/**
 * A parsed board as static HTML, in Kanban's own markup (`kanban-plugin__*`
 * classes), so themes and CSS snippets written for the plugin style the site
 * too. Card text renders through the page's own pipeline (`renderBlock`), so a
 * link, tag, formula or embed in a card behaves as it does in a note.
 */
import fs from "node:fs";
import { escapeHtmlAttribute, escapeHtmlText } from "../../../shared/escape.js";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import { tagRoutePath } from "../../../shared/paths.js";
import { formatDailyNoteDate, parseMomentDate } from "../../daily-notes.js";
import type { InlineField } from "../../dataview-metadata.js";
import { DataviewLink, escapeRegExp, valueToString } from "../../dataview-values.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import type { ContentIndex, ContentPage } from "../../types.js";
import type { PluginRenderContext } from "../types.js";
import type { ResolvedKanbanSettings } from "./board-settings.js";
import { dateClass, dateColorMatcher, relativeDate } from "./dates.js";
import type { KanbanDateColor, KanbanMetadataKey, KanbanTagColor } from "./options.js";
import { type KanbanBoard, type KanbanCard, type KanbanLane, TASK_FIELDS } from "./parse.js";

/** What a board renders with, besides the board itself. */
export interface BoardRenderContext {
	ctx: PluginRenderContext;
	settings: ResolvedKanbanSettings;
	now: Date;
	showArchive: boolean;
	/**
	 * Ids the note's own page gives its headings, by the heading's line in the
	 * board body; written behind `ctx.idPrefix`, as the pipeline writes an
	 * embedded note's heading ids.
	 */
	laneIds: ReadonlyMap<number, string>;
}

interface CardDates {
	/** The card's date (with its time, when it has both), as Kanban's `metadata.date`. */
	date?: Date;
	/** The time shown, when the card has one. */
	time?: Date;
	/** What the date colour, the date line and the table sort by: the time, else the date. */
	target?: Date;
}

/** Kanban's task-field labels (`lableToName`). */
const TASK_FIELD_NAMES: Record<string, string> = {
	priority: "Priority",
	start: "Start",
	created: "Created",
	scheduled: "Scheduled",
	due: "Due",
	completion: "Done",
	cancelled: "Cancelled",
	recurrence: "Recurrence",
	dependsOn: "Depends on",
	id: "ID",
};

/** Kanban's task-field icons (`lableToIcon`), for fields written as emoji. */
const TASK_FIELD_ICONS: Record<string, string> = {
	start: "🛫",
	created: "➕",
	scheduled: "⏳",
	due: "📅",
	completion: "✅",
	cancelled: "❌",
	recurrence: "🔁",
	dependsOn: "⛔",
	id: "🆔",
};

const PRIORITY_ICONS: Record<string, string> = {
	highest: "🔺",
	high: "⏫",
	medium: "🔼",
	low: "🔽",
	lowest: "⏬",
};

/** A colour from settings, or `undefined` when it is anything but a plain CSS colour. */
function cssColor(value: unknown): string | undefined {
	return typeof value === "string" && /^[#\w\s(),.%/-]+$/.test(value) ? value.trim() : undefined;
}

function dateStyle(color: KanbanDateColor | undefined): { className: string; style: string } {
	const foreground = cssColor(color?.color);
	const background = cssColor(color?.backgroundColor);
	const declarations = [
		foreground && `--date-color: ${foreground};`,
		background && `--date-background-color: ${background};`,
	].filter(Boolean);
	return {
		className: background ? " has-background" : "",
		style: declarations.length > 0 ? ` style="${escapeHtmlAttribute(declarations.join(" "))}"` : "",
	};
}

function tagStyle(color: KanbanTagColor | undefined): string {
	const foreground = cssColor(color?.color);
	const background = cssColor(color?.backgroundColor);
	const declarations = [
		foreground && `--tag-color: ${foreground};`,
		background && `--tag-background: ${background};`,
	].filter(Boolean);
	return declarations.length > 0 ? ` style="${escapeHtmlAttribute(declarations.join(" "))}"` : "";
}

/** A stable, attribute-safe key for one board, to scope its generated styles. */
function boardKey(page: ContentPage): string {
	let hash = 0x811c9dc5;
	for (const char of page.relativePath) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/** The ISO-like local timestamp Kanban puts in `data-date`, without the build's time zone. */
function dataDate(date: Date): string {
	return formatDailyNoteDate(date, "YYYY-MM-DD[T]HH:mm:ss");
}

export class BoardRenderer {
	private readonly colorFor: (date: Date) => KanbanDateColor | undefined;
	private readonly tagColors: Record<string, KanbanTagColor> = {};

	constructor(private readonly input: BoardRenderContext) {
		this.colorFor = dateColorMatcher(input.settings.dateColors, input.now);
		for (const color of input.settings.tagColors) this.tagColors[color.tagKey] = color;
	}

	/**
	 * A card date or time as Kanban reads it, `moment(text, format)` without
	 * strict mode: `5/3/2024` fits `MM/DD/YYYY`, a missing year is this year.
	 */
	private readDate(text: string, format: string): Date | undefined {
		return parseMomentDate(text, format, { strict: false, now: this.input.now });
	}

	/** The card's date and time, read with the board's date and time formats. */
	private cardDates(card: KanbanCard): CardDates {
		const { dateFormat, timeFormat } = this.input.settings;
		const date = card.dateText === undefined ? undefined : this.readDate(card.dateText, dateFormat);
		const clock =
			card.timeText === undefined ? undefined : this.readDate(card.timeText, timeFormat);
		if (!clock) return { date, target: date };
		const base = date ?? this.input.now;
		const time = new Date(
			base.getFullYear(),
			base.getMonth(),
			base.getDate(),
			clock.getHours(),
			clock.getMinutes(),
			clock.getSeconds(),
		);
		return { date: date && time, time, target: time };
	}

	/**
	 * Kanban's `preprocessTitle`: dates and times still in the card text show
	 * in their display format, coloured; `@[[date]]` stays a link. Code is
	 * left as written.
	 */
	private decorateTitle(title: string): string {
		const { dateTrigger, timeTrigger, dateFormat, dateDisplayFormat, timeFormat } =
			this.input.settings;
		let color: KanbanDateColor | undefined;
		let colored = false;
		let lastDate: Date | undefined;
		const wrap = (date: Date, baseClass: string, inner: string) => {
			if (!colored) {
				color = this.colorFor(date);
				colored = true;
			}
			const { className, style } = dateStyle(color);
			return `<span data-date="${dataDate(date)}" class="${baseClass}${className}"${style}>${inner}</span>`;
		};
		const dateLink = new RegExp(`(^|\\s)${escapeRegExp(dateTrigger)}\\[\\[([^\\]]+)\\]\\]`, "g");
		const dateBraces = new RegExp(`(^|\\s)${escapeRegExp(dateTrigger)}\\{([^}]+)\\}`, "g");
		const time = new RegExp(`(^|\\s)${escapeRegExp(timeTrigger)}\\{([^}]+)\\}`, "g");
		const decorate = (text: string) =>
			text
				.replace(dateLink, (match, space: string, content: string) => {
					const date = this.readDate(content, dateFormat);
					if (!date) return match;
					lastDate = date;
					const display = formatDailyNoteDate(date, dateDisplayFormat);
					return `${space}${wrap(date, "kanban-plugin__preview-date-wrapper kanban-plugin__date kanban-plugin__preview-date-link", `[[${content}|${display}]]`)}`;
				})
				.replace(dateBraces, (match, space: string, content: string) => {
					const date = this.readDate(content, dateFormat);
					if (!date) return match;
					lastDate = date;
					const display = escapeHtmlText(formatDailyNoteDate(date, dateDisplayFormat));
					return `${space}${wrap(date, "kanban-plugin__preview-date-wrapper kanban-plugin__date", `<span class="kanban-plugin__preview-date kanban-plugin__item-metadata-date">${display}</span>`)}`;
				})
				.replace(time, (match, space: string, content: string) => {
					const clock = this.readDate(content, timeFormat);
					if (!clock) return match;
					const day = lastDate ?? new Date(1970, 0, 1);
					const at = new Date(
						day.getFullYear(),
						day.getMonth(),
						day.getDate(),
						clock.getHours(),
						clock.getMinutes(),
						clock.getSeconds(),
					);
					const display = escapeHtmlText(formatDailyNoteDate(clock, timeFormat));
					return `${space}${wrap(at, "kanban-plugin__preview-time-wrapper kanban-plugin__date", `<span class="kanban-plugin__preview-time kanban-plugin__item-metadata-time">${display}</span>`)}`;
				});
		// Code spans and fences keep their text; everything between them is decorated.
		let output = "";
		let cursor = 0;
		for (const code of title.matchAll(/(`+)[\s\S]*?\1/g)) {
			output += decorate(title.slice(cursor, code.index)) + code[0];
			cursor = code.index + code[0].length;
		}
		return output + decorate(title.slice(cursor));
	}

	private renderTag(tag: string): string {
		const style = tagStyle(this.tagColors[tag]);
		const inner = `<span>#</span>${escapeHtmlText(tag.slice(1))}`;
		return this.input.ctx.options.enableTagLinking
			? `<a href="${escapeHtmlAttribute(tagRoutePath(tag.slice(1)))}" class="tag kanban-plugin__item-tag"${style}>${inner}</a>`
			: `<span class="tag kanban-plugin__item-tag"${style}>${inner}</span>`;
	}

	private renderTags(tags: readonly string[]): string {
		return `<div class="kanban-plugin__item-tags">${tags.map((tag) => this.renderTag(tag)).join("")}</div>`;
	}

	/** Kanban's `DateAndTime`: the date (a daily-note link if asked) and the time. */
	private async renderDateAndTime(dates: CardDates): Promise<string> {
		const { target } = dates;
		if (!target) return "";
		const { ctx } = this.input;
		const { className, style } = dateStyle(this.colorFor(target));
		let inner = "";
		if (dates.date) {
			const display = formatDailyNoteDate(target, this.input.settings.dateDisplayFormat);
			let date = escapeHtmlText(display);
			if (this.input.settings.linkDateToDailyNote) {
				const day = formatDailyNoteDate(target, this.input.settings.dateFormat);
				const link = parseWikiLink(day, `[[${day}]]`);
				const resolved = await ctx.resolve(link);
				date =
					resolved.status === "ok"
						? await ctx.renderInline(`[[${day}|${display}]]`)
						: `<span class="internal-link is-unresolved">${date}</span>`;
			}
			inner += `<span class="kanban-plugin__item-metadata-date">${date}</span> `;
		}
		if (dates.time) {
			const time = formatDailyNoteDate(target, this.input.settings.timeFormat);
			inner += `<span class="kanban-plugin__item-metadata-time">${escapeHtmlText(time)}</span>`;
		}
		return `<span class="kanban-plugin__item-metadata-date-wrapper kanban-plugin__date${className}"${style}>${inner}</span>`;
	}

	private metadataKeyFor(key: string): Required<KanbanMetadataKey> {
		return (
			this.input.settings.metadataKeys.find((entry) => entry.metadataKey === key) ?? {
				metadataKey: key,
				label: key,
				shouldHideLabel: false,
				containsMarkdown: false,
			}
		);
	}

	/** One value of the metadata table, as Kanban's `MetadataValue` shows it. */
	private async renderValue(value: unknown, containsMarkdown: boolean): Promise<string> {
		const { ctx } = this.input;
		if (Array.isArray(value)) {
			const parts: string[] = [];
			for (const entry of value) parts.push(await this.renderValue(entry, containsMarkdown));
			return parts.join("<span>, </span>");
		}
		const date = metadataDate(value);
		if (date) {
			const midnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
			const format = midnight
				? this.input.settings.dateDisplayFormat
				: this.input.settings.dateTimeDisplayFormat;
			const { className, style } = dateStyle(this.colorFor(date));
			return `<span class="kanban-plugin__date${className}"${style}><span class="kanban-plugin__item-metadata-date">${escapeHtmlText(formatDailyNoteDate(date, format))}</span></span>`;
		}
		if (value instanceof DataviewLink) {
			return ctx.renderInline(`[[${value.path}${value.display ? `|${value.display}` : ""}]]`);
		}
		const text =
			typeof value === "string"
				? value
				: value !== null && typeof value === "object" && !Array.isArray(value)
					? valueToString(value)
					: String(value);
		if (containsMarkdown || /^!?\[\[[^\]]+\]\]$/.test(text.trim())) return ctx.renderInline(text);
		return escapeHtmlText(text);
	}

	private async renderMetaRow(
		key: string,
		label: string,
		hideLabel: boolean,
		value: unknown,
		containsMarkdown: boolean,
	): Promise<string> {
		const cell =
			key === "tags" && Array.isArray(value)
				? this.renderTags(value.map((tag) => `#${String(tag).replace(/^#/, "")}`))
				: `<span class="kanban-plugin__meta-value${Array.isArray(value) ? " mod-array" : ""}">${await this.renderValue(value, containsMarkdown)}</span>`;
		const labelCell = hideLabel
			? ""
			: `<td class="kanban-plugin__meta-key" data-key="${escapeHtmlAttribute(key)}"><span>${escapeHtmlText(label)}</span></td>`;
		return `<tr class="kanban-plugin__meta-row">${labelCell}<td${hideLabel ? ' colspan="2"' : ""} class="kanban-plugin__meta-value-wrapper">${cell}</td></tr>`;
	}

	/** The linked note's values for every metadata key, in key order (Kanban's `getLinkedPageMetadata`). */
	private async linkedMetadata(
		card: KanbanCard,
	): Promise<Array<{ key: Required<KanbanMetadataKey>; value: unknown }>> {
		const { ctx } = this.input;
		if (!card.link || this.input.settings.metadataKeys.length === 0) return [];
		const resolved = await ctx.resolve(card.link);
		const page = resolved.targetPage;
		if (resolved.status !== "ok" || !page) return [];
		const frontmatter = await noteFrontmatter(page, await ctx.indexFor(page.absolutePath));
		const rows: Array<{ key: Required<KanbanMetadataKey>; value: unknown }> = [];
		for (const key of this.input.settings.metadataKeys) {
			let value: unknown =
				key.metadataKey === "tags"
					? page.tags.map((tag) => `#${tag}`)
					: propertyAt(frontmatter, key.metadataKey);
			if (isEmptyValue(value) && ctx.options.enableDataview)
				value = page.dataviewFields[key.metadataKey];
			if (!isEmptyValue(value)) rows.push({ key, value });
		}
		return rows;
	}

	/** Kanban's `ItemMetadata`: the linked note's metadata, plus inline fields when merged into it. */
	private async renderMetadataTable(card: KanbanCard): Promise<string> {
		const rows: string[] = [];
		const seen = new Set<string>();
		for (const { key, value } of await this.linkedMetadata(card)) {
			seen.add(key.metadataKey);
			rows.push(
				await this.renderMetaRow(
					key.metadataKey,
					key.label,
					key.shouldHideLabel,
					value,
					key.containsMarkdown,
				),
			);
		}
		if (this.input.settings.inlineMetadataPosition === "metadata-table") {
			for (const field of card.inlineFields) {
				if (field.wrapping === "emoji" || TASK_FIELDS[field.key] || seen.has(field.key)) continue;
				seen.add(field.key);
				const key = this.metadataKeyFor(field.key);
				rows.push(
					await this.renderMetaRow(
						field.key,
						key.label,
						key.shouldHideLabel,
						field.value,
						key.containsMarkdown,
					),
				);
			}
		}
		if (rows.length === 0) return "";
		return `<div class="kanban-plugin__item-metadata-wrapper"><table class="kanban-plugin__meta-table"><tbody>${rows.join("")}</tbody></table></div>`;
	}

	/** One inline field under the card (Kanban's `InlineMetadata`). */
	private async renderInlineField(field: InlineField): Promise<string> {
		const isTask = field.wrapping === "emoji" || Boolean(TASK_FIELDS[field.key]);
		const isEmoji = field.wrapping === "emoji";
		const isDate = metadataDate(field.value) !== undefined;
		let label = isEmoji
			? field.key === "priority"
				? (PRIORITY_ICONS[field.value] ?? field.value)
				: (TASK_FIELD_ICONS[field.key] ?? field.key)
			: isTask
				? (TASK_FIELD_NAMES[field.key] ?? field.key)
				: this.metadataKeyFor(field.key).label;
		if (!isEmoji) label += ": ";
		const slug = field.key.replace(/[^a-zA-Z0-9_]/g, "-");
		const classes = [
			"kanban-plugin__item-task-inline-metadata-item",
			`kanban-plugin__inline-metadata__${slug}`,
			isTask && "is-task-metadata",
			isEmoji && "is-emoji",
			isDate && "is-date",
		].filter(Boolean);
		const key = `<span class="kanban-plugin__item-task-inline-metadata-item-key">${escapeHtmlText(label)}</span>`;
		const value =
			isEmoji && field.key === "priority"
				? ""
				: `<span class="kanban-plugin__item-task-inline-metadata-item-value"><span class="kanban-plugin__meta-value">${await this.renderValue(field.value, false)}</span></span>`;
		return `<span class="${classes.join(" ")}">${key}${value}</span>`;
	}

	private renderCheckbox(card: KanbanCard): string {
		if (!this.input.settings.showCheckboxes) return "";
		return `<div class="kanban-plugin__item-prefix-button-wrapper"><input type="checkbox" class="task-list-item-checkbox" disabled${card.checked ? " checked" : ""} data-task="${escapeHtmlAttribute(card.checkChar)}" aria-label="${card.checked ? "Completed" : "Not completed"}"></div>`;
	}

	private async renderMarkdown(card: KanbanCard): Promise<string> {
		const markdown = this.input.settings.moveDates ? card.title : this.decorateTitle(card.title);
		const html = markdown ? await this.input.ctx.renderBlock(markdown) : "";
		const anchor = card.blockId
			? `<span class="obsidian-block-anchor" id="${escapeHtmlAttribute(`${this.input.ctx.idPrefix}^${card.blockId}`)}"></span>`
			: "";
		return `<div class="kanban-plugin__item-markdown markdown-rendered">${html}${anchor}</div>`;
	}

	private cardClasses(card: KanbanCard, dates: CardDates): string {
		const classes = ["kanban-plugin__item"];
		if (dates.date) classes.push(dateClass(dates.date, this.input.now));
		if (card.checked && card.checkChar.toLowerCase() === "x") classes.push("is-complete");
		for (const tag of card.tags) classes.push(`has-tag-${tag.slice(1)}`);
		return classes.join(" ");
	}

	private async renderCard(card: KanbanCard): Promise<string> {
		const { settings } = this.input;
		const dates = this.cardDates(card);
		const footer: string[] = [];
		if (settings.showRelativeDate && dates.date) {
			footer.push(
				`<span class="kanban-plugin__item-metadata-date-relative">${relativeDate(dates.date, dates.time !== undefined, this.input.now)}</span>`,
			);
		}
		if (settings.showDateFooter) footer.push(await this.renderDateAndTime(dates));
		const inline: string[] = [];
		for (const field of card.inlineFields) {
			const isTask = field.wrapping === "emoji" || Boolean(TASK_FIELDS[field.key]);
			if (isTask ? !settings.moveTaskMetadata : settings.inlineMetadataPosition !== "footer")
				continue;
			inline.push(await this.renderInlineField(field));
		}
		if (inline.length > 0)
			footer.push(`<span class="kanban-plugin__item-task-metadata">${inline.join("")}</span>`);
		if (settings.showTagFooter && card.tags.length > 0) footer.push(this.renderTags(card.tags));
		const metadata = footer.filter(Boolean);
		return [
			'<div class="kanban-plugin__item-wrapper">',
			`<div class="${escapeHtmlAttribute(this.cardClasses(card, dates))}">`,
			'<div class="kanban-plugin__item-content-wrapper">',
			'<div class="kanban-plugin__item-title-wrapper">',
			this.renderCheckbox(card),
			'<div class="kanban-plugin__item-title">',
			await this.renderMarkdown(card),
			metadata.length > 0
				? `<div class="kanban-plugin__item-metadata">${metadata.join("")}</div>`
				: "",
			"</div></div>",
			await this.renderMetadataTable(card),
			"</div></div></div>",
		].join("");
	}

	private laneCount(lane: KanbanLane): string {
		if (this.input.settings.hideCardCount) return "";
		const count = lane.cards.length;
		const exceeded = lane.maxItems > 0 && lane.maxItems < count;
		const limit =
			lane.maxItems > 0
				? `<span class="kanban-plugin__lane-title-count-separator">/</span><span class="kanban-plugin__lane-title-count-limit">${lane.maxItems}</span>`
				: "";
		const label =
			lane.maxItems > 0
				? `${count} of ${lane.maxItems} cards${exceeded ? ", over the limit" : ""}`
				: `${count} cards`;
		return `<div class="kanban-plugin__lane-title-count${exceeded ? " wip-exceeded" : ""}" aria-label="${label}">${count}${limit}</div>`;
	}

	private async renderLane(lane: KanbanLane, index: number, archive: boolean): Promise<string> {
		const { settings } = this.input;
		const vertical = settings.view === "list";
		const width =
			vertical && settings.fullListLaneWidth
				? "100%"
				: settings.laneWidth
					? `${settings.laneWidth}px`
					: undefined;
		const collapsed = settings.listCollapse[index] === true;
		const wrapperClasses = [
			"kanban-plugin__lane-wrapper",
			collapsed && (vertical ? "collapse-vertical" : "collapse-horizontal"),
			archive && "kanban-plugin__archive",
		].filter(Boolean);
		const laneId = archive ? undefined : this.input.laneIds.get(lane.line);
		const id = laneId === undefined ? undefined : `${this.input.ctx.idPrefix}${laneId}`;
		const cards: string[] = [];
		for (const card of lane.cards) cards.push(await this.renderCard(card));
		const items = `<div class="kanban-plugin__lane-items kanban-plugin__vertical">${cards.join("")}</div>`;
		const body = collapsed
			? `<details class="kanban-plugin__lane-collapsed"><summary>${lane.cards.length === 1 ? "1 card" : `${lane.cards.length} cards`}</summary>${items}</details>`
			: items;
		const title = lane.title ? await this.input.ctx.renderInline(lane.title) : "";
		return [
			`<div class="${wrapperClasses.join(" ")}"${width ? ` style="width: ${width}"` : ""}>`,
			`<section class="kanban-plugin__lane"${id ? ` id="${escapeHtmlAttribute(id)}"` : ""} data-count="${lane.cards.length}"${lane.maxItems > 0 ? ` data-max-items="${lane.maxItems}"` : ""}${lane.complete ? ' data-complete="true"' : ""}>`,
			'<div class="kanban-plugin__lane-header-wrapper">',
			`<div class="kanban-plugin__lane-title"><div class="kanban-plugin__lane-title-text">${title}</div></div>`,
			this.laneCount(lane),
			"</div>",
			body,
			"</section></div>",
		].join("");
	}

	/** The archive as a lane of its own, capped at `max-archive-size` (the newest cards kept). */
	private archiveLane(board: KanbanBoard): KanbanLane | undefined {
		if (!this.input.showArchive) return undefined;
		const { maxArchiveSize } = this.input.settings;
		const cards =
			maxArchiveSize >= 0
				? board.archive.slice(board.archive.length - maxArchiveSize)
				: board.archive;
		return {
			title: "Archive",
			maxItems: 0,
			complete: false,
			line: 0,
			cards: maxArchiveSize === 0 ? [] : cards,
		};
	}

	/** Title tags coloured by `tag-colors`, scoped to this board. */
	private tagColorStyle(key: string): string {
		const rules = this.input.settings.tagColors.flatMap((color) => {
			const tag = color.tagKey.replace(/^#/, "");
			const foreground = cssColor(color.color);
			const background = cssColor(color.backgroundColor);
			if (!tag || (!foreground && !background)) return [];
			const href = tagRoutePath(tag).replace(/["\\]/g, "\\$&");
			const declarations = [
				foreground && `color: ${foreground};`,
				background && `background-color: ${background};`,
			]
				.filter(Boolean)
				.join(" ");
			const selector = `[data-kanban-board="${key}"] .kanban-plugin__item-markdown a[href$="${href}"]`;
			// A colour picked against Obsidian's light card is too dark on the dark one:
			// lighten it there, as kanban.css lightens the tags under the card.
			const dark = foreground
				? [`.dark ${selector} { color: color-mix(in srgb, ${foreground} 45%, #fff); }`]
				: [];
			return [`${selector} { ${declarations} }`, ...dark];
		});
		return rules.length > 0 ? `<style>${rules.join("\n")}</style>` : "";
	}

	private async renderTable(
		lanes: readonly { lane: KanbanLane; card: KanbanCard }[],
	): Promise<string> {
		const { settings } = this.input;
		const rows = lanes.map((row) => ({ ...row, dates: this.cardDates(row.card) }));
		const showDate =
			(settings.showRelativeDate || settings.moveDates) && rows.some((row) => row.dates.date);
		const showTags = settings.moveTags && rows.some((row) => row.card.tags.length > 0);
		const inlineKeys: string[] = [];
		if (settings.inlineMetadataPosition !== "body" || settings.moveTaskMetadata) {
			for (const { card } of rows) {
				for (const field of card.inlineFields)
					if (!inlineKeys.includes(field.key)) inlineKeys.push(field.key);
			}
		}
		const metadata = new Map<
			KanbanCard,
			Map<string, { key: Required<KanbanMetadataKey>; value: unknown }>
		>();
		const fileKeys: string[] = [];
		for (const { card } of rows) {
			const values = new Map(
				(await this.linkedMetadata(card)).map((row) => [row.key.metadataKey, row]),
			);
			metadata.set(card, values);
			for (const key of values.keys()) if (!fileKeys.includes(key)) fileKeys.push(key);
		}

		const header = (label: string) =>
			`<th><div class="kanban-plugin__table-cell-wrapper"><div class="kanban-plugin__table-header"><div>${escapeHtmlText(label)}</div></div></div></th>`;
		const cell = (html: string, extra = "") =>
			`<td${extra}><div class="kanban-plugin__table-cell-wrapper">${html}</div></td>`;
		const headers = [
			header("Card"),
			header("List"),
			showDate ? header("Date") : "",
			showTags ? header("Tags") : "",
			...inlineKeys.map((key) => header(TASK_FIELD_NAMES[key] ?? this.metadataKeyFor(key).label)),
			...fileKeys.map((key) => header(this.metadataKeyFor(key).label)),
		];
		const body: string[] = [];
		for (const { lane, card, dates } of rows) {
			const cells = [
				cell(
					`<div class="kanban-plugin__item-content-wrapper"><div class="kanban-plugin__item-title-wrapper">${this.renderCheckbox(card)}<div class="kanban-plugin__item-title">${await this.renderMarkdown(card)}</div></div></div>`,
				),
				cell(
					`<div class="kanban-plugin__cell-flex-wrapper">${lane.title ? await this.input.ctx.renderInline(lane.title) : ""}</div>`,
					' class="mod-has-icon"',
				),
			];
			if (showDate) {
				const relative =
					settings.showRelativeDate && dates.date
						? `<span class="kanban-plugin__item-metadata-date-relative">${relativeDate(dates.date, dates.time !== undefined, this.input.now)}</span>`
						: "";
				cells.push(
					cell(
						dates.date
							? relative + (settings.moveDates ? await this.renderDateAndTime(dates) : "")
							: "",
					),
				);
			}
			if (showTags) cells.push(cell(card.tags.length > 0 ? this.renderTags(card.tags) : ""));
			for (const key of inlineKeys) {
				const field = card.inlineFields.find((candidate) => candidate.key === key);
				const isTask = field && (field.wrapping === "emoji" || Boolean(TASK_FIELDS[field.key]));
				const shown =
					field &&
					(isTask ? settings.moveTaskMetadata : settings.inlineMetadataPosition !== "body");
				cells.push(cell(field && shown ? await this.renderInlineField(field) : ""));
			}
			const values = metadata.get(card);
			for (const key of fileKeys) {
				const entry = values?.get(key);
				let html = "";
				if (entry) {
					html =
						key === "tags" && Array.isArray(entry.value)
							? this.renderTags(entry.value.map(String))
							: `<span class="kanban-plugin__meta-value">${await this.renderValue(entry.value, entry.key.containsMarkdown)}</span>`;
				}
				cells.push(cell(html));
			}
			body.push(`<tr>${cells.join("")}</tr>`);
		}
		return `<div class="markdown-rendered kanban-plugin__table-wrapper" tabindex="0" role="region" aria-label="${escapeHtmlAttribute(this.boardLabel())}"><table><thead><tr>${headers.join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
	}

	private boardLabel(): string {
		const page = this.input.ctx.currentPage;
		return `Kanban board: ${page.title ?? page.baseName}`;
	}

	/** The whole board: Kanban's root, then the lanes (or the table). */
	async render(board: KanbanBoard, error?: string): Promise<string> {
		const { ctx, settings } = this.input;
		const key = boardKey(ctx.currentPage);
		const archive = this.archiveLane(board);
		const lanes = archive ? [...board.lanes, archive] : board.lanes;
		let content: string;
		if (settings.view === "table") {
			content = await this.renderTable(
				lanes.flatMap((lane) => lane.cards.map((card) => ({ lane, card }))),
			);
		} else {
			const rendered: string[] = [];
			for (const [index, lane] of lanes.entries()) {
				rendered.push(await this.renderLane(lane, index, lane === archive));
			}
			const direction =
				settings.view === "list" ? "kanban-plugin__vertical" : "kanban-plugin__horizontal";
			content = `<div class="kanban-plugin__board ${direction}" tabindex="0" role="region" aria-label="${escapeHtmlAttribute(this.boardLabel())}"><div>${rendered.join("")}</div></div>`;
		}
		const classes = ["kanban-plugin", ...ctx.currentPage.cssclasses]
			.map(escapeHtmlAttribute)
			.join(" ");
		const style = settings.laneWidth ? ` style="--lane-width: ${settings.laneWidth}px"` : "";
		const errorHtml = error
			? `<div class="kanban-plugin__error" role="alert">${escapeHtmlText(error)}</div>`
			: "";
		return `<div class="${classes}" data-kanban-board="${key}" data-kanban-view="${settings.view}"${style}>${this.tagColorStyle(key)}${errorHtml}${content}</div>`;
	}
}

function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

/** A frontmatter property, or a dotted path into one (Kanban's `getPageData`). */
function propertyAt(data: Record<string, unknown>, key: string): unknown {
	if (key in data) return data[key];
	let current: unknown = data;
	for (const part of key.split(".")) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = Reflect.get(current, part);
	}
	return current;
}

/**
 * A value Kanban shows as a date: a YAML date (read as UTC midnight, shown as
 * that calendar day) or a string starting `YYYY-MM-DD`.
 */
function metadataDate(value: unknown): Date | undefined {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return undefined;
		return new Date(
			value.getUTCFullYear(),
			value.getUTCMonth(),
			value.getUTCDate(),
			value.getUTCHours(),
			value.getUTCMinutes(),
			value.getUTCSeconds(),
		);
	}
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
	if (!match) return undefined;
	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4] ?? 0),
		Number(match[5] ?? 0),
		Number(match[6] ?? 0),
	);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

const frontmatterCache = new WeakMap<ContentIndex, Map<string, Promise<Record<string, unknown>>>>();

/** A note's frontmatter, read once per index generation. */
export function noteFrontmatter(
	page: ContentPage,
	index: ContentIndex,
): Promise<Record<string, unknown>> {
	let cache = frontmatterCache.get(index);
	if (!cache) {
		cache = new Map();
		frontmatterCache.set(index, cache);
	}
	let pending = cache.get(page.absolutePath);
	if (!pending) {
		pending = fs.promises.readFile(page.absolutePath, "utf8").then(
			(source) => {
				try {
					return parseFrontmatter(source).data;
				} catch {
					// The content index reports malformed frontmatter; the card shows none.
					return {};
				}
			},
			() => ({}),
		);
		cache.set(page.absolutePath, pending);
	}
	return pending;
}
