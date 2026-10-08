import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MERMAID_BLOCK_CLASS, MERMAID_SECURITY_ATTRIBUTE } from "../../../mermaid/classes.js";
import { excalidrawFeature } from "./index.js";
import { stagingDir } from "./publish.js";
import {
	buildContext,
	compile,
	drawingNote,
	element,
	makeVault,
	sceneJson,
	vaultIndex,
	vaultOptions,
} from "./test-helpers.js";

spyOn(console, "warn").mockImplementation(() => undefined);

const PIE = 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2';

/** A drawing with a Mermaid diagram the plugin placed as an image. */
function mermaidVault(): string {
	return makeVault({
		"Diagram.excalidraw.md": drawingNote(
			sceneJson([
				element("image", {
					id: "m1",
					x: 10,
					y: 20,
					width: 300,
					height: 200,
					fileId: "mermaid-file",
					customData: { mermaidText: PIE },
				}),
			]),
		),
	});
}

/** A drawing showing page 3 of a vault PDF, and one cropped to a region of page 2. */
function pdfVault(): string {
	return makeVault({
		"docs/Report.pdf": "%PDF-1.4\n%%EOF\n",
		"Paper.excalidraw.md": drawingNote(
			sceneJson([
				element("image", { id: "p1", width: 200, height: 280, fileId: "pdf1" }),
				element("image", { id: "p2", x: 300, width: 200, height: 100, fileId: "pdf2" }),
			]),
			{
				embeddedFiles: {
					pdf1: "[[docs/Report.pdf#page=3]]",
					pdf2: "[[Report.pdf#page=2&rect=10,20,300,400]]",
				},
			},
		),
	});
}

describe("a Mermaid diagram inside a drawing", () => {
	test("is the site's Mermaid placeholder, in the image's box, when enableMermaid is on", async () => {
		const root = mermaidVault();
		const { html, messages } = await compile(
			root,
			"Diagram.excalidraw.md",
			vaultOptions(root, { enableMermaid: true, mermaidSecurityLevel: "loose" }),
		);
		const box =
			/<g transform="translate\(10 10\)[^"]*" opacity="1"><foreignObject width="300" height="200"><div xmlns="http:\/\/www.w3.org\/1999\/xhtml" class="excalidraw-embedded-mermaid">(.*?)<\/foreignObject>/s.exec(
				html,
			)?.[1];
		expect(box).toBeDefined();
		// The same contract a ```mermaid fence emits, so MermaidBlocks draws it.
		expect(box).toContain(
			`<div class="${MERMAID_BLOCK_CLASS}" ${MERMAID_SECURITY_ATTRIBUTE}="loose" data-code="pie title Pets\n  &quot;Dogs&quot; : 3\n  &quot;Cats&quot; : 2">`,
		);
		expect(box).toContain('<span class="excalidraw-embed-label">Mermaid</span>');
		// Not a missing file: the diagram is in the element itself.
		expect(html).not.toContain("excalidraw-missing-image");
		expect(messages.join("\n")).not.toContain("has no file");
	});

	test("shows its source in a labelled box, and says why, when enableMermaid is off", async () => {
		const root = mermaidVault();
		const { html, messages } = await compile(root, "Diagram.excalidraw.md", vaultOptions(root));
		expect(html).toContain(
			'<span class="excalidraw-embed-label">Mermaid</span><div class="excalidraw-mermaid-source">pie title Pets\n  "Dogs" : 3\n  "Cats" : 2</div>',
		);
		expect(html).not.toContain(MERMAID_BLOCK_CLASS);
		expect(messages.join("\n")).toContain(
			'A Mermaid diagram in drawing "Diagram.excalidraw.md" is shown as its source: `enableMermaid` is off.',
		);
	});
});

describe("a PDF page inside a drawing", () => {
	test("is the served PDF at its page, under the site base, with a link to fall back on", async () => {
		const root = pdfVault();
		const { html } = await compile(
			root,
			"Paper.excalidraw.md",
			vaultOptions(root),
			undefined,
			"/sub/",
		);
		expect(html).toContain(
			'<foreignObject width="200" height="280" data-bitmap=""><div xmlns="http://www.w3.org/1999/xhtml" class="excalidraw-embedded-pdf"><object data="/sub/vault/docs/Report.pdf#page=3&amp;toolbar=0&amp;view=Fit" type="application/pdf" aria-label="Report.pdf, page 3">',
		);
		expect(html).toContain(
			'<a class="excalidraw-pdf-link" href="/sub/vault/docs/Report.pdf#page=3" target="_blank" rel="noopener noreferrer">',
		);
		expect(html).toContain('<span class="excalidraw-pdf-page">page 3</span>');
	});

	test("a region crop shows the whole page and is reported", async () => {
		const root = pdfVault();
		const { html, messages } = await compile(root, "Paper.excalidraw.md", vaultOptions(root));
		expect(html).toContain('data="/vault/docs/Report.pdf#page=2&amp;toolbar=0&amp;view=Fit"');
		expect(messages.join("\n")).toContain(
			'![[Report.pdf#page=2&rect=10,20,300,400]] in drawing "Paper.excalidraw.md": a browser\'s PDF viewer cannot crop to a region, so the whole page is shown.',
		);
	});

	test("in a dark drawing the page is turned back, as Excalidraw turns back a bitmap", async () => {
		const root = pdfVault();
		const { html } = await compile(
			root,
			"Paper.excalidraw.md",
			vaultOptions(root, { excalidraw: { theme: "dark" } }),
		);
		expect(html).toContain(
			'data-bitmap="" filter="invert(100%) hue-rotate(180deg) saturate(1.25)"><div xmlns="http://www.w3.org/1999/xhtml" class="excalidraw-embedded-pdf">',
		);
	});

	test("is staged with the site, as the drawing's images are", async () => {
		const root = pdfVault();
		const index = await vaultIndex(root);
		const options = vaultOptions(root);
		await excalidrawFeature.addPages?.(buildContext(root, index, options));
		const staged = path.join(stagingDir(options), "vault", "docs", "Report.pdf");
		expect(fs.readFileSync(staged, "utf8")).toBe("%PDF-1.4\n%%EOF\n");
	});
});
