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
 * Registry linking published non-Markdown files to their pages, one per build:
 * two sites built by the same process must not resolve each other's links.
 *
 * A feature registers its files from `addPages`, which runs before any page is
 * compiled and before attachments are staged. Link resolution consults it, so
 * `[[Projects.base]]` opens the base's page instead of downloading the YAML —
 * and a file with a page is never also staged as an attachment.
 */
export interface FileRoutes {
	/** Replace every route of `kind` with `routes` (a rebuild drops files that are gone). */
	set(kind: string, routes: Iterable<PublishedFileRoute>): void;
	/** The page a published file is shown on, if any feature published it. */
	find(absolutePath: string): PublishedFileRoute | undefined;
	/** Every file `kind` published. */
	byKind(kind: string): readonly PublishedFileRoute[];
	/** Forget every published file. */
	clear(): void;
}

/** An empty registry; a build creates one and hands it to its features. */
export function createFileRoutes(): FileRoutes {
	const byKind = new Map<string, PublishedFileRoute[]>();
	const byAbsolutePath = new Map<string, PublishedFileRoute>();
	return {
		set(kind, routes) {
			for (const previous of byKind.get(kind) ?? []) byAbsolutePath.delete(previous.absolutePath);
			const next = [...routes].map((route) => ({
				...route,
				absolutePath: normalizeFsPath(route.absolutePath),
			}));
			byKind.set(kind, next);
			for (const route of next) byAbsolutePath.set(route.absolutePath, route);
		},
		find(absolutePath) {
			return byAbsolutePath.get(normalizeFsPath(absolutePath));
		},
		byKind(kind) {
			return byKind.get(kind) ?? [];
		},
		clear() {
			byKind.clear();
			byAbsolutePath.clear();
		},
	};
}
