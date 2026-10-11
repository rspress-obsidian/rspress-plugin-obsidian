import fs from "node:fs";
import path from "node:path";

/** Obsidian's default configuration folder; a vault may rename it. */
export const DEFAULT_CONFIG_DIR = ".obsidian";

const cache = new Map<string, { mtimeMs: number; value: Record<string, unknown> | undefined }>();

/**
 * A JSON file from the vault's Obsidian configuration folder, parsed — or
 * `undefined` when the vault has none, it is unreadable, or it is not a JSON
 * object. Re-read whenever the file changes, so `rspress dev` sees a setting
 * changed in Obsidian.
 *
 * The configuration folder is never indexed or published; features read the
 * few files that decide how their syntax renders (Tasks' global filter,
 * Templater's folders) so a site matches the vault without restating them.
 */
export function readObsidianConfigFile(
	vaultRoot: string | undefined,
	relativePath: string,
	configDir: string = DEFAULT_CONFIG_DIR,
): Record<string, unknown> | undefined {
	if (!vaultRoot) return undefined;
	const file = path.join(vaultRoot, configDir, relativePath);
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		cache.delete(file);
		return undefined;
	}
	const cached = cache.get(file);
	if (cached?.mtimeMs === mtimeMs) return cached.value;
	let value: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		value =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
	} catch {
		console.warn(
			`[rspress-plugin-obsidian:markdown] ${file} is not valid JSON; its settings are ignored.`,
		);
		value = undefined;
	}
	cache.set(file, { mtimeMs, value });
	return value;
}

/** The settings a community plugin saved for this vault (`plugins/<id>/data.json`). */
export function readObsidianPluginSettings(
	vaultRoot: string | undefined,
	pluginId: string,
	configDir: string = DEFAULT_CONFIG_DIR,
): Record<string, unknown> | undefined {
	return readObsidianConfigFile(vaultRoot, path.join("plugins", pluginId, "data.json"), configDir);
}
