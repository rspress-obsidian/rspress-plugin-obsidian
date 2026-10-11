import { describe, expect, test } from "bun:test";
import { formatDailyNoteDate } from "../../daily-notes.js";
import { type MomentValue, momentFunction } from "./moment.js";

const NOW = new Date(2024, 4, 15, 14, 5, 0);
const moment = momentFunction(NOW);

/** `moment(text, format)`, as a template script calls it. */
function at(text: string, format = "YYYY-MM-DD HH:mm"): MomentValue {
	return moment.call([text, format]) as MomentValue;
}

function show(value: unknown): string {
	return (value as MomentValue).format("YYYY-MM-DD HH:mm");
}

describe("moment arithmetic", () => {
	test("a duration moves months first, then days, as moment adds them", () => {
		// Jan 30 + 1 month = Feb 29, + 1 day = Mar 1.
		expect(show(at("2024-01-30 00:00").method("add", ["P1M1D"]))).toBe("2024-03-01 00:00");
		expect(show(at("2024-03-01 00:00").method("subtract", ["P1M1D"]))).toBe("2024-01-31 00:00");
	});

	test("fractional days and months round half away from zero", () => {
		expect(show(at("2024-01-31 00:00").method("add", [1.5, "days"]))).toBe("2024-02-02 00:00");
		expect(show(at("2024-01-31 00:00").method("subtract", [1.5, "d"]))).toBe("2024-01-29 00:00");
		expect(show(at("2024-01-31 00:00").method("add", [1.5, "M"]))).toBe("2024-03-31 00:00");
		expect(show(at("2024-01-31 00:00").method("add", [1.5, "h"]))).toBe("2024-01-31 01:30");
	});

	test("`D` is moment's date field, which a duration does not have: adding it changes nothing", () => {
		expect(show(at("2024-01-31 00:00").method("add", [3, "D"]))).toBe("2024-01-31 00:00");
		expect(show(at("2024-01-31 00:00").method("add", [1, "W"]))).toBe("2024-02-07 00:00");
		expect(show(at("2024-01-31 00:00").method("add", [1, "Q"]))).toBe("2024-04-30 00:00");
	});

	test("`W` starts the ISO week on Monday; `w` the locale week on Sunday", () => {
		expect(show(at("2024-05-15 10:00").method("startOf", ["W"]))).toBe("2024-05-13 00:00");
		expect(show(at("2024-05-15 10:00").method("startOf", ["w"]))).toBe("2024-05-12 00:00");
		expect(show(at("2024-05-15 10:00").method("endOf", ["date"]))).toBe("2024-05-15 23:59");
	});
});

describe("moment diff", () => {
	test("months anchor on the later day of the month, as moment compares month ends", () => {
		const january31 = at("2024-01-31 00:00");
		expect(january31.method("diff", [at("2024-02-29 00:00"), "months"])).toBe(-1);
		expect(at("2024-02-29 00:00").method("diff", [january31, "months"])).toBe(1);
	});

	test("a third argument returns the fraction; `date` counts milliseconds", () => {
		const start = at("2024-05-01 00:00");
		expect(at("2024-05-02 18:00").method("diff", [start, "days", true])).toBe(1.75);
		expect(at("2024-05-02 18:00").method("diff", [start, "days"])).toBe(1);
		expect(at("2024-05-02 00:00").method("diff", [start, "date"])).toBe(86_400_000);
		expect(at("2024-05-02 00:00").method("diff", [start])).toBe(86_400_000);
	});

	test("a day across a DST change is still one day", () => {
		const previous = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const before = at("2024-03-10 00:00");
			const after = at("2024-03-11 00:00");
			expect(after.method("diff", [before, "days"])).toBe(1);
			expect(formatDailyNoteDate(new Date(Number(after.primitive())), "Z")).toBe("-04:00");
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	});
});

describe("moment(text, format)", () => {
	const parse = (...args: unknown[]) => moment.call(args) as MomentValue;

	test("reads forgivingly, as moment does without strict mode", () => {
		expect(show(parse("2024-5-3", "YYYY-MM-DD"))).toBe("2024-05-03 00:00");
		expect(show(parse("Meeting 5/3/2024 notes", "MM/DD/YYYY"))).toBe("2024-05-03 00:00");
		expect(show(parse("9:5", "HH:mm"))).toBe("2024-05-15 09:05");
		// The year left out comes from the template clock.
		expect(show(parse("3 Sept", "D MMMM"))).toBe("2024-09-03 00:00");
		expect(parse("2024-02-30", "YYYY-MM-DD").method("isValid", [])).toBe(false);
	});

	test("`true` after the format (or after a locale) asks for strict mode", () => {
		expect(parse("2024-5-3", "YYYY-MM-DD", true).method("isValid", [])).toBe(false);
		expect(parse("2024-5-3", "YYYY-MM-DD", "en", true).method("isValid", [])).toBe(false);
		expect(show(parse("2024-05-03", "YYYY-MM-DD", true))).toBe("2024-05-03 00:00");
	});

	test("a list of formats takes the one that fits the text best", () => {
		expect(show(parse("3 May 2024 10:30", ["D MMM", "D MMM YYYY HH:mm"]))).toBe("2024-05-03 10:30");
	});
});
