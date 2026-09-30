#!/usr/bin/env bun
// Regenerates the callout icon CSS block embedded in src/markdown/styles.css.
// Run via `bun scripts/generate-icons.ts` whenever icon mappings change.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const STYLES_PATH = path.join(ROOT, "src", "markdown", "styles.css");

// Stable, CSP-safe callout glyphs. CSS data-URI masks are not rendered by
// every documentation host, so these use ordinary text content instead.
const ICON_MAP: Record<string, string> = {
	note: "✎",
	todo: "☑",
	tip: "✦",
	info: "i",
	success: "✓",
	question: "?",
	warning: "!",
	caution: "!",
	danger: "!",
	failure: "×",
	bug: "⌁",
	example: "◇",
	abstract: "≡",
	quote: "❝",
};

const START_MARKER = "/* ── CALL OUT ICONS (generated) ── */";
const END_MARKER = "/* ── END CALL OUT ICONS ── */";

function glyphRule(selector: string, glyph: string): string[] {
	return [
		`${selector} {`,
		`\tcontent: "${glyph}";`,
		"\tbackground: none;",
		"\tcolor: var(--callout-color, currentColor);",
		"\tfont-size: 1rem;",
		"\tfont-weight: 800;",
		"\tline-height: 1.1rem;",
		"\ttext-align: center;",
		"\tmask: none;",
		"\t-webkit-mask: none;",
		"}",
	];
}

function buildBlock(): string {
	const lines: string[] = [START_MARKER];
	// Custom (unrecognised) types fall back to Obsidian's note glyph. This rule
	// is emitted first: it ties on specificity with the per-type rules below,
	// so document order lets each known type — and `todo` — win.
	lines.push(
		...glyphRule(".callout .callout-title::before,\n.rp-callout .rp-callout__title::before", "✎"),
	);
	for (const [type, glyph] of Object.entries(ICON_MAP)) {
		lines.push(
			...glyphRule(
				`.callout-${type} .callout-title::before,\n.rp-callout--${type} .rp-callout__title::before`,
				glyph,
			),
		);
	}
	lines.push(END_MARKER);
	return lines.join("\n");
}

const styles = readFileSync(STYLES_PATH, "utf8");
const start = styles.indexOf(START_MARKER);
const end = styles.indexOf(END_MARKER);

let next: string;
if (start !== -1 && end !== -1) {
	next = styles.slice(0, start) + buildBlock() + styles.slice(end + END_MARKER.length);
} else {
	next = `${styles}\n\n${buildBlock()}\n`;
}

writeFileSync(STYLES_PATH, next);
console.log("  generated callout icons in src/markdown/styles.css");
