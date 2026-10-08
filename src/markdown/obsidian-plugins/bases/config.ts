/**
 * A `.base` file (or a ```base block) read into its parts: `filters`,
 * `formulas`, `properties`, `summaries` and `views`, as Bases syntax.md
 * defines them. Malformed YAML and a wrong shape are errors; a key Obsidian
 * does not define is a warning, because a newer Obsidian or a view plugin may
 * write keys this build does not know.
 */
import { parseDocument } from "yaml";

export type FilterNode =
	| { kind: "statement"; source: string }
	| { kind: "and" | "or" | "not"; children: FilterNode[] };

export type SortDirection = "ASC" | "DESC";

export interface SortSpec {
	property: string;
	direction: SortDirection;
}

export interface ViewConfig {
	type: string;
	name: string;
	limit?: number;
	filters?: FilterNode;
	/** Properties shown, in order. */
	order: string[];
	sort: SortSpec[];
	groupBy?: SortSpec;
	/** Groups shown, in this order; `null` is the group of files without a value. */
	groupOrder?: (string | null)[];
	/** Property → summary name (a default one, or a key of the base's `summaries`). */
	summaries: Record<string, string>;
	/** Layout settings (`image`, `imageFit`, `rowHeight`, `columnSize`, …) as written. */
	settings: Record<string, unknown>;
}

export interface BaseConfig {
	filters?: FilterNode;
	formulas: Record<string, string>;
	displayNames: Record<string, string>;
	summaries: Record<string, string>;
	views: ViewConfig[];
}

export interface ParsedBase {
	config: BaseConfig;
	warnings: string[];
}

/** The base cannot be read: malformed YAML or a section of the wrong shape. */
export class BaseConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BaseConfigError";
	}
}

const TOP_LEVEL_KEYS: Record<string, true> = {
	filters: true,
	formulas: true,
	properties: true,
	summaries: true,
	views: true,
};

const VIEW_KEYS: Record<string, true> = {
	type: true,
	name: true,
	limit: true,
	filters: true,
	order: true,
	sort: true,
	groupBy: true,
	groupOrder: true,
	summaries: true,
};

/** Settings each layout reads (Layouts/*.md); any other key is reported. */
const LAYOUT_KEYS: Record<string, Record<string, true>> = {
	table: { columnSize: true, rowHeight: true },
	cards: { image: true, imageFit: true, imageAspectRatio: true, cardSize: true },
	list: { markers: true, indentProperties: true, separator: true, nestedProperties: true },
	kanban: {
		image: true,
		imageFit: true,
		imageAspectRatio: true,
		hideEmptyColumns: true,
		columnWidth: true,
		cardSize: true,
	},
	map: {
		coordinates: true,
		markerIcon: true,
		markerColor: true,
		center: true,
		defaultZoom: true,
		minZoom: true,
		maxZoom: true,
		mapHeight: true,
		mapTiles: true,
		mapTilesDark: true,
		/** Not the Maps plugin's: the credit a published raster background needs. */
		mapAttribution: true,
		embeddedHeight: true,
	},
};

/** A YAML mapping as `toJS()` returns it: string keys, values still unchecked. */
type Mapping = Record<string, unknown>;

/** `value` as a YAML mapping, or a {@link BaseConfigError} with `message`. */
function mapping(value: unknown, message: string): Mapping {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BaseConfigError(message);
	}
	// `toJS()` builds plain objects with string keys for every YAML mapping.
	const yamlMapping = value as Mapping;
	return yamlMapping;
}

function direction(value: unknown): SortDirection {
	return String(value ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
}

/** Read a filter section: a statement, or `and`/`or`/`not` over a list of filters. */
function parseFilter(value: unknown, where: string): FilterNode {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return { kind: "statement", source: String(value) };
	}
	const node = mapping(value, `${where} must be a filter statement or an and/or/not object`);
	const keys = Object.keys(node);
	const [key] = keys;
	if (keys.length !== 1 || (key !== "and" && key !== "or" && key !== "not")) {
		throw new BaseConfigError(
			`${where} must have exactly one of "and", "or" or "not" (found ${keys.map((k) => `"${k}"`).join(", ") || "none"})`,
		);
	}
	const list = node[key];
	if (!Array.isArray(list)) throw new BaseConfigError(`${where}.${key} must be a list`);
	return {
		kind: key,
		children: list.map((child, index) => parseFilter(child, `${where}.${key}[${index}]`)),
	};
}

function stringRecord(value: unknown, where: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(mapping(value, `${where} must be a mapping`))) {
		result[key] = String(entry ?? "");
	}
	return result;
}

function sortSpec(value: unknown, where: string): SortSpec {
	if (typeof value === "string") return { property: value, direction: "ASC" };
	const spec = mapping(value, `${where} must be {property, direction}`);
	// Obsidian 1.9 wrote `column:`; later versions write `property:`.
	const property = spec.property ?? spec.column;
	if (typeof property !== "string" || property === "") {
		throw new BaseConfigError(`${where} needs a property`);
	}
	return { property, direction: direction(spec.direction) };
}

function parseView(raw: unknown, index: number, warnings: string[]): ViewConfig {
	const where = `views[${index}]`;
	const value = mapping(raw, `${where} must be a mapping`);
	const type = typeof value.type === "string" ? value.type : "table";
	const name =
		typeof value.name === "string" || typeof value.name === "number"
			? String(value.name)
			: `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
	const layoutKeys = LAYOUT_KEYS[type] ?? {};
	const settings: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (Object.hasOwn(VIEW_KEYS, key)) continue;
		if (!Object.hasOwn(layoutKeys, key)) {
			warnings.push(`Unknown key "${key}" in view "${name}" (${type})`);
		}
		settings[key] = entry;
	}
	let limit: number | undefined;
	if (value.limit !== undefined && value.limit !== null) {
		limit = Number(value.limit);
		if (!Number.isInteger(limit) || limit < 0) {
			throw new BaseConfigError(`${where}.limit must be a whole number`);
		}
	}
	if (value.order !== undefined && value.order !== null && !Array.isArray(value.order)) {
		throw new BaseConfigError(`${where}.order must be a list of properties`);
	}
	if (value.sort !== undefined && value.sort !== null && !Array.isArray(value.sort)) {
		throw new BaseConfigError(`${where}.sort must be a list`);
	}
	if (
		value.groupOrder !== undefined &&
		value.groupOrder !== null &&
		!Array.isArray(value.groupOrder)
	) {
		throw new BaseConfigError(`${where}.groupOrder must be a list`);
	}
	return {
		type,
		name,
		limit,
		filters:
			value.filters === undefined || value.filters === null
				? undefined
				: parseFilter(value.filters, `${where}.filters`),
		order: ((value.order as unknown[] | undefined) ?? ["file.name"]).map(String),
		sort: ((value.sort as unknown[] | undefined) ?? []).map((entry, i) =>
			sortSpec(entry, `${where}.sort[${i}]`),
		),
		groupBy:
			value.groupBy === undefined || value.groupBy === null
				? undefined
				: sortSpec(value.groupBy, `${where}.groupBy`),
		groupOrder: (value.groupOrder as unknown[] | undefined)?.map((entry) =>
			entry === null ? null : String(entry),
		),
		summaries: stringRecord(value.summaries, `${where}.summaries`),
		settings,
	};
}

/** Parse the YAML of a base. Throws {@link BaseConfigError} when it cannot be used. */
export function parseBaseConfig(source: string): ParsedBase {
	const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
	const [error] = document.errors;
	if (error) throw new BaseConfigError(`Invalid YAML: ${error.message.split("\n")[0]}`);
	const raw: unknown = document.toJS();
	const data =
		raw === null || raw === undefined ? {} : mapping(raw, "A base must be a YAML mapping");
	const warnings: string[] = [];
	for (const key of Object.keys(data)) {
		if (!Object.hasOwn(TOP_LEVEL_KEYS, key)) warnings.push(`Unknown key "${key}"`);
	}
	const displayNames: Record<string, string> = {};
	if (data.properties !== undefined && data.properties !== null) {
		const properties = mapping(data.properties, "properties must be a mapping");
		for (const [property, entry] of Object.entries(properties)) {
			const settings = mapping(entry, `properties.${property} must be a mapping`);
			for (const key of Object.keys(settings)) {
				if (key !== "displayName") warnings.push(`Unknown key "${key}" in properties.${property}`);
			}
			if (settings.displayName !== undefined && settings.displayName !== null) {
				displayNames[property] = String(settings.displayName);
			}
		}
	}
	if (data.views !== undefined && data.views !== null && !Array.isArray(data.views)) {
		throw new BaseConfigError("views must be a list");
	}
	const views = ((data.views as unknown[] | undefined) ?? []).map((view, index) =>
		parseView(view, index, warnings),
	);
	return {
		config: {
			filters:
				data.filters === undefined || data.filters === null
					? undefined
					: parseFilter(data.filters, "filters"),
			formulas: stringRecord(data.formulas, "formulas"),
			displayNames,
			summaries: stringRecord(data.summaries, "summaries"),
			// A base with no views opens as one table of every file, as a new base does.
			views:
				views.length > 0
					? views
					: [
							{
								type: "table",
								name: "Table",
								order: ["file.name"],
								sort: [],
								summaries: {},
								settings: {},
							},
						],
		},
		warnings,
	};
}
