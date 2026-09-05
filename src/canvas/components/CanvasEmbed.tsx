import { useEffect, useState } from 'react';
import type { CanvasData } from '../types';
import { CanvasRenderer } from './CanvasRenderer';

interface CanvasEmbedProps {
  src: string;
  fileRoutePrefix?: string;
  linkPreview?: boolean;
  iframeSandbox?: string;
  basePath?: string;
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/' || value === '.' || value === './') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function detectRuntimeBasePath(): string {

  if (typeof document !== 'undefined') {
    const scripts = Array.from(document.scripts)
      .map((script) => script.src)
      .filter(Boolean);
    for (const scriptUrl of scripts) {
      try {
        const pathname = new URL(scriptUrl, document.baseURI).pathname;
        const marker = pathname.search(/\/(?:static|assets)\//);
        if (marker > 0) return pathname.slice(0, marker);
        if (marker === 0) return '';
      } catch {
        // Ignore malformed script URLs and continue with the other runtime hints.
      }
    }

    const baseHref = document.querySelector('base')?.getAttribute('href');
    if (baseHref) {
      try {
        return normalizeBasePath(new URL(baseHref, document.baseURI).pathname);
      } catch {
        // Fall through to the root path when the document base is malformed.
      }
    }
  }
  return '';
}

function resolveCanvasJsonUrl(src: string, basePath?: string): string {
  const jsonPath = src
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.canvas$/i, '')
    .replace(/\.json$/i, '');
  const base = normalizeBasePath(basePath ?? detectRuntimeBasePath());
  return `${base}/__canvases__/${jsonPath}.json`;
}

export { resolveCanvasJsonUrl };

export default function CanvasEmbed({
  src,
  fileRoutePrefix,
  linkPreview,
  iframeSandbox,
  basePath,
}: CanvasEmbedProps) {
  const [data, setData] = useState<CanvasData | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'loaded'>('loading');

  useEffect(() => {
    let cancelled = false;

    const loadCanvas = async () => {
      setStatus('loading');
      const url = resolveCanvasJsonUrl(src, basePath);

      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Canvas not found: ${src} (${res.status})`);
        }
        const json: CanvasData = await res.json();
        if (!cancelled) {
          setData(json);
          setStatus('loaded');
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          console.error('[CanvasEmbed] Failed to load canvas:', err);
        }
      }
    };

    loadCanvas();

    return () => {
      cancelled = true;
    };
  }, [src, basePath]);

  if (status === 'loading') {
    return (
      <div className="canvas-embed-loading">
        <div className="canvas-embed-spinner" />
        <span>Loading canvas…</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="canvas-embed-error">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label="Error">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          Could not load canvas: <code>{src}</code>
        </span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <CanvasRenderer
      data={data}
      fileRoutePrefix={fileRoutePrefix}
      linkPreview={linkPreview}
      iframeSandbox={iframeSandbox}
    />
  );
}
