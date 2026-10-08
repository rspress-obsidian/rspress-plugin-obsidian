/**
 * An Excalidraw scene as this feature reads it: the JSON stored in a plain
 * `.excalidraw` file, or in the `## Drawing` section of an Obsidian
 * Excalidraw note, normalised the way Excalidraw's own `restore()` fills in a
 * missing property — so a hand-written or older file renders instead of
 * failing on the first absent field.
 */

export type Point = [number, number];

export interface Roundness {
	type: number;
	value?: number;
}

export interface ImageCrop {
	x: number;
	y: number;
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
}

export interface ExcalidrawElement {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
	strokeColor: string;
	backgroundColor: string;
	fillStyle: string;
	strokeWidth: number;
	strokeStyle: string;
	roughness: number;
	opacity: number;
	seed: number;
	groupIds: string[];
	frameId: string | null;
	roundness: Roundness | null;
	boundElements: { id: string; type: string }[];
	link: string | null;
	isDeleted: boolean;
	// text
	text: string;
	originalText: string;
	fontSize: number;
	fontFamily: number;
	textAlign: string;
	verticalAlign: string;
	containerId: string | null;
	lineHeight: number;
	/** `false`: a text the author sized by hand, wrapped to its width. */
	autoResize: boolean;
	// linear and freedraw
	points: Point[];
	pressures: number[];
	simulatePressure: boolean;
	lastCommittedPoint: Point | null;
	startArrowhead: string | null;
	endArrowhead: string | null;
	elbowed: boolean;
	// image
	fileId: string | null;
	scale: Point;
	crop: ImageCrop | null;
	// frame
	name: string | null;
	customData: Record<string, unknown>;
}

export interface FrameRendering {
	enabled: boolean;
	name: boolean;
	outline: boolean;
	clip: boolean;
}

export interface SceneAppState {
	viewBackgroundColor: string;
	theme: "light" | "dark";
	frameRendering: FrameRendering;
}

export interface BinaryFile {
	mimeType: string;
	dataURL: string;
}

export interface Scene {
	elements: ExcalidrawElement[];
	appState: SceneAppState;
	files: Record<string, BinaryFile>;
}

/** Thrown for a drawing whose scene cannot be read; the message names the problem. */
export class SceneError extends Error {}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function point(value: unknown): Point | null {
	return Array.isArray(value) && value.length >= 2 ? [num(value[0], 0), num(value[1], 0)] : null;
}

function points(value: unknown): Point[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const parsed = point(entry);
		return parsed ? [parsed] : [];
	});
}

/** Excalidraw's own defaults for a property an element leaves out. */
function normalizeElement(raw: unknown, index: number): ExcalidrawElement | undefined {
	if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
	const roundness = isRecord(raw.roundness)
		? {
				type: num(raw.roundness.type, 3),
				...(typeof raw.roundness.value === "number" && { value: raw.roundness.value }),
			}
		: null;
	const crop = isRecord(raw.crop)
		? {
				x: num(raw.crop.x, 0),
				y: num(raw.crop.y, 0),
				width: num(raw.crop.width, 0),
				height: num(raw.crop.height, 0),
				naturalWidth: num(raw.crop.naturalWidth, 1),
				naturalHeight: num(raw.crop.naturalHeight, 1),
			}
		: null;
	const text = str(raw.text, "");
	return {
		id: str(raw.id, `element-${index}`),
		type: raw.type,
		x: num(raw.x, 0),
		y: num(raw.y, 0),
		width: num(raw.width, 0),
		height: num(raw.height, 0),
		angle: num(raw.angle, 0),
		strokeColor: str(raw.strokeColor, "#1e1e1e"),
		backgroundColor: str(raw.backgroundColor, "transparent"),
		fillStyle: str(raw.fillStyle, "solid"),
		strokeWidth: num(raw.strokeWidth, 2),
		strokeStyle: str(raw.strokeStyle, "solid"),
		roughness: num(raw.roughness, 1),
		opacity: num(raw.opacity, 100),
		seed: num(raw.seed, index + 1),
		groupIds: Array.isArray(raw.groupIds)
			? raw.groupIds.filter((id): id is string => typeof id === "string")
			: [],
		frameId: nullableStr(raw.frameId),
		roundness,
		boundElements: Array.isArray(raw.boundElements)
			? raw.boundElements.flatMap((bound) =>
					isRecord(bound) && typeof bound.id === "string"
						? [{ id: bound.id, type: str(bound.type, "") }]
						: [],
				)
			: [],
		link: nullableStr(raw.link),
		isDeleted: raw.isDeleted === true,
		text,
		originalText: str(raw.originalText, text),
		fontSize: num(raw.fontSize, 20),
		fontFamily: num(raw.fontFamily, 1),
		textAlign: str(raw.textAlign, "left"),
		verticalAlign: str(raw.verticalAlign, "top"),
		containerId: nullableStr(raw.containerId),
		lineHeight: num(raw.lineHeight, 1.25),
		// A text written before the key existed grows with its text.
		autoResize: raw.autoResize !== false,
		points: points(raw.points),
		pressures: Array.isArray(raw.pressures) ? raw.pressures.map((value) => num(value, 0.5)) : [],
		simulatePressure: raw.simulatePressure !== false,
		lastCommittedPoint: point(raw.lastCommittedPoint),
		startArrowhead: nullableStr(raw.startArrowhead),
		// An arrow written without the key gets Excalidraw's default head.
		endArrowhead:
			"endArrowhead" in raw ? nullableStr(raw.endArrowhead) : raw.type === "arrow" ? "arrow" : null,
		elbowed: raw.elbowed === true,
		fileId: nullableStr(raw.fileId),
		scale: point(raw.scale) ?? [1, 1],
		crop,
		name: nullableStr(raw.name),
		customData: isRecord(raw.customData) ? raw.customData : {},
	};
}

/**
 * Read a scene from parsed JSON.
 *
 * @throws {SceneError} When the value is not an Excalidraw scene.
 */
export function normalizeScene(json: unknown): Scene {
	if (!isRecord(json) || !Array.isArray(json.elements)) {
		throw new SceneError("the drawing has no `elements` array");
	}
	const appState = isRecord(json.appState) ? json.appState : {};
	const frameRendering = isRecord(appState.frameRendering) ? appState.frameRendering : {};
	const files: Record<string, BinaryFile> = {};
	if (isRecord(json.files)) {
		for (const [id, file] of Object.entries(json.files)) {
			if (isRecord(file) && typeof file.dataURL === "string") {
				files[id] = { mimeType: str(file.mimeType, ""), dataURL: file.dataURL };
			}
		}
	}
	return {
		elements: json.elements.flatMap((raw, index) => normalizeElement(raw, index) ?? []),
		appState: {
			viewBackgroundColor: str(appState.viewBackgroundColor, "#ffffff"),
			theme: appState.theme === "dark" ? "dark" : "light",
			frameRendering: {
				enabled: frameRendering.enabled !== false,
				name: frameRendering.name !== false,
				outline: frameRendering.outline !== false,
				clip: frameRendering.clip !== false,
			},
		},
		files,
	};
}

/**
 * Parse scene JSON text (a plain `.excalidraw` file).
 *
 * @throws {SceneError} When the text is not JSON or not a scene.
 */
export function parseSceneJson(text: string): Scene {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new SceneError(
			`the drawing is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return normalizeScene(json);
}
