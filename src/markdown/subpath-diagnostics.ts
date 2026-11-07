import type { ContentPage } from "./types.js";

const MAX_LISTED = 12;

/**
 * Format a concise list of available heading names for error messages.
 * Shows explicit IDs in parentheses when they differ from the raw text.
 */
export function formatAvailableHeadings(page: ContentPage): string {
	const names = page.headings.slice(0, MAX_LISTED).map((h) => {
		if (h.explicitId && h.explicitId !== h.slug) {
			return `${h.rawText} (${h.explicitId})`;
		}
		return h.rawText;
	});
	if (names.length === 0) return " No headings found on this page.";
	const remainder = page.headings.length - names.length;
	const list = names.join(", ");
	return ` Available headings: ${list}${remainder > 0 ? ` (and ${remainder} more)` : ""}.`;
}

/**
 * Format a concise list of available block IDs for error messages.
 */
export function formatAvailableBlocks(page: ContentPage): string {
	const ids = page.blocks.slice(0, MAX_LISTED).map((b) => `^${b.id}`);
	if (ids.length === 0) return " No blocks found on this page.";
	const remainder = page.blocks.length - ids.length;
	return ` Available block IDs: ${ids.join(", ")}${remainder > 0 ? ` (and ${remainder} more)` : ""}.`;
}
