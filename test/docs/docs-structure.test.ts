import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Guards the docs tree itself, not the plugin code. Three failure modes are
// invisible to both TypeScript and the build: Rspress silently drops the body of
// a `pageType: home` page, reads the navbar only from `<docsRoot>/_nav.json` so a
// nested copy is dead config that orphans its whole section, and emits a
// root-absolute link that points nowhere as a plain 404. Source-level checks, so
// they need no docs build and fail fast in the unit run.

const REPO = path.resolve(import.meta.dir, "..", "..");
const DOCS = path.join(REPO, "docs");

/** Routes generated during the build, i.e. not backed by a file under `docs/`. */
const GENERATED_ROUTES: Record<string, true> = { "/canvas/demo": true }; // canvas plugin over `Obsidian Vault/Demo.canvas`
const GENERATED_PREFIXES = ["/tags/", "/vault/"]; // tag pages, vault pages

type Page = { file: string; route: string; source: string };

function listFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? listFiles(full) : [full];
	});
}

/** Authored route for a docs file: drop the extension and a trailing `index`. */
function routeFor(file: string): string {
	const relative = path
		.relative(DOCS, file)
		.replace(/\.mdx?$/, "")
		.split(path.sep)
		.join("/");
	const trimmed = relative.replace(/(^|\/)index$/, "");
	return trimmed ? `/${trimmed}` : "/";
}

/** Compare routes without a fragment, `.html` suffix, or trailing slash. */
function normalizeRoute(route: string): string {
	const clean = route
		.replace(/#.*$/, "")
		.replace(/\.html$/, "")
		.replace(/\/+$/, "");
	return clean === "" ? "/" : clean;
}

function frontmatter(source: string): string {
	return /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
}

/** Prose only: frontmatter, fenced blocks and inline code never carry real links. */
function stripCode(source: string): string {
	return source
		.replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "");
}

/** Markdown link targets plus frontmatter `link:` values (hero actions, features). */
function linksIn(source: string): string[] {
	const links: string[] = [];
	for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) links.push(match[1] as string);
	for (const match of source.matchAll(/^\s*link:\s*(\S+)\s*$/gm)) links.push(match[1] as string);
	return links;
}

/** Route for a relative link target, or `undefined` when the file does not exist. */
function resolveRelative(target: string, from: Page): string | undefined {
	const bare = target.replace(/#.*$/, "");
	const base = path.resolve(path.dirname(from.file), bare);
	for (const candidate of [base, `${base}.md`, `${base}.mdx`]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return normalizeRoute(routeFor(candidate));
		}
	}
	return undefined;
}

// `file` is normalised to `/` because it is compared with `endsWith` and
// `path.relative` elsewhere in this file, and both are separator-sensitive:
// `path.join` yields `\` on Windows, so `docs\canvas\guide\styling.md` never
// ends with `canvas/guide/styling.md`.
const pages: Page[] = listFiles(DOCS)
	.filter((file) => /\.mdx?$/.test(file))
	.map((file) => ({
		file: file.replace(/\\/g, "/"),
		route: routeFor(file),
		source: fs.readFileSync(file, "utf-8"),
	}));

const authoredRoutes = new Set(pages.map((page) => normalizeRoute(page.route)));

const navRoutes = new Set(
	(JSON.parse(fs.readFileSync(path.join(DOCS, "_nav.json"), "utf-8")) as { link: string }[]).map(
		(entry) => normalizeRoute(entry.link),
	),
);

const sectionRoutes = new Set(
	pages
		.map((page) => normalizeRoute(page.route).split("/")[1] ?? "")
		.filter((segment) => segment !== "")
		.map((segment) => `/${segment}`),
);

describe("docs tree", () => {
	test("no pageType: home page carries a body Rspress would drop", () => {
		for (const page of pages) {
			if (!/^pageType:\s*home\s*$/m.test(frontmatter(page.source))) continue;
			const block = /^---\r?\n[\s\S]*?\r?\n---/.exec(page.source);
			const body = (block ? page.source.slice(block[0].length) : page.source).trim();
			expect(body, `${path.relative(REPO, page.file)} has body content after its frontmatter`).toBe(
				"",
			);
		}
	});

	test("every page declares a description", () => {
		for (const page of pages) {
			expect(
				frontmatter(page.source),
				`${path.relative(REPO, page.file)} has no description`,
			).toMatch(/^description:\s*\S+/m);
		}
	});

	test("the navbar lives only at the docs root", () => {
		const navFiles = listFiles(DOCS).filter((file) => path.basename(file) === "_nav.json");
		// Normalised like the reference assertion further down: `path.relative`
		// yields `\` on Windows, so this compared `docs\_nav.json` with
		// `docs/_nav.json`.
		expect(navFiles.map((file) => path.relative(REPO, file).split(path.sep).join("/"))).toEqual([
			"docs/_nav.json",
		]);
	});

	test("the navbar reaches every top-level section", () => {
		for (const section of sectionRoutes) {
			expect([...navRoutes], `no navbar entry reaches ${section}`).toContain(section);
		}
	});

	test("no page is orphaned from the navbar and from every other page", () => {
		const linked = new Set<string>();
		for (const page of pages) {
			for (const target of [
				...linksIn(frontmatter(page.source)),
				...linksIn(stripCode(page.source)),
			]) {
				if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target) || !target.startsWith("/")) continue;
				linked.add(normalizeRoute(target));
			}
		}
		for (const page of pages) {
			const route = normalizeRoute(page.route);
			if (route === "/") continue;
			const inSection = [...navRoutes].some((nav) => route === nav || route.startsWith(`${nav}/`));
			expect(
				inSection || linked.has(route),
				`${path.relative(REPO, page.file)} (${route}) is reachable from neither the navbar nor a link`,
			).toBe(true);
		}
	});

	test("every internal link resolves to a route", () => {
		for (const page of pages) {
			for (const target of [
				...linksIn(frontmatter(page.source)),
				...linksIn(stripCode(page.source)),
			]) {
				if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
				if (target.startsWith("#")) continue;
				const where = `${path.relative(REPO, page.file)} → ${target}`;
				if (!target.startsWith("/")) {
					expect(
						resolveRelative(target, page),
						`${where} does not resolve to a file`,
					).toBeDefined();
					continue;
				}
				const route = normalizeRoute(target);
				const generated =
					GENERATED_ROUTES[route] === true ||
					GENERATED_PREFIXES.some((prefix) => route.startsWith(prefix));
				expect(authoredRoutes.has(route) || generated, `${where} is not a published route`).toBe(
					true,
				);
			}
		}
	});

	test("canvas examples that publish a vault also pin fileRoutePrefix", () => {
		for (const page of pages) {
			const blocks = [...page.source.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)]
				.filter((match) => /^(?:ts|typescript|js)$/.test(match[1] as string))
				.map((match) => match[2] as string);
			for (const block of blocks) {
				// A Canvas file node resolves through fileRoutePrefix, which must name the
				// same prefix as the markdown plugin's vaultRoutePrefix or every card 404s.
				if (!/\bvaultRoutePrefix\b/.test(block) || !/\bcanvas\(/.test(block)) continue;
				expect(
					block,
					`${path.relative(REPO, page.file)} configures canvas() without fileRoutePrefix`,
				).toContain("fileRoutePrefix");
			}
		}
	});

	test("every stylesheet under docs/ is referenced", () => {
		const referencing = [
			fs.readFileSync(path.join(REPO, "rspress.config.ts"), "utf-8"),
			...pages.map((page) => page.source),
		].join("\n");
		const stylesheets = listFiles(DOCS).filter((file) => file.endsWith(".css"));
		expect(stylesheets.length).toBeGreaterThan(0);
		for (const file of stylesheets) {
			const relative = path.relative(REPO, file).split(path.sep).join("/");
			const name = path.basename(relative);
			// A bare filename only counts when it is unambiguous — a second
			// `theme.css` must be referenced by its own path.
			const unique = stylesheets.filter((other) => path.basename(other) === name).length === 1;
			expect(
				referencing.includes(relative) || (unique && referencing.includes(name)),
				`${relative} is referenced by nothing`,
			).toBe(true);
		}
	});

	test("every CSS class the styling guide documents still ships", () => {
		const guide = pages.find((page) => page.file.endsWith("canvas/guide/styling.md"));
		expect(guide, "docs/canvas/guide/styling.md is missing").toBeDefined();
		const classNames = [...(guide as Page).source.matchAll(/^\|\s*`\.([a-z][\w-]*)`/gm)].map(
			(match) => match[1] as string,
		);
		expect(classNames.length).toBeGreaterThan(10);
		const source = listFiles(path.join(REPO, "src"))
			.filter((file) => !/\.test\.tsx?$/.test(file))
			.map((file) => fs.readFileSync(file, "utf-8"))
			.join("\n");
		for (const name of classNames) {
			expect(
				source.includes(name),
				`styling.md documents .${name}, which no longer ships in src/`,
			).toBe(true);
		}
	});
});
