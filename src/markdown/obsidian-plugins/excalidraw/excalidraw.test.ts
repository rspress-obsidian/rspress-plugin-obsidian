import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { findPublishedFileRoute, publishedFileRoutes } from "../../../shared/file-routes.js";
import { excalidrawFeature } from "./index.js";
import { stagingDir } from "./publish.js";
import {
	buildContext,
	compile,
	drawingNote,
	element,
	makeVault,
	PNG,
	sceneJson,
	vaultIndex,
	vaultOptions,
} from "./test-helpers.js";

const warnings: string[] = [];
let restoreWarn = (): void => undefined;
beforeEach(() => {
	warnings.length = 0;
	const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	restoreWarn = () => spy.mockRestore();
});
afterEach(() => restoreWarn());

const box = element("rectangle", {
	id: "box",
	x: 0,
	y: 0,
	width: 220,
	height: 100,
	backgroundColor: "#a5d8ff",
	boundElements: [{ type: "text", id: "label" }],
	groupIds: ["g1"],
});
const label = element("text", {
	id: "label",
	x: 40,
	y: 37,
	width: 140,
	height: 25,
	text: "Plan Target",
	originalText: "Plan Target",
	textAlign: "center",
	verticalAlign: "middle",
	containerId: "box",
	groupIds: ["g1"],
});
const circle = element("ellipse", { id: "circle", x: 400, y: 0, width: 140, height: 120 });
const photo = element("image", {
	id: "photo",
	x: 0,
	y: 200,
	width: 80,
	height: 80,
	fileId: "img1",
});

function demoVault(extra: Record<string, string | Buffer> = {}): string {
	return makeVault({
		"Drawing.excalidraw.md": drawingNote(sceneJson([box, label, circle, photo]), {
			back: "Notes on the **plan**.",
			textElements: { label: "Plan [[Target]]" },
			elementLinks: { circle: "[[Kanban Board]]" },
			embeddedFiles: { img1: "[[photo.png]]" },
		}),
		"Target.md": "# Target\n",
		"Kanban Board.md": "# Board\n",
		"photo.png": PNG,
		"Plain.excalidraw": sceneJson([element("diamond", { id: "d1", link: "[[Target]]" })]),
		...extra,
	});
}

describe("a drawing note's page", () => {
	test("renders the scene as SVG, then the back of the note, without the plugin's banner or data", async () => {
		const root = demoVault();
		const { html } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toContain('<div class="excalidraw-drawing"><svg');
		expect(html).toContain('aria-label="Drawing.excalidraw"');
		expect(html).toContain("<strong>plan</strong>");
		expect(html).not.toContain("Switch to EXCALIDRAW VIEW");
		expect(html).not.toContain("Text Elements");
		expect(html).not.toContain("compressed-json");
		// The drawing comes before the back of the note.
		expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("<strong>plan</strong>"));
	});

	test("shows a text element's wikilink as its text and links the element to the note", async () => {
		const root = demoVault();
		const { html } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toMatch(/<a href="\/vault\/Target">.*>Plan Target<\/text>/s);
		expect(html).not.toContain("[[Target]]");
	});

	test("links an element through ## Element Links, with the site base", async () => {
		const root = demoVault();
		const { html } = await compile(
			root,
			"Drawing.excalidraw.md",
			vaultOptions(root),
			undefined,
			"/docs/",
		);
		expect(html).toContain('<a href="/docs/vault/Kanban%20Board">');
	});

	test("draws an embedded vault image from its published URL", async () => {
		const root = demoVault();
		const { html } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toContain('<image href="/vault/photo.png"');
	});

	test("reports a broken element link through onBrokenLink and leaves the element unlinked", async () => {
		const root = demoVault({
			"Drawing.excalidraw.md": drawingNote(sceneJson([box, label]), {
				elementLinks: { box: "[[Nowhere]]" },
			}),
		});
		const { html, messages } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toContain('class="excalidraw-unresolved-link"');
		expect(messages.join("\n")).toContain('[[Nowhere]] in drawing "Drawing.excalidraw.md"');
		await expect(
			compile(root, "Drawing.excalidraw.md", vaultOptions(root, { onBrokenLink: "error" })),
		).rejects.toThrow("failed to resolve");
	});

	test("shows a corrupt drawing's error in place and reports it", async () => {
		const root = demoVault({
			"Broken.excalidraw.md":
				"---\nexcalidraw-plugin: parsed\n---\n\n%%\n## Drawing\n```compressed-json\n@@@not-base64@@@\n```\n%%\n",
		});
		const { html, messages } = await compile(root, "Broken.excalidraw.md", vaultOptions(root));
		expect(html).toContain(
			'<div class="excalidraw-error">Excalidraw: drawing "Broken.excalidraw.md" cannot be shown',
		);
		expect(messages.join("\n")).toContain("could not be decompressed");
		await expect(
			compile(root, "Broken.excalidraw.md", vaultOptions(root, { onPluginError: "error" })),
		).rejects.toThrow();
	});

	test("leaves an ordinary note alone", async () => {
		const root = demoVault();
		const { html } = await compile(root, "Target.md", vaultOptions(root));
		expect(html).not.toContain("excalidraw");
	});
});

describe("embeds", () => {
	test("![[Drawing]] and ![[Drawing.excalidraw]] draw the picture at the default width", async () => {
		const root = demoVault({ "Note.md": "![[Drawing]]\n\n![[Drawing.excalidraw]]\n" });
		const { html } = await compile(root, "Note.md", vaultOptions(root));
		const embeds = html.match(
			/<span class="internal-embed media-embed image-embed excalidraw-embed"/g,
		);
		expect(embeds).toHaveLength(2);
		expect(html).toContain('<svg style="width:400px" version="1.1"');
		expect(html).toContain('class="excalidraw-svg excalidraw-embedded-img"');
	});

	test("a width and a width×height alias size the embed", async () => {
		const root = demoVault({
			"Note.md":
				"![[Drawing.excalidraw|300]] ![[Drawing.excalidraw|300x200]] ![[Drawing.excalidraw|x150]]",
		});
		const { html } = await compile(root, "Note.md", vaultOptions(root));
		expect(html).toContain('style="width:300px"');
		expect(html).toContain('style="width:300px;min-height:200px"');
		expect(html).toContain('style="max-height:150px"');
	});

	test("#^group= draws only the group, #^id crops to the element", async () => {
		const root = demoVault({
			"Note.md": "![[Drawing.excalidraw#^group=box]]\n\n![[Drawing.excalidraw#^circle]]\n",
		});
		const { html } = await compile(root, "Note.md", vaultOptions(root));
		const [group, crop] = html.split('<span class="internal-embed');
		const svgs = html.match(/<svg[^>]*viewBox="([^"]+)"/g) ?? [];
		expect(svgs).toHaveLength(2);
		expect(svgs[0]).toContain('viewBox="0 0 240 120"');
		expect(svgs[1]).toContain('viewBox="0 0 160 140"');
		expect(group).toBeDefined();
		expect(crop).toBeDefined();
		const groupSvg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
		expect(groupSvg).not.toContain("Kanban%20Board");
		expect(groupSvg).toContain(">Plan Target</text>");
	});

	test("a missing element is reported and the whole drawing shown", async () => {
		const root = demoVault({ "Note.md": "![[Drawing.excalidraw#^nope]]" });
		const { html, messages } = await compile(root, "Note.md", vaultOptions(root));
		expect(messages.join("\n")).toContain('no element with id "nope"');
		expect(html).toContain("Kanban%20Board");
	});

	test("a plain .excalidraw file embeds too", async () => {
		const root = demoVault({ "Note.md": "![[Plain.excalidraw]]" });
		const { html } = await compile(root, "Note.md", vaultOptions(root));
		expect(html).toContain('data-src="Plain.excalidraw"');
		expect(html).toContain('<a href="/vault/Target">');
	});

	test("an image embed is left to the media embeds", async () => {
		const root = demoVault({ "Note.md": "![[photo.png]]" });
		const { html } = await compile(root, "Note.md", vaultOptions(root));
		expect(html).not.toContain("excalidraw");
		expect(html).toContain('<img src="/vault/photo.png"');
	});
});

describe("plain .excalidraw files", () => {
	test("addPages publishes each at a route under the vault prefix and registers it", async () => {
		const root = demoVault();
		const index = await vaultIndex(root);
		const options = vaultOptions(root);
		const pages = (await excalidrawFeature.addPages?.(buildContext(root, index, options))) ?? [];
		expect(pages).toEqual([
			{
				routePath: "/vault/Plain.excalidraw",
				content: `---\ntitle: "Plain"\n---\n\n{/* excalidraw-file: "Plain.excalidraw" */}\n`,
			},
		]);
		expect(findPublishedFileRoute(path.join(root, "Plain.excalidraw"))?.routePath).toBe(
			"/vault/Plain.excalidraw",
		);
		// The drawing's image is staged where the content index serves it.
		expect(fs.existsSync(path.join(stagingDir(options), "vault", "photo.png"))).toBe(true);
	});

	test("[[Plain.excalidraw]] links to the page, which draws the file", async () => {
		const root = demoVault({ "Note.md": "See [[Plain.excalidraw]]." });
		const index = await vaultIndex(root);
		const options = vaultOptions(root);
		const pages = (await excalidrawFeature.addPages?.(buildContext(root, index, options))) ?? [];
		const note = await compile(root, "Note.md", options, index);
		expect(note.html).toContain('<a href="/vault/Plain.excalidraw">Plain.excalidraw</a>');

		// The page is compiled from a temp file outside the vault, as Rspress does.
		const temp = makeVault({ "temp-1.mdx": pages[0]?.content ?? "" });
		const page = await compile(root, path.join(temp, "temp-1.mdx"), options, index);
		expect(page.html).toContain('<div class="excalidraw-drawing"><svg');
		expect(page.html).toContain('<a href="/vault/Target">');
		expect(publishedFileRoutes("excalidraw")).toHaveLength(1);
	});

	test("a note that claims a plain drawing's route keeps it", async () => {
		const root = demoVault({ "Plain.excalidraw.md": "# A note\n" });
		const index = await vaultIndex(root);
		const pages =
			(await excalidrawFeature.addPages?.(buildContext(root, index, vaultOptions(root)))) ?? [];
		expect(pages).toEqual([]);
		expect(warnings.join("\n")).toContain("a note already has the route /vault/Plain.excalidraw");
	});
});

describe("auto-exported images", () => {
	const exported = {
		"Drawing.excalidraw.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
		"Drawing.excalidraw.light.png": PNG,
		"Drawing.excalidraw.dark.png": PNG,
	};

	test("are shown instead of the scene when preferExportedImage is on", async () => {
		const root = demoVault({ ...exported, "Note.md": "![[Drawing.excalidraw]]" });
		const options = vaultOptions(root, { excalidraw: { preferExportedImage: true } });
		const { html } = await compile(root, "Note.md", options);
		expect(html).toContain(
			'<img class="excalidraw-svg excalidraw-embedded-img excalidraw-exported" src="/vault/Drawing.excalidraw.svg"',
		);
		expect(html).not.toContain("<svg");
	});

	test("a light/dark pair follows the site theme in auto mode", async () => {
		const root = demoVault({
			"Drawing.excalidraw.light.svg": "<svg/>",
			"Drawing.excalidraw.dark.svg": "<svg/>",
		});
		const options = vaultOptions(root, {
			excalidraw: { preferExportedImage: true, theme: "auto" },
		});
		const { html } = await compile(root, "Drawing.excalidraw.md", options);
		expect(html).toContain('excalidraw-exported-light" src="/vault/Drawing.excalidraw.light.svg"');
		expect(html).toContain('excalidraw-exported-dark" src="/vault/Drawing.excalidraw.dark.svg"');
	});

	test("are ignored by default, and for a crop", async () => {
		const root = demoVault({
			...exported,
			"Note.md": "![[Drawing.excalidraw]] ![[Drawing.excalidraw#^circle]]",
		});
		const byDefault = await compile(root, "Note.md", vaultOptions(root));
		expect(byDefault.html).not.toContain("excalidraw-exported");
		const preferred = await compile(
			root,
			"Note.md",
			vaultOptions(root, { excalidraw: { preferExportedImage: true } }),
		);
		expect(preferred.html.match(/excalidraw-exported/g)).toHaveLength(1);
		expect(preferred.html).toContain("<svg");
	});

	test("the vault's displayExportedImageIfAvailable turns the preference on", async () => {
		const root = demoVault({
			...exported,
			".obsidian/plugins/obsidian-excalidraw-plugin/data.json": JSON.stringify({
				displayExportedImageIfAvailable: true,
			}),
		});
		const { html } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toContain('src="/vault/Drawing.excalidraw.svg"');
	});
});

describe("page data", () => {
	test("a drawing page is titled by its name, its outline and search text cut at the data", async () => {
		const root = demoVault();
		const filepath = path.join(root, "Drawing.excalidraw.md");
		const content = fs.readFileSync(filepath, "utf8");
		const page = {
			title: "Excalidraw Data",
			toc: [{ text: "Back" }, { text: "Excalidraw Data" }, { text: "Text Elements" }],
			content,
			_filepath: filepath,
		};
		await excalidrawFeature.extendPageData?.(page as never, true);
		expect(page.title).toBe("Drawing.excalidraw");
		expect(page.toc).toEqual([{ text: "Back" }]);
		await excalidrawFeature.modifySearchIndexData?.([page] as never, true);
		expect(page.content).not.toContain("compressed-json");
		expect(page.content).toContain("Plan [[Target]]");
	});
});

describe("```excalidraw fences", () => {
	test("draw the scene JSON they hold", async () => {
		const root = demoVault({
			"Fence.md": `\`\`\`excalidraw\n${sceneJson([element("ellipse", { id: "e" })])}\n\`\`\`\n`,
		});
		const { html } = await compile(root, "Fence.md", vaultOptions(root));
		expect(html).toContain('<div class="excalidraw-drawing"><svg');
	});

	test("report a fence that is not a scene", async () => {
		const root = demoVault({ "Fence.md": "```excalidraw\n{ nope\n```\n" });
		const { html, messages } = await compile(root, "Fence.md", vaultOptions(root));
		expect(html).toContain("excalidraw-error");
		expect(messages.join("\n")).toContain("not valid JSON");
	});
});
