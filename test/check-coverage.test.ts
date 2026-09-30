import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Drives the gate the way CI does: a real process, a real lcov file, a real exit
// code. Bun applies `coverageThreshold` per file and has no exception mechanism,
// so all three floors live in the script — the 97% aggregate, the 85% per-file
// one, and the guard for modules no test loads. Each has to fail loudly, because
// a gate that quietly passes is the bug it exists to catch.
const script = path.resolve(import.meta.dir, "..", "scripts", "check-coverage.ts");

interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

const run = (lcov: string, minimum: string | null = "0.97"): Run => {
	const file = path.join(mkdtempSync(path.join(os.tmpdir(), "check-coverage-")), "lcov.info");
	writeFileSync(file, lcov);
	const result = spawnSync(
		process.execPath,
		minimum === null ? [script, file] : [script, minimum, file],
		{ encoding: "utf8" },
	);
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

/** One lcov record: 10 statements and 2 functions, `coverage` of them hit. */
const record = (file: string, coverage = 1, branches: string[] = []): string =>
	[
		`SF:${file}`,
		...Array.from({ length: 10 }, (_, index) => `DA:${index + 1},${index < coverage * 10 ? 1 : 0}`),
		"FNF:2",
		`FNH:${Math.round(coverage * 2)}`,
		...branches,
		"end_of_record",
	].join("\n");

/**
 * The modules the gate insists on measuring, taken from the gate itself: against
 * an empty report it lists every src/ module that is neither in the report nor
 * documented as unmeasurable.
 */
const guardedModules = [...run("").stderr.matchAll(/^ {2}(\S+)$/gm)].map((match) => match[1]!);
const complete = guardedModules.map((file) => record(file)).join("\n");

describe("check-coverage", () => {
	test("passes when every shipped module is measured and above the floors", () => {
		const result = run(complete);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("100.00% of");
		expect(result.stdout).toContain("functions: 100.00%");
	});

	test("demands a record for a module no test loaded", () => {
		expect(guardedModules.length).toBeGreaterThan(0);
		// A types-only module produces no record even when imported, so it must
		// not be demanded; everything else under src/ must be.
		expect(guardedModules).not.toContain("src/canvas/types.ts");

		const withoutParser = guardedModules
			.filter((file) => file !== "src/canvas/parser.ts")
			.map((file) => record(file))
			.join("\n");
		const result = run(withoutParser);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Not in");
		expect(result.stderr).toContain("src/canvas/parser.ts");
	});

	test("fails a module under the per-file floor", () => {
		const result = run(
			guardedModules
				.map((file) => record(file, file === "src/canvas/parser.ts" ? 0.5 : 1))
				.join("\n"),
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Below the per-file floor of 85%");
		expect(result.stderr).toContain("src/canvas/parser.ts — 50.0% lines, 50.0% functions");
	});

	test("fails when the aggregate is under the floor but no file is", () => {
		// 90% per file: above the 85% per-file floor, below the 97% aggregate.
		const result = run(guardedModules.map((file) => record(file, 0.86)).join("\n"));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("below the aggregate floor");
		expect(result.stderr).not.toContain("Below the per-file floor");
	});

	test("defaults the aggregate floor to 97% when the minimum is omitted", () => {
		const result = run(complete, null);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("(floor 97%)");
	});

	test("says branch coverage is not measured rather than implying a number", () => {
		const result = run(complete);

		expect(result.stdout).toContain("branches: NOT MEASURED");
	});

	test("reports a real branch percentage when the report carries BRDA records", () => {
		const result = run(
			guardedModules
				.map((file) =>
					record(file, 1, file === "src/canvas/parser.ts" ? ["BRDA:1,0,0,3", "BRDA:1,0,1,-"] : []),
				)
				.join("\n"),
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("branches: 50.00% (1/2)");
		expect(result.stdout).not.toContain("NOT MEASURED");
	});

	test("prints every unmeasurable exemption with its reason on every run", () => {
		const result = run(complete);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"unmeasurable exemption: src/canvas/types.ts — types only — no executable statements to cover",
		);
		expect(result.stdout).toContain(
			"unmeasurable exemption: src/markdown/types.ts — types only — no executable statements to cover",
		);
	});

	test("exempts nothing a test can load", () => {
		const result = run(complete);

		// The umbrella entry, the plugin factory it composes and the runtime
		// components Rspress loads by path are all reachable from a test.
		for (const module of [
			"src/index.ts",
			"src/graph/index.ts",
			"src/graph/runtime/GraphSidebar.tsx",
			"src/markdown/runtime/MermaidBlocks.tsx",
		]) {
			expect(result.stdout).not.toContain(`unmeasurable exemption: ${module} — `);
			expect(guardedModules).toContain(module);
		}
	});

	test("rejects a module documented as unmeasurable that the report now measures", () => {
		const result = run(`${complete}\n${record("src/canvas/types.ts")}`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Listed in NOT_MEASURABLE but present in");
		expect(result.stderr).toContain("src/canvas/types.ts");
	});
});

// Bun writes the separators and line endings of the platform it ran on, so the
// same tree produces `SF:src\foo.ts` with CRLF on Windows and `SF:src/foo.ts`
// with LF on Linux. A gate that compares those verbatim reports every module as
// unmeasured — and fails a fully covered tree — on one OS only, which is the
// worst possible place for a false negative.
const repoRoot = path.resolve(import.meta.dir, "..");

/** The report with Windows-style `\` separators and CRLF line endings. */
const windowsShaped = (lcov: string): string =>
	lcov
		.split("\n")
		.map((line) => (line.startsWith("SF:") ? `SF:${line.slice(3).replace(/\//g, "\\")}` : line))
		.join("\r\n");

/** The report with absolute `SF:` paths, as an absolute-path Bun run emits. */
const absoluteShaped = (lcov: string): string =>
	lcov
		.split("\n")
		.map((line) => (line.startsWith("SF:") ? `SF:${path.resolve(repoRoot, line.slice(3))}` : line))
		.join("\n");

/** The report with all three shapes interleaved and CRLF endings. */
const mixedShaped = (lcov: string): string => {
	let seen = 0;
	return lcov
		.split("\n")
		.map((line) => {
			if (!line.startsWith("SF:")) return line;
			const target = line.slice(3);
			seen += 1;
			if (seen % 3 === 0) return `SF:${target}`;
			if (seen % 3 === 1) return `SF:${target.replace(/\//g, "\\")}`;
			return `SF:${path.resolve(repoRoot, target)}`;
		})
		.join("\r\n");
};

describe("check-coverage lcov path shapes", () => {
	/** Same verdict, same output — the shape of the paths must not be observable. */
	const expectSameVerdict = (variant: string): void => {
		const baseline = run(complete);
		const result = run(variant);

		expect(result.status).toBe(baseline.status);
		expect(result.stdout).toBe(baseline.stdout);
		expect(result.stderr).toBe(baseline.stderr);
	};

	test("accepts a Windows-shaped report (backslash paths, CRLF)", () => {
		expectSameVerdict(windowsShaped(complete));
	});

	test("accepts a report whose SF paths are absolute", () => {
		expectSameVerdict(absoluteShaped(complete));
	});

	test("accepts a report mixing separators and absolute paths", () => {
		expectSameVerdict(mixedShaped(complete));
	});

	test("still names a module a Windows-shaped report omits", () => {
		const withoutParser = guardedModules
			.filter((file) => file !== "src/canvas/parser.ts")
			.map((file) => record(file))
			.join("\n");
		const result = run(windowsShaped(withoutParser));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Not in");
		expect(result.stderr).toContain("src/canvas/parser.ts");
	});

	test("still fails a Windows-shaped report below the per-file floor", () => {
		const result = run(
			windowsShaped(
				guardedModules
					.map((file) => record(file, file === "src/canvas/parser.ts" ? 0.5 : 1))
					.join("\n"),
			),
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("src/canvas/parser.ts — 50.0% lines, 50.0% functions");
	});

	test("flags an exemption a Windows-shaped report measures", () => {
		const result = run(windowsShaped(`${complete}\n${record("src/canvas/types.ts")}`));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Listed in NOT_MEASURABLE but present in");
		expect(result.stderr).toContain("src/canvas/types.ts");
	});
});
