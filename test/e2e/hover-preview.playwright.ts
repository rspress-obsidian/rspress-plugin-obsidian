import { expect, test } from "@playwright/test";

// Anchors as Rspress renders them on docs/markdown/guide/examples.md: wikilinks
// keep the route path, markdown links are rewritten to `.html` (and keep their
// `#fragment`).
const WIKILINK = 'a[href="/markdown/guide/advanced"]';
const MARKDOWN_LINK = 'a[href="/markdown/guide/getting-started.html"]';
const MARKDOWN_LINK_WITH_FRAGMENT = 'a[href="/markdown/guide/getting-started.html#Install"]';

test.describe("Hover Previews", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/examples.html");
		// The hover listener is attached on hydration, and the graph panel's footer
		// stats are the client-only signal that the plugin's React tree has mounted.
		// Waiting for them replaces the fixed sleep (and the hover race it hid).
		await expect(page.locator("#rspress-graph-view-panel span[aria-live='polite']")).toBeVisible();
	});

	test("hover preview popup is hidden initially", async ({ page }) => {
		const popup = page.locator(".obsidian-hover-preview");
		await expect(popup).not.toBeVisible();
	});

	test("hovering an internal link shows preview", async ({ page }) => {
		await page.locator(WIKILINK).first().hover();

		const popup = page.locator(".obsidian-hover-preview");
		await expect(popup).toBeVisible();
		await expect(popup.locator(".obsidian-hover-preview__title")).toHaveText("Advanced");
		await expect(popup.locator(".obsidian-hover-preview__content")).not.toBeEmpty();
	});

	test("hovering a markdown link rewritten to .html shows preview", async ({ page }) => {
		await page.locator(MARKDOWN_LINK).first().hover();

		await expect(page.locator(".obsidian-hover-preview__title")).toHaveText("Getting Started");
	});

	test("hovering a markdown link with a fragment shows preview", async ({ page }) => {
		await page.locator(MARKDOWN_LINK_WITH_FRAGMENT).first().hover();

		await expect(page.locator(".obsidian-hover-preview__title")).toHaveText("Getting Started");
	});

	test("moving mouse away hides preview", async ({ page }) => {
		await page.locator(WIKILINK).first().hover();

		const popup = page.locator(".obsidian-hover-preview");
		await expect(popup).toBeVisible();

		await page.mouse.move(0, 0);
		await expect(popup).not.toBeVisible();
	});

	test("hover preview has correct styling", async ({ page }) => {
		await page.locator(WIKILINK).first().hover();

		const popup = page.locator(".obsidian-hover-preview");
		await expect(popup).toBeVisible();
		expect(await popup.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
	});
});
