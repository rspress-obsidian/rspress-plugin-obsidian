/**
 * The hand-drawn strokes, generated the way Excalidraw generates them
 * (`scene/Shape.ts`, `element/bounds.ts` in `@excalidraw/excalidraw`): the same
 * roughjs calls with the same options and each element's own `seed`, so a
 * rectangle wobbles exactly as it does in Obsidian. roughjs's generator is
 * pure geometry — no DOM — so it runs at build time.
 */
import { getStroke } from "perfect-freehand";
import rough from "roughjs";
import type { Drawable, Op, Options } from "roughjs/bin/core";
import { escapeHtmlAttribute } from "../../../shared/escape.js";
import type { ExcalidrawElement, Point } from "./scene.js";

/** Excalidraw writes SVG numbers with two decimals (`MAX_DECIMALS_FOR_SVG_EXPORT`). */
const PRECISION = 2;
/** `LINE_CONFIRM_THRESHOLD`: a line whose ends meet this closely is a closed shape. */
const LOOP_THRESHOLD = 8;
const PROPORTIONAL_RADIUS = 0.25;
const ADAPTIVE_RADIUS = 32;
const ROUNDNESS_LEGACY = 1;
const ROUNDNESS_PROPORTIONAL = 2;
const ROUNDNESS_ADAPTIVE = 3;

const generator = rough.generator();

export function isTransparent(color: string): boolean {
	return (
		color === "transparent" ||
		(color.length === 5 && color[4] === "0") ||
		(color.length === 9 && color.slice(7, 9) === "00")
	);
}

export function rotatePoint([x, y]: Point, [cx, cy]: Point, angle: number): Point {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return [(x - cx) * cos - (y - cy) * sin + cx, (x - cx) * sin + (y - cy) * cos + cy];
}

export function isPathALoop(points: readonly Point[]): boolean {
	const first = points[0];
	const last = points.at(-1);
	return (
		points.length >= 3 &&
		first !== undefined &&
		last !== undefined &&
		Math.hypot(first[0] - last[0], first[1] - last[1]) <= LOOP_THRESHOLD
	);
}

/** Excalidraw's corner radius for a side of length `size` (`getCornerRadius`). */
export function cornerRadius(size: number, element: ExcalidrawElement): number {
	const type = element.roundness?.type;
	if (type === ROUNDNESS_PROPORTIONAL || type === ROUNDNESS_LEGACY) {
		return size * PROPORTIONAL_RADIUS;
	}
	if (type === ROUNDNESS_ADAPTIVE) {
		const fixed = element.roundness?.value ?? ADAPTIVE_RADIUS;
		return size <= fixed / PROPORTIONAL_RADIUS ? size * PROPORTIONAL_RADIUS : fixed;
	}
	return 0;
}

const ROUNDABLE_TYPES: Record<string, true> = {
	rectangle: true,
	iframe: true,
	embeddable: true,
	line: true,
	diamond: true,
	image: true,
};

const LINEAR_TYPES: Record<string, true> = { line: true, arrow: true };

/** Small shapes get less wobble, or they would be unrecognisable (`adjustRoughness`). */
function adjustRoughness(element: ExcalidrawElement): number {
	const max = Math.max(element.width, element.height);
	const min = Math.min(element.width, element.height);
	if (
		(min >= 20 && max >= 50) ||
		(min >= 15 && element.roundness && ROUNDABLE_TYPES[element.type]) ||
		(LINEAR_TYPES[element.type] && max >= 50)
	) {
		return element.roughness;
	}
	return Math.min(element.roughness / (max < 10 ? 3 : 2), 2.5);
}

export function dashArray(strokeStyle: string, strokeWidth: number): number[] | undefined {
	if (strokeStyle === "dashed") return [8, 8 + strokeWidth];
	if (strokeStyle === "dotted") return [1.5, 6 + strokeWidth];
	return undefined;
}

/** Excalidraw's roughjs options for an element (`generateRoughOptions`). */
export function roughOptions(element: ExcalidrawElement, continuousPath = false): Options {
	const options: Options = {
		seed: element.seed,
		strokeLineDash: dashArray(element.strokeStyle, element.strokeWidth),
		// Overlaid dashes from a second stroke would blur the pattern.
		disableMultiStroke: element.strokeStyle !== "solid",
		strokeWidth: element.strokeStyle !== "solid" ? element.strokeWidth + 0.5 : element.strokeWidth,
		fillWeight: element.strokeWidth / 2,
		hachureGap: element.strokeWidth * 4,
		roughness: adjustRoughness(element),
		stroke: element.strokeColor,
		preserveVertices: continuousPath || element.roughness < 2,
	};
	switch (element.type) {
		case "rectangle":
		case "iframe":
		case "embeddable":
		case "diamond":
		case "ellipse":
			options.fillStyle = element.fillStyle;
			options.fill = isTransparent(element.backgroundColor) ? undefined : element.backgroundColor;
			if (element.type === "ellipse") options.curveFitting = 1;
			return options;
		case "line":
		case "freedraw":
			if (isPathALoop(element.points)) {
				options.fillStyle = element.fillStyle;
				options.fill =
					element.backgroundColor === "transparent" ? undefined : element.backgroundColor;
			}
			return options;
		default:
			return options;
	}
}

/** The four corners of a diamond, relative to its box (`getDiamondPoints`). */
export function diamondPoints(element: ExcalidrawElement): Point[] {
	const topX = Math.floor(element.width / 2) + 1;
	const sideY = Math.floor(element.height / 2) + 1;
	return [
		[topX, 0],
		[element.width, sideY],
		[topX, element.height],
		[0, sideY],
	];
}

/** Excalidraw's placeholder look for an embed it does not render live. */
function asEmbeddablePlaceholder(element: ExcalidrawElement): ExcalidrawElement {
	if (element.type === "iframe") {
		return {
			...element,
			strokeColor: isTransparent(element.strokeColor) ? "#000000" : element.strokeColor,
			backgroundColor: isTransparent(element.backgroundColor) ? "#f4f4f6" : element.backgroundColor,
		};
	}
	if (isTransparent(element.backgroundColor) && isTransparent(element.strokeColor)) {
		return { ...element, roughness: 0, backgroundColor: "#d3d3d3", fillStyle: "solid" };
	}
	return element;
}

/** Whether a segment runs sideways (`vectorToHeading` is left or right). */
function headingIsHorizontal([x, y]: Point): boolean {
	const absY = Math.abs(y);
	return x > absY || x <= -absY;
}

/** The rounded-corner path of an elbow arrow (`generateElbowArrowShape`). */
function elbowArrowPath(points: readonly Point[], radius: number): string {
	const sub: Point[] = [];
	for (let i = 1; i < points.length - 1; i += 1) {
		const prev = points[i - 1] as Point;
		const point = points[i] as Point;
		const next = points[i + 1] as Point;
		const corner = Math.min(
			radius,
			Math.hypot(next[0] - point[0], next[1] - point[1]) / 2,
			Math.hypot(prev[0] - point[0], prev[1] - point[1]) / 2,
		);
		const offset = (towards: Point, horizontal: boolean): Point =>
			horizontal
				? [point[0] + (towards[0] < point[0] ? -corner : corner), point[1]]
				: [point[0], point[1] + (towards[1] < point[1] ? -corner : corner)];
		sub.push(offset(prev, headingIsHorizontal([point[0] - prev[0], point[1] - prev[1]])));
		sub.push(point);
		sub.push(offset(next, headingIsHorizontal([next[0] - point[0], next[1] - point[1]])));
	}
	const first = points[0] ?? [0, 0];
	const last = points.at(-1) ?? first;
	const d = [`M ${first[0]} ${first[1]}`];
	for (let i = 0; i + 2 < sub.length; i += 3) {
		const [a, b, c] = [sub[i] as Point, sub[i + 1] as Point, sub[i + 2] as Point];
		d.push(`L ${a[0]} ${a[1]}`, `Q ${b[0]} ${b[1]}, ${c[0]} ${c[1]}`);
	}
	d.push(`L ${last[0]} ${last[1]}`);
	return d.join(" ");
}

/** The ops of a shape's outline: its `path` set, as Excalidraw reads it. */
function curveOps(drawable: Drawable | undefined): Op[] {
	if (!drawable) return [];
	return (drawable.sets.find((set) => set.type === "path") ?? drawable.sets[0])?.ops ?? [];
}

function arrowheadSize(arrowhead: string): number {
	if (arrowhead === "arrow") return 25;
	if (arrowhead === "diamond" || arrowhead === "diamond_outline") return 12;
	if (arrowhead.startsWith("crowfoot")) return 20;
	return 15;
}

function arrowheadAngle(arrowhead: string): number {
	if (arrowhead === "bar") return 90;
	if (arrowhead === "arrow") return 20;
	return 25;
}

/** The points of an arrowhead along the drawn curve (`getArrowheadPoints`). */
function arrowheadPoints(
	element: ExcalidrawElement,
	shaft: Drawable | undefined,
	position: "start" | "end",
	arrowhead: string,
): number[] | null {
	const ops = curveOps(shaft);
	if (ops.length < 2) return null;
	const index = position === "start" ? 1 : ops.length - 1;
	const data = ops[index]?.data ?? [];
	if (data.length !== 6) return null;
	const p3: Point = [data[4] as number, data[5] as number];
	const p2: Point = [data[2] as number, data[3] as number];
	const p1: Point = [data[0] as number, data[1] as number];
	const previous = ops[index - 1];
	let p0: Point = [0, 0];
	if (previous?.op === "move") p0 = [previous.data[0] as number, previous.data[1] as number];
	else if (previous?.op === "bcurveTo")
		p0 = [previous.data[4] as number, previous.data[5] as number];
	const at = (t: number, i: 0 | 1): number =>
		(1 - t) ** 3 * p3[i] +
		3 * t * (1 - t) ** 2 * p2[i] +
		3 * t ** 2 * (1 - t) * p1[i] +
		p0[i] * t ** 3;
	const [x2, y2] = position === "start" ? p0 : p3;
	const [x1, y1] = [at(0.3, 0), at(0.3, 1)];
	const distance = Math.hypot(x2 - x1, y2 - y1);
	const nx = (x2 - x1) / distance;
	const ny = (y2 - y1) / distance;
	const tip = position === "end" ? element.points.at(-1) : element.points[0];
	const before =
		element.points.length > 1
			? position === "end"
				? element.points.at(-2)
				: element.points[1]
			: ([0, 0] as Point);
	const length = tip && before ? Math.hypot(tip[0] - before[0], tip[1] - before[1]) : 0;
	const multiplier = arrowhead === "diamond" || arrowhead === "diamond_outline" ? 0.25 : 0.5;
	const minSize = Math.min(arrowheadSize(arrowhead), length * multiplier);
	const xs = x2 - nx * minSize;
	const ys = y2 - ny * minSize;
	if (arrowhead === "dot" || arrowhead === "circle" || arrowhead === "circle_outline") {
		return [x2, y2, Math.hypot(ys - y2, xs - x2) + element.strokeWidth - 2];
	}
	const angle = (arrowheadAngle(arrowhead) * Math.PI) / 180;
	if (arrowhead === "crowfoot_many" || arrowhead === "crowfoot_one_or_many") {
		const [x3, y3] = rotatePoint([x2, y2], [xs, ys], -angle);
		const [x4, y4] = rotatePoint([x2, y2], [xs, ys], angle);
		return [xs, ys, x3, y3, x4, y4];
	}
	const [x3, y3] = rotatePoint([xs, ys], [x2, y2], -angle);
	const [x4, y4] = rotatePoint([xs, ys], [x2, y2], angle);
	if (arrowhead === "diamond" || arrowhead === "diamond_outline") {
		const neighbour = (before ?? [0, 0]) as Point;
		const [ox, oy] =
			position === "start"
				? rotatePoint(
						[x2 + minSize * 2, y2],
						[x2, y2],
						Math.atan2(neighbour[1] - y2, neighbour[0] - x2),
					)
				: rotatePoint(
						[x2 - minSize * 2, y2],
						[x2, y2],
						Math.atan2(y2 - neighbour[1], x2 - neighbour[0]),
					);
		return [x2, y2, x3, y3, ox, oy, x4, y4];
	}
	return [x2, y2, x3, y3, x4, y4];
}

/** An arrowhead's strokes (`getArrowheadShapes`). */
function arrowheadDrawables(
	element: ExcalidrawElement,
	shaft: Drawable | undefined,
	position: "start" | "end",
	arrowhead: string,
	options: Options,
	canvasBackground: string,
): Drawable[] {
	const points = arrowheadPoints(element, shaft, position, arrowhead);
	if (!points) return [];
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = points;
	const { strokeLineDash: _dash, ...solid } = options;
	const outline = arrowhead.endsWith("_outline");
	switch (arrowhead) {
		case "dot":
		case "circle":
		case "circle_outline":
			return [
				generator.circle(a, b, c, {
					...solid,
					fill: outline ? canvasBackground : element.strokeColor,
					fillStyle: "solid",
					stroke: element.strokeColor,
					roughness: Math.min(0.5, options.roughness ?? 0),
				}),
			];
		case "triangle":
		case "triangle_outline":
			return [
				generator.polygon(
					[
						[a, b],
						[c, d],
						[e, f],
						[a, b],
					],
					{
						...solid,
						fill: outline ? canvasBackground : element.strokeColor,
						fillStyle: "solid",
						roughness: Math.min(1, options.roughness ?? 0),
					},
				),
			];
		case "diamond":
		case "diamond_outline":
			return [
				generator.polygon(
					[
						[a, b],
						[c, d],
						[e, f],
						[g, h],
						[a, b],
					],
					{
						...solid,
						fill: outline ? canvasBackground : element.strokeColor,
						fillStyle: "solid",
						roughness: Math.min(1, options.roughness ?? 0),
					},
				),
			];
		case "crowfoot_one":
			return [generator.line(c, d, e, f, solid)];
		default: {
			const dotted = dashArray("dotted", element.strokeWidth - 1) ?? [];
			const headOptions: Options = {
				...solid,
				...(element.strokeStyle === "dotted" && {
					strokeLineDash: [dotted[0] ?? 0, (dotted[1] ?? 1) - 1],
				}),
				roughness: Math.min(1, options.roughness ?? 0),
			};
			const strokes = [
				generator.line(c, d, a, b, headOptions),
				generator.line(e, f, a, b, headOptions),
			];
			if (arrowhead === "crowfoot_one_or_many") {
				const one = arrowheadPoints(element, shaft, position, "crowfoot_one");
				if (one)
					strokes.push(
						generator.line(one[2] ?? 0, one[3] ?? 0, one[4] ?? 0, one[5] ?? 0, headOptions),
					);
			}
			return strokes;
		}
	}
}

/**
 * The roughjs drawables of an element, in its own coordinates (the origin is
 * its `x`/`y`), exactly as `_generateElementShape` builds them. Text, images
 * and frames have none; freedraw has only its closed-loop fill.
 */
export function elementDrawables(element: ExcalidrawElement, canvasBackground: string): Drawable[] {
	switch (element.type) {
		case "rectangle":
		case "iframe":
		case "embeddable": {
			const shaped = element.type === "rectangle" ? element : asEmbeddablePlaceholder(element);
			if (element.roundness) {
				const w = element.width;
				const h = element.height;
				const r = cornerRadius(Math.min(w, h), element);
				return [
					generator.path(
						`M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`,
						roughOptions(shaped, true),
					),
				];
			}
			return [generator.rectangle(0, 0, element.width, element.height, roughOptions(shaped))];
		}
		case "diamond": {
			const [top, right, bottom, left] = diamondPoints(element) as [Point, Point, Point, Point];
			if (element.roundness) {
				const v = cornerRadius(Math.abs(top[0] - left[0]), element);
				const hr = cornerRadius(Math.abs(right[1] - top[1]), element);
				return [
					generator.path(
						`M ${top[0] + v} ${top[1] + hr} L ${right[0] - v} ${right[1] - hr}
            C ${right[0]} ${right[1]}, ${right[0]} ${right[1]}, ${right[0] - v} ${right[1] + hr}
            L ${bottom[0] + v} ${bottom[1] - hr}
            C ${bottom[0]} ${bottom[1]}, ${bottom[0]} ${bottom[1]}, ${bottom[0] - v} ${bottom[1] - hr}
            L ${left[0] + v} ${left[1] + hr}
            C ${left[0]} ${left[1]}, ${left[0]} ${left[1]}, ${left[0] + v} ${left[1] - hr}
            L ${top[0] - v} ${top[1] + hr}
            C ${top[0]} ${top[1]}, ${top[0]} ${top[1]}, ${top[0] + v} ${top[1] + hr}`,
						roughOptions(element, true),
					),
				];
			}
			return [generator.polygon([top, right, bottom, left], roughOptions(element))];
		}
		case "ellipse":
			return [
				generator.ellipse(
					element.width / 2,
					element.height / 2,
					element.width,
					element.height,
					roughOptions(element),
				),
			];
		case "line":
		case "arrow": {
			const options = roughOptions(element);
			const points: Point[] = element.points.length > 0 ? element.points : [[0, 0]];
			let shaft: Drawable;
			if (element.type === "arrow" && element.elbowed) {
				shaft = generator.path(elbowArrowPath(points, 16), roughOptions(element, true));
			} else if (!element.roundness) {
				shaft = options.fill
					? generator.polygon(points, options)
					: generator.linearPath(points, options);
			} else {
				shaft = generator.curve(points, options);
			}
			const drawables = [shaft];
			if (element.type === "arrow") {
				for (const [position, head] of [
					["start", element.startArrowhead],
					["end", element.endArrowhead],
				] as const) {
					if (head) {
						drawables.push(
							...arrowheadDrawables(
								element,
								shaft,
								position,
								head,
								{ ...options },
								canvasBackground,
							),
						);
					}
				}
			}
			return drawables;
		}
		case "freedraw":
			return isPathALoop(element.points)
				? [
						generator.curve(simplifyPoints(element.points, 0.75), {
							...roughOptions(element),
							stroke: "none",
						}),
					]
				: [];
		default:
			return [];
	}
}

/** Ramer–Douglas–Peucker, as `points-on-curve`'s `simplify` runs it for a freedraw fill. */
function simplifyPoints(points: readonly Point[], tolerance: number): Point[] {
	if (points.length < 3) return [...points];
	const first = points[0] as Point;
	const last = points.at(-1) as Point;
	let farthest = 0;
	let index = 0;
	for (let i = 1; i < points.length - 1; i += 1) {
		const [px, py] = points[i] as Point;
		const dx = last[0] - first[0];
		const dy = last[1] - first[1];
		const lengthSquared = dx * dx + dy * dy;
		const t =
			lengthSquared === 0
				? 0
				: Math.max(0, Math.min(1, ((px - first[0]) * dx + (py - first[1]) * dy) / lengthSquared));
		const distance = Math.hypot(px - (first[0] + t * dx), py - (first[1] + t * dy));
		if (distance > farthest) {
			farthest = distance;
			index = i;
		}
	}
	if (farthest <= tolerance) return [first, last];
	return [
		...simplifyPoints(points.slice(0, index + 1), tolerance).slice(0, -1),
		...simplifyPoints(points.slice(index), tolerance),
	];
}

const easeOutSine = (t: number): number => Math.sin((t * Math.PI) / 2);

/** The outline of a freedraw stroke, from perfect-freehand (`getFreeDrawSvgPath`). */
export function freedrawPath(element: ExcalidrawElement): string {
	const input = element.simulatePressure
		? element.points
		: element.points.length > 0
			? element.points.map(([x, y], i) => [x, y, element.pressures[i] ?? 0.5])
			: [[0, 0, 0.5]];
	const outline = getStroke(input, {
		simulatePressure: element.simulatePressure,
		size: element.strokeWidth * 4.25,
		thinning: 0.6,
		smoothing: 0.5,
		streamline: 0.5,
		easing: easeOutSine,
		last: element.lastCommittedPoint !== null,
	});
	if (outline.length === 0) return "";
	const midpoint = (a: number[], b: number[]): number[] => [
		((a[0] ?? 0) + (b[0] ?? 0)) / 2,
		((a[1] ?? 0) + (b[1] ?? 0)) / 2,
	];
	const first = outline[0] as number[];
	const parts: (string | number[])[] = ["M", first, "Q"];
	outline.forEach((point, i) => {
		if (i === outline.length - 1) parts.push(point, midpoint(point, first), "L", first, "Z");
		else parts.push(point, midpoint(point, outline[i + 1] as number[]));
	});
	// Excalidraw truncates (not rounds) every number to two decimals.
	return parts.join(" ").replace(TO_FIXED_PRECISION, "$1");
}

const TO_FIXED_PRECISION = /(\s?[A-Z]?,?-?[0-9]*\.[0-9]{0,2})(([0-9]|e|-)*)/g;

/** The `<path>`s roughjs's SVG renderer draws for a drawable, without the `<g>`. */
export function drawablePaths(drawable: Drawable): string {
	const o = drawable.options;
	const stroke = escapeHtmlAttribute(o.stroke);
	const fill = escapeHtmlAttribute(o.fill ?? "");
	return drawable.sets
		.map((set) => {
			const d = generator.opsToPath(set, PRECISION);
			if (set.type === "path") {
				const dash = o.strokeLineDash ? ` stroke-dasharray="${o.strokeLineDash.join(" ")}"` : "";
				return `<path d="${d}" stroke="${stroke}" stroke-width="${o.strokeWidth}" fill="none"${dash}/>`;
			}
			if (set.type === "fillPath") {
				const rule =
					drawable.shape === "curve" || drawable.shape === "polygon" ? ` fill-rule="evenodd"` : "";
				return `<path d="${d}" stroke="none" stroke-width="0" fill="${fill}"${rule}/>`;
			}
			const weight = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight;
			return `<path d="${d}" stroke="${fill}" stroke-width="${weight}" fill="none"/>`;
		})
		.join("");
}

/** The curve ops of a linear element's shaft, for its bounds and its arrowheads. */
export function shaftOps(element: ExcalidrawElement): Op[] {
	return curveOps(elementDrawables(element, "#ffffff")[0]);
}
