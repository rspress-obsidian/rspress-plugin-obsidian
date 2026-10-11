import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	FORCE_GRAPH_INSTALL_HINT,
	forceGraphBuilderConfig,
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
		expect(forceGraphBuilderConfig({ installed: true })).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});

test("aliases a missing react-force-graph-2d to an empty module and warns once", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const alias = { resolve: { alias: { "react-force-graph-2d": false } } } as const;
		expect(forceGraphBuilderConfig({ installed: false })).toEqual(alias);
		expect(forceGraphBuilderConfig({ installed: false })).toEqual(alias);
		// The markdown, canvas and graph plugins each build one config; the site
		// is told once.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(FORCE_GRAPH_INSTALL_HINT);
	} finally {
		warn.mockRestore();
	}
});
