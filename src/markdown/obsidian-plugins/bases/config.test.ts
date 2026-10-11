import { describe, expect, test } from "bun:test";
import { BaseConfigError, parseBaseConfig } from "./config.js";

const EXAMPLE = `
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    groupOrder: [Planned, null, 3]
    filters: 'status != "done"'
    order:
      - file.name
      - formula.ppu
    sort:
      - property: file.name
        direction: desc
      - column: note.age
    summaries:
      formula.ppu: Average
    columnSize:
      file.name: 200
    rowHeight: medium
`;

function errorOf(source: string): string {
	try {
		parseBaseConfig(source);
	} catch (error) {
		expect(error).toBeInstanceOf(BaseConfigError);
		return (error as Error).message;
	}
	throw new Error("expected the base to be rejected");
}

describe("parseBaseConfig", () => {
	test("reads every section of the documented example", () => {
		const { config, warnings } = parseBaseConfig(EXAMPLE);
		expect(warnings).toEqual([]);
		expect(config.filters).toEqual({
			kind: "or",
			children: [
				{ kind: "statement", source: 'file.hasTag("tag")' },
				{
					kind: "and",
					children: [
						{ kind: "statement", source: 'file.hasTag("book")' },
						{ kind: "statement", source: 'file.hasLink("Textbook")' },
					],
				},
				{
					kind: "not",
					children: [
						{ kind: "statement", source: 'file.hasTag("book")' },
						{ kind: "statement", source: 'file.inFolder("Required Reading")' },
					],
				},
			],
		});
		expect(config.formulas.ppu).toBe("(price / age).toFixed(2)");
		expect(config.displayNames).toEqual({ status: "Status", "formula.formatted_price": "Price" });
		expect(config.summaries).toEqual({ customAverage: "values.mean().round(3)" });
		const [view] = config.views;
		expect(view).toEqual({
			type: "table",
			name: "My table",
			limit: 10,
			filters: { kind: "statement", source: 'status != "done"' },
			order: ["file.name", "formula.ppu"],
			sort: [
				{ property: "file.name", direction: "DESC" },
				{ property: "note.age", direction: "ASC" },
			],
			groupBy: { property: "note.age", direction: "DESC" },
			groupOrder: ["Planned", null, "3"],
			summaries: { "formula.ppu": "Average" },
			settings: { columnSize: { "file.name": 200 }, rowHeight: "medium" },
		});
	});

	test("an empty base is one table of every file", () => {
		for (const source of ["", "views: []", "filters:\n"]) {
			expect(parseBaseConfig(source).config.views).toEqual([
				{
					type: "table",
					name: "Table",
					order: ["file.name"],
					sort: [],
					summaries: {},
					settings: {},
				},
			]);
		}
	});

	test("a view without a name is named after its layout; a bare string sorts ascending", () => {
		const { config } = parseBaseConfig(
			"views:\n  - type: cards\n    sort: [file.mtime]\n    groupBy: status\n",
		);
		expect(config.views[0]?.name).toBe("Cards");
		expect(config.views[0]?.sort).toEqual([{ property: "file.mtime", direction: "ASC" }]);
		expect(config.views[0]?.groupBy).toEqual({ property: "status", direction: "ASC" });
		expect(parseBaseConfig("views:\n  - name: 7\n").config.views[0]).toMatchObject({
			type: "table",
			name: "7",
		});
	});

	test("keys Obsidian does not define are warnings, layout keys are not", () => {
		const { warnings } = parseBaseConfig(
			[
				"colour: red",
				"properties:",
				"  status:",
				"    width: 3",
				"views:",
				"  - type: cards",
				"    image: note.cover",
				"    imageFit: contain",
				"    imageAspectRatio: 0.75",
				"    shuffle: true",
				"  - type: map",
				"    coordinates: note.where",
				"  - type: calendar",
				"    startDate: note.when",
			].join("\n"),
		);
		expect(warnings).toEqual([
			'Unknown key "colour"',
			'Unknown key "width" in properties.status',
			'Unknown key "shuffle" in view "Cards" (cards)',
			'Unknown key "startDate" in view "Calendar" (calendar)',
		]);
	});

	test("malformed YAML and wrongly shaped sections are errors", () => {
		expect(errorOf("views: [unclosed")).toContain("Invalid YAML");
		expect(errorOf("a: 1\na: 2")).toContain("Invalid YAML");
		expect(errorOf("- just\n- a list")).toBe("A base must be a YAML mapping");
		expect(errorOf("views: table")).toBe("views must be a list");
		expect(errorOf("views: [3]")).toBe("views[0] must be a mapping");
		expect(errorOf("filters: [a]")).toBe(
			"filters must be a filter statement or an and/or/not object",
		);
		expect(errorOf("filters:\n  and: [a]\n  or: [b]")).toContain(
			'exactly one of "and", "or" or "not" (found "and", "or")',
		);
		expect(errorOf("filters: {}")).toContain("(found none)");
		expect(errorOf("filters:\n  xor: [a]")).toContain('(found "xor")');
		expect(errorOf("filters:\n  not: a")).toBe("filters.not must be a list");
		expect(errorOf("filters:\n  and:\n    - or:\n        - [x]")).toBe(
			"filters.and[0].or[0] must be a filter statement or an and/or/not object",
		);
		expect(errorOf("formulas: [a]")).toBe("formulas must be a mapping");
		expect(errorOf("properties: 3")).toBe("properties must be a mapping");
		expect(errorOf("properties:\n  status: Status")).toBe("properties.status must be a mapping");
		expect(errorOf("views:\n  - limit: many")).toBe("views[0].limit must be a whole number");
		expect(errorOf("views:\n  - limit: -1")).toBe("views[0].limit must be a whole number");
		expect(errorOf("views:\n  - order: file.name")).toBe(
			"views[0].order must be a list of properties",
		);
		expect(errorOf("views:\n  - sort: file.name")).toBe("views[0].sort must be a list");
		expect(errorOf("views:\n  - sort: [{direction: ASC}]")).toBe(
			"views[0].sort[0] needs a property",
		);
		expect(errorOf("views:\n  - sort: [3]")).toBe("views[0].sort[0] must be {property, direction}");
		expect(errorOf("views:\n  - groupOrder: Done")).toBe("views[0].groupOrder must be a list");
		expect(errorOf("views:\n  - summaries: [Average]")).toBe(
			"views[0].summaries must be a mapping",
		);
	});

	test("scalar filter statements and null entries are read as written", () => {
		const { config } = parseBaseConfig(
			"filters: true\nformulas:\n  n: 5\n  blank:\nproperties:\n  x: {}\n  y: {displayName: null}",
		);
		expect(config.filters).toEqual({ kind: "statement", source: "true" });
		expect(config.formulas).toEqual({ n: "5", blank: "" });
		expect(config.displayNames).toEqual({});
	});
});
