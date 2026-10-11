/**
 * Bases conformance: our evaluator against results recorded from a running
 * Obsidian by obsidian-bases-expression's oracle generator (see README.md).
 *
 * The vault, the row (`this` and the evaluated note), the formulas, `now` and
 * the timezone are the ones the oracle ran with, so every case must match,
 * except the ones in KNOWN_DIVERGENCES.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "../../../content-index.js";
import { normalizePluginOptions } from "../../../normalize-options.js";
import { datasetFor } from "../dataset.js";
import { compileExpression, type EvalEnv, evaluate, RowScope } from "../evaluate.js";
import {
	type BaseFile,
	DateValue,
	DurationValue,
	ErrorValue,
	FileValue,
	formatDate,
	HtmlValue,
	humanizeSpan,
	IconValue,
	ImageValue,
	ISO_FORMATS,
	LinkValue,
	ObjectValue,
	RegexValue,
	type Value,
} from "../values.js";

interface OracleCase {
	name: string;
	expression: string;
	expected: unknown;
	/** `random()`: Obsidian's number is random too, so only its range is compared. */
	assertion?: "range01";
}

interface OracleFixture {
	generatedAt: string;
	context: {
		/** Obsidian's clock when the oracle ran. */
		now: string;
		/** The IANA zone Obsidian ran in; local dates and `today()` depend on it. */
		timezone: string;
		/** The vault path of the evaluated note, also `this`. */
		this: string;
		formulas: Record<string, string>;
	};
	cases: OracleCase[];
}

interface DiagnosticsFixture {
	cases: OracleCase[];
}

const fixtureDir = path.join(import.meta.dir, "fixtures");
const readFixture = (name: string): unknown =>
	JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));

const oracle = readFixture("oracle.json") as OracleFixture;
const diagnostics = readFixture("diagnostics.json") as DiagnosticsFixture;
/** The 18 files the oracle generator creates, by vault path. */
const vault = readFixture("vault.json") as Record<string, string>;

/**
 * Cases where we knowingly differ from Obsidian, by case name, with the reason.
 * Each must still differ: one that starts matching fails, so it is removed here.
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
	// Obsidian lists backlinks in metadata-cache order (the order the source
	// files were indexed: here, the order the generator created them). A static
	// build has no such order, so we list backlinks by path, which is stable.
	"file backlinks rendered matrix": "backlink order",
};

/**
 * The value as upstream's `toPlain` reports it, which is what the oracle's
 * expected values are written in: a link is its target, a file its path, a
 * date ISO text, a duration its humanized text, an error `{ error: message }`.
 */
function toPlain(value: Value): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(toPlain);
	if (value instanceof ErrorValue) {
		// Obsidian cannot build a formula that does not parse, and its value is null.
		return value.message.startsWith("Syntax error") ? null : { error: value.message };
	}
	if (value instanceof DateValue) return formatDate(value, ISO_FORMATS);
	if (value instanceof DurationValue) return humanizeSpan(value.months, value.ms);
	if (value instanceof LinkValue) return value.target;
	if (value instanceof FileValue) return value.file.path;
	if (value instanceof ObjectValue) {
		return Object.fromEntries(
			Object.entries(value.entries).map(([key, item]) => [key, toPlain(item)]),
		);
	}
	if (value instanceof RegexValue) return String(value.regex);
	if (value instanceof HtmlValue) return value.html;
	if (value instanceof IconValue) return value.name;
	if (value instanceof ImageValue) {
		const source = value.source;
		if (source instanceof LinkValue) return source.target;
		if (source instanceof FileValue) return source.file.path;
		return toPlain(source);
	}
	return value;
}

const savedTimezone = process.env.TZ;
let root: string;
let env: EvalEnv;
let row: BaseFile;

beforeAll(async () => {
	// Bun applies a TZ change at runtime; restored in afterAll so no other test file sees it.
	process.env.TZ = oracle.context.timezone;
	root = mkdtempSync(path.join(os.tmpdir(), "bases-conformance-"));
	for (const [file, content] of Object.entries(vault)) {
		const absolute = path.join(root, file);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
	const index = await buildContentIndex(root);
	const dataset = await datasetFor(
		[index],
		normalizePluginOptions({ vaultRoot: root, enableBases: true }),
	);
	const found = dataset.files.find((file) => file.path === oracle.context.this);
	if (!found?.page) throw new Error(`${oracle.context.this} is not in the dataset`);
	row = found;
	env = {
		dataset,
		now: new Date(oracle.context.now),
		formats: ISO_FORMATS,
		thisFile: row,
		formulas: Object.fromEntries(
			Object.entries(oracle.context.formulas).map(([name, source]) => [
				name,
				compileExpression(source),
			]),
		),
		contextPage: found.page,
		seed: "conformance",
	};
});

afterAll(() => {
	if (savedTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = savedTimezone;
	rmSync(root, { recursive: true, force: true });
});

function evaluateCase(expression: string): unknown {
	const compiled = compileExpression(expression);
	return toPlain(
		compiled instanceof ErrorValue ? compiled : evaluate(compiled, env, new RowScope(row)),
	);
}

function suite(title: string, cases: readonly OracleCase[]): void {
	describe(title, () => {
		for (const testCase of cases) {
			const divergence = KNOWN_DIVERGENCES[testCase.name];
			if (divergence) {
				test(`${testCase.name} still diverges (${divergence})`, () => {
					expect(evaluateCase(testCase.expression)).not.toEqual(testCase.expected);
				});
			} else if (testCase.assertion === "range01") {
				test(testCase.name, () => {
					const actual = evaluateCase(testCase.expression);
					expect(actual).toBeGreaterThanOrEqual(0);
					expect(actual).toBeLessThan(1);
				});
			} else {
				test(testCase.name, () => {
					expect(evaluateCase(testCase.expression)).toEqual(testCase.expected);
				});
			}
		}
	});
}

suite(`Obsidian oracle (${oracle.generatedAt})`, oracle.cases);
suite("Obsidian diagnostics oracle", diagnostics.cases);

test("every known divergence names an oracle case", () => {
	const names = new Set([...oracle.cases, ...diagnostics.cases].map((testCase) => testCase.name));
	expect(Object.keys(KNOWN_DIVERGENCES).filter((name) => !names.has(name))).toEqual([]);
});
