import { normalizeFsPath } from "./route-path.js";

/**
 * A non-Markdown vault file a feature publishes as its own page — a `.base`
 * file's view, a plain `.excalidraw` drawing — rather than as a raw attachment.
 */
export interface PublishedFileRoute {
	/** The feature that publishes it (`"bases"`, `"excalidraw"`). */
	kind: string;
	/** The file on disk. */
	absolutePath: string;
	/** Route of the page that shows it. */
	routePath: string;
	/** Path relative to the root it was found in, `/`-separated. */
	source: string;
}

/**
 * Registry linking published non-Markdown files to their pages.
 *
 * A feature registers its files from `addPages`, which runs before any page is
 * compiled and before attachments are staged. Link resolution consults it, so
 * `[[Projects.base]]` opens the base's page instead of downloading the YAML —
 * and a file with a page is never also staged as an attachment.
 */
const byKind = new Map<string, PublishedFileRoute[]>();
const byAbsolutePath = new Map<string, PublishedFileRoute>();

/** Replace every route of `kind` with `routes` (a rebuild drops files that are gone). */
export function setPublishedFileRoutes(kind: string, routes: Iterable<PublishedFileRoute>): void {
	for (const previous of byKind.get(kind) ?? []) byAbsolutePath.delete(previous.absolutePath);
	const next = [...routes].map((route) => ({
		...route,
		absolutePath: normalizeFsPath(route.absolutePath),
	}));
	byKind.set(kind, next);
	for (const route of next) byAbsolutePath.set(route.absolutePath, route);
}

/** The page a published file is shown on, if any feature published it. */
export function findPublishedFileRoute(absolutePath: string): PublishedFileRoute | undefined {
	return byAbsolutePath.get(normalizeFsPath(absolutePath));
}

/** Every file `kind` published. */
export function publishedFileRoutes(kind: string): readonly PublishedFileRoute[] {
	return byKind.get(kind) ?? [];
}

/** Forget every published file (a new build, or an isolated test). */
export function clearPublishedFileRoutes(): void {
	byKind.clear();
	byAbsolutePath.clear();
}
