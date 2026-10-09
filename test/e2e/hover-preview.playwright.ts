import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Anchors as Rspress renders them on docs/markdown/guide/examples.md: wikilinks
// keep the route path, markdown links are rewritten to `.html` (and keep their
// `#fragment`).
const ARTICLE = ".rspress-doc";
const WIKILINK = `${ARTICLE} a[href="/markdown/guide/advanced"]`;
const MARKDOWN_LINK = `${ARTICLE} a[href="/markdown/guide/getting-started.html"]`;
const HEADING_LINK = `${ARTICLE} a[href="/markdown/guide/getting-started.html#Install"]`;
const BLOCK_LINK = `${ARTICLE} a:has-text("A block in the vault's intro")`;
const SIDEBAR_LINK = 'a.rp-sidebar-item[href="/markdown/guide/advanced.html"]';
const POPOVER = ".obsidian-hover-preview";
/** The hover delay plus the close grace, and some. */
const SETTLE_MS = 700;

/**
 * Hover a link once the page has stopped scrolling. Playwright scrolls a link
 * into view before hovering it, the site scrolls smoothly, and every scroll
 * event that arrives after the hover is a host scroll, which closes a preview.
 */
async function hoverLink(link: Locator): Promise<void> {
	await link.scrollIntoViewIfNeeded();
	await link.page().evaluate(async () => {
		let last = Number.NaN;
		for (let stableFrames = 0; stableFrames < 3; ) {
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => resolve());
			await promise;
			stableFrames = window.scrollY === last ? stableFrames + 1 : 0;
			last = window.scrollY;
		}
	});
	await link.hover();
}

/** WCAG contrast of an element's text against the popover surface. */
function contrastIn(page: Page, selector: string): Promise<number> {
	return page.locator(POPOVER).evaluate((popover, textSelector) => {
		const text = popover.querySelector(textSelector);
		if (!text) throw new Error(`no ${textSelector} in the popover`);
		const luminance = (color: string) => {
			const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
			const linear = (channel: number) => {
				const c = channel / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
		};
		const foreground = luminance(getComputedStyle(text).color);
		const background = luminance(getComputedStyle(popover).backgroundColor);
		return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
	}, selector);
}

test.describe("Page preview", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/examples.html");
		// The hover listener is attached on hydration, and the graph panel's footer
		// stats are the client-only signal that the plugin's React tree has mounted.
		await expect(page.locator("#rspress-graph-view-panel span[aria-live='polite']")).toBeVisible();
	});

	test("is hidden until a link is hovered", async ({ page }) => {
		await expect(page.locator(POPOVER)).toHaveCount(0);
	});

	test("renders the linked page, not a text excerpt", async ({ page }) => {
		await hoverLink(page.locator(WIKILINK).first());

		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();
		await expect(popover.locator("h1")).toHaveText("Advanced", { useInnerText: true });
		await expect(popover.locator("h2").first()).toBeVisible();
		await expect(popover.locator("pre").first()).toBeVisible();
		expect(await popover.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
	});

	test("a markdown link rewritten to .html previews its page", async ({ page }) => {
		await hoverLink(page.locator(MARKDOWN_LINK).first());

		await expect(page.locator(POPOVER).locator("h1")).toHaveText("Getting Started", {
			useInnerText: true,
		});
	});

	test("a heading link shows only that section", async ({ page }) => {
		await hoverLink(page.locator(HEADING_LINK).first());

		const popover = page.locator(POPOVER);
		await expect(popover.locator("h2", { hasText: "Install" })).toBeVisible();
		await expect(popover.locator("h1")).toBeHidden();
		await expect(popover.locator("h2", { hasText: "Quick Setup" })).toBeHidden();
	});

	test("a block link shows only that block", async ({ page }) => {
		await hoverLink(page.locator(BLOCK_LINK));

		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();
		const visibleBlocks = await popover
			.locator(".obsidian-hover-preview__body")
			.evaluate(
				(body) =>
					Array.from(body.children).filter((child) => getComputedStyle(child).display !== "none")
						.length,
			);
		expect(visibleBlocks).toBe(1);
		await expect(popover).toContainText("This paragraph carries one");
		expect(
			await popover
				.locator("h2")
				.evaluateAll((headings) => headings.filter((h) => h.checkVisibility()).length),
		).toBe(0);
	});

	test("stays open while the pointer is in it, and scrolls", async ({ page }) => {
		const link = page.locator(WIKILINK).first();
		await hoverLink(link);
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();
		const box = await popover.boundingBox();
		if (!box) throw new Error("popover has no box");

		await page.mouse.move(box.x + 40, box.y + 40, { steps: 8 });
		await page.waitForTimeout(SETTLE_MS);
		await expect(popover).toBeVisible();

		const scrollBefore = await page.evaluate(() => window.scrollY);
		await page.mouse.wheel(0, 300);
		await expect.poll(() => popover.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await expect(popover).toBeVisible();
		expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
	});

	test("closes after the pointer leaves link and popover", async ({ page }) => {
		await hoverLink(page.locator(WIKILINK).first());
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();

		await page.mouse.move(0, 0);
		await expect(popover).toBeHidden();
	});

	test("Escape closes it", async ({ page }) => {
		await hoverLink(page.locator(WIKILINK).first());
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(popover).toBeHidden();
	});

	test("a sidebar link shows nothing", async ({ page }) => {
		await hoverLink(page.locator(SIDEBAR_LINK));
		await page.waitForTimeout(SETTLE_MS);
		await expect(page.locator(POPOVER)).toHaveCount(0);

		await hoverLink(page.locator(WIKILINK).first());
		await expect(page.locator(POPOVER)).toBeVisible();
	});

	test("touch shows nothing", async ({ browser }) => {
		const context = await browser.newContext({ hasTouch: true });
		const page = await context.newPage();
		await page.goto("/markdown/guide/examples.html");
		await expect(page.locator("#rspress-graph-view-panel span[aria-live='polite']")).toBeVisible();
		const box = await page.locator(WIKILINK).first().boundingBox();
		if (!box) throw new Error("link has no box");
		await page.evaluate(() => {
			// A tap must not navigate away before the check.
			document.addEventListener("click", (event) => event.preventDefault(), { capture: true });
		});
		await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
		await page.waitForTimeout(SETTLE_MS);
		await expect(page.locator(POPOVER)).toHaveCount(0);

		await hoverLink(page.locator(WIKILINK).first());
		await expect(page.locator(POPOVER)).toBeVisible();
		await context.close();
	});

	test("leaves the host page's ids and outline alone", async ({ page }) => {
		const outline = () =>
			page.locator(".rp-outline__toc a").evaluateAll((links) => links.map((a) => a.textContent));
		const outlineBefore = await outline();

		await hoverLink(page.locator(WIKILINK).first());
		const popover = page.locator(POPOVER);
		await expect(popover.locator("h1")).toHaveText("Advanced", { useInnerText: true });

		const inside = await popover.evaluate((element) => ({
			unprefixedIds: Array.from(element.querySelectorAll("[id]"), (child) => child.id).filter(
				(id) => !id.startsWith("obsidian-hover-preview-"),
			),
			tocIncludes: element.querySelectorAll(".rp-toc-include").length,
		}));
		expect(inside).toEqual({ unprefixedIds: [], tocIncludes: 0 });
		const duplicates = await page.evaluate(() => {
			const ids = Array.from(document.querySelectorAll("[id]"), (element) => element.id);
			return ids.filter((id, index) => ids.indexOf(id) !== index);
		});
		expect(duplicates).toEqual([]);
		expect(await outline()).toEqual(outlineBefore);
	});

	test("sits above the graph panel", async ({ page }) => {
		await hoverLink(page.locator(WIKILINK).first());
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();

		const onTop = await popover.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			return element.contains(hit);
		});
		expect(onTop).toBe(true);
		expect(await popover.evaluate((element) => getComputedStyle(element).zIndex)).toBe("10000");
	});

	test("opens above a link near the bottom of the window", async ({ page }) => {
		const link = page.locator(WIKILINK).first();
		await link.evaluate((element) => {
			const top = element.getBoundingClientRect().top + window.scrollY;
			window.scrollTo(0, top - window.innerHeight + 60);
		});
		await hoverLink(link);
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();

		const linkBox = await link.boundingBox();
		const popoverBox = await popover.boundingBox();
		if (!linkBox || !popoverBox) throw new Error("missing box");
		expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(linkBox.y);
	});

	test("body text meets WCAG AA in light and dark themes", async ({ page }) => {
		await hoverLink(page.locator(WIKILINK).first());
		const popover = page.locator(POPOVER);
		await expect(popover).toBeVisible();
		const surface = () => popover.evaluate((element) => getComputedStyle(element).backgroundColor);
		const lightSurface = await surface();
		expect(await contrastIn(page, "p")).toBeGreaterThanOrEqual(4.5);

		// The classes Rspress's theme switch sets.
		await page.evaluate(() => document.documentElement.classList.add("dark", "rp-dark"));
		expect(await surface()).not.toBe(lightSurface);
		expect(await contrastIn(page, "p")).toBeGreaterThanOrEqual(4.5);
	});
});
