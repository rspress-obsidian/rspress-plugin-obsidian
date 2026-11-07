/**
 * `CALENDAR` rendering: one month grid per month that has dated pages.
 *
 * Separate from `dataview.ts` because a calendar is the only command that draws
 * pages on dates instead of rows in a table, and it needs nothing from the
 * query engine but the rows the other commands also receive.
 */
import { MONTH_NAMES } from "../shared/date-math.js";
import { escapeHtmlText } from "../shared/escape.js";
import type { DataviewEnvironment, Row } from "./dataview.js";
import { evaluate, parseExpression } from "./dataview-expression.js";
import type { NamedField } from "./dataview-plan.js";
import { renderValue } from "./dataview-render.js";
import { daysInMonth, typeOf } from "./dataview-values.js";

const CALENDAR_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * A CALENDAR query as month grids, newest month first; each page sits on the
 * day its date field names. Pages whose field is empty are left out, and a
 * field that holds something other than a date is an error, as in Dataview.
 */
export function renderCalendar(field: NamedField, rows: Row[], env: DataviewEnvironment): string {
	const linkField = parseExpression("file.link");
	const dated: Array<{ date: Date; link: unknown }> = [];
	for (const row of rows) {
		const value = evaluate(field.field, env.ctx, row.data);
		if (value === null || value === undefined) continue;
		if (!(value instanceof Date)) {
			throw new Error(
				`CALENDAR ${field.name} must be a date, but one page has a ${typeOf(value)}.`,
			);
		}
		const date = value;
		dated.push({ date, link: evaluate(linkField, env.ctx, row.data) });
	}
	const months = new Map<string, { year: number; month: number; entries: typeof dated }>();
	for (const entry of dated) {
		const key = `${entry.date.getFullYear()}-${entry.date.getMonth()}`;
		const month = months.get(key);
		if (month) month.entries.push(entry);
		else
			months.set(key, {
				year: entry.date.getFullYear(),
				month: entry.date.getMonth(),
				entries: [entry],
			});
	}
	const ordered = [...months.values()].sort(
		(left, right) => right.year - left.year || right.month - left.month,
	);
	const grids = ordered
		.map((month) => renderMonthGrid(month.year, month.month, month.entries, env))
		.join("");
	return `<div class="dataview dataview-calendar">${grids}</div>`;
}

function renderMonthGrid(
	year: number,
	month: number,
	entries: Array<{ date: Date; link: unknown }>,
	env: DataviewEnvironment,
): string {
	const byDay = new Map<number, unknown[]>();
	for (const entry of entries) {
		const bucket = byDay.get(entry.date.getDate());
		if (bucket) bucket.push(entry.link);
		else byDay.set(entry.date.getDate(), [entry.link]);
	}
	const leading = new Date(year, month, 1).getDay();
	const today = env.ctx.now;
	const cells: string[] = [];
	for (let offset = 0; offset < leading; offset += 1) {
		cells.push('<td class="dataview-calendar-day is-empty"></td>');
	}
	for (let day = 1; day <= daysInMonth(year, month); day += 1) {
		const links = (byDay.get(day) ?? [])
			.map((link) => `<li>${renderValue(link, env.rc)}</li>`)
			.join("");
		const classes = ["dataview-calendar-day"];
		const weekday = (day + leading - 1) % 7;
		if (weekday === 0 || weekday === 6) classes.push("is-weekend");
		if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
			classes.push("is-today");
		}
		cells.push(
			`<td class="${classes.join(" ")}"><span class="dataview-calendar-date">${day}</span>${links ? `<ul>${links}</ul>` : ""}</td>`,
		);
	}
	const weeks: string[] = [];
	for (let start = 0; start < cells.length; start += 7) {
		weeks.push(`<tr>${cells.slice(start, start + 7).join("")}</tr>`);
	}
	const head = CALENDAR_WEEKDAYS.map((day) => `<th>${day}</th>`).join("");
	return `<table class="dataview-calendar-month"><caption>${escapeHtmlText(`${MONTH_NAMES[month]} ${year}`)}</caption><thead><tr>${head}</tr></thead><tbody>${weeks.join("")}</tbody></table>`;
}
