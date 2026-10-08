# Source layout

```
src/
  shared/     primitives more than one feature needs. Node-free.
  markdown/   the `markdown` feature — the remark pipeline.
  canvas/     the `canvas` feature — .canvas parsing, rendering, editor.
  graph/      the `graphview` feature — build-time extraction + runtime panel.
  index.ts    the umbrella entry that composes the three plugins.
```

## The rule

**`src/shared/` may not import `node:*` or a feature.** Everything there is
something at least two features need and no feature owns.

The node-free half is not stylistic. The canvas text-card renderer and the graph
panel both ship to the browser, so a module reachable from either pulls its
whole import graph into the client bundle — and a single `node:fs` in that graph
is a broken build. `route-path.ts` exists as a separate module purely so the
browser never inherits it.

`test/shared-boundary.test.ts` enforces all of this: the node-free rule (every
import form — static, dynamic, `require`, bare `fs`/`path` as well as `node:`),
that `shared/` does not reach into a feature, and that only build-time code
crosses between features — into markdown's content index and resolver, never
from or into browser code.

## Why it is a directory and not a `utils.ts`

The three features were merged into one package, and the utilities that all
three need came along for the ride inside `src/markdown/`. That made the markdown
directory two things at once — a feature, and the shared library the other two
features imported from. `src/escape.ts` and `src/route-path.ts` had already
escaped to the root for exactly the node-free reason above; `src/shared/` is
where that convention now applies uniformly.

## Adding a module here

Move it only when **two features genuinely need it**. A helper used by one
feature belongs to that feature, even if it feels generally useful — a shared
module that only one caller uses is just a misplaced private helper.

## The markdown pipeline

`src/markdown/remark-wikilink.ts` is one file, and stays one file. Its
`remarkWikilinkInner` runs the document through ~19 stages, and the stages are
named functions in pipeline order at the top of the file, with the orchestrator
below them reading as the ordered list.

The order is load-bearing in at least one place: callout content is rebuilt
from raw source and so carries no source positions, which is the only reason
`processCommentValues` exists. Running it before the callout stage publishes
hidden comment text. Other neighbouring pairs are not coupled — do not assume
they are. `pipeline ordering` in `remark-wikilink.test.ts` holds the composed
behaviour, and the comment above the stages says which pair is a real pin.

Splitting the stages into `passes/` was considered and rejected: together they
reach 17 helpers that all live in the same module, so a split exports 17
internals and leaves `passes/` importing back from the file that imports it.
