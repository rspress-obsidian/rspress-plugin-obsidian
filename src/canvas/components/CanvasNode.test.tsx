import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { CanvasFileData, CanvasNode, CanvasTextData } from "../types";
import { CanvasNodeComponent, type CanvasNodeProps, cardLabel } from "./CanvasNode";

declare global {
	// happy-dom attaches its live settings to the global (see test/test-setup.ts).
	var happyDOM: { settings: { disableIframePageLoading?: boolean } } | undefined;
}

afterEach(cleanup);

type ExtraNodeProps = Omit<CanvasNodeProps, "node">;

/**
 * Happy-dom would fetch an embedded iframe's src over the real network, and logs a
 * (harmless) error when page loading is disabled. Neither affects the rendered
 * element, so both are suppressed around the render and restored afterwards.
 */
function renderNode(node: CanvasNode, props: ExtraNodeProps = {}) {
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

function textNode(text: string, extra: Partial<CanvasTextData> = {}): CanvasTextData {
	return { id: "t1", type: "text", ...base, text, ...extra };
}

function fileNode(file: string, extra: Partial<CanvasFileData> = {}): CanvasFileData {
	return { id: "f1", type: "file", ...base, file, ...extra };
}

describe("CanvasNodeComponent text nodes", () => {
	test("renders a callout, a resolved wikilink and a mermaid placeholder from markdown", () => {
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
			{ links: { "": { "Page Name": { href: "/vault/notes/page-name" } } } },
		);

		expect(container.querySelector(".canvas-node")?.className).toContain("canvas-node-text");
		const callout = container.querySelector(".canvas-callout-note") as HTMLElement;
		expect(callout.querySelector(".canvas-callout-title")?.textContent).toBe("Heads up");
		expect(callout.querySelector(".canvas-callout-body strong")?.textContent).toBe("bold");

		const wikiLink = container.querySelector("a.wiki-link") as HTMLAnchorElement;
		expect(wikiLink.getAttribute("href")).toBe("/vault/notes/page-name");
		expect(wikiLink.textContent).toBe("the page");

		const mermaid = container.querySelector("pre.obsidian-mermaid-block") as HTMLElement;
		expect(mermaid.getAttribute("data-code")).toContain("graph TD;");
	});

	test("prefixes footnote ids per card so two cards never share an id", () => {
		const one = renderNode(textNode("a[^1]\n\n[^1]: note", { id: "c1" }), { idPrefix: "b1-" });
		const ids = [...one.querySelectorAll("[id]")].map((element) => element.id);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(id.startsWith("b1-c1-")).toBe(true);
	});

	test("renders no content for an unknown node type, unlike a known one", () => {
		const container = renderNode({ id: "x", type: "future", ...base } as unknown as CanvasNode);
		expect(container.querySelector(".canvas-node")).toBeTruthy();
		expect(container.querySelector(".canvas-node-content")).toBeNull();
		cleanup();
		expect(renderNode(textNode("hi")).querySelector(".canvas-node-content")).not.toBeNull();
	});
});

describe("CanvasNodeComponent file nodes", () => {
	const assets = {
		"media/pic.png": "/vault/media/pic.png",
		"clip.mp3": "/vault/clip.mp3",
		"movie.mp4": "/vault/movie.mp4",
		"doc.pdf": "/vault/doc.pdf",
		"archive.zip": "/vault/archive.zip",
	};

	test("draws an image node as the bare picture with its name above, like Obsidian", () => {
		const container = renderNode(
			fileNode("media/pic.png", { resolvedFile: { kind: "image", key: "media/pic.png" } }),
			{ assets },
		);
		const image = container.querySelector("img.canvas-file-image") as HTMLImageElement;
		expect(image.getAttribute("src")).toBe("/vault/media/pic.png");
		expect(container.querySelector(".canvas-node-label")?.textContent).toBe("pic.png");
		expect(container.querySelector(".canvas-node")?.className).toContain("canvas-file-image");
	});

	test("plays audio and video from their published URLs", () => {
		const container = renderNode(
			fileNode("clip.mp3", { resolvedFile: { kind: "audio", key: "clip.mp3" } }),
			{ assets },
		);
		expect(container.querySelector("audio")?.getAttribute("src")).toBe("/vault/clip.mp3");
		cleanup();
		const video = renderNode(
			fileNode("movie.mp4", { resolvedFile: { kind: "video", key: "movie.mp4" } }),
			{ assets },
		);
		expect(video.querySelector("video")?.getAttribute("src")).toBe("/vault/movie.mp4");
	});

	test("renders a PDF in an unsandboxed frame, which Chromium's viewer requires", () => {
		const container = renderNode(
			fileNode("doc.pdf", { subpath: "#page=3", resolvedFile: { kind: "pdf", key: "doc.pdf" } }),
			{ assets, iframeSandbox: "allow-scripts" },
		);
		const frame = container.querySelector("iframe.canvas-file-pdf") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe("/vault/doc.pdf#page=3");
		expect(frame.hasAttribute("sandbox")).toBe(false);
	});

	test("offers a download for a file type it cannot show", () => {
		const container = renderNode(
			fileNode("archive.zip", { resolvedFile: { kind: "file", key: "archive.zip" } }),
			{ assets },
		);
		const link = container.querySelector("a[download]") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/vault/archive.zip");
	});

	test("links a file node naming another board to that board's page", () => {
		const container = renderNode(
			fileNode("Other.canvas", { resolvedFile: { kind: "canvas", href: "/canvas/other" } }),
		);
		expect(container.querySelector("a.canvas-file-open")?.getAttribute("href")).toBe(
			"/canvas/other",
		);
	});

	test("drops an unsafe asset url", () => {
		const container = renderNode(
			fileNode("x.png", { resolvedFile: { kind: "image", key: "x.png" } }),
			{ assets: { "x.png": "javascript:alert(1)" } },
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.innerHTML).not.toContain("javascript:");
	});

	test("slices a note card with the shared slicer: nested headings keep their fences", () => {
		const note =
			"# Parent\n\n## Child\n\n```bash\n# not a heading\n```\n\nchild body\n\n# Other\n\nother";
		const container = renderNode(
			fileNode("Notes/Deep.md", {
				subpath: "#Parent#Child",
				resolvedFile: { kind: "note", key: "notes/deep.md", href: "/vault/notes/deep#child" },
			}),
			{ notes: { "notes/deep.md": note } },
		);
		expect(container.querySelector("pre code")?.textContent).toContain("# not a heading");
		expect(container.textContent).toContain("child body");
		expect(container.textContent).not.toContain("other");
		const label = container.querySelector(".canvas-node-label a") as HTMLAnchorElement;
		expect(label.getAttribute("href")).toBe("/vault/notes/deep#child");
		expect(label.textContent).toBe("Deep › Parent#Child");
	});

	test("shows the whole note, and says so, when the subpath names nothing", () => {
		const container = renderNode(
			fileNode("Note.md", {
				subpath: "#Nope",
				resolvedFile: { kind: "note", key: "note.md", href: "/vault/note", missingSubpath: true },
			}),
			{ notes: { "note.md": "# Title\n\nall of it" } },
		);
		expect(container.textContent).toContain("all of it");
		expect(container.querySelector(".canvas-file-notice")?.textContent).toContain("Nope");
	});

	test("shows a private or missing note the same way, without its content", () => {
		for (const kind of ["private", "missing"] as const) {
			const container = renderNode(fileNode("Secret.md", { resolvedFile: { kind } }));
			expect(container.querySelector(".canvas-file-error-text")?.textContent).toContain(
				"Secret.md",
			);
			cleanup();
		}
	});

	test("without build data, links a note to its route and names anything else", () => {
		const note = renderNode(fileNode("Deep/Note.md", { subpath: "#Intro" }), {
			fileRoutePrefix: "/vault",
		});
		expect(note.querySelector(".canvas-node-label a")?.getAttribute("href")).toBe(
			"/vault/Deep/Note#intro",
		);
		cleanup();
		const other = renderNode(fileNode("data.bin"));
		expect(other.querySelector("a")).toBeNull();
		expect(other.querySelector(".canvas-file-name")?.textContent).toBe("data");
	});
});

describe("CanvasNodeComponent link nodes", () => {
	test("embeds the site in a sandboxed, lazy frame by default, like Obsidian", () => {
		const container = renderNode(
			{ id: "l3", type: "link", ...base, url: "https://example.com/page" },
			{ iframeSandbox: "allow-forms" },
		);
		const frame = container.querySelector("iframe") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe("https://example.com/page");
		expect(frame.getAttribute("sandbox")).toBe("allow-forms");
		expect(frame.getAttribute("loading")).toBe("lazy");
		expect(container.querySelector(".canvas-node-label")?.textContent).toBe("example.com/page");
	});

	test("renders a plain external anchor when previews are off", () => {
		const container = renderNode(
			{ id: "l1", type: "link", ...base, url: "https://example.com/page" },
			{ linkPreview: false },
		);
		expect(container.querySelector("iframe")).toBeNull();
		const anchor = container.querySelector("a") as HTMLAnchorElement;
		expect(anchor.getAttribute("href")).toBe("https://example.com/page");
		expect(anchor.getAttribute("target")).toBe("_blank");
		expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
	});

	test("never emits a javascript: url, as a link or as a frame", () => {
		const container = renderNode({
			id: "l2",
			type: "link",
			...base,
			url: "javascript:alert(document.cookie)",
		});
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector(".canvas-link span")?.textContent).toBe(
			"javascript:alert(document.cookie)",
		);
	});
});

describe("CanvasNodeComponent group nodes", () => {
	test("labels the group above its box and repeats a published background", () => {
		const container = renderNode(
			{
				id: "g1",
				type: "group",
				...base,
				label: "Chapter one",
				background: "bg.png",
				resolvedBackground: "bg.png",
				backgroundStyle: "repeat",
			},
			{ assets: { "bg.png": "/vault/bg.png" } },
		);
		expect(container.querySelector(".canvas-group-label")?.textContent).toBe("Chapter one");
		const group = container.querySelector(".canvas-group") as HTMLElement;
		expect(group.style.backgroundImage).toBe('url("/vault/bg.png")');
		expect(group.style.backgroundRepeat).toBe("repeat");
		expect(group.style.backgroundSize).toBe("auto");
	});

	test("scales a ratio background to contain, and accepts a remote one", () => {
		const container = renderNode({
			id: "g2",
			type: "group",
			...base,
			background: "https://cdn.example/bg.png",
			backgroundStyle: "ratio",
		});
		const group = container.querySelector(".canvas-group") as HTMLElement;
		expect(group.style.backgroundImage).toBe('url("https://cdn.example/bg.png")');
		expect(group.style.backgroundSize).toBe("contain");
	});

	test("drops an unsafe background url", () => {
		const container = renderNode(
			{ id: "g3", type: "group", ...base, resolvedBackground: "x" },
			{ assets: { x: "javascript:alert(1)" } },
		);
		expect((container.querySelector(".canvas-group") as HTMLElement).style.backgroundImage).toBe(
			"",
		);
	});

	test("hands the group colour to the stylesheet for the border, tint and label", () => {
		const container = renderNode({ id: "g4", type: "group", ...base, color: "3", label: "G" });
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.className).toContain("canvas-node-colored");
		expect(root.style.getPropertyValue("--canvas-node-accent")).toBe("var(--canvas-color-3)");
	});
});

describe("CanvasNodeComponent presentation", () => {
	test("treats a custom colour like a preset: an accent, never an opaque background", () => {
		const container = renderNode(textNode("hi", { color: "#123456" }));
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.className).toContain("canvas-node-colored");
		expect(root.style.getPropertyValue("--canvas-node-accent")).toBe("#123456");
		expect(root.style.backgroundColor).toBe("");
	});

	test("ignores a malformed colour and keeps the theme default", () => {
		const container = renderNode(textNode("hi", { color: "red; x: y" }));
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.className).not.toContain("canvas-node-colored");
		expect(root.getAttribute("style")).toBeNull();
	});

	test("marks the selected and hovered classes", () => {
		const container = renderNode(textNode("hi"), { isSelected: true, isHovered: true });
		const root = container.querySelector(".canvas-node") as HTMLElement;
		expect(root.className).toContain("canvas-node-selected");
		expect(root.className).toContain("canvas-node-hovered");
	});

	test("names cards by what they show, not by their type", () => {
		expect(cardLabel(textNode("# Plan **A**\n\nbody"))).toBe("Plan A");
		expect(cardLabel(textNode("See [[Note|the note]]"))).toBe("See the note");
		expect(cardLabel(fileNode("a/b/Deep.md"))).toBe("Deep.md");
		expect(cardLabel({ id: "g", type: "group", ...base })).toBe("Group");
	});
});
