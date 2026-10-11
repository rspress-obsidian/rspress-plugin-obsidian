/**
 * Text elements as the Obsidian plugin shows them. In `parsed` mode a text
 * element's markdown — `[[Note|alias]]`, `[label](url)`, `![[Note#^block]]`
 * — is shown as the link's text or the transcluded content
 * (`ExcalidrawData.parse`), and the element links to the first link it holds.
 * In `raw` mode the text is shown exactly as written.
 *
 * A text whose words changed that way is laid out again with Excalidraw's own
 * wrapping and placement, measured by a {@link TextMeasurer}.
 */
import type { TextMeasurer } from "./measure.js";
import type { ExcalidrawElement } from "./scene.js";

/** The plugin's link syntax: `![[link|alias]]{wrap}` and `[alias](link){wrap}` (`REGEX_LINK`). */
const LINK =
	/(!)?(\[\[([^|\]]+)\|?([^\]]+)?]]|\[([^\]]*)]\(((?:[^()]|\([^()]*\))*)\))(\{(\d+)\})?/g;
const URL_SCHEME = /^\w+:\/\//;

export interface TextLinkSettings {
	/** `showLinkBrackets`: keep `[[` `]]` around a link's text. */
	brackets: boolean;
	/** `linkPrefix` / `urlPrefix`: shown before text that holds a link. */
	linkPrefix: string;
	urlPrefix: string;
}

export interface ParsedText {
	/** What the element shows. */
	text: string;
	/** The first link the text holds: `[[target]]` or a URL, as the plugin records it. */
	link: string | null;
}

/** Reads the content a `![[…]]` inside a text element transcludes, or `undefined`. */
export type TransclusionReader = (target: string) => Promise<string | undefined>;

/** Break `text` into lines of at most `width` characters, at spaces (`wrapTextAtCharLength`). */
export function wrapAtCharLength(text: string, width: number): string {
	if (width <= 0) return text;
	return text
		.split("\n")
		.map((line) => {
			const out: string[] = [];
			let current = "";
			for (const word of line.split(" ")) {
				if (current && current.length + 1 + word.length > width) {
					out.push(current);
					current = word;
				} else {
					current = current ? `${current} ${word}` : word;
				}
			}
			out.push(current);
			return out.join("\n");
		})
		.join("\n");
}

/** A text element's display text and link, from the text the author wrote. */
export async function parseElementText(
	raw: string,
	settings: TextLinkSettings,
	transclude: TransclusionReader,
): Promise<ParsedText> {
	let link: string | null = URL_SCHEME.test(raw) ? raw : null;
	let urlIcon = link !== null;
	let linkIcon = false;
	let out = "";
	let position = 0;
	for (const match of raw.matchAll(LINK)) {
		const wikiTarget = match[3];
		const target = wikiTarget ?? match[6] ?? "";
		if (!link) link = URL_SCHEME.test(target) ? target : `[[${target}]]`;
		out += raw.slice(position, match.index);
		if (match[1]) {
			const contents = (await transclude(target)) ?? match[0];
			const wrap = match[8] ? Number(match[8]) : 0;
			out += wrapAtCharLength(contents.replace(/%%[^%]*%%/g, ""), wrap);
		} else {
			const label = wikiTarget !== undefined ? (match[4] ?? wikiTarget) : match[5] || target;
			out += settings.brackets ? `[[${label}]]` : label;
			if (URL_SCHEME.test(target)) urlIcon = true;
			else linkIcon = true;
		}
		position = match.index + match[0].length;
	}
	out += raw.slice(position);
	out = out.replace(/\\\[/g, "[");
	if (linkIcon) out = settings.linkPrefix + out;
	if (urlIcon) out = settings.urlPrefix + out;
	return { text: out, link };
}

/** The first link a raw text holds, for `raw` mode, where the text is shown as written. */
export function firstLink(raw: string): string | null {
	if (URL_SCHEME.test(raw)) return raw;
	const match = LINK.exec(raw);
	LINK.lastIndex = 0;
	if (!match) return null;
	const target = match[3] ?? match[6] ?? "";
	return URL_SCHEME.test(target) ? target : `[[${target}]]`;
}

const CLOSING = String.raw`>\)\]\}.,:;!\?…\/`;
const OPENING = String.raw`<\(\[\{`;
const CJK_CHAR = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}｀＇＾〃〰〆＃＆＊＋－ー／＼＝｜￤〒￢￣`;
const CJK_OPENING = "（［｛〈《｟｢「『【〖〔〘〚＜〝";
const CJK_CLOSING = "）］｝〉》｠｣」』】〗〕〙〛＞。．，、〟‥？！：；・〜〞";
const CJK_CURRENCY = "￥￦￡￠＄";
const EMOJI_JOINER = String.raw`(?:\p{Emoji_Modifier}|\uFE0F\u20E3?|[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const EMOJI = String.raw`(\p{RI}\p{RI}|[\p{Extended_Pictographic}\p{Emoji_Presentation}]${EMOJI_JOINER}(?:\u200D(?:\p{RI}\p{RI}|[\p{Emoji}]${EMOJI_JOINER}))*)`;
const EMOJI_PATTERN = new RegExp(EMOJI, "u");

/**
 * Where Excalidraw may break a line (`getLineBreakRegexAdvanced`): around an
 * emoji, before and after whitespace, after a hyphen, around CJK characters
 * unless punctuation binds them, and between a closing and an opening bracket.
 */
const LINE_BREAK = new RegExp(
	[
		EMOJI,
		String.raw`(?=[\s])`,
		String.raw`(?<=[\s-])`,
		`(?<![${OPENING}${CJK_OPENING}])(?=[${CJK_CHAR}${CJK_CURRENCY}])`,
		`(?<=[${CJK_CHAR}])(?![-${CLOSING}${CJK_CLOSING}])`,
		`(?<![${OPENING}])(?<![${CJK_OPENING}])(?=[${CJK_OPENING}])`,
		`(?<=[${CJK_CLOSING}])(?![${CJK_CLOSING}])(?![${CLOSING}])`,
		`(?<=[${CLOSING}])(?![${CLOSING}])(?=[${OPENING}])`,
	].join("|"),
	"u",
);

/** The width of one line of a text element's font. */
type LineWidth = (line: string) => number;

/** Break a word wider than the line at characters (`wrapWord`); an emoji stays whole. */
function wrapWord(word: string, width: LineWidth, maxWidth: number): string[] {
	if (EMOJI_PATTERN.test(word)) return [word];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const char of word) {
		const charWidth = width(char);
		if (currentWidth + charWidth <= maxWidth) {
			current += char;
			currentWidth += charWidth;
			continue;
		}
		if (current) lines.push(current);
		current = char;
		currentWidth = charWidth;
	}
	if (current) lines.push(current);
	return lines;
}

/** A last line's trailing whitespace, kept only as far as it fits (`trimLine`). */
function trimLine(line: string, width: LineWidth, maxWidth: number): string {
	if (width(line) <= maxWidth) return line;
	const [, trimmed = line, spaces = ""] = /^(.+?)(\s+)$/.exec(line) ?? [line, line.trimEnd(), ""];
	let out = trimmed;
	let outWidth = width(trimmed);
	for (const space of spaces) {
		const spaceWidth = width(space);
		if (outWidth + spaceWidth > maxWidth) break;
		out += space;
		outWidth += spaceWidth;
	}
	return out;
}

/** One line, broken to fit `maxWidth` (`wrapLine`). */
function wrapLine(line: string, width: LineWidth, maxWidth: number): string[] {
	const lines: string[] = [];
	const tokens = line.normalize("NFC").split(LINE_BREAK).filter(Boolean);
	let current = "";
	let currentWidth = 0;
	for (let t = 0; t < tokens.length; ) {
		const token = tokens[t] as string;
		const test = current + token;
		// Excalidraw adds a single character's own width rather than measuring the line again.
		const single = token.codePointAt(0) !== undefined && token.codePointAt(1) === undefined;
		const testWidth = single ? currentWidth + width(token) : width(test);
		if (/\s/.test(token) || testWidth <= maxWidth) {
			current = test;
			currentWidth = testWidth;
			t += 1;
		} else if (!current) {
			const pieces = wrapWord(token, width, maxWidth);
			lines.push(...pieces.slice(0, -1));
			current = pieces.at(-1) ?? "";
			currentWidth = width(current);
			t += 1;
		} else {
			// The token starts the next line: it is tried again there.
			lines.push(current.trimEnd());
			current = "";
			currentWidth = 0;
		}
	}
	if (current) lines.push(trimLine(current, width, maxWidth));
	return lines;
}

/**
 * Word-wrap `text` to `maxWidth` exactly as Excalidraw's `wrapText` does:
 * a line that fits stays, a longer one breaks at Excalidraw's break
 * opportunities, and a word wider than the line breaks between characters.
 */
export function wrapText(text: string, maxWidth: number, width: LineWidth): string {
	if (!Number.isFinite(maxWidth) || maxWidth < 0) return text;
	return text
		.split("\n")
		.flatMap((line) => (width(line) <= maxWidth ? [line] : wrapLine(line, width, maxWidth)))
		.join("\n");
}

/** A text's width: its widest line, an empty line as wide as a space (`measureText`). */
export function textWidth(text: string, width: LineWidth): number {
	return Math.max(...text.split("\n").map((line) => width(line.replace(/\t/g, "        ") || " ")));
}

/** Excalidraw's padding between a container's edge and its label (`BOUND_TEXT_PADDING`). */
const BOUND_TEXT_PADDING = 5;

/** How wide a container's label may be (`getBoundTextMaxWidth`). */
export function boundTextMaxWidth(container: ExcalidrawElement, fontSize: number): number {
	const { width } = container;
	if (container.type === "arrow") return Math.max(0.7 * width, fontSize * 11);
	if (container.type === "ellipse") {
		return Math.round((width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
	}
	if (container.type === "diamond") return Math.round(width / 2) - BOUND_TEXT_PADDING * 2;
	return width - BOUND_TEXT_PADDING * 2;
}

/** Where a label sits in its container (`computeBoundTextPosition`), from its size. */
function boundTextPosition(
	container: ExcalidrawElement,
	text: ExcalidrawElement,
	width: number,
	height: number,
): { x: number; y: number } {
	let offsetX = BOUND_TEXT_PADDING;
	let offsetY = BOUND_TEXT_PADDING;
	let maxHeight = container.height - BOUND_TEXT_PADDING * 2;
	if (container.type === "ellipse") {
		offsetX += (container.width / 2) * (1 - Math.SQRT2 / 2);
		offsetY += (container.height / 2) * (1 - Math.SQRT2 / 2);
		maxHeight = Math.round((container.height / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
	} else if (container.type === "diamond") {
		offsetX += container.width / 4;
		offsetY += container.height / 4;
		maxHeight = Math.round(container.height / 2) - BOUND_TEXT_PADDING * 2;
	}
	const maxWidth = boundTextMaxWidth(container, text.fontSize);
	const x = container.x + offsetX;
	const y = container.y + offsetY;
	return {
		x:
			text.textAlign === "left"
				? x
				: text.textAlign === "right"
					? x + maxWidth - width
					: x + maxWidth / 2 - width / 2,
		y:
			text.verticalAlign === "top"
				? y
				: text.verticalAlign === "bottom"
					? y + maxHeight - height
					: y + maxHeight / 2 - height / 2,
	};
}

/**
 * Where a free text's box moves when its size changes (`getAdjustedDimensions`):
 * it grows away from the side its alignment anchors, turned with the element.
 */
function adjustedPosition(
	element: ExcalidrawElement,
	width: number,
	height: number,
	previousWidth: number,
): { x: number; y: number } {
	if (element.textAlign === "center" && element.verticalAlign === "middle" && element.autoResize) {
		const previousHeight = element.text.split("\n").length * element.fontSize * element.lineHeight;
		return {
			x: element.x - (width - previousWidth) / 2,
			y: element.y - (height - previousHeight) / 2,
		};
	}
	const cos = Math.cos(element.angle);
	const sin = Math.sin(element.angle);
	const dx = (element.width - width) / 2;
	const dy = (element.height - height) / 2;
	let { x, y } = element;
	if (element.textAlign === "center") {
		x += dx;
	} else if (element.textAlign === "right") {
		x += dx * (1 + cos);
		y += dx * sin;
	} else {
		x += dx * (1 - cos);
		y -= dx * sin;
	}
	return { x: x + dy * sin, y: y + dy * (1 - cos) };
}

/** Whitespace-insensitive key: wrapping inserts line breaks but never changes the words. */
function words(text: string): string {
	return text.replace(/\s+/g, "");
}

/**
 * Give a text element its display text. When the text is the one the drawing
 * already laid out (only wrapping differs), Excalidraw's own wrapped lines and
 * box are kept; otherwise — a link shown as its alias, a transclusion — the
 * text is laid out anew as the plugin does on load (`refreshTextDimensions`):
 * wrapped to its container (or its own width, when sized by hand), measured,
 * and placed in its container or about its anchor.
 */
export function applyDisplayText(
	element: ExcalidrawElement,
	display: string,
	container: ExcalidrawElement | undefined,
	measure: TextMeasurer,
): ExcalidrawElement {
	if (words(display) === words(element.text) || words(display) === words(element.originalText)) {
		return element;
	}
	const width: LineWidth = (line) => measure.lineWidth(line, element.fontSize, element.fontFamily);
	const maxWidth = container
		? boundTextMaxWidth(container, element.fontSize)
		: element.autoResize
			? undefined
			: element.width;
	const text = maxWidth === undefined ? display : wrapText(display, maxWidth, width);
	const nextWidth = element.autoResize ? textWidth(text, width) : element.width;
	const height = text.split("\n").length * element.fontSize * element.lineHeight;
	const laidOut = { ...element, text, width: nextWidth, height };
	// An arrow places its label at render time, from the label's size.
	if (container?.type === "arrow") return laidOut;
	const position = container
		? boundTextPosition(container, element, nextWidth, height)
		: adjustedPosition(element, nextWidth, height, textWidth(element.text, width));
	return { ...laidOut, ...position };
}
