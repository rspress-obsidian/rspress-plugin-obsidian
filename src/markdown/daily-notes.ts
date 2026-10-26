import { momentAdd, momentUnitSpan, normalizeMomentUnit, startOf } from "../shared/date-math.js";
import { escapeHtmlText, escapeMarkdownDestination } from "../shared/escape.js";
import { formatMomentDate, parseMomentDate } from "../shared/moment-format.js";
import type { AdditionalPage } from "./tag-pages.js";
import type { ContentIndex, ContentPage } from "./types.js";
import { routeHref } from "./utils.js";

export interface DailyNoteConfig {
	folder: string;
	dateFormat: string;
	navigation: boolean;
	/** Vault-relative path of a note used as the body of an empty daily note. */
	template: string;
	/** Route of the generated calendar page; empty when no calendar is wanted. */
	calendar: string;
}

export function normalizeDailyNoteConfig(config?: Partial<DailyNoteConfig>): DailyNoteConfig {
	return {
		folder: config?.folder?.replace(/^\/|\/$/g, "") ?? "",
		dateFormat: config?.dateFormat ?? "YYYY-MM-DD",
		navigation: config?.navigation ?? true,
		template: config?.template?.replace(/^\/|\/$/g, "") ?? "",
		calendar: normalizeCalendarRoute(config?.calendar),
	};
}

/** The date a daily note's path names, when it sits in the folder and matches the format. */
export function parseDailyNoteDate(
	relativePath: string,
	config: DailyNoteConfig,
): Date | undefined {
	const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, "");
	const folderPrefix = config.folder ? `${config.folder}/` : "";
	if (folderPrefix && !withoutExtension.startsWith(folderPrefix)) return undefined;
	return parseMomentDate(withoutExtension.slice(folderPrefix.length), config.dateFormat);
}

/** `/daily` for `/daily`, `daily` and `/daily/` alike; empty stays empty. */
function normalizeCalendarRoute(route: string | undefined): string {
	const trimmed = (route ?? "").trim();
	if (!trimmed) return "";
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** Whether a daily note has nothing but (optional) frontmatter in its body. */
export function isEmptyDailyNoteBody(body: string): boolean {
	// Frontmatter has already been stripped by the time the remark pass sees the
	// body, so anything left is content the author wrote.
	return body.trim().length === 0;
}

/** Inputs of template expansion that are not the note's own date. */
export interface DailyTemplateOptions {
	/** The daily-note filename format: what `{{date}}` and `{{date+1d}}` render with. Default `YYYY-MM-DD`. */
	format?: string;
	/** The clock `{{time}}` reads, and whose time of day `{{date:HH:mm}}` uses. Default: now. */
	now?: Date;
}

/**
 * Apply a template note to a daily note.
 *
 * Obsidian inserts the template at the cursor, which a static build has no
 * equivalent for; the rule here is the useful one instead — a daily note whose
 * body is still empty is filled with the template, and a note the author has
 * started writing is never touched.
 */
export function applyDailyNoteTemplate(
	body: string,
	templateBody: string,
	date: Date,
	title: string,
	options: DailyTemplateOptions = {},
): string {
	if (!isEmptyDailyNoteBody(body) || templateBody.trim().length === 0) return body;
	return expandDailyTemplateTokens(templateBody, date, title, options);
}

/**
 * Every token Obsidian's daily-notes core expands when it creates a note from
 * a template: `{{title}}`, `{{date}}`, `{{time}}`, `{{yesterday}}`,
 * `{{tomorrow}}`, and `{{date|time[±N unit][:FORMAT]}}`.
 */
export function expandDailyTemplateTokens(
	value: string,
	date: Date,
	title: string,
	options: DailyTemplateOptions = {},
): string {
	const format = options.format ?? "YYYY-MM-DD";
	const shift = (days: number) =>
		formatMomentDate(momentAdd(startOf(date, "day"), momentUnitSpan("day", days)), format);
	return expandDailyTemplateText(
		value.replace(/\{\{\s*date\s*\}\}/gi, title).replace(/\{\{\s*title\s*\}\}/gi, title),
		date,
		format,
		options.now,
	)
		.replace(/\{\{\s*yesterday\s*\}\}/gi, shift(-1))
		.replace(/\{\{\s*tomorrow\s*\}\}/gi, shift(1));
}

/**
 * `{{date}}`, `{{time}}` and `{{date|time[±N unit][:FORMAT]}}`. The value is the
 * note's date at the current time of day, moved by the offset (Moment units:
 * `y`, `Q`, `M` months, `w`, `d`, `h`, `m` minutes, `s`; `q` and `D` add nothing) and formatted with
 * FORMAT, else with the daily-note format; a bare `{{time}}` is the current
 * `HH:mm`.
 */
export function expandDailyTemplateText(
	value: string,
	date: Date,
	format = "YYYY-MM-DD",
	now: Date = new Date(),
): string {
	return value
		.replace(/\{\{\s*date\s*\}\}/gi, formatMomentDate(date, format))
		.replace(/\{\{\s*time\s*\}\}/gi, formatMomentDate(now, "HH:mm"))
		.replace(
			/\{\{\s*(?:date|time)\s*(?:([+-]\d+)([yqmwdhs]))?\s*(:.+?)?\}\}/gi,
			(_match, delta: string | undefined, unit: string | undefined, momentFormat?: string) => {
				const current = new Date(date.getTime());
				current.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
				// Obsidian calls `moment.add(amount, unit)`: `q` is no moment unit, and `D`
				// (`date`) is one a duration has no field for, so both add nothing.
				const momentUnit = unit === undefined ? undefined : normalizeMomentUnit(unit);
				const moved =
					delta && momentUnit
						? momentAdd(current, momentUnitSpan(momentUnit, Number(delta)))
						: current;
				return formatMomentDate(moved, momentFormat ? momentFormat.slice(1).trim() : format);
			},
		);
}

/**
 * The dated notes in date order, plus each note's position in that order.
 * Keyed on the `pages` array identity, which is the index's own `pages` for
 * the whole build, so it is computed once per config and dropped with it.
 */
const dailyLadders = new WeakMap<
	ContentPage[],
	Map<
		string,
		{
			dated: Array<{ page: ContentPage; date: Date }>;
			positions: Map<string, { index: number; date: Date }>;
		}
	>
>();

function dailyNoteLadder(pages: ContentPage[], config: DailyNoteConfig) {
	let byFormat = dailyLadders.get(pages);
	if (!byFormat) {
		byFormat = new Map();
		dailyLadders.set(pages, byFormat);
	}
	const key = `${config.folder}\n${config.dateFormat}`;
	const cached = byFormat.get(key);
	if (cached) return cached;
	const dated = pages
		.map((page) => ({ page, date: parseDailyNoteDate(page.relativePath, config) }))
		.filter((entry): entry is { page: ContentPage; date: Date } => Boolean(entry.date))
		.sort((left, right) => left.date.getTime() - right.date.getTime());
	const positions = new Map(
		dated.map((entry, index) => [entry.page.absolutePath, { index, date: entry.date }]),
	);
	const ladder = { dated, positions };
	byFormat.set(key, ladder);
	return ladder;
}

export function renderDailyNavigation(
	currentPage: ContentPage,
	pages: ContentPage[],
	config: DailyNoteConfig,
): string {
	if (!config.navigation) return "";
	// Every daily note asks for the same thing — the vault's dated notes, in
	// date order — so this list is built once per `(pages, config)` rather
	// than once per note, and the position is a Map hit instead of a scan.
	// Together these turned an O(notes x pages) pass linear: 3578ms at 2000
	// notes before, 16ms after.
	const { dated, positions } = dailyNoteLadder(pages, config);
	const position = positions.get(currentPage.absolutePath);
	if (position === undefined) return "";
	const previous = dated[position.index - 1];
	const next = dated[position.index + 1];
	const link = (entry: { page: ContentPage; date: Date } | undefined) =>
		entry
			? `<a href="${routeHref(entry.page.routePath, entry.page.relativePath)}">${escapeHtmlText(formatMomentDate(entry.date, config.dateFormat))}</a>`
			: `<span class="daily-notes-placeholder"></span>`;
	return `<nav class="obsidian-daily-navigation" aria-label="Daily notes navigation"><span class="daily-notes-previous">${link(previous)}</span><span class="daily-notes-current">${escapeHtmlText(formatMomentDate(position.date, config.dateFormat))}</span><span class="daily-notes-next">${link(next)}</span></nav>`;
}

/**
 * Generate the daily-notes calendar page.
 *
 * Obsidian's daily-notes core offers a calendar that opens a note by clicking a
 * day; a published site can offer the same reachability as an index of every
 * daily note, grouped by month and newest first. The route comes from
 * `dailyNotes.calendar`, and nothing is generated when it is empty.
 */
export function generateDailyNoteCalendar(
	index: ContentIndex,
	config: DailyNoteConfig,
): AdditionalPage[] {
	if (!config.calendar) return [];

	const dated = [...dailyNoteLadder(index.pages, config).dated].reverse();
	if (dated.length === 0) return [];

	const months = new Map<string, typeof dated>();
	for (const entry of dated) {
		const key = formatMomentDate(entry.date, "MMMM YYYY");
		const bucket = months.get(key);
		if (bucket) bucket.push(entry);
		else months.set(key, [entry]);
	}

	const lines: string[] = [
		"---",
		`title: "Daily notes"`,
		"---",
		"",
		"# Daily notes",
		"",
		`${dated.length} daily note${dated.length === 1 ? "" : "s"}, newest first.`,
		"",
	];
	for (const [month, entries] of months) {
		lines.push(`## ${month}`, "");
		for (const { page, date } of entries) {
			const day = formatMomentDate(date, "dddd");
			const title = page.title ?? page.baseName;
			const label2 =
				title === formatMomentDate(date, config.dateFormat)
					? day
					: `${day} — ${escapeMarkdownLabel(title)}`;
			lines.push(
				`- [${label2}](${escapeMarkdownDestination(routeHref(page.routePath, page.relativePath))})`,
			);
		}
		lines.push("");
	}

	return [{ routePath: config.calendar, content: lines.join("\n") }];
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/([\\[\]])/g, "\\$1");
}
