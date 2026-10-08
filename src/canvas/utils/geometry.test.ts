import { expect, test } from "bun:test";
import { edgeCurve, facingSides } from "./geometry";

const a = { x: 0, y: 0, width: 100, height: 100 };
const b = { x: 400, y: 50, width: 100, height: 100 };

test("missing sides pick the facing sides along the dominant axis", () => {
	expect(facingSides(a, b)).toEqual({ fromSide: "right", toSide: "left" });
	expect(facingSides(b, a)).toEqual({ fromSide: "left", toSide: "right" });
	expect(facingSides(a, { ...a, y: 500 })).toEqual({ fromSide: "bottom", toSide: "top" });
});

test("an edge without sides ends on the target's border, not its centre", () => {
	const curve = edgeCurve(a, b, undefined, undefined);
	expect(curve.start).toEqual({ x: 100, y: 50 });
	expect(curve.end).toEqual({ x: 400, y: 100 });
});

test("the label point is the bezier midpoint B(0.5), not the chord midpoint", () => {
	// Demo edge-4 from the review: node-6 top → node-1 left.
	const from = { x: -200, y: 200, width: 280, height: 100 };
	const to = { x: 0, y: 0, width: 200, height: 80 };
	const curve = edgeCurve(from, to, "top", "left");
	const expected = {
		x: (curve.start.x + 3 * curve.cp1.x + 3 * curve.cp2.x + curve.end.x) / 8,
		y: (curve.start.y + 3 * curve.cp1.y + 3 * curve.cp2.y + curve.end.y) / 8,
	};
	expect(curve.mid).toEqual(expected);
	const chord = { x: (curve.start.x + curve.end.x) / 2, y: (curve.start.y + curve.end.y) / 2 };
	expect(Math.hypot(curve.mid.x - chord.x, curve.mid.y - chord.y)).toBeGreaterThan(20);
});
