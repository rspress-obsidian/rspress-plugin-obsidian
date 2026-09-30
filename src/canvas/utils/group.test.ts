import { describe, expect, test } from "bun:test";
import type { CanvasNode } from "../types";
import { isContainedIn, membersByGroup } from "./group";

const group: CanvasNode = {
	id: "g",
	type: "group",
	x: 0,
	y: 0,
	width: 400,
	height: 300,
	label: "Group",
};

function text(id: string, x: number, y: number, width = 100, height = 50): CanvasNode {
	return { id, type: "text", x, y, width, height, text: id };
}

describe("isContainedIn", () => {
	test("holds a node whose rectangle is inside the group's", () => {
		expect(isContainedIn(group, text("in", 20, 20))).toBe(true);
	});

	test("holds a node flush with every edge", () => {
		expect(isContainedIn(group, text("flush", 0, 0, 400, 300))).toBe(true);
	});

	test("does not hold a node that overlaps an edge without being inside it", () => {
		// Straddles the group's right edge: the partial-overlap case, which a
		// centre-point test would wrongly call a member.
		expect(isContainedIn(group, text("straddle", 350, 20, 100, 50))).toBe(false);
		expect(isContainedIn(group, text("above", 20, -10, 100, 50))).toBe(false);
	});

	test("does not hold a node outside the group, nor the group itself", () => {
		expect(isContainedIn(group, text("out", 500, 500))).toBe(false);
		expect(isContainedIn(group, group)).toBe(false);
	});

	test("holds a group nested inside another group", () => {
		const nested: CanvasNode = { ...group, id: "nested", x: 50, y: 50, width: 100, height: 100 };
		expect(isContainedIn(group, nested)).toBe(true);
	});
});

describe("membersByGroup", () => {
	test("keys every group's members by group id", () => {
		const outer: CanvasNode = { ...group, id: "outer", width: 600, height: 600 };
		const inner: CanvasNode = { ...group, id: "inner", x: 20, y: 20, width: 200, height: 200 };
		const nodes = [outer, inner, text("deep", 40, 40, 50, 50), text("outside", 900, 900)];

		const members = membersByGroup(nodes);

		// A nested group is a member of its parent, and so is everything the
		// geometry puts inside the parent — no recursion needed.
		expect(members.get("outer")).toEqual(["inner", "deep"]);
		expect(members.get("inner")).toEqual(["deep"]);
		// Non-groups are not keys at all.
		expect(members.has("deep")).toBe(false);
	});
});
