import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Inputs whose change makes `doc_build` stale. The suite asserts what the browser
 * ends up showing, so serving a build older than its source makes every
 * assertion describe markup the current tree no longer emits — and it surfaces as
 * an unrelated-looking failure rather than "you forgot to rebuild". CI builds the
 * docs immediately before this runs; locally the run stops here with the fix.
 */
const BUILD_INPUTS = ["src", "docs", "theme", "Obsidian Vault", "rspress.config.ts"];
const BUILD_ENTRY = path.join("doc_build", "index.html");

/**
 * Directories under `docs` that the build itself writes: vault assets staged by
 * the wikilink plugin and the enriched canvas JSON. Their sources (`Obsidian
 * Vault`, `src`) are watched instead — watching the copies would race, because
 * rspress sometimes writes them after `doc_build/index.html` in the same run.
 */
const GENERATED_INPUT_DIRS = [
	path.join("docs", "public", "vault"),
	path.join("docs", "public", "__canvases__"),
];

/** Newest mtime under `dir`, recursively. */
const newestMtime = (dir: string): number =>
	readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory() && GENERATED_INPUT_DIRS.includes(child)) return newest;
		const mtime = entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs;
		return Math.max(newest, mtime);
	}, 0);

const newestInput = BUILD_INPUTS.filter((input) => existsSync(input))
	.map((input) => ({
		input,
		mtime: statSync(input).isDirectory() ? newestMtime(input) : statSync(input).mtimeMs,
	}))
	.reduce((newest, candidate) => (candidate.mtime > newest.mtime ? candidate : newest));

if (!existsSync(BUILD_ENTRY)) {
	throw new Error(`doc_build is missing — run \`bun run docs:build\` before \`bun run test:e2e\``);
}

if (statSync(BUILD_ENTRY).mtimeMs < newestInput.mtime) {
	throw new Error(
		`${BUILD_ENTRY} is older than ${newestInput.input} — run \`bun run docs:build\` before \`bun run test:e2e\``,
	);
}

export default defineConfig({
	testDir: "./test/e2e",
	testMatch: "**/*.playwright.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI
		? // On CI the HTML report and the traces in `test-results/` are uploaded
			// as workflow artifacts (see `.github/workflows/ci.yml`), so a failure
			// can be inspected without re-running the suite. Locally `list` is
			// enough and skips writing `playwright-report/`.
			[["list"], ["html", { open: "never" }]]
		: [["list"]],
	use: {
		baseURL: "http://localhost:4321",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		// `serve` (already a devDependency) rather than `python3 -m http.server`:
		// the Python launcher is `python` or `py` on Windows and the `3` name
		// does not exist there at all. Same static root, same port, same
		// reuseExistingServer rule; `serve` serves `index.html` for a directory
		// request exactly as http.server did.
		command: "bunx serve --listen 4321 doc_build",
		url: "http://localhost:4321",
		reuseExistingServer: !process.env.CI,
	},
});
