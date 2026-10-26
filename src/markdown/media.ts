/**
 * Attachments: wikilink media embeds, markdown images, and the URLs both emit.
 *
 * Obsidian resolves an attachment the same way whichever syntax names it — next
 * to the note, from the vault root, or by unique file name anywhere in the vault
 * — so `![[photo.png]]`, `![](photo.png)` and `![](media/photo.png)` all go
 * through {@link resolveMediaSrc}. It embeds the same way too: `![](tone.mp3)`,
 * `![](clip.mp4)` and `![](doc.pdf#page=3)` are players and frames, exactly as
 * their wikilink forms are, and `![](https://youtu.be/…)` frames the video.
 *
 * Markdown images need extra care because Rspress gets to them first: its
 * `remarkImage` turns every relative `![](url)` into an `<img>` JSX element whose
 * `src` is a default import of the url. A vault-style url (`photo.png` stored in
 * `attachments/`, `my%20image.png`) is not a module the bundler can find, so the
 * import is replaced by the published URL here, before the bundler sees it.
 */
import fs from "node:fs";
import path from "node:path";
import type { Image, PhrasingContent, Root } from "mdast";
import type { Parent } from "unist";
import { escapeHtmlAttribute, sanitizeUrl } from "../shared/escape.js";
import { EMBED_SIZE_PATTERN } from "../shared/inline-syntax.js";
import { AUDIO_EXTS, extensionOf, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../shared/media-exts.js";
import {
	isSameSiteUrl,
	parsePdfSubpath,
	pdfEmbedHtml,
	webEmbedHtml,
} from "../shared/media-html.js";
import { humanizeBaseName } from "../shared/slug.js";
import { assetUrlPath } from "./content-index.js";
import type { ContentIndex, ParsedWikiLink } from "./types.js";
import { normalizeFilePathKey, normalizeFsPath } from "./utils.js";
import { visit } from "./visit.js";

/** What media rendering needs from the page being compiled. */
export interface MediaContext {
	docsRoot: string;
	currentFilePath: string;
	index: ContentIndex;
	enableCaseInsensitiveLookup: boolean;
	/** The site `base`, `/…/`. */
	siteBase: string;
	/** `enableMediaEmbeds`: markdown-syntax audio, video, PDFs and web pages embed. */
	embedMedia: boolean;
	/**
	 * Disk answers for the page being compiled — whether a path is a regular
	 * file — so the page asks the disk about a path once. Not kept longer, nor
	 * keyed by content index: the index survives edits its signature ignores
	 * (`_`-prefixed files and folders, excluded folders, paths outside the
	 * root), and those are exactly the files only the disk knows about.
	 */
	fileChecks: Map<string, boolean>;
}

export interface MediaResolveResult {
	url: string;
	found: boolean;
	/** The file on disk, when one matched. */
	absolutePath?: string;
}

/**
 * Prefix a root-relative URL with the site `base`.
 *
 * Rspress rewrites the URLs it owns — links through its `Link`, images through
 * `normalizeImagePath` — but raw `<audio>`, `<video>`, `<source>` and
 * `<iframe>` markup reaches the browser as written. Idempotent, like Rspress's
 * own `withBase`, so a URL that already carries the base is left alone.
 */
export function withSiteBase(url: string, base: string): string {
	if (!url.startsWith("/") || url.startsWith("//") || base === "/") return url;
	if (url === base.slice(0, -1) || url.startsWith(base)) return url;
	return `${base}${url.slice(1)}`;
}

function decodePath(url: string): string {
	try {
		return decodeURI(url);
	} catch {
		return url;
	}
}

/** Whether `absolutePath` is a regular file, asked of the disk once per page. */
function isFileOnDisk(absolutePath: string, checks: Map<string, boolean>): boolean {
	let isFile = checks.get(absolutePath);
	if (isFile === undefined) {
		try {
			isFile = fs.statSync(absolutePath).isFile();
		} catch {
			isFile = false;
		}
		checks.set(absolutePath, isFile);
	}
	return isFile;
}

/**
 * Resolve a media embed target to a root-relative URL.
 *
 * Tries the file relative to the current markdown file, then relative to the
 * root, then a unique basename anywhere in the index. Falls back to the URL the
 * file would be published at from the root (reported as not found), so an
 * embed starts working once the file lands. Each path segment is
 * percent-encoded so spaces and special characters produce valid `src`/`href`
 * URLs.
 */
export function resolveMediaSrc(target: string, ctx: MediaContext): MediaResolveResult {
	const { docsRoot, index } = ctx;
	// Percent-encode every segment, dropping `..`/`.` so a wikilink target
	// cannot escape the docs root through the emitted URL.
	const encodePath = (segments: string[]): string =>
		`/${segments
			.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
			.map((segment) => encodeURIComponent(segment))
			.join("/")}`;

	const relativeAsset = (absolutePath: string): MediaResolveResult | undefined => {
		const relativePath = path.relative(docsRoot, absolutePath);
		if (
			relativePath.startsWith("..") ||
			path.isAbsolute(relativePath) ||
			relativePath.length === 0
		) {
			return undefined;
		}
		const pathKey = normalizeFilePathKey(normalizeFsPath(relativePath));
		const exact = index.byAssetPath.get(pathKey);
		if (exact) return { url: exact.urlPath, found: true, absolutePath: exact.absolutePath };
		if (!ctx.enableCaseInsensitiveLookup) return undefined;
		const candidates = index.byAssetPathCI.get(pathKey.toLowerCase()) ?? [];
		return candidates.length === 1 && candidates[0]
			? { url: candidates[0].urlPath, found: true, absolutePath: candidates[0].absolutePath }
			: undefined;
	};

	// A disk check is not authoritative about spelling: on a case-insensitive
	// filesystem (macOS, Windows) the file `document.pdf` exists when it is
	// actually named `Document.pdf`, and returning the name as typed emits a URL
	// the site never publishes. The index recorded the real casing, so ask it
	// first and fall back to the request only when it has no entry.
	const canonicalOrTyped = (absolutePath: string): string | undefined => {
		const rel = path.relative(docsRoot, absolutePath).replace(/\\/g, "/");
		if (rel.startsWith("..") || path.isAbsolute(rel) || rel.length === 0) return undefined;
		return relativeAsset(absolutePath)?.url ?? encodePath(rel.split("/"));
	};

	for (const candidate of [
		path.resolve(path.dirname(ctx.currentFilePath), target),
		path.resolve(docsRoot, target.replace(/^\/+/, "")),
	]) {
		if (isFileOnDisk(candidate, ctx.fileChecks)) {
			const url = canonicalOrTyped(candidate);
			if (url) return { url, found: true, absolutePath: candidate };
		}
		const indexed = relativeAsset(candidate);
		if (indexed) return indexed;
	}

	// When no path-qualified asset matched, mirror page wikilinks by accepting
	// a unique basename, including nested and case-insensitive attachments.
	const local = uniqueByName(index, target, ctx.enableCaseInsensitiveLookup);
	if (local) return local;

	// A docs page may embed a vault attachment (and a vault note a docs one),
	// the same fallback page links take: the other tree is tried by path, then
	// by unique name, only once this tree has nothing.
	const pathKey = normalizeFilePathKey(normalizeFsPath(target.replace(/^\/+/, "")));
	for (const linked of index.linkedIndexes ?? []) {
		const exact =
			linked.byAssetPath.get(pathKey) ??
			(ctx.enableCaseInsensitiveLookup
				? onlyOne(linked.byAssetPathCI.get(pathKey.toLowerCase()))
				: undefined);
		const match = exact
			? { url: exact.urlPath, found: true, absolutePath: exact.absolutePath }
			: uniqueByName(linked, target, ctx.enableCaseInsensitiveLookup);
		if (match) return match;
	}

	// Where the file would be served from had it been found: under this tree's
	// route prefix (`/vault/…`), as every published attachment is.
	const segments = target
		.split("/")
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..");
	return { url: assetUrlPath(segments.join("/"), index.routePrefix ?? ""), found: false };
}

function onlyOne<T>(candidates: T[] | undefined): T | undefined {
	return candidates?.length === 1 ? candidates[0] : undefined;
}

/** The one attachment in `index` named like `target`, if exactly one is. */
function uniqueByName(
	index: ContentIndex,
	target: string,
	caseInsensitive: boolean | undefined,
): MediaResolveResult | undefined {
	const basename = path.basename(normalizeFilePathKey(target));
	const match =
		onlyOne(index.byAssetBaseName.get(basename)) ??
		(caseInsensitive ? onlyOne(index.byAssetBaseNameCI.get(basename.toLowerCase())) : undefined);
	return match ? { url: match.urlPath, found: true, absolutePath: match.absolutePath } : undefined;
}

/**
 * Split an image's caption into alt text and a size.
 *
 * Obsidian documents two forms, for markdown images and wikilink embeds alike:
 * the size alone (`![250](url)`, `![[img.png|250x145]]`) and a caption followed
 * by a size pipe (`![A picture|80](url)`, `![[img.png|A picture|80]]`). A caption
 * that is not a bare dimension — `![A picture|wide](url)` — is no size, so none
 * is ever claimed from prose.
 */
function splitImageSize(
	caption: string,
): { alt: string; width: string; height?: string } | undefined {
	const separator = caption.lastIndexOf("|");
	const sizePart = separator === -1 ? caption : caption.slice(separator + 1);
	const match = sizePart.trim().match(EMBED_SIZE_PATTERN);
	if (!match?.[1]) return undefined;
	return {
		alt: separator === -1 ? "" : caption.slice(0, separator).trim(),
		width: match[1],
		height: match[2],
	};
}

/** Alt text for a sized image that carried none: the file's own name. */
function altFromImageUrl(url: string): string {
	const name =
		decodePath(url)
			.split("/")
			.pop()
			?.split(/[?#]/)[0]
			?.replace(/\.[^.]+$/, "") ?? "";
	return humanizeBaseName(name);
}

function sizeAttributes(size: { width: string; height?: string }): string {
	return size.height ? ` width="${size.width}" height="${size.height}"` : ` width="${size.width}"`;
}

type MediaKind = "Image" | "Audio" | "Video" | "PDF";

function mediaKindOf(target: string): MediaKind | undefined {
	const ext = extensionOf(target);
	if (IMAGE_EXTS.has(ext)) return "Image";
	if (AUDIO_EXTS.has(ext)) return "Audio";
	if (VIDEO_EXTS.has(ext)) return "Video";
	return ext === PDF_EXT ? "PDF" : undefined;
}

/**
 * The player or frame for an audio, video or PDF file at `src` (base already
 * applied), shared by `![[x.mp3]]` and `![](x.mp3)`.
 *
 * @param subpath - The embed's `#…` without the `#`. Audio and video keep it (a
 *   media fragment such as `t=10`); a PDF reads its `page` and `height` knobs.
 * @param caption - The wikilink alias or markdown alt, for a video's size.
 * @param target - The file as written, for the PDF bar's name.
 */
function playableMediaHtml(
	kind: Exclude<MediaKind, "Image">,
	src: string,
	subpath: string,
	caption: string,
	target: string,
): string {
	const fragment = subpath ? `#${subpath}` : "";
	if (kind === "Audio") {
		return `<audio controls src="${escapeHtmlAttribute(`${src}${fragment}`)}"></audio>`;
	}
	if (kind === "Video") {
		const size = splitImageSize(caption);
		return `<video controls src="${escapeHtmlAttribute(`${src}${fragment}`)}"${size ? sizeAttributes(size) : ""}></video>`;
	}
	// Obsidian puts the two PDF knobs in the subpath: `#page=3` opens the viewer
	// at a page, `#height=400` sizes the frame. Only the page belongs in the URL
	// — the height is a property of this embed and never travels to the file.
	const { page, height } = parsePdfSubpath(subpath);
	return pdfEmbedHtml({
		src: `${src}${page ? `#page=${page}` : ""}`,
		target,
		page,
		height: Number(height ?? 600),
	});
}

/**
 * The element a media wikilink embed (`![[x.png]]`, `.mp3`, `.mp4`, `.pdf`)
 * renders as, or `undefined` when the target is not media.
 */
export function renderMediaEmbed(
	parsed: ParsedWikiLink,
	ctx: MediaContext,
	report: (message: string) => void,
): PhrasingContent | undefined {
	const target = parsed.target;
	const kind = mediaKindOf(target);
	if (!kind) return undefined;

	const resolved = resolveMediaSrc(target, ctx);
	if (!resolved.found) report(`${kind} "${target}" not found on disk for ${parsed.raw}.`);
	const subpath = parsed.subpath?.value ?? "";
	const caption = parsed.alias ?? "";

	if (kind === "Image") {
		// Rspress's `img` component adds the base to a root-relative src.
		const size = splitImageSize(caption);
		const alt = size ? size.alt || target : caption.trim() || target;
		return {
			type: "html",
			value: `<img src="${escapeHtmlAttribute(`${resolved.url}${subpath ? `#${subpath}` : ""}`)}" alt="${escapeHtmlAttribute(alt)}"${size ? sizeAttributes(size) : ""} loading="lazy" />`,
		};
	}
	return {
		type: "html",
		value: playableMediaHtml(
			kind,
			withSiteBase(resolved.url, ctx.siteBase),
			subpath,
			caption,
			target,
		),
	};
}

/**
 * What a markdown image `![caption](url)` becomes when its url is not an
 * image: a player or frame for audio, video and PDFs, a frame for a YouTube
 * video or a tweet, or — with `enableMediaEmbeds` off, as a wikilink embed
 * degrades — a link to the file. `undefined` leaves the image to the image
 * pass.
 */
function markdownMediaNode(
	url: string,
	caption: string,
	ctx: MediaContext,
	reportMissing: (raw: string, message: string) => void,
): PhrasingContent | undefined {
	const hashAt = url.indexOf("#");
	const file = hashAt === -1 ? url : url.slice(0, hashAt);
	const subpath = hashAt === -1 ? "" : url.slice(hashAt + 1);
	const decoded = decodePath(file.split("?")[0] ?? file);
	const kind = mediaKindOf(decoded);
	const playable = kind === "Image" ? undefined : kind;
	const size = splitImageSize(caption);
	const label = (size ? size.alt : caption).trim();
	const web = kind
		? undefined
		: webEmbedHtml(url, { title: label, width: size?.width, height: size?.height });
	if (!web && !playable) return undefined;

	let src: string | null;
	if (web) {
		src = sanitizeUrl(url);
	} else if (isPluginOwnedImageUrl(file)) {
		const resolved = resolveMediaSrc(decoded, ctx);
		if (!resolved.found) {
			reportMissing(
				`![${caption}](${url})`,
				`${kind} "${url}" not found next to the note or in the vault.`,
			);
		}
		src = withSiteBase(resolved.url, ctx.siteBase);
	} else {
		// Root-absolute (a `public/` file) or an external URL.
		src = sanitizeUrl(withSiteBase(file, ctx.siteBase));
	}
	const fallbackText = label || (web ? url : altFromImageUrl(file));
	if (!src) return { type: "text", value: fallbackText };
	// A PDF on another site is a link even when media embeds are on: the PDF
	// frame cannot be sandboxed, so it only shows the site's own files.
	if (!ctx.embedMedia || (playable === "PDF" && !isSameSiteUrl(src))) {
		// The link opens the file; a PDF keeps its page, not the frame height.
		const page = playable === "PDF" ? parsePdfSubpath(subpath).page : undefined;
		const fragment =
			playable === "PDF" ? (page ? `#page=${page}` : "") : subpath ? `#${subpath}` : "";
		return {
			type: "link",
			url: web ? src : `${src}${fragment}`,
			children: [{ type: "text", value: fallbackText }],
		};
	}
	const value = web ?? (playable && playableMediaHtml(playable, src, subpath, caption, decoded));
	return value ? { type: "html", value } : undefined;
}

/**
 * Whether Rspress's dead-image gate should leave `url` to this plugin.
 *
 * Every relative image url is resolved by {@link processMarkdownImages} with
 * Obsidian's rules — next to the note, from the vault root, or by unique file
 * name — and reported there through `onBrokenLink` when nothing matches. The
 * gate only sees the url (not the page), so it cannot make that judgement and
 * fails the build for `![](photo.png)` stored in `attachments/`. Root-absolute
 * (`/logo.png`, served from `public/`), external and data URLs stay checked.
 */
export function isPluginOwnedImageUrl(url: string): boolean {
	return (
		url.length > 0 &&
		!url.startsWith("/") &&
		!url.startsWith("#") &&
		!url.startsWith("data:") &&
		!/^[a-z][a-z0-9+.-]*:/i.test(url)
	);
}

interface MdxAttribute {
	type: string;
	name?: string;
	value?: unknown;
}

interface MdxImage {
	type: "mdxJsxFlowElement" | "mdxJsxTextElement";
	name: string | null;
	attributes: MdxAttribute[];
}

export interface MdxjsEsm {
	type: "mdxjsEsm";
	value: string;
	data?: {
		estree?: {
			body?: Array<{
				type: string;
				specifiers?: Array<{ type: string; local?: { name?: string } }>;
				source?: { value?: unknown; raw?: string };
			}>;
		};
	};
}

/** The default-import url each `mdxjsEsm` node binds, by local name. */
export function imageImports(tree: Root): Map<string, { node: MdxjsEsm; url: string }> {
	const imports = new Map<string, { node: MdxjsEsm; url: string }>();
	for (const child of tree.children as unknown as MdxjsEsm[]) {
		if (child.type !== "mdxjsEsm") continue;
		for (const statement of child.data?.estree?.body ?? []) {
			if (statement.type !== "ImportDeclaration") continue;
			const specifier = statement.specifiers?.[0];
			const name = specifier?.type === "ImportDefaultSpecifier" ? specifier.local?.name : undefined;
			const url = statement.source?.value;
			if (name && typeof url === "string") imports.set(name, { node: child, url });
		}
	}
	return imports;
}

function setImportSource(node: MdxjsEsm, from: string): void {
	const statement = node.data?.estree?.body?.[0];
	if (statement?.source) {
		statement.source.value = from;
		statement.source.raw = JSON.stringify(from);
	}
	node.value = node.value.replace(/from\s+(["']).*\1\s*$/, `from ${JSON.stringify(from)}`);
}

function setAttribute(element: MdxImage, name: string, value: string): void {
	const existing = element.attributes.find(
		(attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === name,
	);
	if (existing) existing.value = value;
	else element.attributes.push({ type: "mdxJsxAttribute", name, value });
}

/** A bundler import specifier for `absolutePath`, relative to `fromFile`. */
function relativeImportPath(fromFile: string, absolutePath: string): string {
	const relative = path.relative(path.dirname(fromFile), absolutePath).split(path.sep).join("/");
	return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Where an Obsidian image url points: the file next to the note when it exists
 * (as a bundler-resolvable `./` path), otherwise the attachment the index finds.
 */
function locateImage(
	url: string,
	ctx: MediaContext,
): { kind: "local"; importPath: string } | { kind: "published"; resolved: MediaResolveResult } {
	const decoded = decodePath(url.split(/[?#]/)[0] ?? url);
	const absolute = path.resolve(path.dirname(ctx.currentFilePath), decoded);
	if (isFileOnDisk(absolute, ctx.fileChecks)) {
		return { kind: "local", importPath: relativeImportPath(ctx.currentFilePath, absolute) };
	}
	return { kind: "published", resolved: resolveMediaSrc(decoded, ctx) };
}

/**
 * Markdown images: Obsidian attachment resolution and the size caption.
 *
 * Two shapes reach this pass. Under Rspress every relative image is already an
 * `<img>` JSX element bound to an import (see the module comment); in a plain
 * remark pipeline (and inside transcluded notes) it is still an mdast `image`.
 * Both get the same treatment: a url that is not a file next to the note is
 * resolved like an embed and rewritten to the published URL, an unresolvable
 * one is reported, and `![120](x.png)` / `![cap|120x40](x.png)` become alt text
 * plus `width`/`height`.
 */
export function processMarkdownImages(
	tree: Root,
	ctx: MediaContext,
	reportMissing: (raw: string, message: string) => void,
): void {
	const imports = imageImports(tree);
	const droppedImports = new Set<MdxjsEsm>();

	visit(tree, (node, index, parent) => {
		const siblings = (parent as (Parent & { children: PhrasingContent[] }) | undefined)?.children;
		if (node.type === "image") {
			const image = node as Image;
			if (/\.(md|mdx)([#?]|$)/i.test(image.url)) return;
			const media = markdownMediaNode(image.url, image.alt ?? "", ctx, reportMissing);
			if (media && siblings && typeof index === "number") {
				siblings.splice(index, 1, media);
				return;
			}
			const size = splitImageSize(image.alt ?? "");
			if (isPluginOwnedImageUrl(image.url)) {
				const located = locateImage(image.url, ctx);
				if (located.kind === "published") {
					if (!located.resolved.found) {
						reportMissing(
							`![${image.alt ?? ""}](${image.url})`,
							`Image "${image.url}" not found next to the note or in the vault.`,
						);
					}
					image.url = located.resolved.url;
				}
			}
			if (!size || !siblings || typeof index !== "number") return;
			// A bare relative path carries no scheme to vet; anything else is
			// checked like every other URL this package emits.
			const src = isPluginOwnedImageUrl(image.url) ? image.url : sanitizeUrl(image.url);
			const alt = size.alt || altFromImageUrl(image.url);
			const replacement: PhrasingContent = src
				? {
						type: "html",
						value: `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${sizeAttributes(size)} loading="lazy" />`,
					}
				: { type: "text", value: alt };
			siblings.splice(index, 1, replacement);
			return;
		}

		if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;
		const element = node as unknown as MdxImage;
		if (element.name !== "img") return;
		const altAttribute = element.attributes.find(
			(attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "alt",
		);
		const alt = typeof altAttribute?.value === "string" ? altAttribute.value : "";
		const srcAttribute = element.attributes.find(
			(attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "src",
		);
		const srcExpression = srcAttribute?.value as { value?: unknown } | undefined;
		const bound =
			typeof srcExpression?.value === "string" ? imports.get(srcExpression.value) : undefined;

		// Rspress made an import of the file, which for audio, video or a PDF
		// bundles it as an image (a small PDF inlined as a `data:` URL). The
		// player replaces the element, and the import goes with it.
		const writtenUrl =
			bound?.url ?? (typeof srcAttribute?.value === "string" ? srcAttribute.value : undefined);
		const media = writtenUrl ? markdownMediaNode(writtenUrl, alt, ctx, reportMissing) : undefined;
		if (media && siblings && typeof index === "number") {
			if (bound) droppedImports.add(bound.node);
			siblings.splice(index, 1, media);
			return;
		}

		if (bound && srcAttribute) {
			const located = locateImage(bound.url, ctx);
			const found = located.kind === "published" ? located.resolved : undefined;
			// A file found anywhere on disk is bundled like any Rspress image, from
			// a path relative to the page: hashed, base-aware, and independent of
			// which attachments a root publishes.
			const importPath =
				located.kind === "local"
					? located.importPath
					: found?.absolutePath
						? relativeImportPath(ctx.currentFilePath, found.absolutePath)
						: undefined;
			if (importPath) {
				if (importPath !== bound.url) setImportSource(bound.node, importPath);
			} else {
				reportMissing(
					`![${alt}](${bound.url})`,
					`Image "${bound.url}" not found next to the note or in the vault.`,
				);
				droppedImports.add(bound.node);
				srcAttribute.value = found?.url ?? bound.url;
			}
		}

		const size = splitImageSize(alt);
		if (size) {
			const src = typeof srcAttribute?.value === "string" ? srcAttribute.value : bound?.url;
			setAttribute(element, "alt", size.alt || altFromImageUrl(src ?? ""));
			setAttribute(element, "width", size.width);
			if (size.height) setAttribute(element, "height", size.height);
		}
	});

	if (droppedImports.size > 0) {
		tree.children = tree.children.filter(
			(child) => !droppedImports.has(child as unknown as MdxjsEsm),
		);
	}
}
