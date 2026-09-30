import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `src/shared/` holds the primitives more than one feature needs, so the rule
 * that keeps it that way is mechanical and worth a test rather than a note in a
 * README: nothing in there may import `node:*` or reach into a feature.
 *
 * Both halves have bitten this codebase. `route-path.ts` exists, and is
 * documented as node-free, purely so the browser bundle does not inherit
 * `node:fs`; and `link-extractor.ts` once imported a 45-line pure function
 * through `content-index.ts`, dragging that module's `node:fs` with it. Neither
 * was a bug at the time — both were one careless import away from being one.
 */

const SRC = path.join(import.meta.dir, "..", "src");
const SHARED = path.join(SRC, "shared");
const FEATURES = ["markdown", "canvas", "graph"];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

describe("src/shared boundary", () => {
	const files = sourceFiles(SHARED);

	test("has the shared modules it is supposed to own", () => {
		// Named so an accidental move back into a feature fails here rather than
		// being rediscovered the next time a bundle size or a `node:fs` leak
		// regresses.
		expect(files.map((f) => path.basename(f)).sort()).toEqual([
			"canvas-routes.ts",
			"content-flags.ts",
			"escape.ts",
			"extensions.ts",
			"frontmatter.ts",
			"media-exts.ts",
			"media-html.ts",
			"paths.ts",
			"route-path.ts",
			"slug.ts",
			"transclusion.ts",
		]);
	});

	test("no module imports node builtins", () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (/from "node:/.test(readFileSync(file, "utf-8"))) {
				offenders.push(path.relative(SRC, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no module reaches into a feature", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			// `../markdown/`, `../../canvas/`, … — a shared module that needs a
			// feature is a feature-pure module that has not been extracted yet.
			for (const feature of FEATURES) {
				if (new RegExp(`from "\\.{1,2}/${feature}/`).test(source)) {
					offenders.push(`${path.relative(SRC, file)} -> ${feature}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("a feature reaches into another only through a named exception", () => {
		// The refactor removed three of these. What is left is a node-bound
		// filesystem guard, which cannot live in a node-free `shared/`, so the
		// exception is named here and this list may only shrink — a new
		// cross-feature import fails the build instead of becoming a fourth
		// quietly-accepted one.
		const ALLOWED = new Set([
			// Vault containment. `isRealPathInsideRoot` resolves realpaths through
			// `node:path`, and both features need the same check for the same
			// reason: an attachment or note must not escape the vault root.
			"canvas/index.ts -> ../markdown/utils.js",
		]);

		const found = new Set<string>();
		for (const feature of FEATURES) {
			const dir = path.join(SRC, feature);
			if (!statSync(dir).isDirectory()) continue;
			for (const file of sourceFiles(dir)) {
				const source = readFileSync(file, "utf-8");
				for (const match of source.matchAll(/from "(\.[^"]*)"/g)) {
					// Resolve the specifier to a real file before judging it. A
					// textual `canvas/` match is not evidence of a cross-feature
					// import: `graph/runtime/` has a directory of its own named
					// `canvas`, and `./canvas/colors.js` from inside graph is graph's.
					const resolved = path.resolve(path.dirname(file), match[1] as string);
					const target = FEATURES.find(
						(candidate) =>
							resolved === path.join(SRC, candidate) ||
							resolved.startsWith(`${path.join(SRC, candidate)}${path.sep}`),
					);
					if (!target || target === feature) continue;
					// Report the specifier as written — that is what a reader sees
					// in the source and what the allowlist is keyed on.
					found.add(`${path.relative(SRC, file)} -> ${match[1] as string}`);
				}
			}
		}

		expect([...found].filter((entry) => !ALLOWED.has(entry))).toEqual([]);
	});
});
