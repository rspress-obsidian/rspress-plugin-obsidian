/**
 * Client-side Mermaid rendering, shared by the markdown feature (```mermaid
 * fences in notes) and the canvas feature (mermaid blocks inside canvas text).
 *
 * Both features emit `<pre class="obsidian-mermaid-block" data-code="...">`
 * placeholders at parse time. Mermaid needs the DOM, so the diagram is rendered
 * here (from an effect), not during the markdown pass — the same approach as
 * `rspress-plugin-mermaid`. Mermaid itself (~900 kB with its renderer) is
 * imported dynamically on the first diagram: a static import would put it in
 * every chunk that merely touches this module, including pages whose canvases
 * and notes contain no diagram at all.
 *
 * React re-applies `dangerouslySetInnerHTML` on re-render, which wipes any SVG
 * injected into a placeholder. `renderMermaidBlocks` is therefore idempotent: it
 * only renders blocks that currently lack their diagram, so callers can invoke
 * it after every commit and wipes self-heal.
 *
 * State is module-level, so a host app that uses both features shares one
 * instance. Holders of that state are counted (`retainMermaid`/`disposeMermaid`),
 * so the first canvas to unmount no longer disables the diagrams of a second
 * canvas or of a markdown page in the same document; the last release drops the
 * tracked set and the theme observer, and the next `renderMermaidBlocks` call
 * rebuilds both.
 *
 * Mermaid's configuration is global too, yet each diagram has its own security
 * level (see {@link securityLevelOf}). Renders therefore run one at a time
 * through a single queue, ordered so diagrams of one level render together, and
 * the instance is re-initialized before the first render of each group: no
 * render ever observes another block's level.
 */

import {
	MERMAID_BLOCK_CLASS,
	MERMAID_ERROR_CLASS,
	MERMAID_INSTALL_HINT,
	MERMAID_RENDERED_CLASS,
	MERMAID_SECURITY_ATTRIBUTE,
	MERMAID_STRICT_SCOPE_ATTRIBUTE,
	MERMAID_UNAVAILABLE_ATTRIBUTE,
	type MermaidSecurityLevel,
} from "./classes.js";

const RENDER_TIMEOUT_MS = 10_000;

const SECURITY_LEVELS: readonly MermaidSecurityLevel[] = [
	"strict",
	"loose",
	"antiscript",
	"sandbox",
];

type Mermaid = typeof import("mermaid").default;

let renderId = 0;
let observer: MutationObserver | null = null;
const trackedBlocks = new Set<HTMLElement>();
/** Blocks with a render in flight, so a rescan cannot start a second one. */
const pendingBlocks = new WeakSet<HTMLElement>();
/**
 * Live consumers holding the shared observer open. The canvas renderer mounts and
 * unmounts per page, and several canvases can share one document; without a count
 * the first unmount tore the observer out from under every other diagram.
 */
let consumers = 0;
/** One in-flight `import("mermaid")` shared by every block. */
let mermaidPromise: Promise<Mermaid> | null = null;
/** Theme the shared instance was last configured with; `null` until first use. */
let initializedTheme: "dark" | "default" | null = null;
/** Security level the shared instance was last configured with. */
let initializedSecurityLevel: MermaidSecurityLevel | null = null;
/** Level of an unstamped diagram, and of every diagram in a strict scope. */
const DEFAULT_SECURITY_LEVEL: MermaidSecurityLevel = "strict";
/**
 * Tail of the render queue. Every render, including its `initialize`, runs after
 * the previous one settles, so re-configuring mermaid for one diagram's level can
 * never land while another diagram is still rendering.
 */
let renderQueue: Promise<void> = Promise.resolve();

function isDark(): boolean {
	return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/**
 * Raised when the page has diagrams but the site was built without `mermaid`.
 *
 * Mermaid is an optional peer dependency. When it is not installed, the
 * plugins alias the specifier to an empty module (see `./install.ts`) so the
 * site still builds; `import("mermaid")` then resolves to a namespace with no
 * renderer in it.
 */
export class MermaidUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super(MERMAID_INSTALL_HINT, options);
		this.name = "MermaidUnavailableError";
	}
}

function defaultImport(): Promise<unknown> {
	return import("mermaid");
}

let importMermaid: () => Promise<unknown> = defaultImport;

/**
 * Replace how the renderer obtains the `mermaid` module namespace; `null`
 * restores the real `import("mermaid")`. Internal: tests use it to reproduce a
 * site built without the optional peer, which a module mock cannot do without
 * also replacing mermaid for every other suite in the same run.
 */
export function setMermaidLoader(loader: (() => Promise<unknown>) | null): void {
	importMermaid = loader ?? defaultImport;
	mermaidPromise = null;
	initializedTheme = null;
	initializedSecurityLevel = null;
	warnedUnavailable = false;
}

/** Pull the mermaid API out of a module namespace, or report it missing. */
export function mermaidFromModule(module: unknown): Mermaid {
	const api =
		typeof module === "object" && module !== null && "default" in module ? module.default : null;
	if (
		typeof api !== "object" ||
		api === null ||
		!("render" in api) ||
		typeof api.render !== "function" ||
		!("initialize" in api) ||
		typeof api.initialize !== "function"
	) {
		throw new MermaidUnavailableError();
	}
	// Shape checked above; the namespace's full type is mermaid's own.
	const mermaid = api as Mermaid;
	return mermaid;
}

async function loadMermaid(): Promise<Mermaid> {
	mermaidPromise ??= importMermaid().then(mermaidFromModule, (error: unknown) => {
		// The code a bundler's missing-module stub and Node both throw with.
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
		if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
			throw new MermaidUnavailableError({ cause: error });
		}
		// A chunk that failed to download (offline, a deploy swapped the
		// assets) is not a missing package: forget the attempt so the next
		// scan retries instead of caching the failure for the whole visit.
		mermaidPromise = null;
		throw error;
	});
	return mermaidPromise;
}

let warnedUnavailable = false;

/** Read a stamped level, or `null` when the attribute is absent or unknown. */
function readSecurityLevel(value: string | null): MermaidSecurityLevel | null {
	const match = SECURITY_LEVELS.find((level) => level === value);
	return match ?? null;
}

/**
 * The `securityLevel` one diagram renders with.
 *
 * `strict` unless the placeholder stamps another level: mermaid's own sanitising
 * pass then strips unsafe link URLs, so a diagram with `click A "javascript:..."`
 * never reaches the DOM as a live anchor. Only note placeholders carry a stamp,
 * written from plugin configuration; an unknown stamp counts as none, and a
 * diagram inside a strict scope (a canvas board) is `strict` whatever it stamps.
 */
function securityLevelOf(block: HTMLElement): MermaidSecurityLevel {
	if (block.closest(`[${MERMAID_STRICT_SCOPE_ATTRIBUTE}]`)) return DEFAULT_SECURITY_LEVEL;
	return (
		readSecurityLevel(block.getAttribute(MERMAID_SECURITY_ATTRIBUTE)) ?? DEFAULT_SECURITY_LEVEL
	);
}

/**
 * Load mermaid once, and re-run `initialize` only when the theme or the
 * security level actually changed. `mermaid.initialize` writes global config, so
 * calling it per block was wasted work; theme switches still need it, since the
 * diagram text is re-rendered with the new palette. Only ever called from a
 * queued render, so nothing else renders between this and that render.
 */
async function ensureMermaid(securityLevel: MermaidSecurityLevel): Promise<Mermaid> {
	const mermaid = await loadMermaid();
	const theme = isDark() ? "dark" : "default";
	if (initializedTheme !== theme || initializedSecurityLevel !== securityLevel) {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel,
			theme,
			// Mermaid renders into a temporary container it appends to `<body>`. On
			// a syntax error it otherwise draws its "Syntax error" diagram there and
			// throws before removing it, stranding one per broken block at the end
			// of the page. The block keeps its source and the error class instead.
			suppressErrorRendering: true,
		});
		initializedTheme = theme;
		initializedSecurityLevel = securityLevel;
	}
	return mermaid;
}

/** Settle with `work`, or reject once a render has taken too long. */
async function withRenderTimeout<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Executor form: this ships to browsers, and `Promise.withResolvers` needs Safari 17.4.
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Mermaid render timed out after ${RENDER_TIMEOUT_MS}ms`)),
			RENDER_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Render one diagram. `onShown` fires as soon as the block shows its outcome —
 * a diagram or the error class, a timeout included — while the returned promise
 * waits for Mermaid itself: a render that timed out is still running inside it,
 * and the queued render behind it must not `initialize` the shared instance
 * under it. Its late result is discarded.
 */
async function renderBlock(
	block: HTMLElement,
	securityLevel: MermaidSecurityLevel,
	onShown: () => void,
): Promise<void> {
	let rendering: Promise<unknown> | undefined;
	try {
		const code = block.getAttribute("data-code") ?? "";
		if (!code) return;
		const mermaid = await ensureMermaid(securityLevel);
		renderId += 1;
		const render = mermaid.render(`obsidian-mermaid-${renderId}`, code);
		rendering = render;
		const { svg } = await withRenderTimeout(render);
		block.innerHTML = svg;
		block.classList.add(MERMAID_RENDERED_CLASS);
		block.classList.remove(MERMAID_ERROR_CLASS);
	} catch (error) {
		block.classList.add(MERMAID_ERROR_CLASS);
		if (error instanceof MermaidUnavailableError) {
			// The source stays readable in the block; the title says why it is
			// not a diagram. One console line per page load, not one per block.
			block.setAttribute(MERMAID_UNAVAILABLE_ATTRIBUTE, "");
			block.title = MERMAID_INSTALL_HINT;
			if (!warnedUnavailable) {
				warnedUnavailable = true;
				console.warn(`[rspress-plugin-obsidian] ${MERMAID_INSTALL_HINT}`);
			}
			return;
		}
		console.warn("[rspress-plugin-obsidian] Mermaid diagram failed to render", error);
	} finally {
		onShown();
	}
	await rendering?.catch(() => undefined);
}

/**
 * Queue renders for `blocks`, those sharing a level back to back, so the shared
 * instance is re-initialized once per level rather than once per alternation.
 * Returns each block's render, settling once that block is drawn or errored.
 */
function enqueueRenders(blocks: readonly HTMLElement[]): Promise<void>[] {
	const groups = new Map<MermaidSecurityLevel, HTMLElement[]>();
	for (const block of blocks) {
		const level = securityLevelOf(block);
		const group = groups.get(level);
		if (group) group.push(block);
		else groups.set(level, [block]);
	}
	const renders: Promise<void>[] = [];
	for (const [level, group] of groups) {
		for (const block of group) {
			// `renderBlock` reports its own failures on the block and never
			// rejects, so a failed diagram does not stop the ones behind it.
			renders.push(
				new Promise<void>((shown) => {
					renderQueue = renderQueue.then(() => renderBlock(block, level, shown));
				}),
			);
		}
	}
	return renders;
}

function ensureObserver(): void {
	if (observer || typeof document === "undefined") return;
	observer = new MutationObserver(() => {
		const stale: HTMLElement[] = [];
		for (const block of trackedBlocks) {
			// Client-side navigation detaches a page's placeholders; drop them so
			// the set tracks only live diagrams and a theme toggle does not
			// re-render elements nobody can see.
			if (!block.isConnected) {
				trackedBlocks.delete(block);
				continue;
			}
			// Reset to raw source so the diagram re-renders with the new theme.
			block.textContent = block.getAttribute("data-code") ?? "";
			block.classList.remove(MERMAID_RENDERED_CLASS, MERMAID_ERROR_CLASS);
			stale.push(block);
		}
		enqueueRenders(stale);
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

/**
 * Render any placeholders inside `root` that are missing their diagram, and
 * return how many are still unrendered (including renders now in flight).
 * Idempotent — safe to call after every React commit, route change or DOM
 * mutation. Each diagram renders at its own level ({@link securityLevelOf}), so
 * scanning a page together with an embedded canvas, or two scans racing, never
 * renders one diagram at another's level.
 */
export function renderMermaidBlocks(root: ParentNode): number {
	const blocks = Array.from(root.querySelectorAll<HTMLElement>(`.${MERMAID_BLOCK_CLASS}`));
	const fresh: HTMLElement[] = [];
	let pending = 0;
	for (const block of blocks) {
		if (block.classList.contains(MERMAID_ERROR_CLASS)) continue;
		if (block.querySelector("svg")) continue;
		pending += 1;
		if (pendingBlocks.has(block)) continue;
		trackedBlocks.add(block);
		pendingBlocks.add(block);
		fresh.push(block);
	}
	const renders = enqueueRenders(fresh);
	fresh.forEach((block, index) => {
		void renders[index]?.finally(() => pendingBlocks.delete(block));
	});
	ensureObserver();
	return pending;
}

/**
 * Claim the shared theme observer. Every holder must pair this with
 * `disposeMermaid` on unmount, so one holder leaving does not drop the diagrams
 * belonging to the others.
 */
export function retainMermaid(): void {
	consumers += 1;
}

/**
 * Release a claim (call on unmount). Each holder counts, so the first canvas to
 * unmount no longer takes the observer away from a second canvas. The observer is
 * also kept whenever any tracked block is still in the document: those diagrams
 * belong to a page — typically a markdown route rendering `MermaidBlocks` — that
 * never claimed the shared state.
 */
export function disposeMermaid(): void {
	consumers = Math.max(0, consumers - 1);
	if (consumers > 0) return;
	for (const block of trackedBlocks) {
		if (!block.isConnected) trackedBlocks.delete(block);
	}
	if (trackedBlocks.size > 0) return;
	observer?.disconnect();
	observer = null;
}
