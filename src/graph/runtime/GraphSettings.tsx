import type { CSSProperties, ReactNode } from "react";
import { type GraphScope, MAX_DEPTH } from "./deriveGraphViewData.js";
import {
	DISPLAY_RANGES,
	FORCE_RANGES,
	type GraphDisplaySettings,
	type GraphForceSettings,
	type SliderRange,
} from "./graph-settings.js";
import { FONT_STACK } from "./palette/colors.js";

/** The persisted filter toggles — everything in Filters except the search text. */
export interface GraphFilterSettings {
	scope: GraphScope;
	depth: number;
	incoming: boolean;
	outgoing: boolean;
	neighborLinks: boolean;
	showTags: boolean;
	showAttachments: boolean;
	existingOnly: boolean;
	showOrphans: boolean;
}

interface GraphSettingsProps {
	filters: GraphFilterSettings;
	onFiltersChange: (next: GraphFilterSettings) => void;
	display: GraphDisplaySettings;
	onDisplayChange: (next: GraphDisplaySettings) => void;
	forces: GraphForceSettings;
	onForcesChange: (next: GraphForceSettings) => void;
	onAnimate: () => void;
	isAnimating: boolean;
	onReset: () => void;
}

const TEXT: CSSProperties = {
	fontSize: 11,
	fontFamily: FONT_STACK,
	color: "var(--rp-c-text-1, #1f2937)",
};

const SECTION: CSSProperties = {
	border: "none",
	margin: 0,
	padding: "6px 0",
	borderTop: "1px solid var(--rp-c-divider, #e2e8f0)",
	display: "flex",
	flexDirection: "column",
	gap: 4,
};

const LEGEND: CSSProperties = {
	...TEXT,
	padding: 0,
	fontWeight: 600,
	textTransform: "uppercase",
	letterSpacing: "0.04em",
	fontSize: 10,
	marginBottom: 2,
};

const BUTTON: CSSProperties = {
	...TEXT,
	border: "1px solid var(--rp-c-divider, #cbd5e1)",
	borderRadius: 4,
	padding: "1px 8px",
	background: "transparent",
	cursor: "pointer",
};

function Toggle({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label style={{ ...TEXT, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			{label}
		</label>
	);
}

function Slider({
	label,
	value,
	range,
	onChange,
}: {
	label: string;
	value: number;
	range: SliderRange;
	onChange: (value: number) => void;
}) {
	return (
		<label style={{ ...TEXT, display: "grid", gridTemplateColumns: "1fr auto", gap: "0 6px" }}>
			<span>{label}</span>
			<output style={{ fontVariantNumeric: "tabular-nums" }}>{value}</output>
			<input
				type="range"
				min={range.min}
				max={range.max}
				step={range.step}
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
				style={{ gridColumn: "1 / -1", width: "100%" }}
			/>
		</label>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<fieldset style={SECTION}>
			<legend style={LEGEND}>{title}</legend>
			{children}
		</fieldset>
	);
}

/**
 * Obsidian's graph settings drawer: Filters, Display and Forces. Groups are a
 * plugin option (`groups`) rather than a reader setting, because they describe
 * the site's own taxonomy.
 */
export default function GraphSettings({
	filters,
	onFiltersChange,
	display,
	onDisplayChange,
	forces,
	onForcesChange,
	onAnimate,
	isAnimating,
	onReset,
}: GraphSettingsProps) {
	const setFilter = <K extends keyof GraphFilterSettings>(key: K, value: GraphFilterSettings[K]) =>
		onFiltersChange({ ...filters, [key]: value });
	const isLocal = filters.scope === "local";

	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			<Section title="Filters">
				{/* Local is the neighborhood of the current page; global is the whole
				    site with the current page highlighted. */}
				<div role="group" aria-label="Graph scope" style={{ display: "flex", gap: 4 }}>
					{(["local", "global"] as const).map((value) => (
						<button
							key={value}
							type="button"
							aria-label={`${value === "local" ? "Local" : "Global"} graph`}
							aria-pressed={filters.scope === value}
							onClick={() => setFilter("scope", value)}
							style={{
								...BUTTON,
								fontWeight: filters.scope === value ? 600 : 400,
								background:
									filters.scope === value
										? "color-mix(in srgb, var(--rp-c-brand, #3b82f6) 18%, transparent)"
										: "transparent",
							}}
						>
							{value === "local" ? "Local" : "Global"}
						</button>
					))}
				</div>
				{/* Depth and link directions shape the local neighborhood only. */}
				<div
					hidden={!isLocal}
					style={{ display: isLocal ? "flex" : "none", flexDirection: "column", gap: 4 }}
				>
					<div
						role="group"
						aria-label="Neighborhood depth"
						hidden={!isLocal}
						style={{ ...TEXT, display: "flex", alignItems: "center", gap: 6 }}
					>
						<span>Depth</span>
						<button
							type="button"
							aria-label="Decrease depth"
							disabled={filters.depth <= 1}
							onClick={() => setFilter("depth", Math.max(1, filters.depth - 1))}
							style={BUTTON}
						>
							−
						</button>
						<span aria-live="polite" style={{ minWidth: 12, textAlign: "center" }}>
							{filters.depth}
						</span>
						<button
							type="button"
							aria-label="Increase depth"
							disabled={filters.depth >= MAX_DEPTH}
							onClick={() => setFilter("depth", Math.min(MAX_DEPTH, filters.depth + 1))}
							style={BUTTON}
						>
							+
						</button>
					</div>
					<Toggle
						label="Incoming links"
						checked={filters.incoming}
						onChange={(value) => setFilter("incoming", value)}
					/>
					<Toggle
						label="Outgoing links"
						checked={filters.outgoing}
						onChange={(value) => setFilter("outgoing", value)}
					/>
					<Toggle
						label="Neighbor links"
						checked={filters.neighborLinks}
						onChange={(value) => setFilter("neighborLinks", value)}
					/>
				</div>
				<Toggle
					label="Tags"
					checked={filters.showTags}
					onChange={(value) => setFilter("showTags", value)}
				/>
				<Toggle
					label="Attachments"
					checked={filters.showAttachments}
					onChange={(value) => setFilter("showAttachments", value)}
				/>
				<Toggle
					label="Existing files only"
					checked={filters.existingOnly}
					onChange={(value) => setFilter("existingOnly", value)}
				/>
				<Toggle
					label="Orphans"
					checked={filters.showOrphans}
					onChange={(value) => setFilter("showOrphans", value)}
				/>
			</Section>

			<Section title="Display">
				<Toggle
					label="Arrows"
					checked={display.arrows}
					onChange={(arrows) => onDisplayChange({ ...display, arrows })}
				/>
				<Slider
					label="Text fade threshold"
					value={display.textFadeThreshold}
					range={DISPLAY_RANGES.textFadeThreshold}
					onChange={(textFadeThreshold) => onDisplayChange({ ...display, textFadeThreshold })}
				/>
				<Slider
					label="Node size"
					value={display.nodeSize}
					range={DISPLAY_RANGES.nodeSize}
					onChange={(nodeSize) => onDisplayChange({ ...display, nodeSize })}
				/>
				<Slider
					label="Link thickness"
					value={display.linkThickness}
					range={DISPLAY_RANGES.linkThickness}
					onChange={(linkThickness) => onDisplayChange({ ...display, linkThickness })}
				/>
				<button type="button" onClick={onAnimate} disabled={isAnimating} style={BUTTON}>
					{isAnimating ? "Animating…" : "Animate"}
				</button>
			</Section>

			<Section title="Forces">
				<Slider
					label="Center force"
					value={forces.centerStrength}
					range={FORCE_RANGES.centerStrength}
					onChange={(centerStrength) => onForcesChange({ ...forces, centerStrength })}
				/>
				<Slider
					label="Repel force"
					value={forces.repelStrength}
					range={FORCE_RANGES.repelStrength}
					onChange={(repelStrength) => onForcesChange({ ...forces, repelStrength })}
				/>
				<Slider
					label="Link force"
					value={forces.linkStrength}
					range={FORCE_RANGES.linkStrength}
					onChange={(linkStrength) => onForcesChange({ ...forces, linkStrength })}
				/>
				<Slider
					label="Link distance"
					value={forces.linkDistance}
					range={FORCE_RANGES.linkDistance}
					onChange={(linkDistance) => onForcesChange({ ...forces, linkDistance })}
				/>
			</Section>

			<button
				type="button"
				onClick={onReset}
				style={{ ...BUTTON, alignSelf: "flex-start", marginTop: 4 }}
			>
				Restore defaults
			</button>
		</div>
	);
}
