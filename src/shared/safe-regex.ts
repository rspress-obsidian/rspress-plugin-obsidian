/**
 * Guards for regular expressions written in the vault: Tasks' `regex
 * matches`, Dataview's `regextest`/`regexmatch`/`regexreplace`, Bases and
 * Templater regex literals, and the matchers compiled from vault date formats
 * (Dataview's `date(text, format)`, Moment's strict parse). They run during
 * the build on JavaScript's backtracking engine, where a pattern such as
 * `(a+)+$` takes exponential time on a short subject and would hang the build.
 * Obsidian runs such a pattern; a site build refuses it, and its message says
 * so.
 *
 * The pattern is parsed as the `RegExp` constructor reads it under the given
 * flags: without `u` or `v`, `\p{1,}` is `p` repeated and `\u{2}` is `uu`,
 * as the web-compatible grammar has it, while with them `\p{L}` is a property
 * and `\u{1F600}` a code point. Four shapes are refused, each conservatively
 * (a refused pattern may be harmless; an accepted one has none of them):
 *
 * - nested quantifiers: a repeated group that itself contains a repeat
 *   (`(a+)+`, `(a{1,1000}){1,1000}`), or a quantifier stacked on a quantifier
 *   (`a{2}*`). A group whose passes each begin with a character nothing else
 *   in the pass can match is exempt (`^\d{1,3}(\.\d{1,3}){3}$`,
 *   `(?:,\s*\w+)*`): a text splits into its passes one way only;
 * - a repeated group holding a choice whose options can start on the same
 *   character: alternatives (`(a|a)*`, `(a|ab)*c`) or an optional part
 *   (`(a?b?)*`, where `ab` is one pass or two);
 * - unbounded quantifiers (`*`, `+`, `{n,}`, and `{n,m}` allowing more than
 *   100 passes beyond its minimum) in a row over characters they share, with
 *   nothing between them that only one of them can match (`.*.*=`, `\d*\d*x`,
 *   `\d{0,9999}\d{0,9999}x`, `\d+\.?\d*`, `.*,.*=`): each one multiplies the
 *   work by the subject's length, and so does retrying at every position. A
 *   pattern anchored with `^` (and no `m` flag) may chain two
 *   (`^(\w+):\s*(.*)$`); one that is not, only one;
 * - choices in a row over characters they share whose options multiply past
 *   2^20 (about a million) ways to split one text: each quantifier counts its
 *   number of pass counts (2 for `?`, 3 for `\d{1,3}`, 101 at most), and
 *   alternatives that can match at the same position (`a|aa`, not `Jan|Jun`)
 *   count how many can. `\d{0,99}` three times in a row is accepted, four
 *   times refused, as are twenty-one `a?` (`a?a?…a?aaa`) or twenty-one
 *   `(?:a|aa)`. The budget is per match attempt; retrying at every position
 *   multiplies every pattern's work alike.
 *
 * Characters compare case-insensitively under the `i` flag (or an `(?i:…)`
 * group). Lookarounds are checked on their own, and a backreference counts as
 * any text. Under `v`, a class or property that matches strings
 * (`[\q{a|aa}]`, `\p{RGI_Emoji}`) counts as a choice of lengths.
 * {@link MAX_REGEX_PATTERN_LENGTH} caps the size of what is analysed.
 * Node-free: every interpreter imports it.
 */

/** The longest pattern a build compiles. */
export const MAX_REGEX_PATTERN_LENGTH = 1000;

/** A pattern refused before it runs; Obsidian would have run it. */
export class UnsafeRegexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeRegexError";
	}
}

const OBSIDIAN_WOULD_RUN =
	"Obsidian would run it, but a site build refuses it so the build cannot hang";

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

type Range = readonly [number, number];
/** Characters (code points) as sorted, disjoint, inclusive ranges. */
type CharSet = readonly Range[];

const MAX_CHAR = 0x10ffff;
const NOTHING: CharSet = [];
const ANYTHING: CharSet = [[0, MAX_CHAR]];
const DIGIT: CharSet = [[48, 57]];
const WORD: CharSet = [
	[48, 57],
	[65, 90],
	[95, 95],
	[97, 122],
];
const SPACE: CharSet = [
	[9, 13],
	[32, 32],
	[160, 160],
	[0x1680, 0x1680],
	[0x2000, 0x200a],
	[0x2028, 0x2029],
	[0x202f, 0x202f],
	[0x205f, 0x205f],
	[0x3000, 0x3000],
	[0xfeff, 0xfeff],
];

function single(code: number): CharSet {
	return [[code, code]];
}

function union(...sets: CharSet[]): CharSet {
	const ranges = sets.flat().sort((left, right) => left[0] - right[0]);
	const merged: Array<[number, number]> = [];
	for (const [low, high] of ranges) {
		const last = merged[merged.length - 1];
		if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
		else merged.push([low, high]);
	}
	return merged;
}

function complement(set: CharSet): CharSet {
	const ranges: Range[] = [];
	let next = 0;
	for (const [low, high] of set) {
		if (low > next) ranges.push([next, low - 1]);
		next = high + 1;
	}
	if (next <= MAX_CHAR) ranges.push([next, MAX_CHAR]);
	return ranges;
}

function intersects(left: CharSet, right: CharSet): boolean {
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		const [leftLow, leftHigh] = left[i] as Range;
		const [rightLow, rightHigh] = right[j] as Range;
		if (leftHigh < rightLow) i += 1;
		else if (rightHigh < leftLow) j += 1;
		else return true;
	}
	return false;
}

/**
 * Each character that has another case, paired with every other member of its
 * case class, sorted by character: `[k, K]`, `[k, K (Kelvin)]`, `[ϑ, θ]`, … A
 * class joins a character with its one-character lower and upper case, and
 * characters whose case is several (`ﬅ` → `ST`) with those sharing it, since
 * `u` folding equates some (`ﬅ`, `ﬆ`); then everything joined, transitively
 * (`ϑ` → `Θ` → `θ` ← `ϴ`). Built on first use.
 */
let casePairs: ReadonlyArray<Range> | undefined;

function caseClassPairs(): ReadonlyArray<Range> {
	if (casePairs) return casePairs;
	const classOf = new Map<number, Set<number>>();
	const join = (left: number, right: number) => {
		const leftClass = classOf.get(left) ?? new Set([left]);
		const rightClass = classOf.get(right) ?? new Set([right]);
		if (leftClass === rightClass) return;
		for (const code of rightClass) leftClass.add(code);
		for (const code of leftClass) classOf.set(code, leftClass);
	};
	const byLongCase = new Map<string, number>();
	for (let code = 0; code <= MAX_CHAR; code += 1) {
		if (code >= 0xd800 && code <= 0xdfff) continue;
		const char = String.fromCodePoint(code);
		for (const other of [char.toLowerCase(), char.toUpperCase()]) {
			if (other === char) continue;
			const otherCode = other.codePointAt(0) ?? code;
			if (String.fromCodePoint(otherCode) === other) {
				join(code, otherCode);
				continue;
			}
			const sharing = byLongCase.get(other);
			if (sharing === undefined) byLongCase.set(other, code);
			else join(sharing, code);
		}
	}
	const pairs: Range[] = [];
	for (const [code, members] of classOf) {
		for (const other of members) if (other !== code) pairs.push([code, other]);
	}
	casePairs = pairs.sort((left, right) => left[0] - right[0]);
	return casePairs;
}

const foldedSets = new WeakMap<CharSet, CharSet>();

/**
 * `set` with the rest of each of its characters' case classes: a superset of
 * what the `i` flag equates them with, with or without `u`.
 */
function caseFolded(set: CharSet): CharSet {
	const cached = foldedSets.get(set);
	if (cached) return cached;
	const pairs = caseClassPairs();
	const extra: Range[] = [];
	for (const [low, high] of set) {
		// Binary search for the first pair at or after `low`.
		let from = 0;
		let to = pairs.length;
		while (from < to) {
			const middle = (from + to) >> 1;
			if ((pairs[middle] as Range)[0] < low) from = middle + 1;
			else to = middle;
		}
		for (let index = from; index < pairs.length; index += 1) {
			const [code, other] = pairs[index] as Range;
			if (code > high) break;
			extra.push([other, other]);
		}
	}
	const folded = union(set, extra);
	foldedSets.set(set, folded);
	return folded;
}

function overlaps(left: CharSet, right: CharSet, fold: boolean): boolean {
	return fold ? intersects(caseFolded(left), caseFolded(right)) : intersects(left, right);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A pattern as the checks see it: what each part can match, not how it captures. */
type PatternNode =
	| { kind: "char"; set: CharSet }
	/** `^`: where a match may begin. */
	| { kind: "start" }
	/** `$`, `\b`, `\B`. */
	| { kind: "empty" }
	/** `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`: zero-width, and atomic in JavaScript. */
	| { kind: "look"; body: PatternNode }
	| { kind: "backreference" }
	| { kind: "sequence"; items: PatternNode[] }
	| { kind: "alternation"; branches: PatternNode[] }
	| { kind: "repeat"; body: PatternNode; min: number; max: number };

const EMPTY: PatternNode = { kind: "empty" };
const BACKREFERENCE: PatternNode = { kind: "backreference" };

/**
 * How many passes beyond its minimum a bounded quantifier may allow and still
 * count as bounded (see the module comment): `\d{1,3}` allows 2, `\d{4}`
 * none. Up to it, a quantifier multiplies the work by at most 101, as
 * spelling the choice out would; one allowing more, such as `\d{0,9999}`,
 * costs what `*` does on any subject a build meets. 100 keeps the bounded
 * quantifiers vault patterns use (`\d{1,3}`, `\w{2,64}`, `.{0,80}`) bounded.
 */
const LONG_REPEAT = 100;

/**
 * Under `v`, a class holding `\q{…}` or a property of strings
 * (`\p{RGI_Emoji}`): it matches one of several strings, the empty one
 * possibly included, and repeating it is a choice between their lengths
 * (`[\q{a|aa}]+` is `(?:a|aa)+`). Read as `.{0,2}`: the checks tell one
 * character from several, and a bounded quantifier from a long one, and a
 * pattern's strings come in fewer than {@link LONG_REPEAT} lengths. A new
 * node each time, since the run check tells quantifiers apart by identity.
 */
function mayMatchAString(): PatternNode {
	return { kind: "repeat", body: { kind: "char", set: ANYTHING }, min: 0, max: 2 };
}

/** The prefix of a group, after its `(`: a lookaround (group 1), `?<name>`, or `?:` with optional modifiers (group 2). */
const GROUP_PREFIX = /\?(?:(<?[=!])|<[^>]*>|([a-z]*)(?:-[a-z]*)?:)/y;
/** A named group's `(?<`, or text that looks like one (`\(?<a>`, conservatively). */
const NAMED_GROUP = /\(\?<(?![=!])/;
const QUANTIFIER = /[*+?]|\{(\d+)(?:(,)(\d*))?\}/y;
const HEX = /[0-9a-f]+/iy;
/** The trail of an escaped surrogate pair, after its lead. */
const TRAIL_SURROGATE = /\\u(d[c-f][0-9a-f]{2})/iy;
/** A legacy octal escape after its `\`: at most `\377`, so `\477` is `\47` then `7`. */
const LEGACY_OCTAL = /[0-3][0-7]{0,2}|[4-7][0-7]?/y;
const STRING_PROPERTIES =
	"Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji(?:_Flag_Sequence|_Modifier_Sequence|_Tag_Sequence|_ZWJ_Sequence)?";
/** A property of strings, after its `\`. */
const STRING_PROPERTY = new RegExp(`p\\{(?:${STRING_PROPERTIES})\\}`, "y");
/** What makes a `v`-mode class match strings. */
const STRINGS_IN_CLASS = new RegExp(`\\\\q\\{|\\\\p\\{(?:${STRING_PROPERTIES})\\}`);

/**
 * A lenient reader: whatever it cannot make sense of is a literal, since the
 * `RegExp` constructor, not this, decides whether the pattern is valid. What
 * it does read, it reads as the constructor does under the same flags: without
 * `u` or `v`, the web-compatible grammar applies, so `\p{1,}` is `p` repeated,
 * `\u{2}` is `uu`, `\k<a>` the text `k<a>` unless there is a named group,
 * `\c1` in a class a control character, and characters are UTF-16 code units.
 */
class PatternParser {
	private index = 0;
	private depth = 0;
	/** The `i` flag, or an `(?i:…)` group anywhere (conservatively, for the whole pattern). */
	caseInsensitive: boolean;
	/** `u` or `v`: `\p{…}`, `\u{…}` and escaped surrogate pairs mean what they say. */
	private readonly unicode: boolean;
	private readonly unicodeSets: boolean;
	/** Whether `\k<name>` is a backreference rather than text. */
	private readonly namedGroups: boolean;

	constructor(
		private readonly pattern: string,
		flags: string,
	) {
		this.caseInsensitive = flags.includes("i");
		this.unicodeSets = flags.includes("v");
		this.unicode = this.unicodeSets || flags.includes("u");
		this.namedGroups = this.unicode || NAMED_GROUP.test(pattern);
	}

	parse(): PatternNode {
		const node = this.parseAlternation();
		// An unbalanced `)` is a SyntaxError for `RegExp`; read on past it.
		while (this.index < this.pattern.length) {
			this.index += 1;
			this.parseAlternation();
		}
		return node;
	}

	private parseAlternation(): PatternNode {
		const branches = [this.parseSequence()];
		while (this.pattern[this.index] === "|") {
			this.index += 1;
			branches.push(this.parseSequence());
		}
		return branches.length === 1 ? (branches[0] as PatternNode) : { kind: "alternation", branches };
	}

	private parseSequence(): PatternNode {
		const items: PatternNode[] = [];
		while (this.index < this.pattern.length) {
			const char = this.pattern[this.index];
			if (char === "|" || (char === ")" && this.depth > 0)) break;
			let node = this.parseAtom();
			// Each further quantifier wraps the last, so `a+*` repeats a repeat.
			for (let quantifier = this.readQuantifier(); quantifier; quantifier = this.readQuantifier()) {
				// A trailing `?` makes the quantifier lazy, which matches no less.
				if (this.pattern[this.index] === "?") this.index += 1;
				node = { kind: "repeat", body: node, ...quantifier };
			}
			items.push(node);
		}
		return items.length === 1 ? (items[0] as PatternNode) : { kind: "sequence", items };
	}

	/** `*`, `+`, `?`, `{n}`, `{n,}` or `{n,m}`; any other `{` is text (without `u`) or invalid. */
	private readQuantifier(): { min: number; max: number } | undefined {
		QUANTIFIER.lastIndex = this.index;
		const match = QUANTIFIER.exec(this.pattern);
		if (!match) return undefined;
		this.index = QUANTIFIER.lastIndex;
		const [text, min, comma, max] = match;
		if (text === "*") return { min: 0, max: Number.POSITIVE_INFINITY };
		if (text === "+") return { min: 1, max: Number.POSITIVE_INFINITY };
		if (text === "?") return { min: 0, max: 1 };
		const low = Number(min);
		if (comma === undefined) return { min: low, max: low };
		return { min: low, max: max === "" ? Number.POSITIVE_INFINITY : Number(max) };
	}

	private parseAtom(): PatternNode {
		const char = this.pattern[this.index];
		if (char === "(") return this.parseGroup();
		if (char === "[") {
			return this.unicodeSets ? this.parseSetClass() : { kind: "char", set: this.parseClass() };
		}
		if (char === "\\") return this.parseEscape();
		if (char === "^" || char === "$") {
			this.index += 1;
			return char === "^" ? { kind: "start" } : EMPTY;
		}
		if (char === ".") {
			this.index += 1;
			return { kind: "char", set: ANYTHING };
		}
		return { kind: "char", set: single(this.readLiteral()) };
	}

	/** One character: a code point under `u`/`v`, else a UTF-16 code unit, as the pattern compares them. */
	private readLiteral(): number {
		const code = this.unicode
			? (this.pattern.codePointAt(this.index) ?? 0)
			: this.pattern.charCodeAt(this.index);
		this.index += code > 0xffff ? 2 : 1;
		return code;
	}

	private parseGroup(): PatternNode {
		this.index += 1;
		GROUP_PREFIX.lastIndex = this.index;
		const prefix = GROUP_PREFIX.exec(this.pattern);
		if (prefix) {
			this.index = GROUP_PREFIX.lastIndex;
			if (prefix[2]?.includes("i")) this.caseInsensitive = true;
		}
		this.depth += 1;
		const body = this.parseAlternation();
		this.depth -= 1;
		if (this.pattern[this.index] === ")") this.index += 1;
		return prefix?.[1] ? { kind: "look", body } : body;
	}

	private parseEscape(): PatternNode {
		this.index += 1;
		const char = this.pattern[this.index];
		if (char === undefined) return { kind: "char", set: single(92) };
		if (char === "b" || char === "B") {
			this.index += 1;
			return EMPTY;
		}
		// Without `u`, `\1`–`\9` past the last group are an octal escape or a
		// digit; read as backreferences all the same, since any text is more
		// than either, and so refuses no less.
		if (char >= "1" && char <= "9") {
			while (/\d/.test(this.pattern[this.index] ?? "")) this.index += 1;
			return BACKREFERENCE;
		}
		if (char === "k" && this.namedGroups && this.pattern[this.index + 1] === "<") {
			const end = this.pattern.indexOf(">", this.index);
			if (end >= 0) {
				this.index = end + 1;
				return BACKREFERENCE;
			}
		}
		if (this.unicodeSets) {
			STRING_PROPERTY.lastIndex = this.index;
			if (STRING_PROPERTY.test(this.pattern)) {
				this.index = STRING_PROPERTY.lastIndex;
				return mayMatchAString();
			}
		}
		return { kind: "char", set: this.readEscapedSet(false) };
	}

	/** The characters an escape names, from the character after its `\`. */
	private readEscapedSet(inClass: boolean): CharSet {
		const char = this.pattern[this.index] ?? "";
		switch (char) {
			case "d":
			case "D":
			case "w":
			case "W":
			case "s":
			case "S": {
				this.index += 1;
				const set = char.toLowerCase() === "d" ? DIGIT : char.toLowerCase() === "w" ? WORD : SPACE;
				return char === char.toLowerCase() ? set : complement(set);
			}
			case "p":
			case "P":
				this.index += 1;
				// Without `u`/`v`, the letter, and a `{…}` after it is a quantifier or text.
				if (!this.unicode) return single(char.charCodeAt(0));
				// A Unicode property: any character, conservatively.
				if (this.pattern[this.index] === "{") {
					const end = this.pattern.indexOf("}", this.index);
					if (end >= 0) this.index = end + 1;
				}
				return ANYTHING;
			case "n":
				this.index += 1;
				return single(10);
			case "r":
				this.index += 1;
				return single(13);
			case "t":
				this.index += 1;
				return single(9);
			case "v":
				this.index += 1;
				return single(11);
			case "f":
				this.index += 1;
				return single(12);
			case "c": {
				// A control character: `\cJ`, and without `u` also `\c1` or `\c_` in a class.
				const letter = this.pattern[this.index + 1] ?? "";
				const control = inClass && !this.unicode ? /[a-z0-9_]/i : /[a-z]/i;
				if (control.test(letter)) {
					this.index += 2;
					return single(letter.charCodeAt(0) % 32);
				}
				// Otherwise (without `u`) the `\` is itself, and the `c` is read next.
				return single(92);
			}
			case "x":
			case "u":
				return single(this.readHexEscape(char));
		}
		if (char >= "0" && char <= "7") {
			LEGACY_OCTAL.lastIndex = this.index;
			const digits = LEGACY_OCTAL.exec(this.pattern)?.[0] ?? char;
			this.index += digits.length;
			return single(Number.parseInt(digits, 8));
		}
		return single(this.readLiteral());
	}

	/**
	 * `\xHH`, `\uHHHH`, and under `u`/`v` `\u{H…}` and an escaped surrogate pair
	 * (`\uD83D\uDE00`, one character); anything else is the letter itself.
	 */
	private readHexEscape(letter: "x" | "u"): number {
		const start = this.index + 1;
		const braced = this.unicode && letter === "u" && this.pattern[start] === "{";
		HEX.lastIndex = braced ? start + 1 : start;
		const digits = HEX.exec(this.pattern)?.[0] ?? "";
		const length = letter === "x" ? 2 : 4;
		if (braced && this.pattern[HEX.lastIndex] === "}" && digits.length > 0) {
			this.index = HEX.lastIndex + 1;
			return Math.min(Number.parseInt(digits, 16), MAX_CHAR);
		}
		if (!braced && digits.length >= length) {
			this.index = start + length;
			const code = Number.parseInt(digits.slice(0, length), 16);
			if (!this.unicode || code < 0xd800 || code > 0xdbff) return code;
			TRAIL_SURROGATE.lastIndex = this.index;
			const trail = TRAIL_SURROGATE.exec(this.pattern)?.[1];
			if (trail === undefined) return code;
			this.index = TRAIL_SURROGATE.lastIndex;
			return 0x10000 + (code - 0xd800) * 0x400 + (Number.parseInt(trail, 16) - 0xdc00);
		}
		this.index += 1;
		return letter.charCodeAt(0);
	}

	/**
	 * A `v`-mode class, with nested classes and set operations: any character,
	 * conservatively, or {@link mayMatchAString} when it can match strings.
	 */
	private parseSetClass(): PatternNode {
		const start = this.index;
		this.index += 1;
		let depth = 1;
		while (this.index < this.pattern.length && depth > 0) {
			const char = this.pattern[this.index];
			if (char === "\\") this.index += 1;
			else if (char === "[") depth += 1;
			else if (char === "]") depth -= 1;
			this.index += 1;
		}
		return STRINGS_IN_CLASS.test(this.pattern.slice(start, this.index))
			? mayMatchAString()
			: { kind: "char", set: ANYTHING };
	}

	private parseClass(): CharSet {
		this.index += 1;
		const negated = this.pattern[this.index] === "^";
		if (negated) this.index += 1;
		const parts: CharSet[] = [];
		while (this.index < this.pattern.length && this.pattern[this.index] !== "]") {
			const from = this.readClassAtom();
			const isRange =
				this.pattern[this.index] === "-" &&
				this.index + 1 < this.pattern.length &&
				this.pattern[this.index + 1] !== "]";
			if (!isRange) {
				parts.push(from);
				continue;
			}
			this.index += 1;
			const to = this.readClassAtom();
			const low = singleCode(from);
			const high = singleCode(to);
			parts.push(
				low !== undefined && high !== undefined && low <= high
					? [[low, high]]
					: union(from, single(45), to),
			);
		}
		this.index += 1;
		const set = union(...parts);
		return negated ? complement(set) : set;
	}

	private readClassAtom(): CharSet {
		if (this.pattern[this.index] !== "\\") return single(this.readLiteral());
		this.index += 1;
		if (this.pattern[this.index] === "b") {
			this.index += 1;
			return single(8);
		}
		return this.readEscapedSet(true);
	}
}

function singleCode(set: CharSet): number | undefined {
	const [range] = set;
	return set.length === 1 && range && range[0] === range[1] ? range[0] : undefined;
}

// ---------------------------------------------------------------------------
// What a node matches
// ---------------------------------------------------------------------------

function nullable(node: PatternNode): boolean {
	switch (node.kind) {
		case "char":
			return false;
		case "sequence":
			return node.items.every(nullable);
		case "alternation":
			return node.branches.some(nullable);
		case "repeat":
			return node.min === 0 || nullable(node.body);
		default:
			return true;
	}
}

/** The characters a match of `node` can start with. A backreference may start with any. */
function first(node: PatternNode): CharSet {
	switch (node.kind) {
		case "char":
			return node.set;
		case "backreference":
			return ANYTHING;
		case "sequence": {
			const sets: CharSet[] = [];
			for (const item of node.items) {
				sets.push(first(item));
				if (!nullable(item)) break;
			}
			return union(...sets);
		}
		case "alternation":
			return union(...node.branches.map(first));
		case "repeat":
			return node.max === 0 ? NOTHING : first(node.body);
		default:
			return NOTHING;
	}
}

/** Every character a match of `node` can contain. */
function alphabet(node: PatternNode): CharSet {
	switch (node.kind) {
		case "char":
			return node.set;
		case "backreference":
			return ANYTHING;
		case "sequence":
			return union(...node.items.map(alphabet));
		case "alternation":
			return union(...node.branches.map(alphabet));
		case "repeat":
			return node.max === 0 ? NOTHING : alphabet(node.body);
		default:
			return NOTHING;
	}
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Whether `node` holds a quantifier that repeats (`*`, `+`, `{2}`, `{1,}`), as opposed to `?`. */
function repeats(node: PatternNode): boolean {
	switch (node.kind) {
		case "repeat":
			return node.max > 1 || repeats(node.body);
		case "sequence":
			return node.items.some(repeats);
		case "alternation":
			return node.branches.some(repeats);
		default:
			return false;
	}
}

/** The parts `node` matches one after another, groups flattened. */
function parts(node: PatternNode): PatternNode[] {
	return node.kind === "sequence" ? node.items.flatMap(parts) : [node];
}

/**
 * Whether every pass of a repeated `body` begins with a character that
 * nothing else in the pass can match (`(\.\d{1,3}){3}`, `(?:,\s*\w+)*`): a
 * text then splits into passes one way only, at those characters, and a
 * repeat inside a pass ends where the next pass's character comes.
 */
function delimited(body: PatternNode, fold: boolean): boolean {
	const items = parts(body);
	// Anchors and lookarounds before it match no character.
	const at = items.findIndex((item) => alphabet(item).length > 0);
	const delimiter = items[at];
	if (delimiter?.kind !== "char") return false;
	return !overlaps(delimiter.set, union(...items.slice(at + 1).map(alphabet)), fold);
}

/**
 * Whether `node` repeats a repeat: `(a+)+`, `(?:\w*x)*`, `((a+))+`, `a{2}*`;
 * unless each pass starts with its own delimiter ({@link delimited}).
 */
function nestsQuantifiers(node: PatternNode, fold: boolean): boolean {
	switch (node.kind) {
		case "repeat":
			return (
				(node.max > 1 && repeats(node.body) && !delimited(node.body, fold)) ||
				nestsQuantifiers(node.body, fold)
			);
		case "sequence":
			return node.items.some((item) => nestsQuantifiers(item, fold));
		case "alternation":
			return node.branches.some((branch) => nestsQuantifiers(branch, fold));
		case "look":
			return nestsQuantifiers(node.body, fold);
		default:
			return false;
	}
}

/** One repeated group whose body is being checked for ambiguous choices. */
interface Loop {
	/** What the next pass starts with. */
	first: CharSet;
	/** Whether a pass may match nothing and the loop still go on (`{2,}` below its minimum). */
	emptyPasses: boolean;
	fold: boolean;
}

/**
 * Whether, inside one pass of `loop`, `node` holds a choice — alternatives, or
 * an optional part against skipping it — whose options can start on the same
 * character: a text one option takes, the other can take too, and every
 * repetition doubles the ways to match. `follow` is what the rest of the pass
 * starts with, `reachesEnd` whether the rest can be empty, and `consumed`
 * whether the pass has matched something before `node` (a pass that matched
 * nothing ends the loop, so it cannot be followed by another).
 */
function ambiguousChoice(
	node: PatternNode,
	follow: CharSet,
	reachesEnd: boolean,
	consumed: boolean,
	loop: Loop,
): boolean {
	const rest = () =>
		reachesEnd && (consumed || loop.emptyPasses) ? union(follow, loop.first) : follow;
	const startsOf = (option: PatternNode, after: CharSet) =>
		nullable(option) ? union(first(option), after) : first(option);
	switch (node.kind) {
		case "sequence": {
			const { items } = node;
			const follows: CharSet[] = [];
			const ends: boolean[] = [];
			let after = follow;
			let empty = reachesEnd;
			for (let position = items.length - 1; position >= 0; position -= 1) {
				const item = items[position] as PatternNode;
				follows[position] = after;
				ends[position] = empty;
				after = startsOf(item, after);
				empty &&= nullable(item);
			}
			let before = consumed;
			for (const [position, item] of items.entries()) {
				const itemFollow = follows[position] as CharSet;
				if (ambiguousChoice(item, itemFollow, ends[position] === true, before, loop)) return true;
				// Lookarounds and anchors match no character; a backreference may.
				before ||= alphabet(item).length > 0;
			}
			return false;
		}
		case "alternation": {
			const after = rest();
			const starts = node.branches.map((branch) => startsOf(branch, after));
			for (let i = 0; i < starts.length; i += 1) {
				for (let j = i + 1; j < starts.length; j += 1) {
					if (overlaps(starts[i] as CharSet, starts[j] as CharSet, loop.fold)) return true;
				}
			}
			return node.branches.some((branch) =>
				ambiguousChoice(branch, follow, reachesEnd, consumed, loop),
			);
		}
		case "repeat": {
			// A repeating repeat inside the pass is delimited (or was refused as nested).
			if (node.max === 0) return false;
			// Passes past its minimum (`?`, the last two of `\d{1,3}`) compete with what follows.
			if (node.max > node.min) {
				const after = node.min > 0 && reachesEnd ? union(follow, loop.first) : rest();
				if (overlaps(startsOf(node.body, after), after, loop.fold)) return true;
			}
			return ambiguousChoice(node.body, follow, reachesEnd, consumed, loop);
		}
		default:
			return false;
	}
}

/** Whether a repeated group anywhere in `node` holds an ambiguous choice ({@link ambiguousChoice}). */
function repeatsAmbiguousChoice(node: PatternNode, fold: boolean): boolean {
	switch (node.kind) {
		case "repeat": {
			if (node.max > 1) {
				const loop: Loop = { first: first(node.body), emptyPasses: node.min > 1, fold };
				if (ambiguousChoice(node.body, NOTHING, true, false, loop)) return true;
			}
			return repeatsAmbiguousChoice(node.body, fold);
		}
		case "sequence":
			return node.items.some((item) => repeatsAmbiguousChoice(item, fold));
		case "alternation":
			return node.branches.some((branch) => repeatsAmbiguousChoice(branch, fold));
		case "look":
			return repeatsAmbiguousChoice(node.body, fold);
		default:
			return false;
	}
}

/**
 * How many ways one match attempt may have to split a text between the
 * choices of a run before the pattern is refused, as a power of two: 2^20,
 * about a million (see {@link RunCheck}).
 */
const CHOICE_BUDGET_BITS = 20;

/**
 * A choice the match may still be inside of — a quantifier, an optional part
 * or overlapping alternatives: its characters, the sets of the mandatory parts
 * matched since (each of which it could have taken too), how many unbounded
 * quantifiers its run holds (itself included; 0 for a bounded choice), and
 * how many ways its run's choices can split a text, as a power of two.
 */
interface OpenRun {
	origin: PatternNode;
	set: CharSet;
	between: CharSet[];
	chained: number;
	bits: number;
}

/**
 * The characters `node` matches one by one when it always matches the same
 * number of them (`ab`, `\d{2}`), else `undefined`.
 */
function fixedChars(node: PatternNode): CharSet[] | undefined {
	switch (node.kind) {
		case "char":
			return [node.set];
		case "start":
		case "empty":
		case "look":
			return [];
		case "sequence": {
			const chars: CharSet[] = [];
			for (const item of node.items) {
				const more = fixedChars(item);
				if (!more) return undefined;
				chars.push(...more);
			}
			return chars;
		}
		case "repeat": {
			const once = node.min === node.max ? fixedChars(node.body) : undefined;
			if (!once || once.length * node.min > MAX_REGEX_PATTERN_LENGTH) return undefined;
			return Array.from({ length: node.min }, () => once).flat();
		}
		default:
			return undefined;
	}
}

/**
 * The most alternatives of `node` that may all match at one position, one
 * match a prefix of another's (`a|aa`, `\d|1`): when what follows fails, each
 * is tried. Alternatives of fixed width that differ at some character
 * (`Jan|Jun`) never both match; others conservatively may when they can start
 * on the same character or one can match nothing.
 */
function overlappingAlternatives(
	node: Extract<PatternNode, { kind: "alternation" }>,
	fold: boolean,
): number {
	const branches = node.branches.map((branch) => ({
		chars: fixedChars(branch),
		start: first(branch),
		empty: nullable(branch),
	}));
	let most = 1;
	for (const left of branches) {
		let together = 1;
		for (const right of branches) {
			if (right === left) continue;
			if (left.empty || right.empty) together += 1;
			else if (left.chars && right.chars) {
				const length = Math.min(left.chars.length, right.chars.length);
				const differ = left.chars
					.slice(0, length)
					.some((set, position) => !overlaps(set, right.chars?.[position] ?? NOTHING, fold));
				if (!differ) together += 1;
			} else if (overlaps(left.start, right.start, fold)) together += 1;
		}
		most = Math.max(most, together);
	}
	return most;
}

/**
 * Finds choices in a row over shared characters. A later choice continues an
 * earlier one's run when they share characters and everything between them is
 * optional or could be taken by both; then the text they share can be split
 * between them in several ways, and a failure after them tries every split.
 *
 * Two limits apply. Unbounded quantifiers (`.*.*`, `\d+\.?\d*`, `.*,.*`)
 * each multiply the work by the subject's length, and so does trying the
 * match at every position, unless the pattern is anchored: one is the most an
 * unanchored run may chain, two an anchored one. And every choice multiplies
 * the work by its number of options — a quantifier by its number of pass
 * counts (2 for `?`, 100 for `\d{0,99}`, 101 at most, as unbounded ones are
 * already limited), alternatives by how many may match together — so a run
 * may hold {@link CHOICE_BUDGET_BITS} bits of them: `\d{0,99}` three times,
 * or `a?` twenty times. The budget is per match attempt; retrying at every
 * position multiplies every pattern's work alike.
 */
class RunCheck {
	/** Unbounded quantifiers chained past the limit. */
	chainsUnbounded = false;
	/** A run's choices over {@link CHOICE_BUDGET_BITS}. */
	overBudget = false;

	constructor(
		private readonly fold: boolean,
		private readonly maxChained: number,
	) {}

	/** The runs still open after `node`, given those open before it. */
	visit(node: PatternNode, open: OpenRun[]): OpenRun[] {
		switch (node.kind) {
			case "char":
				return this.cross(open, node.set);
			case "look":
				this.visit(node.body, []);
				return open;
			case "sequence": {
				let current = open;
				for (const item of node.items) current = this.visit(item, current);
				return current;
			}
			case "alternation": {
				const through = merge(node.branches.map((branch) => this.visit(branch, open)));
				const together = overlappingAlternatives(node, this.fold);
				if (together === 1) return through;
				return [...through, this.choose(node, open, Math.log2(together), false)];
			}
			case "repeat": {
				if (node.max === 0) return open;
				const bits = Math.log2(Math.min(node.max - node.min, LONG_REPEAT) + 1);
				// A bounded quantifier with a choice of few pass counts is a sequence
				// of optional parts; one with a choice of many is as costly as `*`.
				if (node.max - node.min <= LONG_REPEAT) {
					const through = this.visit(node.body, open);
					const passed = node.min === 0 ? merge([through, open]) : through;
					if (node.max === node.min) return passed;
					return [...passed, this.choose(node, open, bits, false)];
				}
				this.visit(node.body, []);
				const run = this.choose(node, open, bits, true);
				const kept = node.min === 0 ? open : this.cross(open, run.set);
				return [...kept, run];
			}
			default:
				// Anchors and backreferences (which may match nothing) leave every run open.
				return open;
		}
	}

	/** The run of a choice over `origin`, continuing the open runs it can. */
	private choose(origin: PatternNode, open: OpenRun[], bits: number, unbounded: boolean): OpenRun {
		const set = alphabet(origin);
		const continued = open.filter(
			(run) =>
				overlaps(run.set, set, this.fold) &&
				run.between.every((part) => overlaps(part, set, this.fold)),
		);
		const chained = unbounded ? Math.max(0, ...continued.map((run) => run.chained)) + 1 : 0;
		const total = bits + Math.max(0, ...continued.map((run) => run.bits));
		if (chained > this.maxChained) this.chainsUnbounded = true;
		if (total > CHOICE_BUDGET_BITS) this.overBudget = true;
		return { origin, set, between: [], chained, bits: total };
	}

	/** The runs that a mandatory part over `set` leaves open: those that could take it too. */
	private cross(open: OpenRun[], set: CharSet): OpenRun[] {
		return open
			.filter((run) => overlaps(run.set, set, this.fold))
			.map((run) => ({ ...run, between: [...run.between, set] }));
	}
}

/**
 * Runs from several paths, one per choice: the one with the fewest parts
 * between, which continues most easily, holding the longest run any path has.
 */
function merge(paths: OpenRun[][]): OpenRun[] {
	const byOrigin = new Map<PatternNode, OpenRun>();
	for (const path of paths) {
		for (const run of path) {
			const seen = byOrigin.get(run.origin);
			if (!seen) {
				byOrigin.set(run.origin, run);
				continue;
			}
			const fewer = run.between.length < seen.between.length ? run : seen;
			byOrigin.set(run.origin, {
				...fewer,
				chained: Math.max(run.chained, seen.chained),
				bits: Math.max(run.bits, seen.bits),
			});
		}
	}
	return [...byOrigin.values()];
}

/** Whether every match of `node` begins at a `^`. */
function startsAnchored(node: PatternNode): boolean {
	switch (node.kind) {
		case "start":
			return true;
		case "sequence":
			for (const item of node.items) {
				if (startsAnchored(item)) return true;
				// Zero-width parts before the `^` (`\b`, a lookahead) still leave it first.
				if (item.kind !== "empty" && item.kind !== "look") return false;
			}
			return false;
		case "alternation":
			return node.branches.every(startsAnchored);
		case "repeat":
			return node.min > 0 && startsAnchored(node.body);
		default:
			return false;
	}
}

/**
 * Throw {@link UnsafeRegexError} when `pattern` is too long or has a shape
 * that backtracks catastrophically (see the module comment). `flags` are the
 * ones it will be compiled with: `i` folds case, `v` changes classes, and `m`
 * or `y` change where a match may begin. The pattern's own syntax is the
 * `RegExp` constructor's to check.
 */
export function assertSafeRegex(pattern: string, flags = ""): void {
	if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
		throw new UnsafeRegexError(
			`Regular expression pattern is too long (${pattern.length} characters, limit ${MAX_REGEX_PATTERN_LENGTH}); ${OBSIDIAN_WOULD_RUN}.`,
		);
	}
	const parser = new PatternParser(pattern, flags);
	const tree = parser.parse();
	const fold = parser.caseInsensitive;
	let shape: string | undefined;
	if (nestsQuantifiers(tree, fold)) {
		shape = "uses nested quantifiers";
	} else if (repeatsAmbiguousChoice(tree, fold)) {
		shape = "repeats a choice whose options can match the same text";
	} else {
		// `^` pins the match to the subject's start, unless `m` makes it every line's.
		const anchored = flags.includes("y") || (!flags.includes("m") && startsAnchored(tree));
		const runs = new RunCheck(fold, anchored ? 2 : 1);
		runs.visit(tree, []);
		if (runs.chainsUnbounded) {
			shape = "has unbounded quantifiers in a row over shared characters";
		} else if (runs.overBudget) {
			shape =
				"has too many optional parts, bounded quantifiers or alternatives in a row over shared characters";
		}
	}
	if (shape) {
		throw new UnsafeRegexError(
			`Regular expression /${pattern}/ ${shape} (possible catastrophic backtracking detected); ${OBSIDIAN_WOULD_RUN}.`,
		);
	}
}

/**
 * Compile a vault-written regular expression after {@link assertSafeRegex}.
 * Throws {@link UnsafeRegexError}, or the `SyntaxError` of an invalid pattern.
 */
export function compileSafeRegex(pattern: string, flags = ""): RegExp {
	assertSafeRegex(pattern, flags);
	return new RegExp(pattern, flags);
}
