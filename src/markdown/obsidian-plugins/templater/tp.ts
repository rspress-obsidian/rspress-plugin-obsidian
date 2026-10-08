/**
 * The `tp` object a template sees, rebuilt for a static build.
 *
 * Everything that reads the vault (`tp.file`, `tp.frontmatter`, `tp.config`)
 * or the clock (`tp.date`) behaves as in Obsidian. Everything that needs a
 * person or a live app — a prompt, the clipboard, the cursor, renaming the
 * note, the network, user scripts, the Obsidian API — cannot happen at build
 * time: it returns the closest static value and is reported.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { stripFrontmatter } from "../../../shared/frontmatter.js";
import { formatDailyNoteDate } from "../../daily-notes.js";
import { expandCommands } from "./engine.js";
import {
	HostFunction,
	HostObject,
	HostValue,
	invoke,
	type ProgramRuntime,
	type RunBudget,
	TemplaterError,
	toTemplateString,
} from "./interpreter.js";
import { addDuration, momentFunction, parseDateText, parseMomentDuration } from "./moment.js";

/** Templater's `RunMode`, which `tp.config.run_mode` reports. */
export const RUN_MODE = {
	CreateNewFromTemplate: 0,
	AppendActiveFile: 1,
	OverwriteFile: 2,
	OverwriteActiveFile: 3,
	DynamicProcessor: 4,
	StartupTemplate: 5,
} as const;

export type RunMode = (typeof RUN_MODE)[keyof typeof RUN_MODE];

/** How deep `tp.file.include` may nest, as in Templater. */
export const INCLUDE_DEPTH_LIMIT = 10;

/** A vault file as templates see it: Obsidian's `TFile` fields. */
export class VaultFile extends HostValue {
	readonly label = "TFile";
	readonly name: string;
	readonly basename: string;
	readonly extension: string;

	constructor(
		/** Vault-relative, `/`-separated. */
		readonly path: string,
		/** Where the file is on disk; not visible to templates. */
		readonly absolutePath: string,
		readonly stat: { ctime: number; mtime: number; size: number },
	) {
		super();
		this.name = path.split("/").pop() ?? path;
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
	}

	/** The folder's vault path (`/` for the vault root), as `TFolder.path`. */
	get folderPath(): string {
		const slash = this.path.lastIndexOf("/");
		return slash < 0 ? "/" : this.path.slice(0, slash);
	}

	override property(name: string): unknown {
		switch (name) {
			case "path":
				return this.path;
			case "name":
				return this.name;
			case "basename":
				return this.basename;
			case "extension":
				return this.extension;
			case "stat":
				return { ...this.stat };
			case "parent": {
				const folder = this.folderPath;
				return new HostObject("TFolder", {
					path: folder,
					name: folder === "/" ? "" : (folder.split("/").pop() ?? ""),
				});
			}
		}
		return undefined;
	}
}

/** What a template run reads and where it reports. */
export interface TemplaterHost {
	/** The clock `tp.date`, `moment()` and `new Date()` read. */
	now: Date;
	/** The note the template is applied to, or whose dynamic commands run. */
	target: VaultFile;
	/** The template being applied (`tp.config.template_file`). */
	templateFile?: VaultFile;
	runMode: RunMode;
	/** The vault root (the docs root without a vault): what `tp.file.path()` and `exists` read. */
	root: string;
	/** The target's tags, `#`-prefixed, as Obsidian's `getAllTags`. */
	tags: string[];
	/** The target's frontmatter. */
	frontmatter: Record<string, unknown>;
	/** The target's file content when the template runs. */
	content: string;
	/** User system command names (`templates_pairs`), which are reported rather than run. */
	systemCommands: readonly string[];
	/** The file a link path names (`MyFile`, `Folder/MyFile`), as Obsidian's link resolution finds it. */
	findFile(linkpath: string): Promise<VaultFile | undefined>;
	/** Report under the Templater scope (`"warn"`: never fails the build). */
	report(message: string, mode?: "warn"): void;
	/** The in-place marker for a failed command, which is also reported. */
	errorMarker(message: string, command: string): string;
}

/** One expansion, with its includes: the include depth and the hooks registered. */
interface Session {
	host: TemplaterHost;
	depth: number;
	hooks: HostFunction[];
	globals: Record<string, unknown>;
	/** Each unreproducible call is reported once per expansion, not once per loop pass. */
	reported: Set<string>;
	/** One step budget for the template and everything it includes. */
	budget: RunBudget;
}

function warnOnce(session: Session, message: string): void {
	if (session.reported.has(message)) return;
	session.reported.add(message);
	session.host.report(message, "warn");
}

function runtimeOf(session: Session): ProgramRuntime {
	return {
		globals: session.globals,
		now: session.host.now,
		onError: (message, command) => session.host.errorMarker(message, command),
		budget: session.budget,
	};
}

/** A function that returns `value` and reports why it does nothing more here. */
function inert(session: Session, label: string, reason: string, value: unknown = ""): HostFunction {
	return new HostFunction(label, () => {
		warnOnce(session, `\`${label}\` ${reason}`);
		return value;
	});
}

function formatOf(value: unknown, fallback: string): string {
	return value === undefined || value === null ? fallback : toTemplateString(value);
}

/** `moment(reference, reference_format)`, or the clock, as `tp.date` reads its reference. */
function referenceDate(host: TemplaterHost, reference: unknown, referenceFormat: unknown): Date {
	if (reference === undefined || reference === null || reference === "") {
		return new Date(host.now.getTime());
	}
	const parsed = parseDateText(toTemplateString(reference), referenceFormat ?? undefined, {
		now: host.now,
	});
	if (!parsed) {
		throw new TemplaterError(
			"Invalid reference date format, try specifying one with the argument 'reference_format'",
		);
	}
	return parsed;
}

function dateModule(host: TemplaterHost): HostObject {
	const relativeDay = (days: number) =>
		new HostFunction("tp.date", ([format]) =>
			formatDailyNoteDate(
				addDuration(host.now, { months: 0, days, milliseconds: 0 }),
				formatOf(format, "YYYY-MM-DD"),
			),
		);
	return new HostObject("tp.date", {
		now: new HostFunction("tp.date.now", ([format, offset, reference, referenceFormat]) => {
			const date = referenceDate(host, reference, referenceFormat);
			const duration =
				typeof offset === "string"
					? parseMomentDuration(offset)
					: typeof offset === "number"
						? { months: 0, days: offset, milliseconds: 0 }
						: undefined;
			return formatDailyNoteDate(
				duration ? addDuration(date, duration) : date,
				formatOf(format, "YYYY-MM-DD"),
			);
		}),
		tomorrow: relativeDay(1),
		yesterday: relativeDay(-1),
		weekday: new HostFunction(
			"tp.date.weekday",
			([format, weekday, reference, referenceFormat]) => {
				const date = referenceDate(host, reference, referenceFormat);
				date.setDate(date.getDate() + Number(weekday ?? 0) - date.getDay());
				return formatDailyNoteDate(date, formatOf(format, "YYYY-MM-DD"));
			},
		),
	});
}

const LINK = /^\[\[(.*)\]\]$/;

/** Headings and block ids are matched loosely, as Obsidian's link resolution does. */
function normalizeHeading(text: string): string {
	return text
		.replace(/[#^|[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * The part of `content` a `#subpath` names: a heading's section (the heading
 * line through the next heading of the same or a higher level, nested as
 * `A#B`), or the block carrying `^id`. `undefined` when it is not there.
 */
export function sliceSubpath(content: string, subpath: string): string | undefined {
	const lines = content.split("\n");
	const headings: Array<{ line: number; level: number; text: string }> = [];
	let fence: string | undefined;
	for (const [index, line] of lines.entries()) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (!fence || marker.startsWith(fence))) {
			fence = fence ? undefined : marker;
			continue;
		}
		if (fence) continue;
		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			headings.push({
				line: index,
				level: heading[1]?.length ?? 1,
				text: normalizeHeading(heading[2] ?? ""),
			});
		}
	}

	if (subpath.startsWith("^")) {
		const id = subpath.slice(1);
		// Block ids are `[A-Za-z0-9-]`, so the id needs no escaping in the pattern.
		const at = lines.findIndex((line) =>
			/^[\w-]+$/.test(id) ? new RegExp(`(?:^|\\s)\\^${id}\\s*$`).test(line) : false,
		);
		if (at < 0) return undefined;
		const own = lines[at] ?? "";
		// A list item is its own block; a paragraph (or an id on the line after a
		// block) runs back to a blank line or to the heading, item or fence before it.
		if (/^\s*(?:[-*+]|\d+[.)])\s/.test(own)) return own;
		let start = own.trim() === `^${id}` ? at - 1 : at;
		while (
			start > 0 &&
			!/^\s*$|^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/.test(lines[start - 1] ?? "")
		) {
			start -= 1;
		}
		return lines.slice(Math.max(0, start), at + 1).join("\n");
	}

	let from = 0;
	let found: { line: number; level: number } | undefined;
	for (const segment of subpath.split("#").filter(Boolean)) {
		const wanted = normalizeHeading(segment);
		const next = headings.find((heading) => heading.line >= from && heading.text === wanted);
		if (!next) return undefined;
		found = next;
		from = next.line + 1;
	}
	if (!found) return undefined;
	const level = found.level;
	const end = headings.find(
		(heading) => heading.line > (found?.line ?? 0) && heading.level <= level,
	);
	return lines.slice(found.line, end ? end.line : lines.length).join("\n");
}

async function include(session: Session, link: unknown): Promise<string> {
	const { host } = session;
	let file: VaultFile | undefined;
	let subpath: string | undefined;
	if (link instanceof VaultFile) {
		file = link;
	} else {
		const match = LINK.exec(toTemplateString(link).trim());
		if (!match) {
			throw new TemplaterError("Invalid file format, provide an obsidian link between quotes.");
		}
		const inner = (match[1] ?? "").split("|")[0] ?? "";
		const hash = inner.indexOf("#");
		const target = hash < 0 ? inner : inner.slice(0, hash);
		subpath = hash < 0 ? undefined : inner.slice(hash + 1);
		file = await host.findFile(target.trim());
		if (!file) throw new TemplaterError(`File ${toTemplateString(link)} doesn't exist`);
	}
	if (session.depth >= INCLUDE_DEPTH_LIMIT) {
		throw new TemplaterError(`Reached inclusion depth limit (max = ${INCLUDE_DEPTH_LIMIT})`);
	}
	let content = await fs.readFile(file.absolutePath, "utf8");
	if (subpath) {
		const section = sliceSubpath(content, subpath);
		if (section !== undefined) content = section;
	} else {
		// The included note's properties belong to that note; spliced into
		// the middle of another they would render as a rule and stray text.
		content = stripFrontmatter(content);
	}
	session.depth += 1;
	try {
		return await expandCommands(content, runtimeOf(session), { keepDynamic: true });
	} finally {
		session.depth -= 1;
	}
}

function fileModule(session: Session): HostObject {
	const { host } = session;
	const target = host.target;
	const unsupported = "cannot change the vault from a static site; it was skipped.";
	return new HostObject("tp.file", {
		title: target.basename,
		content: host.content,
		tags: [...host.tags],
		creation_date: new HostFunction("tp.file.creation_date", ([format]) =>
			formatDailyNoteDate(new Date(target.stat.ctime), formatOf(format, "YYYY-MM-DD HH:mm")),
		),
		last_modified_date: new HostFunction("tp.file.last_modified_date", ([format]) =>
			formatDailyNoteDate(new Date(target.stat.mtime), formatOf(format, "YYYY-MM-DD HH:mm")),
		),
		folder: new HostFunction("tp.file.folder", ([absolute]) => {
			const folder = target.folderPath;
			if (absolute) return folder;
			return folder === "/" ? "" : (folder.split("/").pop() ?? "");
		}),
		path: new HostFunction("tp.file.path", ([relative]) =>
			relative ? target.path : path.join(host.root, target.path).split(path.sep).join("/"),
		),
		selection: new HostFunction("tp.file.selection", () => ""),
		// The cursor is where Obsidian puts the caret after inserting a
		// template; a published page has no caret, so the marker goes.
		cursor: new HostFunction("tp.file.cursor", () => ""),
		cursor_append: inert(
			session,
			"tp.file.cursor_append",
			"writes at the editor's cursor, which a static site does not have; nothing was inserted.",
		),
		exists: new HostFunction("tp.file.exists", async ([filepath]) => {
			const relative = toTemplateString(filepath ?? "").replace(/^\/+/, "");
			const absolute = path.resolve(host.root, relative);
			if (absolute !== host.root && !absolute.startsWith(host.root + path.sep)) return false;
			return fs.stat(absolute).then(
				() => true,
				() => false,
			);
		}),
		find_tfile: new HostFunction("tp.file.find_tfile", async ([filename]) => {
			return (await host.findFile(toTemplateString(filename ?? "").replace(/^\/+/, ""))) ?? null;
		}),
		include: new HostFunction("tp.file.include", ([link]) => include(session, link)),
		// The file is not created, but the template still gets the `TFile`
		// Templater returns, so `[[<% (await tp.file.create_new(…)).basename %>]]`
		// writes the link Obsidian would have written instead of `[[undefined]]`.
		create_new: new HostFunction("tp.file.create_new", ([, filename, , folder]) => {
			warnOnce(session, `\`tp.file.create_new\` ${unsupported}`);
			const name = toTemplateString(filename ?? "Untitled") || "Untitled";
			const parent =
				typeof folder === "string"
					? folder.replace(/^\/+|\/+$/g, "")
					: target.folderPath === "/"
						? ""
						: target.folderPath;
			const relative = `${parent ? `${parent}/` : ""}${name}.md`;
			const now = host.now.getTime();
			return new VaultFile(relative, path.join(host.root, relative), {
				ctime: now,
				mtime: now,
				size: 0,
			});
		}),
		move: inert(session, "tp.file.move", unsupported),
		rename: inert(session, "tp.file.rename", unsupported),
		delete: inert(session, "tp.file.delete", unsupported),
	});
}

function systemModule(session: Session): HostObject {
	return new HostObject("tp.system", {
		prompt: new HostFunction("tp.system.prompt", ([promptText, defaultValue]) => {
			if (defaultValue !== undefined && defaultValue !== null) return defaultValue;
			warnOnce(
				session,
				`\`tp.system.prompt(${JSON.stringify(toTemplateString(promptText ?? ""))})\` has no default value and nobody to answer it on a static site; it was left empty.`,
			);
			return "";
		}),
		suggester: new HostFunction(
			"tp.system.suggester",
			async ([textItems, items, , placeholder, , defaultValue]) => {
				const choice =
					defaultValue !== undefined ? defaultValue : Array.isArray(items) ? items[0] : undefined;
				const shown =
					textItems instanceof HostFunction
						? await invoke(textItems, [choice])
						: Array.isArray(textItems) && Array.isArray(items)
							? textItems[items.indexOf(choice)]
							: choice;
				warnOnce(
					session,
					`\`tp.system.suggester(${placeholder ? JSON.stringify(toTemplateString(placeholder)) : "…"})\` cannot ask on a static site; it chose ${JSON.stringify(toTemplateString(shown ?? choice ?? ""))}.`,
				);
				return choice ?? null;
			},
		),
		multi_suggester: new HostFunction("tp.system.multi_suggester", ([, , , , , defaultValues]) => {
			warnOnce(
				session,
				"`tp.system.multi_suggester` cannot ask on a static site; it chose its default values.",
			);
			return Array.isArray(defaultValues) ? [...defaultValues] : [];
		}),
		clipboard: inert(
			session,
			"tp.system.clipboard",
			"reads a clipboard a static build does not have; it was left empty.",
		),
	});
}

function webModule(session: Session): HostObject {
	// A build that fetched quotes, pictures or URLs would publish different
	// pages on every run, and fail offline: the network stays off.
	const reason =
		"makes a network request; builds stay offline and reproducible, so it was left empty.";
	return new HostObject("tp.web", {
		daily_quote: inert(session, "tp.web.daily_quote", reason),
		random_picture: inert(session, "tp.web.random_picture", reason),
		request: inert(session, "tp.web.request", reason),
	});
}

function userModule(session: Session): HostObject {
	return new HostObject("tp.user", {}, (name) =>
		session.host.systemCommands.includes(name)
			? inert(
					session,
					`tp.user.${name}`,
					"is a user system command; shell commands never run during a site build, so it was left empty.",
				)
			: inert(
					session,
					`tp.user.${name}`,
					"is a user script; arbitrary JavaScript does not run during a site build, so it was left empty.",
				),
	);
}

function createSession(host: TemplaterHost): Session {
	const session: Session = {
		host,
		depth: 0,
		hooks: [],
		globals: {},
		reported: new Set(),
		budget: { steps: 0, depth: 0 },
	};
	const { target } = host;
	const tp = new HostObject(
		"tp",
		{
			date: dateModule(host),
			file: fileModule(session),
			frontmatter: { ...host.frontmatter },
			config: new HostObject("tp.config", {
				template_file: host.templateFile,
				target_file: target,
				run_mode: host.runMode,
				active_file: target,
			}),
			system: systemModule(session),
			web: webModule(session),
			hooks: new HostObject("tp.hooks", {
				on_all_templates_executed: new HostFunction(
					"tp.hooks.on_all_templates_executed",
					([callback]) => {
						if (!(callback instanceof HostFunction)) {
							throw new TemplaterError("on_all_templates_executed() needs a function.");
						}
						session.hooks.push(callback);
						return undefined;
					},
				),
			}),
			user: userModule(session),
		},
		(name) => {
			if (name === "app" || name === "obsidian") {
				throw new TemplaterError(
					`\`tp.${name}\` is Obsidian's live API, which a static site does not have.`,
				);
			}
			return undefined;
		},
	);
	session.globals = { tp, moment: momentFunction(host.now) };
	return session;
}

/**
 * Run Templater over `source` for `host.target` and return the text it
 * produces. `keepDynamic` copies `<%+ %>` commands through, as when a
 * template is applied; the hooks registered with
 * `tp.hooks.on_all_templates_executed` run once everything is expanded.
 */
export async function expandWithTp(
	source: string,
	host: TemplaterHost,
	keepDynamic: boolean,
): Promise<string> {
	const session = createSession(host);
	const output = await expandCommands(source, runtimeOf(session), { keepDynamic });
	for (const hook of session.hooks) {
		try {
			await hook.call([]);
		} catch (error) {
			host.errorMarker(
				error instanceof Error ? error.message : String(error),
				"tp.hooks.on_all_templates_executed",
			);
		}
	}
	return output;
}
