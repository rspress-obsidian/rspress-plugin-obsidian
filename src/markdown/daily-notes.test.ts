import { describe, expect, test } from "bun:test";
import { formatMomentDate } from "../shared/moment-format.ts";
import {
	applyDailyNoteTemplate,
	expandDailyTemplateText,
	expandDailyTemplateTokens,
	generateDailyNoteCalendar,
	isEmptyDailyNoteBody,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.ts";
import type { ContentIndex, ContentPage } from "./types.ts";

/** `YYYY-MM-DD` of a local date. */
const ymd = (date: Date | undefined) => (date ? formatMomentDate(date, "YYYY-MM-DD") : undefined);

describe("parseDailyNoteDate", () => {
	test("parses the default format to a local date", () => {
		const date = parseDailyNoteDate("2026-08-20.md", normalizeDailyNoteConfig());
		expect(date).toEqual(new Date(2026, 7, 20));
	});

	test("parses weekday and month-name formats and honours the folder", () => {
		expect(
			ymd(
				parseDailyNoteDate(
					"Thursday, August 20, 2026.md",
					normalizeDailyNoteConfig({ dateFormat: "dddd, MMMM D, YYYY" }),
				),
			),
		).toBe("2026-08-20");
		const config = normalizeDailyNoteConfig({ folder: "daily", dateFormat: "ddd YYYY-MM-DD" });
		expect(ymd(parseDailyNoteDate("daily/Thu 2026-08-20.md", config))).toBe("2026-08-20");
		expect(parseDailyNoteDate("notes/Thu 2026-08-20.md", config)).toBeUndefined();
	});

	test("is strict: the date must exist and format back to the same name", () => {
		const config = normalizeDailyNoteConfig({ dateFormat: "YYYY-MM-DD" });
		expect(parseDailyNoteDate("2026-08.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2026-13-01.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2026-02-30.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2024-5-3.md", normalizeDailyNoteConfig())).toBeUndefined();
	});
});

describe("template tokens", () => {
	const date = new Date(2026, 7, 20);
	const now = new Date(2030, 0, 1, 9, 41, 7);

	test("{{date}} and {{date:FORMAT}} render the note's date", () => {
		expect(expandDailyTemplateText("{{date}}", date, "YYYY-MM-DD", now)).toBe("2026-08-20");
		expect(expandDailyTemplateText("{{ date:MMMM Do, YYYY }}", date, "YYYY-MM-DD", now)).toBe(
			"August 20th, 2026",
		);
		expect(expandDailyTemplateText("{{date}}", date, "DD.MM.YYYY", now)).toBe("20.08.2026");
	});

	test("{{time}} reads the build clock; {{time:FORMAT}} and {{date:HH:mm}} too", () => {
		expect(expandDailyTemplateText("{{time}}", date, "YYYY-MM-DD", now)).toBe("09:41");
		expect(expandDailyTemplateText("{{time:HH:mm:ss}}", date, "YYYY-MM-DD", now)).toBe("09:41:07");
		expect(expandDailyTemplateText("{{date:YYYY-MM-DD HH:mm}}", date, "YYYY-MM-DD", now)).toBe(
			"2026-08-20 09:41",
		);
	});

	test("offsets use Moment's units: M is months, m minutes", () => {
		expect(expandDailyTemplateText("{{date+3d}}", date, "YYYY-MM-DD", now)).toBe("2026-08-23");
		expect(expandDailyTemplateText("{{date-2w}}", date, "YYYY-MM-DD", now)).toBe("2026-08-06");
		expect(expandDailyTemplateText("{{date+1M}}", new Date(2026, 11, 15), "YYYY-MM-DD", now)).toBe(
			"2027-01-15",
		);
		expect(expandDailyTemplateText("{{date+1M}}", new Date(2026, 0, 31), "YYYY-MM-DD", now)).toBe(
			"2026-02-28",
		);
		expect(expandDailyTemplateText("{{time+20m:HH:mm}}", date, "YYYY-MM-DD", now)).toBe("10:01");
		expect(expandDailyTemplateText("{{date-1y}}", new Date(2026, 1, 28), "YYYY-MM-DD", now)).toBe(
			"2025-02-28",
		);
	});

	test("{{title}}, {{yesterday}} and {{tomorrow}}", () => {
		expect(
			expandDailyTemplateTokens(
				"{{title}} {{yesterday}} {{tomorrow}} {{date}}",
				date,
				"2026-08-20",
				{
					now,
				},
			),
		).toBe("2026-08-20 2026-08-19 2026-08-21 2026-08-20");
	});

	test("a template fills only an empty note", () => {
		const template = "# {{title}}\n\nPlanned for {{date:dddd}} at {{time}}.";
		expect(applyDailyNoteTemplate("  \n", template, date, "2026-08-20", { now })).toBe(
			"# 2026-08-20\n\nPlanned for Thursday at 09:41.",
		);
		expect(applyDailyNoteTemplate("My own note", template, date, "2026-08-20", { now })).toBe(
			"My own note",
		);
		expect(applyDailyNoteTemplate("", "   ", date, "2026-08-20", { now })).toBe("");
		expect(isEmptyDailyNoteBody("\n\n  ")).toBe(true);
		expect(isEmptyDailyNoteBody("x")).toBe(false);
	});

	test("offset units follow Moment's aliases, case included", () => {
		const expand = (token: string, on = date) =>
			expandDailyTemplateText(token, on, "YYYY-MM-DD", now);
		expect(expand("{{date+1Q}}")).toBe("2026-11-20");
		expect(expand("{{date+1Q}}", new Date(2026, 10, 30))).toBe("2027-02-28");
		expect(expand("{{date+1Y}}", new Date(2028, 1, 29))).toBe("2029-02-28");
		expect(expand("{{date+1W}}")).toBe("2026-08-27");
		expect(expand("{{date-1d}}")).toBe("2026-08-19");
		expect(expand("{{time+2h:HH:mm}}")).toBe("11:41");
		expect(expand("{{date+3H:HH}}")).toBe("12");
		expect(expand("{{time+30s:HH:mm:ss}}")).toBe("09:41:37");
		expect(expand("{{time+30S:ss}}")).toBe("37");
		// Moment knows no `q` unit and treats `D` as the date field, which a
		// duration ignores: `moment().add(1, "q")` and `add(2, "D")` change nothing.
		expect(expand("{{date+1q}}")).toBe("2026-08-20");
		expect(expand("{{date+2D}}")).toBe("2026-08-20");
		// With an offset but no format, the daily-note format applies — even to `time`.
		expect(expand("{{time+1d}}")).toBe("2026-08-21");
	});
});

describe("normalizeDailyNoteConfig", () => {
	test("normalizes the calendar route and template path", () => {
		expect(normalizeDailyNoteConfig({ calendar: "daily" }).calendar).toBe("/daily");
		expect(normalizeDailyNoteConfig({ calendar: "/daily/" }).calendar).toBe("/daily");
		expect(normalizeDailyNoteConfig().calendar).toBe("");
		expect(normalizeDailyNoteConfig({ template: "/templates/Daily/" }).template).toBe(
			"templates/Daily",
		);
	});
});

function dailyPage(relativePath: string): ContentPage {
	const filePathKey = relativePath.replace(/\.md$/, "");
	return {
		absolutePath: `/vault/${relativePath}`,
		relativePath,
		routePath: `/${filePathKey}`,
		pathKey: filePathKey,
		filePathKey,
		baseName: filePathKey.split("/").pop() ?? filePathKey,
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

describe("renderDailyNavigation", () => {
	const config = normalizeDailyNoteConfig({ folder: "Daily" });

	test("links each note to its neighbours in date order", () => {
		const pages = ["2026-08-22", "2026-08-20", "2026-08-21"].map((day) =>
			dailyPage(`Daily/${day}.md`),
		);
		const middle = pages[2];
		if (!middle) throw new Error("missing page");
		const html = renderDailyNavigation(middle, pages, config);
		expect(html).toContain(
			'<span class="daily-notes-previous"><a href="/Daily/2026-08-20">2026-08-20</a>',
		);
		expect(html).toContain(
			'<span class="daily-notes-next"><a href="/Daily/2026-08-22">2026-08-22</a>',
		);
		expect(html).toContain('<span class="daily-notes-current">2026-08-21</span>');
	});

	test("keeps separate ladders for configs that differ only by folder", () => {
		const pages = [dailyPage("Daily/2026-08-20.md"), dailyPage("Other/2026-08-21.md")];
		const first = pages[0];
		const second = pages[1];
		if (!first || !second) throw new Error("missing page");
		expect(renderDailyNavigation(first, pages, config)).toContain("daily-notes-current");
		expect(
			renderDailyNavigation(second, pages, normalizeDailyNoteConfig({ folder: "Other" })),
		).toContain('<span class="daily-notes-current">2026-08-21</span>');
	});

	// Every note asks for the same sorted list of dated notes, so building it
	// per note made a daily-notes vault quadratic: 3.6s at 2000 notes. The list
	// and its position index are memoized on the `pages` array, so a note must
	// not re-parse its neighbours on each call.
	test("reuses one sorted ladder across notes rather than rebuilding it per note", () => {
		const PAGES = 400;
		const CALLS = 4;
		const pages = Array.from({ length: PAGES }, (_, day) =>
			dailyPage(`Daily/${formatMomentDate(new Date(2020, 0, 1 + day), "YYYY-MM-DD")}.md`),
		);
		let reads = 0;
		for (const page of pages) {
			const relativePath = page.relativePath;
			Object.defineProperty(page, "relativePath", {
				get() {
					reads += 1;
					return relativePath;
				},
				configurable: true,
			});
		}
		const tenth = pages[10];
		if (!tenth) throw new Error("missing page");
		renderDailyNavigation(tenth, pages, config);
		const afterFirst = reads;
		expect(afterFirst).toBeGreaterThanOrEqual(PAGES);
		for (const page of pages.slice(0, CALLS)) renderDailyNavigation(page, pages, config);
		// A handful of reads per call, not a full ladder rebuild.
		expect(reads - afterFirst).toBeLessThan(CALLS * 10);
	});

	test("the first and last notes get a placeholder; gaps link the nearest note", () => {
		const pages = ["2026-08-01", "2026-08-15", "2026-09-30"].map((day) =>
			dailyPage(`Daily/${day}.md`),
		);
		const [first, middle, last] = pages;
		if (!first || !middle || !last) throw new Error("missing page");
		const placeholder = '<span class="daily-notes-placeholder"></span>';
		expect(renderDailyNavigation(first, pages, config)).toContain(
			`<span class="daily-notes-previous">${placeholder}</span>`,
		);
		expect(renderDailyNavigation(last, pages, config)).toContain(
			`<span class="daily-notes-next">${placeholder}</span>`,
		);
		const html = renderDailyNavigation(middle, pages, config);
		expect(html).toContain('<a href="/Daily/2026-08-01">2026-08-01</a>');
		expect(html).toContain('<a href="/Daily/2026-09-30">2026-09-30</a>');
	});

	test("renders nothing for a non-daily note or with navigation off", () => {
		const pages = [dailyPage("Daily/2026-08-20.md"), dailyPage("Daily/Ideas.md")];
		const [daily, ideas] = pages;
		if (!daily || !ideas) throw new Error("missing page");
		expect(renderDailyNavigation(ideas, pages, config)).toBe("");
		expect(
			renderDailyNavigation(
				daily,
				pages,
				normalizeDailyNoteConfig({ folder: "Daily", navigation: false }),
			),
		).toBe("");
	});

	test("labels links with the configured format", () => {
		const format = normalizeDailyNoteConfig({ dateFormat: "ddd, MMM Do" });
		const pages = ["Thu, Aug 20th.md", "Fri, Aug 21st.md"].map(dailyPage);
		const [thursday] = pages;
		if (!thursday) throw new Error("missing page");
		const html = renderDailyNavigation(thursday, pages, format);
		expect(html).toContain('<span class="daily-notes-current">Thu, Aug 20th</span>');
		expect(html).toContain(">Fri, Aug 21st</a>");
	});
});

describe("generateDailyNoteCalendar", () => {
	test("lists dated notes by month, newest first", () => {
		const pages = ["daily/2026-07-31.md", "daily/2026-08-02.md", "daily/notes.md"].map(dailyPage);
		const index = { pages } as unknown as ContentIndex;
		const [page] = generateDailyNoteCalendar(
			index,
			normalizeDailyNoteConfig({ folder: "daily", calendar: "/daily" }),
		);
		expect(page?.routePath).toBe("/daily");
		const content = page?.content ?? "";
		expect(content).toContain("2 daily notes, newest first.");
		expect(content.indexOf("## August 2026")).toBeLessThan(content.indexOf("## July 2026"));
		expect(content).toContain("- [Sunday](/daily/2026-08-02)");
	});

	test("generates nothing without a route or without dated notes", () => {
		const index = { pages: [dailyPage("daily/notes.md")] } as unknown as ContentIndex;
		expect(generateDailyNoteCalendar(index, normalizeDailyNoteConfig({ folder: "daily" }))).toEqual(
			[],
		);
		expect(
			generateDailyNoteCalendar(
				index,
				normalizeDailyNoteConfig({ folder: "daily", calendar: "c" }),
			),
		).toEqual([]);
	});

	test("shows a custom title next to the weekday and escapes the link", () => {
		const page = dailyPage("Thursday, August 20, 2026.md");
		page.title = "Launch [v2]";
		const index = { pages: [page] } as unknown as ContentIndex;
		const [calendar] = generateDailyNoteCalendar(
			index,
			normalizeDailyNoteConfig({ dateFormat: "dddd, MMMM D, YYYY", calendar: "/calendar" }),
		);
		const content = calendar?.content ?? "";
		expect(content).toContain("1 daily note, newest first.");
		expect(content).toContain("## August 2026");
		const item = content.split("\n").find((line) => line.startsWith("- "));
		expect(item).toMatch(/^- \[Thursday — Launch \\\[v2\\\]\]\(\S+\)$/);
		expect(item).toContain("August%2020");
	});
});

describe("template offsets across a DST change", () => {
	test("hours are moment's exact hours, days keep the wall clock (America/New_York)", () => {
		const previous = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			// Clocks jump from 02:00 to 03:00 on 10 March 2024.
			const date = new Date(2024, 2, 9);
			const now = new Date(2024, 2, 9, 12);
			const expand = (token: string) => expandDailyTemplateText(token, date, "YYYY-MM-DD", now);
			expect(expand("{{time+24h:YYYY-MM-DD HH:mm}}")).toBe("2024-03-10 13:00");
			expect(expand("{{time+1d:YYYY-MM-DD HH:mm}}")).toBe("2024-03-10 12:00");
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	});
});
