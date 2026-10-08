/**
 * `icon()` against a stand-in `lucide-static` install: a temp project whose
 * `node_modules/lucide-static` holds the files the real package ships (a
 * license comment, `class="lucide lucide-<name>"`, and alias files for renamed
 * icons), and an empty project for the absent peer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lucideIcon } from "./icons.js";

const CHECK = `<!-- @license lucide-static v0.462.0 - ISC -->
<svg
  class="lucide lucide-check"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M20 6 9 17l-5-5" />
</svg>
`;

let installed: string;
let bare: string;

beforeAll(() => {
	installed = mkdtempSync(path.join(os.tmpdir(), "bases-lucide-"));
	const pkg = path.join(installed, "node_modules", "lucide-static");
	mkdirSync(path.join(pkg, "icons"), { recursive: true });
	writeFileSync(path.join(pkg, "package.json"), '{"name":"lucide-static","version":"0.462.0"}');
	writeFileSync(path.join(pkg, "icons", "check.svg"), CHECK);
	// lucide-static ships each alias of a renamed icon as a file of its own.
	writeFileSync(
		path.join(pkg, "icons", "circle-check.svg"),
		CHECK.replace("lucide-check", "lucide-circle-check"),
	);
	writeFileSync(path.join(pkg, "icons", "broken.svg"), "not an svg");
	bare = mkdtempSync(path.join(os.tmpdir(), "bases-no-lucide-"));
});

afterAll(() => {
	rmSync(installed, { recursive: true, force: true });
	rmSync(bare, { recursive: true, force: true });
});

describe("lucideIcon", () => {
	test("an installed icon is inlined with Obsidian's classes, hidden from assistive tech, in the text colour", () => {
		const icon = lucideIcon("check", installed);
		expect("svg" in icon).toBe(true);
		const svg = "svg" in icon ? icon.svg : "";
		expect(
			svg.startsWith(
				'<svg class="svg-icon lucide-check bases-icon" data-icon="check" aria-hidden="true"',
			),
		).toBe(true);
		expect(svg).not.toContain("<!--");
		expect(svg).not.toContain('class="lucide lucide-check"');
		expect(svg).toContain('stroke="currentColor"');
		expect(svg).toContain('<path d="M20 6 9 17l-5-5" />');
		expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
	});

	test("Obsidian's `lucide-` icon ids and any case name the same icon; an alias file resolves too", () => {
		const prefixed = lucideIcon("lucide-check", installed);
		expect("svg" in prefixed && prefixed.svg).toContain(
			'class="svg-icon lucide-check bases-icon" data-icon="lucide-check"',
		);
		expect("svg" in lucideIcon(" Check ", installed)).toBe(true);
		const alias = lucideIcon("circle-check", installed);
		expect("svg" in alias && alias.svg).toContain(
			'class="svg-icon lucide-circle-check bases-icon"',
		);
	});

	test("a name Lucide does not have, or cannot have, is drawn as its name and says so", () => {
		expect(lucideIcon("no-such-icon", installed)).toEqual({
			problem: 'icon("no-such-icon") is not a Lucide icon; it is drawn as its name',
		});
		expect(lucideIcon("../package", installed)).toEqual({
			problem: 'icon("../package") is not a Lucide icon; it is drawn as its name',
		});
		expect(lucideIcon("broken", installed)).toEqual({
			problem: 'icon("broken") is not a Lucide icon; it is drawn as its name',
		});
	});

	test("without lucide-static every icon is its name, with the fix named", () => {
		expect(lucideIcon("check", bare)).toEqual({
			problem: "icon() draws each icon as its name: install `lucide-static` to draw Bases icons",
		});
	});
});
