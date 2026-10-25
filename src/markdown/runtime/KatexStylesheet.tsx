import { Head } from "@rspress/core/runtime";
import { isStylesheetApplied, loadStylesheet } from "../../shared/stylesheet.js";

/** Stylesheets this component has waited for, whether they loaded or failed. */
const settled = new Set<string>();

/**
 * Links KaTeX's stylesheet from the head of a page whose formulas were rendered
 * at build time. The remark pass emits it only on such pages, so a page
 * without math never downloads the stylesheet.
 *
 * Server-rendered, the link lands in the page's `<head>`, where it holds the
 * first paint like any stylesheet. Reached by client-side navigation, the page
 * suspends until the stylesheet has loaded, so its formulas never flash
 * unstyled; Rspress handles that like the wait for the route's own chunk.
 *
 * Registered through `markdown.globalComponents`.
 */
export default function KatexStylesheet({ href }: { href: string }) {
	if (typeof document !== "undefined" && !settled.has(href)) {
		if (isStylesheetApplied(href)) settled.add(href);
		else
			throw loadStylesheet(href).then(() => {
				settled.add(href);
			});
	}
	return (
		<Head>
			<link rel="stylesheet" href={href} />
		</Head>
	);
}
