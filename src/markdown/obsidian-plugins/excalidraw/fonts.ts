/**
 * Excalidraw's fonts: the family each `fontFamily` id names, the metrics text
 * is laid out with, and — when the optional `@excalidraw/excalidraw` peer is
 * installed — the `.woff2` files it ships, served with the site so a drawing
 * reads in Excalifont, Nunito or Comic Shanns exactly as it does in Obsidian.
 *
 * Excalidraw splits each family into subsets with a `unicode-range` apiece.
 * The ranges are read from each file's own `cmap` table rather than copied
 * from Excalidraw's source, so they stay right whichever version is
 * installed.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { moduleDir } from "../../../runtime-paths.js";
import { readFontFile } from "./font-file.js";

export interface FontMetrics {
	unitsPerEm: number;
	ascender: number;
	descender: number;
}

interface FontFamily {
	/** The CSS family name Excalidraw registers. */
	name: string;
	/** Folder under the package's `dist/prod/fonts/`, when it ships the font. */
	folder?: string;
	/** The shipped font whose widths it has, for a family the peer does not ship. */
	measuredBy?: string;
	/** What a reader without the font sees instead. */
	fallback: string;
	metrics: FontMetrics;
}

const HAND_DRAWN_FALLBACK = `"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive`;
const EMOJI = "Segoe UI Emoji";
const EXCALIFONT_METRICS: FontMetrics = { unitsPerEm: 1000, ascender: 886, descender: -374 };

/** Excalidraw's `FONT_FAMILY` ids and `FONT_METADATA`. */
const FONT_FAMILIES: Record<number, FontFamily> = {
	1: {
		name: "Virgil",
		folder: "Virgil",
		fallback: HAND_DRAWN_FALLBACK,
		metrics: EXCALIFONT_METRICS,
	},
	2: {
		name: "Helvetica",
		fallback: "Arial, sans-serif",
		// Liberation Sans is metric-compatible with Helvetica and Arial.
		measuredBy: "Liberation",
		metrics: { unitsPerEm: 2048, ascender: 1577, descender: -471 },
	},
	3: {
		name: "Cascadia",
		folder: "Cascadia",
		fallback: `"Cascadia Code", Consolas, ui-monospace, monospace`,
		metrics: { unitsPerEm: 2048, ascender: 1900, descender: -480 },
	},
	5: {
		name: "Excalifont",
		folder: "Excalifont",
		fallback: HAND_DRAWN_FALLBACK,
		metrics: EXCALIFONT_METRICS,
	},
	6: {
		name: "Nunito",
		folder: "Nunito",
		fallback: `"Segoe UI", system-ui, sans-serif`,
		metrics: { unitsPerEm: 1000, ascender: 1011, descender: -353 },
	},
	7: {
		name: "Lilita One",
		folder: "Lilita",
		fallback: `Impact, "Arial Black", sans-serif`,
		metrics: { unitsPerEm: 1000, ascender: 923, descender: -220 },
	},
	8: {
		name: "Comic Shanns",
		folder: "ComicShanns",
		fallback: `"Comic Sans MS", ui-monospace, monospace`,
		metrics: { unitsPerEm: 1000, ascender: 750, descender: -250 },
	},
	9: {
		name: "Liberation Sans",
		folder: "Liberation",
		fallback: "Arial, sans-serif",
		metrics: { unitsPerEm: 2048, ascender: 1854, descender: -434 },
	},
};

/** Excalidraw's hand-drawn CJK fallback, behind Excalifont. */
const CJK_FAMILY = { name: "Xiaolai", folder: "Xiaolai" };

/** Excalidraw's own font for an id it does not know. */
const UNKNOWN_FAMILY = FONT_FAMILIES[5] as FontFamily;

function familyOf(id: number): FontFamily {
	return FONT_FAMILIES[id] ?? UNKNOWN_FAMILY;
}

/**
 * The `font-family` of a text element: Excalidraw's own list
 * (`getFontFamilyString`), then a system stack for a reader without the font.
 */
export function fontFamilyCss(id: number): string {
	const family = familyOf(id);
	const cjk = id === 5 ? `, ${CJK_FAMILY.name}` : "";
	return `${family.name}${cjk}, ${EMOJI}, ${family.fallback}`;
}

/** Where the first baseline sits below a line box's top (`getVerticalOffset`). */
export function baselineOffset(id: number, fontSize: number, lineHeightPx: number): number {
	const { unitsPerEm, ascender, descender } = familyOf(id).metrics;
	const em = fontSize / unitsPerEm;
	return em * ascender + (lineHeightPx - em * ascender + em * descender) / 2;
}

/** The family names a set of font ids uses, for the `@font-face` rules a drawing needs. */
export function familyNames(ids: Iterable<number>): Set<string> {
	const names = new Set<string>();
	for (const id of ids) {
		names.add(familyOf(id).name);
		if (id === 5) names.add(CJK_FAMILY.name);
	}
	return names;
}

/**
 * The font folders a browser looks a character of family `id` up in, in
 * order — the family's own, then Xiaolai behind Excalifont — as the canvas
 * Excalidraw measures with falls back through its `font-family` list.
 */
export function familyFolders(id: number): string[] {
	const family = familyOf(id);
	const own = family.folder ?? family.measuredBy;
	return [...(own ? [own] : []), ...(id === 5 ? [CJK_FAMILY.folder] : [])];
}

/**
 * The `dist/prod/fonts` folder of the installed `@excalidraw/excalidraw`, or
 * `undefined` when the optional peer is absent. Resolved from this package's
 * directory, as `isMermaidInstalled` resolves mermaid, so a hoisted, pnpm or
 * workspace install answers the way the site's build would.
 */
export function excalidrawFontsDir(fromDir: string = moduleDir): string | undefined {
	try {
		const entry = createRequire(path.join(fromDir, "noop.js")).resolve("@excalidraw/excalidraw");
		const dir = path.join(path.dirname(entry), "..", "prod", "fonts");
		return fs.existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** One `@font-face`: a subset file of a family and the characters it covers. */
export interface FontFace {
	family: string;
	/** `<Folder>/<file>.woff2`, relative to the fonts folder. */
	file: string;
	unicodeRange: string;
}

/** Code points as a CSS `unicode-range`: `U+20-7e,U+a0`. */
export function unicodeRange(codePoints: readonly number[]): string {
	const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		const start = sorted[i] as number;
		let end = start;
		while (sorted[i + 1] === end + 1) {
			end += 1;
			i += 1;
		}
		i += 1;
		ranges.push(
			start === end ? `U+${start.toString(16)}` : `U+${start.toString(16)}-${end.toString(16)}`,
		);
	}
	return ranges.join(",");
}

const facesByDir = new Map<string, FontFace[]>();

/**
 * Every subset file the peer ships, with the characters it covers — read once
 * per process. `cjk` adds Xiaolai, Excalidraw's hand-drawn CJK fallback
 * (around 200 files, 12 MB).
 */
export function excalidrawFontFaces(fontsDir: string, cjk: boolean): FontFace[] {
	const key = `${fontsDir}\u0000${cjk}`;
	const cached = facesByDir.get(key);
	if (cached) return cached;
	const families = [
		...Object.values(FONT_FAMILIES).flatMap((family) =>
			family.folder ? [{ name: family.name, folder: family.folder }] : [],
		),
		...(cjk ? [CJK_FAMILY] : []),
	];
	const faces: FontFace[] = [];
	for (const family of families) {
		const dir = path.join(fontsDir, family.folder);
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
		for (const file of files) {
			if (!file.endsWith(".woff2")) continue;
			const glyphs = readFontFile(path.join(dir, file))?.glyphs;
			const range = glyphs ? unicodeRange([...glyphs.keys()]) : "";
			if (range)
				faces.push({ family: family.name, file: `${family.folder}/${file}`, unicodeRange: range });
		}
	}
	facesByDir.set(key, faces);
	return faces;
}

/** URL path, under the site, that the font files are served at. */
export const FONT_URL_DIR = "excalidraw-fonts";

/** `@font-face` rules for the families a drawing uses, pointing at the served files. */
export function fontFaceCss(
	faces: readonly FontFace[],
	families: ReadonlySet<string>,
	siteBase: string,
): string {
	return faces
		.filter((face) => families.has(face.family))
		.map(
			(face) =>
				`@font-face{font-family:"${face.family}";src:url(${siteBase}${FONT_URL_DIR}/${face.file}) format("woff2");unicode-range:${face.unicodeRange};font-display:swap}`,
		)
		.join("");
}
