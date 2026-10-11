import { resolveWikiLink } from "../../markdown/resolve-wikilink.js";
import { tagRoutePath } from "../../shared/paths.js";
import { normalizeLookupValue } from "../../shared/slug.js";
import type { GraphData, GraphLink, GraphNode } from "../types.js";
import { normalizeRoutePath } from "../utils.js";
import { type GraphDocument, safeDecode, TAG_ROUTE_PREFIX } from "./documents.js";

export interface GraphBuildOutput {
	graph: GraphData;
	/** Source route → link targets that resolved to nothing. */
	unresolved: Map<string, Set<string>>;
	/** Outlinks run through `resolveWikiLink`. */
	resolvedLinks: number;
}

/**
 * Resolve every document's outlinks with the markdown plugin's own resolver
 * and turn the result into graph nodes and directed links: a page link becomes
 * an edge to that page, an attachment link an edge to an attachment node, a
 * tag an edge to a tag node, and a link that resolves to nothing an edge to an
 * unresolved ("ghost") node — the four node kinds Obsidian's graph draws.
 */
export function buildGraphData(documents: GraphDocument[]): GraphBuildOutput {
	const nodes = new Map<string, GraphNode>();
	const links: GraphLink[] = [];
	const seenLinks = new Set<string>();
	const unresolved = new Map<string, Set<string>>();
	const documentByFile = new Map<string, GraphDocument>();
	const documentByRoute = new Map<string, GraphDocument>();
	const tagNodeIdByKey = new Map<string, string>();
	// Labels a tag got from a note's own spelling, so a route's lowercased
	// segment never overrides how the vault writes the tag.
	const tagLabelFromNote = new Set<string>();
	let resolvedLinks = 0;

	for (const document of documents) {
		const id = document.route.routePath;
		documentByRoute.set(id, document);
		if (document.filePath) documentByFile.set(document.filePath, document);
		nodes.set(id, {
			id,
			label: document.label,
			kind: document.kind,
			navigable: true,
			path: document.path,
			// Whole milliseconds: the timelapse needs no more, and the payload ships integers.
			ctime: Math.round(document.ctime),
		});
		if (document.kind === "tag" && id.startsWith(TAG_ROUTE_PREFIX)) {
			tagNodeIdByKey.set(tagRoutePath(safeDecode(id.slice(TAG_ROUTE_PREFIX.length))), id);
		}
	}

	const addLink = (source: GraphDocument, targetId: string) => {
		const sourceId = source.route.routePath;
		if (sourceId === targetId) return;
		const key = `${sourceId}\u0000${targetId}`;
		if (seenLinks.has(key)) return;
		seenLinks.add(key);
		links.push({ source: sourceId, target: targetId });
		// Derived nodes (tags, attachments, ghosts) have no file of their own;
		// they appear in the timelapse with the first note that links them.
		const target = nodes.get(targetId);
		const sourceTime = Math.round(source.ctime);
		if (target && target.kind !== "page" && sourceTime > 0) {
			target.ctime = target.ctime > 0 ? Math.min(target.ctime, sourceTime) : sourceTime;
		}
	};

	const ensureNode = (node: GraphNode): string => {
		if (!nodes.has(node.id)) nodes.set(node.id, node);
		return node.id;
	};

	for (const document of documents) {
		const context = document.context;
		if (context) {
			for (const outlink of document.outlinks) {
				if (outlink.isCurrentPageReference || outlink.search) continue;
				resolvedLinks += 1;
				// The graph links notes, not headings: a dead `#heading` still links
				// the note, exactly as Obsidian draws it.
				const resolved = resolveWikiLink({ ...outlink, subpath: undefined }, context);
				if (resolved.status === "ok") {
					if (resolved.targetPage) {
						const target = documentByFile.get(resolved.targetPage.absolutePath.replace(/\\/g, "/"));
						if (target) addLink(document, target.route.routePath);
						continue;
					}
					const hrefPath = (resolved.href ?? "").split(/[?#]/, 1)[0] ?? "";
					if (resolved.canvasSrc) {
						const board = documentByRoute.get(normalizeRoutePath(safeDecode(hrefPath)));
						if (board) addLink(document, board.route.routePath);
						continue;
					}
					if (!hrefPath) continue;
					const filePath = safeDecode(hrefPath).replace(/^\/+/, "");
					addLink(
						document,
						ensureNode({
							id: hrefPath,
							label: filePath.split("/").pop() ?? filePath,
							kind: "attachment",
							navigable: true,
							path: filePath,
							ctime: 0,
						}),
					);
					continue;
				}

				const sourceId = document.route.routePath;
				const bucket = unresolved.get(sourceId);
				if (bucket) bucket.add(outlink.target);
				else unresolved.set(sourceId, new Set([outlink.target]));
				if (resolved.status !== "broken-page") continue;
				const ghostKey = normalizeLookupValue(outlink.target.replace(/\.mdx?$/i, ""));
				addLink(
					document,
					ensureNode({
						id: `?${ghostKey}`,
						label: outlink.target,
						kind: "unresolved",
						navigable: false,
						path: outlink.target,
						ctime: 0,
					}),
				);
			}
		}

		for (const tag of document.tags) {
			const key = tagRoutePath(tag);
			const id = tagNodeIdByKey.get(key) ?? key;
			const existing = nodes.get(id);
			if (!existing) {
				nodes.set(id, {
					id,
					label: `#${tag}`,
					kind: "tag",
					navigable: false,
					path: "",
					ctime: 0,
				});
				tagNodeIdByKey.set(key, id);
				tagLabelFromNote.add(id);
			} else if (existing.kind === "tag" && !tagLabelFromNote.has(id)) {
				existing.label = `#${tag}`;
				tagLabelFromNote.add(id);
			}
			addLink(document, id);
		}
	}

	return { graph: { nodes: [...nodes.values()], links }, unresolved, resolvedLinks };
}
