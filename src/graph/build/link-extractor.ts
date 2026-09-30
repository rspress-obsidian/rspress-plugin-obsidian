import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
// Straight to the node-free module: reaching it through `content-index` would
// pull that module's `node:fs` import along for a 45-line pure function.
import { getContentLineFlags } from "../../shared/content-flags.js";
import { parseFrontmatter, stripFrontmatter } from "../../shared/frontmatter.js";
import { encodeTagPathSegment } from "../../shared/paths.js";

/**
 * Link and tag extraction from raw text, with code masked out.
 *
 * This is the fast path: a masked-source scan costs ~0.9µs per note against
 * ~379µs for a full mdast parse (measured), and a vault note's parse exists
 * almost entirely to find `[[…]]` and `#tags`. `extractMarkdownLinks` only takes
 * this path when the source contains no markdown-link syntax, so definitions,
 * reference links and autolinks always go through the parser.
 */
export function extractWikilinkTargets(source: string): string[] {
	const visible = maskCode(source);
	const links: string[] = [];

	for (const match of visible.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
		const rawTarget = match[2]?.split("|")[0]?.trim() ?? "";
		const target = rawTarget.split("#", 1)[0]?.trim() ?? "";
		if (isPageTarget(target, match[1] === "!")) links.push(target);
	}

	for (const match of visible.matchAll(/(^|[\s>])#([A-Za-z_][A-Za-z0-9_/-]*)/gm)) {
		const tag = match[2];
		if (tag) links.push(`/tags/${encodeTagPathSegment(tag)}`);
	}

	return links;
}

/** Markdown-link syntax the parser is needed for: inline, reference, autolink. */
const LINK_SYNTAX = /\](?:\(|\[|:)|\]:|<(?:https?|mailto):/i;

/** Replace fenced blocks and inline code spans with spaces, preserving offsets. */
function maskCode(source: string): string {
	const lines = source.split("\n");
	const isContent = getContentLineFlags(lines);

	return lines
		.map((line, index) => (isContent[index] ? maskInlineCode(line) : " ".repeat(line.length)))
		.join("\n");
}

/** Blank backtick-delimited spans; an unclosed span masks the rest of the line. */
function maskInlineCode(line: string): string {
	const characters = [...line];
	let index = 0;

	while (index < characters.length) {
		if (characters[index] !== "`") {
			index += 1;
			continue;
		}
		let run = 0;
		while (characters[index + run] === "`") run += 1;
		const closer = line.indexOf("`".repeat(run), index + run);
		const end = closer === -1 ? line.length : closer + run;
		for (let cursor = index; cursor < end; cursor += 1) characters[cursor] = " ";
		index = end;
	}

	return characters.join("");
}

/** Extract graph edges from Markdown, Obsidian wikilinks, tags, or Canvas JSON. */
export function extractMarkdownLinks(source: string, sourcePath?: string): string[] {
	if (sourcePath?.toLowerCase().endsWith(".canvas")) {
		return extractCanvasLinks(source, sourcePath);
	}

	// Frontmatter is metadata, not content: a `description` or `details` field
	// that mentions `[[Page]]` must not create an edge.
	const body = stripFrontmatter(source);
	const links: string[] = [];
	const definitions = new Map<string, string>();

	// Notes without markdown-link syntax never need a parse: the masked scan finds
	// the same wikilinks and tags for ~400× less time.
	if (LINK_SYNTAX.test(body)) {
		// GFM parses ~2× slower than the base parser (measured: 315 µs vs 159 µs per
		// note) and the only extraction difference is footnote definitions, where the
		// base parser reads `[^1]: [[Page]]` as a link definition and hides the
		// wikilink inside it. Pay for GFM only when the source has a footnote marker.
		const tree = body.includes("[^")
			? unified().use(remarkParse).use(remarkGfm).parse(body)
			: unified().use(remarkParse).parse(body);

		visit(tree, "definition", (node) => {
			if (node.identifier) {
				definitions.set(normalizeReferenceIdentifier(node.identifier), node.url);
			}
		});

		visit(tree, "link", (node) => {
			const target = cleanLinkTarget(node.url);
			if (isInternalDocLink(target)) links.push(target);
		});

		visit(tree, "linkReference", (node) => {
			const rawTarget = definitions.get(normalizeReferenceIdentifier(node.identifier));
			if (!rawTarget) return;
			const target = cleanLinkTarget(rawTarget);
			if (isInternalDocLink(target)) links.push(target);
		});

		// Wikilinks and tags come from the parsed tree's text nodes, so code fences,
		// inline code and raw HTML cannot contribute phantom edges — `[[Page]]`
		// inside backticks is documentation, not a link.
		const textNodes: string[] = [];
		visit(tree, "text", (node) => {
			textNodes.push(node.value);
		});
		for (const text of textNodes) {
			links.push(...extractWikilinkTargets(text));
		}
	} else {
		links.push(...extractWikilinkTargets(body));
	}

	for (const tag of extractFrontmatterTags(source)) {
		links.push(`/tags/${encodeTagPathSegment(tag)}`);
	}

	return links;
}

export function extractDisplayTitle(source: string): string | undefined {
	const title = readFrontmatter(source).title;
	if (typeof title === "string" && title.trim().length > 0) {
		return title.trim();
	}

	const headingMatch = source.match(/^#\s+(.+?)\r?$/m);
	if (headingMatch?.[1]) return headingMatch[1].trim();
	return undefined;
}

function extractCanvasLinks(source: string, sourcePath: string): string[] {
	try {
		const canvas = JSON.parse(source) as { nodes?: Array<Record<string, unknown>> };
		if (!Array.isArray(canvas.nodes)) return [];

		const links: string[] = [];
		for (const node of canvas.nodes) {
			if (node.type === "file" && typeof node.file === "string" && isPageTarget(node.file)) {
				links.push(node.file);
			}
			if (node.type === "text" && typeof node.text === "string") {
				links.push(...extractMarkdownLinks(node.text, `${sourcePath}.md`));
			}
		}
		return links;
	} catch {
		return [];
	}
}

function cleanLinkTarget(rawLink: string): string {
	const hashIndex = rawLink.indexOf("#");
	const queryIndex = rawLink.indexOf("?");
	const end = Math.min(
		hashIndex === -1 ? rawLink.length : hashIndex,
		queryIndex === -1 ? rawLink.length : queryIndex,
	);

	const cleaned = rawLink.slice(0, end).trim();
	if (cleaned.startsWith("<") && cleaned.endsWith(">")) return cleaned.slice(1, -1);
	return cleaned;
}

/**
 * Frontmatter data via gray-matter — the same parser the content index uses,
 * so the graph and the markdown resolver agree on `title: >-` folded scalars,
 * quoted values and both list forms. The shared parser refuses `---js` and other
 * non-YAML/JSON language markers; a note that trips it contributes no names
 * rather than killing the build.
 *
 * `extractDisplayTitle`, `extractFrontmatterNames` and `extractMarkdownLinks`
 * each ask for the same document's frontmatter in a row, and gray-matter copies
 * the whole document into a Buffer per call — so remember the last parse.
 * ponytail: single-entry memo; the build's calls are per-document. Keyed by the
 * exact source, so a different document simply evicts it.
 */
let lastFrontmatterSource: string | null = null;
let lastFrontmatterData: Record<string, unknown> = {};

function readFrontmatter(source: string): Record<string, unknown> {
	if (source === lastFrontmatterSource) return lastFrontmatterData;

	let data: Record<string, unknown>;
	try {
		data = parseFrontmatter(source).data;
	} catch {
		data = {};
	}
	lastFrontmatterSource = source;
	lastFrontmatterData = data;
	return data;
}

/** A frontmatter scalar or list of scalars as strings, mirroring the content index. */
function toStringArray(value: unknown): string[] {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	return [];
}

function extractFrontmatterTags(source: string): string[] {
	const frontmatter = readFrontmatter(source);
	return [...new Set(toStringArray(frontmatter.tags ?? frontmatter.tag))];
}

/**
 * Frontmatter `title` and `aliases` — the names the markdown resolver accepts
 * for a page. Without them a `[[Custom Title]]` link that renders on the page
 * stays an unresolved edge in the graph.
 */
export function extractFrontmatterNames(source: string): string[] {
	const frontmatter = readFrontmatter(source);
	const names = [
		...toStringArray(frontmatter.aliases ?? frontmatter.alias),
		...toStringArray(frontmatter.title),
	];
	return [...new Set(names)];
}

/** Extensions a graph node can never come from: routes are `.md`/`.mdx`/`.canvas`. */
const PAGE_EMBED_TARGET = /\.(?:md|mdx|canvas)$/i;

function isPageTarget(target: string, isEmbed = false): boolean {
	if (!target) return false;
	// `![[image.png]]` addresses an attachment, not a page. It can never resolve
	// to a route, so keeping it would report an unresolved link on every build
	// for every image a note embeds. `![[Note]]` stays: the markdown pipeline
	// indexes note embeds as links too.
	if (isEmbed && /\.[A-Za-z0-9]{1,8}$/.test(target) && !PAGE_EMBED_TARGET.test(target)) {
		return false;
	}
	return !/^(?:https?:|mailto:|tel:|data:|file:)/i.test(target);
}

function normalizeReferenceIdentifier(identifier: string): string {
	return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function isInternalDocLink(link: string): boolean {
	return Boolean(
		link && !link.startsWith("#") && !link.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(link),
	);
}
