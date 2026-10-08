/**
 * The site's Rspress `base`, injected by the canvas plugin through
 * `source.define` (see `canvas()` in ../index.ts). Card HTML is set with
 * `innerHTML` and media `src` attributes are plain attributes, so Rspress never
 * rewrites them: every root-relative URL a card emits is prefixed here.
 */
declare const __RSPRESS_OBSIDIAN_CANVAS_BASE__: string | undefined;

/** The site base, always `/` or `/…/`; `/` outside an Rspress build. */
export function siteBase(): string {
	const base =
		typeof __RSPRESS_OBSIDIAN_CANVAS_BASE__ === "string" ? __RSPRESS_OBSIDIAN_CANVAS_BASE__ : "/";
	return normalizeSiteBase(base);
}

/** `docs`, `/docs` and `/docs/` all name the same base; `""` and `.` mean none. */
export function normalizeSiteBase(base: string | undefined): string {
	const trimmed = (base ?? "").trim().replace(/^\/+|\/+$/g, "");
	return !trimmed || trimmed === "." ? "/" : `/${trimmed}/`;
}

/**
 * Prefix a root-relative URL with the site base. Fragments, relative paths,
 * protocol-relative and absolute URLs, data URLs and URLs already under the
 * base pass through untouched.
 */
export function withSiteBase(url: string, base: string = siteBase()): string {
	const normalized = normalizeSiteBase(base);
	if (normalized === "/" || !url.startsWith("/") || url.startsWith("//")) return url;
	if (url === normalized.slice(0, -1) || url.startsWith(normalized)) return url;
	return `${normalized.slice(0, -1)}${url}`;
}
