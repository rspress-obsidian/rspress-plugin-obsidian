import {
	initPageData,
	PageContext,
	pathnameToRouteService,
	removeBase,
} from "@rspress/core/runtime";
import { Callout, getCustomMDXComponent } from "@rspress/core/theme";
import type { ComponentType, CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
	Component,
	Suspense,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigateTo, usePathname } from "../../shared/usePathname.js";
import type {
	Placement,
	PreviewEvent,
	PreviewPage,
	PreviewTarget,
	ShownPreview,
} from "./hover-preview-model.js";
import {
	anchorInPlace,
	anchorRectAt,
	CLOSE_GRACE_MS,
	HOVER_DELAY_MS,
	IDLE,
	isolateIds,
	POPOVER_CLASS,
	placePopover,
	popoverWidth,
	previewTargetFor,
	reducePreview,
	shownPreview,
	sliceToAnchor,
} from "./hover-preview-model.js";

interface PreviewHeadingProps {
	id?: string;
	className?: string;
	children?: ReactNode;
}

/**
 * Plain headings in place of the theme's: no `rp-toc-include` class, Tag badge
 * or LLMs buttons, so nothing in a popover joins the host's outline or acts on
 * the wrong page.
 */
const PREVIEW_HEADINGS: Record<
	"h1" | "h2" | "h3" | "h4" | "h5" | "h6",
	ComponentType<PreviewHeadingProps>
> = {
	h1: (props) => <h1 {...props} />,
	h2: (props) => <h2 {...props} />,
	h3: (props) => <h3 {...props} />,
	h4: (props) => <h4 {...props} />,
	h5: (props) => <h5 {...props} />,
	h6: (props) => <h6 {...props} />,
};

/**
 * The MDX components `DocContent` provides on a real page, with the headings
 * replaced. Passed as the page component's `components` prop, which MDX spreads
 * over its provider's, so no `MDXProvider` is needed.
 */
const PREVIEW_COMPONENTS = {
	...getCustomMDXComponent(),
	$$$callout$$$: Callout,
	...PREVIEW_HEADINGS,
};

const POPOVER_SELECTOR = `.${POPOVER_CLASS}`;
/**
 * What Bases' map component keys on (`MAP_CONFIG_ATTRIBUTE` in markdown's
 * `bases/runtime/map-markup.ts`; browser code may not import across features).
 */
const BASES_MAP_ATTRIBUTE = "data-bases-map";

/**
 * Resolve and load the page a target names, or undefined when no route matches
 * (an attachment, an unpublished note). The module comes from `route.preload()`,
 * the memoized import Rspress's `Link` already started on hover. The data comes
 * from `initPageData`, never `warmPageData`, which is the App's one navigation
 * slot. Components rendered inside should take page identity from `usePage()`,
 * not the router: the location stays the host page's.
 */
async function loadPreviewPage(target: PreviewTarget): Promise<PreviewPage | undefined> {
	const route = pathnameToRouteService(removeBase(target.pathname));
	if (!route) return undefined;
	const [module, data] = await Promise.all([route.preload(), initPageData(route.path)]);
	const Content: ComponentType<{ components?: object }> = module.default;
	const requested = target.anchor;
	return {
		routePath: route.path,
		content: (
			<PageContext.Provider value={{ data }}>
				<Content components={PREVIEW_COMPONENTS} />
			</PageContext.Provider>
		),
		fallbackTitle: data.headingTitle || !data.title ? null : data.title,
		anchor:
			requested?.kind === "heading"
				? {
						kind: "heading",
						// Dynamic: the slugger is needed only for heading links, and this
						// component loads on every page.
						ids: [
							requested.text,
							(await import("../../shared/slug.js")).slugifyHeading(requested.text),
						],
					}
				: requested,
	};
}

/**
 * Keeps a page that throws while rendering inside the popover from reaching the
 * App root: a portal's render errors propagate up the React tree.
 */
class PreviewErrorBoundary extends Component<
	{ onError: () => void; children: ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch() {
		this.props.onError();
	}
	override render() {
		return this.state.failed ? null : this.props.children;
	}
}

function geometry(placement: Placement | null): CSSProperties {
	if (!placement) {
		return { left: 0, top: 0, width: popoverWidth(window.innerWidth), visibility: "hidden" };
	}
	const { side, ...box } = placement;
	return box;
}

/**
 * The popover: a portal into `document.body`, outside `.rspress-doc` so the
 * outline never sees it, inside body so the Mermaid scanner draws its diagrams.
 * Before first paint, per preview: prefix ids, turn Bases maps back into their
 * tables (no MapLibre download on hover, no map fighting the wheel), slice to
 * the anchor, measure and place. A mutation observer repeats all but placement
 * for content that renders late; the popover never moves under the pointer.
 */
function PreviewPopover({ shown, onDismiss }: { shown: ShownPreview; onDismiss: () => void }) {
	const popoverRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const navigateTo = useNavigateTo();
	const { anchorRect } = shown.request;
	const { anchor, routePath, fallbackTitle, content } = shown.page;

	useLayoutEffect(() => {
		const popover = popoverRef.current;
		const body = bodyRef.current;
		if (!popover || !body) return;
		const prepare = () => {
			isolateIds(body);
			for (const map of body.querySelectorAll(`[${BASES_MAP_ATTRIBUTE}]`)) {
				map.removeAttribute(BASES_MAP_ATTRIBUTE);
			}
			sliceToAnchor(body, anchor);
		};
		prepare();
		popover.scrollTop = 0;
		setPlacement(
			placePopover(anchorRect, popover.scrollHeight, {
				width: window.innerWidth,
				height: window.innerHeight,
			}),
		);
		const observer = new MutationObserver(prepare);
		observer.observe(body, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [anchor, anchorRect]);

	// A hash link (a footnote, a back-reference) would scroll the host page;
	// send it to the previewed page instead.
	const onClick = (event: ReactMouseEvent) => {
		const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
		if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
		event.preventDefault();
		navigateTo(`${routePath}${link.getAttribute("href")}`);
		onDismiss();
	};

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: the click handler only reroutes hash links inside, which stay keyboard-operable themselves
		<div
			ref={popoverRef}
			className={POPOVER_CLASS}
			data-side={placement?.side}
			style={{
				position: "fixed",
				zIndex: 10000,
				overflow: "auto",
				// Wheeling past the end would scroll the host page, and a host scroll dismisses.
				overscrollBehavior: "contain",
				background: "var(--rp-c-bg)",
				...geometry(placement),
			}}
			onClick={onClick}
		>
			<div ref={bodyRef} className={`${POPOVER_CLASS}__body rp-doc`}>
				{fallbackTitle && <h1>{fallbackTitle}</h1>}
				<PreviewErrorBoundary onError={onDismiss}>
					{/* A child that suspends must not suspend the host page. */}
					<Suspense fallback={null}>{content}</Suspense>
				</PreviewErrorBoundary>
			</div>
		</div>,
		document.body,
	);
}

/**
 * Obsidian's Page preview. Registered through `globalUIComponents` by
 * `graphview({ enableHoverPreviews: true })`. Every timer, load and listener is
 * derived from the lifecycle state, so leaving a phase cancels its work.
 */
export default function HoverPreview() {
	const [state, dispatch] = useReducer(reducePreview, IDLE);
	const pathname = usePathname();
	const request = state.phase === "pending" ? state.request : null;
	const anchored = request ?? shownPreview(state)?.request ?? null;

	useEffect(() => {
		const linkFrom = (event: PointerEvent) => {
			const element = event.target instanceof Element ? event.target : null;
			const link = element?.closest("a[href]");
			return link instanceof HTMLAnchorElement ? link : null;
		};
		// Mouse only: pen and touch never open a preview. `pointerover` and
		// `pointerout` bubble on every child crossing, so each is matched against
		// the element on its other side.
		const onOver = (event: PointerEvent) => {
			if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
			const from = event.relatedTarget instanceof Node ? event.relatedTarget : null;
			const popover = event.target.closest(POPOVER_SELECTOR);
			if (popover) {
				if (!popover.contains(from)) dispatch({ type: "enterPopover" });
				return;
			}
			const link = linkFrom(event);
			if (!link || link.contains(from)) return;
			const target = previewTargetFor(link, window.location);
			if (!target) return;
			const anchorRect = anchorRectAt(link, event.clientX, event.clientY);
			dispatch({ type: "enterLink", request: { link, target, anchorRect } });
		};
		const onOut = (event: PointerEvent) => {
			if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
			const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
			const popover = event.target.closest(POPOVER_SELECTOR);
			if (popover) {
				if (!popover.contains(to)) dispatch({ type: "leavePopover" });
				return;
			}
			const link = linkFrom(event);
			if (link && !link.contains(to) && previewTargetFor(link, window.location)) {
				dispatch({ type: "leaveLink" });
			}
		};
		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointerout", onOut);
		return () => {
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointerout", onOut);
		};
	}, []);

	useEffect(() => {
		if (!request) return;
		const { link } = request;
		const timer = setTimeout(() => dispatch({ type: "delayElapsed", link }), HOVER_DELAY_MS);
		loadPreviewPage(request.target).then(
			(page) => dispatch(page ? { type: "pageLoaded", link, page } : { type: "pageMissing", link }),
			() => dispatch({ type: "pageMissing", link }),
		);
		return () => clearTimeout(timer);
	}, [request]);

	useEffect(() => {
		if (state.phase !== "closing") return;
		const timer = setTimeout(() => dispatch({ type: "graceElapsed" }), CLOSE_GRACE_MS);
		return () => clearTimeout(timer);
	}, [state.phase]);

	useEffect(() => {
		if (!anchored) return;
		const dismiss: PreviewEvent = { type: "dismiss" };
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") dispatch(dismiss);
		};
		const onOutside = (event: Event) => {
			if (!(event.target instanceof Element && event.target.closest(POPOVER_SELECTOR))) {
				dispatch(dismiss);
			}
		};
		// A fixed popover would drift off its link. Content loading above the link
		// scrolls the page without moving the link (scroll anchoring), so a scroll
		// counts only when the hovered line box moved.
		const onScroll = (event: Event) => {
			const rects = Array.from(anchored.link.getClientRects());
			if (!anchorInPlace(rects, anchored.anchorRect)) onOutside(event);
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onOutside);
		document.addEventListener("scroll", onScroll, { capture: true, passive: true });
		window.addEventListener("resize", onOutside);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onOutside);
			document.removeEventListener("scroll", onScroll, { capture: true });
			window.removeEventListener("resize", onOutside);
		};
	}, [anchored]);

	// `pathname` is the trigger: navigating away closes the preview.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per route
	useEffect(() => dispatch({ type: "dismiss" }), [pathname]);

	const shown = shownPreview(state);
	return shown ? (
		<PreviewPopover shown={shown} onDismiss={() => dispatch({ type: "dismiss" })} />
	) : null;
}
