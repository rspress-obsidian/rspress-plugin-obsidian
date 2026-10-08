import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readObsidianConfigFile, readObsidianPluginSettings } from "./settings.js";

const roots: string[] = [];

function vaultWith(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-settings-"));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		fs.writeFileSync(path.join(root, relative), content);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("readObsidianPluginSettings", () => {
	test("reads a community plugin's saved settings", () => {
		const vault = vaultWith({
			".obsidian/plugins/obsidian-tasks-plugin/data.json": '{"globalFilter":"#task"}',
		});

		expect(readObsidianPluginSettings(vault, "obsidian-tasks-plugin")).toEqual({
			globalFilter: "#task",
		});
	});

	test("honours a renamed configuration folder", () => {
		const vault = vaultWith({ ".config/plugins/templater-obsidian/data.json": '{"a":1}' });

		expect(readObsidianPluginSettings(vault, "templater-obsidian", ".config")).toEqual({ a: 1 });
		expect(readObsidianPluginSettings(vault, "templater-obsidian")).toBeUndefined();
	});

	test("sees a setting changed in Obsidian while the dev server runs", () => {
		const vault = vaultWith({ ".obsidian/plugins/x/data.json": '{"v":1}' });
		const file = path.join(vault, ".obsidian/plugins/x/data.json");
		expect(readObsidianPluginSettings(vault, "x")).toEqual({ v: 1 });

		fs.writeFileSync(file, '{"v":2}');
		const later = new Date(Date.now() + 5_000);
		fs.utimesSync(file, later, later);

		expect(readObsidianPluginSettings(vault, "x")).toEqual({ v: 2 });
	});

	test("forgets settings whose file was deleted", () => {
		const vault = vaultWith({ ".obsidian/plugins/x/data.json": '{"v":1}' });
		expect(readObsidianPluginSettings(vault, "x")).toEqual({ v: 1 });

		fs.rmSync(path.join(vault, ".obsidian/plugins/x/data.json"));

		expect(readObsidianPluginSettings(vault, "x")).toBeUndefined();
	});
});

describe("readObsidianConfigFile", () => {
	test("is empty without a vault", () => {
		expect(readObsidianConfigFile(undefined, "app.json")).toBeUndefined();
	});

	test("ignores a file that is not a JSON object, warning once per change", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const vault = vaultWith({
				".obsidian/broken.json": "{not json",
				".obsidian/list.json": "[1]",
			});

			expect(readObsidianConfigFile(vault, "broken.json")).toBeUndefined();
			expect(readObsidianConfigFile(vault, "broken.json")).toBeUndefined();
			expect(readObsidianConfigFile(vault, "list.json")).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("broken.json is not valid JSON");
		} finally {
			warn.mockRestore();
		}
	});
});
