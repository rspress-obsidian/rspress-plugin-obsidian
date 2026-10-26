import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasEdgeData, CanvasNode } from "../types.js";
import { membersByGroup } from "../utils/group.js";

export interface CanvasGroupsOptions {
	nodes: CanvasNode[];
	edges: CanvasEdgeData[];
	/** While true, membership stays as it was when the drag began. */
	isDragging: boolean;
	/** Called with the members a collapse hides, which must leave the selection. */
	onHide: (hidden: ReadonlySet<string>) => void;
}

export interface CanvasGroups {
	/** The nodes each group holds, by containment. */
	groupMembers: Map<string, string[]>;
	/** The latest members of `groupId`; one identity for the component's lifetime. */
	membersOf: (groupId: string) => readonly string[];
	collapsedGroupIds: string[];
	toggleGroupCollapse: (groupId: string) => void;
	/** The nodes left showing once collapsed groups hide their members. */
	visibleNodes: CanvasNode[];
	/** The edges left showing: every edge but those wholly inside a collapsed group. */
	visibleEdges: CanvasEdgeData[];
}

/**
 * Group membership and collapsing. Collapsed groups are view state, never
 * canvas data: the `.canvas` format has nowhere to record them and export must
 * stay faithful to the source.
 */
export function useCanvasGroups({
	nodes,
	edges,
	isDragging,
	onHide,
}: CanvasGroupsOptions): CanvasGroups {
	const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
	const onHideRef = useRef(onHide);
	onHideRef.current = onHide;

	// Which nodes each group holds, by containment. Frozen while a drag runs,
	// recomputed when it ends so membership follows a card dragged out of (or
	// into) a group.
	const membershipNodesRef = useRef(nodes);
	if (!isDragging) membershipNodesRef.current = nodes;
	const membershipNodes = membershipNodesRef.current;
	const groupMembers = useMemo(() => membersByGroup(membershipNodes), [membershipNodes]);
	const groupMembersRef = useRef(groupMembers);
	groupMembersRef.current = groupMembers;
	const membersOf = useCallback(
		(groupId: string): readonly string[] => groupMembersRef.current.get(groupId) ?? [],
		[],
	);

	// Members of collapsed groups, and the edges wholly inside them. Edges with one
	// visible endpoint stay: the format keeps them, and the line still points at
	// the group's box.
	const hiddenNodeIds = useMemo(() => {
		const hidden = new Set<string>();
		for (const groupId of collapsedGroupIds) {
			for (const memberId of groupMembers.get(groupId) ?? []) hidden.add(memberId);
		}
		return hidden;
	}, [collapsedGroupIds, groupMembers]);
	const visibleNodes = useMemo(
		() => (hiddenNodeIds.size === 0 ? nodes : nodes.filter((node) => !hiddenNodeIds.has(node.id))),
		[nodes, hiddenNodeIds],
	);
	const visibleEdges = useMemo(
		() =>
			hiddenNodeIds.size === 0
				? edges
				: edges.filter(
						(edge) => !(hiddenNodeIds.has(edge.fromNode) && hiddenNodeIds.has(edge.toNode)),
					),
		[edges, hiddenNodeIds],
	);

	// A collapsed id outlives its group only until the next canvas change. Left in
	// place it would still be collapsed by the time the toolbar's next group takes
	// the freed id, and that new group would hide its members on sight.
	useEffect(() => {
		const ids = new Set(nodes.map((node) => node.id));
		setCollapsedGroupIds((current) =>
			current.some((id) => !ids.has(id)) ? current.filter((id) => ids.has(id)) : current,
		);
	}, [nodes]);

	// Collapsing is a view toggle: it never touches the board, so export and the
	// undo history stay exactly as the source had them.
	const toggleGroupCollapse = useCallback((groupId: string) => {
		setCollapsedGroupIds((current) => {
			if (current.includes(groupId)) return current.filter((id) => id !== groupId);
			onHideRef.current(new Set(groupMembersRef.current.get(groupId) ?? []));
			return [...current, groupId];
		});
	}, []);

	return {
		groupMembers,
		membersOf,
		collapsedGroupIds,
		toggleGroupCollapse,
		visibleNodes,
		visibleEdges,
	};
}
