import { describe, expect, test } from "bun:test";
import { normalizePluginOptions } from "../normalize-options.js";
import { disabledFenceMessage, enabledPluginFeatures, mergeBuilderConfigs } from "./index.js";

describe("disabledFenceMessage", () => {
	test("names the option that turns each plugin's fences on", () => {
		const options = normalizePluginOptions({});

		expect(disabledFenceMessage("tasks", options)).toContain("`enableTasks`");
		expect(disabledFenceMessage("excalidraw", options)).toContain("`enableExcalidraw`");
		expect(disabledFenceMessage("base", options)).toContain("`enableBases`");
		expect(disabledFenceMessage("dataviewjs", options)).toContain("`enableDataview`");
	});

	test("stays silent once the plugin is on, and for the author's own languages", () => {
		const options = normalizePluginOptions({
			enableTasks: true,
			enableBases: true,
			enableDataview: true,
		});

		expect(disabledFenceMessage("tasks", options)).toBeUndefined();
		expect(disabledFenceMessage("base", options)).toBeUndefined();
		expect(disabledFenceMessage("dataview", options)).toBeUndefined();
		expect(disabledFenceMessage("ts", options)).toBeUndefined();
		// Kanban stores boards as notes; a ```kanban fence is nobody's syntax.
		expect(disabledFenceMessage("kanban", normalizePluginOptions({}))).toBeUndefined();
	});
});

describe("enabledPluginFeatures", () => {
	test("runs Templater before every plugin whose input it may produce", () => {
		const ids = enabledPluginFeatures(
			normalizePluginOptions({
				enableBases: true,
				enableTasks: true,
				enableTemplater: true,
				enableKanban: true,
				enableExcalidraw: true,
			}),
		).map((feature) => feature.id);

		expect(ids).toEqual(["templater", "tasks", "kanban", "excalidraw", "bases"]);
		expect(enabledPluginFeatures(normalizePluginOptions({}))).toEqual([]);
	});
});

describe("mergeBuilderConfigs", () => {
	test("keeps every plugin, alias and define from each feature", () => {
		const first = { name: "a", setup() {} };
		const second = { name: "b", setup() {} };

		const merged = mergeBuilderConfigs(
			{ plugins: [first], resolve: { alias: { mermaid: false } }, source: { define: { A: "1" } } },
			{},
			{
				plugins: [second],
				resolve: { alias: { "@excalidraw/excalidraw": false } },
				source: { define: { B: "2" } },
			},
		);

		expect(merged.plugins).toEqual([first, second]);
		// Rsbuild applies a chain in order, so neither feature's alias is lost.
		expect(merged.resolve?.alias).toEqual([
			{ mermaid: false },
			{ "@excalidraw/excalidraw": false },
		]);
		expect(merged.source?.define).toEqual({ A: "1", B: "2" });
	});

	test("adds no empty keys when no feature contributes config", () => {
		expect(mergeBuilderConfigs({}, {})).toEqual({});
	});
});
