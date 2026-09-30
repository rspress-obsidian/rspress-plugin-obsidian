import { expect, test } from "@playwright/test";

// The media embeds page is the plugin's own claim that every format Obsidian
// accepts really renders. Unit tests assert the emitted markup; this suite
// asserts the two things markup alone cannot: that the browser fetched each file
// the embed points at (a wrong `src` is invisible until it 404s), and that the
// audio and video elements actually decoded something.
//
// The page also embeds a canvas board, and a canvas card inlines its
// attachments as `data:` URLs rather than fetching them. Those are real embeds
// too, but they are checked on the board's own page below, so the selectors here
// take the page's own http(s) embeds: a `data:` URL is what a canvas card looks
// like, and `page.request` cannot fetch one.
test.describe("Media embeds", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/markdown/guide/media-embeds.html");
	});

	test("renders an image, sized and unsized", async ({ page }) => {
		const images = page.locator(".rp-doc img[src$='gradient.png']");
		await expect(images.first()).toBeVisible();

		// The sized variants are the point of the pipe syntax, so the rendered box
		// has to differ from the unsized one rather than merely carrying a width
		// attribute.
		const widths = await images.evaluateAll((nodes) =>
			nodes.map((node) => (node as HTMLImageElement).getBoundingClientRect().width),
		);
		expect(widths.length).toBeGreaterThanOrEqual(3);
		expect(new Set(widths.map((width) => Math.round(width))).size).toBeGreaterThan(1);
	});

	test("sizes a markdown image from the size in its alt", async ({ page }) => {
		const sized = page.locator(".rp-doc img[alt='A caption, then a size']");
		await expect(sized).toBeVisible();
		const width = await sized.evaluate(
			(node) => (node as HTMLImageElement).getBoundingClientRect().width,
		);
		expect(width).toBeGreaterThan(200);
		expect(width).toBeLessThan(320);
	});

	test("loads every audio format the page embeds", async ({ page }) => {
		const sources = await page
			.locator(".rp-doc audio")
			.evaluateAll((nodes) =>
				nodes
					.map((node) => (node as HTMLAudioElement).getAttribute("src") ?? "")
					.filter((src) => !src.startsWith("data:")),
			);
		expect(sources.length).toBeGreaterThanOrEqual(5);
		for (const src of sources) {
			const response = await page.request.get(src);
			expect(response.status(), `${src} should be served`).toBe(200);
		}
	});

	test("decodes an audio file far enough to report its duration", async ({ page }) => {
		// A 200 on the file only proves the URL resolved. Metadata means the
		// browser parsed the container, which is the claim the page makes.
		const decoded = await page
			.locator(".rp-doc audio:not([src^='data:'])")
			.first()
			.evaluate(async (node) => {
				const audio = node as HTMLAudioElement;
				if (audio.readyState === 0) {
					await new Promise<void>((resolve) => {
						audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
						audio.addEventListener("error", () => resolve(), { once: true });
						audio.load();
					});
				}
				return audio.duration;
			});
		expect(decoded).toBeGreaterThan(0);
	});

	test("loads and decodes a video", async ({ page }) => {
		const video = page.locator(".rp-doc video:not([src^='data:'])").first();
		await expect(video).toBeVisible();

		const state = await video.evaluate(async (node) => {
			const media = node as HTMLVideoElement;
			if (media.readyState === 0) {
				await new Promise<void>((resolve) => {
					media.addEventListener("loadeddata", () => resolve(), { once: true });
					media.addEventListener("error", () => resolve(), { once: true });
					media.load();
				});
			}
			return { width: media.videoWidth, duration: media.duration };
		});
		expect(state.width).toBeGreaterThan(0);
		expect(state.duration).toBeGreaterThan(0);
	});

	test("serves the PDF a frame points at, and keeps the height out of the URL", async ({
		page,
	}) => {
		// `*=` rather than `$=`: two of these frames carry a `#page=` subpath, so
		// their `src` does not end with the filename.
		const frames = page.locator(".rp-doc iframe[src*='sample.pdf']");
		await expect(frames.first()).toBeVisible();

		const srcs = await frames.evaluateAll((nodes) =>
			nodes
				.map((node) => (node as HTMLIFrameElement).getAttribute("src") ?? "")
				.filter((src) => !src.startsWith("data:")),
		);
		// The page subpath reaches the file; the height subpath never does.
		expect(srcs.some((src) => src.endsWith("#page=2"))).toBe(true);
		expect(srcs.every((src) => !src.includes("#height="))).toBe(true);

		const plain = srcs.find((src) => !src.includes("#"));
		expect(plain).toBeDefined();
		const response = await page.request.get(plain as string);
		expect(response.status()).toBe(200);
	});

	test("names each PDF and links out to the document", async ({ page }) => {
		// The caption bar exists because a bare frame told a reader nothing: not
		// which document, and no way to open it on a browser that cannot display it
		// in place.
		const bars = page.locator(".rp-doc figure.obsidian-pdf");
		await expect(bars.first()).toBeVisible();
		expect(await bars.count()).toBeGreaterThanOrEqual(3);

		const first = bars.first();
		// The extension is nested inside the name on purpose: a long vault path has
		// to truncate as one run, so the two cannot be separate boxes.
		await expect(first.locator(".obsidian-pdf-name")).toHaveText("sample.pdf");
		await expect(first.locator(".obsidian-pdf-ext")).toHaveText(".pdf");
		// A `#page=` subpath is worth showing: the frame opens partway in.
		await expect(first.locator(".obsidian-pdf-page")).toHaveText("page 2");

		const open = first.locator("a.obsidian-pdf-open");
		await expect(open).toHaveAttribute("target", "_blank");
		await expect(open).toHaveAttribute("rel", /noopener/);
		// The action has to work, not merely look like a link.
		const href = await open.getAttribute("href");
		expect(href).toBeTruthy();
		const response = await page.request.get(href as string);
		expect(response.status()).toBe(200);

		// The bar sits above the frame rather than over it, so the caption is never
		// the first thing a click lands on when the reader means to page the PDF.
		const [barBox, frameBox] = await Promise.all([
			first.locator(".obsidian-pdf-bar").boundingBox(),
			first.locator("iframe.obsidian-pdf-frame").boundingBox(),
		]);
		expect(barBox).not.toBeNull();
		expect(frameBox).not.toBeNull();
		expect(frameBox?.y ?? 0).toBeGreaterThanOrEqual((barBox?.y ?? 0) + (barBox?.height ?? 0) - 1);
	});

	test("renders media inside a canvas text card", async ({ page }) => {
		await page.goto("/canvas/media.html");
		const card = page.locator(".obsidian-embed-image").first();
		await expect(card).toBeVisible();

		// Cards inline their attachments as data URLs, so a card's media cannot
		// 404 the way a page's can — and the image really decoded.
		const decoded = await card.evaluate((node) => (node as HTMLImageElement).naturalWidth);
		expect(decoded).toBeGreaterThan(0);
	});
});
