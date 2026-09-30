import * as path from "node:path";
import { findCanvasBoard } from "../../shared/canvas-routes.js";
import { normalizeLookupValue } from "../../shared/slug.js";
import type { GraphData, GraphLink, GraphNode } from "../types.js";
import { normalizeRoutePath } from "../utils.js";
import type { ScannedRouteDocument } from "./cache.js";
import type { CollectedRoute } from "./types.js";

export function buildGraphData(
	routes: CollectedRoute[],
	scannedDocuments: ScannedRouteDocument[],
	/**
	 * What to do about a link that resolves to no route.
	 *
	 * The graph sees every authored link, so a page that demonstrates an
	 * unresolved link on purpose reports here too — and the markdown plugin has
	 * already reported it through its own `onBrokenLink`. `"ignore"` is for a
	 * site that has told the markdown plugin what it wants to hear about.
	 */
	onUnresolvedLink: "error" | "warn" | "ignore" = "warn",
): GraphData {
	const routeByPath = new Map<string, CollectedRoute>();
	const routeByFile = new Map<string, CollectedRoute>();
	// Case-insensitive path lookup, mirroring the markdown resolver's
	// `byFilePathKeyCI` (on by default, matching Obsidian). A link whose spelling
	// differs only in case still renders on the page, so the graph must agree.
	const routeByFileCI = new Map<string, CollectedRoute[]>();
	// Obsidian resolves `[[Note]]` by file basename, so the graph needs that
	// lookup too — a vault link rarely spells out the path.
	const routeByBaseName = new Map<string, CollectedRoute[]>();
	// Frontmatter `title`/`aliases` resolve like basenames: a wikilink may
	// address a page by name, and the markdown pipeline accepts it.
	const routeByName = new Map<string, CollectedRoute[]>();
	const titleByRoute = new Map<string, string | undefined>();

	for (const route of routes) {
		routeByPath.set(route.routePath, route);
		for (const alias of buildFileAliases(route)) {
			routeByFile.set(alias, route);
			pushBucket(routeByFileCI, alias.toLowerCase(), route);
		}
		const baseName = baseNameKey(route);
		if (baseName) {
			pushBucket(routeByBaseName, baseName, route);
		}
	}

	for (const scannedDocument of scannedDocuments) {
		titleByRoute.set(scannedDocument.route.routePath, scannedDocument.inferredTitle);
		for (const name of scannedDocument.names) {
			pushBucket(routeByName, normalizeLookupValue(name), scannedDocument.route);
		}
	}

	const links: GraphLink[] = [];
	const seenLinks = new Set<string>();
	const unresolvedLinks = new Map<string, Set<string>>();

	for (const scannedDocument of scannedDocuments) {
		for (const rawLink of scannedDocument.rawLinks) {
			const targetRoute = resolveLinkedRoute(
				scannedDocument.route.absolutePath,
				rawLink,
				routeByPath,
				routeByFile,
				routeByFileCI,
				routeByBaseName,
				routeByName,
			);

			if (!targetRoute) {
				// Tag routes exist only when the markdown plugin runs with
				// `enableTagPages`; a `graphview()`-only install has no `/tags/…`
				// route, so a tag link is not a broken authored link — drop it
				// silently, the same treatment attachment embeds get. A tag page
				// that *does* exist still resolves above and becomes an edge.
				if (rawLink === "/tags" || rawLink.startsWith("/tags/")) continue;

				const source = scannedDocument.route.routePath;
				const bucket = unresolvedLinks.get(source);
				if (bucket) bucket.add(rawLink);
				else unresolvedLinks.set(source, new Set([rawLink]));
				continue;
			}

			const source = scannedDocument.route.routePath;
			const target = targetRoute.routePath;
			if (source === target) continue;
			const linkKey = `${source}→${target}`;
			if (seenLinks.has(linkKey)) continue;

			seenLinks.add(linkKey);
			links.push({ source, target });
		}
	}

	if (unresolvedLinks.size > 0 && onUnresolvedLink !== "ignore") {
		const lines: string[] = [];
		for (const [source, targets] of unresolvedLinks) {
			for (const target of targets) {
				lines.push(`  ${source} -> ${target}`);
			}
		}
		const message = `[rspress-plugin-obsidian:graph] ${unresolvedLinks.size} page(s) reference ${countTargets(unresolvedLinks)} unresolved internal link(s):\n${lines.join("\n")}`;
		if (onUnresolvedLink === "error") {
			// The graph build has no VFile to fail through, and a link that goes
			// nowhere is a mistake worth stopping a build over.
			throw new Error(message);
		}
		console.warn(message);
	}

	const nodes: GraphNode[] = routes.map((route) => ({
		id: route.routePath,
		label: makeNodeLabel(route, titleByRoute.get(route.routePath)),
		routePath: route.routePath,
	}));

	return { nodes, links };
}

function countTargets(unresolvedLinks: Map<string, Set<string>>): number {
	let count = 0;
	for (const targets of unresolvedLinks.values()) {
		count += targets.size;
	}
	return count;
}

/** Append to a many-valued lookup bucket, creating it on first use. */
function pushBucket<K, V>(buckets: Map<K, V[]>, key: K, value: V): void {
	const bucket = buckets.get(key);
	if (bucket) bucket.push(value);
	else buckets.set(key, [value]);
}

/** Case-insensitive lookup key for a route's file basename, extension dropped. */
function baseNameKey(route: CollectedRoute): string {
	const absolute = path.normalize(route.absolutePath);
	const extension = path.extname(absolute);
	const withoutExtension = extension ? absolute.slice(0, -extension.length) : absolute;
	const baseName = path.basename(withoutExtension);
	return baseName.toLowerCase();
}

/** The `[[…]]` / `[…](…)` target with any heading or block fragment removed. */
function stripFragment(rawLink: string): string {
	const hashIndex = rawLink.indexOf("#");
	return (hashIndex === -1 ? rawLink : rawLink.slice(0, hashIndex)).trim();
}

function buildFileAliases(route: CollectedRoute): string[] {
	const aliases = new Set<string>();
	const absolute = path.normalize(route.absolutePath);
	aliases.add(absolute);

	const extension = path.extname(absolute);
	const withoutExtension = extension ? absolute.slice(0, -extension.length) : absolute;

	aliases.add(withoutExtension);

	if (path.basename(withoutExtension) === "index") {
		aliases.add(path.dirname(withoutExtension));
	}

	return [...aliases];
}

function resolveLinkedRoute(
	sourceAbsolutePath: string,
	rawLink: string,
	routeByPath: Map<string, CollectedRoute>,
	routeByFile: Map<string, CollectedRoute>,
	routeByFileCI: Map<string, CollectedRoute[]>,
	routeByBaseName: Map<string, CollectedRoute[]>,
	routeByName: Map<string, CollectedRoute[]>,
): CollectedRoute | undefined {
	if (rawLink.startsWith("#")) return undefined;

	// A published board's route table entry points at a temp file (the canvas
	// feature feeds Rspress pre-rendered content), so file/path matching can
	// never find it — ask the canvas registry, keyed by the vault-relative
	// name the link was authored with. Without it every `[[Board.canvas]]`
	// would warn as unresolved on every build.
	if (/\.canvas$/i.test(rawLink)) {
		const board = findCanvasBoard(rawLink);
		if (board) return routeByPath.get(normalizeRoutePath(board.routePath));
	}

	if (rawLink.startsWith("/")) {
		return routeByPath.get(normalizeRoutePath(normalizeAbsoluteLinkTarget(rawLink)));
	}

	const rootTarget = normalizeRoutePath(`/${normalizeAbsoluteLinkTarget(rawLink)}`);
	const rootRoute = routeByPath.get(rootTarget);
	if (rootRoute && !rawLink.startsWith("./") && !rawLink.startsWith("../")) {
		return rootRoute;
	}

	const basePath = path.resolve(path.dirname(sourceAbsolutePath), rawLink);
	const candidates = new Set<string>();
	const normalizedBase = path.normalize(basePath);
	candidates.add(normalizedBase);

	const extension = path.extname(normalizedBase);
	if (extension) {
		const withoutExtension = normalizedBase.slice(0, -extension.length);
		candidates.add(withoutExtension);
		if (path.basename(withoutExtension) === "index") candidates.add(path.dirname(withoutExtension));
	} else {
		candidates.add(`${normalizedBase}.md`);
		candidates.add(`${normalizedBase}.mdx`);
		candidates.add(path.join(normalizedBase, "index.md"));
		candidates.add(path.join(normalizedBase, "index.mdx"));
	}

	for (const candidate of candidates) {
		const matchedRoute = routeByFile.get(path.normalize(candidate));
		if (matchedRoute) return matchedRoute;
	}

	// Case-insensitive fallback, mirroring the markdown resolver's
	// `byFilePathKeyCI`: a link spelled `../Guide/Note.md` still resolves to
	// `guide/note.md`. Only an unambiguous match resolves — two files differing
	// only in case stay unresolved, exactly like the resolver's ambiguity report.
	for (const candidate of candidates) {
		const caseInsensitiveMatches = routeByFileCI.get(path.normalize(candidate).toLowerCase());
		if (!caseInsensitiveMatches) continue;
		if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0];
		return undefined;
	}

	// Obsidian's own resolution: a bare target names a file, wherever it lives —
	// `[[Note]]` and `[text](Note.md)` alike. Only an unambiguous basename
	// resolves; several matches stay unresolved, matching how the markdown
	// pipeline reports ambiguous links.
	//
	// Explicitly relative targets are excluded: the markdown pipeline resolves
	// `./x.md` against the source file and reports a miss as broken, so the graph
	// must not invent an edge for a link the build rejects.
	const target = stripFragment(rawLink);
	if (!target || target.startsWith("/") || path.isAbsolute(target)) return undefined;
	if (/^\.\.?\//.test(target)) return undefined;
	const targetBaseName = path
		.basename(target)
		.replace(/\.(md|mdx)$/i, "")
		.toLowerCase();
	const byBaseName = routeByBaseName.get(targetBaseName);
	if (byBaseName) return byBaseName.length === 1 ? byBaseName[0] : undefined;

	// Last step, matching the markdown resolver's ladder: a unique frontmatter
	// title or alias. Several pages may claim one name, in which case the link
	// stays unresolved there too.
	const byName = routeByName.get(normalizeLookupValue(target));
	return byName?.length === 1 ? byName[0] : undefined;
}

function normalizeAbsoluteLinkTarget(rawLink: string): string {
	return (
		rawLink
			.replace(/\/+$/g, "")
			.replace(/\.(md|mdx)$/i, "")
			.replace(/\/index$/i, "") || "/"
	);
}

function makeNodeLabel(route: CollectedRoute, inferredTitle?: string): string {
	if (inferredTitle) {
		return inferredTitle;
	}

	if (route.routePath === "/") {
		return "Home";
	}

	return route.pageName || route.routePath;
}
