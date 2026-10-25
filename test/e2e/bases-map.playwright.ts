import { expect, type Page, test } from "@playwright/test";

// Unit tests assert a map view's markup and the bundler config; this suite
// asserts what only a browser shows: that the MapLibre the site bundled starts
// its worker and draws. MapLibre 6 runs that worker from a module file the
// bundler has to emit; without it the canvas and the markers still appear, but
// nothing is drawn and the console reports "Worker failed to load".
//
// The view's background, OpenFreeMap's style, is replaced by one with a single
// GeoJSON polygon covering the world. MapLibre tiles GeoJSON in its worker, so
// the canvas turns the probe colour only when the worker runs, and the suite
// needs no network.
const PROBE_STYLE = {
	version: 8,
	sources: {
		probe: {
			type: "geojson",
			data: {
				type: "Polygon",
				coordinates: [
					[
						[-180, -85],
						[180, -85],
						[180, 85],
						[-180, 85],
						[-180, -85],
					],
				],
			},
		},
	},
	layers: [{ id: "probe", type: "fill", source: "probe", paint: { "fill-color": "#ff00ff" } }],
};

/** Share of a PNG's pixels in the probe colour, decoded by the browser. */
function probeShare(page: Page, png: Buffer): Promise<number> {
	return page.evaluate(async (base64) => {
		const bitmap = await createImageBitmap(
			await (await fetch(`data:image/png;base64,${base64}`)).blob(),
		);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d");
		if (!context) return 0;
		context.drawImage(bitmap, 0, 0);
		const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
		let probe = 0;
		for (let index = 0; index < data.length; index += 4) {
			const [red = 0, green = 0, blue = 0] = data.subarray(index, index + 3);
			if (red > 200 && green < 60 && blue > 200) probe++;
		}
		return probe / (bitmap.width * bitmap.height);
	}, png.toString("base64"));
}

test("a map view starts MapLibre's worker and draws its background", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.route("https://tiles.openfreemap.org/**", (route) =>
		route.fulfill({ json: PROBE_STYLE }),
	);
	await page.goto("/bases/Plugins/Bases/Places.html");

	const canvas = page.locator(".maplibregl-canvas").first();
	await expect(canvas).toBeVisible();
	await expect(page.locator(".maplibregl-marker")).toHaveCount(3);
	// MapLibre's own stylesheet, a lazy chunk, is applied: it positions the controls.
	await expect(page.locator(".maplibregl-ctrl-top-right").first()).toHaveCSS(
		"position",
		"absolute",
	);
	await expect
		.poll(async () => probeShare(page, await canvas.screenshot()), { timeout: 15_000 })
		.toBeGreaterThan(0.5);
	expect(errors).toEqual([]);
});
