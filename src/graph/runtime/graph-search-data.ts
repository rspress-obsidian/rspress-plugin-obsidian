let pending: Promise<ReadonlyMap<string, string>> | undefined;

/**
 * Note text for `content:`, `line:` and `section:` graph searches. It is the
 * largest graph dataset, so it is its own chunk, fetched the first time a query
 * needs it and shared by every graph on the page after that.
 */
export function loadGraphSearchText(): Promise<ReadonlyMap<string, string>> {
	pending ??= import("virtual-graph-search-data")
		.then(
			({ searchEntries }) =>
				new Map(searchEntries.map((entry) => [entry.id, entry.text])) as ReadonlyMap<
					string,
					string
				>,
		)
		.catch((error: unknown) => {
			// Let a later query retry a chunk that failed to download.
			pending = undefined;
			throw error;
		});
	return pending;
}
