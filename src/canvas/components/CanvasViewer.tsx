import { CanvasRenderer } from "./CanvasRenderer.js";
import { useCanvasBoard } from "./useCanvasBoard.js";

export interface CanvasViewerProps {
	/** Vault path of the published board; the page the plugin generates sets it. */
	src: string;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	editable?: boolean;
	editorTitle?: string;
	iframeSandbox?: string;
}

/**
 * The full-page board a canvas route renders. It fetches the published JSON
 * instead of receiving it as a prop, so the board is stored once (in
 * `__canvases__/`) rather than also inlined into the route's JavaScript.
 */
export default function CanvasViewer({
	src,
	fileRoutePrefix,
	linkPreview,
	editable,
	editorTitle,
	iframeSandbox,
}: CanvasViewerProps) {
	const board = useCanvasBoard(src);

	if (board.status === "loading") {
		return (
			<div className="canvas-container canvas-loading" role="status">
				<div className="canvas-embed-spinner" />
				<span>Loading canvas…</span>
			</div>
		);
	}
	if (board.status === "error") {
		return (
			<div className="canvas-error" role="alert">
				Failed to load canvas <code>{src}</code>. Check the console for details.
			</div>
		);
	}

	return (
		<CanvasRenderer
			key={board.url}
			data={board.data}
			boardId={src}
			fileRoutePrefix={fileRoutePrefix}
			linkPreview={linkPreview}
			editable={editable}
			editorTitle={editorTitle}
			iframeSandbox={iframeSandbox}
		/>
	);
}
