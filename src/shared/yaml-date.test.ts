import { describe, expect, test } from "bun:test";
import { yamlDateAsLocal } from "./yaml-date.ts";

describe("yamlDateAsLocal", () => {
	test("reads a UTC instant's fields as local wall-clock time", () => {
		const local = yamlDateAsLocal(new Date(Date.UTC(2024, 4, 1, 10, 30)));
		expect(local?.getFullYear()).toBe(2024);
		expect(local?.getMonth()).toBe(4);
		expect(local?.getDate()).toBe(1);
		expect(local?.getHours()).toBe(10);
		expect(local?.getMinutes()).toBe(30);
	});

	// `new Date(50, 0, 1)` is 1950: a YAML year below 100 must stay the year it
	// names, which is why the constructor goes through `localDate`.
	test("keeps a year below 100", () => {
		const utc = new Date(Date.UTC(2000, 0, 1));
		utc.setUTCFullYear(50, 0, 2);
		const local = yamlDateAsLocal(utc);
		expect(local?.getFullYear()).toBe(50);
		expect(local?.getMonth()).toBe(0);
		expect(local?.getDate()).toBe(2);
	});

	test("returns undefined for an invalid date", () => {
		expect(yamlDateAsLocal(new Date(Number.NaN))).toBeUndefined();
	});
});
