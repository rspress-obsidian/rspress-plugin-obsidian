/**
 * A point in board ("world") space or in viewport-local screen pixels. The two
 * spaces differ only by the viewport, so the type is shared.
 */
export interface Point {
	x: number;
	y: number;
}

/**
 * Where the board sits in its viewport. The world→screen mapping is
 * `screen = world * zoom + (x, y)`: `x`/`y` are the screen pixels the board's
 * origin landed on, `zoom` scales world units to screen pixels.
 */
export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

/** The CSS transform that places a `viewport`'s world inside the viewport element. */
export function viewportTransform({ x, y, zoom }: Viewport): string {
	return `translate(${x}px, ${y}px) scale(${zoom})`;
}

/** The world point under `point`, a viewport-local screen point. */
export function screenToWorld(viewport: Viewport, point: Point): Point {
	return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

/** The viewport that shows `world` at `screen` (viewport-local pixels) with `zoom`. */
export function viewportShowing(world: Point, screen: Point, zoom: number): Viewport {
	return { x: screen.x - world.x * zoom, y: screen.y - world.y * zoom, zoom };
}

/** The world point at the centre of a `width`×`height` viewport. */
export function viewportCentre(viewport: Viewport, width: number, height: number): Point {
	return screenToWorld(viewport, { x: width / 2, y: height / 2 });
}

// Form fields and media controls: a press on them starts typing, moves a caret,
// moves a slider or plays a clip, so the board must not turn it into a pan or a
// card drag.
const FORM_AND_MEDIA_SELECTOR = "input, textarea, select, video, audio";

/**
 * Elements that own their own pointer gesture, so a press on one never pans the
 * board. Only the marker values Obsidian and the browser actually use are
 * matched: `contenteditable="false"` is not an editable region.
 */
export const OWN_GESTURE_SELECTOR = `${FORM_AND_MEDIA_SELECTOR}, [contenteditable=''], [contenteditable='true']`;

/**
 * Card content that handles its own click, so a click on it must not select the
 * card. It is the gesture owners above plus the controls and frames whose click
 * is their own — but every `contenteditable` value counts: an editable region
 * is the reader's target even where its value is not plain `true`.
 */
export const INTERACTIVE_CONTENT_SELECTOR = `a[href], button, ${FORM_AND_MEDIA_SELECTOR}, [contenteditable], summary, label, iframe`;
