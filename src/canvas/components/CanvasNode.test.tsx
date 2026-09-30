import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CanvasNode, CanvasTextData } from "../types";
import { CanvasNodeComponent } from "./CanvasNode";

declare global {
	// happy-dom attaches its live settings to the global (see test/test-setup.ts).
	var happyDOM: { settings: { disableIframePageLoading?: boolean } } | undefined;
}

afterEach(cleanup);

/**
 * Happy-dom would fetch an embedded iframe's src over the real network, and logs a
 * (harmless) error when page loading is disabled. Neither affects the rendered
 * element, so both are suppressed around the render and restored afterwards.
 */
function renderQuiet(node: CanvasNode, props: ExtraNodeProps = {}) {
	const settings = globalThis.happyDOM?.settings;
	const previousIframeSetting = settings?.disableIframePageLoading;
	if (settings) settings.disableIframePageLoading = true;
	const originalError = console.error;
	console.error = () => {};
	try {
		return render(<CanvasNodeComponent node={node} {...props} />).container;
	} finally {
		console.error = originalError;
		if (settings) settings.disableIframePageLoading = previousIframeSetting;
	}
}

const base = { x: 0, y: 0, width: 200, height: 100 } as const;

type ExtraNodeProps = {
	zIndex?: number;
	isHovered?: boolean;
	isSelected?: boolean;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	iframeSandbox?: string;
	onHover?: (nodeId: string | null) => void;
	onClick?: (nodeId: string) => void;
};

function renderNode(node: CanvasNode, props: ExtraNodeProps = {}) {
	return render(<CanvasNodeComponent node={node} {...props} />).container;
}

function textNode(text: string, extra: Partial<CanvasTextData> = {}): CanvasTextData {
	return { id: "t1", type: "text", ...base, text, ...extra };
}

describe("CanvasNodeComponent text nodes", () => {
	test("renders a callout, a wikilink and a mermaid placeholder from markdown", () => {
		const container = renderNode(
			textNode(
				[
					"> [!note] Heads up",
					"> Body **bold**",
					"",
					"See [[Page Name|the page]].",
					"",
					"```mermaid",
					"graph TD;",
					"  A-->B;",
					"```",
				].join("\n"),
			),
		);

		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.className).toContain("canvas-node-text");
		expect(root.getAttribute("aria-label")).toBe("Text node");

		const callout = container.querySelector(".canvas-callout-note") as HTMLElement;
		expect(callout.querySelector(".canvas-callout-title")?.textContent).toBe("Heads up");
		expect(callout.querySelector(".canvas-callout-body")?.textContent).toContain("bold");
		expect(callout.querySelector(".canvas-callout-body strong")?.textContent).toBe("bold");

		const wikiLink = container.querySelector("a.wiki-link") as HTMLAnchorElement;
		expect(wikiLink.getAttribute("href")).toBe("/Page Name");
		expect(wikiLink.textContent).toBe("the page");

		const mermaid = container.querySelector("pre.obsidian-mermaid-block") as HTMLElement;
		expect(mermaid.getAttribute("data-code")).toContain("graph TD;");
	});

	test("renders no content for an unknown node type, unlike a known one", () => {
		const container = renderNode({
			id: "x",
			type: "future",
			...base,
		} as unknown as CanvasNode);
		expect(container.querySelector(".canvas-node")).toBeTruthy();
		expect(container.querySelector(".canvas-node-content")).toBeNull();

		cleanup();

		expect(renderNode(textNode("hi")).querySelector(".canvas-node-content")).not.toBeNull();
	});
});

describe("CanvasNodeComponent file nodes", () => {
	test("renders an image asset with its header title", () => {
		const container = renderNode({
			id: "f1",
			type: "file",
			...base,
			file: "pic.png",
			assetUrl: "https://cdn.example.com/pic.png",
		});

		expect(container.querySelector(".canvas-node-file-header-title")?.textContent).toBe("pic.png");
		const img = container.querySelector("img.canvas-file-image") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe("https://cdn.example.com/pic.png");
		expect(img.getAttribute("alt")).toBe("pic.png");
	});

	test("renders audio and video by media type", () => {
		const audio = renderNode({
			id: "a1",
			type: "file",
			...base,
			file: "clip.bin",
			assetUrl: "/clip.bin",
			mediaType: "audio/mpeg",
		});
		expect(audio.querySelector("audio.canvas-file-media")?.getAttribute("src")).toBe("/clip.bin");

		cleanup();

		const video = renderNode({
			id: "v1",
			type: "file",
			...base,
			file: "clip.bin",
			assetUrl: "/clip.bin",
			mediaType: "video/mp4",
		});
		expect(video.querySelector("video.canvas-file-media")?.getAttribute("src")).toBe("/clip.bin");
	});

	test("renders a pdf asset in a sandboxed iframe", () => {
		const container = renderQuiet(
			{
				id: "p1",
				type: "file",
				...base,
				file: "doc.pdf",
				assetUrl: "/doc.pdf",
			},
			{ iframeSandbox: "allow-scripts" },
		);

		const frame = container.querySelector("iframe.canvas-file-pdf") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe("/doc.pdf");
		expect(frame.getAttribute("title")).toBe("doc.pdf");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
	});

	test("drops an unsafe asset url and falls back to the file card", () => {
		const container = renderNode({
			id: "f2",
			type: "file",
			...base,
			file: "pic.png",
			assetUrl: "javascript:alert(1)",
		});

		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector(".canvas-file-name")?.textContent).toBe("pic");
	});

	test("renders file content markdown behind a header link to the note route", () => {
		const container = renderNode(
			{
				id: "f3",
				type: "file",
				...base,
				file: "Note.md",
				subpath: "#Section",
				fileContent: "# Hello",
				color: "1",
			},
			{ fileRoutePrefix: "docs" },
		);

		expect(container.querySelector(".canvas-node-file-header-title")?.textContent).toBe(
			"Note > Section",
		);
		const header = container.querySelector(".canvas-node-file-header") as HTMLElement;
		expect(header.style.backgroundColor).toBe("var(--canvas-color-1)");

		// The fragment has to be slugified: the note page renders `## Section`
		// as `id="section"`, so a raw `#Section` matched nothing.
		const link = container.querySelector("a.canvas-node-file-header-link") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/docs/Note#section");
		expect(link.getAttribute("aria-label")).toBe("Open note page");
		expect(container.querySelector(".canvas-markdown h1")?.textContent).toBe("Hello");
	});

	test("renders an error card for a failed file read", () => {
		const container = renderNode({
			id: "f4",
			type: "file",
			...base,
			file: "Missing.md",
			subpath: "#top",
			isError: true,
			fileContent: "ENOENT: no such file",
		});

		expect(container.querySelector(".canvas-node-file-header-title")?.textContent).toBe(
			"Missing > top",
		);
		expect(container.querySelector(".canvas-file-error-text")?.textContent).toBe(
			"ENOENT: no such file",
		);
	});

	test("renders a non-markdown file as a plain card with subpath", () => {
		const container = renderNode({
			id: "f5",
			type: "file",
			...base,
			file: "Archive.zip",
			subpath: "#inner",
		});

		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector(".canvas-file-name")?.textContent).toBe("Archive");
		expect(container.querySelector(".canvas-file-subpath")?.textContent).toBe("#inner");
	});

	test("renders a markdown file without content as a link to its route", () => {
		const container = renderNode(
			{ id: "f6", type: "file", ...base, file: "Deep/My Note.mdx" },
			{ fileRoutePrefix: "/guide" },
		);

		const link = container.querySelector("a.canvas-file-fallback") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/guide/Deep/My Note");
		expect(link.querySelector(".canvas-file-name")?.textContent).toBe("Deep/My Note");
	});
});

describe("CanvasNodeComponent link nodes", () => {
	test("renders a safe url as an external anchor", () => {
		const container = renderNode({
			id: "l1",
			type: "link",
			...base,
			url: "https://example.com/page",
		});

		const anchor = container.querySelector("a") as HTMLAnchorElement;
		expect(anchor.getAttribute("href")).toBe("https://example.com/page");
		expect(anchor.getAttribute("target")).toBe("_blank");
		expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
		expect(anchor.textContent).toBe("https://example.com/page");
	});

	test("never emits a javascript: url as an href", () => {
		const container = renderNode({
			id: "l2",
			type: "link",
			...base,
			url: "javascript:alert(document.cookie)",
		});

		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector(".canvas-link span")?.textContent).toBe(
			"javascript:alert(document.cookie)",
		);
	});

	test("renders an iframe preview for http links when linkPreview is on", () => {
		const container = renderQuiet(
			{ id: "l3", type: "link", ...base, url: "https://example.com/page" },
			{ linkPreview: true, iframeSandbox: "allow-forms" },
		);

		const frame = container.querySelector("iframe") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe("https://example.com/page");
		expect(frame.getAttribute("sandbox")).toBe("allow-forms");
		expect(container.querySelector(".canvas-node-file-header-title")?.textContent).toBe(
			"example.com/page",
		);
	});
});

describe("CanvasNodeComponent group nodes", () => {
	test("renders the label and repeats a background image", () => {
		const container = renderNode({
			id: "g1",
			type: "group",
			...base,
			label: "Chapter one",
			backgroundUrl: "https://cdn.example.com/bg.png",
			backgroundStyle: "repeat",
		});

		expect(container.querySelector(".canvas-group-label")?.textContent).toBe("Chapter one");
		const group = container.querySelector(".canvas-group") as HTMLElement;
		expect(group.style.backgroundImage).toBe('url("https://cdn.example.com/bg.png")');
		expect(group.style.backgroundRepeat).toBe("repeat");
		expect(group.style.backgroundSize).toBe("auto");

		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.getAttribute("aria-label")).toBe("Chapter one");
		expect(root.style.overflow).toBe("visible");
	});

	test("scales a ratio background to contain", () => {
		const container = renderNode({
			id: "g2",
			type: "group",
			...base,
			backgroundUrl: "/bg.png",
			backgroundStyle: "ratio",
		});

		const group = container.querySelector(".canvas-group") as HTMLElement;
		expect(group.style.backgroundSize).toBe("contain");
		expect(group.style.backgroundRepeat).toBe("no-repeat");
	});

	test("drops an unsafe background url", () => {
		const container = renderNode({
			id: "g3",
			type: "group",
			...base,
			backgroundUrl: "javascript:alert(1)",
		});

		expect((container.querySelector(".canvas-group") as HTMLElement).style.backgroundImage).toBe(
			"",
		);
	});
});

describe("CanvasNodeComponent presentation", () => {
	test("applies preset colours to the border and background", () => {
		const container = renderNode(textNode("hi", { color: "2" }));
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.style.backgroundColor).toBe("var(--canvas-bg-color-2-tint)");
		expect(root.style.borderColor).toBe("var(--canvas-color-2)");
	});

	test("uses the group tint for a preset-coloured group", () => {
		const container = renderNode({
			id: "g4",
			type: "group",
			...base,
			color: "3",
			label: "G",
		});
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.style.backgroundColor).toBe("rgba(234, 179, 8, 0.03)");
		expect(root.style.borderColor).toBe("");
	});

	test("ignores a malformed colour and falls back to the node background", () => {
		const container = renderNode(textNode("hi", { color: "not-a-color" }));
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.style.backgroundColor).toBe("var(--canvas-node-bg)");
		expect(root.style.borderColor).toBe("var(--canvas-node-border)");
	});

	test("raises z-index and marks the selected and hovered classes", () => {
		const container = renderNode(textNode("hi"), { zIndex: 5, isSelected: true, isHovered: true });
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.style.zIndex).toBe("225");
		expect(root.className).toContain("canvas-node-selected");
		expect(root.className).toContain("canvas-node-hovered");
	});

	test("leaves a selected or hovered group in the band it was ranked into", () => {
		// A group is a container: lifting it on hover/selection would paint it over
		// the cards it holds. Its feedback is the border and shadow instead.
		const container = renderNode(
			{ id: "g1", type: "group", ...base, label: "Group" },
			{ zIndex: 1, isSelected: true, isHovered: true },
		);
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.style.zIndex).toBe("1");
		expect(root.className).toContain("canvas-node-selected");
		expect(root.className).toContain("canvas-node-hovered");
	});
});

describe("CanvasNodeComponent interactions", () => {
	test("reports clicks and keyboard activation", () => {
		const clicked: string[] = [];
		const container = renderNode(textNode("hi"), { onClick: (id: string) => clicked.push(id) });
		const root = container.querySelector(".canvas-node") as HTMLElement;

		fireEvent.click(root);
		fireEvent.keyDown(root, { key: "Enter" });
		fireEvent.keyDown(root, { key: " " });
		fireEvent.keyDown(root, { key: "a" });

		expect(clicked).toEqual(["t1", "t1", "t1"]);
	});

	test("reports pointer hover on enter and leave", () => {
		const hovered: Array<string | null> = [];
		const container = renderNode(textNode("hi"), {
			onHover: (id: string | null) => hovered.push(id),
		});
		const root = container.querySelector(".canvas-node") as HTMLElement;

		fireEvent.mouseEnter(root);
		fireEvent.mouseLeave(root);

		expect(hovered).toEqual(["t1", null]);
	});

	test("stops inner links from selecting the node", () => {
		const clicked: string[] = [];
		const container = renderNode(
			{ id: "f7", type: "file", ...base, file: "Deep/Note.md" },
			{ onClick: (id: string) => clicked.push(id) },
		);
		const link = container.querySelector("a.canvas-file-fallback") as HTMLAnchorElement;

		fireEvent.click(link);

		expect(clicked).toEqual([]);
	});

	test("stops the file header link and the external link from selecting the node", () => {
		const headerClicks: string[] = [];
		const header = renderNode(
			{ id: "f8", type: "file", ...base, file: "Note.md", fileContent: "body" },
			{ onClick: (id: string) => headerClicks.push(id) },
		);
		fireEvent.click(header.querySelector("a.canvas-node-file-header-link") as HTMLAnchorElement);
		expect(headerClicks).toEqual([]);

		cleanup();

		const linkClicks: string[] = [];
		const external = renderNode(
			{ id: "l4", type: "link", ...base, url: "https://example.com" },
			{ onClick: (id: string) => linkClicks.push(id) },
		);
		fireEvent.click(external.querySelector("a") as HTMLAnchorElement);
		expect(linkClicks).toEqual([]);
	});
});
