import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MERMAID_INSTALL_HINT } from "./classes";
import { isMermaidInstalled, mermaidBuilderConfig } from "./install";

test("finds mermaid where this package's runtime chunks resolve it", () => {
	expect(isMermaidInstalled()).toBe(true);
});

test("reports mermaid missing from a directory with no node_modules above it", () => {
	const isolated = mkdtempSync(path.join(os.tmpdir(), "obsidian-no-mermaid-"));
	try {
		expect(isMermaidInstalled(isolated)).toBe(false);
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("contributes nothing to the build when mermaid is installed", () => {
	expect(mermaidBuilderConfig({ diagramsRequested: true, installed: true })).toEqual({});
});

test("aliases a missing mermaid to an empty module so the site still builds", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(mermaidBuilderConfig({ diagramsRequested: false, installed: false })).toEqual({
			resolve: { alias: { mermaid: false } },
		});
		// A canvas-only site never asked for diagrams, so the build stays quiet.
		expect(warn).not.toHaveBeenCalled();

		mermaidBuilderConfig({ diagramsRequested: true, installed: false });
		mermaidBuilderConfig({ diagramsRequested: true, installed: false });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(MERMAID_INSTALL_HINT);
	} finally {
		warn.mockRestore();
	}
});
