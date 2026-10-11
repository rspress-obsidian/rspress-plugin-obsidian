/**
 * Boolean combinations of filters: `(due before tomorrow) AND NOT (is
 * recurring)`. Each filter sits in one kind of delimiter — `()`, `[]`, `{}`
 * or `""` — and the operators bind NOT, then XOR, then AND, then OR, as in
 * Tasks.
 */
import {
	combineExplanations,
	type Explanation,
	escapeRegExp,
	type Filter,
	type FilterOrError,
	makeExplanation,
	makeFilter,
	operandExplanation,
	type SearchInfo,
} from "./query-model.js";
import type { Task } from "./task.js";

const DELIMITER_PAIRS: readonly [string, string][] = [
	["(", ")"],
	["[", "]"],
	["{", "}"],
	['"', '"'],
];

function anyOf(chars: string): string {
	return `[${escapeRegExp(chars)}]`;
}

interface Delimiters {
	openChars: string;
	closeChars: string;
	open: string;
	close: string;
	both: string;
}

function makeDelimiters(openChars: string, closeChars: string): Delimiters {
	return {
		openChars,
		closeChars,
		open: anyOf(openChars),
		close: anyOf(closeChars),
		both: openChars === closeChars ? openChars : openChars + closeChars,
	};
}

const ALL_DELIMITERS = makeDelimiters(
	DELIMITER_PAIRS.map(([open]) => open).join(""),
	DELIMITER_PAIRS.map(([, close]) => close).join(""),
);

/** Whether a line looks like a Boolean combination (Tasks' own, deliberately loose, test). */
export const BOOLEAN_LINE = new RegExp(
	`(.*(AND|OR|XOR|NOT)\\s*${ALL_DELIMITERS.open}.*|${ALL_DELIMITERS.open}.+${ALL_DELIMITERS.close})`,
);

function delimitersOf(line: string): Delimiters | undefined {
	const operand = /^[A-Z ]*\s*(.*)/.exec(line.trim())?.[1] ?? "";
	const pair = DELIMITER_PAIRS.find(
		([open, close]) => operand.startsWith(open) && operand.endsWith(close),
	);
	return pair ? makeDelimiters(pair[0], pair[1]) : undefined;
}

/** The line split at operators and delimiters, keeping both. */
function splitLine(line: string, delimiters: Delimiters): string[] {
	const binary = new RegExp(
		`(${delimiters.close}\\s*(?:AND|OR|AND +NOT|OR +NOT|XOR)\\s*${delimiters.open})`,
	);
	const unary = new RegExp(`(NOT\\s*${delimiters.open})`);
	const leading = new RegExp(`(^${anyOf(`${delimiters.openChars} `)}*)`);
	const trailing = new RegExp(`(${anyOf(`${delimiters.closeChars} `)}*$)`);
	return line
		.split(binary)
		.flatMap((part) => part.split(unary))
		.filter((part) => part !== "")
		.flatMap((part) => part.split(leading))
		.flatMap((part) => part.split(trailing))
		.filter((part) => part !== "");
}

function isOperand(part: string, delimiters: Delimiters): boolean {
	const { open, close } = delimiters;
	return ![
		new RegExp(`^${anyOf(` ${delimiters.both}`)}+$`),
		new RegExp(`^ *${close} *(AND|OR|XOR) *${open} *$`),
		new RegExp(`^(AND|OR|XOR|NOT) *${open}$`),
		new RegExp(`^${close} *(AND|OR|XOR)$`),
		/^(AND|OR|XOR|NOT)$/,
	].some((pattern) => pattern.test(part));
}

interface Simplified {
	line: string;
	operands: Record<string, string>;
}

/** The line with each filter replaced by a placeholder (`f1`, `f2`…) and delimiters by parentheses. */
function simplify(line: string, delimiters: Delimiters): Simplified {
	const operands: Record<string, string> = {};
	let simplified = "";
	let next = 1;
	for (const part of splitLine(line, delimiters)) {
		if (!isOperand(part, delimiters)) {
			simplified += part;
			continue;
		}
		const placeholder = `f${next++}`;
		operands[placeholder] = part;
		simplified += placeholder;
	}
	simplified = simplified
		.replace(new RegExp(`(${delimiters.close})([A-Z])`, "g"), "$1 $2")
		.replace(new RegExp(`([A-Z])(${delimiters.open})`, "g"), "$1 $2");
	if (delimiters.openChars !== '"' && delimiters.openChars !== "(") {
		simplified = simplified
			.replace(new RegExp(delimiters.open, "g"), "(")
			.replace(new RegExp(delimiters.close, "g"), ")");
	}
	return { line: simplified, operands };
}

type Node =
	| { kind: "operand"; filter: Filter }
	| { kind: "not"; operand: Node }
	| { kind: "binary"; operator: "AND" | "OR" | "XOR"; left: Node; right: Node };

/**
 * How deep `(`/`NOT` may nest, and how many filters one line may combine.
 * Evaluating and explaining recurse once per level and once per chained
 * filter, so either unbounded would end in a stack overflow.
 */
const MAX_NESTING = 100;
const MAX_OPERANDS = 1000;

/** Precedence climbing over the simplified line: OR < AND < XOR < NOT. */
function parseExpression(source: string, filters: ReadonlyMap<string, Filter>): Node {
	const tokens = source.match(/\(|\)|"|[^\s()"]+/g) ?? [];
	let position = 0;
	let depth = 0;
	const peek = () => tokens[position];

	const binary = (operator: "AND" | "OR" | "XOR", operand: () => Node) => (): Node => {
		let left = operand();
		while (peek() === operator) {
			position += 1;
			left = { kind: "binary", operator, left, right: operand() };
		}
		return left;
	};
	const nested = (parse: () => Node): Node => {
		depth += 1;
		if (depth > MAX_NESTING) {
			throw new Error(
				`the combination nests more than ${MAX_NESTING} levels deep, which Obsidian would evaluate but a site build does not`,
			);
		}
		const node = parse();
		depth -= 1;
		return node;
	};
	const primary = (): Node => {
		const token = tokens[position++];
		if (token === undefined) throw new Error("unexpected end of expression");
		if (token === "NOT") return nested(() => ({ kind: "not", operand: primary() }));
		if (token === "(" || token === '"') {
			const inner = nested(or);
			if (tokens[position++] !== (token === "(" ? ")" : '"')) {
				throw new Error("missing closing delimiter");
			}
			return inner;
		}
		const filter = filters.get(token);
		if (filter) return { kind: "operand", filter };
		throw new Error(`unexpected token '${token}'`);
	};
	const xor = binary("XOR", primary);
	const and = binary("AND", xor);
	const or = binary("OR", and);

	const tree = or();
	if (position < tokens.length) throw new Error(`unexpected token '${tokens[position]}'`);
	return tree;
}

function evaluate(node: Node, task: Task, info: SearchInfo): boolean {
	switch (node.kind) {
		case "operand":
			return node.filter.matches(task, info);
		case "not":
			return !evaluate(node.operand, task, info);
		case "binary": {
			const left = evaluate(node.left, task, info);
			const right = evaluate(node.right, task, info);
			if (node.operator === "AND") return left && right;
			if (node.operator === "OR") return left || right;
			return left !== right;
		}
	}
}

function explain(node: Node): Explanation {
	switch (node.kind) {
		case "operand":
			return operandExplanation(node.filter);
		case "not":
			return makeExplanation("None of", [explain(node.operand)], "NOT");
		case "binary":
			return combineExplanations(node.operator, [explain(node.left), explain(node.right)]);
	}
}

function simpleError(line: string, message: string): string {
	return `Could not interpret the following instruction as a Boolean combination:
    ${line}

The error message is:
    ${message}`;
}

/**
 * A Boolean combination of filters, or Tasks' explanation of why the line is
 * not one. `parseOperand` parses each sub-filter (any filter, Boolean ones included).
 */
export function parseBooleanFilter(
	line: string,
	parseOperand: (text: string) => FilterOrError | undefined,
): FilterOrError {
	const delimiters = delimitersOf(line);
	if (!delimiters) {
		const pairs = DELIMITER_PAIRS.map(([open, close]) => `${open}...${close}`).join(" or ");
		return {
			error: simpleError(
				line,
				`All filters in a Boolean instruction must be inside one of these pairs of delimiter characters: ${pairs}. Combinations of those delimiters are no longer supported.`,
			),
		};
	}
	const simplified = simplify(line, delimiters);
	// A chain of N filters evaluates N calls deep: the same stack bound as nesting.
	const operandCount = Object.keys(simplified.operands).length;
	if (operandCount > MAX_OPERANDS) {
		return {
			error: simpleError(
				line,
				`The combination has ${operandCount} filters, more than the ${MAX_OPERANDS} a site build evaluates; Obsidian would evaluate it.`,
			),
		};
	}
	const detailedError = (message: string) => {
		const operands = Object.entries(simplified.operands)
			.map(([placeholder, text]) => {
				const parsed = parseOperand(text);
				const status = !parsed
					? "ERROR:\n           do not understand query"
					: parsed.error !== undefined
						? `ERROR:\n           ${parsed.error
								.split("\n")
								.map((errorLine) => errorLine.trim())
								.join("\n           ")}`
						: "OK";
				return `    '${placeholder}': '${text}'\n        => ${status}`;
			})
			.join("\n");
		return {
			error: `${simpleError(line, message)}

The instruction was converted to the following simplified line:
    ${simplified.line}

Where the sub-expressions in the simplified line are:
${operands}

For help, see:
    https://publish.obsidian.md/tasks/Queries/Combining+Filters
`,
		};
	};

	const filters = new Map<string, Filter>();
	for (const [placeholder, text] of Object.entries(simplified.operands)) {
		const parsed = parseOperand(text);
		if (!parsed) return detailedError(`couldn't parse sub-expression '${text}'`);
		if (parsed.error !== undefined) {
			return detailedError(`couldn't parse sub-expression '${text}': ${parsed.error}`);
		}
		filters.set(placeholder, parsed.filter);
	}
	let tree: Node;
	try {
		tree = parseExpression(simplified.line, filters);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return detailedError(
			`malformed boolean query -- ${message} (check the documentation for guidelines)`,
		);
	}
	return makeFilter(line, (task, info) => evaluate(tree, task, info), explain(tree));
}
