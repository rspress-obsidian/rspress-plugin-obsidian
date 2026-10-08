declare module "virtual-graph-data" {
	import type { GraphPayload } from "../types";
	export const graphPayload: GraphPayload;
	export default graphPayload;
}

declare module "virtual-graph-search-data" {
	import type { GraphSearchEntry } from "../types";
	export const searchEntries: GraphSearchEntry[];
	export default searchEntries;
}

declare module "virtual-page-content-data" {
	interface PageContent {
		routePath: string;
		title: string;
		content: string;
	}
	/** Site `base` (`/…/`), stripped from link hrefs before lookup. */
	export const base: string;
	export const pageContentData: PageContent[];
	export default pageContentData;
}
