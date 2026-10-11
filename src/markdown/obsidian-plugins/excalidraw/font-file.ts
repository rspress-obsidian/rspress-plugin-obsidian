/**
 * A WOFF2 font read far enough to lay text out as a browser's canvas does:
 * the glyph each character maps to (`cmap`), each glyph's advance (`hmtx`,
 * with `hhea`'s metric count and `head`'s units per em), the glyphs its
 * default substitution features swap in (`GSUB`: `liga`, `calt`, …) and the
 * pair kerning of its `kern` feature (`GPOS` lookup type 2). That is all a
 * canvas `measureText` sees of a line set in the fonts Excalidraw ships:
 * their other features position marks, which have no advance.
 */
import fs from "node:fs";
import { brotliDecompressSync } from "node:zlib";

/** One font file's layout data. */
export interface FontFile {
	/** Code point → glyph id. */
	glyphs: ReadonlyMap<number, number>;
	unitsPerEm: number;
	/** A glyph's advance width, in font units. */
	advance(glyph: number): number;
	/** The `kern` adjustment between two glyphs, in font units. */
	kerning(left: number, right: number): number;
	/** A run of glyphs with the font's default substitutions made (ligatures, alternates). */
	substitute(glyphs: number[]): number[];
}

/** WOFF2's known-table index (`flags & 0x3f`); 63 means the tag follows. */
const WOFF2_TAGS = [
	"cmap",
	"head",
	"hhea",
	"hmtx",
	"maxp",
	"name",
	"OS/2",
	"post",
	"cvt ",
	"fpgm",
	"glyf",
	"loca",
	"prep",
	"CFF ",
	"VORG",
	"EBDT",
	"EBLC",
	"gasp",
	"hdmx",
	"kern",
	"LTSH",
	"PCLT",
	"VDMX",
	"vhea",
	"vmtx",
	"BASE",
	"GDEF",
	"GPOS",
	"GSUB",
];

/** The tables layout needs; the rest (outlines above all) are dropped once read. */
const KEPT: Record<string, true> = {
	cmap: true,
	head: true,
	hhea: true,
	hmtx: true,
	GPOS: true,
	GSUB: true,
};

function readBase128(buffer: Buffer, cursor: { at: number }): number {
	let value = 0;
	for (let i = 0; i < 5; i += 1) {
		const byte = buffer[cursor.at] ?? 0;
		cursor.at += 1;
		value = value * 128 + (byte & 0x7f);
		if ((byte & 0x80) === 0) return value;
	}
	throw new Error("invalid UIntBase128");
}

interface Tables {
	data: Map<string, Buffer>;
	/** Tables stored in WOFF2's transformed form. */
	transformed: Set<string>;
}

function woff2Tables(buffer: Buffer): Tables | undefined {
	if (buffer.toString("latin1", 0, 4) !== "wOF2") return undefined;
	const tableCount = buffer.readUInt16BE(12);
	const compressedLength = buffer.readUInt32BE(20);
	const cursor = { at: 48 };
	const entries: { tag: string; length: number; transformed: boolean }[] = [];
	for (let i = 0; i < tableCount; i += 1) {
		const flags = buffer[cursor.at] ?? 0;
		cursor.at += 1;
		const known = flags & 0x3f;
		let tag = WOFF2_TAGS[known] ?? "";
		if (known === 63) {
			tag = buffer.toString("latin1", cursor.at, cursor.at + 4);
			cursor.at += 4;
		}
		const version = flags >> 6;
		let length = readBase128(buffer, cursor);
		// glyf/loca are transformed at version 0, every other table at a non-zero one.
		const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
		if (transformed) length = readBase128(buffer, cursor);
		entries.push({ tag, length, transformed });
	}
	const stream = brotliDecompressSync(buffer.subarray(cursor.at, cursor.at + compressedLength));
	const tables: Tables = { data: new Map(), transformed: new Set() };
	let offset = 0;
	for (const entry of entries) {
		if (KEPT[entry.tag]) {
			// A copy, so the outlines' share of the stream can be collected.
			tables.data.set(entry.tag, Buffer.from(stream.subarray(offset, offset + entry.length)));
			if (entry.transformed) tables.transformed.add(entry.tag);
		}
		offset += entry.length;
	}
	return tables;
}

/** Code point → glyph, from the `cmap`'s Unicode format 12 subtable, else its format 4 one. */
function cmapGlyphs(cmap: Buffer): Map<number, number> {
	const count = cmap.readUInt16BE(2);
	const glyphs = new Map<number, number>();
	let format4: number | undefined;
	for (let i = 0; i < count; i += 1) {
		const record = 4 + i * 8;
		const platform = cmap.readUInt16BE(record);
		const encoding = cmap.readUInt16BE(record + 2);
		const offset = cmap.readUInt32BE(record + 4);
		const format = cmap.readUInt16BE(offset);
		if (format === 12 && (platform === 0 || (platform === 3 && encoding === 10))) {
			const groups = cmap.readUInt32BE(offset + 12);
			for (let g = 0; g < groups; g += 1) {
				const start = cmap.readUInt32BE(offset + 16 + g * 12);
				const end = cmap.readUInt32BE(offset + 20 + g * 12);
				const first = cmap.readUInt32BE(offset + 24 + g * 12);
				for (let c = start; c <= end; c += 1) glyphs.set(c, first + c - start);
			}
			return glyphs;
		}
		if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) format4 = offset;
	}
	if (format4 === undefined) return glyphs;
	const segments = cmap.readUInt16BE(format4 + 6) / 2;
	const ends = format4 + 14;
	const starts = ends + segments * 2 + 2;
	const deltas = starts + segments * 2;
	const rangeOffsets = deltas + segments * 2;
	for (let s = 0; s < segments; s += 1) {
		const end = cmap.readUInt16BE(ends + s * 2);
		const start = cmap.readUInt16BE(starts + s * 2);
		const delta = cmap.readInt16BE(deltas + s * 2);
		const rangeOffsetAt = rangeOffsets + s * 2;
		const rangeOffset = cmap.readUInt16BE(rangeOffsetAt);
		for (let c = start; c <= end && c !== 0xffff; c += 1) {
			let glyph =
				rangeOffset === 0 ? c : cmap.readUInt16BE(rangeOffsetAt + rangeOffset + (c - start) * 2);
			if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
			if (glyph !== 0) glyphs.set(c, glyph);
		}
	}
	return glyphs;
}

/** An OpenType coverage table: glyph → coverage index. */
function coverage(table: Buffer, at: number): Map<number, number> {
	const covered = new Map<number, number>();
	const format = table.readUInt16BE(at);
	const count = table.readUInt16BE(at + 2);
	for (let i = 0; i < count; i += 1) {
		if (format === 1) {
			covered.set(table.readUInt16BE(at + 4 + i * 2), i);
			continue;
		}
		const range = at + 4 + i * 6;
		const start = table.readUInt16BE(range);
		const end = table.readUInt16BE(range + 2);
		const index = table.readUInt16BE(range + 4);
		for (let glyph = start; glyph <= end; glyph += 1) covered.set(glyph, index + glyph - start);
	}
	return covered;
}

/** An OpenType class definition: glyph → class (0 when absent). */
function classes(table: Buffer, at: number): Map<number, number> {
	const classOf = new Map<number, number>();
	const format = table.readUInt16BE(at);
	if (format === 1) {
		const first = table.readUInt16BE(at + 2);
		const count = table.readUInt16BE(at + 4);
		for (let i = 0; i < count; i += 1) classOf.set(first + i, table.readUInt16BE(at + 6 + i * 2));
		return classOf;
	}
	const count = table.readUInt16BE(at + 2);
	for (let i = 0; i < count; i += 1) {
		const range = at + 4 + i * 6;
		const end = table.readUInt16BE(range + 2);
		const value = table.readUInt16BE(range + 4);
		for (let glyph = table.readUInt16BE(range); glyph <= end; glyph += 1) {
			classOf.set(glyph, value);
		}
	}
	return classOf;
}

function popcount(bits: number): number {
	let count = 0;
	for (let value = bits; value; value >>= 1) count += value & 1;
	return count;
}

/** The XAdvance of a value record, 0 when the format has none. */
function xAdvance(table: Buffer, at: number, format: number): number {
	return format & 0x4 ? table.readInt16BE(at + popcount(format & 0x3) * 2) : 0;
}

/** A pair subtable: the adjustment for a pair it covers, `undefined` for one it does not. */
type PairSubtable = (left: number, right: number) => number | undefined;

function pairSubtable(gpos: Buffer, at: number): PairSubtable | undefined {
	const format = gpos.readUInt16BE(at);
	const covered = coverage(gpos, at + gpos.readUInt16BE(at + 2));
	const format1 = gpos.readUInt16BE(at + 4);
	const format2 = gpos.readUInt16BE(at + 6);
	// A value record holds two bytes per field its format sets.
	const size1 = popcount(format1 & 0xff) * 2;
	const record = size1 + popcount(format2 & 0xff) * 2;
	// The second glyph's own XAdvance widens it, as the first's does.
	const adjust = (value: number) =>
		xAdvance(gpos, value, format1) + xAdvance(gpos, value + size1, format2);
	if (format === 1) {
		const sets = new Map<number, Map<number, number>>();
		for (const [glyph, index] of covered) {
			const set = at + gpos.readUInt16BE(at + 10 + index * 2);
			const pairs = new Map<number, number>();
			const count = gpos.readUInt16BE(set);
			for (let i = 0; i < count; i += 1) {
				const pair = set + 2 + i * (2 + record);
				pairs.set(gpos.readUInt16BE(pair), adjust(pair + 2));
			}
			sets.set(glyph, pairs);
		}
		return (left, right) => sets.get(left)?.get(right);
	}
	if (format !== 2) return undefined;
	const class1 = classes(gpos, at + gpos.readUInt16BE(at + 8));
	const class2 = classes(gpos, at + gpos.readUInt16BE(at + 10));
	const class2Count = gpos.readUInt16BE(at + 14);
	return (left, right) => {
		if (!covered.has(left)) return undefined;
		const row = (class1.get(left) ?? 0) * class2Count + (class2.get(right) ?? 0);
		return adjust(at + 16 + row * record);
	};
}

/** A lookup's type and subtables, an extension subtable followed through to the real one. */
interface Lookup {
	type: number;
	subtables: number[];
}

function readLookup(table: Buffer, index: number, extensionType: number): Lookup {
	const list = table.readUInt16BE(8);
	const lookup = list + table.readUInt16BE(list + 2 + index * 2);
	const type = table.readUInt16BE(lookup);
	const subtables: number[] = [];
	let real = type;
	for (let i = 0; i < table.readUInt16BE(lookup + 4); i += 1) {
		const at = lookup + table.readUInt16BE(lookup + 6 + i * 2);
		if (type !== extensionType) {
			subtables.push(at);
			continue;
		}
		real = table.readUInt16BE(at + 2);
		subtables.push(at + table.readUInt32BE(at + 4));
	}
	return { type: real, subtables };
}

/**
 * The lookups of a `GPOS`/`GSUB` table's `features`, under the `latn`
 * script's default language (else `DFLT`'s, else the first script's) — the
 * ones a browser applies to Latin text — in the order they run.
 */
function featureLookups(table: Buffer, features: Record<string, true>): number[] {
	const scripts = table.readUInt16BE(4);
	const featureList = table.readUInt16BE(6);
	const scriptTags = new Map<string, number>();
	for (let i = 0; i < table.readUInt16BE(scripts); i += 1) {
		const record = scripts + 2 + i * 6;
		scriptTags.set(table.toString("latin1", record, record + 4), table.readUInt16BE(record + 4));
	}
	const script = scriptTags.get("latn") ?? scriptTags.get("DFLT") ?? [...scriptTags.values()][0];
	const langSys = script === undefined ? 0 : table.readUInt16BE(scripts + script);
	if (script === undefined || langSys === 0) return [];
	const langSysAt = scripts + script + langSys;
	const indices = new Set<number>();
	for (let i = 0; i < table.readUInt16BE(langSysAt + 4); i += 1) {
		const record = featureList + 2 + table.readUInt16BE(langSysAt + 6 + i * 2) * 6;
		if (!features[table.toString("latin1", record, record + 4)]) continue;
		const featureAt = featureList + table.readUInt16BE(record + 4);
		for (let j = 0; j < table.readUInt16BE(featureAt + 2); j += 1) {
			indices.add(table.readUInt16BE(featureAt + 4 + j * 2));
		}
	}
	return [...indices].sort((a, b) => a - b);
}

/** The substitution features a browser turns on for horizontal text. */
const DEFAULT_SUBSTITUTIONS: Record<string, true> = {
	ccmp: true,
	locl: true,
	rlig: true,
	liga: true,
	clig: true,
	calt: true,
};

/** Whether the glyph at a position passes a rule's test. */
type GlyphTest = (glyph: number) => boolean;

/** A chaining rule: what must precede, form and follow the input, and its substitutions. */
interface ChainRule {
	backtrack: GlyphTest[];
	input: GlyphTest[];
	lookahead: GlyphTest[];
	/** Offset of the rule's substitution records (a count, then the records). */
	records: number;
}

/**
 * The default substitutions of a `GSUB` table, as a function over a run of
 * glyphs: single (type 1), ligature (type 4) and chaining-context (type 6)
 * lookups — Excalifont's narrower `f` before another `f`, Nunito's `fi` —
 * applied as a shaper applies them, lookup by lookup along the run.
 */
function substitutions(gsub: Buffer): (glyphs: number[]) => number[] {
	const coverages = new Map<number, Map<number, number>>();
	const coverageAt = (at: number) => {
		let covered = coverages.get(at);
		if (!covered) {
			covered = coverage(gsub, at);
			coverages.set(at, covered);
		}
		return covered;
	};
	const classDefs = new Map<number, Map<number, number>>();
	const classAt = (at: number, glyph: number) => {
		let classOf = classDefs.get(at);
		if (!classOf) {
			classOf = classes(gsub, at);
			classDefs.set(at, classOf);
		}
		return classOf.get(glyph) ?? 0;
	};
	const lookups = new Map<number, Lookup>();

	/** `count` tests read from the uint16 array at `at`, and where the array ends. */
	const readTests = (at: number, count: number, test: (value: number) => GlyphTest) => {
		const tests: GlyphTest[] = [];
		for (let k = 0; k < count; k += 1) tests.push(test(gsub.readUInt16BE(at + k * 2)));
		return { tests, end: at + count * 2 };
	};

	/** Apply a chaining rule if its context matches at `i`; the position after its input. */
	const applyRule = (glyphs: number[], i: number, rule: ChainRule): number | undefined => {
		const matches = (tests: GlyphTest[], start: number, step: number) =>
			tests.every((test, k) => {
				const glyph = glyphs[start + k * step];
				return glyph !== undefined && test(glyph);
			});
		if (
			!matches(rule.backtrack, i - 1, -1) ||
			!matches(rule.input, i, 1) ||
			!matches(rule.lookahead, i + rule.input.length, 1)
		) {
			return undefined;
		}
		const length = glyphs.length;
		for (let r = 0; r < gsub.readUInt16BE(rule.records); r += 1) {
			const record = rule.records + 2 + r * 4;
			const position = i + gsub.readUInt16BE(record);
			if (position < glyphs.length) apply(gsub.readUInt16BE(record + 2), glyphs, position);
		}
		return i + rule.input.length - (length - glyphs.length);
	};

	/** A chaining subtable at `i`: its first rule whose context matches. */
	const chain = (at: number, glyphs: number[], i: number): number | undefined => {
		const format = gsub.readUInt16BE(at);
		const glyph = glyphs[i] as number;
		if (format === 3) {
			// Coverage per position, the first input coverage listed with the rest.
			const covers = (offset: number) => (candidate: number) =>
				coverageAt(at + offset).has(candidate);
			const backtrack = readTests(at + 4, gsub.readUInt16BE(at + 2), covers);
			const input = readTests(backtrack.end + 2, gsub.readUInt16BE(backtrack.end), covers);
			const lookahead = readTests(input.end + 2, gsub.readUInt16BE(input.end), covers);
			return applyRule(glyphs, i, {
				backtrack: backtrack.tests,
				input: input.tests,
				lookahead: lookahead.tests,
				records: lookahead.end,
			});
		}
		const covered = coverageAt(at + gsub.readUInt16BE(at + 2)).get(glyph);
		if (covered === undefined || (format !== 1 && format !== 2)) return undefined;
		// Format 1 rules name glyphs; format 2 rules name classes of three class definitions.
		const test =
			format === 1
				? () => (value: number) => (candidate: number) => candidate === value
				: (classDef: number) => (value: number) => (candidate: number) =>
						classAt(at + gsub.readUInt16BE(at + classDef), candidate) === value;
		const setIndex = format === 1 ? covered : classAt(at + gsub.readUInt16BE(at + 6), glyph);
		const setsAt = format === 1 ? at + 6 : at + 12;
		if (setIndex >= gsub.readUInt16BE(setsAt - 2)) return undefined;
		const setOffset = gsub.readUInt16BE(setsAt + setIndex * 2);
		if (setOffset === 0) return undefined;
		const set = at + setOffset;
		for (let r = 0; r < gsub.readUInt16BE(set); r += 1) {
			const ruleAt = set + gsub.readUInt16BE(set + 2 + r * 2);
			const backtrack = readTests(ruleAt + 2, gsub.readUInt16BE(ruleAt), test(4));
			// The first input glyph is the covered one; the rule lists the rest.
			const input = readTests(backtrack.end + 2, gsub.readUInt16BE(backtrack.end) - 1, test(6));
			const lookahead = readTests(input.end + 2, gsub.readUInt16BE(input.end), test(8));
			const end = applyRule(glyphs, i, {
				backtrack: backtrack.tests,
				input: [() => true, ...input.tests],
				lookahead: lookahead.tests,
				records: lookahead.end,
			});
			if (end !== undefined) return end;
		}
		return undefined;
	};

	/** Apply one lookup at `i`, editing `glyphs`; the position after what it consumed. */
	const apply = (index: number, glyphs: number[], i: number): number | undefined => {
		let lookup = lookups.get(index);
		if (!lookup) {
			lookup = readLookup(gsub, index, 7);
			lookups.set(index, lookup);
		}
		const glyph = glyphs[i] as number;
		for (const at of lookup.subtables) {
			if (lookup.type === 6) {
				const end = chain(at, glyphs, i);
				if (end !== undefined) return end;
				continue;
			}
			const covered = coverageAt(at + gsub.readUInt16BE(at + 2)).get(glyph);
			if (covered === undefined) continue;
			if (lookup.type === 1) {
				glyphs[i] =
					gsub.readUInt16BE(at) === 1
						? (glyph + gsub.readInt16BE(at + 4)) & 0xffff
						: gsub.readUInt16BE(at + 6 + covered * 2);
				return i + 1;
			}
			if (lookup.type !== 4) continue;
			const set = at + gsub.readUInt16BE(at + 6 + covered * 2);
			for (let l = 0; l < gsub.readUInt16BE(set); l += 1) {
				const ligature = set + gsub.readUInt16BE(set + 2 + l * 2);
				const count = gsub.readUInt16BE(ligature + 2);
				let matched = true;
				for (let c = 1; c < count && matched; c += 1) {
					matched = glyphs[i + c] === gsub.readUInt16BE(ligature + 2 + c * 2);
				}
				if (!matched) continue;
				glyphs.splice(i, count, gsub.readUInt16BE(ligature));
				return i + 1;
			}
		}
		return undefined;
	};

	const order = featureLookups(gsub, DEFAULT_SUBSTITUTIONS);
	return (glyphs) => {
		const out = [...glyphs];
		for (const index of order) {
			for (let i = 0; i < out.length; ) i = apply(index, out, i) ?? i + 1;
		}
		return out;
	};
}

function parseFontFile(buffer: Buffer): FontFile | undefined {
	const tables = woff2Tables(buffer);
	const cmap = tables?.data.get("cmap");
	const head = tables?.data.get("head");
	const hhea = tables?.data.get("hhea");
	const hmtx = tables?.data.get("hmtx");
	if (!tables || !cmap || !head || !hhea || !hmtx) return undefined;
	const metricCount = hhea.readUInt16BE(34);
	// A transformed `hmtx` starts with a flags byte; the advances come first either way.
	const advancesAt = tables.transformed.has("hmtx") ? 1 : 0;
	const stride = tables.transformed.has("hmtx") ? 2 : 4;
	const gpos = tables.data.get("GPOS");
	const gsub = tables.data.get("GSUB");
	// Read on first use: most subset files never measure a word.
	let kern: PairSubtable[][] | undefined;
	let substitute: ((glyphs: number[]) => number[]) | undefined;
	return {
		glyphs: cmapGlyphs(cmap),
		unitsPerEm: head.readUInt16BE(18),
		advance: (glyph) => hmtx.readUInt16BE(advancesAt + Math.min(glyph, metricCount - 1) * stride),
		kerning(left, right) {
			kern ??= gpos
				? featureLookups(gpos, { kern: true }).map((index) => {
						const lookup = readLookup(gpos, index, 9);
						return lookup.type === 2
							? lookup.subtables.flatMap((at) => pairSubtable(gpos, at) ?? [])
							: [];
					})
				: [];
			let total = 0;
			for (const lookup of kern) {
				for (const subtable of lookup) {
					const value = subtable(left, right);
					if (value === undefined) continue;
					total += value;
					break;
				}
			}
			return total;
		},
		substitute(glyphs) {
			substitute ??= gsub ? substitutions(gsub) : (run) => run;
			return substitute(glyphs);
		},
	};
}

const files = new Map<string, FontFile | null>();

/** A WOFF2 file's layout data, read once per process; `undefined` for a file that is not WOFF2. */
export function readFontFile(absolutePath: string): FontFile | undefined {
	let file = files.get(absolutePath);
	if (file === undefined) {
		file = parseFontFile(fs.readFileSync(absolutePath)) ?? null;
		files.set(absolutePath, file);
	}
	return file ?? undefined;
}
