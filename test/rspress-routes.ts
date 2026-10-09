import type { ComponentType } from "react";

/** A page as the `@rspress/core/runtime` stub serves it: the compiled MDX component and its page data. */
export interface TestRoute {
	path: string;
	default: ComponentType<{ components?: object }>;
	title?: string;
	/** The page's own `# heading`, which suppresses the fallback title. */
	headingTitle?: string;
	/** The page's chunk fails to download. */
	chunkFails?: boolean;
}

let routes: TestRoute[] = [];

export function setTestRoutes(next: TestRoute[]): void {
	routes = next;
}

/** Rspress's own route normalization: decoded, no `.html`, no `/index`, case-insensitive. */
export function findTestRoute(pathname: string): TestRoute | undefined {
	const normalize = (path: string) =>
		decodeURIComponent(path)
			.replace(/\.html$/, "")
			.replace(/\/index$/, "/")
			.toLowerCase();
	return routes.find((route) => normalize(route.path) === normalize(pathname));
}
