/**
 * The date logic of Kanban's cards — relative dates, date colours, the
 * `is-today`/`is-past`/`is-future` classes — against an injectable "now", so a
 * board renders the same on every build that pins it. Kanban computes all of
 * it with moment, so the arithmetic is moment's, from `date-math.ts`.
 */
import {
	momentAdd,
	momentDiff,
	momentFrom,
	momentUnitSpan,
	normalizeMomentUnit,
	startOf,
} from "../../date-math.js";
import type { KanbanDateColor } from "./options.js";

/**
 * "Now" from the `now` option: a `Date`, a `YYYY-MM-DD` day (local midnight,
 * as a card date is read), or any string `Date` parses. `undefined` when the
 * string is not a date.
 */
export function parseNow(now: Date | string | undefined): Date | undefined {
	if (now === undefined) return new Date();
	if (now instanceof Date) return Number.isNaN(now.getTime()) ? undefined : now;
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(now.trim());
	const parsed = day
		? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
		: new Date(now.trim());
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier), as `diff(…, "day")`. */
export function dayDifference(to: Date, from: Date): number {
	return momentDiff(startOf(to, "day"), startOf(from, "day"), "day");
}

/**
 * Kanban's relative date: a timed card counts from this moment; a dated one
 * reads `today`, `yesterday`, `tomorrow`, or counts from the start of today.
 */
export function relativeDate(date: Date, hasTime: boolean, now: Date): string {
	if (hasTime) return momentFrom(date, now);
	const days = dayDifference(date, now);
	if (days === 0) return "today";
	if (days === -1) return "yesterday";
	if (days === 1) return "tomorrow";
	return momentFrom(startOf(date, "day"), startOf(now, "day"));
}

/** The `is-today` / `is-past` / `is-future` class a dated card carries. */
export function dateClass(date: Date, now: Date): "is-today" | "is-past" | "is-future" {
	const days = dayDifference(date, now);
	if (days === 0) return "is-today";
	return days < 0 ? "is-past" : "is-future";
}

type DateColorRule =
	| { kind: "today" | "before" | "after"; color: KanbanDateColor }
	| { kind: "window"; edge: Date; color: KanbanDateColor };

/**
 * Kanban's `getDateColorFn`: "today" rules are tried first, then the
 * distance windows by their far edge, earliest first, then "before"/"after";
 * the first rule a date falls in gives its colour.
 */
export function dateColorMatcher(
	colors: readonly KanbanDateColor[],
	now: Date,
): (date: Date) => KanbanDateColor | undefined {
	const rules: DateColorRule[] = colors.map((color) => {
		if (color.isToday) return { kind: "today", color };
		if (color.isBefore) return { kind: "before", color };
		if (color.isAfter) return { kind: "after", color };
		const sign = color.direction === "after" ? 1 : -1;
		// Kanban's `moment().add(distance, unit)`: a month clamps to the month's last day.
		const unit = normalizeMomentUnit(color.unit ?? "days") ?? "day";
		const edge = momentAdd(now, momentUnitSpan(unit, (color.distance ?? 0) * sign));
		return { kind: "window", edge, color };
	});
	const rank = { today: 0, window: 1, before: 2, after: 2 } as const;
	rules.sort((left, right) => {
		if (rank[left.kind] !== rank[right.kind]) return rank[left.kind] - rank[right.kind];
		return left.kind === "window" && right.kind === "window"
			? left.edge.getTime() - right.edge.getTime()
			: 0;
	});

	return (date) => {
		const days = dayDifference(date, now);
		const rule = rules.find((candidate) => {
			if (candidate.kind !== "window") {
				if (candidate.kind === "today") return days === 0;
				return candidate.kind === "after"
					? date.getTime() > now.getTime()
					: date.getTime() < now.getTime();
			}
			const byHour = candidate.color.unit === "hours";
			const low = candidate.color.direction === "before" ? candidate.edge : now;
			const high = candidate.color.direction === "before" ? now : candidate.edge;
			if (byHour) {
				const hour = 3_600_000;
				const at = Math.floor(date.getTime() / hour);
				return at >= Math.floor(low.getTime() / hour) && at <= Math.floor(high.getTime() / hour);
			}
			return dayDifference(date, low) >= 0 && dayDifference(high, date) >= 0;
		});
		return rule?.color;
	};
}
