import { describe, expect, test } from "bun:test";
import {
	applyDailyNoteTemplate,
	expandDailyTemplateText,
	expandDailyTemplateTokens,
	formatDailyNoteDate,
	generateDailyNoteCalendar,
	isEmptyDailyNoteBody,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	parseMomentDate,
	renderDailyNavigation,
} from "./daily-notes.ts";
import type { ContentIndex, ContentPage } from "./types.ts";

/** `YYYY-MM-DD` of a local date. */
const ymd = (date: Date | undefined) =>
	date ? formatDailyNoteDate(date, "YYYY-MM-DD") : undefined;

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

	test("reads Moment tokens: Do, ww, W, gggg, HH, mm, A and [literals]", () => {
		const cases: Array<[string, string]> = [
			["August 20th, 2026", "MMMM Do, YYYY"],
			["2026-08-20 [Week] 34", "YYYY-MM-DD [[Week]] ww"],
			["2026-08-20 Week 34", "YYYY-MM-DD [Week] ww"],
			["2026-W34-4", "GGGG-[W]WW-E"],
			["2026 week 34 Thu", "gggg [week] w ddd"],
			["2026-08-20 0930", "YYYY-MM-DD HHmm"],
			["20/08/2026 9 AM", "DD/MM/YYYY h A"],
		];
		for (const [name, format] of cases) {
			expect([name, ymd(parseMomentDate(name, format))]).toEqual([name, "2026-08-20"]);
		}
		expect(parseMomentDate("2026-08-20 0930", "YYYY-MM-DD HHmm")?.getHours()).toBe(9);
		expect(parseMomentDate("2026-08-20 0930", "YYYY-MM-DD HHmm")?.getMinutes()).toBe(30);
	});

	test("is strict: the date must exist and format back to the same name", () => {
		const config = normalizeDailyNoteConfig({ dateFormat: "YYYY-MM-DD" });
		expect(parseDailyNoteDate("2026-08.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2026-13-01.md", config)).toBeUndefined();
		expect(parseDailyNoteDate("2026-02-30.md", config)).toBeUndefined();
		expect(parseMomentDate("Friday 2026-08-20", "dddd YYYY-MM-DD")).toBeUndefined();
		expect(parseMomentDate("2026-08-20 Week 35", "YYYY-MM-DD [Week] ww")).toBeUndefined();
	});

	test("round-trips every supported token", () => {
		const date = new Date(2026, 7, 20, 14, 5, 9);
		const format =
			"YYYY YY Q Qo M MM MMM MMMM Mo D DD Do DDD DDDD d dd ddd dddd E e w ww gggg W WW GGGG H HH h hh k m mm s ss A a [lit]";
		expect(formatDailyNoteDate(date, format)).toBe(
			"2026 26 3 3rd 8 08 Aug August 8th 20 20 20th 232 232 4 Th Thu Thursday 4 4 34 34 2026 34 34 2026 14 14 2 02 14 5 05 9 09 PM pm lit",
		);
	});

	test("formats the remaining Moment tokens", () => {
		const date = new Date(2026, 7, 20, 14, 5, 9, 456);
		expect(formatDailyNoteDate(date, "YYYYYY Y DDDo do wo gg Wo GG kk S SS SSS")).toBe(
			"+002026 2026 232nd 4th 34th 26 34th 26 14 4 45 456",
		);
		expect(formatDailyNoteDate(new Date(2026, 7, 20, 0, 30), "k:mm kk h hh A")).toBe(
			"24:30 24 12 12 AM",
		);
		const ancient = new Date(2026, 0, 1);
		ancient.setFullYear(26);
		expect(formatDailyNoteDate(ancient, "Y YYYY")).toBe("0026 0026");
		expect(formatDailyNoteDate(new Date(12345, 0, 1), "Y")).toBe("+12345");
		// 11th–13th take "th", not "st"/"nd"/"rd".
		expect(
			[1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map((day) =>
				formatDailyNoteDate(new Date(2026, 0, day), "Do"),
			),
		).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
	});

	test("formats epoch and offset tokens", () => {
		const instant = new Date(Date.UTC(2026, 7, 20, 12, 0, 0, 0));
		expect(formatDailyNoteDate(instant, "X")).toBe("1787227200");
		expect(formatDailyNoteDate(instant, "x")).toBe("1787227200000");
		const z = formatDailyNoteDate(instant, "Z");
		expect(z).toMatch(/^[+-]\d{2}:\d{2}$/);
		expect(formatDailyNoteDate(instant, "ZZ")).toBe(z.replace(":", ""));
		// A note named with the local offset parses back to the same instant.
		expect(
			parseMomentDate(formatDailyNoteDate(instant, "YYYY-MM-DD HH:mm Z"), "YYYY-MM-DD HH:mm Z"),
		).toEqual(instant);
	});

	test("week-years differ from calendar years at the year boundary", () => {
		// 2027-01-01 is a Friday: locale week 1 of 2027, ISO week 53 of 2026.
		const date = new Date(2027, 0, 1);
		expect(formatDailyNoteDate(date, "gggg-[w]ww GGGG-[W]WW")).toBe("2027-w01 2026-W53");
		expect(ymd(parseMomentDate("2026-W53-5", "GGGG-[W]WW-E"))).toBe("2027-01-01");
		expect(ymd(parseMomentDate("2027 w01 Fri", "gggg [w]ww ddd"))).toBe("2027-01-01");
	});

	test("parses year, quarter, month and day-of-year tokens", () => {
		const cases: Array<[string, string, string]> = [
			["+002026-08-20", "YYYYYY-MM-DD", "2026-08-20"],
			["2026-08-20", "Y-MM-DD", "2026-08-20"],
			["26-08-20", "YY-MM-DD", "2026-08-20"],
			// Moment's two-digit-year pivot: 69–99 are the 1900s.
			["69-08-20", "YY-MM-DD", "1969-08-20"],
			["68-08-20", "YY-MM-DD", "2068-08-20"],
			["2026-Q3", "YYYY-[Q]Q", "2026-07-01"],
			["3rd quarter 2026", "Qo [quarter] YYYY", "2026-07-01"],
			["8th month 2026", "Mo [month] YYYY", "2026-08-01"],
			["Aug 20 2026", "MMM D YYYY", "2026-08-20"],
			["20 august 2026", "D MMMM YYYY", "2026-08-20"],
			["2026-232", "YYYY-DDDD", "2026-08-20"],
			["2026 232", "YYYY DDD", "2026-08-20"],
			["232nd day of 2026", "DDDo [day of] YYYY", "2026-08-20"],
			["2026", "YYYY", "2026-01-01"],
		];
		for (const [name, format, expected] of cases) {
			expect([name, ymd(parseMomentDate(name, format))]).toEqual([name, expected]);
		}
		// Day 366 of a common year does not exist.
		expect(parseMomentDate("2026-366", "YYYY-DDDD")).toBeUndefined();
	});

	test("parses week tokens with Moment's week defaults", () => {
		const cases: Array<[string, string, string]> = [
			// ISO weeks start on Monday; with no weekday, Moment takes Monday.
			["26-W34", "GG-[W]WW", "2026-08-17"],
			["2026-W34 Mon", "GGGG-[W]WW ddd", "2026-08-17"],
			["2026 34th ISO week", "GGGG Wo [ISO week]", "2026-08-17"],
			// Locale (en) weeks start on Sunday.
			["26 w34 Th", "gg [w]ww dd", "2026-08-20"],
			["2026 w34 4th", "gggg [w]w do", "2026-08-20"],
			["2026 w34 4", "gggg [w]w e", "2026-08-20"],
			["34th week 2026", "wo [week] gggg", "2026-08-16"],
		];
		for (const [name, format, expected] of cases) {
			expect([name, ymd(parseMomentDate(name, format))]).toEqual([name, expected]);
		}
		// An ISO week's weekday is E; a `ddd` that is not that day is not this note.
		expect(parseMomentDate("2026-W34 Thu", "GGGG-[W]WW ddd")).toBeUndefined();
	});

	test("missing leading date parts come from today, the rest are their first", () => {
		const today = new Date();
		const year = today.getFullYear();
		expect(ymd(parseMomentDate("08-20", "MM-DD"))).toBe(`${year}-08-20`);
		expect(ymd(parseMomentDate("08", "MM"))).toBe(`${year}-08-01`);
		expect(ymd(parseMomentDate("15", "DD"))).toBe(
			formatDailyNoteDate(new Date(year, today.getMonth(), 15), "YYYY-MM-DD"),
		);
		const timeOnly = parseMomentDate("09:30", "HH:mm");
		expect(ymd(timeOnly)).toBe(ymd(today));
		expect(timeOnly?.getHours()).toBe(9);
		// A weekday alone is that day of the current week.
		const weekday = formatDailyNoteDate(today, "dddd");
		expect(ymd(parseMomentDate(weekday, "dddd"))).toBe(ymd(today));
	});

	test("parses time tokens: 12-hour clock, 24 as midnight, fractions", () => {
		const at = (name: string, format: string) => {
			const date = parseMomentDate(name, format);
			return date && formatDailyNoteDate(date, "YYYY-MM-DD HH:mm:ss.SSS");
		};
		expect(at("2026-08-20 12 am", "YYYY-MM-DD hh a")).toBe("2026-08-20 00:00:00.000");
		expect(at("2026-08-20 12 PM", "YYYY-MM-DD h A")).toBe("2026-08-20 12:00:00.000");
		expect(at("2026-08-20 24", "YYYY-MM-DD kk")).toBe("2026-08-20 00:00:00.000");
		expect(at("2026-08-20 7", "YYYY-MM-DD k")).toBe("2026-08-20 07:00:00.000");
		expect(at("2026-08-20 14:05:09.456", "YYYY-MM-DD HH:mm:ss.SSS")).toBe(
			"2026-08-20 14:05:09.456",
		);
		expect(at("2026-08-20 14:5:9.45", "YYYY-MM-DD H:m:s.SS")).toBe("2026-08-20 14:05:09.450");
		expect(at("2026-08-20 14:05:09.4", "YYYY-MM-DD HH:mm:ss.S")).toBe("2026-08-20 14:05:09.400");
	});

	test("parses epoch and offset names to the instant they name", () => {
		const instant = new Date(Date.UTC(2026, 7, 20, 4, 0, 0));
		expect(parseMomentDate("1787227200", "X")).toEqual(new Date(Date.UTC(2026, 7, 20, 12)));
		expect(parseMomentDate("1787227200000", "x")).toEqual(new Date(Date.UTC(2026, 7, 20, 12)));
		const format = "YYYY-MM-DD[T]HH:mm:ssZ";
		expect(parseMomentDate("2026-08-20T09:00:00+05:00", format)).toEqual(instant);
		expect(parseMomentDate("2026-08-20T09:00:00+0500", "YYYY-MM-DD[T]HH:mm:ssZZ")).toEqual(instant);
		expect(parseMomentDate("2026-08-19T23:00:00-05", format)).toEqual(instant);
		expect(parseMomentDate("2026-08-20T04:00:00Z", format)).toEqual(instant);
		// Moment's bounds: minutes ≤ 59, offsets within -12:00…+14:00.
		expect(parseMomentDate("2026-08-20T09:00:00+05:60", format)).toBeUndefined();
		expect(parseMomentDate("2026-08-20T09:00:00+15:00", format)).toBeUndefined();
		expect(parseMomentDate("2026-08-20T09:00:00-13:00", format)).toBeUndefined();
	});
});

describe("parseMomentDate, forgiving (moment(text, format) without strict mode)", () => {
	const now = new Date(2030, 0, 1, 12);
	const read = (text: string, format: string) =>
		parseMomentDate(text, format, { strict: false, now });
	const stamp = (date: Date | undefined) =>
		date ? formatDailyNoteDate(date, "YYYY-MM-DD HH:mm:ss.SSS") : undefined;

	test("takes one-digit values, any separator, and skips text around the date", () => {
		for (const text of ["5/3/2024", "05-03-2024", "5.3.2024", "5/3/24", "due 5/3/2024 or so"]) {
			expect([text, ymd(read(text, "MM/DD/YYYY"))]).toEqual([text, "2024-05-03"]);
		}
		expect(ymd(read("2024/5/3", "YYYY-MM-DD"))).toBe("2024-05-03");
		expect(ymd(read("2024-05-03T10:00", "YYYY-MM-DD"))).toBe("2024-05-03");
		expect(ymd(read("3.5.24", "DD.MM.YYYY"))).toBe("2024-05-03");
		// Moment's `YYYY` takes 1–4 digits: `5-3-2024` is 20 March of the year 5.
		expect(read("5-3-2024", "YYYY-MM-DD")?.getFullYear()).toBe(5);
	});

	test("month and weekday names match by their start; a missing year is the clock's", () => {
		expect(ymd(read("3 may", "D MMMM"))).toBe("2030-05-03");
		expect(ymd(read("3 Sept", "D MMMM"))).toBe("2030-09-03");
		expect(ymd(read("May 3 2024", "MMM D, YYYY"))).toBe("2024-05-03");
		expect(ymd(read("Fri 3 May 2024", "dddd D MMM YYYY"))).toBe("2024-05-03");
		expect(ymd(read("3rd May 2024", "Do MMM YYYY"))).toBe("2024-05-03");
	});

	test("refuses what moment refuses: no such day, month or hour, a wrong weekday, no date at all", () => {
		expect(read("13/3/2024", "MM/DD/YYYY")).toBeUndefined();
		expect(read("2/30/2024", "MM/DD/YYYY")).toBeUndefined();
		expect(read("3 foo", "D MMMM")).toBeUndefined();
		expect(read("Monday 3 May 2024", "dddd D MMM YYYY")).toBeUndefined();
		expect(read("soon", "YYYY-MM-DD")).toBeUndefined();
		expect(read("pm", "h A")).toBeUndefined();
		expect(read("24:30", "HH:mm")).toBeUndefined();
		expect(read("25:00", "kk:mm")).toBeUndefined();
		expect(read("10:60", "HH:mm")).toBeUndefined();
		expect(read("2023-366", "YYYY-DDDD")).toBeUndefined();
		expect(read("2024 W60", "GGGG [W]WW")).toBeUndefined();
		expect(read("2024 w60", "gggg [w]ww")).toBeUndefined();
		expect(read("2024 W5 9", "GGGG [W]WW E")).toBeUndefined();
	});

	test("times: a meridiem, one-digit minutes, 24:00 as the next midnight, fractions of a second", () => {
		expect(stamp(read("2:30 pm", "h:mm A"))).toBe("2030-01-01 14:30:00.000");
		expect(stamp(read("12:30 am", "h:mm a"))).toBe("2030-01-01 00:30:00.000");
		expect(stamp(read("9:5", "HH:mm"))).toBe("2030-01-01 09:05:00.000");
		expect(stamp(read("24:00", "HH:mm"))).toBe("2030-01-02 00:00:00.000");
		expect(stamp(read("24:00", "kk:mm"))).toBe("2030-01-01 00:00:00.000");
		expect(stamp(read("10:30:05.5", "HH:mm:ss.SSS"))).toBe("2030-01-01 10:30:05.500");
		expect(stamp(read("10:30:05.05", "HH:mm:ss.SSS"))).toBe("2030-01-01 10:30:05.050");
	});

	test("week and day-of-year dates, epochs and offsets", () => {
		expect(ymd(read("2024-W5", "GGGG-[W]WW"))).toBe("2024-01-29");
		expect(ymd(read("2024-366", "YYYY-DDDD"))).toBe("2024-12-31");
		expect(ymd(read("2024 9", "gggg w"))).toBe("2024-02-25");
		expect(read("1700000000.5", "X")?.getTime()).toBe(1_700_000_000_500);
		expect(read("2024-05-03 10:00 +0200", "YYYY-MM-DD HH:mm Z")?.toISOString()).toBe(
			"2024-05-03T08:00:00.000Z",
		);
	});

	test("strict stays the default: a daily note's name must format back to itself", () => {
		expect(parseMomentDate("2024-5-3", "YYYY-MM-DD")).toBeUndefined();
		expect(parseDailyNoteDate("2024-5-3.md", normalizeDailyNoteConfig())).toBeUndefined();
		expect(ymd(parseMomentDate("2024-05-03", "YYYY-MM-DD", { strict: true }))).toBe("2024-05-03");
		// A year below 100 is that year, not 19xx.
		expect(parseMomentDate("0005-01-01", "YYYY-MM-DD")?.getFullYear()).toBe(5);
	});

	test("strict mode still takes leading zeros in epochs and ISO weekdays, as moment's does", () => {
		expect(parseMomentDate("012", "X")?.getTime()).toBe(12_000);
		expect(parseMomentDate("0513", "x")?.getTime()).toBe(513);
		expect(parseMomentDate("1700000000.5", "X")?.getTime()).toBe(1_700_000_000_500);
		expect(ymd(parseMomentDate("2024-W05-05", "GGGG-[W]WW-E"))).toBe("2024-02-02");
		expect(parseMomentDate("2024-W05-9", "GGGG-[W]WW-E")).toBeUndefined();
		expect(parseMomentDate("2024-W05-0", "GGGG-[W]WW-E")).toBeUndefined();
	});

	test("a list of formats takes the first that reads a date, unless a later one fits better", () => {
		// `MM/DD/YYYY` reads `20` as a month and fails; the second format fits exactly.
		expect(read("2024-05-15 13:45", "MM/DD/YYYY")).toBeUndefined();
		const best = parseMomentDate("2024-05-15 13:45", ["MM/DD/YYYY", "YYYY-MM-DD HH:mm"], {
			strict: false,
			now,
		});
		expect(stamp(best)).toBe("2024-05-15 13:45:00.000");
		// Both read `5/3/2024` with nothing left over: the first wins the tie.
		expect(ymd(parseMomentDate("5/3/2024", ["M/D/YYYY", "D/M/YYYY"], { strict: false, now }))).toBe(
			"2024-05-03",
		);
		// `D MMM` leaves the year unread; `D MMM YYYY` takes it all, so it wins.
		expect(
			ymd(parseMomentDate("3 May 2024", ["D MMM", "D MMM YYYY"], { strict: false, now })),
		).toBe("2024-05-03");
		expect(parseMomentDate("soon", ["YYYY", "MM-DD"], { strict: false, now })).toBeUndefined();
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
			dailyPage(`Daily/${formatDailyNoteDate(new Date(2020, 0, 1 + day), "YYYY-MM-DD")}.md`),
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
