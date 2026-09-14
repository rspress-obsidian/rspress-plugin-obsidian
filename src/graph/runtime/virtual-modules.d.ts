declare module "virtual-graph-data" {
	import type { GraphData } from "../types";
	export const graphData: GraphData;
	export default graphData;
}

declare module "virtual-page-content-data" {
	interface PageContent {
		routePath: string;
		title: string;
		content: string;
	}
	export const pageContentData: PageContent[];
	export default pageContentData;
}
