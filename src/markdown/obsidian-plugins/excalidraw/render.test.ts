import { describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { parseDrawingNote } from "./drawing-file.js";
import { excalidrawFontFaces, excalidrawFontsDir, fontFaceCss, unicodeRange } from "./fonts.js";
import { estimateMeasurer } from "./measure.js";
import { renderSceneSvg } from "./render.js";
import { normalizeScene, parseSceneJson, SceneError } from "./scene.js";
import {
	compile,
	drawingNote,
	element,
	makeVault,
	PNG,
	sceneJson,
	vaultOptions,
} from "./test-helpers.js";
import { wrapAtCharLength } from "./text.js";

spyOn(console, "warn").mockImplementation(() => undefined);

function svgOf(
	elements: Record<string, unknown>[],
	theme: "light" | "dark" | "auto" = "light",
): string {
	const scene = parseSceneJson(sceneJson(elements));
	return renderSceneSvg({
		scene,
		elements: scene.elements,
		frameRendering: scene.appState.frameRendering,
		padding: 10,
		background: true,
		theme,
		links: new Map(),
		images: new Map(),
		fontCss: "",
		idPrefix: "t-",
		label: "Test",
		className: "excalidraw-svg",
		measure: estimateMeasurer,
	});
}

describe("parsing the plugin's note format", () => {
	const json = sceneJson([element("text", { id: "t1", text: "old", originalText: "old" })]);
	for (const format of ["compressed", "json"] as const) {
		for (const comment of [true, false]) {
			for (const heading of ["#", "##"] as const) {
				test(`${format}, ${comment ? "inside" : "without"} %%, ${heading} Drawing`, () => {
					const note = parseDrawingNote(
						drawingNote(json, { format, comment, heading, textElements: { t1: "New [[Link]]" } }),
					);
					expect(note.scene.elements[0]?.type).toBe("text");
					expect(note.textElements.get("t1")).toBe("New [[Link]]");
				});
			}
		}
	}

	test("reads element links, embedded files, URLs and formulas", () => {
		const note = parseDrawingNote(
			drawingNote(sceneJson([element("rectangle", { id: "r1" })]), {
				elementLinks: { r1: "[[Target]]" },
				embeddedFiles: { f1: "[[photo.png]]", f2: "https://example.com/a.png", f3: "$$E=mc^2$$" },
			}),
		);
		expect(note.scene.elements[0]?.link).toBe("[[Target]]");
		expect([...note.embeddedFiles.values()].map((file) => file.kind)).toEqual([
			"link",
			"url",
			"latex",
		]);
	});

	test("rejects a note without a drawing and a scene without elements", () => {
		expect(() => parseDrawingNote("---\nexcalidraw-plugin: parsed\n---\n")).toThrow(SceneError);
		expect(() => normalizeScene({})).toThrow("no `elements` array");
		expect(() => parseSceneJson("{")).toThrow("not valid JSON");
	});
});

describe("every element type draws its SVG primitives", () => {
	test("shapes, fills, dashes, rotation and opacity", () => {
		const svg = svgOf([
			element("rectangle", {
				roundness: { type: 3 },
				fillStyle: "hachure",
				backgroundColor: "#a5d8ff",
			}),
			element("diamond", {
				x: 200,
				fillStyle: "cross-hatch",
				backgroundColor: "#ffec99",
				roundness: { type: 2 },
			}),
			element("diamond", { x: 400, backgroundColor: "#ffec99" }),
			element("ellipse", {
				x: 600,
				fillStyle: "zigzag",
				backgroundColor: "#b2f2bb",
				strokeStyle: "dashed",
			}),
			element("rectangle", { y: 200, angle: Math.PI / 4, opacity: 40, strokeStyle: "dotted" }),
		]);
		expect(svg).toContain('stroke-dasharray="8 10"');
		expect(svg).toContain('stroke-dasharray="1.5 8"');
		expect(svg).toContain("rotate(45 50 30)");
		expect(svg).toContain('stroke-opacity="0.4" fill-opacity="0.4"');
		expect(svg).toContain('stroke="#a5d8ff" stroke-width="1" fill="none"');
		expect(svg).toContain('<rect class="excalidraw-background"');
	});

	test("arrows with every arrowhead, lines, elbows and freedraw", () => {
		const heads = [
			"arrow",
			"bar",
			"dot",
			"circle",
			"circle_outline",
			"triangle",
			"triangle_outline",
			"diamond",
			"diamond_outline",
			"crowfoot_one",
			"crowfoot_many",
			"crowfoot_one_or_many",
		];
		const svg = svgOf([
			...heads.map((head, i) =>
				element("arrow", {
					y: i * 40,
					points: [
						[0, 0],
						[120, 0],
					],
					startArrowhead: "dot",
					endArrowhead: head,
					strokeStyle: i === 0 ? "dotted" : "solid",
				}),
			),
			element("arrow", {
				y: 600,
				elbowed: true,
				points: [
					[0, 0],
					[60, 0],
					[60, 60],
					[120, 60],
				],
			}),
			element("arrow", {
				y: 700,
				roundness: { type: 2 },
				points: [
					[0, 0],
					[60, 40],
					[120, 0],
				],
			}),
			element("line", {
				y: 800,
				backgroundColor: "#fab005",
				points: [
					[0, 0],
					[50, 50],
					[100, 0],
					[0, 0],
				],
			}),
			element("freedraw", {
				y: 900,
				points: [
					[0, 0],
					[10, 10],
					[20, 0],
					[30, 20],
				],
				pressures: [0.3, 0.5, 0.6, 0.4],
				simulatePressure: false,
			}),
			element("freedraw", {
				y: 1000,
				backgroundColor: "#ffc9c9",
				points: [
					[0, 0],
					[30, 10],
					[20, 30],
					[10, 20],
					[0, 1],
				],
			}),
		]);
		expect(svg).toContain('fill-rule="evenodd"');
		expect(svg.match(/<path fill="#1e1e1e" d="M /g)).toHaveLength(2);
		expect(svg.match(/stroke-linecap="round"/g)?.length).toBeGreaterThan(14);
	});

	test("text: multi-line, alignment, fonts, bound text and arrow labels", () => {
		const svg = svgOf([
			element("rectangle", { id: "box", boundElements: [{ type: "text", id: "inner" }] }),
			element("text", {
				id: "inner",
				text: "a\nb",
				containerId: "box",
				textAlign: "center",
				fontFamily: 6,
			}),
			element("text", { x: 200, text: "right", textAlign: "right", fontFamily: 8 }),
			element("text", { x: 300, text: "שלום" }),
			element("arrow", {
				id: "arr",
				y: 200,
				points: [
					[0, 0],
					[100, 0],
					[200, 0],
				],
				boundElements: [{ type: "text", id: "lbl" }],
			}),
			element("text", { id: "lbl", text: "label", containerId: "arr", width: 40, height: 25 }),
		]);
		expect(svg).toContain('text-anchor="middle"');
		expect(svg).toContain('text-anchor="end"');
		expect(svg).toContain('direction="rtl"');
		expect(svg).toContain('font-family="Nunito, Segoe UI Emoji');
		expect(svg).toContain('<mask id="t-mask-arr">');
		expect(svg.indexOf(">a</text>")).toBeGreaterThan(svg.indexOf("stroke-linecap"));
	});

	test("frames clip their children and carry their name; images, embeds and dark mode", () => {
		const svg = svgOf(
			[
				element("frame", { id: "f", name: "A very long frame name that will not fit", width: 80 }),
				element("ellipse", { frameId: "f" }),
				element("image", { y: 200, fileId: "missing" }),
				element("embeddable", { x: 300, link: "https://example.com", strokeColor: "transparent" }),
				element("iframe", { x: 500 }),
			],
			"dark",
		);
		expect(svg).toContain('<clipPath id="t-frame-f">');
		expect(svg).toContain('clip-path="url(#t-frame-f)"');
		expect(svg).toContain("...</text>");
		expect(svg).toContain('class="excalidraw-missing-image"');
		expect(svg).toContain(">https://example.com</text>");
		expect(svg).toContain(">IFrame element</text>");
		expect(svg).toContain('filter="invert(93%) hue-rotate(180deg)"');
	});
});

describe("drawing details through the pipeline", () => {
	test("inline image data, crops, flips, URL images, formulas, notes and nested drawings", async () => {
		const root = makeVault({
			"Inner.excalidraw": sceneJson([element("ellipse", { id: "in" })]),
			"Card.md": "# Card\n\nSome **text**.\n\n## Part\n\nPart body ^blk\n",
			"photo.png": PNG,
			"Drawing.excalidraw.md": drawingNote(
				sceneJson(
					[
						element("image", {
							fileId: "inline",
							crop: { x: 1, y: 1, width: 1, height: 1, naturalWidth: 2, naturalHeight: 2 },
							scale: [-1, 1],
							roundness: { type: 3 },
						}),
						element("image", { x: 200, fileId: "url" }),
						element("image", { x: 400, fileId: "tex" }),
						element("image", { x: 600, fileId: "note" }),
						element("image", { x: 800, fileId: "nested" }),
						element("image", { x: 1000, fileId: "self" }),
						element("image", { x: 1200, fileId: "nofile" }),
						element("text", { id: "tr", y: 300, text: "x", originalText: "x" }),
						element("text", { id: "md", y: 400, text: "x", originalText: "x" }),
						element("rectangle", { id: "web", y: 500, link: "https://example.com" }),
						element("rectangle", { id: "local", y: 600, link: "/guide" }),
						element("rectangle", { id: "bad", y: 700, link: "javascript:alert(1)" }),
					],
					{ files: { inline: { mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" } } },
				),
				{
					textElements: {
						tr: "![[Card#^blk]]",
						md: "[label](https://example.com) and [[Card#Part|part]]",
					},
					embeddedFiles: {
						url: "https://example.com/pic.png",
						tex: "$$x^2$$",
						note: "[[Card]]",
						nested: "[[Inner.excalidraw]]",
						self: "[[Drawing.excalidraw]]",
					},
				},
			),
		});
		const { html } = await compile(root, "Drawing.excalidraw.md", vaultOptions(root));
		expect(html).toContain('href="data:image/png;base64,AAAA"');
		expect(html).toContain("scale(-1 1)");
		expect(html).toContain('href="https://example.com/pic.png"');
		expect(html).toContain('class="excalidraw-embedded-markdown"');
		expect(html).toContain("<strong>text</strong>");
		expect(html).toContain('class="excalidraw-nested"');
		expect(html).toContain("embeds itself");
		expect(html).toContain(">Part body</text>");
		expect(html).toContain(">label and part</text>");
		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">',
		);
		expect(html).toContain('<a href="/guide">');
		expect(html).toContain("Unsafe link");
	});

	test("a text whose words changed is re-wrapped and re-centred in its container", async () => {
		const root = makeVault({
			"Target.md": "# Target\n",
			"Wrap.excalidraw.md": drawingNote(
				sceneJson([
					element("rectangle", {
						id: "c",
						width: 120,
						height: 100,
						boundElements: [{ type: "text", id: "w" }],
					}),
					element("text", {
						id: "w",
						text: "x",
						originalText: "x",
						containerId: "c",
						textAlign: "center",
						verticalAlign: "middle",
					}),
					element("text", {
						id: "free",
						y: 200,
						text: "x",
						originalText: "x",
						textAlign: "center",
					}),
				]),
				{
					textElements: {
						w: "A much longer label than before [[Target|here]]",
						free: "[[Target]] again",
					},
				},
			),
		});
		const { html } = await compile(root, "Wrap.excalidraw.md", vaultOptions(root));
		expect(html.match(/<text /g)?.length).toBeGreaterThan(3);
		expect(html).toContain(">Target again</text>");
	});

	test("raw mode shows text as written; #^area= and #^clippedframe= crop", async () => {
		const root = makeVault({
			"Raw.excalidraw.md": drawingNote(
				sceneJson([
					element("text", { id: "t", text: "x", originalText: "x" }),
					element("rectangle", { id: "area", x: 0, y: 0, width: 50, height: 50 }),
					element("frame", { id: "fr", x: 300, name: "F" }),
					element("ellipse", { x: 310, frameId: "fr" }),
				]),
				{ frontmatter: "excalidraw-plugin: raw", textElements: { t: "See [[Missing]]" } },
			),
			"Note.md":
				"![[Raw.excalidraw#^area=area]] ![[Raw.excalidraw#^clippedframe=F]] ![[Raw.excalidraw#^frame=nope]]",
		});
		const page = await compile(root, "Raw.excalidraw.md", vaultOptions(root));
		expect(page.html).toContain(">See [[Missing]]</text>");
		const note = await compile(root, "Note.md", vaultOptions(root));
		expect(note.html).toContain('viewBox="0 0 70 70"');
		expect(note.messages.join("\n")).toContain('no frame named or with id "nope"');
	});
});

describe("fonts", () => {
	test("the peer's fonts are served with unicode ranges read from the files", () => {
		const dir = excalidrawFontsDir();
		expect(dir).toBeDefined();
		const faces = excalidrawFontFaces(dir ?? "", false);
		const excalifont = faces.filter((face) => face.family === "Excalifont");
		expect(excalifont.length).toBeGreaterThan(1);
		expect(excalifont[0]?.unicodeRange).toContain("U+");
		expect(faces.some((face) => face.family === "Xiaolai")).toBe(false);
		const css = fontFaceCss(faces, new Set(["Nunito"]), "/base/");
		expect(css).toContain("url(/base/excalidraw-fonts/Nunito/");
		expect(css).not.toContain("Excalifont");
	});

	test("without the peer nothing is served and text keeps its fallback stack", () => {
		expect(excalidrawFontsDir(path.join(os.tmpdir(), "no-peer-here"))).toSatisfy(
			(dir) => dir === undefined || dir.endsWith(path.join("prod", "fonts")),
		);
		expect(unicodeRange([0x41, 0x42, 0x43, 0x61])).toBe("U+41-43,U+61");
		expect(wrapAtCharLength("one two three", 7)).toBe("one two\nthree");
	});
});
