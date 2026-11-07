import { describe, expect, test } from "bun:test";
import { routeKey } from "./route-path.js";

describe("routeKey", () => {
	test("strips .html, trailing slashes and /index", () => {
		expect(routeKey("/guide/configuration.html")).toBe("/guide/configuration");
		expect(routeKey("/guide//")).toBe("/guide");
		expect(routeKey("/guide/index.html")).toBe("/guide");
		expect(routeKey("/index.html")).toBe("/");
		expect(routeKey("/")).toBe("/");
	});

	test("decodes the router's percent-encoded path, so spaces and CJK routes match", () => {
		expect(routeKey("/My%20Note")).toBe("/My Note");
		expect(routeKey("/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%8E%E3%83%BC%E3%83%88")).toBe(
			"/日本語ノート",
		);
	});

	test("folds decomposed unicode to NFC, the form route ids use", () => {
		expect(routeKey("/Cafe\u0301")).toBe("/Caf\u00e9");
	});

	test("keeps a malformed escape as written", () => {
		expect(routeKey("/100%")).toBe("/100%");
	});

	test("drops a query and a fragment, and adds the leading slash", () => {
		expect(routeKey("guide/note.html?x=1#top")).toBe("/guide/note");
	});
});
