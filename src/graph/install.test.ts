import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createForceGraphBuilderConfig,
	FORCE_GRAPH_INSTALL_HINT,
	isForceGraphInstalled,
} from "./install";

test("finds react-force-graph-2d where this package's runtime chunks resolve it", () => {
	expect(isForceGraphInstalled()).toBe(true);
});

test("reports react-force-graph-2d missing from a directory with no node_modules above it", () => {
	const isolated = mkdtempSync(path.join(os.tmpdir(), "obsidian-no-force-graph-"));
	try {
		expect(isForceGraphInstalled(isolated)).toBe(false);
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("contributes nothing to the build when react-force-graph-2d is installed", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(createForceGraphBuilderConfig()({ installed: true })).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});

test("aliases a missing react-force-graph-2d to an empty module and warns once per site", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const alias = { resolve: { alias: { "react-force-graph-2d": false } } } as const;
		const forOneSite = createForceGraphBuilderConfig();
		expect(forOneSite({ installed: false })).toEqual(alias);
		expect(forOneSite({ installed: false })).toEqual(alias);
		// The markdown, canvas and graph plugins each build one config; the site
		// is told once.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(FORCE_GRAPH_INSTALL_HINT);
		// A second site in the same process still hears about its own graph.
		expect(createForceGraphBuilderConfig()({ installed: false })).toEqual(alias);
		expect(warn).toHaveBeenCalledTimes(2);
	} finally {
		warn.mockRestore();
	}
});
