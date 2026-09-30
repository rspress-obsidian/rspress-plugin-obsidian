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
 */

import {
	MERMAID_BLOCK_CLASS,
	MERMAID_ERROR_CLASS,
	MERMAID_RENDERED_CLASS,
	MERMAID_SECURITY_ATTRIBUTE,
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
/**
 * Security level the shared instance was last configured with. Mermaid's
 * configuration is global, so the level is tracked here and a change
 * re-initializes it — see {@link setMermaidSecurityLevel}.
 */
let initializedSecurityLevel: MermaidSecurityLevel | null = null;
/** Level every diagram renders with until a placeholder stamps another. */
const DEFAULT_SECURITY_LEVEL: MermaidSecurityLevel = "strict";
let securityLevel: MermaidSecurityLevel = DEFAULT_SECURITY_LEVEL;

function isDark(): boolean {
	return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

async function loadMermaid(): Promise<Mermaid> {
	mermaidPromise ??= import("mermaid").then((module) => module.default);
	return mermaidPromise;
}

/**
 * Choose the `securityLevel` every diagram renders with.
 *
 * `strict` is the default: mermaid's own sanitising pass strips unsafe link
 * URLs, so a diagram with `click A "javascript:..."` never reaches the DOM as
 * a live anchor. The looser levels hand rendering to the diagram source and
 * are only ever set from plugin configuration.
 */
export function setMermaidSecurityLevel(level: MermaidSecurityLevel): void {
	securityLevel = level;
}

/** Read a stamped level, or `null` when the attribute is absent or unknown. */
function readSecurityLevel(value: string | null): MermaidSecurityLevel | null {
	const match = SECURITY_LEVELS.find((level) => level === value);
	return match ?? null;
}

/**
 * Load mermaid once, and re-run `initialize` only when the theme or the
 * security level actually changed. `mermaid.initialize` writes global config, so
 * calling it per block was both wasted work and a way for two renders to
 * observe each other's settings; theme switches still need it, since the
 * diagram text is re-rendered with the new palette.
 */
async function ensureMermaid(): Promise<Mermaid> {
	const mermaid = await loadMermaid();
	const theme = isDark() ? "dark" : "default";
	if (initializedTheme !== theme || initializedSecurityLevel !== securityLevel) {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel,
			theme,
		});
		initializedTheme = theme;
		initializedSecurityLevel = securityLevel;
	}
	return mermaid;
}

async function renderBlock(block: HTMLElement): Promise<void> {
	const code = block.getAttribute("data-code") ?? "";
	if (!code) return;
	try {
		const mermaid = await ensureMermaid();
		renderId += 1;
		const { svg } = await Promise.race([
			mermaid.render(`obsidian-mermaid-${renderId}`, code),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Mermaid render timed out after ${RENDER_TIMEOUT_MS}ms`)),
					RENDER_TIMEOUT_MS,
				),
			),
		]);
		block.innerHTML = svg;
		block.classList.add(MERMAID_RENDERED_CLASS);
		block.classList.remove(MERMAID_ERROR_CLASS);
	} catch (error) {
		console.warn("[rspress-plugin-obsidian] Mermaid diagram failed to render", error);
		block.classList.add(MERMAID_ERROR_CLASS);
	}
}

function ensureObserver(): void {
	if (observer || typeof document === "undefined") return;
	observer = new MutationObserver(() => {
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
			void renderBlock(block);
		}
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

/**
 * Render any placeholders inside `root` that are missing their diagram, and
 * return how many are still unrendered (including renders now in flight).
 * Idempotent — safe to call after every React commit, route change or DOM
 * mutation.
 */
export function renderMermaidBlocks(root: ParentNode): number {
	const blocks = Array.from(root.querySelectorAll<HTMLElement>(`.${MERMAID_BLOCK_CLASS}`));
	// A placeholder emitted from a note carries the configured security level, so
	// the shared instance is configured before the first render starts. Every
	// block of one site carries the same value; the first stamped one wins.
	//
	// Unstamped blocks must reset it rather than inherit: a canvas board emits
	// no stamp, and the level is module-global, so a page that configured a
	// looser one would otherwise hand that level to the next route's diagrams.
	let stamped = false;
	for (const block of blocks) {
		const level = readSecurityLevel(block.getAttribute(MERMAID_SECURITY_ATTRIBUTE));
		if (level) {
			setMermaidSecurityLevel(level);
			stamped = true;
			break;
		}
	}
	if (!stamped) setMermaidSecurityLevel(DEFAULT_SECURITY_LEVEL);
	let pending = 0;
	for (const block of blocks) {
		if (block.classList.contains(MERMAID_ERROR_CLASS)) continue;
		if (block.querySelector("svg")) continue;
		pending += 1;
		if (pendingBlocks.has(block)) continue;
		trackedBlocks.add(block);
		pendingBlocks.add(block);
		void renderBlock(block).finally(() => pendingBlocks.delete(block));
	}
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
