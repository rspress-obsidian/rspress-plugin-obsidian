import { expect, test } from "@playwright/test";

test.describe("Hover Previews", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/examples.html");
		await page.waitForTimeout(300);
	});

	test("hover preview popup is hidden initially", async ({ page }) => {
		const popup = page.locator(".obsidian-hover-preview");
		await expect(popup).not.toBeVisible();
	});

	test("hovering over internal link shows preview", async ({ page }) => {
		// Find an internal link with data-route-path
		const link = page.locator("a[data-route-path]").first();
		if (await link.count()) {
			await link.hover();
			await page.waitForTimeout(500);
			const popup = page.locator(".obsidian-hover-preview");
			await expect(popup).toBeVisible();
		}
	});

	test("hover preview shows page title", async ({ page }) => {
		const link = page.locator("a[data-route-path]").first();
		if (await link.count()) {
			await link.hover();
			await page.waitForTimeout(500);
			const title = page.locator(".obsidian-hover-preview__title");
			await expect(title).toBeVisible();
			const titleText = await title.textContent();
			expect(titleText).toBeTruthy();
		}
	});

	test("hover preview shows page content", async ({ page }) => {
		const link = page.locator("a[data-route-path]").first();
		if (await link.count()) {
			await link.hover();
			await page.waitForTimeout(500);
			const content = page.locator(".obsidian-hover-preview__content");
			await expect(content).toBeVisible();
		}
	});

	test("moving mouse away hides preview", async ({ page }) => {
		const link = page.locator("a[data-route-path]").first();
		if (await link.count()) {
			await link.hover();
			await page.waitForTimeout(500);
			const popup = page.locator(".obsidian-hover-preview");
			await expect(popup).toBeVisible();
			// Move mouse away
			await page.mouse.move(0, 0);
			await page.waitForTimeout(200);
			await expect(popup).not.toBeVisible();
		}
	});

	test("hover preview has correct styling", async ({ page }) => {
		const link = page.locator("a[data-route-path]").first();
		if (await link.count()) {
			await link.hover();
			await page.waitForTimeout(500);
			const popup = page.locator(".obsidian-hover-preview");
			await expect(popup).toBeVisible();
			// Check it's positioned fixed
			const position = await popup.evaluate((el) => getComputedStyle(el).position);
			expect(position).toBe("fixed");
		}
	});
});
