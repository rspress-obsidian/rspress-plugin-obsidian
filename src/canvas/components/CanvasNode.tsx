import { memo, useMemo } from 'react';
import type { CanvasNode } from '../types';
import { resolveBgColor, resolveColor } from '../utils/color';
import { renderMarkdown, sanitizeUrl } from '../utils/markdown';
import { isMarkdownFile, resolveFileRoute } from '../utils/resolver';

interface CanvasNodeProps {
  node: CanvasNode;
  assets?: Record<string, string>;
  notes?: Record<string, string>;
  zIndex?: number;
  isHovered?: boolean;
  isSelected?: boolean;
  fileRoutePrefix?: string;
  linkPreview?: boolean;
  iframeSandbox?: string;
  onHover?: (nodeId: string | null) => void;
  onClick?: (nodeId: string) => void;
}

function nodeBorderColor(color: string | undefined): string {
  return resolveColor(color, 'var(--canvas-node-border)');
}

function mediaKind(
  mediaType: string | undefined,
  file: string,
  flags: {
    isImage?: boolean;
    isVideo?: boolean;
    isAudio?: boolean;
    isPdf?: boolean;
  } = {},
): 'image' | 'audio' | 'video' | 'pdf' | 'file' {
  if (flags.isImage) return 'image';
  if (flags.isAudio) return 'audio';
  if (flags.isVideo) return 'video';
  if (flags.isPdf) return 'pdf';
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType?.startsWith('audio/')) return 'audio';
  if (mediaType?.startsWith('video/')) return 'video';
  if (mediaType === 'application/pdf') return 'pdf';
  const extension = file.toLowerCase().split('.').pop();
  if (['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension || ''))
    return 'image';
  if (['flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(extension || '')) return 'audio';
  if (['mov', 'mp4', 'ogv', 'webm'].includes(extension || '')) return 'video';
  if (extension === 'pdf') return 'pdf';
  return 'file';
}

export const CanvasNodeComponent = memo(function CanvasNodeComponent({
  node,
  assets,
  notes,
  zIndex = 0,
  isHovered,
  isSelected,
  fileRoutePrefix,
  linkPreview,
  iframeSandbox = 'allow-scripts allow-same-origin allow-popups',
  onHover,
  onClick,
}: CanvasNodeProps) {
  const borderColor = nodeBorderColor(node.color);
  return (
    <div
      style={{
        position: 'absolute',
        zIndex: zIndex + (isHovered ? 100 : 0) + (isSelected ? 120 : 0),
        borderLeftColor: node.type === 'group' ? undefined : borderColor,
        borderColor: node.color && node.type !== 'group' ? borderColor : undefined,
        backgroundColor: resolveBgColor(node.color, node.type === 'group' ? 'group' : 'other'),
        overflow: node.type === 'group' ? 'visible' : 'hidden',
      }}
      className={`canvas-node canvas-node-${node.type} ${isHovered ? 'canvas-node-hovered' : ''} ${
        isSelected ? 'canvas-node-selected' : ''
      }`}
      role="button"
      tabIndex={0}
      aria-label={
        node.type === 'text'
          ? 'Text node'
          : node.type === 'file'
            ? `File: ${node.file}`
            : node.type === 'link'
              ? `Link: ${node.url}`
              : node.label || 'Group'
      }
      onMouseEnter={() => onHover?.(node.id)}
      onMouseLeave={() => onHover?.(null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.(node.id);
        }
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(node.id);
      }}>
      <NodeContent
        node={node}
        assets={assets}
        notes={notes}
        fileRoutePrefix={fileRoutePrefix}
        linkPreview={linkPreview}
        iframeSandbox={iframeSandbox}
      />
    </div>
  );
});

function NodeContent({
  node,
  assets,
  notes,
  fileRoutePrefix,
  linkPreview,
  iframeSandbox,
}: {
  node: CanvasNode;
  assets?: Record<string, string>;
  notes?: Record<string, string>;
  fileRoutePrefix?: string;
  linkPreview?: boolean;
  iframeSandbox: string;
}) {
  const borderColor = nodeBorderColor(node.color);
  const text = node.type === 'text' ? node.text : '';
  const renderedMarkdown = useMemo(
    () => (text ? renderMarkdown(text, { assets, notes, fileRoutePrefix }) : ''),
    [text, assets, notes, fileRoutePrefix],
  );

  switch (node.type) {
    case 'text':
      return (
        <div className="canvas-node-content canvas-text">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes HTML and URLs before insertion */}
          <div className="canvas-markdown" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
        </div>
      );
    case 'file': {
      const route = resolveFileRoute(node.file, fileRoutePrefix);
      const fileName = node.file.replace(/\.\w+$/, '');
      const titleText = node.subpath ? `${fileName} > ${node.subpath.substring(1)}` : fileName;
      const assetUrl = node.assetUrl || node.imageUrl;
      const safeAssetUrl = assetUrl ? sanitizeUrl(assetUrl) : null;
      const kind = mediaKind(node.mediaType, node.file, node);

      if (safeAssetUrl && kind !== 'file') {
        return (
          <div className="canvas-node-content">
            <div
              className="canvas-node-file-header"
              style={{
                backgroundColor: node.color ? borderColor : undefined,
                color: node.color ? '#ffffff' : undefined,
              }}>
              <span className="canvas-node-file-header-title">{node.file}</span>
            </div>
            <div className="canvas-node-file-body">
              {kind === 'image' && (
                <img className="canvas-file-image" src={safeAssetUrl} alt={node.file} />
              )}
              {kind === 'audio' && (
                <audio className="canvas-file-media" controls src={safeAssetUrl} />
              )}
              {kind === 'video' && (
                <video className="canvas-file-media" controls src={safeAssetUrl} />
              )}
              {kind === 'pdf' && (
                <iframe
                  className="canvas-file-pdf"
                  src={safeAssetUrl}
                  title={node.file}
                  sandbox={iframeSandbox}
                />
              )}
            </div>
          </div>
        );
      }

      if (node.isError) {
        return (
          <div className="canvas-node-content">
            <div className="canvas-node-file-header">
              <span className="canvas-node-file-header-title">{titleText}</span>
            </div>
            <div className="canvas-node-file-body canvas-file-error-body">
              <div className="canvas-file-error-text">{node.fileContent}</div>
            </div>
          </div>
        );
      }

      if (node.fileContent !== undefined) {
        const fileMarkdown = renderMarkdown(node.fileContent, { assets, notes, fileRoutePrefix });
        return (
          <div className="canvas-node-content">
            <div
              className="canvas-node-file-header"
              style={{
                backgroundColor: node.color ? borderColor : undefined,
                color: node.color ? '#ffffff' : undefined,
              }}>
              <span className="canvas-node-file-header-title">{titleText}</span>
              <a
                href={route + (node.subpath || '')}
                className="canvas-node-file-header-link"
                title="Open note page"
                aria-label="Open note page"
                onClick={(event) => event.stopPropagation()}>
                <span>↗</span>
              </a>
            </div>
            <div className="canvas-node-file-body">
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes HTML and URLs before insertion */}
              <div className="canvas-markdown" dangerouslySetInnerHTML={{ __html: fileMarkdown }} />
            </div>
          </div>
        );
      }

      if (!isMarkdownFile(node.file)) {
        return (
          <div className="canvas-node-content canvas-file-fallback">
            <div className="canvas-file-name">{fileName}</div>
            {node.subpath && <div className="canvas-file-subpath">{node.subpath}</div>}
          </div>
        );
      }

      return (
        <a
          href={route + (node.subpath || '')}
          className="canvas-node-content canvas-file-fallback"
          onClick={(event) => event.stopPropagation()}>
          <div className="canvas-file-name">{fileName}</div>
          {node.subpath && <div className="canvas-file-subpath">{node.subpath}</div>}
        </a>
      );
    }
    case 'link': {
      const safeUrl = sanitizeUrl(node.url);
      if (linkPreview && safeUrl?.startsWith('http')) {
        const titleText = node.url.replace(/^https?:\/\//, '');
        return (
          <div className="canvas-node-content">
            <div className="canvas-node-file-header">
              <span className="canvas-node-file-header-title">{titleText}</span>
            </div>
            <div className="canvas-node-file-body">
              <iframe
                src={safeUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title={node.url}
                sandbox={iframeSandbox}
              />
            </div>
          </div>
        );
      }
      return (
        <div className="canvas-node-content canvas-link">
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}>
              {node.url}
            </a>
          ) : (
            <span>{node.url}</span>
          )}
        </div>
      );
    }
    case 'group': {
      const safeBackgroundUrl = node.backgroundUrl ? sanitizeUrl(node.backgroundUrl) : null;
      return (
        <div
          className="canvas-node-content canvas-group"
          style={{
            backgroundImage: safeBackgroundUrl ? `url("${safeBackgroundUrl}")` : undefined,
            backgroundSize:
              node.backgroundStyle === 'cover'
                ? 'cover'
                : node.backgroundStyle === 'ratio'
                  ? 'contain'
                  : node.backgroundStyle === 'repeat'
                    ? 'auto'
                    : 'cover',
            backgroundRepeat: node.backgroundStyle === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
          }}>
          {node.label && <div className="canvas-group-label">{node.label}</div>}
        </div>
      );
    }
    default:
      return null;
  }
}
