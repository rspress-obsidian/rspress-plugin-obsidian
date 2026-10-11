/** Options for the Excalidraw feature (`enableExcalidraw`). */
export interface ExcalidrawOptions {
	/**
	 * Read the vault's Excalidraw settings
	 * (`.obsidian/plugins/obsidian-excalidraw-plugin/data.json`). An option set here wins
	 * over the vault's setting. Default: `true`.
	 */
	readVaultSettings?: boolean;
	/**
	 * Which theme a drawing is shown in.
	 *
	 * - `"scene"`: the drawing's own theme (its `excalidraw-export-dark`
	 *   frontmatter, else the theme it was saved in) — the plugin's
	 *   `exportWithTheme`.
	 * - `"light"` / `"dark"`: always that theme.
	 * - `"auto"`: follows the site's light/dark switch, as the plugin's
	 *   `previewMatchObsidianTheme` follows Obsidian's.
	 *
	 * Default: the vault's settings (`previewMatchObsidianTheme` → `"auto"`,
	 * `exportWithTheme: false` → `"light"`), else `"scene"`.
	 */
	theme?: "scene" | "light" | "dark" | "auto";
	/**
	 * Show the image the plugin auto-exported next to a drawing
	 * (`Drawing.excalidraw.svg`, `.png`, and their `.dark`/`.light` variants)
	 * instead of drawing the scene. Default: the vault's
	 * `displayExportedImageIfAvailable`, else `false` — an export is only as
	 * current as its last save in Obsidian, and its links are not resolved
	 * against the site.
	 */
	preferExportedImage?: boolean;
	/** Space around the drawing, in pixels. Default: the vault's `exportPaddingSVG`, else `10`. */
	padding?: number;
	/** Paint the drawing's canvas colour behind it. Default: the vault's `exportWithBackground`, else `true`. */
	background?: boolean;
	/**
	 * Width of an embed that names none (`![[Drawing]]`), in pixels or any CSS
	 * length. Default: the vault's `width`, else `400`.
	 */
	embedWidth?: number | string;
	/**
	 * Serve Excalidraw's own fonts (Excalifont, Virgil, Nunito, Lilita One,
	 * Comic Shanns, Cascadia, Liberation Sans) with the site when the optional
	 * `@excalidraw/excalidraw` package is installed. Without it, or with this
	 * off, text falls back to a system stack of the same character. Default: `true`.
	 */
	fonts?: boolean;
	/** Also serve Xiaolai, Excalidraw's hand-drawn CJK font (about 12 MB). Default: `false`. */
	cjkFonts?: boolean;
}
