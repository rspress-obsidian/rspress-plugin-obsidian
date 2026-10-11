import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import CanvasViewer from "./CanvasViewer";

const origFetch = globalThis.fetch;
let requested: string[] = [];

beforeEach(() => {
	requested = [];
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		requested.push(url);
		const text = url.includes("Second") ? "Second" : "First";
		return Promise.resolve(
			new Response(
				JSON.stringify({
					nodes: [{ id: "n", type: "text", x: 0, y: 0, width: 200, height: 100, text }],
					edges: [],
				}),
			),
		);
	}) as typeof fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = origFetch;
});

function renderedText(container: HTMLElement): string | null | undefined {
	return container.querySelector(".canvas-markdown")?.textContent?.trim();
}

test("loads the published board rather than carrying it in the page", async () => {
	const { container } = render(<CanvasViewer src="Boards/First.canvas" />);
	await waitFor(() => expect(renderedText(container)).toBe("First"));
	expect(requested).toEqual(["/__canvases__/Boards/First.json"]);
});

test("shows a swapped-in canvas instead of the one it mounted with", async () => {
	const { container, rerender } = render(<CanvasViewer src="First.canvas" />);
	await waitFor(() => expect(renderedText(container)).toBe("First"));

	// The renderer seeds its editor state from `data` once, so the new canvas has to
	// remount it — otherwise the old cards stay on screen forever.
	rerender(<CanvasViewer src="Second.canvas" />);

	await waitFor(() => expect(renderedText(container)).toBe("Second"));
});
