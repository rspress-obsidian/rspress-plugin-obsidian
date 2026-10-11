import type {
	CanvasData,
	CanvasEdgeData,
	CanvasFileKind,
	CanvasLink,
	CanvasLinks,
	CanvasNode,
	CanvasResolvedFile,
} from "./types.js";

export class CanvasParseError extends Error {
	constructor(message: string) {
		super(`Canvas parse error: ${message}`);
		this.name = "CanvasParseError";
	}
}

export interface ParseCanvasOptions {
	/**
	 * Accept the build-time fields the canvas plugin adds when it publishes a
	 * board (`resolvedFile`, `resolvedBackground`, `assets`, `notes`, `links`).
	 * Off for `.canvas` source files: a hand-written `resolvedFile` or `assets`
	 * entry would otherwise steer what the published page loads, and an
	 * exported board re-imported into the editor must not carry them back.
	 * @default false
	 */
	enriched?: boolean;
}

const VALID_NODE_TYPES = ["text", "file", "link", "group"] as const;
const VALID_SIDES = ["top", "right", "bottom", "left"] as const;
const VALID_EDGE_ENDS = ["none", "arrow"] as const;
const VALID_BACKGROUND_STYLES = ["cover", "ratio", "repeat"] as const;
const VALID_FILE_KINDS: Record<CanvasFileKind, true> = {
	note: true,
	image: true,
	audio: true,
	video: true,
	pdf: true,
	canvas: true,
	file: true,
	missing: true,
	private: true,
};

/**
 * Node fields only the publisher writes. The first two are current; the rest
 * are what earlier versions of this package wrote into published boards (and
 * so into editor exports). None of them is JSON Canvas, so a source file that
 * carries one has it dropped rather than trusted.
 */
const NODE_ENRICHMENT_KEYS = [
	"resolvedFile",
	"resolvedBackground",
	"fileContent",
	"assetUrl",
	"imageUrl",
	"mediaType",
	"isImage",
	"isVideo",
	"isAudio",
	"isPdf",
	"isError",
	"backgroundUrl",
] as const;

/** Top-level fields only the publisher (or the parser itself) writes. */
const DOCUMENT_ENRICHMENT_KEYS = ["assets", "notes", "links", "problems"] as const;

function assertString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new CanvasParseError(`Expected ${field} to be a string, got ${typeof value}`);
	}
	return value;
}

function assertNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new CanvasParseError(`Expected ${field} to be a finite number, got ${typeof value}`);
	}
	return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return assertString(value, field);
}

function assertOneOf<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	field: string,
): T | undefined {
	if (value !== undefined && !allowed.includes(value as T)) {
		throw new CanvasParseError(`Invalid ${field}: ${value}`);
	}
	return value as T | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The record with every enrichment key removed and every `undefined` dropped,
 * so a validated optional field that was absent stays absent on export.
 */
function withoutKeys(
	record: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined && !keys.includes(key)) result[key] = value;
	}
	return result;
}

function parseResolvedFile(value: unknown): CanvasResolvedFile | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new CanvasParseError("Expected node.resolvedFile to be an object");
	const kind = assertString(value.kind, "node.resolvedFile.kind");
	if (!VALID_FILE_KINDS[kind as CanvasFileKind]) {
		throw new CanvasParseError(`Invalid node.resolvedFile.kind: ${kind}`);
	}
	const resolved: CanvasResolvedFile = { kind: kind as CanvasFileKind };
	const key = assertOptionalString(value.key, "node.resolvedFile.key");
	const href = assertOptionalString(value.href, "node.resolvedFile.href");
	if (key !== undefined) resolved.key = key;
	if (href !== undefined) resolved.href = href;
	if (value.missingSubpath === true) resolved.missingSubpath = true;
	return resolved;
}

function validateNode(node: unknown, enriched: boolean): CanvasNode {
	if (!isRecord(node)) {
		throw new CanvasParseError("Node must be an object");
	}

	const id = assertString(node.id, "node.id");
	const type = assertString(node.type, "node.type");
	const x = assertNumber(node.x, "node.x");
	const y = assertNumber(node.y, "node.y");
	const width = assertNumber(node.width, "node.width");
	const height = assertNumber(node.height, "node.height");
	const color = assertOptionalString(node.color, "node.color");
	assertOneOf(type, VALID_NODE_TYPES, "node type");

	// Unknown fields ride along: JSON Canvas is meant to be extended, and the
	// editor exports what it was given rather than a whitelist of it.
	const base: Record<string, unknown> = {
		...withoutKeys(node, NODE_ENRICHMENT_KEYS),
		id,
		type,
		x,
		y,
		width,
		height,
	};
	if (color !== undefined) base.color = color;
	else delete base.color;

	switch (type) {
		case "text": {
			const text = assertString(node.text, "node.text");
			return { ...base, type: "text", text } as unknown as CanvasNode;
		}
		case "file": {
			const file = assertString(node.file, "node.file");
			const subpath = assertOptionalString(node.subpath, "node.subpath");
			const result: Record<string, unknown> = { ...base, type: "file", file };
			if (subpath !== undefined) result.subpath = subpath;
			if (enriched) {
				const resolvedFile = parseResolvedFile(node.resolvedFile);
				if (resolvedFile) result.resolvedFile = resolvedFile;
			}
			return result as unknown as CanvasNode;
		}
		case "link": {
			const url = assertString(node.url, "node.url");
			return { ...base, type: "link", url } as unknown as CanvasNode;
		}
		default: {
			const label = assertOptionalString(node.label, "node.label");
			const background = assertOptionalString(node.background, "node.background");
			const backgroundStyle = assertOneOf(
				assertOptionalString(node.backgroundStyle, "node.backgroundStyle"),
				VALID_BACKGROUND_STYLES,
				"backgroundStyle",
			);
			const result: Record<string, unknown> = { ...base, type: "group" };
			if (label !== undefined) result.label = label;
			if (background !== undefined) result.background = background;
			if (backgroundStyle !== undefined) result.backgroundStyle = backgroundStyle;
			if (enriched) {
				const resolvedBackground = assertOptionalString(
					node.resolvedBackground,
					"node.resolvedBackground",
				);
				if (resolvedBackground !== undefined) result.resolvedBackground = resolvedBackground;
			}
			return result as unknown as CanvasNode;
		}
	}
}

function validateEdge(edge: unknown): CanvasEdgeData {
	if (!isRecord(edge)) {
		throw new CanvasParseError("Edge must be an object");
	}

	const result: Record<string, unknown> = {
		...withoutKeys(edge, []),
		id: assertString(edge.id, "edge.id"),
		fromNode: assertString(edge.fromNode, "edge.fromNode"),
		toNode: assertString(edge.toNode, "edge.toNode"),
	};
	const optional = {
		fromSide: assertOneOf(
			assertOptionalString(edge.fromSide, "edge.fromSide"),
			VALID_SIDES,
			"fromSide",
		),
		toSide: assertOneOf(assertOptionalString(edge.toSide, "edge.toSide"), VALID_SIDES, "toSide"),
		fromEnd: assertOneOf(
			assertOptionalString(edge.fromEnd, "edge.fromEnd"),
			VALID_EDGE_ENDS,
			"fromEnd",
		),
		toEnd: assertOneOf(assertOptionalString(edge.toEnd, "edge.toEnd"), VALID_EDGE_ENDS, "toEnd"),
		color: assertOptionalString(edge.color, "edge.color"),
		label: assertOptionalString(edge.label, "edge.label"),
	};
	for (const [key, value] of Object.entries(optional)) {
		if (value === undefined) delete result[key];
		else result[key] = value;
	}
	return result as unknown as CanvasEdgeData;
}

function parseStringMap(value: unknown, field: string): Record<string, string> {
	if (!isRecord(value)) throw new CanvasParseError(`${field} must be an object`);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = assertString(entry, `${field}.${key}`);
	}
	return result;
}

function parseLinks(value: unknown): CanvasLinks {
	if (!isRecord(value)) throw new CanvasParseError("links must be an object");
	const links: CanvasLinks = {};
	for (const [scope, targets] of Object.entries(value)) {
		if (!isRecord(targets)) throw new CanvasParseError(`links.${scope} must be an object`);
		const scoped: Record<string, CanvasLink> = {};
		for (const [target, raw] of Object.entries(targets)) {
			if (!isRecord(raw)) throw new CanvasParseError(`links.${scope}.${target} must be an object`);
			const link: CanvasLink = {};
			for (const field of ["href", "note", "asset", "label"] as const) {
				const entry = assertOptionalString(raw[field], `links.${scope}.${target}.${field}`);
				if (entry !== undefined) link[field] = entry;
			}
			scoped[target] = link;
		}
		links[scope] = scoped;
	}
	return links;
}

/**
 * Parse a JSON Canvas document.
 *
 * Source boards (the default) keep every field the spec or another tool
 * wrote, and drop the fields only this package's publisher writes. Pass
 * `{ enriched: true }` for a board the canvas plugin published.
 */
export function parseCanvas(json: string, options: ParseCanvasOptions = {}): CanvasData {
	const enriched = options.enriched === true;
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (e) {
		throw new CanvasParseError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!isRecord(data)) {
		throw new CanvasParseError("Canvas data must be an object");
	}

	// Per-item tolerance. A board is one JSON file the user hand-edits, and
	// aborting the whole thing because of a single bad node left every other
	// card on the board unrendered. A node or edge that fails validation is
	// dropped and recorded in `problems` instead, so the loss is never silent;
	// only a structurally broken document (bad JSON, `nodes` not an array) is a
	// hard error, because then nothing can be rendered at all.
	const problems: string[] = [];
	const describe = (item: unknown, index: number): string => {
		const id = isRecord(item) && typeof item.id === "string" ? ` "${item.id}"` : "";
		return `node ${index}${id}`;
	};

	const nodeIds = new Set<string>();
	const nodes: CanvasNode[] = [];
	if (data.nodes !== undefined) {
		if (!Array.isArray(data.nodes)) {
			throw new CanvasParseError("nodes must be an array");
		}
		for (const [index, raw] of data.nodes.entries()) {
			let node: CanvasNode;
			try {
				node = validateNode(raw, enriched);
			} catch (e) {
				if (!(e instanceof CanvasParseError)) throw e;
				problems.push(
					`Skipped ${describe(raw, index)}: ${e.message.replace(/^Canvas parse error: /, "")}`,
				);
				continue;
			}
			// A duplicate id would make the node unaddressable; keep the first and
			// report the rest rather than losing the board over a copy-paste.
			if (nodeIds.has(node.id)) {
				problems.push(`Skipped duplicate node id: "${node.id}"`);
				continue;
			}
			nodeIds.add(node.id);
			nodes.push(node);
		}
	}

	const edges: CanvasEdgeData[] = [];
	if (data.edges !== undefined) {
		if (!Array.isArray(data.edges)) {
			throw new CanvasParseError("edges must be an array");
		}
		const edgeIds = new Set<string>();
		for (const [index, raw] of data.edges.entries()) {
			let edge: CanvasEdgeData;
			try {
				edge = validateEdge(raw);
			} catch (e) {
				if (!(e instanceof CanvasParseError)) throw e;
				problems.push(`Skipped edge ${index}: ${e.message.replace(/^Canvas parse error: /, "")}`);
				continue;
			}
			if (edgeIds.has(edge.id)) {
				problems.push(`Skipped duplicate edge id: "${edge.id}"`);
				continue;
			}
			// An edge whose endpoint was dropped (malformed, or a duplicate) cannot
			// be drawn, so it goes with it — checking this last is what stops the
			// tolerance above from cascading straight back into a hard failure.
			if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) {
				problems.push(`Skipped edge "${edge.id}": endpoint is not a rendered node`);
				continue;
			}
			edgeIds.add(edge.id);
			edges.push(edge);
		}
	}

	const result = {
		...withoutKeys(data, DOCUMENT_ENRICHMENT_KEYS),
		nodes,
		edges,
	} as CanvasData;
	if (enriched) {
		if (data.assets !== undefined) result.assets = parseStringMap(data.assets, "assets");
		if (data.notes !== undefined) result.notes = parseStringMap(data.notes, "notes");
		if (data.links !== undefined) result.links = parseLinks(data.links);
	}
	result.problems = problems;
	return result;
}

/**
 * The board as a `.canvas` file: every field the source had, none of the
 * publisher's. Tab-indented like the files Obsidian writes, so an exported
 * board diffs cleanly against its source.
 */
export function serializeCanvas(data: CanvasData): string {
	const document = withoutKeys(
		data as unknown as Record<string, unknown>,
		DOCUMENT_ENRICHMENT_KEYS,
	);
	document.nodes = data.nodes.map((node) =>
		withoutKeys(node as unknown as Record<string, unknown>, NODE_ENRICHMENT_KEYS),
	);
	document.edges = data.edges.map((edge) =>
		withoutKeys(edge as unknown as Record<string, unknown>, []),
	);
	return JSON.stringify(document, null, "\t");
}
