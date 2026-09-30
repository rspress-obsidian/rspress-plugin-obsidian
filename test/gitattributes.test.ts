import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `.gitattributes` exists because line endings are observable in this package:
// the parsers split on "\n" and the tests assert exact "\n" strings, so a
// Windows checkout with `core.autocrlf=true` — what most Windows Git installers
// write — would fail the suite against files nobody edited. These drive real
// `git` in a scratch repo rather than reading the attribute file, because the
// contract is what git *does* with it.
const repoRoot = path.resolve(import.meta.dir, "..");
const gitattributes = path.join(repoRoot, ".gitattributes");

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/** A scratch repo with `core.autocrlf=true`, the config the hazard needs. */
const scratchRepo = (): string => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gitattributes-"));
	git(dir, "init", "-q");
	git(dir, "config", "core.autocrlf", "true");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "test");
	return dir;
};

/** Deletes the tracked file and lets git write it again through its filters. */
const recheckout = (dir: string, file: string): string => {
	rmSync(path.join(dir, file));
	git(dir, "checkout", "--", file);
	return readFileSync(path.join(dir, file), "utf8");
};

test("a checkout with core.autocrlf=true keeps LF", () => {
	const dir = scratchRepo();
	try {
		writeFileSync(path.join(dir, "note.md"), "line1\nline2\n");
		git(dir, "add", "note.md");
		git(dir, "commit", "-qm", "one");

		// The hazard this file exists for, pinned: with nothing declaring the
		// line ending, `core.autocrlf=true` rewrites the checkout to CRLF.
		expect(recheckout(dir, "note.md")).toBe("line1\r\nline2\r\n");

		copyFileSync(gitattributes, path.join(dir, ".gitattributes"));
		git(dir, "add", ".gitattributes");
		git(dir, "commit", "-qm", "two");

		expect(recheckout(dir, "note.md")).toBe("line1\nline2\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every asset the repo tracks is marked binary", () => {
	// Extensions the package ships or a theme can ship. Only the ones with
	// tracked files are checked, and at least one must be found, or a renamed
	// fixture would quietly turn this test into a no-op.
	const patterns = [
		"*.png",
		"*.jpg",
		"*.jpeg",
		"*.gif",
		"*.webp",
		"*.ico",
		"*.pdf",
		"*.woff",
		"*.woff2",
		"*.ttf",
		"*.otf",
	];
	const assets = patterns
		.flatMap((pattern) => git(repoRoot, "ls-files", "--", pattern).trim().split("\n"))
		.filter(Boolean);
	expect(assets.length).toBeGreaterThan(0);

	// `binary` is the `-text -diff` macro: no line-ending conversion, and no
	// line-wise diff or merge on bytes that are not lines.
	const attributes = git(repoRoot, "check-attr", "text", "diff", "merge", "--", ...assets);
	for (const line of attributes.trim().split("\n")) {
		expect(line).toMatch(/: (text|diff|merge): unset$/);
	}
	expect(attributes.trim().split("\n")).toHaveLength(assets.length * 3);
});
