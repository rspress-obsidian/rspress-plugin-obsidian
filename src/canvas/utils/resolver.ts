import { deriveRoutePath, normalizeRoutePrefix } from "../../shared/route-path.js";

const MD_EXTENSIONS: Record<string, true> = {
	".md": true,
	".mdx": true,
	".markdown": true,
};

export function isMarkdownFile(filePath: string): boolean {
	const ext = filePath.match(/\.\w+$/)?.[0] || "";
	return MD_EXTENSIONS[ext.toLowerCase()] === true;
}

export function resolveFileRoute(filePath: string, prefix?: string): string {
	// An attachment is served from the same place as the note that references it,
	// and for a vault that place is the vault's route prefix: the markdown plugin
	// stages vault attachments into `public/<vaultRoutePrefix>/` during the build
	// precisely so a media embed's `/vault/media/clip.png` resolves. Dropping the
	// prefix here used to look harmless because the canvas inlines most of its
	// assets as data URLs — but anything it could not inline, a PDF carrying a
	// `#page=` subpath among them, fell through to a URL with no prefix and
	// rendered the site's 404 page inside the frame.
	return deriveRoutePath(filePath, normalizeRoutePrefix(prefix));
}
