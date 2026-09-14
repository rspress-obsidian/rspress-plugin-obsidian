import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";

/** Extract graph edges from Markdown, Obsidian wikilinks, tags, or Canvas JSON. */
export function extractMarkdownLinks(source: string, sourcePath?: string): string[] {
	if (sourcePath?.toLowerCase().endsWith(".canvas")) {
		return extractCanvasLinks(source, sourcePath);
	}

	const tree = fromMarkdown(source);
	const definitions = new Map<string, string>();
	const links: string[] = [];

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

	const visibleSource = maskFencedCode(source);
	for (const match of visibleSource.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
		const rawTarget = match[1]?.split("|")[0]?.trim() ?? "";
		const target = rawTarget.split("#", 1)[0]?.trim() ?? "";
		if (isPageTarget(target)) links.push(target);
	}

	for (const match of visibleSource.matchAll(/(^|[\s>])#([A-Za-z_][A-Za-z0-9_/-]*)/gm)) {
		const tag = match[2];
		if (tag) links.push(`/tags/${encodeURIComponent(tag).replace(/%2F/gi, "/")}`);
	}

	for (const tag of extractFrontmatterTags(source)) {
		links.push(`/tags/${encodeURIComponent(tag).replace(/%2F/gi, "/")}`);
	}

	return links;
}

export function extractDisplayTitle(source: string): string | undefined {
	const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (frontmatterMatch?.[1]) {
		const titleMatch = frontmatterMatch[1].match(/^title:\s*(.+?)\r?$/m);
		if (titleMatch?.[1]) {
			return titleMatch[1].trim().replace(/^['"]|['"]$/g, "");
		}
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

function extractFrontmatterTags(source: string): string[] {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return [];

	const lines = match[1].split(/\r?\n/);
	const tags: string[] = [];
	let collecting = false;
	for (const line of lines) {
		if (/^tags:\s*(?:\[([^\]]*)\])?\s*$/.test(line)) {
			const inline = line.match(/^tags:\s*\[([^\]]*)\]/)?.[1];
			if (inline) tags.push(...inline.split(",").map(stripYamlScalar).filter(Boolean));
			collecting = !inline;
			continue;
		}
		if (collecting) {
			const item = line.match(/^\s*-\s*(.+?)\s*$/)?.[1];
			if (item) tags.push(stripYamlScalar(item));
			else if (/^\S/.test(line)) collecting = false;
		}
	}
	return [...new Set(tags.filter(Boolean))];
}

function stripYamlScalar(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "");
}

function maskFencedCode(source: string): string {
	return source.replace(/^\s{0,3}(`{3,}|~{3,})[\s\S]*?^\s{0,3}\1\s*$/gm, "");
}

function isPageTarget(target: string): boolean {
	return (
		Boolean(target) &&
		!target.startsWith("!") &&
		!/^(?:https?:|mailto:|tel:|data:|file:)/i.test(target)
	);
}

function normalizeReferenceIdentifier(identifier: string): string {
	return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function isInternalDocLink(link: string): boolean {
	return Boolean(
		link && !link.startsWith("#") && !link.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(link),
	);
}
