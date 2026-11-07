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
import type { ContentIndexOptions } from "./index-options.js";
import { attachPluginValue, findPluginValue } from "./plugin-channel.js";

/** A vault the markdown plugin publishes, with the options it indexes it with. */
interface PublishedVault {
	/** Absolute vault root. */
	root: string;
	/** Route prefix of vault pages (`"/vault"` by default). */
	routePrefix: string;
	/** The options the plugin indexes the vault with. */
	indexOptions: ContentIndexOptions;
}

/** Link-resolution switches with this site's defaults already applied. */
export interface PublishedResolveOptions {
	enableCaseInsensitiveLookup: boolean;
	enableFuzzyMatching: boolean;
}

/** The switches a markdown plugin uses when the site configures none. */
export const DEFAULT_RESOLVE_OPTIONS: PublishedResolveOptions = {
	enableCaseInsensitiveLookup: true,
	enableFuzzyMatching: false,
};

export interface PublishedContentConfig {
	/** Absolute docs root (`config.root`). */
	docsRoot: string;
	/** The published vault, when there is one. */
	vault?: PublishedVault;
	/**
	 * The exact options the plugin indexes each root with, so a reader hits the
	 * same `getCachedContentIndex` entry. The docs options carry the site's
	 * locales and resolution rules, so docs routes and link resolution match the
	 * ones Rspress publishes.
	 */
	docsIndexOptions: ContentIndexOptions;
	/**
	 * How links resolve on this site, defaults applied. Features resolve with
	 * this rather than re-deriving the switches from an index's options: the
	 * note pass, the canvas and the graph must resolve alike, whichever tree
	 * the target lives in.
	 */
	resolveOptions: PublishedResolveOptions;
}

/** Name the markdown plugin publishes under; see {@link attachPluginValue}. */
const PUBLISHED_CONTENT = "published-content";

/** Attach the reader a sibling feature calls to learn what `plugin` publishes. */
export function attachPublishedContent<Plugin extends object>(
	plugin: Plugin,
	read: () => PublishedContentConfig,
): Plugin {
	return attachPluginValue(plugin, PUBLISHED_CONTENT, read);
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
	return findPluginValue<PublishedContentConfig>(config, PUBLISHED_CONTENT);
}
