import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { ComponentType, ElementType, ReactNode } from "react";
import { setTestRoutes } from "../../../../test/rspress-routes";
import { MAP_CONFIG_ATTRIBUTE } from "../../../markdown/obsidian-plugins/bases/runtime/map-markup";
import { navigation } from "../../../shared/usePathname";
import HoverPreview from "../HoverPreview";
import { CLOSE_GRACE_MS, HOVER_DELAY_MS } from "../hover-preview-model";

type MdxComponents = Record<
	"h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span" | "ul" | "li" | "a" | "div",
	ElementType
>;

/** A page component shaped like Rspress's compiled MDX: overridable tags under `components`. */
function mdxPage(body: (n: MdxComponents) => ReactNode): ComponentType<{ components?: object }> {
	return ({ components }) =>
		body({
			h1: "h1",
			h2: "h2",
			h3: "h3",
			h4: "h4",
			h5: "h5",
			h6: "h6",
			p: "p",
			span: "span",
			ul: "ul",
			li: "li",
			a: "a",
			div: "div",
			...components,
		});
}

const ROUTES = [
	{
		path: "/guide/advanced",
		headingTitle: "Advanced",
		default: mdxPage((n) => (
			<>
				<n.h1 id="advanced">Advanced</n.h1>
				<n.p>Configuration reference.</n.p>
				<n.h2 id="options">Options</n.h2>
				<n.p>Every option.</n.p>
			</>
		)),
	},
	{
		path: "/guide/getting-started",
		headingTitle: "Getting Started",
		default: mdxPage((n) => (
			<>
				<n.h1 id="getting-started">Getting Started</n.h1>
				<n.p>Intro.</n.p>
				<n.h2 id="install">Install</n.h2>
				<n.p>
					Run bun add.
					<n.a href="#fn-1">1</n.a>
				</n.p>
				<n.h2 id="configure">Configure</n.h2>
				<n.ul>
					<n.li>First step.</n.li>
					<n.li>
						Second step.
						<n.span className="obsidian-block-anchor" id="^step" />
					</n.li>
				</n.ul>
				<n.div className="bases-map-view" {...{ [MAP_CONFIG_ATTRIBUTE]: "{}" }}>
					Map table
				</n.div>
			</>
		)),
	},
	{
		path: "/Deep Note",
		headingTitle: "Deep Note",
		default: mdxPage((n) => <n.h1 id="deep-note">Deep Note</n.h1>),
	},
	{
		path: "/日本語ノート",
		headingTitle: "日本語ノート",
		default: mdxPage((n) => <n.h1 id="日本語ノート">日本語ノート</n.h1>),
	},
	{
		path: "/untitled",
		title: "Untitled Page",
		default: mdxPage((n) => <n.p>No heading here.</n.p>),
	},
	{
		path: "/throws",
		default: () => {
			throw new Error("broken page");
		},
	},
	{
		path: "/levels",
		headingTitle: "Level 1",
		default: mdxPage((n) => (
			<>
				<n.h1>Level 1</n.h1>
				<n.h2>Level 2</n.h2>
				<n.h3>Level 3</n.h3>
				<n.h4>Level 4</n.h4>
				<n.h5>Level 5</n.h5>
				<n.h6>Level 6</n.h6>
			</>
		)),
	},
	{
		path: "/offline",
		chunkFails: true,
		default: mdxPage((n) => <n.p>Never seen.</n.p>),
	},
];

function articleLink(href: string): HTMLAnchorElement {
	const article = document.createElement("div");
	article.className = "rspress-doc";
	const link = document.createElement("a");
	link.setAttribute("href", href);
	link.textContent = href;
	article.append(link);
	document.body.append(article);
	return link;
}

function pointer(
	type: string,
	target: Element,
	relatedTarget: Element | null = null,
	pointerType = "mouse",
): void {
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, pointerType, relatedTarget, clientX: 5, clientY: 5 }),
	);
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		// Let the page load's promise chain settle before the timers run.
		for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
		vi.advanceTimersByTime(ms);
	});
}

async function hover(link: Element, pointerType = "mouse"): Promise<void> {
	await act(async () => pointer("pointerover", link, null, pointerType));
	await advance(HOVER_DELAY_MS);
}

function popover(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".obsidian-hover-preview");
}

function popoverText(selector: string): string[] {
	return Array.from(popover()?.querySelectorAll(selector) ?? [], (element) =>
		(element.textContent ?? "").trim(),
	);
}

describe("HoverPreview", () => {
	beforeEach(() => {
		setTestRoutes(ROUTES);
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		// React's scheduler may have queued its next tick on the fake clock; a tick
		// dropped with it leaves the scheduler stalled for every later test file.
		vi.runAllTimers();
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	test("a wikilink, a .html link and one with a query and fragment open the rendered page", async () => {
		render(<HoverPreview />);

		await hover(articleLink("/guide/advanced"));
		expect(popoverText("h1")).toEqual(["Advanced"]);
		expect(popoverText("h2")).toEqual(["Options"]);
		cleanup();

		render(<HoverPreview />);
		await hover(articleLink("/guide/getting-started.html"));
		expect(popoverText("h1")).toEqual(["Getting Started"]);
		cleanup();

		render(<HoverPreview />);
		await hover(articleLink("/guide/getting-started.html?from=nav#Install"));
		expect(popoverText("[data-preview-keep]")).toEqual(["Install", "Run bun add.1"]);
	});

	test("percent-encoded hrefs reach routes with spaces and CJK", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/Deep%20Note"));
		expect(popoverText("h1")).toEqual(["Deep Note"]);
		cleanup();

		render(<HoverPreview />);
		await hover(articleLink("/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%8E%E3%83%BC%E3%83%88.html"));
		expect(popoverText("h1")).toEqual(["日本語ノート"]);
	});

	test("a block link keeps only that block", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/guide/getting-started#%5Estep"));
		expect(popoverText("[data-preview-keep]")).toEqual(["Second step."]);
	});

	test("a page without its own heading shows its title", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/untitled"));
		expect(popoverText("h1")).toEqual(["Untitled Page"]);
	});

	test("the popover holds no unprefixed id, outline heading or live map", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/guide/getting-started"));
		const ids = Array.from(popover()?.querySelectorAll("[id]") ?? [], (element) => element.id);
		expect(ids).toEqual([
			"obsidian-hover-preview-getting-started",
			"obsidian-hover-preview-install",
			"obsidian-hover-preview-configure",
			"obsidian-hover-preview-^step",
		]);
		expect(popover()?.querySelectorAll(".rp-toc-include").length).toBe(0);
		expect(popover()?.querySelectorAll(`[${MAP_CONFIG_ATTRIBUTE}]`).length).toBe(0);
		expect(popoverText(".bases-map-view")).toEqual(["Map table"]);
	});

	test("the popover sits in body, fixed, above the graph panel", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/guide/advanced"));
		expect(popover()?.parentElement).toBe(document.body);
		expect(popover()?.style.position).toBe("fixed");
		expect(popover()?.style.zIndex).toBe("10000");
		expect(popover()?.style.visibility).toBe("");
	});

	test("no heading level in the popover joins the outline", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/levels"));
		expect(popoverText("h1, h2, h3, h4, h5, h6")).toEqual([
			"Level 1",
			"Level 2",
			"Level 3",
			"Level 4",
			"Level 5",
			"Level 6",
		]);
		expect(popover()?.querySelectorAll(".rp-toc-include").length).toBe(0);
	});

	test("a link with no page, or whose chunk fails to load, shows nothing", async () => {
		render(<HoverPreview />);
		const missing = articleLink("/guide/missing.html");
		const offline = articleLink("/offline");
		await hover(missing);
		const afterMissing = popover();
		await act(async () => pointer("pointerout", missing, offline));
		await hover(offline);
		expect([afterMissing, popover()]).toEqual([null, null]);

		await hover(articleLink("/guide/advanced"));
		expect(popoverText("h1")).toEqual(["Advanced"]);
	});

	test("touch, and links outside the article, show nothing", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		await hover(link, "touch");
		const afterTouch = popover();

		const sidebar = document.createElement("a");
		sidebar.setAttribute("href", "/guide/advanced");
		document.body.append(sidebar);
		await hover(sidebar);
		expect([afterTouch, popover()]).toEqual([null, null]);

		await hover(link);
		expect(popoverText("h1")).toEqual(["Advanced"]);
	});

	test("leaving the link closes after the grace period", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		await hover(link);

		await act(async () => pointer("pointerout", link, document.body));
		expect(popover()).not.toBeNull();
		await advance(CLOSE_GRACE_MS);
		expect(popover()).toBeNull();
	});

	test("leaving before the hover delay opens nothing", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		await act(async () => pointer("pointerover", link));
		await act(async () => pointer("pointerout", link, document.body));
		await advance(HOVER_DELAY_MS * 2);
		expect(popover()).toBeNull();
	});

	test("moving from the link into the popover keeps it open", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		await hover(link);
		const popup = popover();
		if (!popup) throw new Error("preview did not open");

		await act(async () => {
			pointer("pointerout", link, popup);
			pointer("pointerover", popup, link);
		});
		await advance(CLOSE_GRACE_MS * 2);
		expect(popover()).toBe(popup);

		await act(async () => pointer("pointerout", popup, document.body));
		await advance(CLOSE_GRACE_MS);
		expect(popover()).toBeNull();
	});

	test("hovering another link keeps the open popover until the new one opens", async () => {
		render(<HoverPreview />);
		const first = articleLink("/guide/advanced");
		const second = articleLink("/Deep%20Note");
		await hover(first);

		await act(async () => {
			pointer("pointerout", first, second);
			pointer("pointerover", second, first);
		});
		expect(popoverText("h1")).toEqual(["Advanced"]);
		await advance(HOVER_DELAY_MS);
		expect(popoverText("h1")).toEqual(["Deep Note"]);
	});

	test("Escape, an outside press and a resize each close it", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		const closers = [
			() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
			() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
			() => window.dispatchEvent(new Event("resize")),
		];
		const openThenClosed: [boolean, boolean][] = [];
		for (const close of closers) {
			await hover(link);
			const opened = popover() !== null;
			await act(async () => close());
			openThenClosed.push([opened, popover() === null]);
			await act(async () => pointer("pointerout", link, document.body));
		}
		expect(openThenClosed).toEqual([
			[true, true],
			[true, true],
			[true, true],
		]);
	});

	test("a host scroll closes it only once the link has moved", async () => {
		render(<HoverPreview />);
		const link = articleLink("/guide/advanced");
		let top = 0;
		Object.defineProperty(link, "getClientRects", {
			value: () => [{ left: 0, top, right: 60, bottom: top + 20 }],
		});
		await hover(link);
		const shown = [popover() !== null];
		await act(async () => document.dispatchEvent(new Event("scroll")));
		shown.push(popover() !== null);
		top = 300;
		await act(async () => document.dispatchEvent(new Event("scroll")));
		shown.push(popover() !== null);
		expect(shown).toEqual([true, true, false]);
	});

	test("scrolling or pressing inside the popover keeps it open", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/guide/advanced"));
		const popup = popover();
		await act(async () => {
			popup?.dispatchEvent(new Event("scroll"));
			popup?.querySelector("p")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		});
		expect(popover()).toBe(popup);
	});

	test("a hash link inside goes to the previewed page", async () => {
		const assign = spyOn(navigation, "assign").mockImplementation(() => {});
		try {
			render(<HoverPreview />);
			await hover(articleLink("/guide/getting-started"));
			const footnote = popover()?.querySelector('a[href="#fn-1"]');
			await act(async () => {
				footnote?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
			});
			expect(assign.mock.calls).toEqual([["/guide/getting-started#fn-1"]]);
			expect(popover()).toBeNull();
		} finally {
			assign.mockRestore();
		}
	});

	test("navigating closes it", async () => {
		render(<HoverPreview />);
		await hover(articleLink("/guide/advanced"));
		await act(async () => {
			history.pushState(null, "", "/guide/other");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		expect(popover()).toBeNull();
		history.replaceState(null, "", "/");
	});

	test("a page that throws shows nothing and leaves the host mounted", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		try {
			const host = render(
				<>
					<p>host page</p>
					<HoverPreview />
				</>,
			);
			await hover(articleLink("/throws"));
			expect(popover()).toBeNull();
			expect(host.container.textContent).toBe("host page");
		} finally {
			consoleError.mockRestore();
		}
	});

	test("a hover still pending when the component unmounts never opens a popover", async () => {
		const { unmount } = render(<HoverPreview />);
		await act(async () => pointer("pointerover", articleLink("/guide/advanced")));
		unmount();
		await advance(HOVER_DELAY_MS * 2);
		expect(popover()).toBeNull();
	});
});
