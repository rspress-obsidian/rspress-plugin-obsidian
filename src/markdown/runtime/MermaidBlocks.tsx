import { useEffect } from "react";
import { MERMAID_BLOCK_CLASS } from "../../mermaid/classes.js";
import { usePathname } from "../../shared/usePathname.js";

/**
 * Draws every ` ```mermaid ` placeholder on the page.
 *
 * Mermaid is a large dependency, so it is imported **only when the page actually
 * contains a diagram** — a dynamic import keeps it in its own chunk instead of
 * the bundle every page loads. The placeholders are server-rendered, so the
 * first scan usually finds them already in the DOM; the mutation observer stays
 * connected for the component's lifetime because Rspress renders each route
 * inside `Suspense` and a slow route chunk can commit well after the first
 * frame. An idle scan costs one `querySelectorAll`, throttled to a frame.
 *
 * Registered by the markdown plugin through `globalUIComponents` when
 * `enableMermaid` is on. Renders nothing itself.
 */
export default function MermaidBlocks() {
	const pathname = usePathname();

	// `pathname` is the route-change trigger, not an input to the scan.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per route
	useEffect(() => {
		let frame = 0;
		let cancelled = false;

		const scan = async () => {
			frame = 0;
			if (!document.querySelector(`.${MERMAID_BLOCK_CLASS}`)) return;

			// Dynamic on purpose: a static import would put mermaid (~900 kB with
			// its renderer) into the chunk every page loads, including the pages
			// that have no diagram at all.
			const { renderMermaidBlocks } = await import("../../mermaid/blocks.js");
			if (cancelled) return;
			renderMermaidBlocks(document.body);
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => void scan());
		};

		schedule();
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });

		return () => {
			cancelled = true;
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [pathname]);

	return null;
}
