import { type CSSProperties, forwardRef, useEffect } from "react";
import { injectStyles } from "../keyframes.js";
import GraphIcon from "./GraphIcon.js";

const FAB_STYLE_ID = "graph-fab-keyframes";

const FAB_KEYFRAMES = `
    @keyframes gv-fab-pulse {
      0%, 100% { box-shadow: 0 2px 16px rgba(99,102,241,0.35), 0 0 0 0 rgba(99,102,241,0.3); }
      50% { box-shadow: 0 4px 20px rgba(99,102,241,0.5), 0 0 0 6px rgba(99,102,241,0); }
    }
    @keyframes gv-fab-spin-in {
      from { transform: rotate(-90deg) scale(0.8); opacity: 0; }
      to { transform: rotate(0deg) scale(1); opacity: 1; }
    }
  `;

/** The button the feature hangs on: in the corner, above every page element. */
const FAB_STYLE: CSSProperties = {
	position: "fixed",
	bottom: 24,
	right: 24,
	zIndex: 9999,
	width: 48,
	height: 48,
	borderRadius: "50%",
	border: "none",
	padding: 0,
	background: "linear-gradient(135deg, #3f3f3f 0%, #262626 50%, #3f3f3f 100%)",
	color: "#fff",
	cursor: "pointer",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	animation: "gv-fab-pulse 3s ease-in-out infinite",
	transition: "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease",
};

/** A fullscreen panel fades the FAB out; it must leave the tab order too. */
const HIDDEN_STYLE: CSSProperties = {
	opacity: 0,
	pointerEvents: "none",
	cursor: "default",
	animation: "none",
};

const ICON_STYLE: CSSProperties = { filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.2))" };

interface GraphFabProps {
	/** The accessible name: the words the icon stands for. */
	label: string;
	/** The panel is open: the icon becomes a close cross. */
	open?: boolean;
	/** The panel fills the screen: the FAB is out of sight and out of the tab order. */
	hidden?: boolean;
	/** The panel's chunk is still downloading: a pulsing placeholder, not a button. */
	loading?: boolean;
	onClick?: () => void;
	ariaControls?: string;
	ariaExpanded?: boolean;
}

const GraphFab = forwardRef<HTMLButtonElement, GraphFabProps>(function GraphFab(
	{ label, open = false, hidden = false, loading = false, onClick, ariaControls, ariaExpanded },
	ref,
) {
	useEffect(() => injectStyles(FAB_STYLE_ID, FAB_KEYFRAMES), []);

	if (loading) {
		return (
			<div style={FAB_STYLE} role="img" aria-label={label}>
				<GraphIcon
					size={20}
					style={{ ...ICON_STYLE, animation: "gv-fab-pulse 3s ease-in-out infinite" }}
				/>
			</div>
		);
	}

	return (
		<button
			ref={ref}
			type="button"
			onClick={onClick}
			aria-controls={ariaControls}
			aria-expanded={ariaExpanded}
			aria-hidden={hidden}
			tabIndex={hidden ? -1 : 0}
			style={hidden ? { ...FAB_STYLE, ...HIDDEN_STYLE } : FAB_STYLE}
			onMouseEnter={(event) => {
				if (hidden) return;
				event.currentTarget.style.transform = "scale(1.12)";
				event.currentTarget.style.animationPlayState = "paused";
			}}
			onMouseLeave={(event) => {
				if (hidden) return;
				event.currentTarget.style.transform = "scale(1)";
				event.currentTarget.style.animationPlayState = "running";
			}}
			aria-label={label}
		>
			{open ? (
				<svg
					aria-hidden="true"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={ICON_STYLE}
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			) : (
				<GraphIcon size={20} style={{ ...ICON_STYLE, animation: "gv-fab-spin-in 0.4s ease-out" }} />
			)}
		</button>
	);
});

export default GraphFab;
