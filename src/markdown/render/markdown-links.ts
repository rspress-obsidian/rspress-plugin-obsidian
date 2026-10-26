/**
 * Standard markdown links and embeds into the vault — `[label](Page.md)`,
 * `obsidian://open?…`, reference definitions and `![alt](Page.md)` — resolved
 * with the wikilink resolution ladder.
 */
import type { Image, Link, Root } from "mdast";
import type { Parent } from "unist";
import { imageImports } from "../media.js";
import { resolveWikiLink } from "../resolve-wikilink.js";
import type { ParsedWikiLink } from "../types.js";
import { visit } from "../visit.js";
import type { RenderContext } from "./context.js";
import { createEmbedNode, reportDiagnostic } from "./link-nodes.js";
import { renderPageEmbed } from "./transclusion.js";

function isExternalUrl(url: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Split a markdown link destination into its decoded path and anchor.
 *
 * Returns `undefined` for anything this plugin does not own: external URLs,
 * pure `#anchors`, and destinations that are not `.md`/`.mdx` files (those
 * belong to Rspress's own link handling). Percent-encoded destinations are
 * decoded before the file-extension test.
 */
function parseMarkdownDestination(url: string): { pathPart: string; anchor?: string } | undefined {
	if (!url || isExternalUrl(url) || url.startsWith("#")) return undefined;
	let decoded = url;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		// keep the raw form when the destination is not valid percent-encoding
	}
	const hashIndex = decoded.indexOf("#");
	const pathPart = (hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded).trim();
	if (!/\.(md|mdx)$/i.test(pathPart)) return undefined;
	return { pathPart, anchor: hashIndex >= 0 ? decoded.slice(hashIndex + 1).trim() : undefined };
}

/**
 * Whether a link destination is one this plugin resolves itself — the
 * predicate the Rspress config hook uses to exempt exactly those destinations
 * from Rspress's dead-link gate.
 */
export function isPluginOwnedMarkdownDestination(url: string): boolean {
	return parseMarkdownDestination(url) !== undefined;
}

/** A {@link ParsedWikiLink} for a `.md`/`.mdx` markdown destination. */
function parseMarkdownLinkUrl(
	url: string,
	raw: string,
	isEmbed: boolean,
): ParsedWikiLink | undefined {
	const destination = parseMarkdownDestination(url);
	if (!destination) return undefined;
	const { pathPart, anchor } = destination;
	return {
		raw,
		target: pathPart.replace(/\.(md|mdx)$/i, ""),
		isEmbed,
		subpath: anchor
			? anchor.startsWith("^")
				? { kind: "block", value: anchor.slice(1).trim() }
				: { kind: "heading", value: anchor }
			: undefined,
		isCurrentPageReference: false,
	};
}

/**
 * An `obsidian://` destination, parsed into the note it names — or the reason
 * it cannot be served.
 *
 * Only the `open` action addresses a note. `search`, `new` and
 * `hook-get-address` cannot be served by a static site, so they — like a URI
 * that cannot be parsed or names no note — come back as an `unsupported`
 * reason. The `vault` parameter is ignored: one root publishes one vault.
 */
function parseObsidianUriTarget(
	url: string,
	raw: string,
): { parsed: ParsedWikiLink } | { unsupported: string } | undefined {
	if (!url.toLowerCase().startsWith("obsidian://")) return undefined;
	let uri: URL;
	try {
		uri = new URL(url);
	} catch {
		return { unsupported: "the URI cannot be parsed; the link is left as written." };
	}
	const action = uri.hostname.toLowerCase();
	if (action !== "open") {
		return {
			unsupported: action
				? `the "obsidian://${action}" action cannot be served by a published site; the link is left as written.`
				: "the URI names no action; the link is left as written.",
		};
	}
	// `file` is the current parameter and `path` the legacy one. A heading
	// arrives percent-encoded inside the value (`file=Note%23Heading`) or as the
	// URI's own fragment (`file=Note#Heading`).
	let target = uri.searchParams.get("file") ?? uri.searchParams.get("path") ?? "";
	let subpathValue = uri.searchParams.get("subpath") ?? "";
	const hashIndex = target.indexOf("#");
	if (hashIndex >= 0) {
		subpathValue = target.slice(hashIndex + 1);
		target = target.slice(0, hashIndex);
	}
	if (!subpathValue && uri.hash.length > 1) {
		const fragment = uri.hash.slice(1);
		try {
			subpathValue = decodeURIComponent(fragment);
		} catch {
			subpathValue = fragment;
		}
	}
	target = target.replace(/\.(md|mdx)$/i, "").trim();
	subpathValue = subpathValue.replace(/^#/, "").trim();
	if (!target) return { unsupported: "the URI does not name a note; the link is left as written." };
	return {
		parsed: {
			raw,
			target,
			isEmbed: false,
			subpath: subpathValue
				? subpathValue.startsWith("^")
					? { kind: "block", value: subpathValue.slice(1).trim() }
					: { kind: "heading", value: subpathValue }
				: undefined,
			isCurrentPageReference: false,
		},
	};
}

/**
 * Rewrite standard markdown links whose destination is a vault page —
 * `[label](Page.md)`, `[label](Page.md#Heading)`, `obsidian://open?…` and
 * reference definitions — to the resolved route, with the wikilink resolution
 * ladder. Unresolvable destinations are reported through `onBrokenLink`: this
 * plugin owns that diagnostic for `.md` links because it exempts them from
 * Rspress's dead-link gate.
 */
export function processMarkdownLinks(tree: Root, ctx: RenderContext): void {
	const rewrite = (node: { url: string }, raw: string, unresolvedMessage: string): void => {
		const obsidianUri = parseObsidianUriTarget(node.url, raw);
		if (obsidianUri && "unsupported" in obsidianUri) {
			// Its scheme looks external, so an unresolvable one is a dead link
			// nothing else reports.
			reportDiagnostic(ctx.file, raw, obsidianUri.unsupported, "broken-page", ctx.options);
			return;
		}
		const parsed = obsidianUri?.parsed ?? parseMarkdownLinkUrl(node.url, raw, false);
		if (!parsed) return;
		const resolved = resolveWikiLink(parsed, {
			currentPage: ctx.currentPage,
			index: ctx.index,
			options: ctx.resolveOptions,
		});
		if (resolved.status === "ok") {
			if (resolved.ambiguity) {
				reportDiagnostic(ctx.file, raw, resolved.ambiguity, "ambiguous-page", ctx.options);
			}
			if (resolved.href) node.url = resolved.href;
			return;
		}
		reportDiagnostic(
			ctx.file,
			raw,
			resolved.message ?? unresolvedMessage,
			resolved.status,
			ctx.options,
		);
	};

	visit(tree, "link", (node: Link) => {
		rewrite(node, `[…](${node.url})`, "Unable to resolve markdown link.");
	});
	// Reference definitions carry the destination for every `[label][ref]`.
	visit(tree, "definition", (node) => {
		rewrite(
			node,
			`[${node.identifier}]: ${node.url}`,
			"Unable to resolve markdown reference definition.",
		);
	});
}

/**
 * Markdown embeds of vault pages — `![alt](note.md)` — which Obsidian
 * transcludes like `![[note]]`. Under Rspress the image has already become an
 * `<img>` bound to an import of the note; that import is dropped here.
 */
export async function processMarkdownEmbeds(tree: Root, ctx: RenderContext): Promise<void> {
	interface EmbedWork {
		node: unknown;
		parent: Parent & { children: unknown[] };
		url: string;
		alt: string;
		dropImport?: unknown;
	}
	const work: EmbedWork[] = [];
	const imports = imageImports(tree);

	visit(tree, (node, _index, parent) => {
		if (!parent) return;
		const container = parent as Parent & { children: unknown[] };
		if (node.type === "image") {
			const image = node as Image;
			if (/\.(md|mdx)([#?]|$)/i.test(image.url)) {
				work.push({ node, parent: container, url: image.url, alt: image.alt ?? "" });
			}
			return;
		}
		if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;
		const element = node as unknown as {
			name: string | null;
			attributes: { type: string; name?: string; value?: unknown }[];
		};
		if (element.name !== "img") return;
		const src = element.attributes.find((attribute) => attribute.name === "src")?.value as
			| { value?: unknown }
			| undefined;
		const bound = typeof src?.value === "string" ? imports.get(src.value) : undefined;
		if (!bound || !/\.(md|mdx)([#?]|$)/i.test(bound.url)) return;
		const alt = element.attributes.find((attribute) => attribute.name === "alt")?.value;
		work.push({
			node,
			parent: container,
			url: bound.url,
			alt: typeof alt === "string" ? alt : "",
			dropImport: bound.node,
		});
	});

	for (const { node, parent, url, alt, dropImport } of work) {
		const raw = `![${alt}](${url})`;
		const parsed = parseMarkdownLinkUrl(url, raw, true);
		if (!parsed) continue;
		const resolved = resolveWikiLink(parsed, {
			currentPage: ctx.currentPage,
			index: ctx.index,
			options: ctx.resolveOptions,
		});
		if (resolved.status !== "ok" || !resolved.targetPage) {
			if (resolved.status !== "ok") {
				reportDiagnostic(
					ctx.file,
					raw,
					resolved.message ?? "Unable to resolve markdown embed.",
					resolved.status,
					ctx.options,
				);
			}
			continue;
		}
		if (resolved.ambiguity) {
			reportDiagnostic(ctx.file, raw, resolved.ambiguity, "ambiguous-page", ctx.options);
		}
		const replacement = ctx.options.enableTransclusion
			? await renderPageEmbed(parsed, resolved, ctx)
			: createEmbedNode(
					resolved.href ?? resolved.targetPage.routePath,
					alt || (resolved.label ?? resolved.targetPage.baseName),
				);
		const position = parent.children.indexOf(node);
		if (position >= 0) parent.children.splice(position, 1, replacement);
		if (dropImport) tree.children = tree.children.filter((child) => child !== dropImport);
	}
}
