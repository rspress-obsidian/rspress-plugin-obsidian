import { escapeHtmlText } from "../shared/escape.js";
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

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TOKEN_PATTERN = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g;
const dateFormatMatchers = new Map<string, { regex: RegExp; tokens: string[] }>();

export function normalizeDailyNoteConfig(config?: Partial<DailyNoteConfig>): DailyNoteConfig {
	return {
		folder: config?.folder?.replace(/^\/|\/$/g, "") ?? "",
		dateFormat: config?.dateFormat ?? "YYYY-MM-DD",
		navigation: config?.navigation ?? true,
		template: config?.template?.replace(/^\/|\/$/g, "") ?? "",
		calendar: normalizeCalendarRoute(config?.calendar),
	};
}

export function parseDailyNoteDate(
	relativePath: string,
	config: DailyNoteConfig,
): Date | undefined {
	const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, "");
	const folderPrefix = config.folder ? `${config.folder}/` : "";
	if (folderPrefix && !withoutExtension.startsWith(folderPrefix)) return undefined;
	const candidate = withoutExtension.slice(folderPrefix.length);
	// The matcher depends only on `dateFormat`, but it was rebuilt — token
	// regexes, escaped literals and all — on every call. `renderDailyNavigation`
	// calls this once per page for every daily note, so a daily-notes vault
	// compiled the same regex millions of times (0.70us a call, 2.8s at 2000
	// notes). Keyed on the format string, which is what it is derived from.
	let compiled = dateFormatMatchers.get(config.dateFormat);
	if (!compiled) {
		const tokenMatches = [...config.dateFormat.matchAll(TOKEN_PATTERN)];
		let pattern = "";
		let cursor = 0;
		for (const match of tokenMatches) {
			pattern += escapeRegex(config.dateFormat.slice(cursor, match.index));
			pattern += tokenRegex(match[0] ?? "");
			cursor = (match.index ?? 0) + (match[0]?.length ?? 0);
		}
		pattern += escapeRegex(config.dateFormat.slice(cursor));
		compiled = {
			regex: new RegExp(`^${pattern}$`),
			tokens: tokenMatches.map((item) => item[0] ?? ""),
		};
		dateFormatMatchers.set(config.dateFormat, compiled);
	}
	const { regex, tokens } = compiled;
	const match = regex.exec(candidate);
	if (!match) return undefined;

	let capture = 1;
	let year = 1970;
	let month = 1;
	let day = 1;
	for (const token of tokens) {
		const value = match[capture++] ?? "";
		if (token === "YYYY") year = Number(value);
		else if (token === "YY") year = 2000 + Number(value);
		else if (token === "MMMM" || token === "MMM") {
			// `-1` for an unknown name fails the round-trip check below.
			month = MONTHS.findIndex((name) => name.toLowerCase().startsWith(value.toLowerCase())) + 1;
		} else if (token === "MM" || token === "M") month = Number(value);
		else if (token === "DD" || token === "D") day = Number(value);
	}
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return undefined;
	}
	return date;
}

export function formatDailyNoteDate(date: Date, format: string): string {
	const replacements: Record<string, string> = {
		YYYY: String(date.getUTCFullYear()).padStart(4, "0"),
		YY: String(date.getUTCFullYear()).slice(-2),
		MMMM: MONTHS[date.getUTCMonth()] ?? "",
		MMM: (MONTHS[date.getUTCMonth()] ?? "").slice(0, 3),
		MM: String(date.getUTCMonth() + 1).padStart(2, "0"),
		M: String(date.getUTCMonth() + 1),
		DD: String(date.getUTCDate()).padStart(2, "0"),
		D: String(date.getUTCDate()),
		dddd: WEEKDAYS[date.getUTCDay()] ?? "",
		ddd: (WEEKDAYS[date.getUTCDay()] ?? "").slice(0, 3),
	};
	return format.replace(TOKEN_PATTERN, (token) => replacements[token] ?? token);
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
): string {
	if (!isEmptyDailyNoteBody(body) || templateBody.trim().length === 0) return body;
	return expandDailyTemplateTokens(templateBody, date, title);
}

/** `{{title}}` plus every `{{date…}}` token Obsidian's daily-notes core supports. */
export function expandDailyTemplateTokens(value: string, date: Date, title: string): string {
	return expandDailyTemplateText(value, date)
		.replace(/\{\{title\}\}/gi, title)
		.replace(/\{\{time\}\}/gi, "00:00");
}

export function expandDailyTemplateText(value: string, date: Date): string {
	return value.replace(
		/\{\{date(?:(:([^}]+))|([+-])(\d+)([dwmy]))?\}\}/gi,
		(
			_match,
			_formatMarker: string,
			format: string | undefined,
			sign: string | undefined,
			amount: string | undefined,
			unit: string | undefined,
		) => {
			const adjusted = adjustDate(date, sign, amount, unit);
			return formatDailyNoteDate(adjusted, format || "YYYY-MM-DD");
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
	Map<string, { dated: Array<{ page: ContentPage; date: Date }>; positions: Map<string, number> }>
>();

function dailyNoteLadder(pages: ContentPage[], config: DailyNoteConfig) {
	let byFormat = dailyLadders.get(pages);
	if (!byFormat) {
		byFormat = new Map();
		dailyLadders.set(pages, byFormat);
	}
	const cached = byFormat.get(config.dateFormat);
	if (cached) return cached;
	const dated = pages
		.map((page) => ({ page, date: parseDailyNoteDate(page.relativePath, config) }))
		.filter((entry): entry is { page: ContentPage; date: Date } => Boolean(entry.date))
		.sort((left, right) => left.date.getTime() - right.date.getTime());
	const positions = new Map(dated.map((entry, index) => [entry.page.absolutePath, index]));
	const ladder = { dated, positions };
	byFormat.set(config.dateFormat, ladder);
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
	const previous = dated[position - 1];
	const next = dated[position + 1];
	const currentDate = parseDailyNoteDate(currentPage.relativePath, config);
	if (!currentDate) return "";
	const link = (entry: { page: ContentPage; date: Date } | undefined) =>
		entry
			? `<a href="${routeHref(entry.page.routePath, entry.page.relativePath)}">${escapeHtmlText(formatDailyNoteDate(entry.date, config.dateFormat))}</a>`
			: `<span class="daily-notes-placeholder"></span>`;
	return `<nav class="obsidian-daily-navigation" aria-label="Daily notes navigation"><span class="daily-notes-previous">${link(previous)}</span><span class="daily-notes-current">${escapeHtmlText(formatDailyNoteDate(currentDate, config.dateFormat))}</span><span class="daily-notes-next">${link(next)}</span></nav>`;
}

function tokenRegex(token: string): string {
	if (token === "YYYY") return "(\\d{4})";
	if (token === "YY") return "(\\d{2})";
	if (token === "MMMM") return `(${MONTHS.join("|")})`;
	if (token === "MMM") return `(${MONTHS.map((month) => month.slice(0, 3)).join("|")})`;
	if (token === "MM") return "(\\d{2})";
	if (token === "M") return "(\\d{1,2})";
	if (token === "DD") return "(\\d{2})";
	if (token === "D") return "(\\d{1,2})";
	if (token === "dddd") return `(${WEEKDAYS.join("|")})`;
	if (token === "ddd") return `(${WEEKDAYS.map((day) => day.slice(0, 3)).join("|")})`;
	return escapeRegex(token);
}

function adjustDate(date: Date, sign?: string, amount?: string, unit?: string): Date {
	const adjusted = new Date(date.getTime());
	if (!sign || !amount || !unit) return adjusted;
	const delta = (sign === "-" ? -1 : 1) * Number(amount);
	if (unit.toLowerCase() === "d") adjusted.setUTCDate(adjusted.getUTCDate() + delta);
	else if (unit.toLowerCase() === "w") adjusted.setUTCDate(adjusted.getUTCDate() + delta * 7);
	else if (unit.toLowerCase() === "m") adjusted.setUTCMonth(adjusted.getUTCMonth() + delta);
	else if (unit.toLowerCase() === "y") adjusted.setUTCFullYear(adjusted.getUTCFullYear() + delta);
	return adjusted;
}

function escapeRegex(value: string | undefined): string {
	return (value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

	const dated = index.pages
		.map((page) => ({ page, date: parseDailyNoteDate(page.relativePath, config) }))
		.filter((entry): entry is { page: ContentPage; date: Date } => Boolean(entry.date))
		.sort((left, right) => right.date.getTime() - left.date.getTime());
	if (dated.length === 0) return [];

	const months = new Map<string, typeof dated>();
	for (const entry of dated) {
		const key = formatDailyNoteDate(entry.date, "YYYY-MM");
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
	for (const [, entries] of months) {
		const label = formatDailyNoteDate((entries[0] as { date: Date }).date, "MMMM YYYY");
		lines.push(`## ${escapeHeadingText(label)}`, "");
		for (const { page, date } of entries) {
			const day = formatDailyNoteDate(date, "dddd");
			const title = page.title ?? page.baseName;
			const label2 =
				title === formatDailyNoteDate(date, config.dateFormat)
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

function escapeHeadingText(value: string): string {
	return value.replace(/[\\`*_[\]<>#]/g, "\\$&");
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownDestination(value: string): string {
	return value.replace(/[()\s<>"']/g, encodeURIComponent);
}
