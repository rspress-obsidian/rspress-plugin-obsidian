/** Fenced blocks that are not the author's own code: Mermaid and plugin fences. */
import type { Code, Html, Root } from "mdast";
import { MERMAID_BLOCK_CLASS, MERMAID_SECURITY_ATTRIBUTE } from "../../mermaid/classes.js";
import { escapeHtmlAttribute, escapeHtmlText } from "../../shared/escape.js";
import { disabledFenceMessage } from "../obsidian-plugins/index.js";
import type { ObsidianPluginFeature } from "../obsidian-plugins/types.js";
import { reportPluginDiagnostic } from "../remark-diagnostics.js";
import type { NormalizedPluginOptions } from "../types.js";
import { visit } from "../visit.js";
import type { RenderContext } from "./context.js";
import { pluginContext } from "./plugin-context.js";

/**
 * Turn ` ```mermaid ` fences into client-rendered placeholders.
 *
 * Mermaid needs a DOM, so the diagram is drawn by the client renderer
 * (`src/mermaid/blocks.ts`) that the markdown plugin registers as a global UI
 * component — the same placeholder contract the canvas feature uses.
 */
export function processMermaidNodes(tree: Root, options: NormalizedPluginOptions): void {
	visit(tree, "code", (node) => {
		if (node.lang?.toLowerCase() !== "mermaid") return;
		// The source lands in an attribute as well as in the text, so quotes must
		// be escaped too — otherwise a diagram containing `"` breaks out of
		// `data-code` and can inject attributes.
		const htmlNode = node as unknown as Html;
		htmlNode.type = "html";
		htmlNode.value = `<pre class="${MERMAID_BLOCK_CLASS}" ${MERMAID_SECURITY_ATTRIBUTE}="${options.mermaidSecurityLevel}" data-code="${escapeHtmlAttribute(node.value)}">${escapeHtmlText(node.value)}</pre>\n`;
	});
}

/**
 * Render fenced blocks that belong to a reproduced Obsidian plugin (```tasks,
 * ```base, …) through that feature, and report the ones whose feature is off:
 * those stay code blocks (the config hook gives Shiki a plain-text fallback for
 * their unknown languages), but a reader would otherwise assume the raw query
 * syntax they see ran. `mermaid` has its own pass, and a fence in any other
 * language is the author's own code.
 */
export async function processPluginFences(tree: Root, ctx: RenderContext): Promise<void> {
	const { file, options } = ctx;
	const work: { node: Code; feature: ObsidianPluginFeature }[] = [];
	visit(tree, "code", (node) => {
		const language = node.lang?.toLowerCase();
		if (!language) return;
		const feature = ctx.features.find((candidate) => candidate.fences?.includes(language));
		if (feature?.renderFence) {
			work.push({ node, feature });
			return;
		}
		const message = disabledFenceMessage(language, options);
		if (!message) return;
		reportPluginDiagnostic(
			file,
			"unsupported-block",
			`[!${language}] ${message}`,
			options.onUnsupportedBlock === "error" ? "fail" : "warn",
		);
	});
	for (const { node, feature } of work) {
		const replacement = await feature.renderFence?.(node, pluginContext(feature, ctx));
		if (!replacement) continue;
		visit(tree, "code", (candidate, index, parent) => {
			if (candidate !== node || !parent || typeof index !== "number") return;
			parent.children.splice(index, 1, ...(replacement as typeof parent.children));
			return index + replacement.length;
		});
	}
}
