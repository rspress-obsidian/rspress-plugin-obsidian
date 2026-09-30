import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import CanvasViewer from "./CanvasViewer";

afterEach(cleanup);

function canvasJson(text: string): string {
	return JSON.stringify({
		nodes: [{ id: "n", type: "text", x: 0, y: 0, width: 200, height: 100, text }],
		edges: [],
	});
}

function renderedText(container: HTMLElement): string | null | undefined {
	return container.querySelector(".canvas-markdown")?.textContent?.trim();
}

test("shows a swapped-in canvas instead of the one it mounted with", () => {
	const { container, rerender } = render(<CanvasViewer canvasJson={canvasJson("First")} />);
	expect(renderedText(container)).toBe("First");

	// The renderer seeds its editor state from `data` once, so the new canvas has to
	// remount it — otherwise the old cards stay on screen forever.
	rerender(<CanvasViewer canvasJson={canvasJson("Second")} />);

	expect(renderedText(container)).toBe("Second");
});
