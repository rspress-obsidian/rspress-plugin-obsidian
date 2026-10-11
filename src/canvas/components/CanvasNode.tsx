import type { CSSProperties } from "react";
import { memo, useMemo } from "react";
import { extractNoteSection } from "../../shared/transclusion.js";
import type { CanvasFileData, CanvasLinks, CanvasNode } from "../types.js";
import { withSiteBase } from "../utils/base.js";
import { resolveColor } from "../utils/color.js";
import { anchorHref, renderMarkdown, sanitizeUrl } from "../utils/markdown.js";
import { isMarkdownFile, resolveFileRoute } from "../utils/resolver.js";

export interface CanvasNodeProps {
	node: CanvasNode;
	assets?: Record<string, string>;
	notes?: Record<string, string>;
	links?: CanvasLinks;
	/** Prefix for ids the card's HTML carries (footnotes), unique per board instance. */
	idPrefix?: string;
	isHovered?: boolean;
	isSelected?: boolean;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	iframeSandbox?: string;
}

const DEFAULT_SANDBOX = "allow-scripts allow-same-origin allow-popups";

/** The last path segment, which is what Obsidian titles a file card with. */
function baseName(file: string): string {
	return file.split("/").pop() ?? file;
}

function stripExtension(name: string): string {
	return name.replace(/\.[^./]+$/, "");
}

/** A URL from the board's asset map, prefixed with the site base and vetted. */
function assetUrl(assets: Record<string, string> | undefined, key: string | undefined) {
	const url = key ? assets?.[key] : undefined;
	return url ? sanitizeUrl(withSiteBase(url)) : null;
}

/**
 * A coloured card or group carries its colour as `--canvas-node-accent`; the
 * stylesheet derives the border, the translucent tint and the group label
 * from it, for presets and picker colours alike.
 */
export function nodeColorStyle(node: CanvasNode): CSSProperties {
	const color = resolveColor(node.color, "");
	return color ? { ["--canvas-node-accent" as string]: color } : {};
}

/**
 * The text a card is announced by: a file or site name, a group label, or a
 * text card's first heading (or first line), stripped of markdown punctuation.
 */
export function cardLabel(node: CanvasNode): string {
	switch (node.type) {
		case "text": {
			const lines = node.text.split(/\r?\n/).map((line) => line.trim());
			const heading = lines.find((line) => /^#{1,6}\s/.test(line));
			const first = heading ?? lines.find(Boolean) ?? "";
			const plain = first
				.replace(/^#{1,6}\s+/, "")
				.replace(
					/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g,
					(_m, target: string, alias: string) => alias || target,
				)
				.replace(/[*_`=~>]/g, "")
				.trim();
			return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || "Text card";
		}
		case "file":
			return baseName(node.file);
		case "link":
			return node.url;
		default:
			return node.label || "Group";
	}
}

/**
 * One card's content. Selection, dragging and keyboard handling belong to the
 * renderer's wrapper; this component only draws.
 */
export const CanvasNodeComponent = memo(function CanvasNodeComponent({
	node,
	assets,
	notes,
	links,
	idPrefix,
	isHovered,
	isSelected,
	fileRoutePrefix,
	linkPreview = true,
	iframeSandbox = DEFAULT_SANDBOX,
}: CanvasNodeProps) {
	const className = [
		"canvas-node",
		`canvas-node-${node.type}`,
		node.type === "file" ? `canvas-file-${node.resolvedFile?.kind ?? "unresolved"}` : "",
		isHovered ? "canvas-node-hovered" : "",
		isSelected ? "canvas-node-selected" : "",
		resolveColor(node.color, "") ? "canvas-node-colored" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={className} style={nodeColorStyle(node)}>
			<NodeContent
				node={node}
				assets={assets}
				notes={notes}
				links={links}
				idPrefix={idPrefix}
				fileRoutePrefix={fileRoutePrefix}
				linkPreview={linkPreview}
				iframeSandbox={iframeSandbox}
			/>
		</div>
	);
});

/** Markdown for a text card or a note card, with the scope its links resolve in. */
function markdownSourceOf(
	node: CanvasNode,
	notes: Record<string, string> | undefined,
): { text: string; scope: string } | null {
	if (node.type === "text") return { text: node.text, scope: "" };
	if (node.type !== "file" || node.resolvedFile?.kind !== "note" || !node.resolvedFile.key) {
		return null;
	}
	const note = notes?.[node.resolvedFile.key];
	if (note === undefined) return null;
	// The shared slicer the Markdown plugin transcludes with: nested headings,
	// fenced blocks and multi-line block ids behave the same on a page and a card.
	const text = node.resolvedFile.missingSubpath
		? note
		: (extractNoteSection(note, node.subpath) ?? note);
	return { text, scope: node.resolvedFile.key };
}

function NodeContent({
	node,
	assets,
	notes,
	links,
	idPrefix,
	fileRoutePrefix,
	linkPreview,
	iframeSandbox,
}: Required<Pick<CanvasNodeProps, "node" | "linkPreview" | "iframeSandbox">> &
	Pick<CanvasNodeProps, "assets" | "notes" | "links" | "idPrefix" | "fileRoutePrefix">) {
	const source = markdownSourceOf(node, notes);
	const sourceText = source?.text;
	const scope = source?.scope;
	// A drag patches only the dragged node and keeps every map's identity, so
	// this holds for every card that is not being edited.
	const html = useMemo(
		() =>
			sourceText
				? renderMarkdown(sourceText, {
						assets,
						notes,
						links,
						scope,
						fileRoutePrefix,
						idPrefix: idPrefix ? `${idPrefix}${node.id}-` : `${node.id}-`,
					})
				: "",
		[sourceText, scope, assets, notes, links, fileRoutePrefix, idPrefix, node.id],
	);
	// React 19 re-applies `dangerouslySetInnerHTML` whenever the prop object is
	// new, without comparing the strings. A fresh `{ __html }` on every render
	// rebuilt the card's DOM on each hover and selection — restarting media,
	// dropping text selection, and detaching the node a fast click pressed on, so
	// the click never fired. One object per distinct html keeps the DOM.
	const markup = useMemo(() => ({ __html: html }), [html]);

	switch (node.type) {
		case "text":
			return (
				<div className="canvas-node-content canvas-text">
					{/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes text and vets every URL */}
					<div className="canvas-markdown" dangerouslySetInnerHTML={markup} />
				</div>
			);
		case "file":
			return (
				<FileContent
					node={node}
					markup={markup}
					assets={assets}
					fileRoutePrefix={fileRoutePrefix}
				/>
			);
		case "link":
			return <LinkContent url={node.url} linkPreview={linkPreview} iframeSandbox={iframeSandbox} />;
		case "group":
			return <GroupContent node={node} assets={assets} />;
		default:
			// A node type from a newer spec: the frame and its label still render.
			return null;
	}
}

/** The name above a card, the way Obsidian labels file, link and group nodes. */
function CardLabel({ children, href }: { children: string; href?: string | null }) {
	return (
		<div className="canvas-node-label">
			{href ? (
				<a href={href} className="canvas-node-label-link" title={`Open ${children}`}>
					{children}
				</a>
			) : (
				<span>{children}</span>
			)}
		</div>
	);
}

function FileContent({
	node,
	markup,
	assets,
	fileRoutePrefix,
}: {
	node: CanvasFileData;
	markup: { __html: string };
	assets?: Record<string, string>;
	fileRoutePrefix?: string;
}) {
	const name = baseName(node.file);
	const resolved = node.resolvedFile;
	const subpathLabel = node.subpath ? ` › ${node.subpath.replace(/^#/, "")}` : "";

	if (!resolved) {
		// A board rendered without the build step (a library caller): link a note
		// to its route the old way, show anything else by name.
		const route = sanitizeUrl(
			withSiteBase(anchorHref(resolveFileRoute(node.file, fileRoutePrefix), node.subpath)),
		);
		return (
			<>
				<CardLabel href={isMarkdownFile(node.file) ? route : null}>{name}</CardLabel>
				<div className="canvas-node-content canvas-file-fallback">
					<div className="canvas-file-name">{stripExtension(name)}</div>
					{node.subpath && <div className="canvas-file-subpath">{node.subpath}</div>}
				</div>
			</>
		);
	}

	const href = resolved.href ? sanitizeUrl(withSiteBase(resolved.href)) : null;
	const url = assetUrl(assets, resolved.key);

	switch (resolved.kind) {
		case "note":
			return (
				<>
					<CardLabel href={href}>{`${stripExtension(name)}${subpathLabel}`}</CardLabel>
					<div className="canvas-node-content canvas-file-note">
						{resolved.missingSubpath && (
							<p className="canvas-file-notice" role="note">
								“{node.subpath?.replace(/^#/, "")}” is not in this note; showing the whole note.
							</p>
						)}
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes text and vets every URL */}
						<div className="canvas-markdown" dangerouslySetInnerHTML={markup} />
					</div>
				</>
			);
		case "image":
			// Obsidian draws an image node as the bare picture, named above it.
			return (
				<>
					<CardLabel>{name}</CardLabel>
					{url ? (
						<img
							className="canvas-file-image"
							src={url}
							alt={stripExtension(name)}
							draggable={false}
						/>
					) : (
						<UnavailableFile name={name} />
					)}
				</>
			);
		case "audio":
		case "video":
			return (
				<>
					<CardLabel>{name}</CardLabel>
					<div className="canvas-node-content canvas-file-media-card">
						{url ? (
							resolved.kind === "audio" ? (
								<audio className="canvas-file-media" controls preload="metadata" src={url} />
							) : (
								<video className="canvas-file-media" controls preload="metadata" src={url} />
							)
						) : (
							<UnavailableFile name={name} />
						)}
					</div>
				</>
			);
		case "pdf": {
			const page = node.subpath?.match(/^#page=(\d+)$/i)?.[1];
			const src = url ? `${url}${page ? `#page=${page}` : ""}` : null;
			return (
				<>
					<CardLabel href={url}>{name}</CardLabel>
					<div className="canvas-node-content canvas-file-pdf-card">
						{src ? (
							// Deliberately not sandboxed: Chromium's PDF viewer refuses to run
							// inside a sandboxed frame and shows a broken-document icon. The
							// file is served from the site's own origin.
							<iframe className="canvas-file-pdf" src={src} title={name} loading="lazy" />
						) : (
							<UnavailableFile name={name} />
						)}
					</div>
				</>
			);
		}
		case "canvas":
			return (
				<>
					<CardLabel href={href}>{name}</CardLabel>
					<div className="canvas-node-content canvas-file-fallback">
						<div className="canvas-file-name">{stripExtension(name)}</div>
						{href && (
							<a className="canvas-file-open" href={href}>
								Open canvas
							</a>
						)}
					</div>
				</>
			);
		case "file":
			return (
				<>
					<CardLabel>{name}</CardLabel>
					<div className="canvas-node-content canvas-file-fallback">
						<div className="canvas-file-name">{name}</div>
						{url ? (
							<a className="canvas-file-open" href={url} download={name}>
								Download
							</a>
						) : (
							<UnavailableFile name={name} />
						)}
					</div>
				</>
			);
		default:
			return (
				<>
					<CardLabel>{name}</CardLabel>
					<div className="canvas-node-content canvas-file-fallback canvas-file-unavailable">
						<UnavailableFile name={name} />
					</div>
				</>
			);
	}
}

/**
 * A file that is missing, outside the vault, or not published. The three read
 * the same on purpose: a private note's existence is not announced.
 */
function UnavailableFile({ name }: { name: string }) {
	return (
		<div className="canvas-file-error-text" role="note">
			“{name}” is not available.
		</div>
	);
}

function LinkContent({
	url,
	linkPreview,
	iframeSandbox,
}: {
	url: string;
	linkPreview: boolean;
	iframeSandbox: string;
}) {
	const safeUrl = sanitizeUrl(url);
	const external = safeUrl !== null && /^https?:/i.test(safeUrl);
	const label = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
	if (linkPreview && external && safeUrl) {
		return (
			<>
				<CardLabel href={safeUrl}>{label}</CardLabel>
				<div className="canvas-node-content canvas-link-preview">
					<iframe
						className="canvas-link-frame"
						src={safeUrl}
						title={label}
						sandbox={iframeSandbox}
						loading="lazy"
						referrerPolicy="no-referrer"
					/>
				</div>
			</>
		);
	}
	return (
		<div className="canvas-node-content canvas-link">
			{safeUrl ? (
				<a href={safeUrl} target={external ? "_blank" : undefined} rel="noopener noreferrer">
					{url}
				</a>
			) : (
				<span>{url}</span>
			)}
		</div>
	);
}

function GroupContent({
	node,
	assets,
}: {
	node: Extract<CanvasNode, { type: "group" }>;
	assets?: Record<string, string>;
}) {
	const remote =
		node.background && /^https?:/i.test(node.background) ? sanitizeUrl(node.background) : null;
	const background = assetUrl(assets, node.resolvedBackground) ?? remote;
	const style: CSSProperties = background
		? {
				// JSON.stringify quotes and escapes the URL for CSS.
				backgroundImage: `url(${JSON.stringify(background)})`,
				backgroundSize:
					node.backgroundStyle === "ratio"
						? "contain"
						: node.backgroundStyle === "repeat"
							? "auto"
							: "cover",
				backgroundRepeat: node.backgroundStyle === "repeat" ? "repeat" : "no-repeat",
				backgroundPosition: "center",
			}
		: {};
	return (
		<>
			{node.label && <div className="canvas-group-label">{node.label}</div>}
			<div className="canvas-node-content canvas-group" style={style} />
		</>
	);
}
