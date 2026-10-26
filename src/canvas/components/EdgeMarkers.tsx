import { memo } from "react";
import type { CanvasEdgeData } from "../types.js";
import { edgeColor, markerIds } from "./CanvasEdge.js";

export interface EdgeMarkersProps {
	edges: CanvasEdgeData[];
	/** The renderer instance's id prefix, shared with each `CanvasEdge`'s marker references. */
	idPrefix: string;
}

/**
 * The `<defs>` holding both arrowheads of every edge. Arrowheads depend only on
 * the edges' ids and colours, and the memo keys on the edge list, so a card
 * drag never rebuilds them.
 */
export const EdgeMarkers = memo(function EdgeMarkers({ edges, idPrefix }: EdgeMarkersProps) {
	return (
		<defs>
			{edges.map((edge) => {
				const color = edgeColor(edge.color);
				const ids = markerIds(idPrefix, edge.id);
				return (
					<g key={edge.id}>
						<marker
							id={ids.end}
							markerWidth="10"
							markerHeight="7"
							refX="9"
							refY="3.5"
							orient="auto"
							markerUnits="userSpaceOnUse"
						>
							<polygon points="0 0, 10 3.5, 0 7" fill={color} />
						</marker>
						<marker
							id={ids.start}
							markerWidth="10"
							markerHeight="7"
							refX="1"
							refY="3.5"
							orient="auto"
							markerUnits="userSpaceOnUse"
						>
							<polygon points="10 0, 0 3.5, 10 7" fill={color} />
						</marker>
					</g>
				);
			})}
		</defs>
	);
});
