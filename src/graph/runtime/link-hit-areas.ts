/**
 * force-graph finds what is under the pointer by reading one pixel of a hidden
 * "shadow" canvas on which every node and link is painted in its own colour.
 * One colour per link means one stroke per link, and the shadow canvas is
 * CPU-rasterised (it is read back every frame), so on a view with thousands of
 * links each repaint is a long main-thread task — and force-graph repaints it
 * after every hover change, because hover emphasis changes the links' widths.
 *
 * This painter leaves the same pixels for far less work. Once the layout, pan
 * and zoom hold still, the links at each shared width (the resting width, the
 * dimmed width while something is hovered) are stroked into an offscreen
 * layer while the page is idle, and every repaint copies the matching layer
 * in. The few links at another width (the hovered link, a hovered node's
 * links) are then repainted: the device-pixel cells their strokes touch are
 * cleared and every link crossing those cells is stroked again, in link
 * order, at its own width — exactly what a full repaint leaves there — and
 * the cells those strokes spill into get the layer's pixels back. Until a
 * layer is ready, the repaint strokes every link itself, as force-graph does.
 */

/** force-graph's default `linkHoverPrecision`: hit width added to the drawn width. */
const LINK_HOVER_PRECISION = 4;
/** force-graph widens shadow strokes by 2 graph units against anti-aliasing. */
const SHADOW_PAD = 2;
/** Side of a repaint cell, in device pixels. */
const CELL = 32;
/** Device pixels of anti-aliasing a stroke may spill past its edge. */
const AA_MARGIN = 2;
/** Layers kept: the resting width and the dimmed width. */
const MAX_LAYERS = 2;

/** A link as force-graph holds it once the simulation has resolved its ends. */
export interface HitAreaLink {
	source?: unknown;
	target?: unknown;
	/** The colour force-graph identifies the link by on the shadow canvas. */
	__indexColor?: string;
}

interface Positioned {
	x: number;
	y: number;
}

/** force-graph's own test for a drawable end. */
function isPositioned(end: unknown): end is Positioned {
	return typeof end === "object" && end !== null && Object.hasOwn(end, "x");
}

/** The shadow stroke width force-graph uses for a link drawn `width` wide. */
function shadowLineWidth(width: number, globalScale: number): number {
	return (width + LINK_HOVER_PRECISION) / globalScale + SHADOW_PAD;
}

function strokeLink(
	ctx: CanvasRenderingContext2D,
	link: HitAreaLink,
	width: number,
	globalScale: number,
) {
	const { source, target } = link;
	if (!isPositioned(source) || !isPositioned(target)) return;
	ctx.beginPath();
	ctx.moveTo(source.x, source.y);
	ctx.lineTo(target.x, target.y);
	ctx.strokeStyle = link.__indexColor ?? "rgba(0,0,0,0.15)";
	ctx.lineWidth = shadowLineWidth(width, globalScale);
	ctx.stroke();
}

/** How long the view must hold still, checked twice, before layers are built. */
const SETTLE_MS = 300;

// Without `requestIdleCallback` (Safari) the check runs in the settle timer's
// own task; a further zero-delay hop would add nothing.
const onIdle: (callback: () => void) => void =
	typeof requestIdleCallback === "function"
		? (callback) => requestIdleCallback(callback, { timeout: 500 })
		: (callback) => callback();

interface Layer {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
}

/** The view a layer was drawn for: the shadow canvas and the links in it. */
interface View {
	ctx: CanvasRenderingContext2D;
	links: readonly HitAreaLink[];
	globalScale: number;
}

/**
 * A painter for the shadow canvas, called once per repaint with every link and
 * a reader for each link's current drawn width (from the first link's
 * `linkPointerAreaPaint`; the others paint nothing).
 */
export function createLinkHitAreaPainter() {
	// What the strokes' geometry depends on: canvas size, transform, and both
	// ends of every link. Layers and the cell index hold while it is unchanged.
	let key = new Float64Array(0);
	let keyLinks: readonly HitAreaLink[] | null = null;
	const layers = new Map<number, Layer>();
	const spare: Layer[] = [];
	// Shared widths most recently painted, newest last: the layers to build.
	let wanted: number[] = [];
	let widestSeen = 0;
	let lastView: View | null = null;
	let checkScheduled = false;
	// Whether a settle check has already found the view unchanged since it last moved.
	let quiet = false;
	let disposed = false;
	// The canvas as a grid of CELL-sized cells; per cell, the links whose
	// strokes may touch it at `indexHalfWidth`, in link order.
	let cols = 0;
	let rows = 0;
	let ends = new Float64Array(0);
	let index: number[][] | null = null;
	let indexHalfWidth = 0;

	function isLayoutUnchanged(ctx: CanvasRenderingContext2D, links: readonly HitAreaLink[]) {
		const transform = ctx.getTransform();
		const size = 8 + links.length * 4;
		let same = links === keyLinks && key.length === size;
		if (key.length !== size) key = new Float64Array(size);
		let i = 0;
		// `Object.is`, so an unpositioned end (NaN) still matches itself.
		const record = (value: number) => {
			if (!Object.is(key[i], value)) same = false;
			key[i] = value;
			i += 1;
		};
		record(ctx.canvas.width);
		record(ctx.canvas.height);
		record(transform.a);
		record(transform.b);
		record(transform.c);
		record(transform.d);
		record(transform.e);
		record(transform.f);
		for (const { source, target } of links) {
			record(isPositioned(source) ? source.x : Number.NaN);
			record(isPositioned(source) ? source.y : Number.NaN);
			record(isPositioned(target) ? target.x : Number.NaN);
			record(isPositioned(target) ? target.y : Number.NaN);
		}
		keyLinks = links;
		if (!same) {
			for (const layer of layers.values()) spare.push(layer);
			layers.clear();
			index = null;
			quiet = false;
		}
		return same;
	}

	/** Every link stroked at `width`, in link order: force-graph's shadow pass. */
	function buildLayer({ ctx: shadow, links, globalScale }: View, width: number) {
		let layer = spare.pop();
		if (!layer) {
			const canvas = document.createElement("canvas");
			// CPU-backed like the shadow canvas, so both rasterise identically.
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return;
			layer = { canvas, ctx };
		}
		const { canvas, ctx } = layer;
		if (canvas.width !== shadow.canvas.width || canvas.height !== shadow.canvas.height) {
			canvas.width = shadow.canvas.width;
			canvas.height = shadow.canvas.height;
		} else {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
		ctx.setTransform(shadow.getTransform());
		for (const link of links) strokeLink(ctx, link, width, globalScale);
		// Rasterise now, while idle, rather than on the first copy.
		ctx.getImageData(0, 0, 1, 1);
		layers.set(width, layer);
	}

	/** Visit the cells within `halfWidth` device pixels of link `i`'s segment. */
	function forEachCell(i: number, halfWidth: number, visit: (cell: number) => void) {
		const x0 = ends[i * 4] as number;
		const y0 = ends[i * 4 + 1] as number;
		const x1 = ends[i * 4 + 2] as number;
		const y1 = ends[i * 4 + 3] as number;
		if (Number.isNaN(x0) || Number.isNaN(x1)) return;
		const length = Math.hypot(x1 - x0, y1 - y0);
		const steps = Math.max(1, Math.ceil(length / (CELL / 2)));
		// Each sample stands for the stretch of segment half a step either side.
		const reach = halfWidth + AA_MARGIN + length / steps / 2;
		let last = -1;
		for (let s = 0; s <= steps; s += 1) {
			const x = x0 + ((x1 - x0) * s) / steps;
			const y = y0 + ((y1 - y0) * s) / steps;
			// Cells off the canvas hold no pixels to get right.
			const left = Math.max(0, Math.floor((x - reach) / CELL));
			const right = Math.min(cols - 1, Math.floor((x + reach) / CELL));
			const top = Math.max(0, Math.floor((y - reach) / CELL));
			const bottom = Math.min(rows - 1, Math.floor((y + reach) / CELL));
			for (let cy = top; cy <= bottom; cy += 1) {
				for (let cx = left; cx <= right; cx += 1) {
					const cell = cy * cols + cx;
					if (cell !== last) visit(cell);
					last = cell;
				}
			}
		}
	}

	function buildIndex({ ctx, links }: View, halfWidth: number) {
		const m = ctx.getTransform();
		cols = Math.ceil(ctx.canvas.width / CELL);
		rows = Math.ceil(ctx.canvas.height / CELL);
		ends = new Float64Array(links.length * 4);
		links.forEach(({ source, target }, i) => {
			const from = isPositioned(source) ? source : { x: Number.NaN, y: Number.NaN };
			const to = isPositioned(target) ? target : { x: Number.NaN, y: Number.NaN };
			ends[i * 4] = m.a * from.x + m.c * from.y + m.e;
			ends[i * 4 + 1] = m.b * from.x + m.d * from.y + m.f;
			ends[i * 4 + 2] = m.a * to.x + m.c * to.y + m.e;
			ends[i * 4 + 3] = m.b * to.x + m.d * to.y + m.f;
		});
		const cells: number[][] = Array.from({ length: cols * rows }, () => []);
		for (let i = 0; i < links.length; i += 1) {
			forEachCell(i, halfWidth, (cell) => {
				const list = cells[cell] as number[];
				if (list[list.length - 1] !== i) list.push(i);
			});
		}
		index = cells;
		indexHalfWidth = halfWidth;
	}

	function halfWidthOf({ ctx, globalScale }: View, width: number) {
		const m = ctx.getTransform();
		// Device pixels per graph unit; force-graph never skews the shadow canvas.
		const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
		return (shadowLineWidth(width, globalScale) * scale) / 2;
	}

	/** Visit marked cells as horizontal runs, in device pixels. */
	function forEachRun(marks: Uint8Array, visit: (x: number, y: number, width: number) => void) {
		for (let cy = 0; cy < rows; cy += 1) {
			let cx = 0;
			while (cx < cols) {
				if (!marks[cy * cols + cx]) {
					cx += 1;
					continue;
				}
				const start = cx;
				while (cx < cols && marks[cy * cols + cx]) cx += 1;
				visit(start * CELL, cy * CELL, (cx - start) * CELL);
			}
		}
	}

	/**
	 * Build the layers and the cell index once the view has held still through
	 * two checks SETTLE_MS apart, so a pan, a zoom or a running simulation never
	 * pays for layers it would discard on its next frame.
	 */
	function scheduleLayers() {
		if (checkScheduled || disposed) return;
		checkScheduled = true;
		setTimeout(
			() =>
				onIdle(() => {
					checkScheduled = false;
					const view = lastView;
					if (disposed || !view) return;
					if (!isLayoutUnchanged(view.ctx, view.links) || !quiet) {
						quiet = true;
						scheduleLayers();
						return;
					}
					for (const [width, layer] of layers) {
						if (wanted.includes(width)) continue;
						layers.delete(width);
						spare.push(layer);
					}
					for (const width of wanted) if (!layers.has(width)) buildLayer(view, width);
					const halfWidth = halfWidthOf(view, widestSeen);
					if (!index || indexHalfWidth < halfWidth) buildIndex(view, halfWidth);
				}),
			SETTLE_MS,
		);
	}

	function paintLinkHitAreas(
		ctx: CanvasRenderingContext2D,
		links: readonly HitAreaLink[],
		globalScale: number,
		widthOf: (link: HitAreaLink) => number,
	): void {
		const view = { ctx, links, globalScale };
		lastView = view;
		disposed = false;
		const widths = links.map(widthOf);
		// The width most links share comes from a layer; the rest repaint.
		const counts = new Map<number, number>();
		let base = 0;
		let baseCount = -1;
		let widest = 0;
		for (const width of widths) {
			const count = (counts.get(width) ?? 0) + 1;
			counts.set(width, count);
			if (count > baseCount) {
				base = width;
				baseCount = count;
			}
			widest = Math.max(widest, width);
		}
		widestSeen = Math.max(widestSeen, widest);
		wanted = [...wanted.filter((width) => width !== base), base].slice(-MAX_LAYERS);

		const settled = isLayoutUnchanged(ctx, links);
		const layer = layers.get(base);
		const ready =
			settled &&
			layer !== undefined &&
			(baseCount === links.length ||
				(index !== null && indexHalfWidth >= halfWidthOf(view, widest)));
		if (!layer || !ready) {
			links.forEach((link, i) => {
				strokeLink(ctx, link, widths[i] as number, globalScale);
			});
			scheduleLayers();
			return;
		}

		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(layer.canvas, 0, 0);
		ctx.restore();
		if (baseCount === links.length) return;

		// A link's cells cover its stroke both at its own width and at the base
		// width the layer drew it with.
		const dirty = new Uint8Array(cols * rows);
		widths.forEach((width, i) => {
			if (width === base) return;
			forEachCell(i, halfWidthOf(view, Math.max(width, base)), (cell) => {
				dirty[cell] = 1;
			});
		});
		const repaint = new Uint8Array(links.length);
		dirty.forEach((isDirty, cell) => {
			if (isDirty) for (const i of index?.[cell] ?? []) repaint[i] = 1;
		});
		// The repainted strokes run on past the dirty cells; everywhere else
		// they touch gets the layer's pixels back.
		const spill = new Uint8Array(cols * rows);
		const spillHalfWidth = halfWidthOf(view, widest);
		repaint.forEach((isRepainted, i) => {
			if (!isRepainted) return;
			forEachCell(i, spillHalfWidth, (cell) => {
				if (!dirty[cell]) spill[cell] = 1;
			});
		});

		const transform = ctx.getTransform();
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		forEachRun(dirty, (x, y, w) => ctx.clearRect(x, y, w, CELL));
		// No clip: Chrome anti-aliases a clipped stroke differently, and the
		// pixels must match a full repaint's exactly.
		ctx.setTransform(transform);
		repaint.forEach((isRepainted, i) => {
			if (isRepainted) strokeLink(ctx, links[i] as HitAreaLink, widths[i] as number, globalScale);
		});
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		forEachRun(spill, (x, y, w) => {
			ctx.clearRect(x, y, w, CELL);
			ctx.drawImage(layer.canvas, x, y, w, CELL, x, y, w, CELL);
		});
		ctx.restore();
	}

	return Object.assign(paintLinkHitAreas, {
		/**
		 * Stop pending work and release the layers (on unmount). A later repaint
		 * (a remount of the same view) takes up the work again.
		 */
		dispose() {
			disposed = true;
			lastView = null;
			layers.clear();
			spare.length = 0;
			index = null;
		},
	});
}
