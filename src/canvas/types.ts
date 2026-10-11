export type CanvasColor = string;

export type NodeType = "text" | "file" | "link" | "group";

export type NodeSide = "top" | "right" | "bottom" | "left";

export type EdgeEnd = "none" | "arrow";

export type BackgroundStyle = "cover" | "ratio" | "repeat";

/**
 * Fields every node shares. Nodes and edges keep any field the JSON Canvas
 * spec (or another tool) adds that this package does not know about: the
 * parser copies the source record and only overlays the validated fields, so
 * an editor export round-trips them.
 */
export interface CanvasNodeData {
	id: string;
	type: NodeType;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: CanvasColor;
}

export interface CanvasTextData extends CanvasNodeData {
	type: "text";
	text: string;
}

/** What a file node's `file` turned out to be when the board was published. */
export type CanvasFileKind =
	| "note"
	| "image"
	| "audio"
	| "video"
	| "pdf"
	| "canvas"
	| "file"
	/** The path is outside the vault, unreadable, or does not exist. */
	| "missing"
	/** A note with `publish: false`: its content is never shipped. */
	| "private";

/**
 * Build-time facts about a file node. Never part of a `.canvas` file: the
 * parser drops it from source boards and the editor strips it on export.
 */
export interface CanvasResolvedFile {
	kind: CanvasFileKind;
	/** Key into {@link CanvasData.notes} (`note`) or {@link CanvasData.assets} (media, `file`). */
	key?: string;
	/** Site route of the note page or the board page, without the site base. */
	href?: string;
	/** The subpath names no heading or block in the note; the card shows the whole note. */
	missingSubpath?: boolean;
}

export interface CanvasFileData extends CanvasNodeData {
	type: "file";
	file: string;
	subpath?: string;
	resolvedFile?: CanvasResolvedFile;
}

export interface CanvasLinkData extends CanvasNodeData {
	type: "link";
	url: string;
}

export interface CanvasGroupData extends CanvasNodeData {
	type: "group";
	label?: string;
	background?: string;
	backgroundStyle?: BackgroundStyle;
	/** Build-time: key into {@link CanvasData.assets} for `background`. */
	resolvedBackground?: string;
}

export type CanvasNode = CanvasTextData | CanvasFileData | CanvasLinkData | CanvasGroupData;

export interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide?: NodeSide;
	fromEnd?: EdgeEnd;
	toNode: string;
	toSide?: NodeSide;
	toEnd?: EdgeEnd;
	color?: CanvasColor;
	label?: string;
}

/**
 * Where a link or embed written in card markdown points, resolved at build
 * time with the Markdown plugin's resolver (shortest path, vault-absolute and
 * relative, case-insensitive). An entry with none of `href`, `note` or `asset`
 * is a target that does not resolve (or resolves to an unpublished note): the
 * card renders its text without a link.
 */
export interface CanvasLink {
	/** Site route (page or board) without the site base, fragment included. */
	href?: string;
	/** Key into {@link CanvasData.notes}: the note `![[…]]` transcludes. */
	note?: string;
	/** Key into {@link CanvasData.assets}: the attachment the target names. */
	asset?: string;
	/** Obsidian's display text for the link when no alias is written. */
	label?: string;
}

/**
 * Resolved targets per markdown source. The outer key is the scope the text
 * was written in — `""` for text cards, a note key for a note's own body —
 * because a relative link means something different in each. The inner key is
 * {@link canvasLinkKey} of the target as written.
 */
export type CanvasLinks = Record<string, Record<string, CanvasLink>>;

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdgeData[];
	/**
	 * Build-time: published attachment URLs (without the site base), keyed by
	 * the vault path folded with `normalizeAssetKey`. Each file is stored once
	 * and referenced by key from nodes and links.
	 */
	assets?: Record<string, string>;
	/** Build-time: published note bodies (frontmatter stripped), keyed like `assets`. */
	notes?: Record<string, string>;
	/** Build-time: resolved card links, see {@link CanvasLinks}. */
	links?: CanvasLinks;
	/**
	 * Items the parser dropped rather than aborting on — a malformed node, a
	 * duplicate id, an edge whose endpoint is not rendered. Absent when the
	 * board parsed cleanly, so a caller logging these can tell "nothing was
	 * wrong" from "this parser does not report".
	 */
	problems?: string[];
}

export interface CanvasPluginOptions {
	/**
	 * Root directory scanned for `.canvas` files; also the base every vault
	 * path (`node.file`, asset references, card links) is resolved and
	 * containment-checked against. Defaults to the Rspress content root
	 * (`config.root`, resolving against the working directory, `docs/` when
	 * unset).
	 */
	vaultRoot?: string;
	/** Route prefix published canvases live under.
	 * @default "/canvas" */
	routePrefix?: string;
	/** Glob patterns for finding canvas files, relative to `vaultRoot`.
	 * @default a single `**\/*.canvas` */
	include?: string[];
	/**
	 * Glob patterns to ignore when scanning, relative to `vaultRoot`. Appended
	 * to the built-ins that always apply — `**\/node_modules\/**`,
	 * `**\/dist\/**`, `**\/.git\/**`, `**\/doc_build\/**`, `**\/coverage\/**` —
	 * so they add to that list rather than replace it.
	 */
	exclude?: string[];
	/**
	 * Route prefix of the vault's note pages. Set it to the markdown plugin's
	 * `vaultRoutePrefix` when `vaultRoot` points at a vault published by that
	 * plugin, otherwise cards link to routes that do not exist.
	 */
	fileRoutePrefix?: string;
	/**
	 * Show link nodes as a live, sandboxed preview of the website — what
	 * Obsidian does. Set to `false` for a plain link card instead (no
	 * third-party page is loaded until the reader clicks).
	 * @default true
	 */
	linkPreview?: boolean;
	/** Expose the canvas editor chrome instead of the read-only viewer.
	 * @default false */
	editable?: boolean;
	/** Accessible name for the editor toolbar.
	 * @default "Canvas editor" */
	editorTitle?: string;
	/**
	 * Sandbox attributes for link-node website previews. PDF cards are never
	 * sandboxed: Chromium's PDF viewer refuses to run in a sandboxed frame.
	 * @default "allow-scripts allow-same-origin allow-popups"
	 */
	iframeSandbox?: string;
	/**
	 * Inject the plugin's stylesheet (canvas cards, toolbar, grid) as a global
	 * style. Set to `false` to style the canvas yourself.
	 * @default true
	 */
	enableDefaultStyles?: boolean;
	/**
	 * Where published board JSON and the attachments boards reference are
	 * written, relative to the working directory. The directory belongs to the
	 * plugin: it is emptied on every build and served as an extra public
	 * directory, so nothing lands in the site's own `public/`.
	 * @default "node_modules/.rspress-plugin-obsidian/canvas"
	 */
	outDir?: string;
}
