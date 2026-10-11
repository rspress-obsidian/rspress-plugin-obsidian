/**
 * What the markdown plugin publishes, for the other features that have to
 * agree with it (the graph resolves links with the same indexes and options).
 *
 * Node-free and import-only-types so any bundle can read it; the markdown
 * plugin writes it from its `config` hook (and again from `addPages`, which
 * sees the final `root`). Without `markdown()` in the site it stays `undefined`.
 */
import type { DocsRouteLocales } from "./route-path.js";

/**
 * The options the plugin indexes a root with — structurally the markdown
 * feature's `ContentIndexOptions`, declared here because `src/shared` must
 * not depend on a feature.
 */
export interface PublishedIndexOptions {
	routePrefix?: string;
	locales?: DocsRouteLocales;
	unlinkedMentions?: boolean;
	dataview?: boolean;
	enableCaseInsensitiveLookup?: boolean;
	enableFuzzyMatching?: boolean;
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

let published: PublishedContentConfig | undefined;

export function setPublishedContent(config: PublishedContentConfig | undefined): void {
	published = config;
}

export function getPublishedContent(): PublishedContentConfig | undefined {
	return published;
}
