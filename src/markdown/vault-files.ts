/**
 * Looking up a vault file by its exact path, and telling a private file from a
 * missing one. Shared by the canvas feature (file cards) and the graph (canvas
 * board links), so a card the board publishes without its path never comes
 * back as a named node in the graph, and both read a path's case the same way.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { NOTE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { normalizeFilePathKey } from "../shared/paths.js";
import type { ContentAsset, ContentIndex, ContentPage } from "./types.js";

/**
 * The page an exact vault path names, case-insensitive like Obsidian: a
 * spelling several files share matches none of them.
 */
export function findPageByPath(index: ContentIndex, file: string): ContentPage | undefined {
	const key = normalizeFilePathKey(file);
	const insensitive = index.byFilePathKeyCI.get(key.toLowerCase());
	return index.byFilePathKey.get(key) ?? (insensitive?.length === 1 ? insensitive[0] : undefined);
}

/** The attachment an exact vault path names, case-insensitive like {@link findPageByPath}. */
export function findAssetByPath(index: ContentIndex, file: string): ContentAsset | undefined {
	const key = normalizeFilePathKey(file);
	const insensitive = index.byAssetPathCI.get(key.toLowerCase());
	return index.byAssetPath.get(key) ?? (insensitive?.length === 1 ? insensitive[0] : undefined);
}

/**
 * Directory entries already read, by absolute directory (`undefined`: not a
 * readable directory). One map per build pass, so each directory a pass asks
 * about is read once.
 */
export type DirectoryListings = Map<string, readonly string[] | undefined>;

/**
 * Whether `file` (relative to `root`) is on disk but not published: a
 * `publish: false` note, anything in a dot-folder, a `_`-prefixed or excluded
 * folder, or outside the vault. The site must not name such a file, whatever
 * its kind. A note is published when the index holds it as a page, a board
 * when `isPublishedBoard` says so, anything else when it is an indexed
 * attachment. A path that is not on disk at all is missing, not private.
 *
 * The disk is asked case-insensitively, as Obsidian and the index match
 * names: on a case-sensitive filesystem `_Private/secret.md` naming
 * `_private/Secret.md` would otherwise count as missing, and a missing file's
 * path is published.
 */
export function isPrivateVaultFile(
	index: ContentIndex,
	root: string,
	file: string,
	isPublishedBoard: (file: string) => boolean,
	listings: DirectoryListings = new Map(),
): boolean {
	const extension = path.extname(file).toLowerCase();
	const published = NOTE_MARKDOWN_EXTENSIONS.has(extension)
		? findPageByPath(index, file) !== undefined
		: extension === ".canvas"
			? isPublishedBoard(file)
			: findAssetByPath(index, file) !== undefined;
	return !published && existsIgnoringCase(root, file, listings);
}

function readListing(directory: string, listings: DirectoryListings): readonly string[] {
	if (!listings.has(directory)) {
		let entries: string[] | undefined;
		try {
			entries = readdirSync(directory);
		} catch {
			entries = undefined;
		}
		listings.set(directory, entries);
	}
	return listings.get(directory) ?? [];
}

/**
 * Whether `root/file` exists under any casing of its segments. Inside `root`
 * the walk starts there; a path that leaves it starts at the filesystem root.
 */
function existsIgnoringCase(root: string, file: string, listings: DirectoryListings): boolean {
	const absolute = path.resolve(root, file);
	if (existsSync(absolute)) return true;
	const base = path.resolve(root);
	const inside = path.relative(base, absolute);
	const start =
		inside && !inside.startsWith("..") && !path.isAbsolute(inside)
			? base
			: path.parse(absolute).root;
	let directories = [start];
	for (const segment of path.relative(start, absolute).split(path.sep).filter(Boolean)) {
		const wanted = segment.toLowerCase();
		directories = directories.flatMap((directory) =>
			readListing(directory, listings)
				.filter((name) => name.toLowerCase() === wanted)
				.map((name) => path.join(directory, name)),
		);
		if (directories.length === 0) return false;
	}
	return true;
}
