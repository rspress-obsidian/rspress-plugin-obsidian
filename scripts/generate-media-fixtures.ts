#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// Generates the media files the docs embed live, so every format the plugin
// claims to support is a real file a browser can actually play rather than a
// code sample. Run via `bun scripts/generate-media-fixtures.ts`.
//
// The files land in the demo vault (`Obsidian Vault/media/`) because that is
// where attachments belong: the wikilink plugin publishes the vault under
// `/vault/`, so a `![[media/gradient.png]]` in a docs page resolves to a URL
// that exists in the built site. A file parked in the docs root instead gets a
// correct-looking URL that Rspress never serves, because only `public/` is
// copied into the build.
//
// PNG, WAV and PDF are written byte by byte here so the script needs nothing
// installed. The video and the lossy audio formats go through ffmpeg, and are
// skipped with a note when it is missing rather than failing the run: the rest
// of the fixtures are still worth having.
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dir, "..");
const MEDIA_DIR = path.join(ROOT, "Obsidian Vault", "media");

// ── PNG ────────────────────────────────────────────────────────────────────

/**
 * Bitwise rather than table-driven: a lookup table needs an indexed access per
 * byte, which TypeScript's unchecked-index rule flags for no gain on files this
 * small.
 */
function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) {
		c ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * A gradient with a soft diagonal, so a reader can tell at a glance that the
 * image is being scaled and not letterboxed.
 */
function gradientPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0; // filter type: none
		for (let x = 0; x < width; x++) {
			const t = (x / width) * 0.7 + (y / height) * 0.3;
			raw[offset++] = Math.round(40 + t * 150);
			raw[offset++] = Math.round(70 + (1 - t) * 120);
			raw[offset++] = Math.round(140 + t * 90);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

// ── WAV ────────────────────────────────────────────────────────────────────

/** One second of a 440 Hz tone: audible in a player, and a few tens of KB. */
function toneWav(seconds: number, sampleRate: number, frequency: number): Buffer {
	const samples = Math.floor(seconds * sampleRate);
	const data = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		// A short fade at each end, so the player does not click on loop.
		const fade = Math.min(1, i / 400, (samples - i) / 400);
		const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.25 * fade;
		data.writeInt16LE(Math.round(value * 0x7fff), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // PCM header size
	header.writeUInt16LE(1, 20); // format: PCM
	header.writeUInt16LE(1, 22); // channels: mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

// ── PDF ────────────────────────────────────────────────────────────────────

/**
 * A two-page PDF written by hand, because `#page=2` is only demonstrable with
 * more than one page, and a one-line fixture could not show it.
 */
function samplePdf(): Buffer {
	const content = (line: string) =>
		`BT /F1 22 Tf 64 700 Td (${line}) Tj ET\n0 0.4 0.8 rg 64 660 460 6 re f\n`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${content("Page one of two").length} >>\nstream\n${content("Page one of two")}endstream`,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
		`<< /Length ${content("Page two of two").length} >>\nstream\n${content("Page two of two")}endstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];

	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	// The xref table is a byte-offset index, so it can only be written once the
	// body it points at is final. `offsets` above is what makes that true.
	const startxref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

// ── ffmpeg-backed formats ──────────────────────────────────────────────────

function ffmpegAvailable(): boolean {
	return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/** Returns false when ffmpeg is missing, so the caller can report the skip. */
function ffmpeg(args: string[]): boolean {
	const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
	return result.status === 0;
}

// ── main ───────────────────────────────────────────────────────────────────

mkdirSync(MEDIA_DIR, { recursive: true });

const written: string[] = [];
const write = (name: string, bytes: Buffer) => {
	writeFileSync(path.join(MEDIA_DIR, name), bytes);
	written.push(`${name} (${(bytes.length / 1024).toFixed(1)} KB)`);
};

write("gradient.png", gradientPng(480, 270));
write("tone.wav", toneWav(1, 22050, 440));
write("sample.pdf", samplePdf());
writeFileSync(
	path.join(MEDIA_DIR, "diagram.svg"),
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120" role="img" aria-label="Note, embed and page">
  <rect width="320" height="120" rx="8" fill="#f6f8fa" stroke="#d0d7de"/>
  <rect x="16" y="34" width="80" height="52" rx="6" fill="#dbeafe" stroke="#60a5fa"/>
  <rect x="120" y="34" width="80" height="52" rx="6" fill="#dcfce7" stroke="#4ade80"/>
  <rect x="224" y="34" width="80" height="52" rx="6" fill="#fef3c7" stroke="#fbbf24"/>
  <text x="56" y="65" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#1e3a8a">note</text>
  <text x="160" y="65" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#14532d">embed</text>
  <text x="264" y="65" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#78350f">page</text>
  <path d="M96 60h24M200 60h24" stroke="#6b7280" stroke-width="2"/>
</svg>
`,
);
written.push("diagram.svg");

if (ffmpegAvailable()) {
	// A 1s colour-bar clip at 320x180: a real H.264/VP8 encode, small enough to
	// keep in git, and unmistakably video when it plays.
	const video = ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=320x180:rate=15:duration=1",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		path.join(MEDIA_DIR, "clip.mp4"),
	]);
	if (video) written.push("clip.mp4 (ffmpeg)");
	else console.warn("[media-fixtures] ffmpeg could not write clip.mp4; skipping it");

	const webm = ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=320x180:rate=15:duration=1",
		"-c:v",
		"libvpx-vp9",
		"-b:v",
		"60k",
		path.join(MEDIA_DIR, "clip.webm"),
	]);
	if (webm) written.push("clip.webm (ffmpeg)");
	else console.warn("[media-fixtures] ffmpeg has no VP9 encoder; skipping clip.webm");

	for (const [name, codecArgs] of [
		["tone.mp3", ["-c:a", "libmp3lame", "-b:a", "48k"]],
		["tone.ogg", ["-c:a", "libvorbis", "-b:a", "48k"]],
		["tone.m4a", ["-c:a", "aac", "-b:a", "48k"]],
		["tone.flac", ["-c:a", "flac"]],
	] as const) {
		const ok = ffmpeg([
			"-i",
			path.join(MEDIA_DIR, "tone.wav"),
			...codecArgs,
			path.join(MEDIA_DIR, name),
		]);
		if (ok) written.push(`${name} (ffmpeg)`);
		else console.warn(`[media-fixtures] ffmpeg could not write ${name}; skipping it`);
	}
} else {
	console.warn(
		"[media-fixtures] ffmpeg not found: wrote the PNG, WAV, PDF and SVG only, and left the video and lossy audio formats out.",
	);
}

console.log(`Wrote ${written.length} fixture(s) to ${path.relative(ROOT, MEDIA_DIR)}:`);
for (const line of written) console.log(`  ${line}`);
