import { parseMomentDate } from "../../daily-notes.js";
import type { NormalizedPluginOptions } from "../../types.js";
import { readObsidianPluginSettings } from "../settings.js";
import type { TemplaterFileTemplate, TemplaterFolderTemplate } from "./options.js";

/** Templater's plugin id: its settings live in `.obsidian/plugins/templater-obsidian/`. */
export const TEMPLATER_PLUGIN_ID = "templater-obsidian";

/** Templater's settings as this site applies them: vault settings under site options. */
export interface TemplaterSettings {
	/** Vault-relative, without leading or trailing `/`; `""` when unset. */
	templatesFolder: string;
	userScriptsFolder: string;
	triggerOnFileCreation: boolean;
	/** Active folder templates (empty when the matching mode is not "folder"). */
	folderTemplates: TemplaterFolderTemplate[];
	/** Active file regex templates (empty when the matching mode is not "regex"). */
	fileTemplates: TemplaterFileTemplate[];
	ignoreFolders: string[];
	/** Names of the user system commands (`templates_pairs`), when they are enabled. */
	systemCommands: string[];
	renderCommands: "dynamic" | "all";
	/** The pinned clock; `undefined` reads the time when a template runs. */
	now?: Date;
	/** Settings that could not be applied, to report once. */
	problems: string[];
}

/** `Templates/`, `/Templates` and `Templates` alike; `/` and `` are the vault root. */
export function normalizeVaultFolder(folder: string): string {
	return folder
		.replace(/\\/g, "/")
		.replace(/^\.?\/+|\/+$/g, "")
		.trim();
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function folderRules(value: unknown): TemplaterFolderTemplate[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry: unknown) => {
		if (typeof entry !== "object" || entry === null) return [];
		const { folder, template } = entry as Record<string, unknown>;
		return typeof folder === "string" && typeof template === "string" && template
			? [{ folder, template }]
			: [];
	});
}

function regexRules(value: unknown): TemplaterFileTemplate[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry: unknown) => {
		if (typeof entry !== "object" || entry === null) return [];
		const { regex, template } = entry as Record<string, unknown>;
		return typeof regex === "string" && typeof template === "string" && template
			? [{ regex, template }]
			: [];
	});
}

/** `now` as a date: a `Date`, or `YYYY-MM-DD` with an optional time, in local time. */
function resolveNow(now: Date | string | undefined, problems: string[]): Date | undefined {
	if (now === undefined) return undefined;
	if (now instanceof Date) {
		if (!Number.isNaN(now.getTime())) return now;
	} else {
		for (const format of [
			"YYYY-MM-DDTHH:mm:ss",
			"YYYY-MM-DDTHH:mm",
			"YYYY-MM-DD HH:mm",
			"YYYY-MM-DD",
		]) {
			const parsed = parseMomentDate(now.trim(), format);
			if (parsed) return parsed;
		}
	}
	problems.push(
		`The \`templater.now\` option "${String(now)}" is not a date; using the build time.`,
	);
	return undefined;
}

const resolved = new WeakMap<
	NormalizedPluginOptions,
	{ vault: Record<string, unknown> | undefined; settings: TemplaterSettings }
>();

/**
 * Templater's settings for this site. The vault's `data.json` is read when
 * `vaultRoot` is set and `readVaultSettings` is not `false`; any option set
 * in `templater` wins over it.
 *
 * Both of Templater's settings layouts are read. The first (`data_version`
 * absent) keeps `trigger_on_file_creation`, `enable_folder_templates`,
 * `enable_file_templates` and `enable_system_commands` in `data.json`. The
 * second (`data_version: 2`) has `trigger_on_file_creation_mode` and keeps
 * the three switches in the device's local storage, out of the vault, so a
 * site cannot see them: trigger-on-creation then counts as on, and system
 * commands as off.
 */
export function resolveTemplaterSettings(options: NormalizedPluginOptions): TemplaterSettings {
	const own = options.templater;
	const vault =
		own.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(options.vaultRoot, TEMPLATER_PLUGIN_ID);
	const cached = resolved.get(options);
	if (cached && cached.vault === vault) return cached.settings;

	const problems: string[] = [];
	const mode =
		vault?.enable_folder_templates === true
			? "folder"
			: vault?.enable_file_templates === true
				? "regex"
				: stringOf(vault?.trigger_on_file_creation_mode);
	const pairs = Array.isArray(vault?.templates_pairs) ? vault.templates_pairs : [];
	const ignoreFolders =
		own.ignoreFolders ??
		(Array.isArray(vault?.ignore_folders_on_creation)
			? vault.ignore_folders_on_creation.flatMap((entry: unknown) => {
					const folder =
						typeof entry === "object" && entry !== null
							? stringOf((entry as Record<string, unknown>).folder)
							: undefined;
					return folder ? [folder] : [];
				})
			: []);

	const settings: TemplaterSettings = {
		templatesFolder: normalizeVaultFolder(
			own.templatesFolder ?? stringOf(vault?.templates_folder) ?? "",
		),
		userScriptsFolder: normalizeVaultFolder(
			own.userScriptsFolder ?? stringOf(vault?.user_scripts_folder) ?? "",
		),
		triggerOnFileCreation:
			own.triggerOnFileCreation ??
			(typeof vault?.trigger_on_file_creation === "boolean"
				? vault.trigger_on_file_creation
				: true),
		folderTemplates:
			own.folderTemplates ?? (mode === "folder" ? folderRules(vault?.folder_templates) : []),
		fileTemplates: own.fileTemplates ?? (mode === "regex" ? regexRules(vault?.file_templates) : []),
		ignoreFolders: ignoreFolders.map(normalizeVaultFolder).filter(Boolean),
		systemCommands:
			vault?.enable_system_commands === true
				? pairs.flatMap((pair: unknown) =>
						Array.isArray(pair) && typeof pair[0] === "string" && pair[0] ? [pair[0]] : [],
					)
				: [],
		renderCommands: own.renderCommands === "all" ? "all" : "dynamic",
		now: resolveNow(own.now, problems),
		problems,
	};
	resolved.set(options, { vault, settings });
	return settings;
}
