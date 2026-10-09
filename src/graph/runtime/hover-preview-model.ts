import type { ReactElement } from "react";

/** What the link's fragment asks for, before the page is loaded. */
export type RequestedAnchor =
	| { kind: "heading"; text: string } // decoded `#Install`, `#second-section`
	| { kind: "block"; id: string }; // decoded `#^blk` → "^blk"

/** What a qualifying link points at. A pure function of the href and location. */
export interface PreviewTarget {
	/** URL pathname, still carrying the site base; the loader strips it. */
	pathname: string;
	anchor: RequestedAnchor | null;
}

/**
 * The anchor resolved against the slug rules the page used for its ids: a
 * heading carries every id it may render as, in preference order (the decoded
 * fragment as written, then its github-slugger slug).
 */
export type ResolvedAnchor =
	| { kind: "heading"; ids: readonly string[] }
	| { kind: "block"; id: string };

/** A loaded preview: everything the popover body needs. */
export interface PreviewPage {
	/** Rspress route path (base removed). */
	routePath: string;
	/** The route's page component under the target page's own `PageContext`. */
	content: ReactElement;
	/** The page title when the page renders no `# heading` of its own, else null. */
	fallbackTitle: string | null;
	anchor: ResolvedAnchor | null;
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface Size {
	width: number;
	height: number;
}

/** One hover of one link: the link, where it points, and the line box hovered. */
export interface PreviewRequest {
	link: HTMLAnchorElement;
	target: PreviewTarget;
	anchorRect: Rect;
}

/** A popover on screen, or in its grace period. */
export interface ShownPreview {
	request: PreviewRequest;
	page: PreviewPage;
}

/**
 * The lifecycle. Every timer, load and listener in the component is derived
 * from the current phase.
 *
 * - idle: nothing hovered, nothing shown.
 * - pending: a link is hovered; the hover delay and the page load race.
 *   `shown` keeps the previous popover on screen while the pointer crosses
 *   another link on its way into that popover.
 * - open: popover visible; pointer on link or popover.
 * - closing: pointer left both; grace timer running.
 */
export type PreviewState =
	| { phase: "idle" }
	| {
			phase: "pending";
			request: PreviewRequest;
			page: PreviewPage | null;
			delayElapsed: boolean;
			shown: ShownPreview | null;
	  }
	| { phase: "open"; shown: ShownPreview }
	| { phase: "closing"; shown: ShownPreview };

export type PreviewEvent =
	| { type: "enterLink"; request: PreviewRequest }
	| { type: "leaveLink" }
	| { type: "enterPopover" }
	| { type: "leavePopover" }
	| { type: "delayElapsed"; link: HTMLAnchorElement }
	| { type: "pageLoaded"; link: HTMLAnchorElement; page: PreviewPage }
	| { type: "pageMissing"; link: HTMLAnchorElement }
	| { type: "graceElapsed" }
	/** Escape, route change, a host scroll that moves the link, resize, pointerdown outside, render error. */
	| { type: "dismiss" };

export const IDLE: PreviewState = { phase: "idle" };
export const HOVER_DELAY_MS = 300;
export const CLOSE_GRACE_MS = 300;
/** Obsidian's `--popover-width` and `--popover-height`. */
export const POPOVER_WIDTH = 450;
export const POPOVER_MAX_HEIGHT = 400;
/** Gap between the link and the popover. */
export const POPOVER_GAP = 6;
export const VIEWPORT_MARGIN = 8;
export const POPOVER_CLASS = "obsidian-hover-preview";
/** Every id inside the popover carries this, so none collides with the host page's. */
export const ID_PREFIX = "obsidian-hover-preview-";

type Pending = Extract<PreviewState, { phase: "pending" }>;

function pendingFor(request: PreviewRequest, shown: ShownPreview | null): Pending {
	return { phase: "pending", request, page: null, delayElapsed: false, shown };
}

function reducePending(state: Pending, event: PreviewEvent): PreviewState {
	switch (event.type) {
		case "enterLink":
			if (state.shown && event.request.link === state.shown.request.link) {
				return { phase: "open", shown: state.shown };
			}
			return event.request.link === state.request.link
				? state
				: pendingFor(event.request, state.shown);
		case "leaveLink":
			return state.shown ? { phase: "closing", shown: state.shown } : IDLE;
		case "enterPopover":
			return state.shown ? { phase: "open", shown: state.shown } : state;
		case "delayElapsed":
			if (event.link !== state.request.link) return state;
			return state.page
				? { phase: "open", shown: { request: state.request, page: state.page } }
				: { ...state, delayElapsed: true };
		case "pageLoaded":
			if (event.link !== state.request.link) return state;
			return state.delayElapsed
				? { phase: "open", shown: { request: state.request, page: event.page } }
				: { ...state, page: event.page };
		case "pageMissing":
			if (event.link !== state.request.link) return state;
			return state.shown ? { phase: "closing", shown: state.shown } : IDLE;
		default:
			return state;
	}
}

/**
 * The transition function. Pure and total: an event that does not apply to the
 * current phase returns `state` itself, so React skips the render. Loads and
 * timers carry the link they were started for; one whose link is no longer
 * `pending.request.link` is stale and ignored.
 *
 * | from     | event                        | to                                            |
 * |----------|------------------------------|-----------------------------------------------|
 * | idle     | enterLink(r)                 | pending(r, page null, delay false, shown null)|
 * | pending  | enterLink(shown link)        | open(shown), abandoning the new request       |
 * | pending  | enterLink(same link)         | unchanged                                     |
 * | pending  | enterLink(other)             | pending(other, shown kept)                    |
 * | pending  | leaveLink                    | shown ? closing(shown) : idle                 |
 * | pending  | enterPopover (shown ≠ null)  | open(shown), abandoning the new request       |
 * | pending  | delayElapsed(link)           | page ? open({request, page}) : delay true     |
 * | pending  | pageLoaded(link, p)          | delay ? open({request, p}) : page p           |
 * | pending  | pageMissing(link)            | shown ? closing(shown) : idle                 |
 * | open     | leaveLink / leavePopover     | closing(shown)                                |
 * | open     | enterLink(same link)         | unchanged                                     |
 * | open     | enterLink(other)             | pending(other, shown = current)               |
 * | closing  | enterLink(same link)         | open(shown)                                   |
 * | closing  | enterPopover                 | open(shown)                                   |
 * | closing  | enterLink(other)             | pending(other, shown = current)               |
 * | closing  | graceElapsed                 | idle                                          |
 * | any      | dismiss                      | idle                                          |
 */
export function reducePreview(state: PreviewState, event: PreviewEvent): PreviewState {
	if (event.type === "dismiss") return IDLE;
	switch (state.phase) {
		case "idle":
			return event.type === "enterLink" ? pendingFor(event.request, null) : state;
		case "pending":
			return reducePending(state, event);
		case "open":
			if (event.type === "leaveLink" || event.type === "leavePopover") {
				return { phase: "closing", shown: state.shown };
			}
			if (event.type === "enterLink" && event.request.link !== state.shown.request.link) {
				return pendingFor(event.request, state.shown);
			}
			return state;
		case "closing":
			if (event.type === "graceElapsed") return IDLE;
			if (event.type === "enterPopover") return { phase: "open", shown: state.shown };
			if (event.type === "enterLink") {
				return event.request.link === state.shown.request.link
					? { phase: "open", shown: state.shown }
					: pendingFor(event.request, state.shown);
			}
			return state;
	}
}

/** The popover on screen for a state, or null. */
export function shownPreview(state: PreviewState): ShownPreview | null {
	return state.phase === "idle" ? null : state.shown;
}

/** Links that point somewhere but are page chrome, not a reference to a note. */
const EXCLUDED_LINKS =
	".rp-header-anchor, .footnote-ref a, .footnote-backref, .canvas-footnote-ref a, .canvas-footnote-backref, [download]";

/**
 * Where a qualifying link points, or undefined when the link must not preview.
 * A link qualifies when it sits in the host article (`.rspress-doc`, which
 * leaves out the sidebar, nav, outline, prev/next and the graph panel), not in
 * a popover (one level of preview), is not page chrome, and is same-origin
 * http(s). A hash-only href targets the current page. The query is ignored;
 * the fragment is percent-decoded, and a leading `^` names a block.
 */
export function previewTargetFor(
	link: HTMLAnchorElement,
	location: Pick<Location, "href" | "origin">,
): PreviewTarget | undefined {
	if (!link.closest(".rspress-doc") || link.closest(`.${POPOVER_CLASS}`)) return undefined;
	if (link.matches(EXCLUDED_LINKS)) return undefined;
	let url: URL;
	try {
		url = new URL(link.getAttribute("href") ?? "", location.href);
	} catch {
		return undefined;
	}
	if (url.origin !== location.origin || !url.protocol.startsWith("http")) return undefined;
	const fragment = decodeFragment(url.hash.slice(1));
	if (!fragment) return { pathname: url.pathname, anchor: null };
	return {
		pathname: url.pathname,
		anchor: fragment.startsWith("^")
			? { kind: "block", id: fragment }
			: { kind: "heading", text: fragment },
	};
}

function decodeFragment(fragment: string): string {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return fragment;
	}
}

/** The link's client rect containing the pointer, else its first one. */
export function anchorRectAt(link: Element, clientX: number, clientY: number): Rect {
	const rects = Array.from(link.getClientRects());
	const hit =
		rects.find(
			(rect) =>
				clientX >= rect.left &&
				clientX <= rect.right &&
				clientY >= rect.top &&
				clientY <= rect.bottom,
		) ??
		rects[0] ??
		link.getBoundingClientRect();
	return { left: hit.left, top: hit.top, right: hit.right, bottom: hit.bottom };
}

/** Sub-pixel layout nudges a line box by a pixel without moving it for the reader. */
const ANCHOR_TOLERANCE = 2;

/**
 * Whether the line box a request is anchored to is still where it was hovered,
 * given the link's current client rects. A wrapped link's lines move together,
 * so the anchor is in place when any one of them still sits at its corner.
 */
export function anchorInPlace(rects: readonly Rect[], anchor: Rect): boolean {
	return rects.some(
		(rect) =>
			Math.abs(rect.top - anchor.top) <= ANCHOR_TOLERANCE &&
			Math.abs(rect.left - anchor.left) <= ANCHOR_TOLERANCE,
	);
}

export type Placement =
	| { side: "below"; left: number; top: number; width: number; maxHeight: number }
	| { side: "above"; left: number; bottom: number; width: number; maxHeight: number };

/** The popover's width in a viewport this wide. */
export function popoverWidth(viewportWidth: number): number {
	return Math.min(POPOVER_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN);
}

/**
 * Below the hovered line box, left edges aligned, clamped inside the viewport
 * margin; above when the content does not fit below and there is more room
 * above. An "above" popover is pinned by `bottom`, so content that grows after
 * placement (a Mermaid diagram drawing) grows away from the link.
 */
export function placePopover(anchor: Rect, contentHeight: number, viewport: Size): Placement {
	const width = popoverWidth(viewport.width);
	const left = Math.max(
		VIEWPORT_MARGIN,
		Math.min(anchor.left, viewport.width - VIEWPORT_MARGIN - width),
	);
	const roomBelow = viewport.height - anchor.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
	const roomAbove = anchor.top - POPOVER_GAP - VIEWPORT_MARGIN;
	const wanted = Math.min(contentHeight, POPOVER_MAX_HEIGHT);
	if (roomBelow >= wanted || roomBelow >= roomAbove) {
		return {
			side: "below",
			left,
			top: anchor.bottom + POPOVER_GAP,
			width,
			maxHeight: Math.min(POPOVER_MAX_HEIGHT, roomBelow),
		};
	}
	return {
		side: "above",
		left,
		bottom: viewport.height - anchor.top + POPOVER_GAP,
		width,
		maxHeight: Math.min(POPOVER_MAX_HEIGHT, roomAbove),
	};
}

/** Attributes whose space-separated tokens name an element by id. */
const ID_REFERENCE_ATTRIBUTES = ["for", "aria-labelledby", "aria-describedby", "aria-controls"];
const SVG_URL_REFERENCE = /url\((['"]?)#([^'")]+)\1\)/g;
const CSS_ID_SELECTOR = /#([\w-]+)/g;

/**
 * Give every id in the popover `ID_PREFIX`, and make every reference inside
 * the popover follow it, so nothing in the preview collides with or drives the
 * host page: `label[for]` and ARIA references, radio group names (Bases view
 * switchers are radio/label pairs), and SVG references (`url(#…)`, `href="#…"`
 * on non-links, `#id` selectors in SVG `<style>`). Hash links (`<a href="#…">`)
 * are left alone: the popover sends their clicks to the previewed page.
 * Idempotent; re-run for content that renders late.
 */
export function isolateIds(root: Element): void {
	for (const element of root.querySelectorAll("[id]")) {
		if (!element.id.startsWith(ID_PREFIX)) element.id = `${ID_PREFIX}${element.id}`;
	}
	const ids = new Set(Array.from(root.querySelectorAll("[id]"), (element) => element.id));
	const follow = (id: string) => (ids.has(`${ID_PREFIX}${id}`) ? `${ID_PREFIX}${id}` : id);
	const rewrite = (element: Element, name: string, value: string) => {
		if (element.getAttribute(name) !== value) element.setAttribute(name, value);
	};

	for (const name of ID_REFERENCE_ATTRIBUTES) {
		for (const element of root.querySelectorAll(`[${name}]`)) {
			const value = element.getAttribute(name) ?? "";
			rewrite(element, name, value.split(/\s+/).map(follow).join(" "));
		}
	}
	for (const radio of root.querySelectorAll('input[type="radio"][name]')) {
		const name = radio.getAttribute("name") ?? "";
		if (!name.startsWith(ID_PREFIX)) radio.setAttribute("name", `${ID_PREFIX}${name}`);
	}
	for (const element of root.querySelectorAll("svg, svg *")) {
		for (const { name, value } of Array.from(element.attributes)) {
			if ((name === "href" || name === "xlink:href") && element.localName !== "a") {
				if (value.startsWith("#")) rewrite(element, name, `#${follow(value.slice(1))}`);
			} else if (value.includes("url(")) {
				rewrite(
					element,
					name,
					value.replace(
						SVG_URL_REFERENCE,
						(_match, quote: string, id: string) => `url(${quote}#${follow(id)}${quote})`,
					),
				);
			}
		}
		if (element.localName === "style") {
			const css = element.textContent ?? "";
			const next = css.replace(CSS_ID_SELECTOR, (_match, id: string) => `#${follow(id)}`);
			if (next !== css) element.textContent = next;
		}
	}
}

export type SliceResult = "whole" | "section" | "block" | "missing";

const KEEP = "data-preview-keep";
const PATH = "data-preview-path";
const HIDE = "data-preview-hide";
/**
 * The inline style each slice mark sets, removed with the mark on the next run.
 * Inline, so slicing works without the optional stylesheet and beats theme
 * rules such as `.rp-doc hr { display: block }` that a `hidden` attribute loses
 * to. A path element's `visibility` hides its own text and list marker (a
 * nested list item's parent line) while the kept block stays visible.
 */
const MARK_STYLES: Record<string, [property: string, value: string]> = {
	[KEEP]: ["visibility", "visible"],
	[PATH]: ["visibility", "hidden"],
	[HIDE]: ["display", "none"],
};
const HEADING_LEVEL = /^h([1-6])$/;

function headingLevel(element: Element): number | undefined {
	const level = HEADING_LEVEL.exec(element.localName)?.[1];
	return level === undefined ? undefined : Number(level);
}

/** The heading and its following siblings up to the next heading of the same or a higher level. */
function sectionFrom(heading: Element, level: number): Element[] {
	const kept = [heading];
	for (let next = heading.nextElementSibling; next; next = next.nextElementSibling) {
		const nextLevel = headingLevel(next);
		if (nextLevel !== undefined && nextLevel <= level) break;
		kept.push(next);
	}
	return kept;
}

/**
 * The block an anchor sits in: its nearest `li` inside `root`, else its
 * top-level ancestor. A top-level block holding nothing but the anchor (a
 * standalone `^id` line) names the block before it, as in Obsidian.
 */
function blockOf(root: Element, target: Element): Element {
	const item = target.closest("li");
	if (item && item !== root && root.contains(item)) return item;
	let block = target;
	while (block.parentElement && block.parentElement !== root) block = block.parentElement;
	const previous = block.previousElementSibling;
	const standalone = [...block.childNodes].every(
		(node) => node === target || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()),
	);
	return previous && standalone ? previous : block;
}

/**
 * Hide everything in `root` except the anchored section or block: mark
 * `data-preview-keep` on the kept elements, `data-preview-path` on the
 * ancestors between them and `root`, and `data-preview-hide` on every other
 * child of `root` or a path element, each with its inline style
 * (`MARK_STYLES`). Looks the anchor up by its prefixed id, so it runs after
 * `isolateIds`. A heading that is a direct child of `root` keeps its section;
 * any other target keeps its block. A missing anchor hides nothing, as Obsidian
 * shows the whole note for a dangling heading. Idempotent: clears its previous
 * marks first.
 */
export function sliceToAnchor(root: Element, anchor: ResolvedAnchor | null): SliceResult {
	for (const [attribute, [property]] of Object.entries(MARK_STYLES)) {
		for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
			element.removeAttribute(attribute);
			element.style.removeProperty(property);
		}
	}
	if (!anchor) return "whole";

	const ids = anchor.kind === "heading" ? anchor.ids : [anchor.id];
	const target = ids
		.map((id) => root.querySelector(`[id="${CSS.escape(`${ID_PREFIX}${id}`)}"]`))
		.find((element) => element !== null);
	if (!target) return "missing";

	const level = headingLevel(target);
	const kept =
		level !== undefined && target.parentElement === root
			? sectionFrom(target, level)
			: [blockOf(root, target)];
	const path: Element[] = [];
	for (
		let ancestor = kept[0]?.parentElement ?? null;
		ancestor && ancestor !== root;
		ancestor = ancestor.parentElement
	) {
		path.push(ancestor);
	}
	for (const element of kept) element.setAttribute(KEEP, "");
	for (const element of path) element.setAttribute(PATH, "");
	for (const parent of [root, ...path]) {
		for (const child of parent.querySelectorAll(`:scope > :not([${PATH}], [${KEEP}])`)) {
			child.setAttribute(HIDE, "");
		}
	}
	for (const [attribute, [property, value]] of Object.entries(MARK_STYLES)) {
		for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
			element.style.setProperty(property, value);
		}
	}
	return anchor.kind === "heading" ? "section" : "block";
}
