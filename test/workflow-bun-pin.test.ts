import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// `bun install --frozen-lockfile` hard-fails on a lockfile the pinned bun
// cannot parse, and that failure only ever surfaces in CI — the release job
// died at the install step while every test job was green. Commit 2c20e56
// re-pinned all five versions in ci.yml and missed release.yml, so the two
// files drifted again on the very next run.
//
// This is deliberately a floor check, not an equality check: `1.4.x`, `1.4`
// and `1.4.2` all read the lockfile correctly, and pinning one exact patch
// everywhere would make this test churn on every routine dependency bump.
// What must never come back is a pin below the floor.
const workflowDir = path.resolve(import.meta.dir, "..", ".github", "workflows");
const workflows = readdirSync(workflowDir).filter((f) => f.endsWith(".yml"));

// The lowest bun that can parse bun.lock (lockfileVersion 2). Verified by
// running `bun@1.3.14 install --frozen-lockfile` against it: it exits with
// `UnknownLockfileVersion`. Keep in step with `engines.bun` in package.json.
const MIN_BUN = "1.4.0";

/** Every bun version a workflow asks setup-bun for, as `[file, version]`. */
function allPins(): [string, string][] {
	return workflows.flatMap((file) => {
		const source = readFileSync(path.join(workflowDir, file), "utf8");
		// Matches `bun-version: 1.4.x`, `bun-version: '1.4.x'` and the matrix
		// array form `bun-version: ['1.4.x']`. The bare `bun-version` key inside
		// a matrix block is picked up here too, which is what lets a
		// `bun-version: ${{ matrix.bun-version }}` reference resolve to the
		// literal it stands for.
		return [...source.matchAll(/bun-version:\s*'?[[]?\s*([^'"\]\n]+)/g)]
			.map((m): [string, string] => [file, (m[1] ?? "").trim()])
			.filter(([, version]) => !version.includes("${{"));
	});
}

test("every workflow pins a bun that can read this lockfile", () => {
	expect(workflows.length).toBeGreaterThan(0);

	const pins = allPins();
	expect(pins.length).toBeGreaterThan(0);

	for (const [file, requested] of pins) {
		expect(requested, `${file} pins bun ${requested}`).toSatisfy(
			(v: string) => v === "1.4" || v >= MIN_BUN,
		);
	}
});

test("package.json declares a bun that can read its own lockfile", () => {
	const pkg = JSON.parse(
		readFileSync(path.resolve(workflowDir, "..", "..", "package.json"), "utf8"),
	) as { packageManager?: string; engines?: { bun?: string } };
	const declared = pkg.packageManager?.replace(/^bun@/, "");

	// `packageManager` is an exact pin, so it has no wildcard to hide behind:
	// it is the one value that can silently contradict `engines.bun`.
	expect(declared).toSatisfy((v?: string) => v !== undefined && v >= MIN_BUN);

	// The two must agree. `engines.bun` is the floor consumers install against,
	// and `packageManager` is what corepack-style tooling resolves locally.
	const floor = pkg.engines?.bun?.replace(/^[>=\s]*/, "");
	expect(declared).toStartWith(floor?.split(".").slice(0, 2).join(".") ?? "");
});
