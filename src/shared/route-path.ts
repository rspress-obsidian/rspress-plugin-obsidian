/**
 * Route derivation shared by the markdown content index, the canvas file-node
 * resolver and the plugin option normalizers.
 *
 * Deliberately node-free: the canvas resolver ships in the browser bundle, and
 * `src/markdown/content-index.ts` (its former home) pulls `node:fs` into
 * anything that imports it. One implementation means a canvas card and a
 * wikilink cannot disagree about where a note is published.
 */

/** Backslashes to forward slashes, so Windows paths compare and split alike. */
export function normalizeFsPath(input: string): string {
	return input.replace(/\\/g, "/");
}

/**
 * Percent-encode a route's path segments while preserving its slashes. Content
 * page `routePath` values stay unencoded because they double as index keys; only
 * emitted hrefs go through here.
 */
export function encodeRoutePath(routePath: string): string {
	return routePath
		.split("/")
		.map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
		.join("/");
}

/** True when a vault-relative path names a section index page. */
export function isIndexRoute(relativePath: string): boolean {
	return /(?:^|\/)index\.(?:md|mdx)$/i.test(relativePath);
}

/**
 * Href for a published page.
 *
 * An index page is written to `<route>/index.html`, and Rspress normalizes a
 * slash-less route to `<route>.html` — a file that does not exist — so an href
 * without the trailing slash is dead on any host that maps URLs to files. Emit
 * the slash form, which is also what Rspress's own navigation uses and what its
 * route table registers.
 */
export function routeHref(routePath: string, relativePath: string): string {
	const href = encodeRoutePath(routePath);
	if (!isIndexRoute(relativePath) || href.endsWith("/")) return href;
	return `${href}/`;
}

/**
 * Vault-relative path to route key: `.`, `..` and empty segments are dropped,
 * then the extension and a trailing `index` are removed. An `index` page
 * collapses to the empty key, which callers render as the root route.
 */
export function normalizeRoutePath(input: string): string {
	const normalized = normalizeFsPath(input)
		.split("/")
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/")
		.replace(/\.(md|mdx)$/i, "")
		.replace(/\/index$/i, "")
		.trim();

	return normalized.toLowerCase() === "index" ? "" : normalized;
}

/** Published route for a vault-relative path, under an optional route prefix. */
export function deriveRoutePath(relativePath: string, routePrefix = ""): string {
	const routeKey = normalizeRoutePath(relativePath);
	const pagePath = routeKey.length === 0 ? "/" : `/${routeKey}`;
	return routePrefix ? `${routePrefix}${pagePath === "/" ? "" : pagePath}` || "/" : pagePath;
}

/**
 * The parts of an Rspress site config that shape a docs page's route: the
 * default language and the locale list, the default version and the version
 * list (`lang`, `locales[].lang`, `multiVersion`).
 */
export interface DocsRouteLocales {
	lang?: string;
	langs?: readonly string[];
	version?: string;
	versions?: readonly string[];
}

/**
 * The route Rspress publishes a docs-root file at — a port of its
 * `normalizeRoutePath` (route/normalizeRoutePath.js), which is not public API.
 * A leading version and then language segment are recognised; the default
 * version and default language are dropped (`en/guide.md` → `/guide` when
 * `lang: "en"`), others kept (`zh/guide.md` → `/zh/guide`). Unlike Rspress
 * the result carries no trailing slash for an `index` page; `routeHref` adds
 * it when emitting a link.
 */
export function deriveDocsRoutePath(relativePath: string, locales: DocsRouteLocales = {}): string {
	let route = normalizeFsPath(relativePath).replace(/\.(md|mdx)$/i, "");
	if (route.endsWith("/")) route = `${route}index`;
	const parts = route.split("/").filter(Boolean);
	let version = "";
	let lang = "";
	if (locales.version && parts[0] !== undefined && locales.versions?.includes(parts[0])) {
		version = parts.shift() ?? "";
	}
	if (locales.lang && parts[0] !== undefined && locales.langs?.includes(parts[0])) {
		lang = parts.shift() ?? "";
	}
	let pure = parts.join("/").replace(/\/index$/, "");
	if (pure === "index") pure = "";
	const prefix = [version === locales.version ? "" : version, lang === locales.lang ? "" : lang]
		.filter(Boolean)
		.join("/");
	return `/${[prefix, pure].filter(Boolean).join("/")}`;
}

/**
 * Normalize a route prefix to a leading slash and no trailing slash, returning
 * `fallback` when unset or empty. `fallback` is `""` for a vault root and
 * `"/vault"` where the option has that documented default.
 */
export function normalizeRoutePrefix(value: string | undefined, fallback = ""): string {
	if (!value) return fallback;

	const normalized = `/${value}`
		.replace(/\/+/g, "/")
		.split("/")
		.filter((segment) => segment !== "." && segment !== "..")
		.join("/")
		.replace(/\/+$/, "");

	// An empty result means the prefix was "/" or only separators: every caller
	// treats that as "no prefix", which is the documented fallback.
	return normalized === "" || normalized === "/" ? fallback : normalized;
}
