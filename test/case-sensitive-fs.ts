import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Can this filesystem hold two files whose names differ only by case?
 *
 * Linux can; macOS and Windows cannot, and silently so — the second write
 * overwrites the first rather than erroring. A fixture of `Case.md` plus
 * `case.md` is therefore one file there, and a test that expects the index to
 * report two ambiguous candidates sees one.
 *
 * Probed rather than inferred from `process.platform`, because the platform is
 * not what decides it: a case-insensitive volume is mounted on Linux too, so a
 * platform check would skip these tests where they *would* run and keep them
 * where they cannot.
 */
export const caseSensitiveFilesystem = (() => {
	const probe = mkdtempSync(path.join(tmpdir(), "case-probe-"));
	try {
		writeFileSync(path.join(probe, "Case.md"), "a");
		writeFileSync(path.join(probe, "case.md"), "b");
		// If the second write replaced the first, this reads back as "b".
		return readFileSync(path.join(probe, "Case.md"), "utf-8") === "a";
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

if (!caseSensitiveFilesystem) {
	console.warn(
		"case-differing-file tests skipped: this filesystem treats names that differ only by case as one file",
	);
}
