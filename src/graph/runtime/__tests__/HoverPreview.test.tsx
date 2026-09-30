// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

const { mock } = require("bun:test");

const mockPageContentData = [
	{
		routePath: "/guide/getting-started",
		title: "Getting Started",
		content: "Install and configure the plugin.",
	},
	{ routePath: "/guide/advanced", title: "Advanced", content: "Configuration reference." },
	// The build ships one character past the budget when it truncated the body.
	{ routePath: "/guide/long", title: "Long", content: "x".repeat(301) },
	{ routePath: "/guide/exact", title: "Exact", content: "y".repeat(300) },
];

mock.module("virtual-page-content-data", () => ({
	pageContentData: mockPageContentData,
	default: mockPageContentData,
}));

// Re-import the component under test AFTER mocks are registered — a static
// import would bind to the unmocked virtual module.
const { default: HoverPreview } = await import("../HoverPreview");

const HOVER_DELAY = 300;

async function hoverHref(href: string): Promise<void> {
	const link = document.createElement("a");
	link.setAttribute("href", href);
	link.textContent = href;
	document.body.appendChild(link);

	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, HOVER_DELAY + 50);

	await act(async () => {
		link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 10, clientY: 10 }));
		await promise;
	});

	link.remove();
}

function previewTitle(): string | null | undefined {
	return document.querySelector(".obsidian-hover-preview__title")?.textContent;
}

describe("HoverPreview link resolution", () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	test("resolves a wikilink target", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/advanced");

		expect(previewTitle()).toBe("Advanced");
	});

	test("resolves a markdown link rewritten to .html", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/getting-started.html");

		expect(previewTitle()).toBe("Getting Started");
	});

	test("resolves a markdown link carrying an .html fragment and query", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/getting-started.html?from=nav#Install");

		expect(previewTitle()).toBe("Getting Started");
	});

	test("truncates the sentinel payload to the budget and marks it", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/long");

		const content = document.querySelector(".obsidian-hover-preview__content")?.textContent ?? "";
		expect(content).toHaveLength(301);
		expect(content.endsWith("…")).toBe(true);
		expect(content.slice(0, 300)).toBe("x".repeat(300));
	});

	test("leaves a body that fits the budget exactly unmarked", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/exact");

		const content = document.querySelector(".obsidian-hover-preview__content")?.textContent ?? "";
		expect(content).toHaveLength(300);
		expect(content).not.toContain("…");
	});

	test("shows nothing for a link with no collected page", async () => {
		render(<HoverPreview />);

		await hoverHref("/guide/missing.html");

		expect(document.querySelector(".obsidian-hover-preview")).toBeNull();
	});

	test("clears the pending hover timer on unmount", () => {
		const clearSpy = spyOn(globalThis, "clearTimeout");
		const { unmount } = render(<HoverPreview />);

		const link = document.createElement("a");
		link.setAttribute("href", "/guide/advanced");
		document.body.appendChild(link);
		link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 5, clientY: 5 }));

		clearSpy.mockClear();
		unmount();

		// A pending 300ms timer must not outlive the component.
		expect(clearSpy).toHaveBeenCalledTimes(1);
		clearSpy.mockRestore();
		link.remove();
	});

	test("re-clamps the popup when the viewport resizes", async () => {
		Object.defineProperty(window, "innerWidth", { value: 200, configurable: true });
		try {
			render(<HoverPreview />);

			await hoverHref("/guide/advanced");

			const popup = document.querySelector(".obsidian-hover-preview") as HTMLElement | null;
			if (!popup) throw new Error("preview did not open");
			// 200px is narrower than the popup, so the clamp pushes it off the left.
			const cramped = popup.style.left;

			await act(async () => {
				Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
				window.dispatchEvent(new Event("resize"));
			});

			// Reading `window.innerWidth` during render would leave it stranded here.
			expect(popup.style.left).not.toBe(cramped);
		} finally {
			Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
		}
	});
});
