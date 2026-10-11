import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// `bun install --frozen-lockfile` hard-fails on a lockfile the pinned bun
// cannot parse, and that failure only ever surfaces in CI — the release job
// once died at the install step while every test job was green, because one
// workflow still hard-coded a bun the others had moved past.
//
// Every workflow now reads the version from `packageManager` in package.json,
// so there is one pin to keep right. These tests keep it that way: no
// setup-bun step may fall back to its own default or hard-code a bun too old
// for the lockfile, and `packageManager` itself must be new enough.
const root = path.resolve(import.meta.dir, "..");
const workflowDir = path.join(root, ".github", "workflows");
const workflows = readdirSync(workflowDir).filter((f) => f.endsWith(".yml"));

// The lowest bun that can parse bun.lock (lockfileVersion 2):
// `bun@1.3.14 install --frozen-lockfile` exits with `UnknownLockfileVersion`.
const MIN_BUN = "1.4.0";

/** Each `oven-sh/setup-bun` step, as `[file, step source]`. */
function setupBunSteps(): [string, string][] {
	return workflows.flatMap((file) => {
		const source = readFileSync(path.join(workflowDir, file), "utf8");
		return [...source.matchAll(/uses:\s*oven-sh\/setup-bun@[\s\S]*?(?=\n\s*- |\n\S|$)/g)].map(
			(m): [string, string] => [file, m[0]],
		);
	});
}

test("every setup-bun step takes its bun from package.json or pins one that reads the lockfile", () => {
	const steps = setupBunSteps();
	expect(steps.length).toBeGreaterThan(0);

	for (const [file, step] of steps) {
		const fromFile = /bun-version-file:\s*'?"?package\.json/.test(step);
		const pin = /bun-version:\s*'?"?([^'"\n]+)/.exec(step)?.[1]?.trim();
		const pinOk =
			pin !== undefined && Bun.semver.satisfies(pin.replace(/\.x$/, ".0"), `>=${MIN_BUN}`);
		expect(fromFile || pinOk, `${file}: setup-bun step\n${step}`).toBe(true);
	}
});

test("packageManager declares a bun that can read the lockfile", () => {
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		packageManager?: string;
	};
	const declared = pkg.packageManager?.replace(/^bun@/, "");
	expect(declared).toBeDefined();
	expect(Bun.semver.satisfies(declared ?? "", `>=${MIN_BUN}`)).toBe(true);
});
