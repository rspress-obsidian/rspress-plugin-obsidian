import { afterEach, beforeEach, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import CanvasEmbed, { resolveCanvasJsonUrl } from './CanvasEmbed';

const mockCanvasJson = JSON.stringify({
  nodes: [{ id: 'n1', type: 'text', text: 'Hello', x: 0, y: 0, width: 200, height: 100 }],
  edges: [],
});

const origFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('nonexistent')) {
      return Promise.reject(new Error('Not found'));
    }
    return Promise.resolve(
      new Response(mockCanvasJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

test('shows loading state on mount', () => {
  const { container } = render(<CanvasEmbed src="Demo.canvas" />);
  const loadingEl = container.querySelector('.canvas-embed-loading');
  expect(loadingEl).toBeTruthy();
  expect(loadingEl?.textContent).toContain('Loading canvas');
});

test('shows error state for missing canvas', async () => {
  const origErr = console.error;
  console.error = () => {};
  const { container } = render(<CanvasEmbed src="nonexistent.canvas" />);
  // Wait for the fetch to fail and error state to render
  await new Promise((r) => setTimeout(r, 50));
  console.error = origErr;
  const errorEl = container.querySelector('.canvas-embed-error');
  expect(errorEl).toBeTruthy();
  expect(errorEl?.textContent).toContain('nonexistent.canvas');
});

test('renders canvas on successful load', async () => {
  const { container } = render(<CanvasEmbed src="Demo.canvas" />);
  await new Promise((r) => setTimeout(r, 50));
  const viewport = container.querySelector('.canvas-viewport');
  expect(viewport).toBeTruthy();
});

test('accepts fileRoutePrefix and linkPreview props', () => {
  const { container } = render(
    <CanvasEmbed src="Demo.canvas" fileRoutePrefix="/docs" linkPreview />,
  );
  expect(container.querySelector('.canvas-embed-loading')).toBeTruthy();
});

test('renders with .json extension', () => {
  const { container } = render(<CanvasEmbed src="subfolder/map.json" />);
  expect(container.querySelector('.canvas-embed-loading')).toBeTruthy();
});

test('renders without canvas extension', () => {
  const { container } = render(<CanvasEmbed src="Demo" />);
  expect(container.querySelector('.canvas-embed-loading')).toBeTruthy();
});
test('resolves embed JSON under an Rspress base path', () => {
  expect(resolveCanvasJsonUrl('maps/Demo.canvas', '/docs/')).toBe(
    '/docs/__canvases__/maps/Demo.json',
  );
});
