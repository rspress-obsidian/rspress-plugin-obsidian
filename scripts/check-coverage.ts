#!/usr/bin/env bun
/**
 * Coverage gate for the shipped package.
 *
 * Two things Bun's `coverageThreshold` (bunfig.toml) cannot express, so they
 * live here:
 *
 *  1. A repo-wide floor. Bun applies its threshold **per file** (verified on
 *     Bun 1.4.2: an 83% aggregate still exits non-zero when one file sits at
 *     0%), so it cannot say "97% of the shipped source".
 *  2. A per-file floor of 85%. Bun has no exception mechanism, and this script
 *     deliberately has none either: an entry allowing a measured module to sit
 *     below the floor would be a claim that no test can reach it, when the
 *     failure below already names the file and its number — which is what a
 *     reviewer needs, and what keeps the floor from being negotiated away.
 *
 * Only `src/**` counts. `scripts/**` is not in package.json `files`, so it is
 * not shipped, and `dist/` is generated output.
 *
 * Bun 1.4.2's lcov carries no `BRDA:` records at all, so branch coverage is
 * *not measured* — the report says so rather than implying a number. Function
 * coverage is reported next to statements.
 *
 * A module no test ever loads produces no lcov record at all, so deleting its
 * tests would *raise* the aggregate. Every module under `src/` must therefore
 * appear in the report unless it is in NOT_MEASURABLE below — and every entry
 * there is printed on every run, with its reason, so an exemption is reviewed
 * rather than assumed.
 *
 * Usage: `bun scripts/check-coverage.ts [minimum] [lcovPath]` — the minimum may
 * be omitted, in which case the first argument is taken as the report path.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const minimumArg =
	args[0] !== undefined && Number.isFinite(Number(args[0])) ? args.shift() : undefined;
const minimum = Number(minimumArg ?? "0.97");
const lcovPath = args[0] ?? "coverage/lcov.info";
const repoRoot = path.resolve(import.meta.dir, "..");

/** Per-file floor for the shipped source. */
const perFileFloor = 0.85;

/**
 * Modules under `src/` that no unit test can load, each with the reason. These
 * hold no executable statements, so they never produce a record even when a
 * test imports them; every other module under `src/` — including the umbrella
 * entry, the plugin factories and the runtime components Rspress loads by path
 * — is imported and exercised by a test, so an entry for one of them would hide
 * a real hole.
 */
const NOT_MEASURABLE: Record<string, string> = {
	"src/canvas/types.ts": "types only — no executable statements to cover",
	"src/graph/build/types.ts": "types only — no executable statements to cover",
	"src/graph/types.ts": "types only — no executable statements to cover",
	"src/markdown/types.ts": "types only — no executable statements to cover",
};

interface FileCoverage {
	file: string;
	statements: number;
	coveredStatements: number;
	functions: number;
	coveredFunctions: number;
}

const files: FileCoverage[] = [];
let current: FileCoverage | null = null;
let branchTotal = 0;
let branchCovered = 0;

const flush = (): void => {
	if (current?.file.startsWith("src/")) files.push(current);
	current = null;
};

/**
 * A repo-relative, forward-slash form of an lcov `SF:` value.
 *
 * Bun writes whatever the platform's `path` module produced: on Windows that is
 * backslashes, and a record can carry an absolute path (`C:\…\src\foo.ts`).
 * Comparing either form verbatim against the `path.join`-built module list marks
 * every module as unmeasured, so both are folded to the one form the list uses.
 * `path.relative` is what maps an absolute path back onto the repo, which only
 * the platform that wrote it can do — hence the split on `path.sep`.
 */
const repoRelative = (raw: string): string =>
	path.isAbsolute(raw)
		? path.relative(repoRoot, raw).split(path.sep).join("/")
		: raw.replace(/\\/g, "/").replace(/^\.\//, "");

// Split on `\r?\n`: a report checked out on Windows carries CRLF, and a trailing
// `\r` would break the `end_of_record` comparison below.
for (const line of readFileSync(lcovPath, "utf8").split(/\r?\n/)) {
	if (line.startsWith("SF:")) {
		flush();
		current = {
			file: repoRelative(line.slice(3).trim()),
			statements: 0,
			coveredStatements: 0,
			functions: 0,
			coveredFunctions: 0,
		};
		continue;
	}
	if (!current) continue;
	if (line.startsWith("DA:")) {
		const hits = Number(line.slice(3).split(",")[1]);
		current.statements += 1;
		if (hits > 0) current.coveredStatements += 1;
		continue;
	}
	if (line.startsWith("FNF:")) {
		current.functions = Number(line.slice(4));
		continue;
	}
	if (line.startsWith("FNH:")) {
		current.coveredFunctions = Number(line.slice(4));
		continue;
	}
	if (line.startsWith("BRDA:")) {
		// Bun 1.4.2 emits none of these. Parse them anyway so a Bun that starts
		// emitting them reports a real number instead of the "not measured" line.
		const taken = line.slice(5).split(",")[3];
		branchTotal += 1;
		if (taken !== "-" && Number(taken) > 0) branchCovered += 1;
		continue;
	}
	if (line.trim() === "end_of_record") flush();
}
flush();

const walk = (dir: string): string[] =>
	readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
		// `path.posix.join` keeps the returned list forward-slash on Windows too,
		// so it matches the normalized `SF:` values; `path.join` above still gets
		// the filesystem its own separators.
		const relative = path.posix.join(dir, entry.name);
		return entry.isDirectory() ? walk(relative) : [relative];
	});

/** Every module the package ships, i.e. every file a test *must* account for. */
const shippedModules = walk("src").filter(
	(relative) =>
		/\.tsx?$/.test(relative) && !relative.endsWith(".d.ts") && !relative.includes(".test."),
);

const measured = new Set(files.map((file) => file.file));

const total = files.reduce((sum, file) => sum + file.statements, 0);
const covered = files.reduce((sum, file) => sum + file.coveredStatements, 0);
const percent = total > 0 ? (100 * covered) / total : 0;

const fnTotal = files.reduce((sum, file) => sum + file.functions, 0);
const fnCovered = files.reduce((sum, file) => sum + file.coveredFunctions, 0);
const fnPercent = fnTotal > 0 ? (100 * fnCovered) / fnTotal : 0;

console.log(
	`shipped source (src/): ${percent.toFixed(2)}% of ${total} statements covered (floor ${(minimum * 100).toFixed(0)}%)`,
);
console.log(`functions: ${fnPercent.toFixed(2)}% (${fnCovered}/${fnTotal})`);
console.log(
	branchTotal > 0
		? `branches: ${((100 * branchCovered) / branchTotal).toFixed(2)}% (${branchCovered}/${branchTotal})`
		: "branches: NOT MEASURED — the report carries no BRDA records",
);

const ratio = (covered: number, total: number): number => (total > 0 ? covered / total : 1);

const belowFloor = files.filter(
	(file) =>
		ratio(file.coveredStatements, file.statements) < perFileFloor ||
		ratio(file.coveredFunctions, file.functions) < perFileFloor,
);
const unmeasured = shippedModules.filter(
	(module) => !measured.has(module) && NOT_MEASURABLE[module] === undefined,
);
/** An entry claiming a module is unmeasurable while the report measures it. */
const staleExemptions = Object.keys(NOT_MEASURABLE).filter((module) => measured.has(module));

let failed = false;

// Printed every run: an exception nobody sees is an exception nobody reviews.
for (const [module, reason] of Object.entries(NOT_MEASURABLE)) {
	console.log(`unmeasurable exemption: ${module} — ${reason}`);
}

if (unmeasured.length > 0) {
	failed = true;
	console.error(
		`\nNot in ${lcovPath} — no test loads them, so they are absent from the denominator and their coverage can never fail this gate:`,
	);
	for (const module of unmeasured) console.error(`  ${module}`);
}

if (staleExemptions.length > 0) {
	failed = true;
	console.error(
		`\nListed in NOT_MEASURABLE but present in ${lcovPath} — a test loads them now, so drop the entry and let the per-file floor apply:`,
	);
	for (const module of staleExemptions) console.error(`  ${module}`);
}

if (belowFloor.length > 0) {
	failed = true;
	console.error(`\nBelow the per-file floor of ${(perFileFloor * 100).toFixed(0)}%:`);
	for (const file of belowFloor) {
		const lines = 100 * ratio(file.coveredStatements, file.statements);
		const fns = 100 * ratio(file.coveredFunctions, file.functions);
		console.error(`  ${file.file} — ${lines.toFixed(1)}% lines, ${fns.toFixed(1)}% functions`);
	}
}

if (percent < minimum * 100) {
	failed = true;
	console.error("\nCoverage is below the aggregate floor.");
}

if (failed) process.exit(1);
