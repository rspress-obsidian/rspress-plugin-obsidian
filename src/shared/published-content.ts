/**
 * What the markdown plugin publishes, for the other features that have to
 * agree with it (the graph resolves links with the same indexes and options,
 * canvas cards link the routes the notes are published at).
 *
 * There is no module state: the markdown plugin object carries a reader for
 * its own configuration, and a sibling feature finds it in the `plugins` of
 * the site config Rspress hands every hook. Each site therefore sees its own
 * markdown plugin, however many sites a process builds, and the order the
 * plugins are listed in does not matter: readers look it up in `addPages` and
 * later hooks, after every `config` hook has run. A markdown plugin another
 * plugin adds with `utils.addPlugin` is not in that list on its own — Rspress
 * keeps the registered plugins private — so its `config` hook lists it there.
 *
 * Node-free and import-only-types so any bundle can read it.
 */
import type { DocsRouteLocales } from "./route-path.js";

/**
 * The options the plugin indexes a root with — structurally the markdown
 * feature's `ContentIndexOptions`, declared here because `src/shared` must
 * not depend on a feature.
 */
interface PublishedIndexOptions {
	routePrefix?: string;
	locales?: DocsRouteLocales;
	unlinkedMentions?: boolean;
	dataview?: boolean;
	enableCaseInsensitiveLookup?: boolean;
	enableFuzzyMatching?: boolean;
	excludeFolders?: string[];
}

export interface PublishedContentConfig {
	/** Absolute docs root (`config.root`). */
	docsRoot: string;
	/** Absolute vault root, when a vault is published. */
	vaultRoot?: string;
	/** Route prefix of vault pages (`"/vault"` by default). */
	vaultRoutePrefix: string;
	/**
	 * The exact options the plugin indexes each root with, so a reader hits the
	 * same `getCachedContentIndex` entry. The docs options carry the site's
	 * locales, so docs routes match the ones Rspress publishes.
	 */
	docsIndexOptions: PublishedIndexOptions;
	vaultIndexOptions?: PublishedIndexOptions;
	enableCaseInsensitiveLookup: boolean;
	enableFuzzyMatching: boolean;
}

// `Symbol.for`, not `Symbol()`: the per-feature entries may be loaded as
// separate bundle copies (an ESM and a CJS entry side by side), and each copy
// has to recognise a markdown plugin built by another.
const PUBLISHED_CONTENT = Symbol.for("rspress-plugin-obsidian:published-content");

type PublishedContentReader = () => PublishedContentConfig;

/** Attach the reader a sibling feature calls to learn what `plugin` publishes. */
export function attachPublishedContent<Plugin extends object>(
	plugin: Plugin,
	read: PublishedContentReader,
): Plugin {
	return Object.assign(plugin, { [PUBLISHED_CONTENT]: read });
}

/**
 * What the markdown plugin of this site publishes, found among the site's
 * `plugins` (where its `config` hook makes sure it is listed); `undefined`
 * when the site has no markdown plugin. Rspress refuses two plugins with one
 * name, so a site has at most one.
 */
export function findPublishedContent(config: {
	plugins?: readonly unknown[];
}): PublishedContentConfig | undefined {
	for (const plugin of config.plugins ?? []) {
		if (typeof plugin !== "object" || plugin === null || !(PUBLISHED_CONTENT in plugin)) continue;
		const read = plugin[PUBLISHED_CONTENT];
		if (typeof read === "function") return read();
	}
	return undefined;
}
