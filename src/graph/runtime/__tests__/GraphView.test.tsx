// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { DARK_COLORS, LIGHT_COLORS } from "../palette/colors";

const { mock } = require("bun:test");

// `virtual-graph-data` is a build-time module; provide a stable fixture.
const mockGraphData = {
	nodes: [
		{ id: "/", label: "Home", routePath: "/" },
		{ id: "/guide", label: "Guide", routePath: "/guide" },
		{ id: "/api", label: "API", routePath: "/api" },
	],
	links: [
		{ source: "/", target: "/guide" },
		{ source: "/guide", target: "/api" },
	],
};

mock.module("virtual-graph-data", () => ({ graphData: mockGraphData, default: mockGraphData }));
mock.module("@rspress/core/runtime", () => ({
	useLocation: () => ({ pathname: "/guide", search: "", hash: "", state: null, key: "" }),
	useNavigate: () => () => {},
}));
// `react-force-graph-2d` renders to a canvas, so it has no DOM of its own and
// the palette it is handed would otherwise be invisible to a test. Echo it back
// as an attribute so a paint's resolved theme can be read from the DOM.
mock.module("react-force-graph-2d", () => ({
	default: ({ nodeColor }: { nodeColor?: (node: { isCurrent?: boolean }) => string }) => (
		<div data-testid="force-graph" data-node-color={nodeColor?.({}) ?? ""} />
	),
}));

// Re-import the component under test AFTER mocks are registered.
const { default: GraphView, GraphErrorBoundary, GraphFallback } = await import("../GraphView");

function textIn(container: HTMLElement, text: string): boolean {
	return [...container.querySelectorAll("*")].some((el) => el.textContent === text);
}

describe("GraphView error boundary", () => {
	beforeEach(() => {
		cleanup();
	});

	test("renders fallback UI when a child throws", () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("render failure");
		};

		const { container } = render(
			<GraphErrorBoundary fallback={<GraphFallback width={100} height={100} color="#333" />}>
				<Boom />
			</GraphErrorBoundary>,
		);

		// The fallback names the package to install: without it the reader has a
		// dead panel and no actionable information.
		expect(textIn(container, "Graph view unavailable — install react-force-graph-2d")).toBe(true);
		errorSpy.mockRestore();
	});

	test("renders children when no error occurs", () => {
		const { container } = render(
			<GraphErrorBoundary fallback={<GraphFallback width={100} height={100} color="#333" />}>
				<div>working child</div>
			</GraphErrorBoundary>,
		);

		expect(textIn(container, "working child")).toBe(true);
		expect(textIn(container, "Graph view unavailable")).toBe(false);
	});
});

describe("GraphView hydration", () => {
	beforeEach(() => {
		cleanup();
		document.documentElement.classList.remove("dark");
	});

	test("first client render paints the server's light palette in dark mode", () => {
		// Render the "server" pass with no DOM — that is what an SSR build sees,
		// and it is why theme state must not be read from `document` during render.
		const documentRef = globalThis.document;
		// @ts-expect-error — simulating the server environment, where `document` is absent.
		delete globalThis.document;
		const serverHtml = renderToString(<GraphView width={400} height={300} />);
		globalThis.document = documentRef;

		// `renderToString` executes the same render code as the client's first
		// paint (neither runs effects), so rendering again with the document dark
		// reproduces exactly the markup hydration compares against. The hydrated
		// DOM itself cannot show this: React 19 reports attribute mismatches but
		// deliberately leaves the server markup in place, so the divergence is
		// only visible in the render output.
		document.documentElement.classList.add("dark");
		const clientFirstRenderHtml = renderToString(<GraphView width={400} height={300} />);
		document.documentElement.classList.remove("dark");

		// The loader spinner is the host element the palette reaches, so this
		// guards the assertions below against silently going vacuous.
		expect(serverHtml).toContain(LIGHT_COLORS.loaderTop);
		expect(clientFirstRenderHtml).not.toContain(DARK_COLORS.loaderTop);
		expect(clientFirstRenderHtml).toBe(serverHtml);
	});

	test("hydrating in dark mode logs no attribute mismatch", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});

		// Render the "server" pass with no DOM — that is what an SSR build sees,
		// and it is why theme state must not be read from `document` during render.
		const documentRef = globalThis.document;
		// @ts-expect-error — simulating the server environment, where `document` is absent.
		delete globalThis.document;
		const serverHtml = renderToString(<GraphView width={400} height={300} />);
		globalThis.document = documentRef;

		// The client is in dark mode, so a render-time `isDarkMode()` seed would
		// paint the dark palette while the server painted the light one.
		document.documentElement.classList.add("dark");
		const container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);

		let root: Root | undefined;
		await act(async () => {
			root = hydrateRoot(container, <GraphView width={400} height={300} />);
		});
		// Let the lazy `import("react-force-graph-2d")` settle inside act.
		await act(async () => {
			await Promise.resolve();
		});

		const messages = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(messages).not.toContain("hydrated but some attributes");
		// Name the palette the regression leaks, so a failure points at the theme
		// seed instead of at React's generic warning text.
		expect(messages).not.toContain(DARK_COLORS.loaderTop);

		// Unmount before touching `<html>`: the theme observer is live and would
		// otherwise set state outside act.
		await act(async () => {
			root?.unmount();
		});
		container.remove();
		document.documentElement.classList.remove("dark");
		errorSpy.mockRestore();
	});
});
