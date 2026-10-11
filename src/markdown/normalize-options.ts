import path from "node:path";
import { normalizeRoutePrefix } from "../shared/route-path.js";
import { normalizeDailyNoteConfig } from "./daily-notes.js";
import type { NormalizedPluginOptions, RspressPluginMarkdownOptions } from "./types.js";

/** Every option with its default applied — the one object each stage reads. */
export function normalizePluginOptions(
	options: RspressPluginMarkdownOptions = {},
): NormalizedPluginOptions {
	return {
		vaultRoot: options.vaultRoot ? path.resolve(process.cwd(), options.vaultRoot) : undefined,
		vaultRoutePrefix: normalizeRoutePrefix(options.vaultRoutePrefix, "/vault"),
		onBrokenLink: options.onBrokenLink ?? "error",
		// Obsidian always resolves a name several files share (same folder, then
		// shortest path), so an ambiguous link is a warning, not a failed build.
		onAmbiguousLink: options.onAmbiguousLink ?? "warn",
		enableFuzzyMatching: options.enableFuzzyMatching ?? false,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup ?? true,
		enableMarkdownLinks: options.enableMarkdownLinks ?? true,
		onDataviewError: options.onDataviewError ?? "error",
		onUnsupportedBlock: options.onUnsupportedBlock ?? "warn",
		enableDataview: options.enableDataview ?? false,
		enableDailyNotes: options.enableDailyNotes ?? false,
		dailyNotes: normalizeDailyNoteConfig(options.dailyNotes),
		enableTagLinking: options.enableTagLinking ?? false,
		enableCallouts: options.enableCallouts ?? false,
		// Mentions render inside the backlinks panel, so asking for them asks for it.
		enableBacklinks: (options.enableBacklinks ?? false) || options.enableUnlinkedMentions === true,
		enableUnlinkedMentions: options.enableUnlinkedMentions ?? false,
		enableTransclusion: options.enableTransclusion ?? false,
		enableMediaEmbeds: options.enableMediaEmbeds ?? false,
		enableTagPages: options.enableTagPages ?? false,
		enableMath: options.enableMath ?? false,
		mathEngine: options.mathEngine ?? "katex",
		enableMermaid: options.enableMermaid ?? false,
		mermaidSecurityLevel: options.mermaidSecurityLevel ?? "strict",
		enableDefaultStyles: options.enableDefaultStyles ?? false,
		strictLineBreaks: options.strictLineBreaks,
		enableTasks: options.enableTasks ?? false,
		tasks: options.tasks ?? {},
		enableKanban: options.enableKanban ?? false,
		kanban: options.kanban ?? {},
		enableExcalidraw: options.enableExcalidraw ?? false,
		excalidraw: options.excalidraw ?? {},
		enableBases: options.enableBases ?? false,
		bases: options.bases ?? {},
		enableTemplater: options.enableTemplater ?? false,
		templater: options.templater ?? {},
		onPluginError: options.onPluginError ?? "error",
	};
}
