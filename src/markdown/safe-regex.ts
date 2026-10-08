/**
 * Guards for regular expressions written in the vault: Tasks' `regex
 * matches`, Dataview's `regextest`/`regexmatch`/`regexreplace`, Bases and
 * Templater regex literals. They run during the build on JavaScript's
 * backtracking engine, where a nested quantifier such as `(a+)+$` takes
 * exponential time on a short subject and would hang the build. Obsidian runs
 * such a pattern; a site build refuses it, and its message says so.
 *
 * The check is a heuristic, not a ReDoS analyser: it refuses a repeated group
 * that itself contains a repeat, and a quantifier stacked on a quantifier.
 * Blow-ups through overlapping alternatives (`(a|a)*`) still get through.
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

/** The prefix of a group, after its `(`: `?:`, `?=`, `?!`, `?<=`, `?<!` or `?<name>`. */
const GROUP_PREFIX = /\?(?:[:=!]|<[=!]|<[^>]*>)/y;
const QUANTIFIER = /[*+?]|\{(\d+)(?:(,)(\d*))?\}/y;

/** Whether a quantifier repeats its atom more than once (`*`, `+`, `{2}`, `{1,}`), as opposed to `?`. */
function repeats(quantifier: RegExpExecArray): boolean {
	const [text, min, comma, max] = quantifier;
	if (text === "*" || text === "+") return true;
	if (text === "?") return false;
	if (comma === undefined) return Number(min) > 1;
	return max === "" || Number(max) > 1;
}

/** Whether `pattern` repeats a repeat: `(a+)+`, `(?:\w*x)*`, `((a+))+`, `a{2}*`. */
function hasNestedQuantifier(pattern: string): boolean {
	// For each open group: whether its body holds a repeating quantifier.
	const groups: boolean[] = [];
	// What the next quantifier would apply to.
	let previous: "none" | "atom" | "repeatingGroup" | "quantifier" = "none";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index];
		if (char === "\\") {
			index += 2;
			previous = "atom";
			continue;
		}
		if (char === "[") {
			index += 1;
			if (pattern[index] === "^") index += 1;
			while (index < pattern.length && pattern[index] !== "]") {
				index += pattern[index] === "\\" ? 2 : 1;
			}
			index += 1;
			previous = "atom";
			continue;
		}
		if (char === "(") {
			groups.push(false);
			index += 1;
			GROUP_PREFIX.lastIndex = index;
			if (GROUP_PREFIX.test(pattern)) index = GROUP_PREFIX.lastIndex;
			previous = "none";
			continue;
		}
		if (char === ")") {
			const inner = groups.pop() ?? false;
			// A repeat inside a group is also inside every group around it.
			if (inner && groups.length > 0) groups[groups.length - 1] = true;
			index += 1;
			previous = inner ? "repeatingGroup" : "atom";
			continue;
		}
		QUANTIFIER.lastIndex = index;
		const quantifier = QUANTIFIER.exec(pattern);
		if (quantifier) {
			index = QUANTIFIER.lastIndex;
			if (previous === "quantifier") {
				// `a+?` is a lazy `+`, not a second quantifier.
				if (quantifier[0] === "?") continue;
				return true;
			}
			if (repeats(quantifier)) {
				if (previous === "repeatingGroup") return true;
				if (groups.length > 0) groups[groups.length - 1] = true;
			}
			previous = "quantifier";
			continue;
		}
		index += 1;
		previous = "atom";
	}
	return false;
}

/**
 * Throw {@link UnsafeRegexError} when `pattern` is too long or nests
 * quantifiers. The pattern's own syntax is the `RegExp` constructor's to check.
 */
export function assertSafeRegex(pattern: string): void {
	if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
		throw new UnsafeRegexError(
			`Regular expression pattern is too long (${pattern.length} characters, limit ${MAX_REGEX_PATTERN_LENGTH}); ${OBSIDIAN_WOULD_RUN}.`,
		);
	}
	if (hasNestedQuantifier(pattern)) {
		throw new UnsafeRegexError(
			`Regular expression /${pattern}/ uses nested quantifiers (possible catastrophic backtracking detected); ${OBSIDIAN_WOULD_RUN}.`,
		);
	}
}

/**
 * Compile a vault-written regular expression after {@link assertSafeRegex}.
 * Throws {@link UnsafeRegexError}, or the `SyntaxError` of an invalid pattern.
 */
export function compileSafeRegex(pattern: string, flags = ""): RegExp {
	assertSafeRegex(pattern);
	return new RegExp(pattern, flags);
}
