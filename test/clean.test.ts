import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The first step of `bun run build`, driven the way the build drives it: a real
// process, a real directory, a real exit code. It used to be a `node -e`
// one-liner whose nested quotes only survived the shell that happened to run
// it, so the build worked on Linux and nowhere else.
const script = path.resolve(import.meta.dir, "..", "scripts", "clean.ts");

const run = (target: string) => {
	const result = spawnSync(process.execPath, [script, target], { encoding: "utf8" });
	return { status: result.status ?? 1, stderr: result.stderr };
};

describe("clean", () => {
	test("removes the target directory and everything under it", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "clean-"));
		const dist = path.join(dir, "dist");
		mkdirSync(path.join(dist, "graph", "runtime"), { recursive: true });
		writeFileSync(path.join(dist, "index.js"), "// build output");
		writeFileSync(path.join(dist, "graph", "runtime", "GraphPanel.js"), "// build output");

		const result = run(dist);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(existsSync(dist)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	// A missing directory is the normal case on a fresh checkout or a second
	// build in a row; failing there would break `prepublishOnly`.
	test("tolerates a target that does not exist", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "clean-"));
		const absent = path.join(dir, "dist");

		const result = run(absent);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		rmSync(dir, { recursive: true, force: true });
	});
});
