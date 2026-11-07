import fs from "node:fs/promises";
import path from "node:path";
import type { CanvasBoards } from "../shared/canvas-routes.js";
import type { FileRoutes } from "../shared/file-routes.js";
import type { ContentIndex } from "./content-index.js";
import { mirrorFiles } from "./mirror-files.js";
import { isPathInsideRoot } from "./path-containment.js";
import { resolveWikiLink } from "./resolve-wikilink.js";
import type { ContentAsset } from "./types.js";

// Destinations a page links: a markdown link or image (`](url)`, `](<url>)`)
// and an HTML `src`/`href` attribute.
const SITE_URL_PATTERN = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))|\b(?:src|href)\s*=\s*["']([^"']+)["']/g;

export interface VaultAssetSync {
	/** Where staged files are mirrored; served as an extra Rsbuild public directory. */
	stagingDir: string;
	vaultRoot: string | undefined;
	vaultRoutePrefix: string;
	docs: ContentIndex;
	vault?: ContentIndex;
	resolveOptions: { enableCaseInsensitiveLookup: boolean; enableFuzzyMatching: boolean };
	canvasBoards: () => Promise<CanvasBoards> | undefined;
	fileRoutes: FileRoutes;
}

/**
 * The vault file a root-absolute site URL names (`/vault/media/x.png` →
 * `<vaultRoot>/media/x.png`), or `undefined` when the URL is outside the
 * vault prefix, escapes the vault, or names a dotfile — which is never
 * published.
 */
export function vaultFileForSiteUrl(
	url: string,
	vaultRoot: string | undefined,
	vaultRoutePrefix: string,
): string | undefined {
	if (!vaultRoot) return undefined;
	const prefix = `/${vaultRoutePrefix.replace(/^\/+|\/+$/g, "")}/`;
	let decoded = url.split(/[?#]/)[0] ?? "";
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		return undefined;
	}
	if (!decoded.startsWith(prefix)) return undefined;
	const segments = decoded.slice(prefix.length).split("/");
	if (segments.some((segment) => segment === "" || segment.startsWith("."))) return undefined;
	const file = path.join(vaultRoot, ...segments);
	return isPathInsideRoot(file, vaultRoot) ? file : undefined;
}

/**
 * Publish exactly the attachments a published page references — an embed, a
 * wikilink, a markdown link or image, a frontmatter property link — from
 * either tree. Vault attachments are served under `vaultRoutePrefix`. A
 * docs-root attachment under `public/` is already served by Rspress; any
 * other docs-root attachment is linked at its root-relative path and served
 * only once staged here. A dotfile is never indexed, and a `publish: false`
 * note is not in the index, so neither its own text nor its attachments
 * reach the site.
 */
export async function syncAssets({
	stagingDir,
	vaultRoot,
	vaultRoutePrefix,
	docs,
	vault,
	resolveOptions,
	canvasBoards,
	fileRoutes,
}: VaultAssetSync): Promise<void> {
	const prefix = vaultRoutePrefix.replace(/^\/+|\/+$/g, "");
	const wanted = new Map<string, string>();
	// A board the canvas feature publishes is a page, not an attachment, and
	// the resolver serves no other `.canvas` file raw while that feature is
	// on the site (see `resolveAgainstAsset`).
	const boards = await canvasBoards();
	const linkOptions = { ...resolveOptions, canvasBoards: boards, fileRoutes };
	const stageVaultAsset = (asset: ContentAsset): void => {
		wanted.set(path.posix.join(prefix, asset.relativePath), asset.absolutePath);
	};
	for (const index of vault ? [vault, docs] : [docs]) {
		for (const page of index.pages) {
			for (const link of page.outlinks ?? []) {
				const asset = resolveWikiLink(link, {
					currentPage: page,
					index,
					options: linkOptions,
				}).targetAsset;
				if (!asset) continue;
				if (vault?.byAssetPath.get(asset.pathKey) === asset) {
					stageVaultAsset(asset);
				} else if (
					docs.byAssetPath.get(asset.pathKey) === asset &&
					!asset.relativePath.startsWith("public/")
				) {
					wanted.set(asset.relativePath, asset.absolutePath);
				}
			}
		}
	}
	// A docs page may link a vault attachment by the URL it is published at
	// (`![](/vault/media/x.png)`): that is a reference too, or the file
	// would only be served when some other page happened to embed it. A
	// `.canvas` file is not served that way while a canvas feature is on the
	// site: the raw board holds what its published JSON drops (comments,
	// private paths).
	if (vault) {
		const byFile = new Map(vault.assets.map((asset) => [asset.absolutePath, asset]));
		for (const page of docs.pages) {
			const source = await fs.readFile(page.absolutePath, "utf8").catch(() => "");
			for (const match of source.matchAll(SITE_URL_PATTERN)) {
				const url = match[1] ?? match[2] ?? match[3] ?? "";
				const file = vaultFileForSiteUrl(url, vaultRoot, vaultRoutePrefix);
				const asset = file ? byFile.get(file) : undefined;
				if (asset && !(boards && /\.canvas$/i.test(asset.relativePath))) {
					stageVaultAsset(asset);
				}
			}
		}
	}
	await mirrorFiles(stagingDir, wanted);
}
