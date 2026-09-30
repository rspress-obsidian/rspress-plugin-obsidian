// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import ZoomButton from "./ZoomButton";

describe("ZoomButton", () => {
	afterEach(() => {
		cleanup();
	});

	test("reports its purpose to assistive tech and fires on click", () => {
		let clicks = 0;
		const { container } = render(
			<ZoomButton ariaLabel="Zoom in" onClick={() => (clicks += 1)}>
				<svg aria-hidden="true" />
			</ZoomButton>,
		);

		const button = container.querySelector("button") as HTMLButtonElement;
		expect(button.getAttribute("aria-label")).toBe("Zoom in");
		expect(button.getAttribute("type")).toBe("button");

		fireEvent.click(button);
		fireEvent.click(button);
		expect(clicks).toBe(2);
	});

	test("sizes the small variant below the default", () => {
		const { container } = render(
			<>
				<ZoomButton ariaLabel="Small" onClick={() => {}} size="sm">
					<svg aria-hidden="true" />
				</ZoomButton>
				<ZoomButton ariaLabel="Default" onClick={() => {}}>
					<svg aria-hidden="true" />
				</ZoomButton>
			</>,
		);

		const small = container.querySelector("button[aria-label='Small']") as HTMLButtonElement;
		const normal = container.querySelector("button[aria-label='Default']") as HTMLButtonElement;

		expect(small.style.width).toBe("22px");
		expect(small.style.borderRadius).toBe("4px");
		expect(normal.style.width).toBe("26px");
		expect(normal.style.borderRadius).toBe("5px");
	});

	test("tints the control on hover and restores it on leave", () => {
		const { container } = render(
			<ZoomButton ariaLabel="Zoom out" onClick={() => {}}>
				<svg aria-hidden="true" />
			</ZoomButton>,
		);

		const button = container.querySelector("button") as HTMLButtonElement;
		const resting = button.style.color;

		fireEvent.mouseEnter(button);
		expect(button.style.color).toBe("var(--rp-c-brand, #6366f1)");

		fireEvent.mouseLeave(button);
		expect(button.style.color).toBe(resting);
	});
});
