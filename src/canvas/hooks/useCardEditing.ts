import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { CanvasData, CanvasNode } from "../types.js";
import type { CanvasEditor } from "./useCanvasEditor.js";

export interface CardEditingOptions extends Pick<CanvasEditor, "commit"> {
	editable: boolean;
	/** The latest board: the card to edit is looked up, and committed, against it. */
	canvasRef: RefObject<CanvasData>;
}

export interface CardEditing {
	/** The text card open in the inline editor, if any. */
	editingNodeId: string | null;
	draftText: string;
	setDraftText: (text: string) => void;
	/** The card being edited and its draft, current even between renders. */
	editingRef: RefObject<{ id: string; draft: string } | null>;
	/** Open the editor on the text card `nodeId`; ignored when read-only or not text. */
	startEditing: (nodeId: string) => void;
	/** Open the editor on `node` itself, which may not be on the board yet. */
	editNode: (node: CanvasNode) => void;
	/** Close the editor, committing the draft if it changed the card's text. */
	commitEdit: () => void;
}

/** Inline editing of text cards: one card at a time, committed as one `update`. */
export function useCardEditing({ editable, canvasRef, commit }: CardEditingOptions): CardEditing {
	const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
	const [draftText, setDraftText] = useState("");
	const editingRef = useRef<{ id: string; draft: string } | null>(null);
	editingRef.current = editingNodeId ? { id: editingNodeId, draft: draftText } : null;

	const editNode = useCallback((node: CanvasNode) => {
		if (node.type !== "text") return;
		setEditingNodeId(node.id);
		setDraftText(node.text);
	}, []);

	const startEditing = useCallback(
		(nodeId: string) => {
			if (!editable) return;
			const node = canvasRef.current.nodes.find((item) => item.id === nodeId);
			if (node) editNode(node);
		},
		[canvasRef, editNode, editable],
	);

	const commitEdit = useCallback(() => {
		const editing = editingRef.current;
		if (!editing) return;
		editingRef.current = null;
		setEditingNodeId(null);
		const current = canvasRef.current;
		const node = current.nodes.find((item) => item.id === editing.id);
		// Opening the editor and leaving without a change is not an edit: it
		// must not clear the redo stack or mark the board unsaved.
		if (node?.type !== "text" || node.text === editing.draft) return;
		const updated: CanvasNode = { ...node, text: editing.draft };
		commit(
			{ type: "update", id: node.id, from: node, to: updated },
			{ ...current, nodes: current.nodes.map((item) => (item.id === node.id ? updated : item)) },
		);
	}, [canvasRef, commit]);

	return {
		editingNodeId,
		draftText,
		setDraftText,
		editingRef,
		startEditing,
		editNode,
		commitEdit,
	};
}
