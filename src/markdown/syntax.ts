/**
 * Obsidian inline syntax, recognised by the markdown tokenizer itself.
 *
 * `[[wikilinks]]`, `![[embeds]]`, `==highlights==` and `$math$` used to be
 * found by regexes over the text nodes CommonMark had already produced. By then
 * the source was gone: `[[__init__]]` had become `[[<strong>init</strong>]]`,
 * `\$5` had lost its backslash, `$a*b*c$` had been split by emphasis, and a
 * highlight could only ever match inside one text node. Here each construct is a
 * micromark extension, so it claims its characters before emphasis, escapes and
 * links see them, exactly as code spans do:
 *
 * - `wikiLink` — `[[…]]` / `![[…]]`, one line, backslash escapes honoured; the
 *   node's `value` is the raw source (`![[Note#H|alias]]`).
 * - `highlight` — `==…==` with phrasing children (so `==**bold** [[Note]]==`
 *   keeps its markup), rendered as `<mark>`.
 * - `math` / `inlineMath` — `micromark-extension-math`, with Obsidian's rule
 *   that inline `$…$` may not start or end with whitespace (`$5 and $10` stays
 *   prose) and `$$…$$` written inline marked as display math.
 *
 * {@link registerObsidianSyntax} wires them into a processor the way
 * `remark-gfm` does; {@link parseObsidianMarkdown} is the parser every re-parse
 * path (transclusion, callout bodies, footnote and title rendering) uses, so a
 * fragment is read with the same rules as the page it came from.
 */
import type { Literal, Parent, PhrasingContent, Root, Text } from "mdast";
import type {
	CompileContext,
	Extension as FromMarkdownExtension,
	Token as MdastToken,
} from "mdast-util-from-markdown";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import { math } from "micromark-extension-math";
import type {
	Code,
	Construct,
	Effects,
	Event,
	Extension,
	Resolver,
	State,
	Token,
	TokenizeContext,
} from "micromark-util-types";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type Processor, unified } from "unified";
import { parseWikiLink } from "./parse-wikilink.js";
import { wikiLinkDisplayText } from "./utils.js";

/** `[[…]]` / `![[…]]`, as written. */
export interface WikiLinkNode extends Literal {
	type: "wikiLink";
}

/** `==…==`. Renders as `<mark>` through `data.hName`. */
export interface HighlightNode extends Parent {
	type: "highlight";
	children: PhrasingContent[];
}

declare module "mdast" {
	interface PhrasingContentMap {
		wikiLink: WikiLinkNode;
		highlight: HighlightNode;
	}
	interface RootContentMap {
		wikiLink: WikiLinkNode;
		highlight: HighlightNode;
	}
	interface TextData {
		/**
		 * Offsets in `value` of each `#` written `\#`. The parser drops the
		 * backslash, and Obsidian reads `\#` as literal text, never a tag.
		 */
		obsidianEscapedHashes?: number[];
	}
}

declare module "mdast-util-math" {
	interface InlineMathData {
		/** Set when the formula was written `$$…$$` inside a paragraph. */
		obsidianDisplay?: boolean;
	}
}

const CODE_EXCLAMATION = 33;
const CODE_EQUALS = 61;
const CODE_LEFT_BRACKET = 91;
const CODE_BACKSLASH = 92;
const CODE_RIGHT_BRACKET = 93;
const CODE_SPACE = 32;

function isLineEnding(code: Code): boolean {
	return code !== null && code < -2;
}

const UNICODE_PUNCTUATION = /\p{P}|\p{S}/u;
const UNICODE_WHITESPACE = /\s/u;

/** micromark's flanking classes: 1 = whitespace, 2 = punctuation, undefined = other. */
function classifyCharacter(code: Code): 1 | 2 | undefined {
	if (code === null || code < 0 || code === CODE_SPACE) return 1;
	const char = String.fromCodePoint(code);
	if (UNICODE_WHITESPACE.test(char)) return 1;
	if (UNICODE_PUNCTUATION.test(char)) return 2;
	return undefined;
}

// --- wikilinks ---------------------------------------------------------------

/**
 * `[[inner]]` or `![[inner]]` on one line. The first unescaped `]]` closes the
 * link (`\]` and `\|` stay inside, as `parseWikiLink` expects) and an empty
 * `[[]]` is not a link.
 */
function tokenizeWikiLink(effects: Effects, ok: State, nok: State): State {
	let hasInner = false;

	const start: State = (code) => {
		effects.enter("obsidianWikiLink" as Token["type"]);
		if (code === CODE_EXCLAMATION) {
			effects.consume(code);
			return openFirst;
		}
		return openFirst(code);
	};
	const openFirst: State = (code) => {
		if (code !== CODE_LEFT_BRACKET) return nok(code);
		effects.consume(code);
		return openSecond;
	};
	const openSecond: State = (code) => {
		if (code !== CODE_LEFT_BRACKET) return nok(code);
		effects.consume(code);
		return inside;
	};
	const inside: State = (code) => {
		if (code === null || isLineEnding(code)) return nok(code);
		if (code === CODE_RIGHT_BRACKET) {
			effects.consume(code);
			return closing;
		}
		hasInner = true;
		effects.consume(code);
		return code === CODE_BACKSLASH ? escaped : inside;
	};
	const escaped: State = (code) => {
		if (code === null || isLineEnding(code)) return nok(code);
		effects.consume(code);
		return inside;
	};
	const closing: State = (code) => {
		if (code === CODE_RIGHT_BRACKET) {
			if (!hasInner) return nok(code);
			effects.consume(code);
			effects.exit("obsidianWikiLink" as Token["type"]);
			return ok;
		}
		// The `]` was content (`[[a]b]]`).
		hasInner = true;
		return inside(code);
	};
	return start;
}

const wikiLinkConstruct: Construct = { name: "obsidianWikiLink", tokenize: tokenizeWikiLink };

const wikiLinkSyntax: Extension = {
	text: { [CODE_LEFT_BRACKET]: wikiLinkConstruct, [CODE_EXCLAMATION]: wikiLinkConstruct },
};

const wikiLinkFromMarkdown: FromMarkdownExtension = {
	enter: {
		obsidianWikiLink(this: CompileContext, token: MdastToken) {
			this.enter({ type: "wikiLink", value: "" } as WikiLinkNode as never, token);
		},
	},
	exit: {
		obsidianWikiLink(this: CompileContext, token: MdastToken) {
			const node = this.stack[this.stack.length - 1] as unknown as WikiLinkNode;
			node.value = this.sliceSerialize(token);
			this.exit(token);
		},
	},
};

// --- escaped `#` ---------------------------------------------------------------

/**
 * mdast-util-from-markdown's own handling of a character escape's value (append
 * it to the text node being built), plus a note of where an escaped `#` landed,
 * so the tag pass can tell `\#` from a tag.
 */
const escapedHashFromMarkdown: FromMarkdownExtension = {
	exit: {
		characterEscapeValue(this: CompileContext, token: MdastToken) {
			const tail = this.stack.pop() as unknown as Text;
			const value = this.sliceSerialize(token);
			if (value === "#") {
				const escaped = tail.data?.obsidianEscapedHashes ?? [];
				tail.data = { ...tail.data, obsidianEscapedHashes: [...escaped, tail.value.length] };
			}
			tail.value += value;
			if (tail.position) {
				tail.position.end = {
					line: token.end.line,
					column: token.end.column,
					offset: token.end.offset,
				};
			}
		},
	},
};

// --- highlights --------------------------------------------------------------

function splice<T>(list: T[], start: number, remove: number, items: T[]): void {
	// `Array#splice(...items)` spreads onto the stack; event lists can be long.
	const tail = list.slice(start + remove);
	list.length = start;
	for (const item of items) list.push(item);
	for (const item of tail) list.push(item);
}

function resolveAll(
	constructs: Array<Pick<Construct, "resolveAll">>,
	events: Event[],
	context: TokenizeContext,
): Event[] {
	const called: Resolver[] = [];
	let result = events;
	for (const construct of constructs) {
		const resolve = construct.resolveAll;
		if (resolve && !called.includes(resolve)) {
			result = resolve(result, context);
			called.push(resolve);
		}
	}
	return result;
}

type HighlightSequence = Token & { _open?: boolean; _close?: boolean };

/**
 * Pair `==` runs the way GFM pairs `~~`: a run opens when the next character
 * is not whitespace (or is punctuation after a non-space), closes
 * symmetrically, and the span between is re-resolved so emphasis, links and
 * wikilinks inside a highlight stay real nodes.
 */
function resolveAllHighlight(events: Event[], context: TokenizeContext): Event[] {
	for (let index = 0; index < events.length; index += 1) {
		const close = events[index] as Event;
		const closeToken = close[1] as HighlightSequence;
		if (
			close[0] !== "enter" ||
			closeToken.type !== ("highlightSequenceTemporary" as Token["type"]) ||
			!closeToken._close
		) {
			continue;
		}
		for (let open = index - 1; open >= 0; open -= 1) {
			const opener = events[open] as Event;
			const openToken = opener[1] as HighlightSequence;
			if (
				opener[0] !== "exit" ||
				openToken.type !== ("highlightSequenceTemporary" as Token["type"]) ||
				!openToken._open
			) {
				continue;
			}
			openToken.type = "highlightSequence" as Token["type"];
			closeToken.type = "highlightSequence" as Token["type"];
			const highlight = {
				type: "obsidianHighlight",
				start: { ...openToken.start },
				end: { ...closeToken.end },
			} as unknown as Token;
			const text = {
				type: "obsidianHighlightText",
				start: { ...openToken.end },
				end: { ...closeToken.start },
			} as unknown as Token;
			const next: Event[] = [
				["enter", highlight, context],
				["enter", openToken, context],
				["exit", openToken, context],
				["enter", text, context],
			];
			const insideSpan = context.parser.constructs.insideSpan.null;
			if (insideSpan) {
				for (const event of resolveAll(insideSpan, events.slice(open + 1, index), context)) {
					next.push(event);
				}
			}
			next.push(
				["exit", text, context],
				["enter", closeToken, context],
				["exit", closeToken, context],
				["exit", highlight, context],
			);
			splice(events, open - 1, index - open + 3, next);
			index = open + next.length - 2;
			break;
		}
	}
	for (const event of events) {
		if (event[1].type === ("highlightSequenceTemporary" as Token["type"])) {
			event[1].type = "data";
		}
	}
	return events;
}

function tokenizeHighlight(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	const previous = this.previous;
	const events = this.events;
	let size = 0;

	const more: State = (code) => {
		const before = classifyCharacter(previous);
		if (code === CODE_EQUALS) {
			// `===` and longer are never highlight markers.
			if (size > 1) return nok(code);
			effects.consume(code);
			size += 1;
			return more;
		}
		if (size < 2) return nok(code);
		const token = effects.exit("highlightSequenceTemporary" as Token["type"]) as HighlightSequence;
		const after = classifyCharacter(code);
		token._open = !after || (after === 2 && Boolean(before));
		token._close = !before || (before === 2 && Boolean(after));
		return ok(code);
	};

	return (code) => {
		const last = events[events.length - 1];
		if (previous === CODE_EQUALS && last && last[1].type !== "characterEscape") {
			return nok(code);
		}
		effects.enter("highlightSequenceTemporary" as Token["type"]);
		return more(code);
	};
}

const highlightConstruct: Construct = {
	name: "obsidianHighlight",
	tokenize: tokenizeHighlight,
	resolveAll: resolveAllHighlight,
};

const highlightSyntax: Extension = {
	text: { [CODE_EQUALS]: highlightConstruct },
	insideSpan: { null: [highlightConstruct] },
	attentionMarkers: { null: [CODE_EQUALS] },
};

const highlightFromMarkdown: FromMarkdownExtension = {
	canContainEols: ["highlight"],
	enter: {
		obsidianHighlight(this: CompileContext, token: MdastToken) {
			this.enter(
				{ type: "highlight", children: [], data: { hName: "mark" } } as HighlightNode as never,
				token,
			);
		},
	},
	exit: {
		obsidianHighlight(this: CompileContext, token: MdastToken) {
			this.exit(token);
		},
	},
};

// `remark-stringify` is only reached by tests and custom pipelines; the
// handlers write what the node renders as, so the output stays faithful.
const obsidianToMarkdown: ToMarkdownExtension = {
	handlers: {
		wikiLink: (node: WikiLinkNode) => node.value,
		highlight: (node: HighlightNode, _parent, state, info) =>
			`<mark>${state.containerPhrasing(node, { ...info, before: ">", after: "<" })}</mark>`,
	} as ToMarkdownExtension["handlers"],
};

// --- math ----------------------------------------------------------------------

/**
 * `mdast-util-math`, plus Obsidian's inline rule. micromark-extension-math
 * accepts `$ 5 and $`; Obsidian (like Pandoc) does not let an inline formula
 * start or end with whitespace, so such a span goes back to the text it was
 * written as. `$$…$$` inside a paragraph is display math in Obsidian.
 */
function obsidianMathFromMarkdown(): FromMarkdownExtension {
	const base = mathFromMarkdown();
	const exitMathText = base.exit?.mathText;
	return {
		...base,
		exit: {
			...base.exit,
			mathText(this: CompileContext, token: MdastToken) {
				exitMathText?.call(this, token);
				const parent = this.stack[this.stack.length - 1] as unknown as Parent;
				const node = parent.children[parent.children.length - 1] as unknown as {
					type: string;
					value: string;
					data?: Record<string, unknown>;
				};
				const raw = this.sliceSerialize(token);
				const display = raw.startsWith("$$");
				const inner = raw.slice(display ? 2 : 1, display ? -2 : -1);
				if (!display && (/^\s/.test(inner) || /\s$/.test(inner))) {
					node.type = "text";
					node.value = raw;
					delete node.data;
					return;
				}
				if (display) node.data = { ...node.data, obsidianDisplay: true };
			},
		},
	};
}

// --- wiring --------------------------------------------------------------------

export interface ObsidianSyntaxOptions {
	/** Tokenize `$…$` / `$$…$$` (only when the site renders math). */
	enableMath: boolean;
}

/** The part of a unified processor the registration touches. */
interface DataHolder {
	data(): object;
}

/**
 * Add the Obsidian constructs to a processor's parser and serializer, the way
 * `remark-gfm` registers GFM. Call from a plugin attacher (`this`).
 */
export function registerObsidianSyntax(
	processor: DataHolder,
	options: ObsidianSyntaxOptions,
): void {
	const data = processor.data() as Record<string, unknown[] | undefined>;
	const add = (key: string, ...values: unknown[]): void => {
		data[key] = [...(data[key] ?? []), ...values];
	};
	add("micromarkExtensions", wikiLinkSyntax, highlightSyntax);
	add(
		"fromMarkdownExtensions",
		wikiLinkFromMarkdown,
		highlightFromMarkdown,
		escapedHashFromMarkdown,
	);
	add("toMarkdownExtensions", obsidianToMarkdown);
	if (options.enableMath) {
		add("micromarkExtensions", math());
		add("fromMarkdownExtensions", obsidianMathFromMarkdown());
		add("toMarkdownExtensions", mathToMarkdown());
	}
}

function obsidianSyntax(this: DataHolder, options: ObsidianSyntaxOptions): void {
	registerObsidianSyntax(this, options);
}

const parsers: { math?: Processor<Root>; plain?: Processor<Root> } = {};

/**
 * Parse markdown with GFM and the Obsidian constructs — the same reading
 * Rspress plus this plugin gives a page.
 */
export function parseObsidianMarkdown(source: string, options: ObsidianSyntaxOptions): Root {
	const key = options.enableMath ? "math" : "plain";
	parsers[key] ??= unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(obsidianSyntax, options)
		.freeze() as unknown as Processor<Root>;
	return parsers[key].parse(source) as Root;
}

/**
 * The text a run of mdast nodes reads as, for tooltips and fallback heading
 * ids: a wikilink shows its display text, math its TeX, markup its content,
 * raw HTML and footnote calls nothing.
 */
export function plainText(nodes: readonly unknown[]): string {
	let out = "";
	for (const node of nodes as Array<{ type?: string; value?: unknown; children?: unknown[] }>) {
		if (node.type === "wikiLink" && typeof node.value === "string") {
			const embed = node.value.startsWith("!");
			const inner = node.value.slice(embed ? 3 : 2, -2);
			if (!embed) out += wikiLinkDisplayText(parseWikiLink(inner, node.value));
		} else if (node.type === "html" || node.type === "footnoteReference") {
			// Nothing a reader sees as text.
		} else if (node.type === "break") {
			out += " ";
		} else if (typeof node.value === "string") {
			out += node.value;
		} else if (Array.isArray(node.children)) {
			out += plainText(node.children);
			if (node.type === "paragraph") out += " ";
		}
	}
	return out;
}
