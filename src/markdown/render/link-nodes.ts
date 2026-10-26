/**
 * The nodes a link renders as — a link, an embed link, an unresolved span, a
 * picker — and the diagnostic an unresolvable link reports.
 */
import type { Html, Link, PhrasingContent } from "mdast";
import type { VFile } from "vfile";
import { escapeHtmlAttribute, escapeHtmlText } from "../../shared/escape.js";
import { createTextNode, reportPluginDiagnostic } from "../remark-diagnostics.js";
import type { NormalizedPluginOptions, ParsedWikiLink, WikiLinkCandidate } from "../types.js";
import { wikiLinkDisplayText } from "../utils.js";

export function reportDiagnostic(
	file: VFile,
	raw: string,
	message: string,
	status: "broken-page" | "broken-anchor" | "ambiguous-page",
	options: NormalizedPluginOptions,
): void {
	const failing =
		status === "ambiguous-page"
			? options.onAmbiguousLink === "error"
			: options.onBrokenLink === "error";
	reportPluginDiagnostic(file, status, `${raw} — ${message}`, failing ? "defer" : "warn");
}

export function createLinkNode(url: string, label: string, title?: string): Link {
	return { type: "link", url, ...(title ? { title } : {}), children: [createTextNode(label)] };
}

export function createEmbedNode(url: string, label: string): Html {
	return {
		type: "html",
		value: `<a class="obsidian-embed" data-obsidian-embed="true" href="${escapeHtmlAttribute(url)}">${escapeHtmlText(label)}</a>`,
	};
}

/**
 * Render a wikilink that could not be resolved the way Obsidian shows one: the
 * display text stays readable but marked as unresolved, with the original
 * syntax and the diagnostic available as attributes.
 */
export function createUnresolvedNode(parsed: ParsedWikiLink, reason: string): Html {
	return {
		type: "html",
		value:
			`<span class="obsidian-unresolved" title="${escapeHtmlAttribute(reason)}"` +
			` data-wikilink="${escapeHtmlAttribute(parsed.raw)}">${escapeHtmlText(wikiLinkDisplayText(parsed))}</span>`,
	};
}

/**
 * `<WikiPicker>` for a vault search that matched more than one target.
 *
 * The candidates are resolved while compiling and written into the attribute as
 * JSON, so the component needs no runtime data module. `base` lets it build
 * real hrefs for the site's base while navigating client-side by route.
 */
export function createWikiPickerNode(
	parsed: ParsedWikiLink,
	candidates: WikiLinkCandidate[],
	siteBase: string,
): PhrasingContent {
	const attributes: { type: "mdxJsxAttribute"; name: string; value: string }[] = [
		{ type: "mdxJsxAttribute", name: "candidates", value: JSON.stringify(candidates) },
	];
	const query = parsed.subpath?.value.trim();
	if (query) attributes.push({ type: "mdxJsxAttribute", name: "query", value: query });
	if (parsed.alias?.trim()) {
		attributes.push({ type: "mdxJsxAttribute", name: "alias", value: parsed.alias.trim() });
	}
	if (siteBase !== "/") attributes.push({ type: "mdxJsxAttribute", name: "base", value: siteBase });
	return {
		type: "mdxJsxTextElement",
		name: "WikiPicker",
		attributes,
		children: [],
	} as unknown as PhrasingContent;
}
