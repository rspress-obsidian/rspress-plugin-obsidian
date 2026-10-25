/**
 * The page-level KaTeX stylesheet link: a page reached by client-side
 * navigation must not show its formulas before the stylesheet applies, and a
 * stylesheet that fails must not keep the page from showing at all.
 *
 * happy-dom fetches every stylesheet link put in the document (and fails), so
 * the links are captured on their way into `<head>` and loaded or failed by
 * hand.
 */
import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Suspense } from "react";
import KatexStylesheet from "./KatexStylesheet";

let appended: HTMLLinkElement[] = [];
let append: Mock<typeof document.head.append>;

beforeEach(() => {
	appended = [];
	append = spyOn(document.head, "append").mockImplementation((...nodes) => {
		for (const node of nodes) if (node instanceof HTMLLinkElement) appended.push(node);
	});
});

afterEach(() => {
	cleanup();
	// The document is shared by every test file in the process.
	append.mockRestore();
});

function page(href: string) {
	return render(
		<Suspense fallback={<p>loading</p>}>
			<KatexStylesheet href={href} />
			<p>formula</p>
		</Suspense>,
	);
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

test("a page reached in the browser waits for the stylesheet, then shows", async () => {
	const view = page("/obsidian-katex/1/katex.min.css");

	expect(view.queryByText("formula")).toBeNull();
	expect(appended.map((link) => [link.rel, link.getAttribute("href")])).toEqual([
		["stylesheet", "/obsidian-katex/1/katex.min.css"],
	]);

	appended[0]?.dispatchEvent(new Event("load"));
	await settle();
	expect(view.getByText("formula")).toBeTruthy();
});

test("a stylesheet already loaded does not hold the page back, nor load twice", async () => {
	const first = page("/obsidian-katex/2/katex.min.css");
	appended[0]?.dispatchEvent(new Event("load"));
	await settle();
	first.unmount();

	const second = page("/obsidian-katex/2/katex.min.css");
	expect(second.getByText("formula")).toBeTruthy();
	expect(appended).toHaveLength(1);
});

test("a stylesheet that fails to load still lets the page show", async () => {
	const view = page("/obsidian-katex/3/katex.min.css");

	appended[0]?.dispatchEvent(new Event("error"));
	await settle();
	expect(view.getByText("formula")).toBeTruthy();
});
