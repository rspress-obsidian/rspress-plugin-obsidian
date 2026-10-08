/**
 * Shared by this feature's tests: scenes built element by element, written as
 * the plugin writes them, and a vault compiled through the real remark pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compressToBase64 } from "lz-string";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { buildContentIndex } from "../../content-index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import { remarkWikilink } from "../../remark-wikilink.js";
import type {
	ContentIndex,
	NormalizedPluginOptions,
	RspressPluginMarkdownOptions,
} from "../../types.js";
import type { PluginBuildContext } from "../types.js";

export type RawElement = Record<string, unknown>;

let seed = 0;

/** An element with Excalidraw's defaults, overridden by `props`. */
export function element(type: string, props: RawElement = {}): RawElement {
	seed += 1;
	return {
		id: `${type}-${seed}`,
		type,
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		roundness: null,
		seed,
		isDeleted: false,
		boundElements: null,
		link: null,
		...(type === "text" && {
			text: "Text",
			originalText: "Text",
			fontSize: 20,
			fontFamily: 5,
			textAlign: "left",
			verticalAlign: "top",
			containerId: null,
			lineHeight: 1.25,
		}),
		...props,
	};
}

export function sceneJson(elements: RawElement[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "excalidraw",
		version: 2,
		source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
		elements,
		appState: { viewBackgroundColor: "#ffffff", theme: "light" },
		files: {},
		...extra,
	});
}

export interface NoteSections {
	textElements?: Record<string, string>;
	elementLinks?: Record<string, string>;
	embeddedFiles?: Record<string, string>;
	frontmatter?: string;
	back?: string;
	/** `compressed-json` (default) or `json`. */
	format?: "compressed" | "json";
	/** Wrap the drawing in `%%` (default) or leave it bare. */
	comment?: boolean;
	heading?: "#" | "##";
}

/** A drawing note, in the layout the Obsidian plugin saves. */
export function drawingNote(json: string, sections: NoteSections = {}): string {
	const { format = "compressed", comment = true, heading = "##" } = sections;
	const lines = (
		record: Record<string, string> | undefined,
		suffix: (id: string, value: string) => string,
	) =>
		Object.entries(record ?? {})
			.map(([id, value]) => suffix(id, value))
			.join("");
	const compressed =
		compressToBase64(json)
			.match(/.{1,256}/g)
			?.join("\n\n") ?? "";
	const fence =
		format === "compressed"
			? `\`\`\`compressed-json\n${compressed}\n\`\`\``
			: `\`\`\`json\n${json}\n\`\`\``;
	return [
		"---",
		"",
		sections.frontmatter ?? "excalidraw-plugin: parsed",
		"tags: [excalidraw]",
		"",
		"---",
		"==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'",
		"",
		sections.back ?? "",
		"",
		"# Excalidraw Data",
		"",
		"## Text Elements",
		lines(sections.textElements, (id, value) => `${value} ^${id}\n\n`),
		...(sections.elementLinks
			? ["## Element Links", lines(sections.elementLinks, (id, value) => `${id}: ${value}\n`), ""]
			: []),
		...(sections.embeddedFiles
			? ["## Embedded Files", lines(sections.embeddedFiles, (id, value) => `${id}: ${value}\n`), ""]
			: []),
		comment ? "%%" : "",
		`${heading} Drawing`,
		fence,
		comment ? "%%" : "",
	].join("\n");
}

/** A 1×1 PNG. */
export const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

export function makeVault(files: Record<string, string | Buffer>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-vault-"));
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return root;
}

export interface Compiled {
	html: string;
	messages: string[];
}

/** Options as `markdown()` normalizes them, with the feature on and links reported, not fatal. */
export function vaultOptions(
	root: string,
	overrides: RspressPluginMarkdownOptions = {},
): NormalizedPluginOptions {
	return normalizePluginOptions({
		enableExcalidraw: true,
		enableTransclusion: true,
		enableMediaEmbeds: true,
		onBrokenLink: "warn",
		onPluginError: "warn",
		...overrides,
		excalidraw: { readVaultSettings: true, ...overrides.excalidraw },
		vaultRoot: root,
	});
}

export async function vaultIndex(root: string): Promise<ContentIndex> {
	return buildContentIndex(root, { routePrefix: "/vault" });
}

/**
 * Compile one vault note through the real remark pass to HTML. An absolute
 * `name` is a file outside the vault — a page Rspress compiles from a temp file.
 */
export async function compile(
	root: string,
	name: string,
	options: NormalizedPluginOptions,
	index?: ContentIndex,
	siteBase = "/",
): Promise<Compiled> {
	const contentIndex = index ?? (await vaultIndex(root));
	const absolutePath = path.resolve(root, name);
	const file = new VFile({ path: absolutePath, value: fs.readFileSync(absolutePath, "utf8") });
	const processor = unified()
		.use(remarkParse)
		.use(remarkWikilink, {
			getDocsRoot: () => root,
			getContentIndex: async () => contentIndex,
			getSiteBase: () => siteBase,
			options,
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true });
	await processor.run(processor.parse(file), file).then((tree) => {
		file.value = processor.stringify(tree, file);
	});
	return { html: String(file.value), messages: file.messages.map((message) => message.message) };
}

/** A build context over one vault, as `markdown()` hands it to `addPages`. */
export function buildContext(
	root: string,
	index: ContentIndex,
	options: NormalizedPluginOptions,
): PluginBuildContext {
	return {
		options,
		docsRoot: root,
		vaultRoot: root,
		vaultRoutePrefix: "/vault",
		siteBase: "/",
		docs: index,
		vault: index,
		resolveOptions: { enableCaseInsensitiveLookup: true, enableFuzzyMatching: false },
	};
}
