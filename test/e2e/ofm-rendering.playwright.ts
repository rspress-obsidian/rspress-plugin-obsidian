import { expect, test } from "@playwright/test";

// Math and Mermaid rendering on a real page. The build-integration suite asserts
// the emitted markup; this suite asserts what the browser ends up showing —
// KaTeX's stylesheet applied and Mermaid's SVG actually drawn.
test.describe("Math and Mermaid rendering", () => {
	test.beforeEach(async ({ page }) => {
		// No fixed sleep: KaTeX is server-rendered and Mermaid's SVG is awaited in
		// the test that needs it, and every assertion below auto-retries.
		await page.goto("/markdown/guide/examples.html");
	});

	test("applies KaTeX styling to inline and display math", async ({ page }) => {
		const inline = page.locator("span.obsidian-math .katex").first();
		const display = page.locator(".obsidian-math-display .katex-display").first();

		await expect(inline).toBeVisible();
		await expect(display).toBeVisible();

		// KaTeX ships its own fonts; the family proves the stylesheet loaded,
		// not just that the markup is present.
		const fontFamily = await inline.evaluate((el) => getComputedStyle(el).fontFamily);
		expect(fontFamily).toContain("KaTeX");
	});

	test("draws mermaid diagrams in the browser", async ({ page }) => {
		const block = page.locator(".obsidian-mermaid-block").first();

		await expect(block.locator("svg")).toBeVisible();
		await expect(block).toHaveClass(/obsidian-mermaid-rendered/);
		await expect(page.locator(".obsidian-mermaid-error")).toHaveCount(0);
	});

	test("keeps the diagram source for the renderer", async ({ page }) => {
		const source = await page.locator(".obsidian-mermaid-block").first().getAttribute("data-code");

		expect(source).toContain("graph TD");
	});

	test("shows an unresolved wikilink as a marked label, not a link", async ({ page }) => {
		const marker = page.locator("span.obsidian-unresolved").first();

		await expect(marker).toBeVisible();
		await expect(marker).toHaveText("Missing page");
		await expect(marker).toHaveAttribute("data-wikilink", "[[not-a-real-page|Missing page]]");
		// A marker, not a navigable link.
		await expect(page.locator("a.obsidian-unresolved")).toHaveCount(0);
	});

	test("does not publish commented-out content", async ({ page }) => {
		await expect(page.getByText("This paragraph is not published either")).toHaveCount(0);
		await expect(page.getByText("Still visible.")).toBeVisible();
	});
});
