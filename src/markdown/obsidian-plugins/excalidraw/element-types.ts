/**
 * What differs between Excalidraw's element types: how each is painted, how
 * its bounds are measured, where its fill comes from, whether it takes rounded
 * corners, where it puts a bound label, and whether it is an arrow or an embed.
 *
 * Every branch on an element's type reads this table, so a type is described
 * once. A type the table does not know — one a newer Excalidraw writes — is
 * measured as a box and painted not at all, which is how every branch treated
 * an unknown type before there was a table.
 */

/** The painter that draws the element. */
type PaintKind =
	| "rect"
	| "diamond"
	| "ellipse"
	| "linear"
	| "freedraw"
	| "image"
	| "frame"
	| "text"
	| "none";

/** How the element's box is measured. */
type BoundsKind = "box" | "ellipse" | "diamond" | "linear" | "freedraw";

/** Where roughjs takes a shape's fill from. */
type FillKind = "background" | "closed" | "none";

/** Where a container puts its bound text element. */
type LabelKind = "arrow" | "ellipse" | "diamond" | "box";

export interface ElementKind {
	paint: PaintKind;
	bounds: BoundsKind;
	fill: FillKind;
	/** Excalidraw rounds the corners of this type when `roundness` is set. */
	roundable: boolean;
	label: LabelKind;
	/** An arrow: arrowheads on its shaft, and its label masked out of the line. */
	arrow?: true;
	/** An embed: a placeholder with a label, drawn last, over everything else. */
	embed?: true;
}

/** The element types Excalidraw writes. */
type ElementType =
	| "rectangle"
	| "diamond"
	| "ellipse"
	| "line"
	| "arrow"
	| "freedraw"
	| "text"
	| "image"
	| "iframe"
	| "embeddable"
	| "frame"
	| "magicframe";

const KINDS: Record<ElementType, ElementKind> = {
	rectangle: { paint: "rect", bounds: "box", fill: "background", roundable: true, label: "box" },
	diamond: {
		paint: "diamond",
		bounds: "diamond",
		fill: "background",
		roundable: true,
		label: "diamond",
	},
	ellipse: {
		paint: "ellipse",
		bounds: "ellipse",
		fill: "background",
		roundable: false,
		label: "ellipse",
	},
	iframe: {
		paint: "rect",
		bounds: "box",
		fill: "background",
		roundable: true,
		label: "box",
		embed: true,
	},
	embeddable: {
		paint: "rect",
		bounds: "box",
		fill: "background",
		roundable: true,
		label: "box",
		embed: true,
	},
	line: { paint: "linear", bounds: "linear", fill: "closed", roundable: true, label: "box" },
	arrow: {
		paint: "linear",
		bounds: "linear",
		fill: "closed",
		roundable: false,
		label: "arrow",
		arrow: true,
	},
	freedraw: {
		paint: "freedraw",
		bounds: "freedraw",
		fill: "closed",
		roundable: false,
		label: "box",
	},
	text: { paint: "text", bounds: "box", fill: "none", roundable: false, label: "box" },
	image: { paint: "image", bounds: "box", fill: "none", roundable: true, label: "box" },
	frame: { paint: "frame", bounds: "box", fill: "none", roundable: false, label: "box" },
	magicframe: { paint: "frame", bounds: "box", fill: "none", roundable: false, label: "box" },
};

/** A type the table does not know: measured as a box, painted not at all. */
const UNKNOWN: ElementKind = {
	paint: "none",
	bounds: "box",
	fill: "none",
	roundable: false,
	label: "box",
};

/** How an element of `type` is drawn and measured. */
export function elementKind(type: string): ElementKind {
	return KINDS[type as ElementType] ?? UNKNOWN;
}
