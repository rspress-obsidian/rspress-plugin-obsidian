import { describe, expect, mock, test } from "bun:test";

// The note-text chunk fails once (a flaky download), then loads. Bun evaluates
// a mocked module once, so the failure is raised the first time the loader
// reads the entries.
const entries = [
	{ id: "/api", text: "Endpoints and rate limits" },
	{ id: "/guide", text: "Getting started" },
];
let attempts = 0;
const searchEntries = {
	map<T>(fn: (entry: (typeof entries)[number]) => T): T[] {
		attempts += 1;
		if (attempts === 1) throw new Error("chunk failed to load");
		return entries.map(fn);
	},
};
mock.module("virtual-graph-search-data", () => ({ searchEntries, default: searchEntries }));

// Imported after the mock is registered, so the loader binds to it.
const { loadGraphSearchText } = await import("./graph-search-data");

describe("loadGraphSearchText", () => {
	test("a failed chunk load is retried by the next query, then shared", async () => {
		await expect(loadGraphSearchText()).rejects.toThrow("chunk failed to load");

		const text = await loadGraphSearchText();
		expect(text.get("/api")).toBe("Endpoints and rate limits");
		expect([...text.keys()]).toEqual(["/api", "/guide"]);
		// Every later query on the page shares the one loaded map.
		expect(await loadGraphSearchText()).toBe(text);
		expect(attempts).toBe(2);
	});
});
