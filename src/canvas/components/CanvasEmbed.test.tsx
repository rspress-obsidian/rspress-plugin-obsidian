import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import CanvasEmbed, { resolveCanvasJsonUrl } from "./CanvasEmbed";

function board(text: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		nodes: [{ id: "n1", type: "text", text, x: 0, y: 0, width: 200, height: 100 }],
		edges: [],
		...extra,
	});
}

const origFetch = globalThis.fetch;
let requested: string[] = [];

function serve(handler: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requested.push(url);
		return Promise.resolve(handler(url));
	}) as typeof fetch;
}

beforeEach(() => {
	requested = [];
	serve(() => new Response(board("Hello"), { status: 200 }));
});

afterEach(() => {
	cleanup();
	globalThis.fetch = origFetch;
});

test("shows a loading state until the board arrives", async () => {
	const { container } = render(<CanvasEmbed src="Demo.canvas" />);
	expect(container.querySelector(".canvas-embed-loading")?.textContent).toContain("Loading canvas");
	await waitFor(() => expect(container.querySelector(".canvas-viewport")).toBeTruthy());
});

test("fetches the published JSON for the board, under the site base", async () => {
	const { container } = render(<CanvasEmbed src="Maps/My Board.canvas" basePath="/docs/" />);
	await waitFor(() => expect(container.textContent).toContain("Hello"));
	expect(requested).toEqual(["/docs/__canvases__/Maps/My%20Board.json"]);
});

test("passes its props to the board it renders", async () => {
	serve(
		() =>
			new Response(
				JSON.stringify({
					nodes: [
						{ id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 9, height: 9 },
						{ id: "f", type: "file", file: "Deep/Note.md", x: 0, y: 0, width: 9, height: 9 },
					],
				}),
			),
	);
	const { container } = render(
		<CanvasEmbed src="Demo.canvas" fileRoutePrefix="/vault" linkPreview={false} />,
	);
	await waitFor(() => expect(container.querySelector(".canvas-viewport")).toBeTruthy());
	// linkPreview={false}: a plain anchor, no frame.
	expect(container.querySelector("iframe")).toBeNull();
	expect(container.querySelector(".canvas-link a")?.getAttribute("href")).toBe(
		"https://example.com",
	);
	// fileRoutePrefix reaches a file card that has no build data.
	expect(container.querySelector(".canvas-node-label a")?.getAttribute("href")).toBe(
		"/vault/Deep/Note",
	);
});

test("lets a bare wheel scroll the page and zooms only with Ctrl/⌘", async () => {
	const { container } = render(<CanvasEmbed src="Demo.canvas" />);
	await waitFor(() => expect(container.querySelector(".canvas-viewport")).toBeTruthy());
	const viewport = container.querySelector(".canvas-viewport") as HTMLElement;
	const world = container.querySelector(".canvas-world") as HTMLElement;
	const before = world.style.transform;

	const bare = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
	viewport.dispatchEvent(bare);
	expect(bare.defaultPrevented).toBe(false);
	expect(world.style.transform).toBe(before);

	const pinch = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
	// happy-dom's WheelEvent drops the modifier keys from its init dictionary.
	Object.defineProperty(pinch, "ctrlKey", { value: true });
	viewport.dispatchEvent(pinch);
	expect(pinch.defaultPrevented).toBe(true);
	await waitFor(() => expect(world.style.transform).not.toBe(before));
});

test("reads the build-time maps the published board carries", async () => {
	serve(
		() =>
			new Response(
				board("[[Loose]]", { links: { "": { Loose: { href: "/vault/notes/loose" } } } }),
			),
	);
	const { container } = render(<CanvasEmbed src="Demo.canvas" />);
	await waitFor(() =>
		expect(container.querySelector("a.wiki-link")?.getAttribute("href")).toBe("/vault/notes/loose"),
	);
});

test("shows an error naming the board when it cannot be loaded", async () => {
	serve(() => new Response("missing", { status: 404 }));
	const origErr = console.error;
	console.error = () => {};
	try {
		const { container } = render(<CanvasEmbed src="nonexistent.canvas" />);
		await waitFor(() =>
			expect(container.querySelector(".canvas-embed-error")?.textContent).toContain(
				"nonexistent.canvas",
			),
		);
	} finally {
		console.error = origErr;
	}
});

test("shows a swapped-in canvas when src changes", async () => {
	serve((url) => new Response(board(url.includes("Second") ? "Second" : "First")));
	const { container, rerender } = render(<CanvasEmbed src="First.canvas" />);
	await waitFor(() => expect(container.textContent).toContain("First"));

	// The renderer seeds its state from `data` once, so the new canvas has to
	// remount it or the first one stays on screen.
	rerender(<CanvasEmbed src="Second.canvas" />);

	await waitFor(() => expect(container.textContent).toContain("Second"));
	expect(container.textContent).not.toContain("First");
	expect(requested).toEqual(["/__canvases__/First.json", "/__canvases__/Second.json"]);
});

test("resolves the JSON URL with or without an extension, under a base path", () => {
	expect(resolveCanvasJsonUrl("maps/Demo.canvas", "/docs/")).toBe(
		"/docs/__canvases__/maps/Demo.json",
	);
	expect(resolveCanvasJsonUrl("maps/Demo.json", "docs")).toBe("/docs/__canvases__/maps/Demo.json");
	expect(resolveCanvasJsonUrl("Demo")).toBe("/__canvases__/Demo.json");
	expect(resolveCanvasJsonUrl("../../etc/Demo.canvas")).toBe("/__canvases__/etc/Demo.json");
});
