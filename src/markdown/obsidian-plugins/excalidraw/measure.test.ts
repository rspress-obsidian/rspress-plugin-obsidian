import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFontFile } from "./font-file.js";
import { excalidrawFontsDir } from "./fonts.js";
import { estimateMeasurer, textMeasurer } from "./measure.js";
import { normalizeScene } from "./scene.js";
import { element } from "./test-helpers.js";
import { applyDisplayText, wrapText } from "./text.js";

const measure = textMeasurer(excalidrawFontsDir());
const excalifont = (line: string) => measure.lineWidth(line, 20, 5);

function elementOf(type: string, props: Record<string, unknown>) {
	const scene = normalizeScene({ elements: [element(type, props)] });
	return scene.elements[0] as (typeof scene.elements)[number];
}

describe("text measured with the peer's fonts", () => {
	test("widths equal Chromium's canvas measureText, kerning and substitutions included", () => {
		// Read from `measureText` in Chromium, the peer's files loaded, at 20px.
		const chromium: [number, string, number][] = [
			[5, "Plan Launch Plan", 162.27987670898438],
			// Excalifont swaps in a narrower `f` before another `f`.
			[5, "office fluffy fjord", 174.0598602294922],
			// Nunito joins `fi` and `ff`.
			[6, "difficult affine shuffle", 191.19976806640625],
			// Liberation Sans kerns `AV`, `TA`, … but never across a space.
			[9, "AVATAR Tokyo WAVE", 194.111328125],
			[9, "A plain", 61.15234375],
			// Helvetica is measured as Liberation Sans, its metric twin.
			[2, "AVATAR Tokyo WAVE", 194.111328125],
			[1, "Hello world", 102.05990600585938],
			[8, "Comic Shanns", 132],
			[7, "Lilita One", 81.17991638183594],
			[3, "a -> b != c", 128.90625],
		];
		for (const [family, text, width] of chromium) {
			expect(measure.lineWidth(text, 20, family)).toBeCloseTo(width, 3);
		}
	});

	test("a character Excalifont lacks comes from Xiaolai; one no font has is estimated", () => {
		expect(excalifont("中文")).toBe(40);
		expect(measure.lineWidth("中文", 20, 1)).toBeCloseTo(2 * 0.55 * 20, 6);
	});

	test("without the peer the per-font average stands in", () => {
		expect(textMeasurer(undefined)).toBe(estimateMeasurer);
		expect(estimateMeasurer.lineWidth("abcd", 20, 5)).toBeCloseTo(44, 6);
		expect(estimateMeasurer.lineWidth("abcd", 10, 42)).toBeCloseTo(22, 6);
	});

	test("a file that is not WOFF2 has no metrics", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "font-")), "x.woff2");
		fs.writeFileSync(file, "not a font at all, just text");
		expect(readFontFile(file)).toBeUndefined();
	});
});

describe("wrapping as Excalidraw's wrapText does", () => {
	test("breaks at the measured width, to a hundredth of a pixel", () => {
		// "Plan Launch" is 113.78px wide in Excalifont at 20px.
		expect(wrapText("Plan Launch Plan", 113.8, excalifont)).toBe("Plan Launch\nPlan");
		expect(wrapText("Plan Launch Plan", 113.7, excalifont)).toBe("Plan\nLaunch\nPlan");
		expect(wrapText("Plan Launch Plan", 200, excalifont)).toBe("Plan Launch Plan");
	});

	test("words, hyphens, CJK and emoji break where Excalidraw breaks them", () => {
		expect(wrapText("Excalidraw", 50, excalifont).split("\n").length).toBeGreaterThan(1);
		expect(wrapText("Excalidraw", 50, excalifont).replace(/\n/g, "")).toBe("Excalidraw");
		expect(wrapText("well-known", excalifont("known") + 1, excalifont)).toBe("well-\nknown");
		expect(wrapText("中文测试", 50, excalifont)).toBe("中文\n测试");
		expect(wrapText("🎉🎉", 5, excalifont)).toBe("🎉\n🎉");
		expect(wrapText("a\nb", -1, excalifont)).toBe("a\nb");
	});
});

describe("a text laid out anew", () => {
	const label = { text: "x", originalText: "x", containerId: "c", fontFamily: 5 };

	test("in a rectangle: wrapped to its width less padding and centred in it", () => {
		const container = elementOf("rectangle", { id: "c", x: 0, y: 0, width: 130, height: 100 });
		const text = elementOf("text", { ...label, textAlign: "center", verticalAlign: "middle" });
		const out = applyDisplayText(text, "Plan Launch Plan", container, measure);
		expect(out.text).toBe("Plan Launch\nPlan");
		expect(out.width).toBeCloseTo(113.78, 2);
		expect(out.height).toBe(50);
		expect(out.x).toBeCloseTo(5 + 60 - 113.78 / 2, 2);
		expect(out.y).toBe(5 + 45 - 25);
	});

	test("in an ellipse and a diamond, by Excalidraw's inner box", () => {
		const ellipse = elementOf("ellipse", { id: "c", width: 200, height: 100 });
		const diamond = elementOf("diamond", { id: "c", width: 300, height: 100 });
		const text = elementOf("text", { ...label, textAlign: "left", verticalAlign: "top" });
		const inEllipse = applyDisplayText(text, "Plan Launch Plan", ellipse, measure);
		// round(100·√2) − 10 = 131 wide: "Plan Launch" fits, the rest wraps.
		expect(inEllipse.text).toBe("Plan Launch\nPlan");
		expect(inEllipse.x).toBeCloseTo(5 + 100 * (1 - Math.SQRT2 / 2), 6);
		const inDiamond = applyDisplayText(
			{ ...text, verticalAlign: "bottom", textAlign: "right" },
			"Plan Launch Plan",
			diamond,
			measure,
		);
		// round(300 / 2) − 10 = 140 wide.
		expect(inDiamond.text).toBe("Plan Launch\nPlan");
		expect(inDiamond.x).toBeCloseTo(5 + 75 + 140 - 113.78, 2);
		expect(inDiamond.y).toBe(5 + 25 + 40 - 50);
	});

	test("an arrow label wraps to the arrow's share and is placed when drawn", () => {
		const arrow = elementOf("arrow", { id: "c", x: 7, y: 9, width: 10 });
		const text = elementOf("text", { ...label, x: 3, y: 4 });
		const out = applyDisplayText(text, "Plan Launch Plan", arrow, measure);
		// max(0.7 × 10, 20 × 11) = 220: one line.
		expect(out.text).toBe("Plan Launch Plan");
		expect([out.x, out.y]).toEqual([3, 4]);
	});

	test("a free text grows from the side its alignment anchors", () => {
		const free = { text: "x", originalText: "x", fontFamily: 5, x: 100, y: 50, width: 40 };
		const right = applyDisplayText(
			elementOf("text", { ...free, textAlign: "right" }),
			"Plan",
			undefined,
			measure,
		);
		expect(right.x + right.width).toBeCloseTo(140, 6);
		const left = applyDisplayText(
			elementOf("text", { ...free, textAlign: "left" }),
			"Plan",
			undefined,
			measure,
		);
		expect(left.x).toBe(100);
		const middle = applyDisplayText(
			elementOf("text", { ...free, textAlign: "center", verticalAlign: "middle" }),
			"Plan\nLaunch",
			undefined,
			measure,
		);
		expect(middle.y).toBe(50 - 12.5);
		expect(middle.x + middle.width / 2).toBeCloseTo(100 + excalifont("x") / 2, 6);
	});

	test("a text sized by hand wraps to its own width and keeps it", () => {
		const fixed = elementOf("text", { ...label, containerId: null, width: 70, autoResize: false });
		const out = applyDisplayText(fixed, "Plan Launch Plan", undefined, measure);
		expect(out.text).toBe("Plan\nLaunch\nPlan");
		expect(out.width).toBe(70);
	});

	test("without the peer, the estimate wraps it the same way", () => {
		const container = elementOf("rectangle", { id: "c", width: 130, height: 100 });
		const text = elementOf("text", { ...label, textAlign: "center", verticalAlign: "middle" });
		const out = applyDisplayText(text, "Plan Launch Plan", container, estimateMeasurer);
		// 11 characters × 0.55 × 20 = 121 > 120: each word on its line.
		expect(out.text).toBe("Plan\nLaunch\nPlan");
	});
});
