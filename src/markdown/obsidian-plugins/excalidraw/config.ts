/**
 * The feature's settings: the site's `excalidraw` options over the vault's
 * Excalidraw plugin settings, over the plugin's own defaults
 * (`settingsDefaults.ts`) — and a drawing's frontmatter over all three, as the
 * plugin lets a note override its export settings.
 */
import type { NormalizedPluginOptions } from "../../types.js";
import { readObsidianPluginSettings } from "../settings.js";
import type { ExcalidrawOptions } from "./options.js";
import type { DrawingTheme } from "./render.js";
import type { Scene } from "./scene.js";
import type { TextLinkSettings } from "./text.js";

export const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

export interface ExcalidrawSettings extends TextLinkSettings {
	theme: NonNullable<ExcalidrawOptions["theme"]>;
	preferExportedImage: boolean;
	padding: number;
	background: boolean;
	embedWidth: string;
	fonts: boolean;
	cjkFonts: boolean;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function finite(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** The settings every drawing on the site starts from. */
export function resolveSettings(options: NormalizedPluginOptions): ExcalidrawSettings {
	const own = options.excalidraw;
	const vault =
		own.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(options.vaultRoot, EXCALIDRAW_PLUGIN_ID);
	const vaultTheme = bool(vault?.previewMatchObsidianTheme)
		? "auto"
		: bool(vault?.exportWithTheme) === false
			? "light"
			: "scene";
	const width = own.embedWidth ?? text(vault?.width) ?? finite(vault?.width) ?? 400;
	return {
		theme: own.theme ?? vaultTheme,
		preferExportedImage:
			own.preferExportedImage ?? bool(vault?.displayExportedImageIfAvailable) ?? false,
		padding: own.padding ?? finite(vault?.exportPaddingSVG) ?? 10,
		background: own.background ?? bool(vault?.exportWithBackground) ?? true,
		embedWidth: typeof width === "number" || /^\d+$/.test(width) ? `${width}px` : width,
		fonts: own.fonts ?? true,
		cjkFonts: own.cjkFonts ?? false,
		brackets: bool(vault?.showLinkBrackets) ?? false,
		linkPrefix: text(vault?.linkPrefix) ?? "",
		urlPrefix: text(vault?.urlPrefix) ?? "",
	};
}

/** What one drawing is drawn with, its frontmatter applied. */
export interface DrawingSettings extends TextLinkSettings {
	theme: DrawingTheme;
	padding: number;
	background: boolean;
}

export function drawingSettings(
	settings: ExcalidrawSettings,
	frontmatter: Record<string, unknown>,
	scene: Scene,
): DrawingSettings {
	const exportDark = bool(frontmatter["excalidraw-export-dark"]);
	const theme: DrawingTheme =
		settings.theme === "scene"
			? (exportDark ?? scene.appState.theme === "dark")
				? "dark"
				: "light"
			: settings.theme;
	return {
		theme,
		padding:
			finite(frontmatter["excalidraw-export-padding"]) ??
			finite(frontmatter["excalidraw-export-svgpadding"]) ??
			settings.padding,
		background: bool(frontmatter["excalidraw-export-transparent"]) ? false : settings.background,
		brackets: bool(frontmatter["excalidraw-link-brackets"]) ?? settings.brackets,
		linkPrefix: text(frontmatter["excalidraw-link-prefix"]) ?? settings.linkPrefix,
		urlPrefix: text(frontmatter["excalidraw-url-prefix"]) ?? settings.urlPrefix,
	};
}
