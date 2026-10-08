/**
 * The pieces a Tasks query is built from — statements, filters, sorters,
 * groupers — and the text `explain` prints for them, worded as Tasks words it.
 */
import type { Day } from "./dates.js";
import type { Task } from "./task.js";

/**
 * One logical instruction: the lines as written (several, with `\`
 * continuations), joined, then with `{{placeholders}}` expanded.
 */
export interface Statement {
	raw: string;
	continued: string;
	expanded: string;
}

export function makeStatement(raw: string, continued: string = raw): Statement {
	const trimmed = continued.trim();
	return { raw, continued: trimmed, expanded: trimmed };
}

/** The statement as `explain` and error messages show it, each transformation on its own line. */
export function explainStatement(statement: Statement, indent: string): string {
	const raw = statement.raw.trim();
	let result = `${indent}${raw.split("\n").join(`\n${indent}`)}`;
	if (statement.raw.includes("\n")) result += `\n${indent}`;
	if (statement.continued !== raw) result += ` =>\n${indent}${statement.continued}`;
	if (statement.expanded !== statement.continued) {
		result += ` =>\n${indent}${statement.expanded}`;
	}
	return result;
}

/** A filter's meaning, nested for Boolean combinations. */
export interface Explanation {
	description: string;
	/** `AND`, `OR`, `NOT`, `XOR`, or `""` for a leaf. */
	symbol: string;
	children: Explanation[];
}

export function makeExplanation(
	description: string,
	children: Explanation[] = [],
	symbol = "",
): Explanation {
	return { description, symbol, children };
}

const BOOLEAN_DESCRIPTIONS: Record<string, string> = {
	AND: "All of",
	OR: "At least one of",
	NOT: "None of",
	XOR: "Exactly one of",
};

/**
 * Combine operands under a Boolean operator. A chain of the same operator
 * (`(a) AND (b) AND (c)`) reads as one list, as in Tasks.
 */
export function combineExplanations(symbol: string, children: Explanation[]): Explanation {
	const [first, second] = children;
	if (
		(symbol === "AND" || symbol === "OR") &&
		children.length === 2 &&
		first?.symbol === symbol &&
		second?.symbol === ""
	) {
		first.children.push(second);
		return first;
	}
	return makeExplanation(BOOLEAN_DESCRIPTIONS[symbol] ?? symbol, children, symbol);
}

export function explanationText(explanation: Explanation, indent = ""): string {
	if (explanation.children.length === 0) return indent + explanation.description;
	let result = indent;
	if (explanation.symbol === "") {
		result += explanation.description;
	} else {
		result += explanation.symbol;
		if (explanation.children.length > 1) result += ` (${explanation.description})`;
		result += ":";
	}
	for (const child of explanation.children) result += `\n${explanationText(child, `${indent}  `)}`;
	return result;
}

/** What every filter, sorter and grouper may consult while a query runs. */
export interface SearchInfo {
	allTasks: readonly Task[];
	today: Day;
	globalFilter: string;
}

export interface Filter {
	statement: Statement;
	explanation: Explanation;
	matches(task: Task, info: SearchInfo): boolean;
}

export type FilterOrError = { filter: Filter; error?: undefined } | { error: string };

export type Comparator = (a: Task, b: Task, info: SearchInfo) => number;

export interface Sorter {
	statement: Statement;
	property: string;
	compare: Comparator;
}

export interface Grouper {
	statement: Statement;
	property: string;
	reverse: boolean;
	names(task: Task, info: SearchInfo): string[];
}

/** A filter, explained on one line when its explanation just restates it. */
export function explainFilter(filter: Filter, indent: string): string {
	const statement = explainStatement(filter.statement, indent);
	if (explanationText(filter.explanation) === filter.statement.expanded) return `${statement}\n`;
	return `${statement} =>\n${explanationText(filter.explanation, `${indent}  `)}\n`;
}

/** A filter as an operand of a Boolean combination. */
export function operandExplanation(filter: Filter): Explanation {
	if (explanationText(filter.explanation) === filter.statement.expanded) return filter.explanation;
	return makeExplanation(`${filter.statement.expanded} =>`, [filter.explanation]);
}

export function makeFilter(
	line: string,
	matches: Filter["matches"],
	explanation: Explanation | string = line,
): FilterOrError {
	return {
		filter: {
			statement: makeStatement(line),
			explanation: typeof explanation === "string" ? makeExplanation(explanation) : explanation,
			matches,
		},
	};
}

/** `text` as a literal inside a regular expression. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
