/**
 * Load a stylesheet into the document from the browser, for content that must
 * not show before its styles apply: KaTeX math on a page reached by
 * client-side navigation, and the formulas a canvas board typesets.
 */

/** A stylesheet that neither loads nor fails within this long stops holding content back. */
const LOAD_TIMEOUT_MS = 5000;

const applied = new Set<string>();
const loading = new Map<string, Promise<void>>();

function linkWithSheet(href: string): HTMLLinkElement | undefined {
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		if (link.getAttribute("href") === href && link.sheet) return link;
	}
	return undefined;
}

/**
 * Whether `href` is already applied to the document: loaded through
 * {@link loadStylesheet}, or linked by the server-rendered page and loaded
 * before it was painted.
 */
export function isStylesheetApplied(href: string): boolean {
	if (applied.has(href)) return true;
	if (!linkWithSheet(href)) return false;
	applied.add(href);
	return true;
}

/**
 * Add `href` to the document, resolving once it applies. A stylesheet that
 * fails or stalls resolves too: the content then shows unstyled rather than
 * not at all, and the next call tries again.
 */
export function loadStylesheet(href: string): Promise<void> {
	if (isStylesheetApplied(href)) return Promise.resolve();
	let pending = loading.get(href);
	if (pending) return pending;
	// Executor form: this ships to browsers, and `Promise.withResolvers` needs Safari 17.4.
	pending = new Promise<boolean>((resolve) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		link.addEventListener("load", () => resolve(true), { once: true });
		link.addEventListener("error", () => resolve(false), { once: true });
		setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
		document.head.append(link);
	}).then((loaded) => {
		loading.delete(href);
		if (loaded) applied.add(href);
	});
	loading.set(href, pending);
	return pending;
}
