/**
 * ```base blocks compiled through the real remark pass, the way a page is:
 * each layout's markup, filtering, sorting, grouping, limits and summaries.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { normalizeFsPath } from "../../../shared/route-path.js";
import { buildContentIndex } from "../../content-index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import { remarkWikilink } from "../../remark-wikilink.js";
import type { ContentIndex, RspressPluginMarkdownOptions } from "../../types.js";
import type { PluginRenderContext } from "../types.js";
import {
	isMapLibraryInstalled,
	mapLibrary,
	mapLibraryBuilderConfig,
	renderBase,
} from "./render.js";
import type { MapViewConfig } from "./runtime/map-markup.js";

const FILES: Record<string, string> = {
	"Books/Dune.md":
		'---\nrating: 5\npages: 600\nread: true\nfinished: 2024-01-10\ngenre: scifi\ncover: "[[dune.png]]"\nauthor: "[[Herbert]]"\ntags: [book]\n---\n# Dune\n',
	"Books/Emma.md":
		"---\nrating: 3\npages: 400\nread: false\nfinished: 2024-03-05\ngenre: classic\ntags: [book]\n---\n# Emma\n",
	"Books/Hobbit.md":
		'---\nrating: 4\npages: 300\nread: true\ngenre: fantasy\ncover: "#ff0000"\ntags: [book]\nsite: "https://example.com/hobbit"\n---\n# Hobbit\n',
	"Books/Notes.md": "# Notes\n",
	"Herbert.md": "# Herbert\n\n![[dune.png]]\n",
	"Places/Paris.md": '---\nwhere: "48.85, 2.29"\n---\n# Paris\n',
	"Places/Rome.md": "---\nwhere: [41.9, 12.5]\n---\n# Rome\n",
	"Places/Nowhere.md": '---\nwhere: "north"\n---\n# Nowhere\n',
	"dune.png": "PNG",
	"orphan.png": "PNG",
	"Home.md": "# Home\n",
};

let root: string;
let index: ContentIndex;

beforeAll(async () => {
	root = mkdtempSync(path.join(os.tmpdir(), "bases-render-"));
	for (const [name, content] of Object.entries(FILES)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	index = await buildContentIndex(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

let warn: Mock<typeof console.warn>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

async function compile(
	markdown: string,
	overrides: RspressPluginMarkdownOptions = {},
): Promise<{ html: string; messages: string[] }> {
	const options = normalizePluginOptions({
		enableBases: true,
		enableTagLinking: true,
		onPluginError: "warn",
		onBrokenLink: "warn",
		...overrides,
		bases: { now: "2024-05-10 12:00", ...overrides.bases },
	});
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, {
			getDocsRoot: () => root,
			getContentIndex: async () => index,
			getPublishedIndexes: async () => [index],
			options,
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true });
	const file = new VFile({ value: markdown, path: path.join(root, "Home.md") });
	const result = await processor.process(file);
	return { html: String(result), messages: result.messages.map((message) => message.message) };
}

function fence(yaml: string): string {
	return `# Home\n\n\`\`\`base\n${yaml}\n\`\`\`\n`;
}

/** The text of each element with `className` (tags stripped), in order. */
function texts(html: string, className: string): string[] {
	const pattern = new RegExp(`<(\\w+)[^>]*class="${className}"[^>]*>([\\s\\S]*?)</\\1>`, "g");
	return [...html.matchAll(pattern)].map((match) =>
		(match[2] ?? "").replace(/<[^>]+>/g, "").trim(),
	);
}

/** The text of the cells of one column. */
function column(html: string, property: string): string[] {
	const pattern = new RegExp(
		`<td class="bases-td" data-property="${property}">([\\s\\S]*?)</td>`,
		"g",
	);
	return [...html.matchAll(pattern)].map((match) =>
		(match[1] ?? "").replace(/<[^>]+>/g, "").trim(),
	);
}

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

function decodeAttribute(value: string): string {
	return value.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (entity, hex, decimal, name) =>
		hex
			? String.fromCodePoint(Number.parseInt(hex, 16))
			: decimal
				? String.fromCodePoint(Number(decimal))
				: (ENTITIES[name] ?? entity),
	);
}

/** The map settings a map view carries for the client. */
function mapConfig(html: string): MapViewConfig {
	const raw = /data-bases-map="([^"]*)"/.exec(html)?.[1];
	if (raw === undefined) throw new Error("no map view");
	return JSON.parse(decodeAttribute(raw));
}

/** The marker each located row carries. */
function markers(html: string): Record<string, string>[] {
	return [...html.matchAll(/<tr class="bases-tr"((?: data-map-[a-z]+="[^"]*")+)>/g)].map((match) =>
		Object.fromEntries(
			[...(match[1] ?? "").matchAll(/data-map-([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [
				key ?? "",
				decodeAttribute(value ?? ""),
			]),
		),
	);
}

const BOOKS = 'filters: file.inFolder("Books")';

describe("table view", () => {
	test("columns from order, headers from displayName, cells by type, sorted and limited", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
formulas:
  per_page: (pages / rating).round(1)
properties:
  rating:
    displayName: Stars
views:
  - type: table
    name: Best
    limit: 3
    order: [file.name, rating, formula.per_page, read, finished, author, file.tags, site]
    sort:
      - property: rating
        direction: DESC
    columnSize:
      rating: 80
    rowHeight: tall`),
		);
		expect(texts(html, "bases-th")).toEqual([
			"file name",
			"Stars",
			"per_page",
			"read",
			"finished",
			"author",
			"file tags",
			"site",
		]);
		expect(column(html, "file.name")).toEqual(["Dune", "Hobbit", "Emma"]);
		expect(column(html, "rating")).toEqual(["5", "4", "3"]);
		expect(column(html, "formula.per_page")).toEqual(["120", "75", "133.3"]);
		expect(column(html, "finished")).toEqual(["2024-01-10", "", "2024-03-05"]);
		expect(html).toContain('<a href="/Books/Dune">Dune</a>');
		expect(html).toContain('<a href="/Herbert">Herbert</a>');
		expect(html).toContain('<input type="checkbox" class="bases-checkbox" disabled checked />');
		expect(html).toContain('<input type="checkbox" class="bases-checkbox" disabled />');
		expect(html).toContain(
			'<span class="value-list-element"><a href="/tags/book">#book</a></span>',
		);
		expect(html).toContain(
			'<td class="bases-td" data-property="site"><a href="https://example.com/hobbit">https://example.com/hobbit</a></td>',
		);
		expect(html).toContain('<table class="bases-table" data-row-height="tall">');
		expect(html).toContain('<colgroup><col /><col style="width: 80px" />');
		expect(html).toContain('<span class="bases-toolbar-results">3 results</span>');
		// A single view needs no switcher.
		expect(html).not.toContain("bases-view-tab");
	});

	test("limit cuts the sorted results; a sort on a missing value puts it last either way", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: table
    limit: 2
    order: [file.name]
    sort: [{property: finished, direction: DESC}]
  - type: table
    name: Ascending
    order: [file.name]
    sort: [{property: finished, direction: ASC}, {property: file.name, direction: DESC}]`),
		);
		const [first, second] = html.split('<section class="bases-view"').slice(1);
		expect(column(first ?? "", "file.name")).toEqual(["Emma", "Dune"]);
		expect(first).toContain("2 results");
		expect(column(second ?? "", "file.name")).toEqual(["Dune", "Emma", "Notes", "Hobbit"]);
	});

	test("every default summary, and a custom one, in the summary row", async () => {
		const { html, messages } = await compile(
			fence(`filters: file.hasTag("book")
formulas:
  rMin: rating
  rMax: rating
  rSum: rating
  rRange: rating
  rMedian: rating
  rStd: rating
  latest: finished
  span: finished
  unread: read
  filled: cover
  unique: genre
  custom: rating
  bogus: rating
summaries:
  aboveThree: values.filter(value > 3).length
views:
  - type: table
    order: [rating, formula.rMin, formula.rMax, formula.rSum, formula.rRange, formula.rMedian, formula.rStd, finished, formula.latest, formula.span, read, formula.unread, cover, formula.filled, formula.unique, formula.custom, formula.bogus, file.name]
    summaries:
      rating: Average
      formula.rMin: Min
      formula.rMax: Max
      formula.rSum: Sum
      formula.rRange: Range
      formula.rMedian: Median
      formula.rStd: Stddev
      finished: Earliest
      formula.latest: Latest
      formula.span: Range
      read: Checked
      formula.unread: Unchecked
      cover: Empty
      formula.filled: Filled
      formula.unique: Unique
      formula.custom: aboveThree
      formula.bogus: Mode`),
		);
		expect(texts(html, "bases-summary-value")).toEqual([
			"4",
			"3",
			"5",
			"12",
			"2",
			"4",
			"0.82",
			"2024-01-10",
			"2024-03-05",
			// Latest − earliest is a Duration, worded as Obsidian words it.
			"2 months",
			"2",
			"1",
			"1",
			"2",
			"3",
			"2",
			'⚠ Unknown summary "Mode"',
		]);
		expect(texts(html, "bases-summary-label")[0]).toBe("Average");
		expect(html).toContain('<tfoot class="bases-tfoot"><tr class="bases-summary-row">');
		// The column without a summary still has its cell.
		expect(html).toContain('<td class="bases-summary-cell" data-property="file.name"></td>');
		expect(messages.some((message) => message.includes('Unknown summary "Mode"'))).toBe(true);
	});

	test("groups: a heading row per group, ordered by groupBy, each with its summaries", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: table
    order: [file.name, rating]
    groupBy: {property: read, direction: DESC}
    summaries: {rating: Sum}`),
		);
		expect(html).toContain(
			'<span class="bases-group-value"><input type="checkbox" class="bases-checkbox" disabled checked /></span> <span class="bases-group-count">2</span>',
		);
		expect(texts(html, "bases-group-value")).toEqual(["", "", "None"]);
		expect(texts(html, "bases-group-count")).toEqual(["2", "1", "1"]);
		expect(texts(html, "bases-summary-value")).toEqual(["9", "3", "0"]);
		expect(html).toContain(
			'<tbody class="bases-tbody bases-group"><tr class="bases-group-heading"><th colspan="2" scope="colgroup"><span class="bases-group-property">read</span>',
		);
		expect(html).not.toContain("bases-tfoot");
	});

	test("groupOrder shows only the listed groups, in order; null is the files without a value", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: table
    order: [file.name]
    groupBy: {property: genre, direction: ASC}
    groupOrder: [fantasy, null, romance, scifi]`),
		);
		expect(texts(html, "bases-group-value")).toEqual(["fantasy", "None", "romance", "scifi"]);
		expect(texts(html, "bases-group-count")).toEqual(["1", "1", "0", "1"]);
		expect(column(html, "file.name")).toEqual(["Hobbit", "Notes", "Dune"]);
		const { html: none } = await compile(
			fence(`${BOOKS}\nviews:\n  - type: table\n    groupBy: genre\n    groupOrder: []`),
		);
		expect(none).not.toContain("bases-group-heading");
	});
});

describe("filters", () => {
	test("global and view filters AND together; and/or/not combine statements", async () => {
		const { html } = await compile(
			fence(`filters:
  and:
    - file.inFolder("Books")
    - or:
        - rating > 3
        - genre == "classic"
views:
  - type: table
    name: Not fantasy
    order: [file.name]
    filters:
      not:
        - genre == "fantasy"
        - read == false
  - type: table
    name: All
    order: [file.name]`),
		);
		const [notFantasy, all] = html.split('<section class="bases-view"').slice(1);
		// \`not\` is "none of the following are true".
		expect(column(notFantasy ?? "", "file.name")).toEqual(["Dune"]);
		expect(column(all ?? "", "file.name")).toEqual(["Dune", "Emma", "Hobbit"]);
	});

	test("a filter that cannot be evaluated excludes the file and is reported", async () => {
		const { html, messages } = await compile(
			fence(`filters: rating.nope()\nviews:\n  - type: table`),
		);
		expect(html).toContain("0 results");
		expect(
			messages.some((message) =>
				message.includes('Filter "rating.nope()": Cannot find function "nope" on type Number'),
			),
		).toBe(true);
		const syntax = await compile(fence("filters: 'rating >'"));
		expect(syntax.messages.some((message) => message.includes("Syntax error"))).toBe(true);
	});
});

describe("cards, list, kanban and map views", () => {
	test("cards: a grid with the cover image property and the listed properties", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: cards
    order: [file.name, genre, rating]
    sort: [file.name]
    image: note.cover
    imageFit: contain
    imageAspectRatio: 1.5
    cardSize: 240`),
		);
		expect(html).toContain(
			'<div class="bases-cards-container" style="--bases-cards-width: 240px">',
		);
		expect(html).toContain(
			'<div class="bases-cards-cover" data-image-fit="contain" style="aspect-ratio: 1 / 1.5"><img class="bases-cards-image" src="/dune.png" alt="" loading="lazy" /></div>',
		);
		expect(html).toContain(
			'<span class="bases-cards-image bases-color-swatch" style="background-color: #ff0000"></span>',
		);
		const titles = [
			...html.matchAll(/bases-cards-title"[^>]*><div class="bases-cards-line">(.*?)<\/div>/g),
		];
		expect(titles.map((match) => match[1]?.replace(/<[^>]+>/g, ""))).toEqual([
			"Dune",
			"Emma",
			"Hobbit",
			"Notes",
		]);
		expect(html).toContain(
			'<div class="bases-cards-label">genre</div><div class="bases-cards-line">scifi</div>',
		);
		expect((html.match(/class="bases-cards-item"/g) ?? []).length).toBe(4);
	});

	test("cards group into collapsible sections", async () => {
		const { html } = await compile(fence(`${BOOKS}\nviews:\n  - type: cards\n    groupBy: read`));
		expect(html).toContain(
			'<details class="bases-group" open><summary class="bases-group-heading">',
		);
		expect(texts(html, "bases-group-count")).toEqual(["1", "2", "1"]);
	});

	test("list: bullets with comma-separated properties, numbers with indented ones", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: list
    order: [file.name, genre, rating]
    sort: [file.name]
  - type: list
    name: Numbered
    markers: number
    indentProperties: true
    separator: " | "
    order: [file.name, genre]
    groupBy: read`),
		);
		expect(html).toContain(
			'<ul class="bases-list" data-markers="bullets"><li class="bases-list-item"><span class="bases-list-primary"><a href="/Books/Dune">Dune</a></span><span class="bases-list-separator">, </span><span class="bases-list-property" data-property="genre">scifi</span>',
		);
		// A file without the property shows no separator for it.
		expect(html).toContain(
			'<li class="bases-list-item"><span class="bases-list-primary"><a href="/Books/Notes">Notes</a></span></li>',
		);
		expect(html).toContain('<ol class="bases-list" data-markers="number">');
		expect(html).toContain(
			'<ul class="bases-list-properties"><li class="bases-list-property" data-property="genre"><span class="bases-list-label">genre</span> classic</li></ul>',
		);
	});

	test("kanban: lanes from groupBy, cards with their cover; empty lanes can hide", async () => {
		const { html } = await compile(
			fence(`${BOOKS}
views:
  - type: kanban
    order: [file.name, rating]
    image: cover
    columnWidth: 300
    groupBy: {property: genre, direction: ASC}
    groupOrder: [scifi, romance, null]
  - type: kanban
    name: Hidden
    hideEmptyColumns: true
    groupBy: genre
    groupOrder: [scifi, romance]`),
		);
		const [lanes, hidden] = html.split('<section class="bases-view"').slice(1);
		expect(lanes).toContain(
			'<div class="bases-kanban" style="--bases-kanban-column-width: 300px">',
		);
		expect(texts(lanes ?? "", "bases-kanban-column-title")).toEqual(["scifi", "romance", "None"]);
		expect(texts(lanes ?? "", "bases-kanban-column-count")).toEqual(["1", "0", "1"]);
		expect(lanes).toContain('<section class="bases-kanban-column" data-group="scifi">');
		expect(lanes).toContain(
			'<div class="bases-kanban-card"><div class="bases-cards-cover" data-image-fit="cover"><img class="bases-cards-image" src="/dune.png"',
		);
		expect(texts(hidden ?? "", "bases-kanban-column-title")).toEqual(["scifi"]);
	});

	test("kanban without groupBy puts every card in None and says so", async () => {
		const { html, messages } = await compile(fence(`${BOOKS}\nviews:\n  - type: kanban`));
		expect(texts(html, "bases-kanban-column-title")).toEqual(["None"]);
		expect(texts(html, "bases-kanban-column-count")).toEqual(["4"]);
		expect(messages.some((message) => message.includes("has no groupBy"))).toBe(true);
	});

	test("map: the located files' table, each row a marker, inside the settings the client draws from", async () => {
		const { html, messages } = await compile(
			fence(`filters: file.inFolder("Places")
views:
  - type: map
    name: Places
    coordinates: note.where
    order: [file.name, where]
  - type: map
    name: Grouped
    coordinates: where
    groupBy: file.name
  - type: map
    name: Unset`),
		);
		const [places, grouped, unset] = html.split('<section class="bases-view"').slice(1);
		expect(column(places ?? "", "file.name")).toEqual(["Paris", "Rome"]);
		expect(texts(places ?? "", "bases-th")).toEqual(["file name", "where", "Location"]);
		expect(places).toContain(
			'href="https://www.openstreetmap.org/?mlat=48.85&amp;mlon=2.29#map=15/48.85/2.29"',
		);
		expect(places).toContain("2 results");
		expect(markers(places ?? "")).toEqual([
			{ lat: "48.85", lng: "2.29", title: "Paris", route: "/Places/Paris" },
			{ lat: "41.9", lng: "12.5", title: "Rome", route: "/Places/Rome" },
		]);
		// No icon or colour set: a plain pin, which the marker clones.
		expect(places).toContain(
			'<span class="bases-map-pin"></span><a href="https://www.openstreetmap.org',
		);
		expect(mapConfig(places ?? "")).toEqual({
			center: null,
			zoom: null,
			minZoom: 0,
			maxZoom: 18,
			// A block in a note is an embedded map, sized by `mapHeight`.
			height: 400,
			tiles: ["https://tiles.openfreemap.org/styles/bright"],
			tilesDark: ["https://tiles.openfreemap.org/styles/dark"],
			attribution: "",
			base: "/",
			// The popup's title is the note, and the marker is its location.
			popupSkip: ["coordinates", "file.name", "where"],
		});
		expect(texts(grouped ?? "", "bases-group-count")).toEqual(["0", "1", "1"]);
		expect(unset).toContain("0 results");
		expect(markers(unset ?? "")).toEqual([]);
		// With MapLibre installed the map is drawn: nothing to warn about.
		expect(html).not.toContain("bases-map-install-hint");
		expect(messages.filter((message) => message.includes("Map view"))).toEqual([]);
	});

	test("map: center, zooms, height, marker icon and colour, tiles and attribution from the view", async () => {
		const { html, messages } = await compile(
			fence(`filters: file.inFolder("Places")
formulas:
  colour: 'if(file.name == "Paris", "#ff0000", "red; background: url(x)")'
  pin: '"no such icon!"'
views:
  - type: map
    name: Formula
    coordinates: where
    markerColor: formula.colour
    markerIcon: formula.pin
    center: "[10, 20]"
    defaultZoom: 30
    maxZoom: 12
    minZoom: -3
    mapHeight: 50
    mapTiles: https://tile.openstreetmap.org/{z}/{x}/{y}.png
  - type: map
    name: Text
    coordinates: where
    center: "48.1, 11.5"
    defaultZoom: 6
    mapHeight: 600
    mapTiles: [" https://a.example/{z}/{x}/{y}.png ", "javascript:alert(1)", 3]
    mapTilesDark: https://dark.example/style.json
    mapAttribution: "Tiles © [Example](https://example.com)"
  - type: map
    name: Off
    coordinates: where
    center: "nowhere"
    mapTiles: "not a url"`),
		);
		const [formula, text, off] = html.split('<section class="bases-view"').slice(1);
		expect(mapConfig(formula ?? "")).toMatchObject({
			center: [10, 20],
			zoom: 12,
			minZoom: 0,
			maxZoom: 12,
			height: 100,
			tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
			// Dark mode falls back to the light tiles, as in the Maps plugin.
			tilesDark: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
		});
		// OpenStreetMap's tiles carry its credit, rendered like any markdown link.
		expect(mapConfig(formula ?? "").attribution).toContain(
			'href="https://www.openstreetmap.org/copyright"',
		);
		// A CSS colour colours the pin; anything else (a style injection here) is dropped and reported.
		expect(formula).toContain(
			'<span class="bases-map-pin" style="--bases-map-marker-color: #ff0000">',
		);
		expect(formula).not.toContain("url(x)");
		expect(
			messages.some((message) =>
				message.includes('marker colour "red; background: url(x)" is not a CSS colour'),
			),
		).toBe(true);
		// An icon that cannot be drawn leaves the pin's dot, reported once for the view.
		expect(
			messages.filter(
				(message) => message.includes('Map view "Formula"') && message.includes("dot"),
			),
		).toHaveLength(1);
		expect(mapConfig(text ?? "")).toMatchObject({
			center: [48.1, 11.5],
			zoom: 6,
			height: 600,
			tiles: ["https://a.example/{z}/{x}/{y}.png"],
			tilesDark: ["https://dark.example/style.json"],
		});
		expect(mapConfig(text ?? "").attribution).toContain('href="https://example.com"');
		expect(mapConfig(off ?? "")).toMatchObject({
			center: null,
			tiles: ["https://tiles.openfreemap.org/styles/bright"],
			attribution: "",
		});
	});

	test("map: the site's bases.mapTiles is the background a view without its own uses", async () => {
		const { html } = await compile(
			fence(`filters: file.inFolder("Places")
views:
  - type: map
    name: Site
    coordinates: where
  - type: map
    name: Own
    coordinates: where
    mapTiles: https://own.example/style.json`),
			{
				bases: {
					mapTiles: {
						tiles: "https://site.example/{z}/{x}/{y}.png",
						tilesDark: ["https://site.example/dark/{z}/{x}/{y}.png"],
						attribution: "© Site",
					},
				},
			},
		);
		const [site, own] = html.split('<section class="bases-view"').slice(1);
		expect(mapConfig(site ?? "")).toMatchObject({
			tiles: ["https://site.example/{z}/{x}/{y}.png"],
			tilesDark: ["https://site.example/dark/{z}/{x}/{y}.png"],
			attribution: "© Site",
		});
		expect(mapConfig(own ?? "")).toMatchObject({
			tiles: ["https://own.example/style.json"],
			tilesDark: ["https://own.example/style.json"],
			attribution: "",
		});
	});

	test("map without maplibre-gl: the table stays, with an install hint shown and reported", async () => {
		mapLibrary.installed = false;
		try {
			const { html, messages } = await compile(
				fence(`filters: file.inFolder("Places")
views:
  - type: map
    name: Places
    coordinates: where`),
			);
			expect(html).toContain('<div class="bases-warning bases-map-install-hint">');
			expect(html).toContain("<code>maplibre-gl</code>");
			expect(html).toContain("<code>npm install maplibre-gl</code>");
			expect(column(html, "coordinates")).toEqual(["48.85, 2.29", "41.9, 12.5"]);
			expect(
				messages.filter(
					(message) =>
						message.includes('Map view "Places" renders as a table of its located files') &&
						message.includes("maplibre-gl"),
				),
			).toHaveLength(1);
			expect(mapLibraryBuilderConfig()).toEqual({ resolve: { alias: { "maplibre-gl": false } } });
		} finally {
			mapLibrary.installed = undefined;
		}
		expect(mapLibraryBuilderConfig()).toEqual({});
	});

	test("maplibre-gl is looked up where the site's bundler resolves it", () => {
		expect(isMapLibraryInstalled()).toBe(true);
		expect(isMapLibraryInstalled(os.tmpdir())).toBe(false);
	});

	test("a layout only a plugin provides renders as a table, reported", async () => {
		const { html, messages } = await compile(
			fence(`${BOOKS}\nviews:\n  - type: calendar\n    name: Cal`),
		);
		expect(html).toContain(
			'<section class="bases-view" data-view-type="calendar" data-view-name="Cal">',
		);
		expect(html).toContain('<table class="bases-table"');
		expect(messages.some((message) => message.includes('has the layout "calendar"'))).toBe(true);
	});
});

describe("several views", () => {
	test("a radio switcher, first view shown by default, view names as tabs", async () => {
		const { html } = await compile(
			fence(
				`${BOOKS}\nviews:\n  - type: table\n    name: One\n  - type: cards\n    name: Two & more`,
			),
		);
		expect(html).toContain(
			'<div class="bases-views"><input type="radio" class="bases-view-tab-input" name="bases-views-1" id="bases-views-1-1" /><input type="radio" class="bases-view-tab-input" name="bases-views-1" id="bases-views-1-2" /><div class="bases-view-tabs"><label class="bases-view-tab" for="bases-views-1-1" data-view-type="table">One</label><label class="bases-view-tab" for="bases-views-1-2" data-view-type="cards">Two &amp; more</label></div>',
		);
		// In a block, views carry no id: the id belongs to the base's own page.
		expect(html).not.toContain('id="One"');
	});

	test("two blocks on one page get separate radio groups; more views than tabs stack", async () => {
		const many = Array.from({ length: 13 }, (_, i) => `  - type: table\n    name: V${i}`).join(
			"\n",
		);
		const { html } = await compile(
			`${fence("views:\n  - name: A\n  - name: B")}\n${fence("views:\n  - name: C\n  - name: D")}\n${fence(`views:\n${many}`)}`,
		);
		expect(html).toContain('name="bases-views-1"');
		expect(html).toContain('name="bases-views-2"');
		expect(html).not.toContain('name="bases-views-3"');
		expect((html.match(/<section class="bases-view"/g) ?? []).length).toBe(17);
	});
});

describe("values in cells", () => {
	test("error values show in their cell and are reported; html(), image(), icon() render", async () => {
		const { html, messages } = await compile(
			fence(`filters: file.name == "Dune"
formulas:
  broken: rating.explode()
  invalid: explode(rating)
  days: (finished - today()).days
  markup: html("<mark>hi</mark>")
  picture: image(cover)
  remote: image("https://example.com/x.png")
  glyph: icon("no-such-glyph")
  dated: finished.format("DD/MM/YYYY")
  orphan: link("orphan.png")
  embedded: link("dune.png")
  regex: /x/g
  span: duration("1d")
  out: link("https://obsidian.md", "Obsidian")
  unsafe: link("javascript:alert(1)", "click")
  author: file("Herbert")
  missing: link("Atlantis")
  swatch: image("#00ff00")
  nothing: image(3)
views:
  - type: table
    order: [formula.broken, formula.invalid, formula.days, formula.markup, formula.picture, formula.remote, formula.glyph, formula.dated, formula.orphan, formula.embedded, formula.regex, formula.span, formula.out, formula.unsafe, formula.author, formula.missing, formula.swatch, formula.nothing]`),
		);
		// A method this note's value lacks: an empty cell, as in Obsidian, with the reason kept.
		expect(html).toContain(
			'<td class="bases-td" data-property="formula.broken"><span class="bases-error-value is-empty" title="Cannot find function &quot;explode&quot; on type Number"></span></td>',
		);
		// A function that does not exist at all: the base is wrong, and says so.
		expect(html).toContain(
			'<span class="bases-error-value" title="Cannot find function &quot;explode&quot;">⚠ Cannot find function "explode"</span>',
		);
		// A field a value's type lacks: Obsidian's error, shown as an empty cell and only warned.
		expect(html).toContain(
			'<td class="bases-td" data-property="formula.days"><span class="bases-error-value is-empty" title="Cannot find &quot;days&quot; on type Duration"></span></td>',
		);
		expect(
			messages.some((message) => message.includes('Cannot find "days" on type Duration')),
		).toBe(true);
		expect(
			messages.some((message) => message.includes('Cannot find function "explode" on type Number')),
		).toBe(true);
		expect(html).toContain("<mark>hi</mark>");
		expect(html).toContain('<img class="bases-image" src="/dune.png" alt="" loading="lazy" />');
		expect(html).toContain('<img class="bases-image" src="https://example.com/x.png"');
		// Without lucide-static, or for a name Lucide lacks, the icon is its name and a warning.
		expect(html).toContain(
			'<span class="bases-icon" data-icon="no-such-glyph">no-such-glyph</span>',
		);
		expect(messages.filter((message) => message.includes("as its name"))).toHaveLength(1);
		expect(column(html, "formula.dated")).toEqual(["10/01/2024"]);
		// No page references orphan.png, so it is not published: its name, not a dead link.
		expect(html).toContain('<td class="bases-td" data-property="formula.orphan">orphan</td>');
		expect(html).toContain('<a href="/dune.png"');
		expect(html).toContain("<code>/x/g</code>");
		expect(column(html, "formula.span")).toEqual(["a day"]);
		expect(html).toContain(
			'<a href="https://obsidian.md" class="external-link" target="_blank" rel="noopener noreferrer">Obsidian</a>',
		);
		expect(html).toContain('<td class="bases-td" data-property="formula.unsafe">click</td>');
		expect(html).toContain(
			'<td class="bases-td" data-property="formula.author"><a href="/Herbert">Herbert</a></td>',
		);
		// An unresolved link renders (and is reported) as the same wikilink in the note would.
		expect(column(html, "formula.missing")).toEqual(["Atlantis"]);
		expect(messages.some((message) => message.includes("[[Atlantis|Atlantis]]"))).toBe(true);
		expect(html).toContain(
			'<span class="bases-image bases-color-swatch" style="background-color: #00ff00"></span>',
		);
		expect(html).toContain('<td class="bases-td" data-property="formula.nothing"></td>');
	});

	test("dates show in the configured formats; `this` in a block is the note holding it", async () => {
		const { html } = await compile(
			fence(`filters: file.name == "Dune"
formulas:
  here: this.file.name
  when: finished
  at: date("2024-01-10 08:05")
views:
  - type: table
    order: [formula.here, formula.when, formula.at]`),
			{ bases: { dateFormat: "D MMM YYYY", dateTimeFormat: "D MMM, HH:mm" } },
		);
		expect(column(html, "formula.here")).toEqual(["Home"]);
		expect(column(html, "formula.when")).toEqual(["10 Jan 2024"]);
		expect(column(html, "formula.at")).toEqual(["10 Jan, 08:05"]);
	});

	test("text values render as markdown in their note; plain text is escaped", async () => {
		const { html } = await compile(
			fence(`filters: file.name == "Dune"
formulas:
  rich: '"**bold** and [[Herbert]]"'
  plain: '"a < b"'
views:
  - type: table
    order: [formula.rich, formula.plain]`),
		);
		expect(html).toContain('<strong>bold</strong> and <a href="/Herbert">Herbert</a>');
		expect(html).toContain('<td class="bases-td" data-property="formula.plain">a &#x3C; b</td>');
	});
});

describe("problems in the base itself", () => {
	test("malformed YAML is shown in place and reported", async () => {
		const { html, messages } = await compile(fence("views: [unclosed"));
		expect(html).toContain(
			'<div class="bases-error"><strong>base block in Home.md</strong>: Invalid YAML',
		);
		expect(
			messages.some((message) => message.includes("base block in Home.md: Invalid YAML")),
		).toBe(true);
	});

	test("unknown keys are shown as warnings above the views and reported as warnings", async () => {
		const { html, messages } = await compile(fence(`${BOOKS}\ncolour: red`));
		expect(html).toContain('<div class="bases-warning">Unknown key "colour"</div>');
		expect(messages.some((message) => message.includes('Unknown key "colour"'))).toBe(true);
	});

	test('with onPluginError "error" a broken base fails the page', async () => {
		await expect(compile(fence("views: [unclosed"), { onPluginError: "error" })).rejects.toThrow();
	});

	test('with onPluginError "error", data a formula does not fit warns; an unknown function fails', async () => {
		const fits = await compile(
			fence(`${BOOKS}
formulas:
  days: (finished - today()).days
  upper: rating.upper()
  inDays: ((finished - today()) / 86400000).round()
views:
  - type: table
    order: [file.name, formula.days, formula.upper, formula.inDays]
    sort: [file.name]
  - type: table
    name: Filtered
    filters: genre.round() > 1`),
			{ onPluginError: "error" },
		);
		expect(column(fits.html, "formula.inDays")).toEqual(["-121", "-66", "", ""]);
		expect(fits.messages.some((message) => message.includes('Filter "genre.round() > 1"'))).toBe(
			true,
		);
		expect(fits.messages.some((message) => message.includes('"upper" on type Number'))).toBe(true);
		await expect(
			compile(fence(`${BOOKS}\nformulas:\n  x: nope(rating)\nviews:\n  - order: [formula.x]`), {
				onPluginError: "error",
			}),
		).rejects.toThrow();
	});

	test("a disabled feature leaves the block as code", async () => {
		const { html } = await compile(fence(BOOKS), { enableBases: false });
		expect(html).toContain('<code class="language-base">');
	});
});

describe("rendering cost", () => {
	test("text that cannot link renders once for every row; links still render per note", async () => {
		const options = normalizePluginOptions({ enableBases: true, onPluginError: "warn" });
		const home = index.byAbsolutePath.get(normalizeFsPath(path.join(root, "Home.md")));
		if (!home) throw new Error("no Home page");
		const calls: Array<[string, string | undefined]> = [];
		const ctx: PluginRenderContext = {
			file: new VFile(),
			options,
			currentPage: home,
			index,
			docsRoot: root,
			siteBase: "/",
			mode: "page",
			wholeNote: true,
			source: "",
			idPrefix: "",
			renderInline: async (markdown, page) => {
				calls.push([markdown, page?.relativePath]);
				return markdown;
			},
			renderBlock: async (markdown) => markdown,
			resolve: async () => ({ status: "broken-page" }),
			indexFor: async () => index,
			publishedIndexes: async () => [index],
			report: () => {},
		};
		await renderBase(
			{
				source: `${BOOKS}\nviews:\n  - type: table\n    order: [file.tags, author]`,
				label: "base block",
				thisFile: undefined,
				standalone: false,
			},
			ctx,
		);
		// Three books tagged #book: one render of the tag, not one per row.
		expect(calls.filter(([markdown]) => markdown === "#book")).toHaveLength(1);
		// A link resolves from the note it is written in, so it stays per note.
		expect(calls.filter(([markdown]) => markdown.includes("[[Herbert"))).toEqual([
			["[[Herbert|Herbert]]", "Books/Dune.md"],
		]);
	});
});
