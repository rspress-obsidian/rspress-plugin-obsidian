import { useMemo } from 'react';
import { parseCanvas } from '../parser';
import { CanvasRenderer } from './CanvasRenderer';

interface CanvasViewerProps {
  canvasJson: string;
  fileRoutePrefix?: string;
  linkPreview?: boolean;
  editable?: boolean;
  editorTitle?: string;
  iframeSandbox?: string;
}

export default function CanvasViewer({
  canvasJson,
  fileRoutePrefix,
  linkPreview,
  editable,
  editorTitle,
  iframeSandbox,
}: CanvasViewerProps) {
  const data = useMemo(() => {
    try {
      return parseCanvas(canvasJson);
    } catch (error) {
      console.error('Failed to parse canvas:', error);
      return null;
    }
  }, [canvasJson]);

  if (!data) {
    return <div className="canvas-error">Failed to load canvas. Check console for details.</div>;
  }

  return (
    <CanvasRenderer
      data={data}
      fileRoutePrefix={fileRoutePrefix}
      linkPreview={linkPreview}
      editable={editable}
      editorTitle={editorTitle}
      iframeSandbox={iframeSandbox}
    />
  );
}
