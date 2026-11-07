/**
 * The options a root is indexed with. Declared node-free so `src/shared` can
 * carry the exact type the markdown feature indexes with, and a reader in
 * another bundle sees the options it was published with rather than a copy
 * of their shape.
 */
import type { DocsRouteLocales } from "./route-path.js";

export interface ContentIndexOptions {
	/**
	 * Route prefix pages publish under (a vault's `vaultRoutePrefix`). Without
	 * one, the root is the Rspress docs root and routes follow Rspress's own
	 * rules, including `locales`.
	 */
	routePrefix?: string;
	/**
	 * The site's `lang`/`locales`/`multiVersion`, for a docs root: Rspress drops
	 * the default language and version segment from a route (`en/guide.md` is
	 * served at `/guide` when `lang: "en"`). Ignored when `routePrefix` is set.
	 */
	locales?: DocsRouteLocales;
	/**
	 * Keep a stripped copy of each page's body so `getMentions` can find pages
	 * that name another page without linking to it. Off by default: it is the only
	 * thing here that retains page text.
	 */
	unlinkedMentions?: boolean;
	/**
	 * Extract Dataview fields, tasks and list items. Default `true`; the plugin
	 * turns it off with `enableDataview`, which saves roughly a third of the
	 * indexing time.
	 */
	dataview?: boolean;
	/** How the index resolves links and computes backlinks. */
	enableCaseInsensitiveLookup?: boolean;
	enableFuzzyMatching?: boolean;
	/**
	 * Root-relative folders whose files are neither indexed nor published
	 * (Templater's templates folder), on top of the hidden folders that never
	 * are. `/`-separated, matched case-sensitively from the root.
	 */
	excludeFolders?: string[];
}
