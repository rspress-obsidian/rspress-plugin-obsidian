import { expect, test } from "@playwright/test";

// rspress.config.ts configures `graphview({ defaultOpen: true })`, so the panel
// is already open on load and the toggle button reads "Close graph view".
const PANEL = "#rspress-graph-view-panel";
// The footer stats are rendered client-side once the graph data is built, so
// waiting for them is the hydration wait the fixed sleep stood in for — and it
// is what the panel's own close/toggle keys depend on.
const STATS = `${PANEL} span[aria-live='polite']`;

test.describe("Graph View Panel", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/examples.html");
		await expect(page.locator(STATS)).toBeVisible();
	});

	test("graph panel is open on load", async ({ page }) => {
		await expect(page.locator(PANEL)).toBeVisible();
		// Two controls carry this label while the panel is open: the FAB (which
		// toggles) and the panel's own close button.
		await expect(page.locator("button[aria-label='Close graph view']").first()).toBeVisible();
	});

	test("graph panel draws nodes and edges", async ({ page }) => {
		// A non-zero count is the contract: the panel is useless if the built graph
		// is empty, and the counts are the only place the rendered graph surfaces.
		await expect(page.locator(STATS)).toHaveText(/[1-9]\d* nodes? · [1-9]\d* links?/);

		// Moving the pointer over the graph must not dismiss the panel.
		await page.locator(`${PANEL} [role='img']`).hover();
		await expect(page.locator(PANEL)).toBeVisible();
	});

	test("graph panel closes on escape", async ({ page }) => {
		const panel = page.locator(PANEL);
		await expect(panel).toBeVisible();

		await page.keyboard.press("Escape");

		await expect(panel).not.toBeVisible();
		await expect(page.locator("button[aria-label='Open graph view']")).toBeVisible();
	});

	test("graph panel toggles with 'g' key", async ({ page }) => {
		const panel = page.locator("#rspress-graph-view-panel");
		await expect(panel).toBeVisible();

		await page.keyboard.press("g");
		await expect(panel).not.toBeVisible();

		await page.keyboard.press("g");
		await expect(panel).toBeVisible();
	});
});

test.describe("Graph View reduced motion", () => {
	test("disables the panel and FAB animations under prefers-reduced-motion", async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto("/markdown/guide/examples.html");
		// The keyframes are injected by the client runtime, so wait for the tree to
		// mount (the footer stats) — asserting `none` any earlier would pass
		// vacuously, before any animation exists to override.
		await expect(page.locator("#rspress-graph-view-panel span[aria-live='polite']")).toBeVisible();

		// The keyframes are injected at runtime and applied inline, so this only
		// passes if graph-panels.css overrides them with `!important`.
		const panelAnimation = await page
			.locator("#rspress-graph-view-panel")
			.evaluate((el) => getComputedStyle(el).animationName);
		expect(panelAnimation).toBe("none");

		const fabAnimation = await page
			.locator("button[aria-controls='rspress-graph-view-panel']")
			.evaluate((el) => getComputedStyle(el).animationName);
		expect(fabAnimation).toBe("none");
	});
});
