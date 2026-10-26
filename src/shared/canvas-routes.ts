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
 * The boards one site's canvas feature published, linking its `.canvas` files
 * to their viewer routes. The wikilink resolver and the graph's link extractor
 * read it, so `[[Board.canvas]]` links to the board's viewer page (not the raw
 * JSON attachment), `![[Board.canvas]]` renders the board through the same
 * `<CanvasEmbed>` component the docs use, and the graph reports the link as
 * resolved instead of warning about it. No canvas plugin means the canvas
 * feature is not in use, and every consumer treats the file as an attachment;
 * with one, a board it did not publish is neither a page nor a served file.
 *
 * Boards are found three ways: by absolute path (for consumers holding the
 * file's real location), by vault-relative source path, and by route. The
 * source lookup matters for pages whose own root is not the vault: a docs page
 * resolves against the docs index, which never contains vault files, so
 * `[[Board.canvas]]` reaches the board directly instead of fanning out over
 * stray `.canvas` copies sitting in the docs tree (checked-in fixtures,
 * previously copied assets) and reporting them ambiguous.
 */
export interface CanvasBoards {
	/** The published board this absolute file path belongs to, if any. */
	byPath(absolutePath: string): CanvasBoardRoute | undefined;
	/**
	 * The published board a wikilink target names, looked up by vault-relative
	 * path — the form a page outside the vault (a docs page), or the graph's
	 * source-text extractor resolves with.
	 */
	bySource(target: string, caseInsensitive?: boolean): CanvasBoardRoute | undefined;
	/**
	 * The published board whose viewer page sits at `routePath`. Rspress hands
	 * route consumers the generated page, not the `.canvas` file, so the graph
	 * maps a route back to its board here. Matching ignores a trailing slash,
	 * `.html`, an `/index` suffix and case (board routes are published lowercase).
	 */
	byRoute(routePath: string): CanvasBoardRoute | undefined;
}

/**
 * One spelling per published route: `/canvas/demo`, `/canvas/demo/`,
 * `/canvas/demo.html` and `/canvas/demo/index` are the same page to Rspress.
 */
function normalizeBoardRoute(routePath: string): string {
	let route = routePath.trim();
	try {
		route = decodeURI(route);
	} catch {
		// Already decoded, or a stray `%`; match it as written.
	}
	route = route
		.replace(/[?#].*$/, "")
		.replace(/\.html$/i, "")
		.replace(/\/index$/i, "")
		.replace(/\/+$/, "");
	return (route.startsWith("/") ? route : `/${route}`).toLowerCase();
}

/** Index the boards one canvas scan published. */
export function createCanvasBoards(boards: Iterable<CanvasBoardRoute>): CanvasBoards {
	const byAbsolutePath = new Map<string, CanvasBoardRoute>();
	const bySourceKey = new Map<string, CanvasBoardRoute>();
	const bySourceKeyLower = new Map<string, CanvasBoardRoute>();
	const byRoute = new Map<string, CanvasBoardRoute>();
	for (const board of boards) {
		const sourceKey = normalizeFilePathKey(board.source);
		byAbsolutePath.set(normalizeFsPath(board.absolutePath), board);
		bySourceKey.set(sourceKey, board);
		bySourceKeyLower.set(sourceKey.toLowerCase(), board);
		byRoute.set(normalizeBoardRoute(board.routePath), board);
	}
	return {
		byPath: (absolutePath) => byAbsolutePath.get(normalizeFsPath(absolutePath)),
		bySource: (target, caseInsensitive = false) => {
			// `./Board.canvas` is a note-relative spelling of the same file; boards
			// are keyed vault-root-relative.
			const key = normalizeFilePathKey(target.replace(/^\.\//, ""));
			return (
				bySourceKey.get(key) ??
				(caseInsensitive ? bySourceKeyLower.get(key.toLowerCase()) : undefined)
			);
		},
		byRoute: (routePath) => byRoute.get(normalizeBoardRoute(routePath)),
	};
}

// The canvas plugin object carries a reader for the boards its latest scan
// published, and the markdown and graph features find it among the `plugins`
// of the site config Rspress hands every hook — the mechanism
// `published-content` uses, for the same reasons: there is no module state, so
// each site sees its own boards however many sites a process builds, and the
// order the plugins are listed in does not matter. The reader hands out a
// promise because Rspress runs every plugin's `addPages` at once: a sibling's
// `addPages` asking while the canvas scan is still globbing waits for that
// scan, rather than reading the empty board list and staging the raw `.canvas`
// file — comments, private paths and all — as an attachment.
// `Symbol.for`, not `Symbol()`: the per-feature entries may be loaded as
// separate bundle copies (an ESM and a CJS entry side by side), and each copy
// has to recognise a canvas plugin built by another.
const CANVAS_BOARDS = Symbol.for("rspress-plugin-obsidian:canvas-boards");

/**
 * Attach the reader a sibling feature calls to learn which boards `plugin`
 * published. `read` settles once the scan in progress (if any) has listed its
 * boards.
 */
export function attachCanvasBoards<Plugin extends object>(
	plugin: Plugin,
	read: () => Promise<CanvasBoards>,
): Plugin {
	return Object.assign(plugin, { [CANVAS_BOARDS]: read });
}

/**
 * The boards the canvas plugin of this site published, found among the site's
 * `plugins`, once its running scan has finished; `undefined` when the site has
 * no canvas plugin. Rspress refuses two plugins with one name, so a site has
 * at most one.
 */
export function findCanvasBoards(config: {
	plugins?: readonly unknown[];
}): Promise<CanvasBoards> | undefined {
	for (const plugin of config.plugins ?? []) {
		if (typeof plugin !== "object" || plugin === null || !(CANVAS_BOARDS in plugin)) continue;
		const read = plugin[CANVAS_BOARDS];
		if (typeof read === "function") return read();
	}
	return undefined;
}
