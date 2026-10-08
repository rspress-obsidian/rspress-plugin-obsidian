/**
 * Where elements are, as Excalidraw measures them (`element/bounds.ts`): the
 * export's viewBox is the union of these bounds, and a `#^id` embed crops to
 * one element's.
 */
import type { Op } from "roughjs/bin/core";
import type { ExcalidrawElement, Point } from "./scene.js";
import { rotatePoint, shaftOps } from "./shapes.js";

/** `[minX, minY, maxX, maxY]`. */
export type Bounds = [number, number, number, number];

/** `[x1, y1, x2, y2, cx, cy]`: an element's unrotated box and its centre. */
export type Coords = [number, number, number, number, number, number];

export type ElementsById = ReadonlyMap<string, ExcalidrawElement>;

function pointsBounds(points: readonly Point[]): Bounds {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of points) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return points.length > 0 ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

/** Extremes of a cubic Bézier along one axis (`solveQuadratic`). */
function cubicExtremes(p0: number, p1: number, p2: number, p3: number): number[] {
	const i = p1 - p0;
	const j = p2 - p1;
	const k = p3 - p2;
	const a = 3 * i - 6 * j + 3 * k;
	const b = 6 * j - 6 * i;
	const c = 3 * i;
	const discriminant = b * b - 4 * a * c;
	if (discriminant < 0) return [];
	const roots =
		a === 0
			? [-c / b]
			: [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)];
	return roots
		.filter((t) => t >= 0 && t <= 1)
		.map(
			(t) =>
				(1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3,
		);
}

/** Bounds of the Bézier segments of a curve (`getMinMaxXYFromCurvePathOps`). */
function curveBounds(ops: readonly Op[], transform: (point: Point) => Point): Bounds {
	let current: Point = [0, 0];
	const xs: number[] = [];
	const ys: number[] = [];
	for (const { op, data } of ops) {
		if (op === "move") {
			current = [data[0] ?? 0, data[1] ?? 0];
		} else if (op === "bcurveTo") {
			const [p0, p1, p2, p3] = [
				current,
				[data[0] ?? 0, data[1] ?? 0] as Point,
				[data[2] ?? 0, data[3] ?? 0] as Point,
				[data[4] ?? 0, data[5] ?? 0] as Point,
			].map(transform) as [Point, Point, Point, Point];
			current = [data[4] ?? 0, data[5] ?? 0];
			xs.push(p0[0], p3[0], ...cubicExtremes(p0[0], p1[0], p2[0], p3[0]));
			ys.push(p0[1], p3[1], ...cubicExtremes(p0[1], p1[1], p2[1], p3[1]));
		}
	}
	return xs.length > 0
		? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
		: [0, 0, 0, 0];
}

const LINEAR: Record<string, true> = { line: true, arrow: true };

/** The box of a linear element: its drawn curve, not just its points. */
function linearCoords(element: ExcalidrawElement): Coords {
	const [minX, minY, maxX, maxY] =
		element.points.length < 2
			? pointsBounds(element.points)
			: curveBounds(shaftOps(element), (point) => point);
	const x1 = minX + element.x;
	const y1 = minY + element.y;
	const x2 = maxX + element.x;
	const y2 = maxY + element.y;
	return [x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2];
}

/** A point of a linear element in scene coordinates, rotation applied. */
export function linearPointInScene(element: ExcalidrawElement, point: Point): Point {
	const [, , , , cx, cy] = linearCoords(element);
	return rotatePoint([element.x + point[0], element.y + point[1]], [cx, cy], element.angle);
}

/**
 * Top-left of a label bound to an arrow: centred on the middle point, or on
 * the middle of the middle segment (`getBoundTextElementPosition`).
 */
export function arrowLabelPosition(arrow: ExcalidrawElement, label: ExcalidrawElement): Point {
	const count = arrow.points.length;
	let middle: Point;
	if (count % 2 === 1) {
		middle = linearPointInScene(arrow, arrow.points[Math.floor(count / 2)] as Point);
	} else {
		const a = linearPointInScene(arrow, arrow.points[count / 2 - 1] ?? [0, 0]);
		const b = linearPointInScene(arrow, arrow.points[count / 2] ?? [0, 0]);
		middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	}
	return [middle[0] - label.width / 2, middle[1] - label.height / 2];
}

/** An element's unrotated box and centre (`getElementAbsoluteCoords`). */
export function elementCoords(element: ExcalidrawElement, elements: ElementsById): Coords {
	if (element.type === "freedraw") {
		const [minX, minY, maxX, maxY] = pointsBounds(element.points);
		const x1 = minX + element.x;
		const y1 = minY + element.y;
		const x2 = maxX + element.x;
		const y2 = maxY + element.y;
		return [x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2];
	}
	if (LINEAR[element.type]) return linearCoords(element);
	const container = element.containerId ? elements.get(element.containerId) : undefined;
	const [x, y] =
		element.type === "text" && container?.type === "arrow"
			? arrowLabelPosition(container, element)
			: [element.x, element.y];
	return [
		x,
		y,
		x + element.width,
		y + element.height,
		x + element.width / 2,
		y + element.height / 2,
	];
}

/** An element's axis-aligned bounds with its rotation applied (`ElementBounds.calculateBounds`). */
export function elementBounds(element: ExcalidrawElement, elements: ElementsById): Bounds {
	const [x1, y1, x2, y2, cx, cy] = elementCoords(element, elements);
	const centre: Point = [cx, cy];
	if (element.type === "freedraw") {
		const [minX, minY, maxX, maxY] = pointsBounds(
			element.points.map((point) =>
				rotatePoint(point, [cx - element.x, cy - element.y], element.angle),
			),
		);
		return [minX + element.x, minY + element.y, maxX + element.x, maxY + element.y];
	}
	if (LINEAR[element.type]) {
		if (element.points.length < 2) {
			const [px, py] = element.points[0] ?? [0, 0];
			const [x, y] = rotatePoint([element.x + px, element.y + py], centre, element.angle);
			return [x, y, x, y];
		}
		const bounds = curveBounds(shaftOps(element), ([x, y]) =>
			rotatePoint([element.x + x, element.y + y], centre, element.angle),
		);
		const label = element.boundElements.find((bound) => bound.type === "text");
		const text = label ? elements.get(label.id) : undefined;
		if (!text || text.isDeleted) return bounds;
		const [lx, ly] = arrowLabelPosition(element, text);
		return [
			Math.min(bounds[0], lx),
			Math.min(bounds[1], ly),
			Math.max(bounds[2], lx + text.width),
			Math.max(bounds[3], ly + text.height),
		];
	}
	if (element.type === "ellipse") {
		const w = (x2 - x1) / 2;
		const h = (y2 - y1) / 2;
		const cos = Math.cos(element.angle);
		const sin = Math.sin(element.angle);
		const ww = Math.hypot(w * cos, h * sin);
		const hh = Math.hypot(h * cos, w * sin);
		return [cx - ww, cy - hh, cx + ww, cy + hh];
	}
	const corners: Point[] =
		element.type === "diamond"
			? [
					[cx, y1],
					[cx, y2],
					[x1, cy],
					[x2, cy],
				]
			: [
					[x1, y1],
					[x1, y2],
					[x2, y2],
					[x2, y1],
				];
	return pointsBounds(corners.map((corner) => rotatePoint(corner, centre, element.angle)));
}

/** The union of the elements' bounds (`getCommonBounds`). */
export function commonBounds(elements: readonly ExcalidrawElement[], byId: ElementsById): Bounds {
	if (elements.length === 0) return [0, 0, 0, 0];
	const all = elements.map((element) => elementBounds(element, byId));
	return [
		Math.min(...all.map((bounds) => bounds[0])),
		Math.min(...all.map((bounds) => bounds[1])),
		Math.max(...all.map((bounds) => bounds[2])),
		Math.max(...all.map((bounds) => bounds[3])),
	];
}
