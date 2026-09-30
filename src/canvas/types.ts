export type CanvasColor = string;

export type NodeType = "text" | "file" | "link" | "group";

export type NodeSide = "top" | "right" | "bottom" | "left";

export type EdgeEnd = "none" | "arrow";

export type BackgroundStyle = "cover" | "ratio" | "repeat";

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

export interface CanvasFileData extends CanvasNodeData {
	type: "file";
	file: string;
	subpath?: string;
	fileContent?: string;
	assetUrl?: string;
	imageUrl?: string;
	mediaType?: string;
	isImage?: boolean;
	isVideo?: boolean;
	isAudio?: boolean;
	isPdf?: boolean;
	isError?: boolean;
}

export interface CanvasLinkData extends CanvasNodeData {
	type: "link";
	url: string;
}

export interface CanvasGroupData extends CanvasNodeData {
	type: "group";
	label?: string;
	background?: string;
	backgroundUrl?: string;
	backgroundStyle?: BackgroundStyle;
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

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdgeData[];
	assets?: Record<string, string>;
	notes?: Record<string, string>;
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
	 * path (`node.file`, asset references) is resolved and containment-checked
	 * against. Defaults to the Rspress content root (`config.root`, resolving
	 * against the working directory, `docs/` when unset).
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
	 * Prefix file-node cards link to. Set it to the markdown plugin's route
	 * prefix when `vaultRoot` points at a vault published by that plugin,
	 * otherwise cards link to routes that do not exist.
	 */
	fileRoutePrefix?: string;
	/** Render file-node cards as hover previews.
	 * @default false */
	linkPreview?: boolean;
	/** Expose the canvas editor chrome instead of the read-only viewer.
	 * @default false */
	editable?: boolean;
	/** Accessible name for the editor toolbar.
	 * @default "Canvas editor" */
	editorTitle?: string;
	/**
	 * Sandbox attributes for iframes used in link previews and PDF rendering.
	 * @default "allow-scripts allow-same-origin allow-popups"
	 */
	iframeSandbox?: string;
	/**
	 * Inject the plugin's stylesheet (canvas cards, toolbar, grid) as a global
	 * style. Set to `false` to style the canvas yourself.
	 * @default true
	 */
	enableDefaultStyles?: boolean;
}
