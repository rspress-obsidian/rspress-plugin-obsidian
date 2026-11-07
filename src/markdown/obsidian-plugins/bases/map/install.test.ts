/**
 * The optional `maplibre-gl` peer dependency: where the bundler finds it, and
 * the Rsbuild config a site gets with and without it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	hasMapLibraryWorkerModule,
	isMapLibraryInstalled,
	mapLibrary,
	mapLibraryBuilderConfig,
} from "./install.js";

afterEach(() => {
	mapLibrary.installed = undefined;
});

describe("maplibre-gl detection", () => {
	test("maplibre-gl is looked up where the site's bundler resolves it", () => {
		expect(isMapLibraryInstalled()).toBe(true);
		expect(isMapLibraryInstalled(os.tmpdir())).toBe(false);
	});

	test("maplibre-gl is found with MapLibre 5's layout and with 6's import-only exports and worker module", () => {
		const layouts = {
			5: {
				manifest: { name: "maplibre-gl", type: "module", main: "dist/maplibre-gl.js" },
				files: ["maplibre-gl.js", "maplibre-gl.css"],
				workerModule: false,
			},
			6: {
				manifest: {
					name: "maplibre-gl",
					type: "module",
					exports: {
						".": { types: "./dist/maplibre-gl.d.ts", import: "./dist/maplibre-gl.mjs" },
						"./dist/*": "./dist/*",
						"./package.json": "./package.json",
					},
				},
				files: ["maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css"],
				workerModule: true,
			},
		};
		for (const [major, { manifest, files, workerModule }] of Object.entries(layouts)) {
			const site = mkdtempSync(path.join(os.tmpdir(), `bases-maplibre-${major}-`));
			try {
				const dist = path.join(site, "node_modules", "maplibre-gl", "dist");
				mkdirSync(dist, { recursive: true });
				writeFileSync(path.join(dist, "..", "package.json"), JSON.stringify(manifest));
				for (const file of files) writeFileSync(path.join(dist, file), "");
				expect([major, isMapLibraryInstalled(site), hasMapLibraryWorkerModule(site)]).toEqual([
					major,
					true,
					workerModule,
				]);
			} finally {
				rmSync(site, { recursive: true, force: true });
			}
		}
	});
});

describe("mapLibraryBuilderConfig", () => {
	test("without maplibre-gl the import is aliased to an empty module and no worker is emitted", () => {
		mapLibrary.installed = false;
		expect(mapLibraryBuilderConfig()).toEqual({
			resolve: { alias: { "maplibre-gl": false } },
			source: { define: { __RSPRESS_OBSIDIAN_MAPLIBRE_WORKER__: "false" } },
		});
		mapLibrary.installed = undefined;
		expect(mapLibraryBuilderConfig()).not.toHaveProperty("resolve");
	});

	test("the map component is told whether the installed MapLibre has a worker module to emit", () => {
		const { version } = JSON.parse(
			readFileSync(createRequire(import.meta.url).resolve("maplibre-gl/package.json"), "utf8"),
		) as { version: string };
		expect(mapLibraryBuilderConfig().source?.define).toEqual({
			__RSPRESS_OBSIDIAN_MAPLIBRE_WORKER__: JSON.stringify(Number.parseInt(version, 10) >= 6),
		});
	});

	test("MapLibre's stylesheet gets a lazy chunk of its own, not a place in the global one", () => {
		const { splitChunks } = mapLibraryBuilderConfig();
		const group = splitChunks ? splitChunks.cacheGroups?.["obsidian-maplibre-css"] : undefined;
		if (!group || typeof group !== "object" || !(group.test instanceof RegExp)) {
			throw new Error("expected a cache group with a RegExp test");
		}
		// Rspress's `styles` group (priority 99) pulls every stylesheet into the
		// one every page loads; only a higher priority keeps this one out of it.
		expect(group).toMatchObject({ chunks: "async", enforce: true });
		expect(group.priority).toBeGreaterThan(99);
		expect(group.test.test("/site/node_modules/maplibre-gl/dist/maplibre-gl.css")).toBe(true);
		expect(group.test.test("C:\\site\\node_modules\\maplibre-gl\\dist\\maplibre-gl.css")).toBe(
			true,
		);
		expect(group.test.test("/site/node_modules/maplibre-gl/dist/maplibre-gl.js")).toBe(false);
	});
});
