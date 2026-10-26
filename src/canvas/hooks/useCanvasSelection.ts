import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";

export interface CanvasSelection {
	selectedNodeIds: string[];
	selectedEdgeId: string | null;
	setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
	setSelectedEdgeId: Dispatch<SetStateAction<string | null>>;
	/** Select one node, or toggle it in the selection when `extend` (Shift). */
	selectNode: (nodeId: string, extend: boolean) => void;
	selectEdge: (edgeId: string) => void;
	clearSelection: () => void;
}

/**
 * Which cards, or which single edge, the board has selected. Node selection and
 * edge selection are exclusive: picking one clears the other. The callbacks keep
 * one identity for the component's lifetime, so memoised cards and edges hold.
 */
export function useCanvasSelection(): CanvasSelection {
	const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	const selectNode = useCallback((nodeId: string, extend: boolean) => {
		setSelectedEdgeId(null);
		setSelectedNodeIds((current) => {
			if (extend)
				return current.includes(nodeId)
					? current.filter((id) => id !== nodeId)
					: [...current, nodeId];
			return current.length === 1 && current[0] === nodeId ? current : [nodeId];
		});
	}, []);

	const selectEdge = useCallback((edgeId: string) => {
		setSelectedNodeIds([]);
		setSelectedEdgeId(edgeId);
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedNodeIds([]);
		setSelectedEdgeId(null);
	}, []);

	return {
		selectedNodeIds,
		selectedEdgeId,
		setSelectedNodeIds,
		setSelectedEdgeId,
		selectNode,
		selectEdge,
		clearSelection,
	};
}
