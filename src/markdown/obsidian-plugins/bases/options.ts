/** The background of map views, as the Maps plugin's `mapTiles` / `mapTilesDark` view settings take it. */
export interface BasesMapTiles {
	/**
	 * A style URL (a MapLibre style JSON, such as OpenFreeMap's), or one or more
	 * raster tile URL templates with `{z}`, `{x}` and `{y}`.
	 */
	tiles: string | string[];
	/** The same, in dark mode. Default: `tiles`. */
	tilesDark?: string | string[];
	/**
	 * Credit shown on the map, as inline markdown (`© [Name](https://…)`). A
	 * style URL brings its own; OpenStreetMap's tile servers get theirs by
	 * default. Default: none.
	 */
	attribution?: string;
}

/** Options for the Bases feature (`enableBases`). */
export interface BasesOptions {
	/** Route prefix the pages of `.base` files publish under. Default: `"/bases"`. */
	routePrefix?: string;
	/**
	 * The clock `now()`, `today()` and `date.relative()` read, as a `Date` or a
	 * `YYYY-MM-DD[ HH:mm[:ss]]` string. Pin it for reproducible builds. Default:
	 * the time each base renders.
	 */
	now?: Date | string;
	/** Moment.js format a date value shows in when no `format()` is applied. Default: `"YYYY-MM-DD"`. */
	dateFormat?: string;
	/** Moment.js format a date-and-time value shows in. Default: `"YYYY-MM-DD HH:mm"`. */
	dateTimeFormat?: string;
	/**
	 * Background of map views that set no `mapTiles` of their own. Default: the
	 * Maps plugin's first background in `.obsidian/plugins/maps/data.json`, else
	 * its default, OpenFreeMap's `bright` and `dark` styles.
	 */
	mapTiles?: BasesMapTiles;
	/**
	 * Read the vault's property types (`.obsidian/types.json`) and the Maps
	 * plugin's backgrounds (`.obsidian/plugins/maps/data.json`), so a property
	 * Obsidian types as a date, number or checkbox reads as one and a map
	 * shows the vault's tiles. Default: `true`.
	 */
	readVaultSettings?: boolean;
}
