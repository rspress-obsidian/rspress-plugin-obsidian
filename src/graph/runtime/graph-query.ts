/**
 * The query language shared by the graph panel's search box and the plugin's
 * `groups` colour option, so a query typed into one behaves the same in the
 * other.
 *
 * A query is a whitespace-separated list of terms ANDed together. A term is
 * one of:
 *
 * - plain text — matches the node's label or route path (case-insensitive)
 * - `path:some/folder` — matches the node's route path
 * - `file:name` — matches the node's file name (the last route segment)
 * - `tag:project` — matches the tag page `/tags/project` (subtags included)
 *   or any page linked to that tag
 * - `-term` — negates any of the above
 *
 * Double quotes group a phrase; a quoted phrase is always plain text (it
 * carries no operator). An input with no matchable terms (empty string,
 * stray `-`) matches every node, which is what the unfiltered panel wants.
 */

export type GraphQueryTermKind = "text" | "path" | "file" | "tag";

export interface GraphQueryTerm {
	kind: GraphQueryTermKind;
	/** Lowercased, quotes and operator prefix stripped. Never empty. */
	value: string;
	negated: boolean;
}

export interface GraphQuery {
	terms: GraphQueryTerm[];
	/** True when the input carried no matchable term — matches everything. */
	isEmpty: boolean;
}

/** What a query matches against. `tags` are the tag routes this node links to. */
export interface QueryableNode {
	label: string;
	routePath: string;
	tags?: readonly string[];
}

const TOKEN_PATTERN = /-?"[^"]*"|\S+/g;
const OPERATOR_PATTERN = /^(path|file|tag):(.*)$/i;
const TAG_ROUTE_PREFIX = "/tags/";

export function parseGraphQuery(input: string): GraphQuery {
	const terms: GraphQueryTerm[] = [];

	for (const [rawToken] of input.matchAll(TOKEN_PATTERN)) {
		let token = rawToken;
		let negated = false;
		if (token.startsWith("-") && token.length > 1) {
			negated = true;
			token = token.slice(1);
		}

		if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
			const phrase = token.slice(1, -1).trim().toLowerCase();
			if (phrase) terms.push({ kind: "text", value: phrase, negated });
			continue;
		}

		const operator = OPERATOR_PATTERN.exec(token);
		if (operator) {
			const value = (operator[2] ?? "").trim().toLowerCase();
			if (!value) continue;
			const kind = (operator[1] ?? "text").toLowerCase() as GraphQueryTermKind;
			terms.push({ kind, value: kind === "tag" ? value.replace(/^#+/, "") : value, negated });
			continue;
		}

		const text = token.trim().toLowerCase();
		// A lone `-` is a stray negation with nothing to negate, not a search
		// for the character.
		if (text && text !== "-") terms.push({ kind: "text", value: text, negated });
	}

	return { terms, isEmpty: terms.length === 0 };
}

export function matchesGraphQuery(node: QueryableNode, query: GraphQuery): boolean {
	if (query.isEmpty) return true;
	const label = node.label.toLowerCase();
	const routePath = node.routePath.toLowerCase();
	return query.terms.every((term) => matchesTerm(node, label, routePath, term));
}

function matchesTerm(
	node: QueryableNode,
	label: string,
	routePath: string,
	term: GraphQueryTerm,
): boolean {
	const hit = matchTerm(node, label, routePath, term);
	return term.negated ? !hit : hit;
}

function matchTerm(
	node: QueryableNode,
	label: string,
	routePath: string,
	term: GraphQueryTerm,
): boolean {
	switch (term.kind) {
		case "path":
			return routePath.includes(term.value);
		case "file":
			return routeFileName(routePath).includes(term.value);
		case "tag":
			return matchesTag(node, routePath, term.value);
		case "text":
			return label.includes(term.value) || routePath.includes(term.value);
	}
}

/** The last route segment — the graph's stand-in for the file name. */
function routeFileName(routePath: string): string {
	const segments = routePath.split("/").filter(Boolean);
	return (segments[segments.length - 1] ?? routePath).toLowerCase();
}

/**
 * `tag:project` matches the tag page itself and every page that links to that
 * tag (its own tag edges), with Obsidian's subtag rule: `project` also matches
 * `project/ideas`.
 */
function matchesTag(node: QueryableNode, routePath: string, value: string): boolean {
	if (routePath.startsWith(TAG_ROUTE_PREFIX)) {
		const ownTag = routePath.slice(TAG_ROUTE_PREFIX.length);
		if (tagCovers(ownTag, value)) return true;
	}
	for (const tag of node.tags ?? []) {
		const normalized = tag.toLowerCase();
		const bare = normalized.startsWith(TAG_ROUTE_PREFIX)
			? normalized.slice(TAG_ROUTE_PREFIX.length)
			: normalized;
		if (tagCovers(bare, value)) return true;
	}
	return false;
}

function tagCovers(tag: string, value: string): boolean {
	return tag === value || tag.startsWith(`${value}/`);
}
