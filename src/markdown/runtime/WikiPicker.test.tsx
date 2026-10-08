// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { navigation } from "../../shared/usePathname.js";
import WikiPicker from "./WikiPicker";

const CANDIDATES = JSON.stringify([
	{ href: "/one/setup#setup-guide", label: "Setup Guide", pageLabel: "Alpha" },
	{ href: "/two/setup#setup-guide", label: "Setup Guide", pageLabel: "Beta" },
	{ href: "/one/setup#other", label: "Other Section", pageLabel: "Alpha" },
]);

afterEach(() => {
	cleanup();
});

describe("WikiPicker", () => {
	test("shows the match count and hides the list until asked", () => {
		const { container } = render(<WikiPicker candidates={CANDIDATES} query="Setup" />);

		const trigger = container.querySelector("button.rp-wiki-picker-trigger");
		expect(trigger?.textContent).toBe("3 matches for Setup");
		expect(container.querySelector(".rp-wiki-picker-list")).toBeNull();
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
	});

	test("opens a list of real links on click", () => {
		const { container } = render(<WikiPicker candidates={CANDIDATES} query="Setup" />);
		fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);

		const links = Array.from(container.querySelectorAll(".rp-wiki-picker-list a"));
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/one/setup#setup-guide",
			"/two/setup#setup-guide",
			"/one/setup#other",
		]);
		expect(links[0]?.textContent).toContain("Alpha");
		expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
	});

	test("filters the list as the reader types", () => {
		const { container } = render(<WikiPicker candidates={CANDIDATES} query="Setup" />);
		fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);

		const filter = container.querySelector(
			"input[aria-label='Filter search results']",
		) as HTMLInputElement;
		fireEvent.change(filter, { target: { value: "beta" } });

		const links = Array.from(container.querySelectorAll(".rp-wiki-picker-list a"));
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("href")).toBe("/two/setup#setup-guide");
	});

	test("reports when the filter matches nothing", () => {
		const { container } = render(<WikiPicker candidates={CANDIDATES} query="Setup" />);
		fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);
		const filter = container.querySelector(
			"input[aria-label='Filter search results']",
		) as HTMLInputElement;
		fireEvent.change(filter, { target: { value: "nothing" } });

		expect(container.querySelector(".rp-wiki-picker-empty")).not.toBeNull();
		expect(container.querySelectorAll(".rp-wiki-picker-list a")).toHaveLength(0);
	});

	test("prefers the alias as its label", () => {
		const { container } = render(
			<WikiPicker candidates={CANDIDATES} query="Setup" alias="The setup" />,
		);
		expect(container.querySelector("button")?.textContent).toBe("The setup");
	});

	test("degrades to plain text when the candidates are unusable", () => {
		const { container } = render(<WikiPicker candidates="not json" query="Setup" />);

		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).toBe("Setup");
	});

	test("drops malformed candidate entries instead of rendering them", () => {
		const { container } = render(
			<WikiPicker
				candidates={JSON.stringify([{ nope: true }, { href: "/a", label: "A" }])}
				query="x"
			/>,
		);
		fireEvent.click(container.querySelector("button") as HTMLElement);

		const links = Array.from(container.querySelectorAll(".rp-wiki-picker-list a"));
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("href")).toBe("/a");
	});
});

describe("WikiPicker navigation", () => {
	test("hrefs carry the site base so a match opens in a new tab", () => {
		const { container } = render(
			<WikiPicker candidates={CANDIDATES} query="Setup" base="/repo/" />,
		);
		fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);
		const links = Array.from(container.querySelectorAll(".rp-wiki-picker-list a"));
		expect(links[0]?.getAttribute("href")).toBe("/repo/one/setup#setup-guide");
	});

	test("a plain click navigates by route inside the router instead of reloading", () => {
		let current = "";
		function Where() {
			current = useLocation().pathname;
			return null;
		}
		const { container } = render(
			<MemoryRouter initialEntries={["/start"]}>
				<WikiPicker candidates={CANDIDATES} query="Setup" base="/repo/" />
				<Routes>
					<Route path="*" element={<Where />} />
				</Routes>
			</MemoryRouter>,
		);
		fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);
		const link = container.querySelector(".rp-wiki-picker-list a") as HTMLElement;
		const notCancelled = fireEvent.click(link, { button: 0 });
		expect(notCancelled).toBe(false);
		expect(current).toBe("/one/setup");
	});

	test("outside a router a plain click loads the route; a modified click is left alone", () => {
		const assign = mock((_href: string) => {});
		const original = navigation.assign;
		navigation.assign = assign;
		try {
			const { container } = render(<WikiPicker candidates={CANDIDATES} query="Setup" />);
			fireEvent.click(container.querySelector("button.rp-wiki-picker-trigger") as HTMLElement);
			const link = container.querySelector(".rp-wiki-picker-list a") as HTMLElement;
			expect(fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
			expect(assign).not.toHaveBeenCalled();
			fireEvent.click(link, { button: 0 });
			expect(assign).toHaveBeenCalledWith("/one/setup#setup-guide");
		} finally {
			navigation.assign = original;
		}
	});
});
