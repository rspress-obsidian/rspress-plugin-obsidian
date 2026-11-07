/**
 * The optional peer that draws the graph. `install.ts` aliases exactly this
 * specifier to an empty module when the package is absent, so the runtime's
 * `import(...)` in `runtime/GraphView.tsx` keeps the string literal: a computed
 * specifier is neither aliased nor bundled.
 */
export const FORCE_GRAPH_PACKAGE = "react-force-graph-2d";
