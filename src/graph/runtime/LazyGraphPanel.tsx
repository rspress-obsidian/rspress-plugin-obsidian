import { lazy, Suspense, useEffect, useState } from "react";

// Lazy load heavy graph components
const GraphPanel = lazy(() => import("./GraphPanel"));

interface LazyGraphPanelProps {
	defaultOpen?: boolean;
	colors?: Record<string, string>;
}

function GraphPanelFallback() {
	return (
		<div
			style={{
				position: "fixed",
				bottom: 24,
				right: 24,
				zIndex: 9999,
				width: 48,
				height: 48,
				borderRadius: "50%",
				background: "linear-gradient(135deg, #3f3f3f 0%, #262626 50%, #3f3f3f 100%)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<svg
				role="img"
				aria-label="Loading graph"
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{ color: "#fff", animation: "gv-fab-pulse 3s ease-in-out infinite" }}
			>
				<title>Loading graph</title>
				<circle cx="5" cy="6" r="2.5" />
				<circle cx="19" cy="6" r="2.5" />
				<circle cx="12" cy="18" r="2.5" />
				<line x1="7.5" y1="6" x2="16.5" y2="6" />
				<line x1="6.5" y1="8" x2="10.5" y2="16" />
				<line x1="17.5" y1="8" x2="13.5" y2="16" />
			</svg>
		</div>
	);
}

export function LazyGraphPanel({ defaultOpen, colors }: LazyGraphPanelProps) {
	const [shouldLoad, setShouldLoad] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => {
			setShouldLoad(true);
		}, 100);

		return () => clearTimeout(timer);
	}, []);

	if (!shouldLoad) {
		return <GraphPanelFallback />;
	}

	return (
		<Suspense fallback={<GraphPanelFallback />}>
			<GraphPanel defaultOpen={defaultOpen} colors={colors} />
		</Suspense>
	);
}
export default LazyGraphPanel;
