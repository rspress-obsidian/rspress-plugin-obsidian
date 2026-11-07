import type { CSSProperties } from "react";

export interface GraphIconProps {
	size?: number;
	style?: CSSProperties;
}

export default function GraphIcon({ size = 16, style }: GraphIconProps) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
		>
			<circle cx="5" cy="6" r="2.5" />
			<circle cx="19" cy="6" r="2.5" />
			<circle cx="12" cy="18" r="2.5" />
			<line x1="7.5" y1="6" x2="16.5" y2="6" />
			<line x1="6.5" y1="8" x2="10.5" y2="16" />
			<line x1="17.5" y1="8" x2="13.5" y2="16" />
		</svg>
	);
}
