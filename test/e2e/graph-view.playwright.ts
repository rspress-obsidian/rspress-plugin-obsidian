import { expect, test } from "@playwright/test";

test.describe("Graph View Panel", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/examples.html");
		await page.waitForTimeout(500);
	});

	test("graph FAB button is visible", async ({ page }) => {
		const fab = page.locator("button[aria-label='Open graph view']");
		await expect(fab).toBeVisible();
	});

	test("graph panel opens on FAB click", async ({ page }) => {
		const fab = page.locator("button[aria-label='Open graph view']");
		await fab.click();
		const panel = page.locator("#rspress-graph-view-panel");
		await expect(panel).toBeVisible();
	});

	test("graph panel shows stats", async ({ page }) => {
		const fab = page.locator("button[aria-label='Open graph view']");
		await fab.click();
		await page.waitForTimeout(500);
		const stats = page.locator("#rspress-graph-view-panel span[aria-live='polite']");
		await expect(stats.first()).toBeVisible();
	});

	test("graph panel closes on escape", async ({ page }) => {
		const fab = page.locator("button[aria-label='Open graph view']");
		await fab.click();
		const panel = page.locator("#rspress-graph-view-panel");
		await expect(panel).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(panel).not.toBeVisible();
	});

	test("graph panel toggles with 'g' key", async ({ page }) => {
		const panel = page.locator("#rspress-graph-view-panel");
		await expect(panel).not.toBeVisible();
		await page.keyboard.press("g");
		await expect(panel).toBeVisible();
		await page.keyboard.press("g");
		await expect(panel).not.toBeVisible();
	});
});
