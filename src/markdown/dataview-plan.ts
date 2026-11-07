/**
 * Parsing a DQL query into a plan the engine runs: the header line, the `FROM`
 * source and the data commands, plus the cache that keeps a note's query text
 * from being re-tokenized on every build.
 *
 * Separate from `dataview.ts` because it never looks at a page or the index —
 * the plan is the whole output.
 */

import {
	DqlCursor,
	type Field,
	parseField,
	parseSource,
	type Source,
	startsExpression,
} from "./dataview-expression.js";

export interface NamedField {
	name: string;
	field: Field;
}

export type QueryOperation =
	| { type: "where"; clause: Field }
	| { type: "sort"; fields: Array<{ field: Field; descending: boolean }> }
	| { type: "limit"; amount: Field }
	| { type: "group"; field: NamedField }
	| { type: "flatten"; field: NamedField };

export type QueryHeader =
	| { type: "TABLE"; fields: NamedField[]; showId: boolean }
	| { type: "LIST"; format?: Field; showId: boolean }
	| { type: "TASK" }
	| { type: "CALENDAR"; field: NamedField };

export interface QueryPlan {
	header: QueryHeader;
	source: Source;
	operations: QueryOperation[];
}

/** `expr [AS name]`; the name defaults to the expression as written. */
function parseNamedField(cursor: DqlCursor): NamedField {
	const start = cursor.pos;
	const field = parseField(cursor);
	const name = cursor.source.slice(start, cursor.pos).replace(/\s+/g, " ").trim();
	const before = cursor.pos;
	cursor.skipSpace();
	if (cursor.word("AS")) {
		cursor.skipSpace();
		const quote = cursor.source[cursor.pos];
		if (quote === '"' || quote === "'") {
			const end = cursor.source.indexOf(quote, cursor.pos + 1);
			if (end < 0) cursor.fail("Unterminated column name");
			const alias = cursor.source.slice(cursor.pos + 1, end);
			cursor.pos = end + 1;
			return { name: alias, field };
		}
		const alias = cursor.match(
			/[\p{L}_\p{Extended_Pictographic}](?:[\p{L}\p{N}_\-\p{Extended_Pictographic}]|\u200d|\ufe0f)*/uy,
		);
		if (!alias) cursor.fail("Expected a name after AS");
		return { name: alias[0], field };
	}
	cursor.pos = before;
	return { name, field };
}

const CLAUSE_WORDS = ["FROM", "WHERE", "SORT", "GROUP", "FLATTEN", "LIMIT"];

/** Parsed queries in insertion order; a site has a handful of distinct queries per note. */
const QUERY_CACHE_SIZE = 64;
const queryCache = new Map<string, QueryPlan>();

/**
 * Parse a DQL query. The whole text is one token stream: clauses may share a
 * line or span several, and an expression may continue on the next line. Any
 * text that is not part of a clause is an error naming where it is.
 */
export function parseQuery(text: string): QueryPlan {
	const cached = queryCache.get(text);
	if (cached) return cached;
	const cursor = new DqlCursor(text, true);
	cursor.skipSpace();
	if (cursor.done) throw new Error("Dataview query is empty.");
	const typeWord = cursor.match(/[A-Za-z]+/y)?.[0].toUpperCase();
	if (
		typeWord !== "TABLE" &&
		typeWord !== "LIST" &&
		typeWord !== "TASK" &&
		typeWord !== "CALENDAR"
	) {
		cursor.pos = 0;
		cursor.skipSpace();
		throw new Error(`Unsupported Dataview query type: ${cursor.lineRest()}.`);
	}

	let header: QueryHeader;
	cursor.skipSpace();
	if (typeWord === "TABLE" || typeWord === "LIST") {
		const before = cursor.pos;
		let showId = true;
		if (cursor.word("WITHOUT")) {
			cursor.skipSpace();
			if (cursor.word("ID")) showId = false;
			else cursor.pos = before;
		}
		cursor.skipSpace();
		if (typeWord === "TABLE") {
			const fields: NamedField[] = [];
			if (startsExpression(cursor)) {
				for (;;) {
					fields.push(parseNamedField(cursor));
					const mark = cursor.pos;
					cursor.skipSpace();
					if (!cursor.text(",")) {
						cursor.pos = mark;
						break;
					}
					cursor.skipSpace();
				}
			}
			header = { type: "TABLE", fields, showId };
		} else {
			header = {
				type: "LIST",
				format: startsExpression(cursor) ? parseField(cursor) : undefined,
				showId,
			};
		}
	} else if (typeWord === "CALENDAR") {
		if (!startsExpression(cursor)) {
			throw new Error("A CALENDAR query needs a date field, such as `CALENDAR file.day`.");
		}
		header = { type: "CALENDAR", field: parseNamedField(cursor) };
	} else {
		header = { type: "TASK" };
	}

	let source: Source = { type: "all" };
	const beforeFrom = cursor.pos;
	cursor.skipSpace();
	if (cursor.word("FROM")) {
		const fromStart = cursor.pos;
		cursor.skipSpace();
		source = parseSource(cursor);
		// Text left on the FROM line that starts no clause belongs to the source.
		const rest = cursor.lineRest();
		if (
			rest &&
			!rest.startsWith("//") &&
			!CLAUSE_WORDS.some((word) => new RegExp(`^${word}\\b`, "i").test(rest))
		) {
			throw new Error(
				`Unsupported Dataview source: ${text.slice(fromStart).split("\n")[0]?.trim()}`,
			);
		}
	} else {
		cursor.pos = beforeFrom;
	}

	const operations: QueryOperation[] = [];
	for (;;) {
		cursor.skipSpace();
		if (cursor.done) break;
		const at = cursor.pos;
		if (cursor.word("FROM")) {
			throw new Error(
				`A Dataview query can contain only one FROM clause, directly after the query type (${cursor.location(at)}).`,
			);
		}
		if (cursor.word("WHERE")) {
			cursor.skipSpace();
			operations.push({ type: "where", clause: parseField(cursor) });
		} else if (cursor.word("SORT")) {
			const fields: Array<{ field: Field; descending: boolean }> = [];
			for (;;) {
				cursor.skipSpace();
				const field = parseField(cursor);
				const mark = cursor.pos;
				cursor.skipSpace();
				let descending = false;
				if (cursor.word("DESCENDING") || cursor.word("DESC")) descending = true;
				else if (!(cursor.word("ASCENDING") || cursor.word("ASC"))) cursor.pos = mark;
				fields.push({ field, descending });
				const afterDirection = cursor.pos;
				cursor.skipSpace();
				if (!cursor.text(",")) {
					cursor.pos = afterDirection;
					break;
				}
			}
			operations.push({ type: "sort", fields });
		} else if (cursor.word("LIMIT")) {
			cursor.skipSpace();
			operations.push({ type: "limit", amount: parseField(cursor) });
		} else if (cursor.word("GROUP")) {
			cursor.skipSpace();
			if (!cursor.word("BY")) cursor.fail("Expected BY after GROUP");
			cursor.skipSpace();
			operations.push({ type: "group", field: parseNamedField(cursor) });
		} else if (cursor.word("FLATTEN")) {
			cursor.skipSpace();
			operations.push({ type: "flatten", field: parseNamedField(cursor) });
		} else {
			throw new Error(
				`Unsupported Dataview command: ${cursor.lineRest()} (${cursor.location()}); expected WHERE, SORT, GROUP BY, FLATTEN or LIMIT.`,
			);
		}
	}

	const plan: QueryPlan = { header, source, operations };
	queryCache.set(text, plan);
	if (queryCache.size > QUERY_CACHE_SIZE) {
		for (const oldest of queryCache.keys()) {
			queryCache.delete(oldest);
			if (queryCache.size <= QUERY_CACHE_SIZE) break;
		}
	}
	return plan;
}
