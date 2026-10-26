import type { ContentIndex } from "./types.js";

/** The docs and vault trees of one site, each linked to the other. */
export interface LinkedContentIndexes {
	docs: ContentIndex;
	vault?: ContentIndex;
}

// Per pair of cached indexes, so every reader of an unchanged pair — the
// remark pass, attachment publishing, a canvas board — gets the same views,
// and the caches keyed by index identity (backlinks, Dataview lookups) keep
// their entries until either tree is re-indexed.
const linkedViews = new WeakMap<ContentIndex, WeakMap<ContentIndex, LinkedContentIndexes>>();
// Each view's wrapped index: tables filled while an index is built (the
// mention sources) are keyed by the index itself, not by its views.
const viewBases = new WeakMap<ContentIndex, ContentIndex>();

/** The cached index `index` is a view of, or `index` itself. */
export function baseIndexOf(index: ContentIndex): ContentIndex {
	return viewBases.get(index) ?? index;
}

/**
 * Views of `docs` and `vault` whose `linkedIndexes` name each other, so a link
 * with no match in its own tree resolves in the other and backlinks follow it
 * both ways. The views share every table with the indexes they wrap; the
 * indexes themselves — the objects `getCachedContentIndex` hands to every
 * reader, whatever site it builds — are left untouched.
 */
export function linkContentIndexes(docs: ContentIndex, vault?: ContentIndex): LinkedContentIndexes {
	if (!vault) return { docs };
	let byVault = linkedViews.get(docs);
	if (!byVault) {
		byVault = new WeakMap();
		linkedViews.set(docs, byVault);
	}
	const cached = byVault.get(vault);
	if (cached) return cached;
	const docsView: ContentIndex = { ...docs };
	const vaultView: ContentIndex = { ...vault, linkedIndexes: [docsView] };
	docsView.linkedIndexes = [vaultView];
	viewBases.set(docsView, docs);
	viewBases.set(vaultView, vault);
	const linked = { docs: docsView, vault: vaultView };
	byVault.set(vault, linked);
	return linked;
}
