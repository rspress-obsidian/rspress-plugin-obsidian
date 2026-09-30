import { normalizeFilePathKey } from "./paths.js";
import { normalizeFsPath } from "./route-path.js";

/**
 * One board the canvas feature has published: where it lives in the vault,
 * the route its viewer page sits on, and the vault-relative path the
 * `<CanvasEmbed>` component fetches the board JSON with.
 */
export interface CanvasBoardRoute {
	/** Absolute, normalized path of the `.canvas` file. */
	absolutePath: string;
	/** Route the canvas feature published the board under, e.g. `/canvas/demo`. */
	routePath: string;
	/** Vault-relative path of the file — `<CanvasEmbed src>`'s value. */
	source: string;
}

/**
 * Registry linking a vault's `.canvas` boards to the routes the canvas
 * feature published them under. The canvas feature's `addPages` hook writes
 * it; the wikilink resolver and the graph's link extractor read it, so
 * `[[Board.canvas]]` links to the board's viewer page (not the raw JSON
 * attachment), `![[Board.canvas]]` renders the board through the same
 * `<CanvasEmbed>` component the docs use, and the graph reports the link as
 * resolved instead of warning about it. An empty registry is the "canvas
 * feature not in use (or this board excluded)" signal, and every consumer
 * then falls back to its pre-registry behaviour.
 *
 * Boards are indexed three ways: by absolute path (for consumers holding the
 * file's real location), by normalized source key, and lowercased. The
 * source-key index matters for pages whose own root is not the vault: a docs
 * page resolves against the docs index, which never contains vault files, so
 * `[[Board.canvas]]` reaches the registry directly instead of fanning out
 * over stray `.canvas` copies sitting in the docs tree (checked-in fixtures,
 * previously copied assets) and reporting them ambiguous.
 *
 * Shared state across plugin entries only works because this module is
 * imported by BOTH `src/markdown` and `src/canvas`: tsup's `splitting` hoists
 * a module imported by more than one entry into a common chunk, for the ESM
 * and the CJS output alike, so the registry stays a single instance however
 * the package is loaded (see tsup.config.ts and test/publish/dist.test.ts).
 */
const byAbsolutePath = new Map<string, CanvasBoardRoute>();
const bySourceKey = new Map<string, CanvasBoardRoute>();
const bySourceKeyLower = new Map<string, CanvasBoardRoute>();

/**
 * Replace the registry with the boards published by the latest canvas scan.
 * Clearing first keeps a rebuild (or a test that changes vaults) from seeing
 * routes for boards that no longer exist.
 */
export function setCanvasRoutes(boards: Iterable<CanvasBoardRoute>): void {
	byAbsolutePath.clear();
	bySourceKey.clear();
	bySourceKeyLower.clear();
	for (const board of boards) {
		const sourceKey = normalizeFilePathKey(board.source);
		byAbsolutePath.set(normalizeFsPath(board.absolutePath), board);
		bySourceKey.set(sourceKey, board);
		bySourceKeyLower.set(sourceKey.toLowerCase(), board);
	}
}

/** The published board this absolute file path belongs to, if any. */
export function findCanvasBoardByPath(absolutePath: string): CanvasBoardRoute | undefined {
	return byAbsolutePath.get(normalizeFsPath(absolutePath));
}

/**
 * The published board a wikilink target names, looked up by vault-relative
 * path — the form a page outside the vault (a docs page), or the graph's
 * source-text extractor resolves with.
 */
export function findCanvasBoard(
	target: string,
	caseInsensitive = false,
): CanvasBoardRoute | undefined {
	// `./Board.canvas` is a note-relative spelling of the same file; the
	// registry is keyed vault-root-relative.
	const key = normalizeFilePathKey(target.replace(/^\.\//, ""));
	return (
		bySourceKey.get(key) ?? (caseInsensitive ? bySourceKeyLower.get(key.toLowerCase()) : undefined)
	);
}
