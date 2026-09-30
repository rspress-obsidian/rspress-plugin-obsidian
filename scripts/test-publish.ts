#!/usr/bin/env bun
/**
 * Runs the packed-artifact suite and fails when there is nothing to test.
 *
 * The suite skips itself when `dist/` is absent so that a bare `bun test` on a
 * clean checkout does not fail — CI runs `bun test` before `bun run build`, and
 * a contributor's first run should not be red. That skip is wrong for the
 * release path: a build that produced nothing would let `prepublishOnly` go
 * green while the tarball contract went unchecked. This wrapper is the explicit
 * path, so it asserts the build output exists first.
 *
 * A script file rather than `VAR=1 bun test …` because the environment-prefix
 * form is POSIX-only, and rather than `test -f … && …` because that is
 * shell-dependent too.
 *
 * Usage: `bun scripts/test-publish.ts` (invoked by `bun run test:publish`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const required = ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"];

for (const artifact of required) {
	if (!existsSync(path.join(root, artifact))) {
		console.error(
			`[test:publish] ${artifact} is missing — the build produced nothing, so the packed-artifact contract would go unchecked. Run \`bun run build\` first.`,
		);
		process.exit(1);
	}
}

const result = spawnSync("bun", ["test", "test/publish"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
