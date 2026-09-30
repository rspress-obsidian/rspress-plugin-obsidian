import { expect, type Page, test } from "@playwright/test";

// The server renders `.canvas-world` at 1:1 and the runtime's fit-on-mount
// replaces that transform. Polling for the change is the real hydration wait the
// fixed sleeps were standing in for: it also guarantees the pointer handlers the
// transform tests drive are attached.
const SERVER_RENDERED_TRANSFORM = "translate(0px, 0px) scale(1)";

const worldTransform = (page: Page): Promise<string> =>
	// `.first()`: the embed guide page carries two live boards, and the value
	// under test is whichever one the test hovers (also the first).
	page
		.locator(".canvas-world")
		.first()
		.evaluate((el) => (el as HTMLElement).style.transform);

const waitForCanvasRuntime = (page: Page): Promise<void> =>
	expect.poll(() => worldTransform(page)).not.toBe(SERVER_RENDERED_TRANSFORM);

/** One of each node type the demo canvas uses — the renderer's contract. */
const NODE_TYPES = ["text", "file", "link", "group"];

test.describe("Canvas visual rendering", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/canvas/demo.html");
		await page.waitForSelector(".canvas-viewport");
		await waitForCanvasRuntime(page);
	});

	test("canvas viewport is visible", async ({ page }) => {
		const viewport = page.locator(".canvas-viewport");
		await expect(viewport).toBeVisible();
	});

	test("all node types are rendered", async ({ page }) => {
		// Per-type presence, not the fixture's exact counts: `docs/public/demo.canvas`
		// is a demo, and editing it must not fail a renderer test.
		for (const type of NODE_TYPES) {
			await expect(page.locator(`.canvas-node-${type}`).first()).toBeVisible();
		}
	});

	test("edges have proper SVG paths", async ({ page }) => {
		// Verify edges render as SVG g.canvas-edge containing path elements
		const edgeGroups = page.locator("g.canvas-edge");
		const count = await edgeGroups.count();
		expect(count).toBeGreaterThan(0);

		// Each edge group should contain a path with a valid d attribute
		for (let i = 0; i < Math.min(count, 3); i++) {
			const path = edgeGroups.nth(i).locator("path");
			await expect(path).toBeVisible();
			const d = await path.getAttribute("d");
			expect(d).toBeTruthy();
			expect(d!.startsWith("M")).toBe(true);
		}
	});

	test("file node links to a published vault page", async ({ page }) => {
		// `Demo.canvas` links `Welcome.md#getting-started`; the href must be the route
		// the markdown plugin publishes (case- and space-preserving), not a slugified one.
		const link = page.locator(".canvas-node-file a").first();
		await expect(link).toHaveAttribute("href", /^\/vault\/Welcome/);

		const href = (await link.getAttribute("href")) ?? "";
		const route = href.split("#")[0];
		const response = await page.request.get(`${route}.html`);
		expect(response.status()).toBe(200);
	});

	// A text card runs the canvas feature's own Markdown renderer, so the two
	// constructs a card used to get wrong are worth holding in place here: the
	// demo board showcases both.
	test("a text card renders highlights and protects them inside inline code", async ({ page }) => {
		const card = page.locator(".canvas-node-text", { hasText: "Highlights" }).first();
		await expect(card.locator("mark")).toHaveCount(1);
		// The literal `==…==` the card mentions sits in a code span, so it must
		// survive as text rather than being highlighted too.
		await expect(card).toContainText("==this stays literal==");
	});

	test("a card embeds one section of a note, not the whole file", async ({ page }) => {
		const card = page.locator(".canvas-node-text", { hasText: "Section Embeds" }).first();
		// `![[guide/intro#Transclusion Target]]` inlines that heading's section…
		await expect(card).toContainText("Transclusion Target");
		// …and `![[guide/intro#^anchor-demo]]` inlines only the block carrying
		// that id. Neither drags in the rest of the note.
		await expect(card).toContainText("This paragraph carries one");
		await expect(card).not.toContainText("Daily Notes");
		await expect(card).not.toContainText("Back to Welcome home");
	});

	test("a file card still inlines the whole note, unlike a text card", async ({ page }) => {
		// The contrast is the point: file cards inline the file, text cards honour
		// the fragment.
		const fileCard = page.locator(".canvas-node-file", { hasText: "intro" }).first();
		await expect(fileCard).toContainText("A vault-level intro page");
		await expect(fileCard).toContainText("Daily Notes");
	});

	test("toolbar controls are visible", async ({ page }) => {
		const toolbar = page.locator(".canvas-toolbar");
		await expect(toolbar).toBeVisible();
		// The buttons are the contract, not how many there are: assert each control
		// by name. Scope every lookup to the toolbar — the graph panel renders its
		// own zoom/close controls with the same aria-labels.
		for (const label of [
			"Toggle Grid Dots",
			"Zoom in",
			"Zoom out",
			"Fit to View",
			"Reset zoom (1:1)",
			"Help",
		]) {
			await expect(toolbar.locator(`button[aria-label="${label}"]`)).toBeVisible();
		}
	});

	test("pan and zoom works", async ({ page }) => {
		const initialTransform = await worldTransform(page);

		const viewport = page.locator(".canvas-viewport");
		await viewport.hover();
		await page.mouse.wheel(0, -100);

		await expect.poll(() => worldTransform(page)).not.toBe(initialTransform);
	});

	test("fit to view via toolbar", async ({ page }) => {
		const toolbar = page.locator(".canvas-toolbar");
		const fitButton = toolbar.locator('button[aria-label="Fit to View"]');
		await expect(fitButton).toBeEnabled();

		// Zoom away from the fitted view first, so fitting has something to undo.
		await page.locator(".canvas-viewport").hover();
		await page.mouse.wheel(0, -400);
		const zoomedTransform = await worldTransform(page);

		await fitButton.click();
		await expect.poll(() => worldTransform(page)).not.toBe(zoomedTransform);
	});

	test("help modal is a labelled dialog that closes with Escape", async ({ page }) => {
		const help = page.locator('.canvas-toolbar button[aria-label="Help"]');
		await expect(help).toHaveAttribute("aria-expanded", "false");

		await help.click();

		const modal = page.locator(".canvas-help-modal");
		await expect(modal).toBeVisible();
		await expect(modal).toHaveAttribute("role", "dialog");
		await expect(modal).toHaveAttribute("aria-modal", "true");
		await expect(modal.locator("h3")).toHaveText("Canvas Controls");
		// The × glyph carries no accessible name of its own, and opening the dialog
		// moves focus onto it.
		await expect(modal.locator('button[aria-label="Close help"]')).toBeFocused();

		await page.keyboard.press("Escape");

		await expect(page.locator(".canvas-help-modal")).toHaveCount(0);
		await expect(help).toHaveAttribute("aria-expanded", "false");
	});

	test("honours prefers-reduced-motion", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });

		const transition = await page
			.locator(".canvas-node")
			.first()
			.evaluate((el) => getComputedStyle(el).transitionProperty);
		expect(transition).toBe("none");
	});

	test("a press on a card never claims the pointer, so its links stay clickable", async ({
		page,
	}) => {
		// Chromium retargets the compatibility click to a capturing ancestor and
		// computes its target as the common ancestor of mouseup and mousedown — so
		// capturing on pointerdown makes every link inside a card unclickable.
		// Component tests cannot see it (they dispatch `click` directly), hence a
		// real pointer sequence against the built site.
		const wrapper = page.locator(".canvas-editor-node-wrapper").first();
		const box = await wrapper.boundingBox();
		if (!box) throw new Error("canvas card has no bounding box");
		const x = box.x + 6;
		const y = box.y + 6;

		const capturedNow = () =>
			page.evaluate(() => {
				const element = document.querySelector(".canvas-editor-node-wrapper");
				return element ? element.hasPointerCapture(1) : null;
			});

		await page.mouse.move(x, y);
		await page.mouse.down();
		expect(await capturedNow()).toBe(false);
		await page.mouse.up();

		// The press also belongs to a card, not the viewport behind it.
		await expect(page.locator(".canvas-node-selected")).toHaveCount(1);
	});

	test("a card inside a group is still clickable to navigate", async ({ page }) => {
		// The demo's file card sits inside the "Project Overview" group, and groups
		// paint behind their members — so the card, not the group's box, has to win
		// the hit test. The component suite dispatches `click` straight at the
		// element and can never see the overlap.
		const groupZ = await page
			.locator(".canvas-editor-node-wrapper:has(.canvas-node-group)")
			.first()
			.evaluate((el) => Number(getComputedStyle(el).zIndex));
		const cardZ = await page
			.locator(".canvas-editor-node-wrapper:has(.canvas-node-file)")
			.first()
			.evaluate((el) => Number(getComputedStyle(el).zIndex));
		expect(cardZ).toBeGreaterThan(groupZ);

		await page.locator(".canvas-node-file a").first().click();
		await page.waitForURL(/\/vault\/Welcome/);
	});
});

test.describe("Inline canvas embed", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/canvas/guide/embed.html");
		// The embed is client-rendered, so this selector appearing *is* the
		// hydration wait.
		await page.waitForSelector(".canvas-viewport");
	});

	test("embed loads and renders canvas viewport", async ({ page }) => {
		// The page carries two live embeds — `<CanvasEmbed src>` and the
		// `![[Demo.canvas]]` wikilink form — so every locator here must pick one.
		const viewport = page.locator(".canvas-viewport").first();
		await expect(viewport).toBeVisible();
	});

	test("embed renders nodes", async ({ page }) => {
		for (const type of NODE_TYPES) {
			await expect(page.locator(`.canvas-node-${type}`).first()).toBeVisible();
		}
	});

	test("embed zooms on scroll", async ({ page }) => {
		// The embed's documented controls are "drag to pan, scroll to zoom,
		// double-click to fit" — there are no keyboard shortcuts outside the
		// editor, so assert the scroll zoom the embed actually implements.
		const initialTransform = await worldTransform(page);

		await page.locator(".canvas-viewport").first().hover();
		await page.mouse.wheel(0, -100);

		await expect.poll(() => worldTransform(page)).not.toBe(initialTransform);
	});
});
