import { describe, expect, test } from "bun:test";
import {
	applyDailyNoteTemplate,
	expandDailyTemplateText,
	expandDailyTemplateTokens,
	formatDailyNoteDate,
	isEmptyDailyNoteBody,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.ts";
import type { ContentPage } from "./types.ts";

/** Every weekday token must consume exactly one capture group, or the date
 *  tokens after it read the wrong value and the whole parse silently fails. */
describe("parseDailyNoteDate", () => {
	test("parses the default YYYY-MM-DD format", () => {
		const date = parseDailyNoteDate("2026-08-20.md", normalizeDailyNoteConfig());
		expect(date?.toISOString().slice(0, 10)).toBe("2026-08-20");
	});

	test("parses a format whose weekday token precedes the date tokens", () => {
		const config = normalizeDailyNoteConfig({ dateFormat: "dddd, MMMM D, YYYY" });
		const date = parseDailyNoteDate("Thursday, August 20, 2026.md", config);
		expect(date?.toISOString().slice(0, 10)).toBe("2026-08-20");
	});

	test("parses a short weekday token and honours the configured folder", () => {
		const config = normalizeDailyNoteConfig({ folder: "daily", dateFormat: "ddd YYYY-MM-DD" });
		expect(parseDailyNoteDate("daily/Thu 2026-08-20.md", config)?.toISOString().slice(0, 10)).toBe(
			"2026-08-20",
		);
		expect(parseDailyNoteDate("notes/Thu 2026-08-20.md", config)).toBeUndefined();
	});

	test("round-trips a formatted weekday filename", () => {
		const config = normalizeDailyNoteConfig({ dateFormat: "dddd, MMMM D, YYYY" });
		const date = new Date(Date.UTC(2026, 7, 20));
		const filename = `${formatDailyNoteDate(date, config.dateFormat)}.md`;
		expect(parseDailyNoteDate(filename, config)?.getTime()).toBe(date.getTime());
	});

	test("rejects filenames that do not match the format", () => {
		const config = normalizeDailyNoteConfig({ dateFormat: "YYYY-MM-DD" });
		expect(parseDailyNoteDate("2026-08.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2026-13-01.md", config)).toBeUndefined();
	});
});

describe("expandDailyTemplateText", () => {
	const date = new Date(Date.UTC(2026, 7, 20));

	test("renders the date with the default format", () => {
		expect(expandDailyTemplateText("{{date}}", date)).toBe("2026-08-20");
		expect(expandDailyTemplateText("{{date:MMMM D, YYYY}}", date)).toBe("August 20, 2026");
	});

	test("offsets days and weeks", () => {
		expect(expandDailyTemplateText("{{date+3d}}", date)).toBe("2026-08-23");
		expect(expandDailyTemplateText("{{date-2w}}", date)).toBe("2026-08-06");
	});

	test("rolls a month offset over the year boundary", () => {
		expect(expandDailyTemplateText("{{date+1m}}", new Date(Date.UTC(2026, 11, 15)))).toBe(
			"2027-01-15",
		);
		expect(expandDailyTemplateText("{{date-1m}}", new Date(Date.UTC(2026, 0, 15)))).toBe(
			"2025-12-15",
		);
	});

	test("rolls a day offset over the month boundary", () => {
		expect(expandDailyTemplateText("{{date+3d}}", new Date(Date.UTC(2026, 0, 30)))).toBe(
			"2026-02-02",
		);
	});

	test("offsets years", () => {
		expect(expandDailyTemplateText("{{date-1y}}", new Date(Date.UTC(2026, 1, 28)))).toBe(
			"2025-02-28",
		);
	});
});

describe("normalizeDailyNoteConfig", () => {
	test("normalizes the calendar route to a leading slash and no trailing one", () => {
		expect(normalizeDailyNoteConfig({ calendar: "daily" }).calendar).toBe("/daily");
		expect(normalizeDailyNoteConfig({ calendar: "/daily/" }).calendar).toBe("/daily");
		expect(normalizeDailyNoteConfig().calendar).toBe("");
	});

	test("strips surrounding slashes from the template path", () => {
		expect(normalizeDailyNoteConfig({ template: "/templates/Daily/" }).template).toBe(
			"templates/Daily",
		);
	});
});

describe("daily note templates", () => {
	const date = new Date(Date.UTC(2026, 7, 20));
	const template = "# {{title}}\n\nPlanned for {{date:dddd}}.\n{{time}}";

	test("fills an empty body from the template", () => {
		expect(applyDailyNoteTemplate("  \n", template, date, "2026-08-20")).toBe(
			"# 2026-08-20\n\nPlanned for Thursday.\n00:00",
		);
	});

	test("leaves a note the author started untouched", () => {
		expect(applyDailyNoteTemplate("My own note", template, date, "2026-08-20")).toBe("My own note");
	});

	test("an empty template changes nothing", () => {
		expect(applyDailyNoteTemplate("", "   ", date, "2026-08-20")).toBe("");
	});

	test("isEmptyDailyNoteBody treats whitespace as empty", () => {
		expect(isEmptyDailyNoteBody("")).toBe(true);
		expect(isEmptyDailyNoteBody("\n\n  ")).toBe(true);
		expect(isEmptyDailyNoteBody("x")).toBe(false);
	});

	test("expands title and time alongside the date tokens", () => {
		expect(expandDailyTemplateTokens("{{title}} at {{time}}", date, "Note")).toBe("Note at 00:00");
	});
});

describe("renderDailyNavigation", () => {
	const config = normalizeDailyNoteConfig({ folder: "Daily" });

	function dailyPage(day: string): ContentPage {
		const filePathKey = `Daily/${day}`;
		return {
			absolutePath: `/vault/${filePathKey}.md`,
			relativePath: `${filePathKey}.md`,
			routePath: `/${filePathKey}`,
			pathKey: filePathKey,
			filePathKey,
			baseName: day,
			title: undefined,
			aliases: [],
			tags: [],
			cssclasses: [],
			publish: true,
			fileCtimeMs: 0,
			fileMtimeMs: 0,
			fileSizeBytes: 10,
			headings: [],
			wikilinkTargets: [],
			headingBySlug: new Map(),
			headingByText: new Map(),
			blocks: [],
			dataviewFields: {},
			dataviewTasks: [],
			dataviewLists: [],
		};
	}

	test("links each note to its neighbours in date order", () => {
		const pages = [dailyPage("2026-08-20"), dailyPage("2026-08-21"), dailyPage("2026-08-22")];
		const middle = pages[1] as ContentPage;

		const html = renderDailyNavigation(middle, pages, config);

		expect(html).toContain('href="/Daily/2026-08-20"');
		expect(html).toContain('href="/Daily/2026-08-22"');
		expect(html).toContain("2026-08-21");
	});

	// Every note asks for the same sorted list of dated notes, so building it
	// per note made a daily-notes vault quadratic: 3.6s at 2000 notes. The list
	// and its position index are memoized on the `pages` array now, so a note
	// must not re-parse its neighbours on each call.
	test("reuses one sorted ladder across notes rather than rebuilding it per note", () => {
		// Many notes, few calls: with the ladder rebuilt per call, rendering
		// navigation for CALLS of these notes reads PAGES paths per call. With
		// it memoized, the neighbour paths are read once for the whole ladder
		// and a call only re-reads its own note — so the counts separate by a
		// factor of PAGES/CALLS. Before: 3578ms at 2000 notes.
		const PAGES = 400;
		const CALLS = 4;
		const pages = Array.from({ length: PAGES }, (_, day) =>
			dailyPage(new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10)),
		);

		let reads = 0;
		for (const page of pages) {
			const path = page.relativePath;
			Object.defineProperty(page, "relativePath", {
				get() {
					reads += 1;
					return path;
				},
				configurable: true,
			});
		}

		renderDailyNavigation(pages[10] as ContentPage, pages, config);
		const afterFirst = reads;
		expect(afterFirst).toBeGreaterThanOrEqual(PAGES);

		for (const page of pages.slice(0, CALLS)) {
			renderDailyNavigation(page, pages, config);
		}

		// A handful of reads per call, not a full ladder rebuild: the bound is
		// deliberately far below CALLS * PAGES so it cannot pass by accident.
		expect(reads - afterFirst).toBeLessThan(CALLS * 10);
	});
});
