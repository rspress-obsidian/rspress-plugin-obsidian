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
