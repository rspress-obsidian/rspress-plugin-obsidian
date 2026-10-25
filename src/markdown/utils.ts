import fs from "node:fs";
import path from "node:path";

import { normalizeFilePathKey } from "../shared/paths.js";
import { normalizeFsPath } from "../shared/route-path.js";
import { humanizeBaseName } from "../shared/slug.js";
import type { ContentPage, ParsedWikiLink } from "./types.js";

export { normalizeFilePathKey } from "../shared/paths.js";
export { normalizeFsPath } from "../shared/route-path.js";

/**
 * The text Obsidian shows for a wikilink: the alias when there is one, else the
 * target exactly as typed (`[[2024-01-15]]` stays `2024-01-15`, `[[my_note]]`
 * stays `my_note`), with a subpath shown as `Note > Heading` / `Note > ^id`
 * and a same-page `[[#Heading]]` as just `Heading`.
 */
export function wikiLinkDisplayText(parsed: ParsedWikiLink): string {
	if (parsed.alias) return parsed.alias;
	const subpath = parsed.subpath;
	const parts =
		subpath?.kind === "block"
			? [`^${subpath.value}`]
			: (subpath?.value
					.split("#")
					.map((part) => part.trim())
					.filter(Boolean) ?? []);
	const target = parsed.target.trim();
	return (target ? [target, ...parts] : parts).join(" > ");
}

/**
 * True when `filePath` is inside the already-absolute `rootDir`.
 *
 * Both sides are normalized to forward slashes before comparing: the remark
 * pass hands out paths that already went through {@link normalizeFsPath},
 * while `rootDir` usually comes from `path.resolve` and carries `\` separators
 * on Windows. A raw `${root}${path.sep}` prefix test therefore never matches
 * there, and the caller silently picks the wrong root.
 *
 * The comparison is case-insensitive on the platforms whose default filesystem
 * is case-insensitive (Windows, macOS): a `vaultRoot` that differs from the
 * reported file path only in case names the same directory, and a
 * case-sensitive test would drop every file under it into the docs root —
 * silently disabling vault processing. The platform is taken as an argument
 * (defaulting to `process.platform`) rather than detected by probing the
 * filesystem: a probe needs a writable temp file and only ever discovers the
 * OS default anyway, while this function stays pure and testable.
 */
export function isPathInsideRoot(
	filePath: string,
	rootDir: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const root = normalizeFsPath(rootDir).replace(/\/+$/, "");
	const candidate = normalizeFsPath(filePath);
	if (platform === "win32" || platform === "darwin") {
		return candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`);
	}
	return candidate.startsWith(`${root}/`);
}

/**
 * `filePath` spelled under `rootDir`, or `undefined` when it is outside it.
 *
 * Rspack resolves every module to its real path, so Rspress compiles a note
 * of a vault whose configured root runs through a symlink — a vault linked
 * into the site, or anything under macOS's `/tmp` (`/private/tmp`) — at a
 * path no prefix test against the root matches. Such a note was taken for a
 * docs-root page, rendered without its own index entry (no Dataview fields,
 * queries over the wrong tree, no backlinks), while the same note embedded
 * elsewhere rendered fine. The content index keeps the configured spelling,
 * so a path under the root's real path is rewritten to it.
 */
export function pathUnderRoot(filePath: string, rootDir: string): string | undefined {
	if (isPathInsideRoot(filePath, rootDir)) return filePath;
	let realRoot: string;
	try {
		realRoot = normalizeFsPath(normalizeRealPath(fs.realpathSync.native(rootDir))).replace(
			/\/+$/,
			"",
		);
	} catch {
		return undefined;
	}
	if (!isPathInsideRoot(filePath, realRoot)) return undefined;
	const root = normalizeFsPath(rootDir).replace(/\/+$/, "");
	return `${root}${normalizeFsPath(filePath).slice(realRoot.length)}`;
}

/**
 * Strip the extended-length prefix Windows' `realpathSync` may return.
 *
 * A resolved path longer than `MAX_PATH` comes back as `\\?\C:\vault`, and a
 * resolved UNC share as `\\?\UNC\server\share`. The prefix is not part of the
 * path, but it is invisible to a `startsWith` test: whichever of the two sides
 * carries it, the pair never matches and a file that is genuinely inside the
 * vault is refused. Strip it before comparing; callers keep the raw path for
 * the actual file access.
 */
export function normalizeRealPath(value: string): string {
	if (value.startsWith("\\\\?\\UNC\\")) {
		return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
	}
	if (value.startsWith("\\\\?\\")) {
		return value.slice("\\\\?\\".length);
	}
	return value;
}

/**
 * True when `realPath` is `realRoot` or lives beneath it, ignoring an
 * extended-length prefix on either side. Separator-agnostic (unlike a
 * `path.sep` test) so it is exercisable with synthetic Windows strings on any
 * host — the real prefix behaviour can only be produced on Windows.
 */
export function isRealPathInsideRoot(realPath: string, realRoot: string): boolean {
	const candidate = normalizeRealPath(realPath);
	const root = normalizeRealPath(realRoot).replace(/[\\/]+$/, "");
	if (candidate === root) return true;
	return candidate.startsWith(root) && /[\\/]/.test(candidate.charAt(root.length));
}

/**
 * Human-facing label for a page in the backlinks panel: the frontmatter
 * `title`, else the page's `# heading`, else a humanized filename. A section
 * heading names a part of the note, not the note (a Kanban board's first
 * heading is a lane), so only a top-level one counts. A raw basename
 * ("getting-started") reads like debug output, so it is the last resort.
 */
export function backlinkLabel(page: ContentPage): string {
	if (page.title) {
		return page.title;
	}
	const titleHeading = page.headings.find((heading) => (heading.depth ?? 1) === 1)?.rawText;
	if (titleHeading) {
		return titleHeading;
	}
	return humanizeBaseName(page.baseName) || page.baseName;
}

export { routeHref } from "../shared/route-path.js";

/**
 * Resolve an explicitly relative wikilink target from the current note.
 *
 * Obsidian-style `./` and `../` targets are note-relative. Targets without
 * those prefixes retain vault-root lookup semantics.
 */
export function resolveRelativePathKey(
	currentRelativePath: string,
	target: string,
): string | undefined {
	const normalizedTarget = normalizeFsPath(target.trim());
	if (!/^\.{1,2}(?:\/|$)/.test(normalizedTarget)) {
		return undefined;
	}

	const currentDirectory = path.posix.dirname(normalizeFsPath(currentRelativePath));
	return normalizeFilePathKey(
		path.posix.normalize(path.posix.join(currentDirectory, normalizedTarget)),
	);
}

const MAX_LISTED = 12;

/**
 * Format a concise list of available heading names for error messages.
 * Shows slugs as rough indicators in parentheses if they differ from the raw text.
 */
export function formatAvailableHeadings(page: ContentPage): string {
	const names = page.headings.slice(0, MAX_LISTED).map((h) => {
		if (h.explicitId && h.explicitId !== h.slug) {
			return `${h.rawText} (${h.explicitId})`;
		}
		return h.rawText;
	});
	if (names.length === 0) return " No headings found on this page.";
	const remainder = page.headings.length - names.length;
	const list = names.join(", ");
	return ` Available headings: ${list}${remainder > 0 ? ` (and ${remainder} more)` : ""}.`;
}

/**
 * Format a concise list of available block IDs for error messages.
 */
export function formatAvailableBlocks(page: ContentPage): string {
	const ids = page.blocks.slice(0, MAX_LISTED).map((b) => `^${b.id}`);
	if (ids.length === 0) return " No blocks found on this page.";
	const remainder = page.blocks.length - ids.length;
	return ` Available block IDs: ${ids.join(", ")}${remainder > 0 ? ` (and ${remainder} more)` : ""}.`;
}
