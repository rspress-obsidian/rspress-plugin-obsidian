import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// End-to-end check of the real Rspress build output. Opt-in: build the docs
// first (`bun run docs:build`), then run
// `RUN_DOCS_BUILD_TESTS=1 bun test test/markdown/integration.test.ts` — the
// step the `e2e` CI job runs before Playwright. The gate is explicit because
// the build must also be from the current tree: a stale `doc_build/` can pass
// while today's sources emit different markup, so rebuild before enabling it.
const DOC_BUILD = path.resolve(import.meta.dir, "..", "..", "doc_build");

const hasBuildOutput =
	process.env.RUN_DOCS_BUILD_TESTS === "1" && fs.existsSync(path.join(DOC_BUILD, "index.html"));
if (!hasBuildOutput) {
	console.info(
		"[integration] skipped — run `bun run docs:build`, then RUN_DOCS_BUILD_TESTS=1 bun test test/markdown/integration.test.ts.",
	);
}

/** Read a built page, failing loudly when the route was not emitted. */
function page(relativePath: string): string {
	const filePath = path.join(DOC_BUILD, relativePath);
	expect(fs.existsSync(filePath)).toBe(true);
	return fs.readFileSync(filePath, "utf-8");
}

/** An emitted href resolves when either the route file or its `.html` exists. */
function routeExists(href: string): boolean {
	const clean = href.replace(/^\/|\/$/g, "").split("#")[0] ?? "";
	const candidates = [
		path.join(DOC_BUILD, `${clean}.html`),
		path.join(DOC_BUILD, clean, "index.html"),
	];
	return candidates.some((candidate) => fs.existsSync(candidate));
}

/** Every built HTML file, recursively. */
function htmlFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return htmlFiles(entryPath);
		return entry.name.endsWith(".html") ? [entryPath] : [];
	});
}

describe.skipIf(!hasBuildOutput)("rspress build integration", () => {
	test("emits docs, vault, canvas and tag pages", () => {
		for (const relativePath of [
			"index.html",
			"markdown/guide/examples.html",
			"vault/Welcome.html",
			"canvas/demo.html",
			"tags/examples.html",
		]) {
			expect(fs.existsSync(path.join(DOC_BUILD, relativePath))).toBe(true);
		}
	});

	test("resolves wikilinks to published routes", () => {
		const html = page("markdown/guide/examples.html");
		for (const href of ["/markdown/guide/getting-started", "/markdown/guide/advanced"]) {
			expect(html).toContain(`href="${href}"`);
			expect(routeExists(href)).toBe(true);
		}
		expect(html).not.toContain("[[markdown/guide");
	});

	test("resolves Obsidian-style markdown links and leaves no .md destinations", () => {
		const html = page("markdown/guide/examples.html");
		expect(html).toContain('href="/markdown/guide/getting-started');
		expect(html).not.toContain("getting-started.md");
	});

	test("renders plugin-owned callouts and restores the types Rspress claims", () => {
		const html = page("markdown/guide/examples.html");
		for (const type of ["success", "question", "bug", "example", "quote", "abstract", "failure"]) {
			expect(html).toContain(`callout-${type}`);
		}
		for (const type of ["note", "tip", "warning", "danger", "info"]) {
			expect(html).toContain(`callout-${type}`);
		}
	});

	test("renders foldable callouts as details elements", () => {
		expect(page("markdown/guide/examples.html")).toContain("<details");
	});

	test("renders highlights, footnote references and tag links", () => {
		const html = page("markdown/guide/examples.html");
		expect(html).toContain("<mark>");
		expect(html).toContain("footnote-ref");
		expect(html).toContain('href="/tags/examples"');
	});

	test("strips Obsidian comments", () => {
		expect(page("markdown/guide/examples.html")).not.toContain(
			"This text will not appear in the rendered page",
		);
	});

	test("transcludes sections with a prefixed source and resolved body", () => {
		const html = page("markdown/guide/examples.html");
		expect(html).toContain('class="obsidian-transclusion"');
		expect(html).toContain('data-src="/markdown/guide/getting-started');
	});

	test("keeps vault hrefs inside transclusions on the vault prefix", () => {
		// Regression guard: transcluded content used to fall back to an index
		// built without the vault route prefix, emitting `/Welcome` instead of
		// `/vault/Welcome`.
		const html = page("vault/create a link.html");
		expect(html).toContain('class="obsidian-transclusion"');
		const transclusion = html.slice(html.indexOf('class="obsidian-transclusion"'));
		expect(transclusion).toContain('href="/vault/');
		expect(transclusion).not.toContain('href="/Welcome"');
	});

	test("renders math to KaTeX HTML", () => {
		const html = page("markdown/guide/examples.html");
		expect(html).toContain('class="obsidian-math"');
		expect(html).toContain('class="obsidian-math-display"');
		expect(html).toContain("katex");
		// Prices stay prose: inline math requires no space inside the delimiters.
		expect(html).toContain("$5 and $10");
	});

	test("emits mermaid placeholders for the client renderer", () => {
		const html = page("markdown/guide/examples.html");
		expect(html).toContain('class="obsidian-mermaid-block"');
		expect(html).toContain("data-code=");
	});

	test("marks unresolved wikilinks instead of printing the raw syntax", () => {
		const html = page("markdown/guide/examples.html");

		expect(html).toContain('class="obsidian-unresolved"');
		expect(html).toContain(">Missing page<");
		expect(html).not.toContain(">[[not-a-real-page");
	});

	test("drops comments that span paragraphs and lists", () => {
		const html = page("markdown/guide/examples.html");

		expect(html).not.toContain("This paragraph is not published either");
		expect(html).not.toContain("Neither is this list item");
		expect(html).toContain("Still visible.");
	});

	test("renders the backlinks panel", () => {
		expect(page("markdown/guide/examples.html")).toContain("obsidian-backlinks");
	});

	test("every internal href in the built site resolves to the file the host will serve", () => {
		// The guard for the whole class of dead links this suite kept missing: an
		// index route emitted without its trailing slash (Rspress turns `/guide`
		// into `guide.html`, and the file is `guide/index.html`). Passive href
		// assertions only check the ones a test author remembered to look at.
		const missing: string[] = [];

		for (const file of htmlFiles(DOC_BUILD)) {
			const html = fs.readFileSync(file, "utf-8");
			for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
				const href = match[1] ?? "";
				// A static host percent-decodes the request before mapping it to a
				// file, so `/vault/create%20a%20link` must be checked against
				// `vault/create a link.html`.
				const encoded = href.split("#")[0]?.split("?")[0] ?? "";
				if (!encoded.startsWith("/")) continue;

				let target = encoded;
				try {
					target = decodeURIComponent(encoded);
				} catch {
					continue; // not valid percent-encoding: Rspress's problem, not a route
				}
				// Assets and externals are served as-is; only route hrefs are checked.
				if (/\.(?!html$)[a-z0-9]+$/i.test(target)) continue;

				const targetFile = target.endsWith("/")
					? path.join(DOC_BUILD, target, "index.html")
					: target.endsWith(".html")
						? path.join(DOC_BUILD, target)
						: path.join(DOC_BUILD, `${target}.html`);

				if (!fs.existsSync(targetFile)) {
					missing.push(`${path.relative(DOC_BUILD, file)} -> ${href}`);
				}
			}
		}

		expect(missing).toEqual([]);
	});
});
