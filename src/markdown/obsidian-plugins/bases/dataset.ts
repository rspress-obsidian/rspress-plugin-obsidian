/**
 * The files a base queries: every published file — notes with their
 * frontmatter properties, and every other file with file properties only.
 *
 * Built once per index generation (`WeakMap` on the index objects, which the
 * plugin replaces on each build or dev recompile) and shared by every base on
 * every page, so a 3000-note vault reads and parses each note once, not once
 * per query.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import { normalizeFsPath } from "../../../shared/route-path.js";
import { formatDailyNoteDate } from "../../daily-notes.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import { resolveWikiLink } from "../../resolve-wikilink.js";
import type {
	ContentAsset,
	ContentIndex,
	ContentPage,
	NormalizedPluginOptions,
} from "../../types.js";
import { readObsidianConfigFile } from "../settings.js";
import { type LinkRecord, type NoteLinks, noteLinks } from "./links.js";
import {
	type BaseFile,
	DateValue,
	LinkValue,
	ObjectValue,
	parseDateText,
	type Value,
} from "./values.js";

export interface Dataset {
	files: readonly BaseFile[];
	byAbsolutePath: ReadonlyMap<string, BaseFile>;
	/** The file link text written in `from` resolves to, as Obsidian resolves it. */
	resolve(target: string, from: ContentPage | undefined): BaseFile | undefined;
	/** A link value for link text written in `from` (`[[Note|Shown]]`, `Note`, `https://…`). */
	link(text: string, from: ContentPage | undefined, display?: string): LinkValue;
	/** `file.links`: the note's links, frontmatter included. */
	links(file: BaseFile): readonly LinkValue[];
	/** `file.embeds`. */
	embeds(file: BaseFile): readonly LinkValue[];
	/** `file.backlinks`: links to each file that links here. */
	backlinks(file: BaseFile): readonly LinkValue[];
	/** The dataset file of a page, or a stand-in for one outside the dataset (a generated page). */
	fileForPage(page: ContentPage, index: ContentIndex): BaseFile;
}

/** Obsidian's property types (`.obsidian/types.json`) that change how a value reads. */
type PropertyTypes = Record<string, string>;

interface CacheEntry {
	indexes: readonly ContentIndex[];
	dataset: Promise<Dataset>;
}

const cache = new WeakMap<ContentIndex, CacheEntry>();

/** The dataset over `indexes`, built once per generation of those index objects. */
export function datasetFor(
	indexes: readonly ContentIndex[],
	options: NormalizedPluginOptions,
): Promise<Dataset> {
	const [first] = indexes;
	if (!first) return buildDataset(indexes, options);
	const cached = cache.get(first);
	if (
		cached &&
		cached.indexes.length === indexes.length &&
		cached.indexes.every((index, i) => index === indexes[i])
	) {
		return cached.dataset;
	}
	const dataset = buildDataset(indexes, options);
	cache.set(first, { indexes: [...indexes], dataset });
	return dataset;
}

async function buildDataset(
	indexes: readonly ContentIndex[],
	options: NormalizedPluginOptions,
): Promise<Dataset> {
	const types = options.bases.readVaultSettings === false ? {} : propertyTypes(options.vaultRoot);
	const resolveOptions = {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};
	const files: BaseFile[] = [];
	const byAbsolutePath = new Map<string, BaseFile>();
	const pending: { file: BaseFile; raw: Record<string, unknown>; links: NoteLinks }[] = [];

	await Promise.all(
		indexes.flatMap((index) => [
			...index.pages.map(async (page) => {
				const file = fileOfPage(page, index);
				pending.push({ file, ...(await readNote(page.absolutePath)) });
				return file;
			}),
			...index.assets.map((asset) => fileOfAsset(asset, index)),
		]),
	).then((built) => {
		for (const file of built) {
			if (byAbsolutePath.has(file.absolutePath)) continue;
			byAbsolutePath.set(file.absolutePath, file);
			files.push(file);
		}
	});
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	/**
	 * The file a link path written in `from` reaches, ignoring its `#subpath`:
	 * Obsidian resolves `Other#No such heading` to `Other.md`.
	 */
	const resolveTarget = (target: string, from: ContentPage | undefined): BaseFile | undefined => {
		if (!from) return undefined;
		const base = target.split("#")[0]?.trim() ?? "";
		if (base === "") return byAbsolutePath.get(normalizeFsPath(from.absolutePath));
		// A stand-in page (a generated `.base` page) maps to the index of the file it stands for.
		const index = byAbsolutePath.get(normalizeFsPath(from.absolutePath))?.index ?? indexes[0];
		if (!index) return undefined;
		const resolved = resolveWikiLink(parseWikiLink(base, `[[${base}]]`), {
			currentPage: from,
			index,
			options: resolveOptions,
		});
		if (resolved.status !== "ok") return undefined;
		const absolutePath =
			resolved.targetPage?.absolutePath ??
			resolved.targetAsset?.absolutePath ??
			resolved.fileRoute?.absolutePath;
		return absolutePath ? byAbsolutePath.get(normalizeFsPath(absolutePath)) : undefined;
	};

	const link = (text: string, from: ContentPage | undefined, display?: string): LinkValue => {
		const inner = text.trim().replace(/^!?\[\[([\s\S]*)\]\]$/, "$1");
		if (/^[a-z][a-z\d+.-]*:/i.test(inner)) return new LinkValue(inner, display, undefined, from);
		const pipe = inner.search(/(?<!\\)\|/);
		const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
		const alias = pipe < 0 ? undefined : inner.slice(pipe + 1).trim();
		return new LinkValue(target, display ?? alias, resolveTarget(target, from), from);
	};

	const outgoing = new Map<BaseFile, { links: LinkValue[]; embeds: LinkValue[] }>();
	for (const { file, raw, links } of pending) {
		file.properties = convertProperties(raw, types, (text) => link(text, file.page));
		const toValue = (record: LinkRecord) =>
			new LinkValue(record.path, record.display, resolveTarget(record.path, file.page), file.page);
		const values = links.links.map(toValue);
		// An embed is the same link in both lists, so it resolves once.
		const embeds = values.slice(values.length - links.embeds.length);
		outgoing.set(file, { links: values, embeds });
	}

	let incoming: Map<BaseFile, LinkValue[]> | undefined;
	const backlinks = (file: BaseFile): readonly LinkValue[] => {
		if (!incoming) {
			const map = new Map<BaseFile, LinkValue[]>();
			for (const source of files) {
				const seen = new Set<BaseFile>();
				for (const target of outgoing.get(source)?.links ?? []) {
					if (!target.file || seen.has(target.file)) continue;
					seen.add(target.file);
					const list = map.get(target.file) ?? [];
					list.push(new LinkValue(source.path, source.basename, source, source.page));
					map.set(target.file, list);
				}
			}
			incoming = map;
		}
		return incoming.get(file) ?? [];
	};

	return {
		files,
		byAbsolutePath,
		resolve: (target, from) => link(target, from).file,
		link,
		links: (file) => outgoing.get(file)?.links ?? [],
		embeds: (file) => outgoing.get(file)?.embeds ?? [],
		backlinks,
		fileForPage: (page, index) =>
			byAbsolutePath.get(normalizeFsPath(page.absolutePath)) ?? fileOfPage(page, index),
	};
}

function propertyTypes(vaultRoot: string | undefined): PropertyTypes {
	const types = readObsidianConfigFile(vaultRoot, "types.json")?.types;
	if (!types || typeof types !== "object") return {};
	const result: PropertyTypes = {};
	for (const [key, value] of Object.entries(types)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/** A note's frontmatter and links, read once per index generation. */
async function readNote(
	absolutePath: string,
): Promise<{ raw: Record<string, unknown>; links: NoteLinks }> {
	let markdown: string;
	try {
		markdown = await fs.readFile(absolutePath, "utf8");
	} catch {
		return { raw: {}, links: { links: [], embeds: [] } };
	}
	let raw: Record<string, unknown> = {};
	try {
		raw = parseFrontmatter(markdown).data;
	} catch {
		// Broken frontmatter gives no properties; the content index reports it.
	}
	return { raw, links: noteLinks(markdown, raw) };
}

function pathParts(
	relativePath: string,
): Pick<BaseFile, "path" | "name" | "basename" | "ext" | "folder"> {
	const normalized = normalizeFsPath(relativePath);
	const name = path.posix.basename(normalized);
	const dot = name.lastIndexOf(".");
	const folder = path.posix.dirname(normalized);
	return {
		path: normalized,
		name,
		basename: dot > 0 ? name.slice(0, dot) : name,
		ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
		folder: folder === "." ? "/" : folder,
	};
}

function fileOfPage(page: ContentPage, index: ContentIndex): BaseFile {
	return {
		absolutePath: normalizeFsPath(page.absolutePath),
		...pathParts(page.relativePath),
		size: page.fileSizeBytes,
		ctimeMs: page.fileCtimeMs,
		mtimeMs: page.fileMtimeMs,
		index,
		page,
		properties: {},
		tags: page.tags,
	};
}

async function fileOfAsset(asset: ContentAsset, index: ContentIndex): Promise<BaseFile> {
	const stats = await fs.stat(asset.absolutePath).catch(() => undefined);
	return {
		absolutePath: normalizeFsPath(asset.absolutePath),
		...pathParts(asset.relativePath),
		size: stats?.size ?? 0,
		ctimeMs: stats ? stats.birthtimeMs || stats.ctimeMs : 0,
		mtimeMs: stats?.mtimeMs ?? 0,
		index,
		asset,
		properties: {},
		tags: [],
	};
}

const WHOLE_WIKILINK = /^!?\[\[[^\]]+\]\]$/;

/** Frontmatter → values: dates, links and the types `types.json` assigns. */
export function convertProperties(
	raw: Record<string, unknown>,
	types: PropertyTypes,
	link: (text: string) => LinkValue,
): Record<string, Value> {
	const result: Record<string, Value> = {};
	for (const [key, value] of Object.entries(raw)) {
		result[key] = convertValue(value, types[key], link);
	}
	return result;
}

function convertValue(
	raw: unknown,
	type: string | undefined,
	link: (text: string) => LinkValue,
): Value {
	if (raw === undefined || raw === null) return null;
	if (raw instanceof Date) {
		const date = dateFromYaml(raw);
		// A text property keeps the date as it is written.
		if (type !== "text") return date;
		return formatDailyNoteDate(
			new Date(date.ms),
			date.hasTime ? "YYYY-MM-DD HH:mm:ss" : "YYYY-MM-DD",
		);
	}
	if (Array.isArray(raw)) return raw.map((item) => convertValue(item, undefined, link));
	if (typeof raw === "object") {
		const entries: Record<string, Value> = {};
		for (const [key, value] of Object.entries(raw)) {
			entries[key] = convertValue(value, undefined, link);
		}
		return new ObjectValue(entries);
	}
	switch (type) {
		case "number": {
			const number = Number(raw);
			return Number.isNaN(number) ? String(raw) : number;
		}
		case "checkbox":
			return raw === true || raw === "true";
		case "text":
			return String(raw);
		case "multitext":
		case "tags":
		case "aliases":
			return [convertValue(raw, undefined, link)];
	}
	if (typeof raw === "string") {
		if (WHOLE_WIKILINK.test(raw.trim())) return link(raw);
		return parseDateText(raw) ?? raw;
	}
	if (typeof raw === "number" || typeof raw === "boolean") return raw;
	return String(raw);
}

/**
 * gray-matter's YAML reads `2024-05-01` and `2024-05-01 10:00:00` as UTC
 * instants. Obsidian reads both as local wall-clock values, so the UTC fields
 * are taken as local ones: a date property shows the day that is written.
 */
function dateFromYaml(date: Date): DateValue {
	const hasTime =
		date.getUTCHours() !== 0 ||
		date.getUTCMinutes() !== 0 ||
		date.getUTCSeconds() !== 0 ||
		date.getUTCMilliseconds() !== 0;
	const local = new Date(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate(),
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds(),
	);
	return new DateValue(local.getTime(), hasTime);
}
