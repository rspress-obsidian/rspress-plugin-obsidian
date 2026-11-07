/**
 * Add a `<style>` element to the document once. Keyframes referenced from
 * inline styles have no stylesheet to live in, and a page can mount the tree
 * that needs them more than once (a panel, a sidebar graph, a second panel), so
 * injection is keyed by id instead of happening per mounted component.
 */
export function injectStyles(id: string, css: string): void {
	if (typeof document === "undefined") return;
	if (document.getElementById(id)) return;
	const style = document.createElement("style");
	style.id = id;
	style.textContent = css;
	document.head.appendChild(style);
}
