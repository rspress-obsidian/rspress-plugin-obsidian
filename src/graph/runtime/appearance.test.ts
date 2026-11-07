import { describe, expect, test } from "bun:test";
import { kindColor, labelOpacity, nodeRadius, safeColor } from "./appearance.js";
import { labelZoomFor } from "./graph-settings.js";
import { LIGHT_COLORS } from "./palette/colors.js";

describe("nodeRadius", () => {
	test("a node with no links is the base radius at its size", () => {
		expect(nodeRadius(0, false, 1)).toBe(5);
		expect(nodeRadius(0, false, 2)).toBe(10);
		expect(nodeRadius(0, true, 1)).toBe(4);
	});

	test("grows with the link count", () => {
		const small = nodeRadius(1, false, 1);
		const medium = nodeRadius(4, false, 1);
		const large = nodeRadius(64, false, 1);
		expect(small).toBeGreaterThan(5);
		expect(medium).toBeGreaterThan(small);
		expect(large).toBeGreaterThan(medium);
	});
});

describe("labelOpacity", () => {
	test("is invisible at rest and fully opaque at the threshold zoom", () => {
		const fullAt = labelZoomFor(1);
		expect(labelOpacity(0, 1)).toBe(0);
		expect(labelOpacity(fullAt * 0.7, 1)).toBe(0);
		expect(labelOpacity(fullAt, 1)).toBe(1);
		expect(labelOpacity(fullAt * 4, 1)).toBe(1);
	});

	test("fades in over the 30% of zoom below the threshold", () => {
		const fullAt = labelZoomFor(0.5);
		expect(labelOpacity(fullAt * 0.85, 0.5)).toBeCloseTo(0.5, 6);
	});
});

describe("safeColor", () => {
	test("keeps a colour the canvas can paint", () => {
		expect(safeColor("#5f9e6e")).toBe("#5f9e6e");
		expect(safeColor("rgba(1, 2, 3, 0.5)")).toBe("rgba(1, 2, 3, 0.5)");
	});

	test("rejects an empty or blank value", () => {
		expect(safeColor("")).toBeUndefined();
		expect(safeColor("   ")).toBeUndefined();
	});
});

describe("kindColor", () => {
	test("each node kind takes its palette entry", () => {
		expect(kindColor({ kind: "page" }, LIGHT_COLORS)).toBe(LIGHT_COLORS.node);
		expect(kindColor({ kind: "tag" }, LIGHT_COLORS)).toBe(LIGHT_COLORS.tagNode);
		expect(kindColor({ kind: "attachment" }, LIGHT_COLORS)).toBe(LIGHT_COLORS.attachmentNode);
		expect(kindColor({ kind: "unresolved" }, LIGHT_COLORS)).toBe(LIGHT_COLORS.unresolvedNode);
	});
});
