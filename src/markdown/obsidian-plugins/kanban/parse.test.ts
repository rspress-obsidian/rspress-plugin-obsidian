import { describe, expect, test } from "bun:test";
import { normalizePluginOptions } from "../../normalize-options.js";
import {
	boardSettingsLayer,
	type KanbanSettingsLayer,
	optionSettingsLayer,
	resolveKanbanSettings,
} from "./board-settings.js";
import { extractSettingsBlock, parseKanbanBoard } from "./parse.js";

const options = normalizePluginOptions();
const NO_FIELDS = { dataview: false, tasks: false };

function parse(body: string, layer: KanbanSettingsLayer = {}, fields = NO_FIELDS) {
	return parseKanbanBoard(body, resolveKanbanSettings([layer], options), fields, false);
}

describe("parseKanbanBoard", () => {
	test("reads checkbox characters, plain items and ordered lists as cards", () => {
		const { lanes } = parse("## A\n\n1. [/] Half done\n2. Plain item\n3. [X] Done\n4. [ ]\n");
		expect(lanes[0]?.cards.map((card) => [card.checkChar, card.checked, card.title])).toEqual([
			["/", true, "Half done"],
			[" ", false, "Plain item"],
			["X", true, "Done"],
			[" ", false, ""],
		]);
	});

	test("only the first list after a heading holds cards; other blocks are skipped", () => {
		const { lanes } = parse(
			"## A\n\nSome intro.\n\n```\ncode\n```\n\n- one\n\nBetween.\n\n- not a card\n\n## B\n",
		);
		expect(lanes.map((lane) => lane.cards.map((card) => card.title))).toEqual([["one"], []]);
	});

	test("the settings block ends a lane's search for its list", () => {
		const { lanes } = parse("## A\n\n%% kanban:settings\n```\n{}\n```\n%%\n\n- stray\n");
		expect(lanes[0]?.cards).toEqual([]);
	});

	test("a `## Archive` heading is the archive only after `***`", () => {
		expect(parse("## Archive\n\n- not archived\n").lanes.map((lane) => lane.title)).toEqual([
			"Archive",
		]);
		const board = parse("## A\n\n- a\n\n***\n\n## Archive\n\n- old\n");
		expect(board.lanes.map((lane) => lane.title)).toEqual(["A"]);
		expect(board.archive.map((card) => card.title)).toEqual(["old"]);
	});

	test("a WIP limit is only a trailing `(N)`", () => {
		const { lanes } = parse("## Doing (3)\n\n## (Not) a limit (x)\n\n## Two<br>lines (2)\n");
		expect(lanes.map((lane) => [lane.title, lane.maxItems])).toEqual([
			["Doing", 3],
			["(Not) a limit (x)", 0],
			// Kanban's pattern does not cross a `<br>`: such a title keeps its `(2)`.
			["Two\nlines (2)", 0],
		]);
	});

	test("tags in code, links and escapes are not the card's tags", () => {
		const [card] =
			parse(
				"## A\n\n- [ ] Real #one `#code` [[Note#Heading]] [x](https://a.b/#frag) \\#escaped #two\n",
			).lanes[0]?.cards ?? [];
		expect(card?.tags).toEqual(["#one", "#two"]);
	});

	test("move-tags and move-dates take the tokens out, leaving single spaces", () => {
		const [card] =
			parse("## A\n\n- [ ] Ship #a it @{2024-05-03} now @@{10:00} #b ^block\n", {
				"move-tags": true,
				"move-dates": true,
			}).lanes[0]?.cards ?? [];
		expect(card?.title).toBe("Ship it now");
		expect(card?.raw).toBe("Ship #a it @{2024-05-03} now @@{10:00} #b");
		expect(card?.blockId).toBe("block");
		expect(card?.dateText).toBe("2024-05-03");
		expect(card?.timeText).toBe("10:00");
	});

	test("the last date and the last note link are the card's", () => {
		const [card] =
			parse(
				"## A\n\n- [ ] @{2024-01-01} then @[[2024-02-02]] about [[First]] and [[Second|2nd]] ![[pic.png]]\n",
			).lanes[0]?.cards ?? [];
		expect(card?.dateText).toBe("2024-02-02");
		expect(card?.link?.target).toBe("Second");
	});

	test("continuation lines lose the card's indentation, tabs or spaces", () => {
		const [tabbed, spaced] =
			parse("## A\n\n- [ ] Tabbed\n\tline two\n\t- nested\n- [ ] Spaced\n      line two\n").lanes[0]
				?.cards ?? [];
		expect(tabbed?.title).toBe("Tabbed\nline two\n- nested");
		expect(spaced?.title).toBe("Spaced\n    line two");
	});

	test("task fields count only on the first line; Dataview fields anywhere", () => {
		const [card] =
			parse(
				"## A\n\n- [ ] Ship [due:: 2024-05-05] 📅 2024-05-06\n\tmore [owner:: Bob] [due:: 2024-06-01]\n",
				{ "inline-metadata-position": "footer", "move-task-metadata": true },
				{ dataview: true, tasks: true },
			).lanes[0]?.cards ?? [];
		expect(card?.inlineFields.map((field) => [field.key, field.value])).toEqual([
			["due", "2024-05-05"],
			["due", "2024-05-06"],
			["owner", "Bob"],
		]);
		expect(card?.title).toBe("Ship\nmore [due:: 2024-06-01]");
	});

	test("an undecodable markdown link is kept as written", () => {
		const [card] = parse("## A\n\n- [ ] See [it](Bad%E0%A4%A.md)\n").lanes[0]?.cards ?? [];
		expect(card?.link?.target).toBe("Bad%E0%A4%A");
	});
});

describe("extractSettingsBlock", () => {
	test("reads the last block, with or without an info string", () => {
		expect(extractSettingsBlock("x").settings).toEqual({});
		expect(extractSettingsBlock('%% kanban:settings\n```json\n{"a":1}\n```\n%%').settings).toEqual({
			a: 1,
		});
		expect(
			extractSettingsBlock(
				'%% kanban:settings\n```\n{"a":1}\n```\n%%\n\n%% kanban:settings\n```\n{"a":2}\n```\n%%',
			).settings,
		).toEqual({ a: 2 });
	});
});

describe("resolveKanbanSettings", () => {
	test("skips values of the wrong type and falls through to the next layer", () => {
		const settings = resolveKanbanSettings(
			[
				{ "lane-width": "wide", "date-trigger": "", "show-checkboxes": "yes" },
				{ "lane-width": 300, "show-checkboxes": true },
			],
			options,
		);
		expect(settings.laneWidth).toBe(300);
		expect(settings.dateTrigger).toBe("@");
		expect(settings.showCheckboxes).toBe(true);
	});

	test("defaults match Kanban's", () => {
		const settings = resolveKanbanSettings([], options);
		expect(settings).toMatchObject({
			view: "board",
			dateTrigger: "@",
			timeTrigger: "@@",
			dateFormat: "YYYY-MM-DD",
			timeFormat: "HH:mm",
			dateDisplayFormat: "YYYY-MM-DD",
			dateTimeDisplayFormat: "YYYY-MM-DD HH:mm",
			moveDates: false,
			moveTags: false,
			inlineMetadataPosition: "body",
			maxArchiveSize: -1,
			showCheckboxes: false,
			listCollapse: [],
		});
		expect(settings.laneWidth).toBeUndefined();
	});

	test("metadata keys are the global keys plus the board's, each key once", () => {
		const settings = resolveKanbanSettings(
			[
				{
					"metadata-keys": [
						{ metadataKey: "status", label: "State" },
						{ metadataKey: "board-only" },
						{ label: "no key" },
					],
				},
				optionSettingsLayer({
					metadataKeys: [{ metadataKey: "status" }, { metadataKey: "owner" }],
				}),
			],
			options,
		);
		expect(settings.metadataKeys.map((key) => [key.metadataKey, key.label])).toEqual([
			["status", "status"],
			["owner", "owner"],
			["board-only", "board-only"],
		]);
	});

	test("only Kanban's setting keys in the frontmatter are settings; the view key is one", () => {
		const layer = boardSettingsLayer(
			{ "kanban-plugin": "table", "move-tags": true, title: "x" },
			{ "move-tags": false },
		);
		expect(layer).toEqual({ "kanban-plugin": "table", "move-tags": true });
		expect(resolveKanbanSettings([layer], options).view).toBe("table");
		expect(resolveKanbanSettings([{ "kanban-plugin": "basic" }], options).view).toBe("board");
		expect(resolveKanbanSettings([{ "kanban-plugin": "bogus" }], options).view).toBe("board");
	});

	test("tag colours need a tag key; list-collapse reads booleans", () => {
		const settings = resolveKanbanSettings(
			[
				{
					"tag-colors": [{ tagKey: "#a", color: "red" }, { color: "blue" }],
					"list-collapse": [true, 1, false],
				},
			],
			options,
		);
		expect(settings.tagColors).toEqual([{ tagKey: "#a", color: "red" }]);
		expect(settings.listCollapse).toEqual([true, false, false]);
	});
});
