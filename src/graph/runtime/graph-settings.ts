/**
 * Obsidian's Display and Forces graph settings, with the ranges the panel's
 * sliders offer. Kept apart from the panel so the view, the panel and the
 * storage reader share one definition.
 */
export interface GraphDisplaySettings {
	/** Draw an arrowhead at each link's target. @default false */
	arrows: boolean;
	/**
	 * Zoom bias for labels, -3…3: higher shows labels from further out. At 0 a
	 * label is fully shown from 1.4× zoom.
	 */
	textFadeThreshold: number;
	/** Node radius multiplier, 0.25…3. Nodes also grow with their link count. */
	nodeSize: number;
	/** Link width multiplier, 0.25…3. */
	linkThickness: number;
}

export interface GraphForceSettings {
	/**
	 * Pull toward the middle, 0…1. Unlinked nodes and separate clusters would
	 * otherwise drift off under the repel force.
	 */
	centerStrength: number;
	/** How strongly nodes push apart, 0…20. */
	repelStrength: number;
	/** How strongly links pull their ends together, 0…1. */
	linkStrength: number;
	/** Resting link length in graph units, 10…200. */
	linkDistance: number;
}

export interface SliderRange {
	min: number;
	max: number;
	step: number;
}

export const DISPLAY_RANGES: Record<Exclude<keyof GraphDisplaySettings, "arrows">, SliderRange> = {
	textFadeThreshold: { min: -3, max: 3, step: 0.5 },
	nodeSize: { min: 0.25, max: 3, step: 0.25 },
	linkThickness: { min: 0.25, max: 3, step: 0.25 },
};

export const FORCE_RANGES: Record<keyof GraphForceSettings, SliderRange> = {
	centerStrength: { min: 0, max: 1, step: 0.05 },
	repelStrength: { min: 0, max: 20, step: 1 },
	linkStrength: { min: 0, max: 1, step: 0.05 },
	linkDistance: { min: 10, max: 200, step: 5 },
};

export const DEFAULT_DISPLAY_SETTINGS: Readonly<GraphDisplaySettings> = Object.freeze({
	arrows: false,
	textFadeThreshold: 0,
	nodeSize: 1,
	linkThickness: 1,
});

/**
 * Defaults keep the panel's original link physics (charge -150, distance 45)
 * and add a gentle pull to the middle.
 */
export const DEFAULT_FORCE_SETTINGS: Readonly<GraphForceSettings> = Object.freeze({
	centerStrength: 0.3,
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 45,
});

/** d3 charge strength per point of the "Repel force" slider. */
export const CHARGE_PER_REPEL = -15;

/** Velocity pulled toward the origin per tick at full "Center force". */
export const MAX_CENTER_PULL = 0.1;

/** The zoom at which labels are fully opaque for a given threshold. */
export function labelZoomFor(threshold: number): number {
	return 1.4 / 2 ** threshold;
}

function clampTo(value: unknown, range: SliderRange, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(range.max, Math.max(range.min, value))
		: fallback;
}

/** Stored display settings, each field validated and clamped; anything else falls back. */
export function readDisplaySettings(value: unknown): GraphDisplaySettings {
	const stored: Record<string, unknown> = value && typeof value === "object" ? { ...value } : {};
	return {
		arrows: typeof stored.arrows === "boolean" ? stored.arrows : DEFAULT_DISPLAY_SETTINGS.arrows,
		textFadeThreshold: clampTo(
			stored.textFadeThreshold,
			DISPLAY_RANGES.textFadeThreshold,
			DEFAULT_DISPLAY_SETTINGS.textFadeThreshold,
		),
		nodeSize: clampTo(stored.nodeSize, DISPLAY_RANGES.nodeSize, DEFAULT_DISPLAY_SETTINGS.nodeSize),
		linkThickness: clampTo(
			stored.linkThickness,
			DISPLAY_RANGES.linkThickness,
			DEFAULT_DISPLAY_SETTINGS.linkThickness,
		),
	};
}

/** Stored force settings, each field validated and clamped; anything else falls back. */
export function readForceSettings(value: unknown): GraphForceSettings {
	const stored: Record<string, unknown> = value && typeof value === "object" ? { ...value } : {};
	const read = (key: keyof GraphForceSettings) =>
		clampTo(stored[key], FORCE_RANGES[key], DEFAULT_FORCE_SETTINGS[key]);
	return {
		centerStrength: read("centerStrength"),
		repelStrength: read("repelStrength"),
		linkStrength: read("linkStrength"),
		linkDistance: read("linkDistance"),
	};
}
