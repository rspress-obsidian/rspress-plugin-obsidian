/**
 * localStorage keys and the viewport query shared by the graph panel and its
 * lazy wrapper: both decide from them whether the panel starts open.
 *
 * A leaf module on purpose: `LazyGraphPanel` must not statically import
 * `GraphPanel`, or the dynamic `import("./GraphPanel.js")` would be folded back
 * into the same chunk and every page view would download the force-graph
 * renderer.
 */
export const LOCAL_STORAGE_KEY_OPEN = "rspress-graph-view-open";
export const LOCAL_STORAGE_KEY_POS = "rspress-graph-view-pos";
/**
 * Scope, depth, link directions and visibility toggles, persisted so a
 * reader's filter choices survive closing the panel. The search query is
 * deliberately not stored: it describes a moment, not a preference.
 */
export const LOCAL_STORAGE_KEY_FILTERS = "rspress-graph-view-filters";
/** Display settings: arrows, text fade threshold, node size, link thickness. */
export const LOCAL_STORAGE_KEY_DISPLAY = "rspress-graph-view-display";
/** Force settings: center, repel, link force, link distance. */
export const LOCAL_STORAGE_KEY_FORCES = "rspress-graph-view-forces";
/**
 * Screens too narrow for the floating panel to sit beside the article: there
 * `defaultOpen` does not apply.
 */
export const NARROW_VIEWPORT_QUERY = "(max-width: 639px)";
