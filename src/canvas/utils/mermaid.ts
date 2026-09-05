/**
 * Client-side Mermaid rendering.
 *
 * `renderMarkdown` emits `<pre class="canvas-mermaid-block" data-code="...">`
 * placeholders for ```mermaid fences. Because Mermaid needs the DOM and
 * browser-only APIs, the diagram is rendered here (in an effect), not at
 * markdown-parse time. This mirrors the official `rspress-plugin-mermaid`
 * approach: a static import (so the bundler resolves it) driven from an effect.
 *
 * React re-applies `dangerouslySetInnerHTML` on re-render, which wipes any SVG
 * injected into the placeholder. `renderMermaidBlocks` is therefore idempotent:
 * it only re-renders blocks that currently lack their diagram, and callers
 * invoke it after every commit so wipes self-heal.
 */

import mermaid from 'mermaid';

let renderId = 0;
let observer: MutationObserver | null = null;
const trackedBlocks = new Set<HTMLElement>();

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

async function renderBlock(block: HTMLElement): Promise<void> {
  const code = block.getAttribute('data-code') ?? '';
  if (!code) return;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: isDark() ? 'dark' : 'default',
    });
    renderId += 1;
    const { svg } = await Promise.race([
      mermaid.render(`canvas-mermaid-${renderId}`, code),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Mermaid render timed out after 10s')), 10000),
      ),
    ]);
    block.innerHTML = svg;
    block.classList.add('canvas-mermaid-rendered');
    block.classList.remove('canvas-mermaid-error');
  } catch (error) {
    console.warn('[rspress-plugin-obsidian-canvas] Mermaid diagram failed to render', error);
    block.classList.add('canvas-mermaid-error');
  }
}

function ensureObserver(): void {
  if (observer || typeof document === 'undefined') return;
  observer = new MutationObserver(() => {
    for (const block of trackedBlocks) {
      // Reset to raw source so the diagram re-renders with the new theme.
      block.textContent = block.getAttribute('data-code') ?? '';
      block.classList.remove('canvas-mermaid-rendered', 'canvas-mermaid-error');
      void renderBlock(block);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Render any `.canvas-mermaid-block` placeholders inside `root` that are
 * missing their diagram. Idempotent — safe to call after every React commit.
 */
export function renderMermaidBlocks(root: HTMLElement): void {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.canvas-mermaid-block'));
  for (const block of blocks) {
    trackedBlocks.add(block);
    if (block.querySelector('svg')) continue;
    if (block.classList.contains('canvas-mermaid-error')) continue;
    void renderBlock(block);
  }
  ensureObserver();
}

/** Disconnect the theme observer and forget tracked blocks (call on unmount). */
export function disposeMermaid(): void {
  observer?.disconnect();
  observer = null;
  trackedBlocks.clear();
}
