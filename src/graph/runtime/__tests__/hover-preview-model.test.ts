import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import type {
	PreviewEvent,
	PreviewPage,
	PreviewRequest,
	PreviewState,
	ShownPreview,
} from "../hover-preview-model";
import {
	anchorRectAt,
	IDLE,
	isolateIds,
	placePopover,
	previewTargetFor,
	reducePreview,
	shownPreview,
	sliceToAnchor,
} from "../hover-preview-model";

const linkA = document.createElement("a");
const linkB = document.createElement("a");
const rect = { left: 0, top: 0, right: 10, bottom: 10 };
const requestA: PreviewRequest = {
	link: linkA,
	target: { pathname: "/a", anchor: null },
	anchorRect: rect,
};
const requestB: PreviewRequest = {
	link: linkB,
	target: { pathname: "/b", anchor: null },
	anchorRect: rect,
};
const pageA: PreviewPage = {
	routePath: "/a",
	content: createElement("p"),
	fallbackTitle: null,
	anchor: null,
};
const pageB: PreviewPage = { ...pageA, routePath: "/b" };
const shownA: ShownPreview = { request: requestA, page: pageA };

function pending(
	request: PreviewRequest,
	fields: Partial<{ page: PreviewPage; delayElapsed: boolean; shown: ShownPreview }> = {},
): PreviewState {
	return {
		phase: "pending",
		request,
		page: fields.page ?? null,
		delayElapsed: fields.delayElapsed ?? false,
		shown: fields.shown ?? null,
	};
}

describe("reducePreview", () => {
	const rows: [string, PreviewState, PreviewEvent, PreviewState][] = [
		["idle + enterLink", IDLE, { type: "enterLink", request: requestA }, pending(requestA)],
		[
			"pending + enterLink(other) keeps the shown popover",
			pending(requestA, { shown: shownA }),
			{ type: "enterLink", request: requestB },
			pending(requestB, { shown: shownA }),
		],
		[
			"pending + enterLink(shown link) reopens the shown popover",
			pending(requestB, { shown: shownA }),
			{ type: "enterLink", request: { ...requestA, anchorRect: { ...rect, top: 5 } } },
			{ phase: "open", shown: shownA },
		],
		["pending + leaveLink, nothing shown", pending(requestA), { type: "leaveLink" }, IDLE],
		[
			"pending + leaveLink, a popover shown",
			pending(requestB, { shown: shownA }),
			{ type: "leaveLink" },
			{ phase: "closing", shown: shownA },
		],
		[
			"pending + enterPopover restores the shown popover",
			pending(requestB, { shown: shownA }),
			{ type: "enterPopover" },
			{ phase: "open", shown: shownA },
		],
		[
			"pending + delayElapsed before the page",
			pending(requestA),
			{ type: "delayElapsed", link: linkA },
			pending(requestA, { delayElapsed: true }),
		],
		[
			"pending + delayElapsed after the page",
			pending(requestA, { page: pageA }),
			{ type: "delayElapsed", link: linkA },
			{ phase: "open", shown: { request: requestA, page: pageA } },
		],
		[
			"pending + pageLoaded before the delay",
			pending(requestA),
			{ type: "pageLoaded", link: linkA, page: pageA },
			pending(requestA, { page: pageA }),
		],
		[
			"pending + pageLoaded after the delay",
			pending(requestA, { delayElapsed: true }),
			{ type: "pageLoaded", link: linkA, page: pageA },
			{ phase: "open", shown: { request: requestA, page: pageA } },
		],
		["pending + pageMissing", pending(requestA), { type: "pageMissing", link: linkA }, IDLE],
		[
			"pending + pageMissing with a popover shown",
			pending(requestB, { shown: shownA }),
			{ type: "pageMissing", link: linkB },
			{ phase: "closing", shown: shownA },
		],
		[
			"open + leaveLink",
			{ phase: "open", shown: shownA },
			{ type: "leaveLink" },
			{ phase: "closing", shown: shownA },
		],
		[
			"open + leavePopover",
			{ phase: "open", shown: shownA },
			{ type: "leavePopover" },
			{ phase: "closing", shown: shownA },
		],
		[
			"open + enterLink(other)",
			{ phase: "open", shown: shownA },
			{ type: "enterLink", request: requestB },
			pending(requestB, { shown: shownA }),
		],
		[
			"closing + enterLink(same)",
			{ phase: "closing", shown: shownA },
			{ type: "enterLink", request: { ...requestA, anchorRect: { ...rect, top: 5 } } },
			{ phase: "open", shown: shownA },
		],
		[
			"closing + enterPopover",
			{ phase: "closing", shown: shownA },
			{ type: "enterPopover" },
			{ phase: "open", shown: shownA },
		],
		[
			"closing + enterLink(other)",
			{ phase: "closing", shown: shownA },
			{ type: "enterLink", request: requestB },
			pending(requestB, { shown: shownA }),
		],
		["closing + graceElapsed", { phase: "closing", shown: shownA }, { type: "graceElapsed" }, IDLE],
	];

	for (const [name, from, event, to] of rows) {
		test(name, () => {
			expect(reducePreview(from, event)).toEqual(to);
		});
	}

	test("an event that does not apply returns the same state", () => {
		const open: PreviewState = { phase: "open", shown: shownA };
		const waiting = pending(requestA);
		expect(reducePreview(IDLE, { type: "delayElapsed", link: linkA })).toBe(IDLE);
		expect(reducePreview(waiting, { type: "enterLink", request: requestA })).toBe(waiting);
		expect(reducePreview(waiting, { type: "enterPopover" })).toBe(waiting);
		expect(reducePreview(waiting, { type: "graceElapsed" })).toBe(waiting);
		expect(reducePreview(open, { type: "enterLink", request: requestA })).toBe(open);
		expect(reducePreview(open, { type: "graceElapsed" })).toBe(open);
	});

	test("a load or timer started for another link changes nothing", () => {
		const waiting = pending(requestB);
		expect(reducePreview(waiting, { type: "pageLoaded", link: linkA, page: pageA })).toBe(waiting);
		expect(reducePreview(waiting, { type: "delayElapsed", link: linkA })).toBe(waiting);
		expect(reducePreview(waiting, { type: "pageMissing", link: linkA })).toBe(waiting);
		expect(
			reducePreview(pending(requestB, { delayElapsed: true }), {
				type: "pageLoaded",
				link: linkB,
				page: pageB,
			}),
		).toEqual({ phase: "open", shown: { request: requestB, page: pageB } });
	});

	test("dismiss returns idle from every phase", () => {
		const phases: PreviewState[] = [
			IDLE,
			pending(requestA, { shown: shownA }),
			{ phase: "open", shown: shownA },
			{ phase: "closing", shown: shownA },
		];
		expect(phases.map((state) => reducePreview(state, { type: "dismiss" }))).toEqual([
			IDLE,
			IDLE,
			IDLE,
			IDLE,
		]);
	});

	test("shownPreview is the popover on screen", () => {
		expect(shownPreview(IDLE)).toBeNull();
		expect(shownPreview(pending(requestA))).toBeNull();
		expect(shownPreview(pending(requestB, { shown: shownA }))).toBe(shownA);
		expect(shownPreview({ phase: "closing", shown: shownA })).toBe(shownA);
	});
});

describe("previewTargetFor", () => {
	const location = new URL("http://localhost/guide/current");

	function articleLink(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
		const article = document.createElement("div");
		article.className = "rspress-doc";
		const link = document.createElement("a");
		link.setAttribute("href", href);
		for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
		article.append(link);
		return link;
	}

	test("an article link targets its pathname", () => {
		expect(previewTargetFor(articleLink("/guide/advanced"), location)).toEqual({
			pathname: "/guide/advanced",
			anchor: null,
		});
	});

	test("the query is dropped and the fragment names a heading", () => {
		expect(
			previewTargetFor(articleLink("/guide/getting-started.html?from=nav#Install"), location),
		).toEqual({
			pathname: "/guide/getting-started.html",
			anchor: { kind: "heading", text: "Install" },
		});
	});

	test("a ^ fragment names a block", () => {
		expect(previewTargetFor(articleLink("/Target#%5Eblk"), location)).toEqual({
			pathname: "/Target",
			anchor: { kind: "block", id: "^blk" },
		});
	});

	test("the fragment is percent-decoded; the pathname is left for the router", () => {
		expect(
			previewTargetFor(articleLink("/%E6%97%A5%E6%9C%AC#%E8%A6%8B%E5%87%BA%E3%81%97"), location),
		).toEqual({ pathname: "/%E6%97%A5%E6%9C%AC", anchor: { kind: "heading", text: "見出し" } });
		expect(previewTargetFor(articleLink("/x#100%"), location)).toEqual({
			pathname: "/x",
			anchor: { kind: "heading", text: "100%" },
		});
	});

	test("a hash-only link targets the current page", () => {
		expect(previewTargetFor(articleLink("#local"), location)).toEqual({
			pathname: "/guide/current",
			anchor: { kind: "heading", text: "local" },
		});
	});

	test("chrome, other origins and links outside the article do not qualify", () => {
		const headerAnchor = articleLink("#x", { class: "rp-header-anchor" });
		const backref = articleLink("#fnref-1", { class: "footnote-backref" });
		const canvasBackref = articleLink("#canvas-fnref-1", { class: "canvas-footnote-backref" });
		const download = articleLink("/file.pdf", { download: "" });
		function footnoteLink(supClass: string): HTMLAnchorElement {
			const link = articleLink("#fn-1");
			const sup = document.createElement("sup");
			sup.className = supClass;
			link.replaceWith(sup);
			sup.append(link);
			return link;
		}
		const footnoteRef = footnoteLink("footnote-ref");
		const canvasFootnoteRef = footnoteLink("canvas-footnote-ref");
		const sidebar = document.createElement("a");
		sidebar.setAttribute("href", "/guide/advanced");
		const inPopover = articleLink("/guide/advanced");
		inPopover.parentElement?.classList.add("obsidian-hover-preview");

		expect(
			[
				articleLink("https://elsewhere.example/guide"),
				articleLink("mailto:someone@example.com"),
				articleLink("http://[bad"),
				headerAnchor,
				backref,
				canvasBackref,
				download,
				footnoteRef,
				canvasFootnoteRef,
				sidebar,
				inPopover,
			].map((link) => previewTargetFor(link, location)),
		).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});

describe("anchorRectAt", () => {
	test("a wrapped link anchors to the line under the pointer", () => {
		const link = document.createElement("a");
		const lines = [
			{ left: 300, top: 100, right: 400, bottom: 120 },
			{ left: 0, top: 120, right: 60, bottom: 140 },
		];
		Object.defineProperty(link, "getClientRects", { value: () => lines });
		expect(anchorRectAt(link, 30, 130)).toEqual({ left: 0, top: 120, right: 60, bottom: 140 });
		expect(anchorRectAt(link, 500, 500)).toEqual({ left: 300, top: 100, right: 400, bottom: 120 });
	});

	test("a link without line boxes falls back to its bounding box", () => {
		expect(anchorRectAt(document.createElement("a"), 0, 0)).toEqual({
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
		});
	});
});

describe("placePopover", () => {
	const viewport = { width: 1000, height: 800 };

	test("opens below the link, left edges aligned", () => {
		expect(placePopover({ left: 100, top: 100, right: 180, bottom: 120 }, 300, viewport)).toEqual({
			side: "below",
			left: 100,
			top: 126,
			width: 450,
			maxHeight: 400,
		});
	});

	test("flips above when the content does not fit below", () => {
		expect(placePopover({ left: 100, top: 740, right: 180, bottom: 760 }, 300, viewport)).toEqual({
			side: "above",
			left: 100,
			bottom: 66,
			width: 450,
			maxHeight: 400,
		});
	});

	test("stays below when there is less room above", () => {
		expect(placePopover({ left: 100, top: 300, right: 180, bottom: 320 }, 600, viewport)).toEqual({
			side: "below",
			left: 100,
			top: 326,
			width: 450,
			maxHeight: 400,
		});
	});

	test("clamps to the viewport's right edge", () => {
		expect(placePopover({ left: 900, top: 100, right: 980, bottom: 120 }, 300, viewport)).toEqual({
			side: "below",
			left: 542,
			top: 126,
			width: 450,
			maxHeight: 400,
		});
	});

	test("narrows to a narrow viewport", () => {
		expect(
			placePopover({ left: 100, top: 100, right: 180, bottom: 120 }, 300, {
				width: 300,
				height: 800,
			}),
		).toEqual({ side: "below", left: 8, top: 126, width: 284, maxHeight: 400 });
	});
});

function rootWith(html: string): HTMLDivElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
}

/**
 * The text a browser shows after slicing, one entry per text node: an inline
 * `display: none` hides a subtree, and the nearest inline `visibility` wins.
 */
function visibleText(root: Element): string {
	const texts: string[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent?.trim();
		if (text && isShown(node)) texts.push(text);
	}
	return texts.join(" ");
}

function isShown(node: Node): boolean {
	let visibility = "";
	for (let element = node.parentElement; element; element = element.parentElement) {
		if (element.style.display === "none") return false;
		visibility ||= element.style.visibility;
	}
	return visibility !== "hidden";
}

describe("isolateIds", () => {
	test("prefixes ids and the labels, ARIA references and radio groups that name them", () => {
		const root = rootWith(
			'<h2 id="x">X</h2>' +
				'<input type="radio" name="bases-views-1" id="bases-views-1-1">' +
				'<label for="bases-views-1-1">Table</label>' +
				'<div aria-labelledby="x host-only">Section</div>' +
				'<a href="#x">jump</a>',
		);
		isolateIds(root);
		expect(root.innerHTML).toBe(
			'<h2 id="obsidian-hover-preview-x">X</h2>' +
				'<input type="radio" name="obsidian-hover-preview-bases-views-1" id="obsidian-hover-preview-bases-views-1-1">' +
				'<label for="obsidian-hover-preview-bases-views-1-1">Table</label>' +
				'<div aria-labelledby="obsidian-hover-preview-x host-only">Section</div>' +
				'<a href="#x">jump</a>',
		);
	});

	test("rewrites an SVG's own references and leaves colours alone", () => {
		const root = rootWith(
			'<svg id="g"><defs><marker id="m"></marker></defs>' +
				'<path marker-end="url(#m)" style="fill: url(\'#m\')"></path><use href="#m"></use>' +
				"<style></style></svg>",
		);
		// happy-dom's parser drops an SVG `<style>`'s text, so it is added as a node.
		root.querySelector("style")?.append("#g .x{fill:#fff}");
		isolateIds(root);
		expect(root.querySelector("path")?.getAttribute("marker-end")).toBe(
			"url(#obsidian-hover-preview-m)",
		);
		expect(root.querySelector("path")?.getAttribute("style")).toBe(
			"fill: url('#obsidian-hover-preview-m')",
		);
		expect(root.querySelector("use")?.getAttribute("href")).toBe("#obsidian-hover-preview-m");
		expect(root.querySelector("style")?.textContent).toBe(
			"#obsidian-hover-preview-g .x{fill:#fff}",
		);
	});

	test("running twice changes nothing more", () => {
		const root = rootWith(
			'<label for="i">L</label><input id="i" type="radio" name="n">' +
				'<svg id="s"><use href="#s"></use><style></style></svg>',
		);
		root.querySelector("style")?.append("#s{}");
		isolateIds(root);
		const once = root.innerHTML;
		isolateIds(root);
		expect(root.innerHTML).toBe(once);
	});
});

describe("sliceToAnchor", () => {
	function sliced(html: string, anchor: Parameters<typeof sliceToAnchor>[1]) {
		const root = rootWith(html);
		isolateIds(root);
		const result = sliceToAnchor(root, anchor);
		return { root, result, text: visibleText(root) };
	}

	test("a heading keeps its section, up to the next heading of its level", () => {
		const { result, text } = sliced(
			'<h1 id="t">Title</h1><p>intro</p><h2 id="a">A</h2><p>a body</p><h3 id="a1">A1</h3>' +
				'<p>a1 body</p><h2 id="b">B</h2><p>b body</p>',
			{ kind: "heading", ids: ["Install", "a"] },
		);
		expect(result).toBe("section");
		expect(text).toBe("A a body A1 a1 body");
	});

	test("a heading nested in a callout keeps the callout", () => {
		const { text } = sliced(
			'<p>before</p><div class="callout"><h3 id="n">N</h3><p>inside</p></div><p>after</p>',
			{ kind: "heading", ids: ["n"] },
		);
		expect(text).toBe("N inside");
	});

	test("a block in a list keeps only its item", () => {
		const { root, result, text } = sliced(
			'<p>before</p><ul><li>one</li><li>two<span id="^two"></span></li></ul>',
			{ kind: "block", id: "^two" },
		);
		expect(result).toBe("block");
		expect(text).toBe("two");
		expect(root.querySelector("ul")?.hasAttribute("data-preview-path")).toBe(true);
	});

	test("a block in a nested list hides the parent item's own text", () => {
		const { text } = sliced(
			'<p>before</p><ul><li>parent text<ul><li>child <span id="^c"></span></li>' +
				"<li>other child</li></ul></li><li>sibling</li></ul><p>after</p>",
			{ kind: "block", id: "^c" },
		);
		expect(text).toBe("child");
	});

	test("a standalone block id keeps the block before it", () => {
		const { text } = sliced(
			'<p>before</p><table><tbody><tr><td>cell</td></tr></tbody></table><p>\n<span id="^t"></span> </p><p>after</p>',
			{ kind: "block", id: "^t" },
		);
		expect(text).toBe("cell");
	});

	test("an image paragraph with a block id keeps itself, not the block before", () => {
		const { root } = sliced(
			'<p>before</p><p><img src="fig.png" alt="Figure"><span id="^fig"></span></p><p>after</p>',
			{ kind: "block", id: "^fig" },
		);
		const shown = [...root.querySelectorAll<HTMLElement>(":scope > *")].filter(
			(child) => child.style.display !== "none",
		);
		expect(shown.map((child) => child.innerHTML)).toEqual([
			'<img src="fig.png" alt="Figure"><span id="obsidian-hover-preview-^fig"></span>',
		]);
	});

	test("an inline block id keeps its paragraph", () => {
		const { text } = sliced('<p>first</p><p>second<span id="^s"></span></p>', {
			kind: "block",
			id: "^s",
		});
		expect(text).toBe("second");
	});

	test("a missing anchor shows the whole note and marks nothing", () => {
		const { root, result, text } = sliced('<h2 id="a">A</h2><p>body</p>', {
			kind: "heading",
			ids: ["nope"],
		});
		expect(result).toBe("missing");
		expect(text).toBe("A body");
		expect(
			root.querySelectorAll(
				"[data-preview-keep], [data-preview-path], [data-preview-hide], [style]",
			).length,
		).toBe(0);
	});

	test("re-slicing clears the previous slice", () => {
		const root = rootWith('<h2 id="a">A</h2><p>a</p><h2 id="b">B</h2><p>b</p>');
		isolateIds(root);
		sliceToAnchor(root, { kind: "heading", ids: ["a"] });
		const once = root.innerHTML;
		sliceToAnchor(root, { kind: "heading", ids: ["a"] });
		expect(root.innerHTML).toBe(once);
		expect(sliceToAnchor(root, { kind: "heading", ids: ["b"] })).toBe("section");
		expect(visibleText(root)).toBe("B b");
		expect(sliceToAnchor(root, null)).toBe("whole");
		expect(visibleText(root)).toBe("A a B b");
	});
});
