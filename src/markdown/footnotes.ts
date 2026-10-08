/**
 * Footnotes — `[^label]` with `[^label]: …`, and Obsidian's inline `^[…]`.
 *
 * remark-gfm (which Rspress runs, and which every re-parse here uses) already
 * turns label references and definitions into `footnoteReference` /
 * `footnoteDefinition` nodes, so a definition inside a code fence is never one,
 * and `%%comments%%` inside a definition are stripped with the rest of the page
 * before this pass runs. Inline footnotes are found by `inline-footnotes.ts`.
 *
 * Obsidian (like GFM) numbers every footnote in one sequence, in the order it is
 * first referenced, and lists them in that order. The definitions stay mdast
 * nodes inside the list, so wikilinks, math and tags in a footnote are rendered
 * by the same passes as the body. Every id carries the document's prefix, so a
 * transcluded note's footnotes never collide with the host's.
 */
import type {
	FootnoteDefinition,
	Html,
	Paragraph,
	PhrasingContent,
	Root,
	RootContent,
} from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { escapeHtmlAttribute } from "../shared/escape.js";
import { replaceInlineFootnotes } from "./inline-footnotes.js";
import { reportPluginDiagnostic } from "./remark-diagnostics.js";
import { parseObsidianMarkdown, plainText } from "./syntax.js";

export interface FootnoteContext {
	file: VFile;
	/** Prefix for every emitted id (empty on the page itself). */
	idPrefix: string;
	enableMath: boolean;
}

interface FootnoteEntry {
	number: number;
	children: RootContent[];
	title: string;
	refIds: string[];
}

export function processFootnotes(tree: Root, ctx: FootnoteContext): void {
	const definitions = new Map<string, FootnoteDefinition>();
	const duplicates = new Set<string>();
	visit(tree, "footnoteDefinition", (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		if (definitions.has(node.identifier)) duplicates.add(node.label ?? node.identifier);
		definitions.set(node.identifier, node);
		parent.children.splice(index, 1);
		return index;
	});
	if (duplicates.size > 0) {
		reportPluginDiagnostic(
			ctx.file,
			"footnote",
			`Duplicate footnote label${duplicates.size > 1 ? "s" : ""}: ${[...duplicates].join(", ")}. Later definitions overwrite earlier ones.`,
		);
	}

	replaceInlineFootnotes(tree);

	const entries: FootnoteEntry[] = [];
	const byIdentifier = new Map<string, FootnoteEntry>();
	const prefix = ctx.idPrefix;

	const createEntry = (children: RootContent[]): FootnoteEntry => {
		const entry: FootnoteEntry = {
			number: entries.length + 1,
			children,
			title: plainText(children).replace(/\s+/g, " ").trim(),
			refIds: [],
		};
		entries.push(entry);
		return entry;
	};

	const referenceNode = (entry: FootnoteEntry): Html => {
		const refId = `${prefix}fnref-${entry.number}${entry.refIds.length > 0 ? `-${entry.refIds.length + 1}` : ""}`;
		entry.refIds.push(refId);
		const title = entry.title ? ` title="${escapeHtmlAttribute(entry.title)}"` : "";
		return {
			type: "html",
			value: `<sup class="footnote-ref" id="${escapeHtmlAttribute(refId)}"><a href="#${escapeHtmlAttribute(`${prefix}fn-${entry.number}`)}"${title}>${entry.number}</a></sup>`,
		};
	};

	const numberReferences = (root: Root): void => {
		visit(root, (node, index, parent) => {
			if (!parent || typeof index !== "number") return;
			let replacement: PhrasingContent | undefined;
			if (node.type === "footnoteReference") {
				const identifier = node.identifier;
				const definition = definitions.get(identifier);
				if (!definition) {
					replacement = {
						type: "text",
						value: `[^${node.label ?? identifier}]`,
					};
				} else {
					let entry = byIdentifier.get(identifier);
					if (!entry) {
						entry = createEntry(definition.children);
						byIdentifier.set(identifier, entry);
					}
					replacement = referenceNode(entry);
				}
			} else if (node.type === "inlineFootnote") {
				const children = parseObsidianMarkdown(node.content, {
					enableMath: ctx.enableMath,
				}).children;
				replacement = referenceNode(createEntry(children));
			}
			if (!replacement) return;
			(parent as Parent & { children: PhrasingContent[] }).children.splice(index, 1, replacement);
		});
	};

	numberReferences(tree);
	// A definition can itself reference a footnote; those are numbered after
	// every body reference, as they are first met when reading the list.
	for (let index = 0; index < entries.length; index += 1) {
		numberReferences({ type: "root", children: (entries[index] as FootnoteEntry).children });
	}
	if (entries.length === 0) return;

	const list: RootContent[] = [{ type: "html", value: '<hr />\n<ol class="footnotes">' }];
	for (const entry of entries) {
		const backrefs: Html[] = entry.refIds.map((refId, position) => ({
			type: "html",
			value: `<a href="#${escapeHtmlAttribute(refId)}" class="footnote-backref">↩${position > 0 ? `<sup>${position + 1}</sup>` : ""}</a>`,
		}));
		const children = [...entry.children];
		const last = children[children.length - 1];
		if (last?.type === "paragraph") {
			children[children.length - 1] = {
				...last,
				children: [...last.children, { type: "text", value: " " }, ...backrefs],
			} as Paragraph;
		} else {
			children.push({ type: "paragraph", children: backrefs });
		}
		list.push(
			{ type: "html", value: `<li id="${escapeHtmlAttribute(`${prefix}fn-${entry.number}`)}">` },
			...children,
			{ type: "html", value: "</li>" },
		);
	}
	list.push({ type: "html", value: "</ol>" });
	tree.children.push(...list);
}
