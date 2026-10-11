import fs from "node:fs/promises";
import path from "node:path";
import type { Html, RootContent } from "mdast";
import { moduleDir, resolveRuntimeFile } from "../../../runtime-paths.js";
import { escapeHtmlText } from "../../../shared/escape.js";
import {
	type PublishedFileRoute,
	publishedFileRoutes,
	setPublishedFileRoutes,
} from "../../../shared/file-routes.js";
import { normalizeFsPath, normalizeRoutePrefix } from "../../../shared/route-path.js";
import type { ContentIndex, ContentPage } from "../../types.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "../types.js";
import { datasetFor } from "./dataset.js";
import { mapLibraryBuilderConfig, renderBase } from "./render.js";
import type { BaseFile } from "./values.js";

const KIND = "bases";

// Client component that draws map views (MapLibre needs the DOM).
const MAP_COMPONENT_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown", "obsidian-plugins", "bases", "runtime", "BasesMaps.js"),
	path.join(moduleDir, "markdown", "obsidian-plugins", "bases", "runtime", "BasesMaps.tsx"),
);

/**
 * The marker a generated base page's body carries: the route it was registered
 * under, percent-encoded. Rspress strips frontmatter before the remark pass,
 * so the page names its base in the body, as an MDX comment that renders nothing.
 */
const PAGE_MARKER = /\{\/\* obsidian-base: (\S+) \*\/\}/;

/** Bases being rendered inside each compiled file, so a base embedded in its own cells stops. */
const rendering = new WeakMap<object, Set<string>>();

async function readBase(
	absolutePath: string,
	ctx: PluginRenderContext,
	label: string,
): Promise<string | undefined> {
	try {
		return await fs.readFile(absolutePath, "utf8");
	} catch (error) {
		ctx.report(`${label} cannot be read: ${(error as Error).message}`);
		return undefined;
	}
}

/** `this` for a base embedded in, or written in, the page being rendered. */
async function embeddingFile(ctx: PluginRenderContext): Promise<BaseFile> {
	const dataset = await datasetFor(await ctx.publishedIndexes(), ctx.options);
	return dataset.fileForPage(ctx.currentPage, ctx.index);
}

function html(value: string): Html {
	return { type: "html", value };
}

/** A route's base, rendered with `this` = the base file and links resolving from its folder. */
async function renderBasePage(
	route: PublishedFileRoute,
	ctx: PluginRenderContext,
): Promise<string> {
	const source = await readBase(route.absolutePath, ctx, route.source);
	if (source === undefined) {
		return `<div class="bases-error">${escapeHtmlText(route.source)} cannot be read</div>`;
	}
	const dataset = await datasetFor(await ctx.publishedIndexes(), ctx.options);
	const thisFile = dataset.byAbsolutePath.get(normalizeFsPath(route.absolutePath));
	// The page is compiled from a temp file; links written in the base resolve
	// as if from the `.base` file itself, as they do in Obsidian.
	const contextPage: ContentPage = {
		...ctx.currentPage,
		absolutePath: route.absolutePath,
		relativePath: route.source,
		pathKey: route.source.replace(/\.base$/i, ""),
		filePathKey: route.source.replace(/\.base$/i, ""),
	};
	return renderBase({ source, label: route.source, thisFile, contextPage, standalone: true }, ctx);
}

/** The pages of every published `.base` file, keyed by route; the first file wins a clash. */
function baseRoutes(indexes: ContentIndex[], prefix: string): PublishedFileRoute[] {
	const routes = new Map<string, PublishedFileRoute>();
	for (const index of indexes) {
		for (const asset of index.assets) {
			if (!/\.base$/i.test(asset.relativePath)) continue;
			const source = normalizeFsPath(asset.relativePath);
			const routePath = `${prefix}/${source.replace(/\.base$/i, "")}`;
			if (routes.has(routePath)) {
				console.warn(
					`[rspress-plugin-obsidian:bases] ${asset.absolutePath} is not published: ${routes.get(routePath)?.absolutePath} already publishes ${routePath}.`,
				);
				continue;
			}
			routes.set(routePath, { kind: KIND, absolutePath: asset.absolutePath, routePath, source });
		}
	}
	return [...routes.values()];
}

/** Obsidian Bases: `.base` files and ```base blocks evaluated at build time into table, card, list, Kanban and map views. */
export const basesFeature: ObsidianPluginFeature = {
	id: "bases",
	label: "Bases",
	enableOption: "enableBases",
	fences: ["base"],
	isEnabled: (options) => options.enableBases,

	globalUIComponents: () => [MAP_COMPONENT_PATH],
	// `maplibre-gl` is an optional peer: without it, alias the client import
	// away so the site still bundles and map views keep their tables.
	builderConfig: mapLibraryBuilderConfig,

	async addPages(ctx) {
		const prefix = normalizeRoutePrefix(ctx.options.bases.routePrefix, "/bases");
		const routes = baseRoutes(ctx.vault ? [ctx.vault, ctx.docs] : [ctx.docs], prefix);
		setPublishedFileRoutes(KIND, routes);
		return routes.map((route) => {
			const title =
				route.source
					.split("/")
					.pop()
					?.replace(/\.base$/i, "") ?? route.source;
			// JSON strings are valid YAML scalars, whatever the file name holds.
			return {
				routePath: route.routePath,
				content: `---\ntitle: ${JSON.stringify(title)}\n---\n\n{/* obsidian-base: ${encodeURIComponent(route.routePath)} */}\n`,
			};
		});
	},

	async renderNote(_tree, ctx) {
		// Only a generated page: an indexed note with this key is the author's own.
		if (ctx.mode !== "page" || ctx.index.byAbsolutePath.get(ctx.currentPage.absolutePath)) {
			return undefined;
		}
		const marker = PAGE_MARKER.exec(ctx.source)?.[1];
		if (!marker) return undefined;
		const routePath = decodeURIComponent(marker);
		const route = publishedFileRoutes(KIND).find((candidate) => candidate.routePath === routePath);
		if (!route) return undefined;
		const title =
			route.source
				.split("/")
				.pop()
				?.replace(/\.base$/i, "") ?? route.source;
		const nodes: RootContent[] = [
			{ type: "heading", depth: 1, children: [{ type: "text", value: title }] },
			html(await renderBasePage(route, ctx)),
		];
		return nodes;
	},

	async renderFence(node, ctx) {
		const label = `base block in ${ctx.currentPage.relativePath}`;
		return [
			html(
				await renderBase(
					{ source: node.value, label, thisFile: await embeddingFile(ctx), standalone: false },
					ctx,
				),
			),
		];
	},

	async renderEmbed(parsed, ctx) {
		if (!/\.base$/i.test(parsed.target)) return undefined;
		const resolved = await ctx.resolve(parsed);
		const absolutePath = resolved.fileRoute?.absolutePath ?? resolved.targetAsset?.absolutePath;
		if (resolved.status !== "ok" || !absolutePath) return undefined;
		const label = resolved.fileRoute?.source ?? parsed.target;
		const active = rendering.get(ctx.file) ?? new Set<string>();
		rendering.set(ctx.file, active);
		if (active.has(absolutePath)) {
			const message = `${label} embeds itself through its own results; the inner embed is left out`;
			ctx.report(message);
			return html(`<div class="bases-error">${escapeHtmlText(message)}</div>`);
		}
		const source = await readBase(absolutePath, ctx, label);
		if (source === undefined) {
			return html(`<div class="bases-error">${escapeHtmlText(label)} cannot be read</div>`);
		}
		active.add(absolutePath);
		try {
			const rendered = await renderBase(
				{
					source,
					label,
					thisFile: await embeddingFile(ctx),
					viewName: parsed.subpath?.value,
					standalone: false,
				},
				ctx,
			);
			return html(`<div class="bases-embed">${rendered}</div>`);
		} finally {
			active.delete(absolutePath);
		}
	},
};
