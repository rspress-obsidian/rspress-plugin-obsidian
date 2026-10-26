// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { CanvasData, CanvasTextData } from "../types";
import { useCanvasEditor } from "./useCanvasEditor";
import {
	DRAG_CAPTURE_THRESHOLD,
	MIN_NODE_HEIGHT,
	MIN_NODE_WIDTH,
	useNodeGesture,
} from "./useNodeGesture";

const originalCapture = HTMLElement.prototype.setPointerCapture;
const captured: number[] = [];

afterEach(() => {
	cleanup();
	HTMLElement.prototype.setPointerCapture = originalCapture;
	captured.length = 0;
});

function text(id: string, x: number, y: number): CanvasTextData {
	return { id, type: "text", x, y, width: 100, height: 50, text: id };
}

function board(): CanvasData {
	return {
		nodes: [
			{ id: "g", type: "group", x: 0, y: 0, width: 400, height: 300 },
			text("a", 20, 40),
			text("b", 600, 0),
		],
		edges: [],
	};
}

/** Cards that drag (a group with its member `a`) and resize, on a viewport that relays the gesture. */
function Harness({ zoom = 1 }: { zoom?: number }) {
	const { canvas, canUndo, commit, preview, undo } = useCanvasEditor(board());
	const canvasRef = useRef(canvas);
	canvasRef.current = canvas;
	const viewportRef = useRef({ x: 0, y: 0, zoom });
	const { isDragging, startDrag, startResize, updateGesture, finishGesture } = useNodeGesture({
		canvasRef,
		viewportRef,
		commit,
		preview,
	});
	return (
		<div
			data-testid="viewport"
			data-dragging={isDragging}
			data-can-undo={canUndo}
			onPointerMove={updateGesture}
			onPointerUp={finishGesture}
		>
			{canvas.nodes.map((node) => (
				<div
					key={node.id}
					data-testid={node.id}
					data-box={`${node.x},${node.y},${node.width},${node.height}`}
					onPointerDown={(event) => startDrag(node.id === "g" ? ["g", "a"] : [node.id], event)}
				>
					<button
						type="button"
						data-testid={`resize-${node.id}`}
						onPointerDown={(event) => startResize(node, event)}
					/>
				</div>
			))}
			<button type="button" data-testid="undo" onClick={undo} />
		</div>
	);
}

const box = (id: string) => screen.getByTestId(id).dataset.box;
const viewport = () => screen.getByTestId("viewport");

function recordCapture(): void {
	HTMLElement.prototype.setPointerCapture = (pointerId: number) => {
		captured.push(pointerId);
	};
}

describe("useNodeGesture drag", () => {
	test("a press becomes a drag, and claims the pointer, only past the capture threshold", () => {
		recordCapture();
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("b"), { clientX: 0, clientY: 0, pointerId: 7 });
		fireEvent.pointerMove(viewport(), {
			clientX: DRAG_CAPTURE_THRESHOLD - 1,
			clientY: 0,
			pointerId: 7,
		});
		expect(box("b")).toBe("600,0,100,50");
		expect(captured).toEqual([]);
		expect(viewport().dataset.dragging).toBe("false");

		fireEvent.pointerMove(viewport(), { clientX: 30, clientY: 20, pointerId: 7 });
		expect(box("b")).toBe("630,20,100,50");
		expect(captured).toEqual([7]);
		expect(viewport().dataset.dragging).toBe("true");

		fireEvent.pointerUp(viewport(), { pointerId: 7 });
		expect(viewport().dataset.dragging).toBe("false");
	});

	test("moves by the pointer travel in world pixels", () => {
		render(<Harness zoom={2} />);
		fireEvent.pointerDown(screen.getByTestId("b"), { clientX: 0, clientY: 0, pointerId: 1 });
		fireEvent.pointerMove(viewport(), { clientX: 40, clientY: -20, pointerId: 1 });
		expect(box("b")).toBe("620,-10,100,50");
	});

	test("ignores moves from another pointer", () => {
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("b"), { clientX: 0, clientY: 0, pointerId: 1 });
		fireEvent.pointerMove(viewport(), { clientX: 50, clientY: 50, pointerId: 2 });
		expect(box("b")).toBe("600,0,100,50");
	});

	test("drags every node of the gesture and commits them as one undo step", () => {
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("g"), { clientX: 0, clientY: 0, pointerId: 1 });
		fireEvent.pointerMove(viewport(), { clientX: 10, clientY: 5, pointerId: 1 });
		fireEvent.pointerMove(viewport(), { clientX: 50, clientY: 25, pointerId: 1 });
		fireEvent.pointerUp(viewport(), { pointerId: 1 });
		expect(box("g")).toBe("50,25,400,300");
		expect(box("a")).toBe("70,65,100,50");
		expect(box("b")).toBe("600,0,100,50");

		fireEvent.click(screen.getByTestId("undo"));
		expect(box("g")).toBe("0,0,400,300");
		expect(box("a")).toBe("20,40,100,50");
		expect(viewport().dataset.canUndo).toBe("false");
	});

	test("a press released without travel commits nothing", () => {
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("b"), { clientX: 0, clientY: 0, pointerId: 1 });
		fireEvent.pointerUp(viewport(), { pointerId: 1 });
		expect(viewport().dataset.canUndo).toBe("false");
		fireEvent.pointerMove(viewport(), { clientX: 50, clientY: 50, pointerId: 1 });
		expect(box("b")).toBe("600,0,100,50");
	});
});

describe("useNodeGesture resize", () => {
	test("resizes from the handle, without dragging the card, and commits once", () => {
		recordCapture();
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("resize-b"), { clientX: 0, clientY: 0, pointerId: 3 });
		expect(captured).toEqual([3]);
		fireEvent.pointerMove(viewport(), { clientX: 60, clientY: 30, pointerId: 3 });
		expect(box("b")).toBe("600,0,160,80");
		fireEvent.pointerUp(viewport(), { pointerId: 3 });
		expect(viewport().dataset.canUndo).toBe("true");

		fireEvent.click(screen.getByTestId("undo"));
		expect(box("b")).toBe("600,0,100,50");
	});

	test("never shrinks a card below the minimum size", () => {
		render(<Harness />);
		fireEvent.pointerDown(screen.getByTestId("resize-b"), { clientX: 0, clientY: 0, pointerId: 1 });
		fireEvent.pointerMove(viewport(), { clientX: -500, clientY: -500, pointerId: 1 });
		expect(box("b")).toBe(`600,0,${MIN_NODE_WIDTH},${MIN_NODE_HEIGHT}`);
	});
});
