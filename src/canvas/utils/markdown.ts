import { slug } from 'github-slugger';
import katex from 'katex';
import { marked } from 'marked';
import { resolveFileRoute } from './resolver';

export interface MarkdownOptions {
  fileRoutePrefix?: string;
  assets?: Record<string, string>;
  notes?: Record<string, string>;
  depth?: number;
}

interface Replacement {
  token: string;
  html: string;
}

interface Footnote {
  id: string;
  content: string;
}

const SAFE_PROTOCOL = /^(?:https?:|mailto:|tel:)/i;
const MARKDOWN_EXTENSIONS: Record<string, true> = {
  '.md': true,
  '.mdx': true,
  '.markdown': true,
};
const MEDIA_DATA_URL =
  /^data:(?:image\/(?:avif|gif|jpe?g|png|svg\+xml|webp)|audio\/[^;,]+|video\/[^;,]+|application\/pdf);base64,/i;

// A fenced code block, with the closing fence matching the opening marker.
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n?[ \t]*\2[ \t]*$/gm;

// Inline math: `$...$` with no adjacent whitespace inside the delimiters.
const INLINE_MATH_RE = /\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
// Display math: `$$...$$`.
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

// Obsidian tags: `#tag` or `#nested/tag`, not preceded by a word char, `[`, or `/`.
const TAG_RE = /(^|[\s([>])(#(?:[A-Za-z0-9_-]+\/?)+)(?![\w/])/g;

// Footnote block definition: `[^id]: content`.
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:[ \t]*([^\n]+)$/gm;
// Footnote inline reference: `[^id]`.
const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeUrl(value: string): string | null {
  const url = value.trim();
  if (
    [...url].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return null;
  }
  if (!url) return null;
  if (
    url.startsWith('#') ||
    (url.startsWith('/') && !url.startsWith('//')) ||
    url.startsWith('./') ||
    url.startsWith('../')
  ) {
    return url;
  }
  if (MEDIA_DATA_URL.test(url) || SAFE_PROTOCOL.test(url)) {
    return url;
  }
  return null;
}

function normalizeAssetKey(value: string): string {
  const [assetPath] = value.split('#');
  return (assetPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function splitTarget(value: string): { file: string; subpath?: string } {
  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) return { file: value.trim() };
  return {
    file: value.slice(0, hashIndex).trim(),
    subpath: value.slice(hashIndex),
  };
}

function resolveWikiLinkTarget(value: string, prefix?: string): string {
  const { file, subpath } = splitTarget(value);
  const filePath = /\.[^/]+$/.test(file) ? file : `${file}.md`;
  const route = resolveFileRoute(filePath, prefix);
  if (!subpath) return route;
  const anchor = subpath.slice(1);
  if (anchor.startsWith('^')) return `${route}#${encodeURIComponent(anchor)}`;
  return `${route}#${slug(anchor)}`;
}

function resolveAssetUrl(target: string, options: MarkdownOptions): string {
  const asset = options.assets?.[normalizeAssetKey(target)];
  return asset || resolveFileRoute(splitTarget(target).file, options.fileRoutePrefix);
}

function createReplacement(replacements: Replacement[], html: string): string {
  const token = `OBS_CANVAS_REPLACEMENT_${replacements.length}`;
  replacements.push({ token, html });
  return token;
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false });
  } catch {
    return `<span class="canvas-math-error">${escapeHtml(tex)}</span>`;
  }
}

/** Split markdown into prose and fenced-code segments; fences stay intact. */
function splitByFences(text: string): Array<{ type: 'prose' | 'code'; text: string }> {
  const segments: Array<{ type: 'prose' | 'code'; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: 'prose', text: text.slice(last, index) });
    segments.push({ type: 'code', text: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'prose', text: text.slice(last) });
  if (segments.length === 0) segments.push({ type: 'prose', text });
  return segments;
}

function collectFootnoteDefinitions(text: string, footnotes: Footnote[]): string {
  const knownIds = new Set(footnotes.map((footnote) => footnote.id));
  return text.replace(FOOTNOTE_DEF_RE, (_match, rawId: string, rawContent: string) => {
    const id = rawId.trim();
    if (!knownIds.has(id)) {
      footnotes.push({ id, content: rawContent.trim() });
      knownIds.add(id);
    }
    return '';
  });
}

function resolveFootnoteReferences(
  text: string,
  replacements: Replacement[],
  footnotes: Footnote[],
): string {
  const knownIds = new Set(footnotes.map((footnote) => footnote.id));
  return text.replace(FOOTNOTE_REF_RE, (_match, rawId: string) => {
    const id = rawId.trim();
    if (!knownIds.has(id)) return _match;
    const index = footnotes.findIndex((footnote) => footnote.id === id) + 1;
    return createReplacement(
      replacements,
      `<sup class="canvas-footnote-ref" id="canvas-fnref-${index}"><a href="#canvas-fn-${index}">${index}</a></sup>`,
    );
  });
}

function processEmbeds(
  text: string,
  replacements: Replacement[],
  options: MarkdownOptions,
): string {
  return text.replace(/!\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const parts = rawTarget.split('|');
    const target = parts[0]?.trim() || '';
    // Obsidian size syntax: `![[image.png|300]]` or `![[image.png|300x200]]`.
    // A trailing pipe value that is a bare dimension is a size, not an alias.
    let altText = target;
    let sizeStyle = '';
    if (parts.length > 1) {
      const rest = parts.slice(1).join('|').trim();
      const sizeMatch = rest.match(/^(\d+)(?:x(\d+))?$/i);
      if (sizeMatch) {
        const width = Number(sizeMatch[1]);
        const height = sizeMatch[2] ? Number(sizeMatch[2]) : undefined;
        sizeStyle = height ? `width:${width}px;height:${height}px;` : `width:${width}px;`;
      } else if (rest) {
        altText = rest;
      }
    }

    const cleanAlt = altText;
    const targetInfo = splitTarget(target);
    const targetExtension = targetInfo.file.toLowerCase().match(/\.[^./]+$/)?.[0] || '';
    const noteFile = targetExtension ? targetInfo.file : `${targetInfo.file}.md`;
    const note = options.notes?.[normalizeAssetKey(noteFile)];

    if (note && (targetExtension === '' || MARKDOWN_EXTENSIONS[targetExtension])) {
      if ((options.depth || 0) >= 2) {
        const href = sanitizeUrl(resolveWikiLinkTarget(target, options.fileRoutePrefix));
        return href
          ? createReplacement(
              replacements,
              `<a href="${escapeHtml(href)}" class="obsidian-embed-note">${escapeHtml(cleanAlt)}</a>`,
            )
          : escapeHtml(cleanAlt);
      }
      const embeddedNote = renderMarkdown(note, {
        ...options,
        depth: (options.depth || 0) + 1,
      });
      return createReplacement(
        replacements,
        `<div class="obsidian-embed-note">${embeddedNote}</div>`,
      );
    }

    const extension = targetInfo.file.toLowerCase().split('.').pop() || '';
    const url = sanitizeUrl(resolveAssetUrl(target, options));
    if (!url) return escapeHtml(cleanAlt);
    const safeTarget = escapeHtml(target);
    const safeUrl = escapeHtml(url);
    const sizeAttr = sizeStyle ? ` style="${sizeStyle}"` : '';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'].includes(extension)) {
      return createReplacement(
        replacements,
        `<img src="${safeUrl}" alt="${escapeHtml(cleanAlt)}"${sizeAttr} class="obsidian-embed-image">`,
      );
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(extension)) {
      return createReplacement(
        replacements,
        `<audio controls src="${safeUrl}" title="${safeTarget}"${sizeAttr}></audio>`,
      );
    }
    if (['mp4', 'webm', 'ogv', 'mov'].includes(extension)) {
      return createReplacement(
        replacements,
        `<video controls src="${safeUrl}" title="${safeTarget}"${sizeAttr}></video>`,
      );
    }
    if (extension === 'pdf') {
      return createReplacement(
        replacements,
        `<iframe src="${safeUrl}" title="${safeTarget}"${sizeAttr} class="obsidian-embed-pdf"></iframe>`,
      );
    }
    return createReplacement(
      replacements,
      `<a href="${safeUrl}" class="obsidian-embed-link">${escapeHtml(cleanAlt)}</a>`,
    );
  });
}

function processWikiLinks(
  text: string,
  replacements: Replacement[],
  options: MarkdownOptions,
): string {
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, rawTarget: string, rawLabel?: string) => {
      const target = rawTarget.trim();
      const label = rawLabel?.trim() || splitTarget(target).file.split('/').pop() || target;
      const href = sanitizeUrl(resolveWikiLinkTarget(target, options.fileRoutePrefix));
      if (!href) return escapeHtml(label);
      return createReplacement(
        replacements,
        `<a href="${escapeHtml(href)}" class="wiki-link">${escapeHtml(label)}</a>`,
      );
    },
  );
}

function preprocessObsidianSyntax(
  text: string,
  options: MarkdownOptions,
): {
  text: string;
  replacements: Replacement[];
  footnotes: Footnote[];
} {
  const replacements: Replacement[] = [];
  const footnotes: Footnote[] = [];

  const segments = splitByFences(text);

  // First pass: collect every footnote definition so references that appear
  // before their definition (or after a code fence) still resolve.
  for (const segment of segments) {
    if (segment.type !== 'prose') continue;
    segment.text = collectFootnoteDefinitions(segment.text, footnotes);
  }

  let result = '';
  for (const segment of segments) {
    if (segment.type === 'code') {
      result += segment.text;
      continue;
    }

    let prose = segment.text;

    // Protect inline code spans before any other inline processing.
    prose = prose.replace(/`([^`\n]+)`/g, (_match, code: string) =>
      createReplacement(replacements, `<code>${escapeHtml(code)}</code>`),
    );

    // Display math before inline math so `$$` is not split.
    prose = prose.replace(DISPLAY_MATH_RE, (_match, tex: string) =>
      createReplacement(
        replacements,
        `<div class="canvas-math-display">${renderMath(tex, true)}</div>`,
      ),
    );
    prose = prose.replace(INLINE_MATH_RE, (_match, tex: string) =>
      createReplacement(replacements, `<span class="canvas-math">${renderMath(tex, false)}</span>`),
    );

    prose = resolveFootnoteReferences(prose, replacements, footnotes);
    prose = processEmbeds(prose, replacements, options);
    prose = processWikiLinks(prose, replacements, options);

    result += prose;
  }

  return { text: result, replacements, footnotes };
}

function createRenderer(options: MarkdownOptions) {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function ({ href, title, tokens }) {
    const safeHref = sanitizeUrl(href);
    const linkText = this.parser.parseInline(tokens);
    if (!safeHref) return linkText;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}>${linkText}</a>`;
  };
  renderer.image = function ({ href, title, text, tokens }) {
    const assetUrl = options.assets?.[normalizeAssetKey(href)] || href;
    const safeHref = sanitizeUrl(assetUrl);
    const altText = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
    if (!safeHref) return escapeHtml(altText);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(altText)}"${titleAttribute}>`;
  };
  renderer.code = ({ text: code, lang }) => {
    if (lang?.toLowerCase() === 'mermaid') {
      const placeholder = escapeHtml(code);
      return `<pre class="canvas-mermaid-block" data-code="${placeholder}">${placeholder}</pre>\n`;
    }
    const clean = code.replace(/\n$/, '');
    const className = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre><code${className}>${escapeHtml(clean)}\n</code></pre>\n`;
  };
  renderer.blockquote = function (token) {
    const headerMatch = token.text.match(/^\[!([A-Za-z]+)\][^\n]*(?:\n|$)/);
    if (!headerMatch) {
      return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
    }
    const type = (headerMatch[1] ?? 'note').toLowerCase();
    const title =
      headerMatch[0]
        .replace(/^\[![A-Za-z]+\]\s*/, '')
        .replace(/\n$/, '')
        .trim() || type;
    const body = token.text.slice(headerMatch[0].length);
    const bodyHtml = body ? renderMarkdown(body, options) : '';
    return `<div class="canvas-callout canvas-callout-${type}"><div class="canvas-callout-title">${escapeHtml(title)}</div><div class="canvas-callout-body">${bodyHtml}</div></div>\n`;
  };
  renderer.text = function (token) {
    // Paragraph-level text carries nested inline tokens (strong/em/code);
    // delegate so they render through the same renderer. Leaf text is
    // escaped and tag-ified directly.
    if ('tokens' in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return escapeHtml(token.text).replace(
      TAG_RE,
      (_match, prefix: string, tag: string) =>
        `${prefix}<span class="canvas-tag">${escapeHtml(tag)}</span>`,
    );
  };
  return renderer;
}

function renderFootnoteContent(content: string, options: MarkdownOptions): string {
  const preprocessed = preprocessObsidianSyntax(content, options);
  let html = marked.parseInline(preprocessed.text, {
    gfm: true,
    breaks: true,
    renderer: createRenderer(options),
    async: false,
  }) as string;
  for (const replacement of preprocessed.replacements) {
    html = html.replaceAll(replacement.token, replacement.html);
  }
  return html;
}

function renderFootnotes(footnotes: Footnote[], options: MarkdownOptions): string {
  if (footnotes.length === 0) return '';
  const items = footnotes
    .map(
      (footnote, index) =>
        `<li id="canvas-fn-${index + 1}"><p>${renderFootnoteContent(footnote.content, options)} <a href="#canvas-fnref-${index + 1}" class="canvas-footnote-backref" aria-label="Back to content">↩</a></p></li>`,
    )
    .join('\n');
  return `<section class="canvas-footnotes" role="doc-endnotes"><ol>${items}</ol></section>`;
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  if (!text) return '';
  const preprocessed = preprocessObsidianSyntax(text, options);
  const renderer = createRenderer(options);
  let html = marked.parse(preprocessed.text, {
    gfm: true,
    breaks: true,
    renderer,
    async: false,
  }) as string;
  for (const replacement of preprocessed.replacements) {
    html = html.replaceAll(replacement.token, replacement.html);
  }
  html += renderFootnotes(preprocessed.footnotes, options);
  return html;
}
