/**
 * The graph's virtual module ids. The build keys the generated module sources
 * by these names (`addRuntimeModules`) and Rspress aliases each id to a file
 * under `.rspress/runtime`, so the build and the client must spell them alike.
 *
 * An id is also written out where a module is *imported*: TypeScript requires
 * a string-literal module specifier and Rspack resolves `import("…")` while it
 * builds, so `runtime/GraphView.tsx`, `runtime/graph-search-data.ts` and
 * `runtime/virtual-modules.d.ts` carry the same two strings. A rename edits
 * this file and those three specifiers.
 */
export const GRAPH_DATA_MODULE = "virtual-graph-data";
export const GRAPH_SEARCH_MODULE = "virtual-graph-search-data";
