/**
 * Obsidian callouts: `> [!type|metadata]± Title`.
 *
 * Header lines are recovered from the source through node positions rather than
 * from the first text node, because inline markdown in a title splits the
 * paragraph into several nodes. The source handed in has its `%%comments%%`
 * blanked (same length, so positions still line up), which is what keeps a
 * comment out of a callout title.
 */
import type { Blockquote, Html, Root, Text } from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";
import { parseObsidianMarkdown } from "./syntax.js";

/**
 * `[!type]`, `[!type|metadata]`, then an optional fold sign and title. Obsidian
 * accepts any type up to `]` — `[!my-type]`, `[!my_type]` — and passes the
 * metadata to themes and CSS snippets.
 */
const CALLOUT_HEADER_PATTERN = /^\[!([^\]|\s]+)(?:\|([^\]]*))?\]([-+])?(?:\s+(.*))?\s*$/;

/**
 * Obsidian's documented aliases, mapped to the type whose styling they share.
 * https://help.obsidian.md/callouts#Supported+types
 */
const CALLOUT_TYPE_ALIASES: Record<string, string> = {
	summary: "abstract",
	tldr: "abstract",
	hint: "tip",
	important: "tip",
	check: "success",
	done: "success",
	help: "question",
	faq: "question",
	caution: "warning",
	attention: "warning",
	fail: "failure",
	missing: "failure",
	error: "danger",
	cite: "quote",
};

/**
 * The marker Rspress's built-in GitHub-style alert transform (its internal
 * `remarkContainerSyntax`) gives the containerDirective nodes it creates, and
 * the types it claims (its `DIRECTIVE_TYPES`).
 */
const RSPRESS_CALLOUT_COMPONENT = "$$$callout$$$";
const RSPRESS_CALLOUT_TYPES: Record<string, true> = {
	tip: true,
	note: true,
	important: true,
	warning: true,
	caution: true,
	danger: true,
	info: true,
	details: true,
};

interface RspressCalloutContainer {
	type: "containerDirective";
	name?: string;
	attributes?: { type?: string; title?: string };
	children: Root["children"];
}

interface NodeWithLine {
	position?: { start?: { line?: number }; end?: { line?: number } };
	children?: NodeWithLine[];
}

/** Strip leading blockquote markers (one or more levels) from a source line. */
function stripQuoteMarker(line: string): string {
	return line.replace(/^(?:\s*>+)+\s*/, "");
}

/**
 * Remove `position` from a node and its descendants.
 *
 * Nodes parsed from a source *fragment* carry offsets relative to that fragment;
 * any pass that maps offsets back into the document (comment stripping, heading
 * ids) would slice the wrong characters. Dropping the positions makes those
 * passes fall back to node values instead.
 */
function dropPositions(node: unknown): void {
	if (typeof node !== "object" || node === null) return;
	const record = node as { position?: unknown; children?: unknown[] };
	delete record.position;
	if (Array.isArray(record.children)) {
		for (const child of record.children) dropPositions(child);
	}
}

/**
 * Restore blockquote callouts that Rspress's built-in GitHub-style alert
 * transform has already claimed.
 *
 * Rspress registers remarkContainerSyntax before plugin remark plugins, so
 * `> [!note]` blockquotes for the types it knows arrive here already converted
 * to `$$$callout$$$` containerDirective nodes — with the fold suffix leaked into
 * the content and the first paragraph of multi-paragraph alerts dropped.
 *
 * The converted nodes keep their original source positions, so each one is
 * verified against the source: walk up from its first positioned child through
 * the contiguous `>`-prefixed lines and check that the range starts with a
 * `[!type]` header matching the container's type. That tells a GitHub alert
 * from a `:::type` container (whose lines are not `>`-prefixed), which keeps
 * Rspress's native rendering. Verified nodes are replaced with the blockquote
 * re-parsed from source, offsets aligned with the document, and are then
 * transformed by {@link processCallouts} like any other callout.
 */
export function restoreHijackedCallouts(tree: Root, source: string, enableMath: boolean): void {
	const sourceLines = source.split(/\r?\n/);
	const lineOffsets: number[] = [0];
	for (const match of source.matchAll(/\r?\n/g)) {
		lineOffsets.push((match.index ?? 0) + match[0].length);
	}

	interface Candidate {
		node: RspressCalloutContainer;
		parent: Parent & { children: Root["children"] };
		startLine: number;
		endLine: number;
	}
	const candidates: Candidate[] = [];
	const parents = new WeakMap<object, Parent>();

	visit(tree, "containerDirective", (rawNode, _position, parent) => {
		const node = rawNode as unknown as RspressCalloutContainer;
		if (parent) parents.set(node, parent);
		const type = node.attributes?.type;
		if (
			!parent ||
			node.name !== RSPRESS_CALLOUT_COMPONENT ||
			!type ||
			!RSPRESS_CALLOUT_TYPES[type]
		) {
			return;
		}

		let startLine = Number.POSITIVE_INFINITY;
		let endLine = 0;
		const scan = (current: NodeWithLine): void => {
			const line = current.position?.start?.line;
			const end = current.position?.end?.line;
			if (typeof line === "number" && line < startLine) startLine = line;
			if (typeof end === "number" && end > endLine) endLine = end;
			for (const child of current.children ?? []) scan(child);
		};
		scan(node as NodeWithLine);
		if (
			!Number.isFinite(startLine) ||
			endLine <= 0 ||
			startLine > sourceLines.length ||
			endLine > sourceLines.length
		) {
			return;
		}

		let headerIndex = startLine - 1;
		while (headerIndex > 0 && (sourceLines[headerIndex - 1] ?? "").trimStart().startsWith(">")) {
			headerIndex -= 1;
		}
		const headerMatch = /^\[!([^\]|\s]+)/.exec(stripQuoteMarker(sourceLines[headerIndex] ?? ""));
		if (headerMatch?.[1]?.toLowerCase() !== type) return;

		candidates.push({
			node,
			parent: parent as Parent & { children: Root["children"] },
			startLine: headerIndex + 1,
			endLine,
		});
	});

	for (const candidate of candidates) {
		// Skip candidates nested inside another restored container: replacing the
		// outer one re-parses them too.
		let ancestor = parents.get(candidate.node);
		let nested = false;
		while (ancestor) {
			if (candidates.some((c) => c.node === ancestor)) {
				nested = true;
				break;
			}
			ancestor = parents.get(ancestor);
		}
		if (nested) continue;

		const startOffset = lineOffsets[candidate.startLine - 1] ?? 0;
		const endOffset = lineOffsets[candidate.endLine] ?? source.length;
		// Everything before the blockquote becomes blank space with the same line
		// breaks, so the re-parsed nodes carry the document's own offsets.
		const fragment =
			source.slice(0, startOffset).replace(/[^\r\n]/g, " ") + source.slice(startOffset, endOffset);
		const parsed = parseObsidianMarkdown(fragment, { enableMath });
		if (parsed.children.length === 0) continue;

		const index = candidate.parent.children.indexOf(
			candidate.node as unknown as Root["children"][number],
		);
		if (index >= 0) candidate.parent.children.splice(index, 1, ...parsed.children);
	}
}

/** Obsidian's default title: the type as written, first letter capitalised. */
function defaultTitle(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/**
 * Find and transform every callout blockquote, innermost first so nested
 * callouts are resolved before their parent is replaced.
 *
 * The opening paragraph's continuation lines are re-parsed from the source
 * (with GFM and the Obsidian constructs, like the rest of the page) so markdown
 * in the title does not leak into the content and vice versa. `renderTitle`
 * renders a title's inline markdown to HTML.
 */
export async function processCallouts(
	tree: Root,
	source: string,
	enableMath: boolean,
	renderTitle: (markdown: string) => Promise<string>,
): Promise<void> {
	interface CalloutEntry {
		bq: Blockquote;
		parent: Parent & { children: Root["children"] };
	}
	const stack: CalloutEntry[] = [];
	const sourceLines = source.split(/\r?\n/);

	const headerLineOf = (bq: Blockquote): string | undefined => {
		const firstPara = bq.children[0];
		const line = firstPara?.position?.start.line;
		if (typeof line === "number" && line >= 1 && line <= sourceLines.length) {
			return stripQuoteMarker(sourceLines[line - 1] ?? "");
		}
		// Position fallback for synthesized ASTs: use the first text node.
		if (firstPara?.type !== "paragraph") return undefined;
		const firstText = firstPara.children.find((c): c is Text => c.type === "text");
		return firstText?.value.split("\n")[0];
	};

	visit(tree, "blockquote", (node, _position, parent) => {
		if (!parent || node.children[0]?.type !== "paragraph") return;
		const headerLine = headerLineOf(node);
		if (!headerLine || !CALLOUT_HEADER_PATTERN.test(headerLine)) return;
		stack.push({ bq: node, parent: parent as Parent & { children: Root["children"] } });
	});

	for (const { bq, parent } of stack.reverse()) {
		const firstPara = bq.children[0];
		if (firstPara?.type !== "paragraph") continue;
		const match = CALLOUT_HEADER_PATTERN.exec(headerLineOf(bq) ?? "");
		if (!match) continue;

		const rawType = (match[1] ?? "note").toLowerCase();
		const metadata = match[2]?.trim();
		const foldState = match[3];
		const title = match[4]?.trim();

		const startLine = firstPara.position?.start.line;
		const endLine = firstPara.position?.end.line;
		if (
			typeof startLine === "number" &&
			typeof endLine === "number" &&
			startLine >= 1 &&
			endLine <= sourceLines.length
		) {
			const contentLines = sourceLines.slice(startLine, endLine).map(stripQuoteMarker);
			const reParsed = parseObsidianMarkdown(contentLines.join("\n"), { enableMath })
				.children as Blockquote["children"];
			for (const node of reParsed) dropPositions(node);
			bq.children.splice(0, 1, ...reParsed);
		} else {
			const firstText = firstPara.children.find((c): c is Text => c.type === "text");
			if (!firstText) continue;
			const remainingLines = firstText.value.split("\n").slice(1);
			if (remainingLines.length === 0) bq.children.shift();
			else firstText.value = remainingLines.join("\n");
		}

		const titleHtml = title ? await renderTitle(title) : escapeHtmlText(defaultTitle(rawType));
		const position = parent.children.indexOf(bq);
		if (position < 0) continue;
		parent.children.splice(
			position,
			1,
			...buildCalloutNodes(
				rawType,
				metadata,
				titleHtml || escapeHtmlText(title ?? defaultTitle(rawType)),
				foldState,
				bq.children as Root["children"],
			),
		);
	}
}

/**
 * Replacement nodes for one callout. Foldable callouts (`+` expanded, `-`
 * collapsed) use `<details>`/`<summary>`, static ones `<div>`s. The class names
 * the alias-resolved type (`caution` → `callout-warning`) so styling is shared,
 * and `data-callout` keeps the type as written, as Obsidian's DOM does, for
 * snippets that target one alias.
 */
function buildCalloutNodes(
	rawType: string,
	metadata: string | undefined,
	titleHtml: string,
	foldState: string | undefined,
	contentChildren: Root["children"],
): Root["children"] {
	const canonical = escapeHtmlAttribute(CALLOUT_TYPE_ALIASES[rawType] ?? rawType);
	const attributes = `class="callout callout-${canonical}" data-callout="${escapeHtmlAttribute(rawType)}"${
		metadata ? ` data-callout-metadata="${escapeHtmlAttribute(metadata)}"` : ""
	}`;
	const open: Html = {
		type: "html",
		value: foldState
			? `<details ${attributes}${foldState === "+" ? " open" : ""}>`
			: `<div ${attributes}>`,
	};
	const titleTag = foldState ? "summary" : "div";
	const titleNode: Html = {
		type: "html",
		value: `<${titleTag} class="callout-title">${titleHtml}</${titleTag}>`,
	};
	const close = foldState ? "</details>" : "</div>";
	if (contentChildren.length === 0) {
		return [
			open,
			titleNode,
			{ type: "html", value: `<div class="callout-content"></div>${close}` },
		];
	}
	return [
		open,
		titleNode,
		{ type: "html", value: '<div class="callout-content">' },
		...contentChildren,
		{ type: "html", value: `</div>${close}` },
	];
}
