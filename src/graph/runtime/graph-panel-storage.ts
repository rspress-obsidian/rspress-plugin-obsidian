/**
 * localStorage keys shared by the graph panel and its lazy wrapper.
 *
 * A leaf module on purpose: `LazyGraphPanel` must not statically import
 * `GraphPanel`, or the dynamic `import("./GraphPanel.js")` would be folded back
 * into the same chunk and every page view would download the force-graph
 * renderer.
 */
export const LOCAL_STORAGE_KEY_OPEN = "rspress-graph-view-open";
export const LOCAL_STORAGE_KEY_POS = "rspress-graph-view-pos";
/**
 * Depth and visibility toggles, persisted so a reader's filter choices
 * survive closing the panel. The search query is deliberately not stored:
 * it describes a moment, not a preference.
 */
export const LOCAL_STORAGE_KEY_FILTERS = "rspress-graph-view-filters";
