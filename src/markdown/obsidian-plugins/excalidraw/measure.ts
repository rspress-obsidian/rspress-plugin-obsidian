/**
 * Text width as Excalidraw measures it: a canvas `measureText` advance, the
 * sum of the glyph advances of the font the browser picks for each
 * character, kerned within a run of one font file.
 *
 * With the optional `@excalidraw/excalidraw` peer installed, the advances
 * are read from the very font files it ships, so a text re-wrapped here
 * breaks where Excalidraw would break it. Without the peer there is nothing
 * to read, and a per-font average character width stands in.
 */
import fs from "node:fs";
import path from "node:path";
import { type FontFile, readFontFile } from "./font-file.js";
import { familyFolders } from "./fonts.js";

export interface TextMeasurer {
	/** The advance width of one line of text, in pixels. */
	lineWidth(line: string, fontSize: number, fontFamily: number): number;
}

/** Average advance of a character, in ems, per font: the estimate without the peer. */
const AVERAGE_ADVANCE: Record<number, number> = {
	1: 0.55,
	2: 0.5,
	3: 0.6,
	5: 0.55,
	6: 0.52,
	7: 0.5,
	8: 0.6,
	9: 0.5,
};
const DEFAULT_ADVANCE = 0.55;

/** Widths by the per-font average: every character the same width. */
export const estimateMeasurer: TextMeasurer = {
	lineWidth: (line, fontSize, fontFamily) =>
		[...line].length * (AVERAGE_ADVANCE[fontFamily] ?? DEFAULT_ADVANCE) * fontSize,
};

/** Every subset file of a folder, in the order the faces are declared. */
function folderFiles(fontsDir: string, folder: string): FontFile[] {
	const dir = path.join(fontsDir, folder);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.sort()
		.filter((file) => file.endsWith(".woff2"))
		.flatMap((file) => readFontFile(path.join(dir, file)) ?? []);
}

/** A character's glyph, and the file it comes from. */
interface Placed {
	file: FontFile;
	glyph: number;
}

/** Widths read from the peer's font files in `fontsDir`. */
function fontMeasurer(fontsDir: string): TextMeasurer {
	const folders = new Map<string, FontFile[]>();
	// A folder is read the first time a character falls through to it, so
	// Xiaolai's 200 files are only read for a text with a character Excalifont lacks.
	const place = (codePoint: number, fontFamily: number): Placed | undefined => {
		for (const folder of familyFolders(fontFamily)) {
			let files = folders.get(folder);
			if (!files) {
				files = folderFiles(fontsDir, folder);
				folders.set(folder, files);
			}
			for (const file of files) {
				const glyph = file.glyphs.get(codePoint);
				if (glyph !== undefined) return { file, glyph };
			}
		}
		return undefined;
	};
	return {
		lineWidth(line, fontSize, fontFamily) {
			let width = 0;
			let run: { file: FontFile; glyphs: number[] } | undefined;
			const endRun = () => {
				if (!run) return;
				const { file } = run;
				const glyphs = file.substitute(run.glyphs);
				let units = 0;
				for (let i = 0; i < glyphs.length; i += 1) {
					const glyph = glyphs[i] as number;
					units += file.advance(glyph);
					if (i > 0) units += file.kerning(glyphs[i - 1] as number, glyph);
				}
				width += (units * fontSize) / file.unitsPerEm;
				run = undefined;
			};
			for (const char of line) {
				const placed = place(char.codePointAt(0) ?? 0, fontFamily);
				// A browser shapes text word by word, and each font file apart:
				// kerning and ligatures never reach across a space or a font change.
				if (!placed || /\s/.test(char) || placed.file !== run?.file) endRun();
				if (!placed) {
					// A character none of the fonts has: the system's fallback font draws it.
					width += (AVERAGE_ADVANCE[fontFamily] ?? DEFAULT_ADVANCE) * fontSize;
					continue;
				}
				run ??= { file: placed.file, glyphs: [] };
				run.glyphs.push(placed.glyph);
				if (/\s/.test(char)) endRun();
			}
			endRun();
			return width;
		},
	};
}

const measurers = new Map<string, TextMeasurer>();

/** How text is measured: from the peer's fonts when `fontsDir` is known, else by estimate. */
export function textMeasurer(fontsDir: string | undefined): TextMeasurer {
	if (!fontsDir) return estimateMeasurer;
	let measurer = measurers.get(fontsDir);
	if (!measurer) {
		measurer = fontMeasurer(fontsDir);
		measurers.set(fontsDir, measurer);
	}
	return measurer;
}
