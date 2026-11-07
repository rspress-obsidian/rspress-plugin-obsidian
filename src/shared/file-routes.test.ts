import { describe, expect, test } from "bun:test";
import { createFileRoutes } from "./file-routes.js";

const route = (kind: string, routePath: string) => ({
	kind,
	absolutePath: "/vault/View.base",
	routePath,
	source: "View.base",
});

describe("createFileRoutes", () => {
	test("two builds resolve the same file to their own pages", () => {
		const first = createFileRoutes();
		const second = createFileRoutes();
		first.set("bases", [route("bases", "/vault/View")]);
		second.set("bases", [route("bases", "/notes/View")]);

		expect(first.find("/vault/View.base")?.routePath).toBe("/vault/View");
		expect(second.find("/vault/View.base")?.routePath).toBe("/notes/View");
	});

	test("clearing one build leaves the other", () => {
		const first = createFileRoutes();
		const second = createFileRoutes();
		first.set("bases", [route("bases", "/vault/View")]);
		second.set("bases", [route("bases", "/notes/View")]);

		first.clear();

		expect(first.find("/vault/View.base")).toBeUndefined();
		expect(first.byKind("bases")).toEqual([]);
		expect(second.find("/vault/View.base")?.routePath).toBe("/notes/View");
	});
});
