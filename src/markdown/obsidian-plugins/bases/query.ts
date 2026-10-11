/**
 * Running one view of a base over the dataset: the base's filters AND the
 * view's, then `sort`, `limit`, `groupBy`/`groupOrder`, and the summaries a
 * view asks for (Bases syntax.md, Views.md).
 */
import type { BaseConfig, FilterNode, SortSpec, ViewConfig } from "./config.js";
import {
	compileExpression,
	type EvalEnv,
	evaluate,
	parsePropertyId,
	propertyValue,
	RowScope,
} from "./evaluate.js";
import type { Expr } from "./expression.js";
import {
	asDate,
	type BaseFile,
	compareValues,
	DurationValue,
	ErrorValue,
	isEmptyValue,
	isTruthy,
	type Value,
	valueKey,
	valueToString,
} from "./values.js";

export interface QueryRow {
	file: BaseFile;
	scope: RowScope;
}

export interface QueryGroup {
	/** The grouped property's value; `null` for files without one. */
	value: Value;
	rows: QueryRow[];
}

export interface ViewResult {
	rows: QueryRow[];
	/** Set when the view groups (`groupBy`), in display order. */
	groups?: QueryGroup[];
	/** Filters that failed (a syntax error, an error value), by message: those rows are left out. */
	errors: ErrorValue[];
}

type CompiledFilter =
	| { kind: "statement"; source: string; expr: Expr | ErrorValue }
	| { kind: "and" | "or" | "not"; children: CompiledFilter[] };

function compileFilter(node: FilterNode): CompiledFilter {
	if (node.kind === "statement") {
		return { kind: "statement", source: node.source, expr: compileExpression(node.source) };
	}
	return { kind: node.kind, children: node.children.map(compileFilter) };
}

/**
 * Whether `row` passes. `not` is "none of the following are true" (Views.md):
 * a row passes only when every child fails.
 */
function passes(
	filter: CompiledFilter,
	env: EvalEnv,
	row: RowScope,
	errors: Map<string, ErrorValue>,
): boolean {
	switch (filter.kind) {
		case "statement": {
			const value =
				filter.expr instanceof ErrorValue ? filter.expr : evaluate(filter.expr, env, row);
			if (value instanceof ErrorValue) {
				const message = `Filter "${filter.source}": ${value.message}`;
				errors.set(message, new ErrorValue(message, value.severity));
				return false;
			}
			return isTruthy(value);
		}
		case "and":
			return filter.children.every((child) => passes(child, env, row, errors));
		case "or":
			return filter.children.some((child) => passes(child, env, row, errors));
		case "not":
			return !filter.children.some((child) => passes(child, env, row, errors));
	}
}

/** Order two values for a sort: empty values last in either direction. */
function sortOrder(left: Value, right: Value, direction: SortSpec["direction"]): number {
	const leftEmpty = isEmptyValue(left);
	const rightEmpty = isEmptyValue(right);
	if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
	const order =
		compareValues(left, right) ??
		valueToString(left, SORT_FORMATS).localeCompare(valueToString(right, SORT_FORMATS));
	return direction === "DESC" ? -order : order;
}

const SORT_FORMATS = { dateFormat: "YYYY-MM-DD", dateTimeFormat: "YYYY-MM-DD HH:mm:ss" };

/** The rows `view` shows, sorted, limited and grouped. */
export function runView(config: BaseConfig, view: ViewConfig, env: EvalEnv): ViewResult {
	const errors = new Map<string, ErrorValue>();
	const filters = [config.filters, view.filters]
		.filter((filter): filter is FilterNode => filter !== undefined)
		.map(compileFilter);
	let rows: QueryRow[] = [];
	for (const file of env.dataset.files) {
		const scope = new RowScope(file);
		if (filters.every((filter) => passes(filter, env, scope, errors))) rows.push({ file, scope });
	}

	if (view.sort.length > 0) {
		const specs = view.sort.map((spec) => ({ ...spec, ref: parsePropertyId(spec.property) }));
		const keyed = rows.map((row) => ({
			row,
			keys: specs.map((spec) => propertyValue(spec.ref, env, row.scope)),
		}));
		keyed.sort((a, b) => {
			for (const [i, spec] of specs.entries()) {
				const order = sortOrder(a.keys[i] ?? null, b.keys[i] ?? null, spec.direction);
				if (order !== 0) return order;
			}
			return 0;
		});
		rows = keyed.map(({ row }) => row);
	}
	if (view.limit !== undefined) rows = rows.slice(0, view.limit);

	const result: ViewResult = { rows, errors: [...errors.values()] };
	if (view.groupBy) result.groups = groupRows(rows, view, view.groupBy, env);
	return result;
}

function groupRows(
	rows: QueryRow[],
	view: ViewConfig,
	groupBy: SortSpec,
	env: EvalEnv,
): QueryGroup[] {
	const ref = parsePropertyId(groupBy.property);
	const byKey = new Map<string, QueryGroup>();
	for (const row of rows) {
		const raw = propertyValue(ref, env, row.scope);
		const value = isEmptyValue(raw) ? null : raw;
		const key = valueKey(value);
		const group = byKey.get(key) ?? { value, rows: [] };
		group.rows.push(row);
		byKey.set(key, group);
	}
	const groups = [...byKey.values()].sort((a, b) => sortOrder(a.value, b.value, groupBy.direction));
	if (!view.groupOrder) return groups;
	// `groupOrder` lists the groups to show, in order. A listed value no file
	// has is still shown, empty — a column added by hand in Obsidian.
	const byLabel = new Map<string | null, QueryGroup>();
	for (const group of groups) {
		byLabel.set(group.value === null ? null : valueToString(group.value, env.formats), group);
	}
	return view.groupOrder.map((label) => byLabel.get(label) ?? { value: label, rows: [] });
}

function numbers(values: Value[]): number[] {
	return values.filter(
		(value): value is number => typeof value === "number" && !Number.isNaN(value),
	);
}

function mean(list: number[]): number | null {
	return list.length === 0 ? null : list.reduce((total, value) => total + value, 0) / list.length;
}

/** The summaries every view offers (Bases syntax.md, "Default Summary Formulas"). Averages show two decimals. */
export const DEFAULT_SUMMARIES: Record<string, (values: Value[]) => Value> = {
	Average: (values) => {
		const average = mean(numbers(values));
		return average === null ? null : Math.round(average * 100) / 100;
	},
	Min: (values) => {
		const list = numbers(values);
		return list.length === 0 ? null : Math.min(...list);
	},
	Max: (values) => {
		const list = numbers(values);
		return list.length === 0 ? null : Math.max(...list);
	},
	Sum: (values) => numbers(values).reduce((total, value) => total + value, 0),
	Range: (values) => {
		const list = numbers(values);
		if (list.length > 0) return Math.max(...list) - Math.min(...list);
		const times = values.flatMap((value) => {
			const date = value === null ? undefined : asDate(value);
			return date ? [date.ms] : [];
		});
		return times.length === 0
			? null
			: new DurationValue(0, Math.max(...times) - Math.min(...times));
	},
	Median: (values) => {
		const list = numbers(values).sort((a, b) => a - b);
		if (list.length === 0) return null;
		const middle = Math.floor(list.length / 2);
		return list.length % 2 === 1
			? (list[middle] ?? null)
			: ((list[middle - 1] ?? 0) + (list[middle] ?? 0)) / 2;
	},
	Stddev: (values) => {
		const list = numbers(values);
		const average = mean(list);
		if (average === null) return null;
		const deviation = Math.sqrt(mean(list.map((value) => (value - average) ** 2)) ?? 0);
		return Math.round(deviation * 100) / 100;
	},
	Earliest: (values) => earliestOrLatest(values, -1),
	Latest: (values) => earliestOrLatest(values, 1),
	Checked: (values) => values.filter((value) => value === true).length,
	Unchecked: (values) => values.filter((value) => value === false).length,
	Empty: (values) => values.filter(isEmptyValue).length,
	Filled: (values) => values.filter((value) => !isEmptyValue(value)).length,
	Unique: (values) => new Set(values.filter((value) => !isEmptyValue(value)).map(valueKey)).size,
};

function earliestOrLatest(values: Value[], sign: 1 | -1): Value {
	let best: Value = null;
	for (const value of values) {
		const date = value === null ? undefined : asDate(value);
		if (!date) continue;
		const current = best === null ? undefined : asDate(best);
		if (!current || sign * (date.ms - current.ms) > 0) best = date;
	}
	return best;
}

/**
 * A summary of `values`: a default one by name, or a formula from the base's
 * `summaries` section evaluated with `values` in scope.
 */
export function summarize(name: string, values: Value[], config: BaseConfig, env: EvalEnv): Value {
	if (Object.hasOwn(config.summaries, name)) {
		const expr = compileExpression(config.summaries[name]);
		if (expr instanceof ErrorValue) return expr;
		return evaluate(expr, env, new RowScope(undefined), { values });
	}
	const summary = Object.hasOwn(DEFAULT_SUMMARIES, name) ? DEFAULT_SUMMARIES[name] : undefined;
	return summary ? summary(values) : new ErrorValue(`Unknown summary "${name}"`);
}
