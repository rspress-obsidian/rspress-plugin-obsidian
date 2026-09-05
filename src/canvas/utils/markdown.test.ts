import { expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';

test('renders plain text as paragraph', () => {
  const html = renderMarkdown('Hello world');
  expect(html).toContain('<p>Hello world</p>');
});

test('renders empty string', () => {
  expect(renderMarkdown('')).toBe('');
});

test('renders headings h1-h6', () => {
  for (let i = 1; i <= 6; i++) {
    const hashes = '#'.repeat(i);
    const html = renderMarkdown(`${hashes} Heading ${i}`);
    expect(html).toContain(`<h${i}>Heading ${i}</h${i}>`);
  }
});

test('renders bold text', () => {
  const html = renderMarkdown('**bold text**');
  expect(html).toContain('<strong>bold text</strong>');
});

test('renders italic text', () => {
  const html = renderMarkdown('*italic text*');
  expect(html).toContain('<em>italic text</em>');
});

test('renders bold+italic text', () => {
  const html = renderMarkdown('***bold italic***');
  expect(html).toMatch(/<(strong|em)><(strong|em)>bold italic<\/\2><\/\1>/);
});

test('renders inline code', () => {
  const html = renderMarkdown('Use `const x = 1`');
  expect(html).toContain('<code>const x = 1</code>');
});

test('renders code blocks with language', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  expect(html).toContain('<pre><code class="language-js">const x = 1;\n</code></pre>');
});

test('renders code blocks without language', () => {
  const html = renderMarkdown('```\nsome code\n```');
  expect(html).toContain('<pre><code>some code\n</code></pre>');
});

test('renders standard links', () => {
  const html = renderMarkdown('[Rspress](https://rspress.dev)');
  expect(html).toContain('<a href="https://rspress.dev">Rspress</a>');
});

test('renders auto-links', () => {
  const html = renderMarkdown('<https://example.com>');
  expect(html).toContain('<a href="https://example.com">https://example.com</a>');
});

test('renders images', () => {
  const html = renderMarkdown('![alt text](https://example.com/img.png)');
  expect(html).toContain('<img src="https://example.com/img.png" alt="alt text"');
});

test('renders wiki-links without display text', () => {
  const html = renderMarkdown('[[My Note]]');
  expect(html).toContain('<a href="/my-note" class="wiki-link">My Note</a>');
});

test('renders wiki-links with display text', () => {
  const html = renderMarkdown('[[My Note|Click Here]]');
  expect(html).toContain('<a href="/my-note" class="wiki-link">Click Here</a>');
});

test('renders horizontal rules', () => {
  expect(renderMarkdown('---')).toMatch(/<hr\s*\/?>/);
  expect(renderMarkdown('***')).toMatch(/<hr\s*\/?>/);
  expect(renderMarkdown('___')).toMatch(/<hr\s*\/?>/);
});

test('renders blockquotes', () => {
  const html = renderMarkdown('> This is a quote');
  expect(html).toContain('<blockquote>\n<p>This is a quote</p>\n</blockquote>');
});

test('renders unordered lists as single ul', () => {
  const html = renderMarkdown('- item one\n- item two\n- item three');
  expect(html).toContain('<li>item one</li>');
  expect(html).toContain('<li>item two</li>');
  expect(html).toContain('<li>item three</li>');
});

test('renders unordered lists with asterisk', () => {
  const html = renderMarkdown('* item one\n* item two');
  expect(html).toContain('<li>item one</li>');
  expect(html).toContain('<li>item two</li>');
});

test('renders ordered lists as single ol', () => {
  const html = renderMarkdown('1. first\n2. second\n3. third');
  expect(html).toContain('<li>first</li>');
  expect(html).toContain('<li>second</li>');
  expect(html).toContain('<li>third</li>');
});

test('consecutive list items merge into one list', () => {
  const html = renderMarkdown('- a\n- b\n- c');
  const ulCount = (html.match(/<ul>/g) || []).length;
  expect(ulCount).toBe(1);
});

test('escapes HTML in text', () => {
  const html = renderMarkdown("<script>alert('xss')</script>");
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

test('renders multi-paragraph text', () => {
  const html = renderMarkdown('First paragraph\n\nSecond paragraph');
  expect(html).toContain('<p>First paragraph</p>');
  expect(html).toContain('<p>Second paragraph</p>');
});

test('renders mixed content in order', () => {
  const html = renderMarkdown('# Title\n\nSome text\n\n- item\n\n> quote');
  const h1Idx = html.indexOf('<h1>Title</h1>');
  const pIdx = html.indexOf('<p>Some text</p>');
  const ulIdx = html.indexOf('<ul>');
  const bqIdx = html.indexOf('<blockquote>');
  expect(h1Idx).toBeLessThan(pIdx);
  expect(pIdx).toBeLessThan(ulIdx);
  expect(ulIdx).toBeLessThan(bqIdx);
});

test('renders inline formatting inside headings', () => {
  const html = renderMarkdown('## **Bold** heading');
  expect(html).toContain('<h2><strong>Bold</strong> heading</h2>');
});

test('renders inline formatting inside list items', () => {
  const html = renderMarkdown('- **bold** and *italic*');
  expect(html).toContain('<li><strong>bold</strong> and <em>italic</em></li>');
});

test('renders complex canvas text node content', () => {
  const text =
    '# Welcome to Obsidian Canvas\n\nThis text node supports **bold**, *italic*, and `code`.\n\n- List item one\n- List item two\n\n> A blockquote for emphasis';
  const html = renderMarkdown(text);
  expect(html).toContain('<h1>Welcome to Obsidian Canvas</h1>');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<em>italic</em>');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<li>List item one</li>');
  expect(html).toContain('<li>List item two</li>');
  expect(html).toContain('<blockquote>');
  expect(html).toContain('A blockquote for emphasis');
});

test('renders nested lists', () => {
  const html = renderMarkdown('- item one\n  - nested a\n  - nested b\n- item two');
  expect(html).toContain('<ul>');
  expect(html).toContain('item one');
  expect(html).toContain('nested a');
  expect(html).toContain('nested b');
  expect(html).toContain('item two');
});

test('renders task lists', () => {
  const html = renderMarkdown('- [ ] todo\n- [x] done');
  expect(html).toContain('<li');
  expect(html).toContain('todo');
  expect(html).toContain('done');
});

test('renders tables', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  expect(html).toContain('<table>');
  expect(html).toContain('<th>A</th>');
  expect(html).toContain('<td>1</td>');
});
test('resolves wiki-link aliases, headings, and prefixes', () => {
  const html = renderMarkdown('[[Notes/Plan#Next Steps|Read plan]]', {
    fileRoutePrefix: '/docs',
  });
  expect(html).toContain('<a href="/docs/notes/plan#next-steps" class="wiki-link">Read plan</a>');
});

test('renders Obsidian media embeds from the asset map', () => {
  const html = renderMarkdown('![[Assets/clip.png]]', {
    assets: { 'assets/clip.png': 'data:image/png;base64,AAAA' },
  });
  expect(html).toContain(
    '<img src="data:image/png;base64,AAAA" alt="Assets/clip.png" class="obsidian-embed-image">',
  );
});

test('renders embed size syntax', () => {
  const html = renderMarkdown('![[Assets/clip.png|300]]', {
    assets: { 'assets/clip.png': 'data:image/png;base64,AAAA' },
  });
  expect(html).toContain('style="width:300px;"');
  expect(html).toContain('class="obsidian-embed-image"');

  const sized = renderMarkdown('![[Assets/clip.png|300x200]]', {
    assets: { 'assets/clip.png': 'data:image/png;base64,AAAA' },
  });
  expect(sized).toContain('style="width:300px;height:200px;"');
});

test('preserves alias text on embeds', () => {
  const html = renderMarkdown('![[Assets/clip.png|My image]]', {
    assets: { 'assets/clip.png': 'data:image/png;base64,AAAA' },
  });
  expect(html).toContain('alt="My image"');
  expect(html).not.toContain('style="width');
});

test('rejects unsafe HTML and URL protocols', () => {
  const html = renderMarkdown('# <img src=x onerror=alert(1)>\\n\\n[x](javascript:alert(1))');
  expect(html).not.toContain('<img src=x onerror=alert(1)>');
  expect(html).not.toContain('javascript:');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});
test('escapes HTML in footnote definitions while preserving markdown formatting', () => {
  const html = renderMarkdown('Text[^1].\n\n[^1]: <img src=x onerror=alert(1)> **bold**');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('<strong>bold</strong>');
});
test('rejects protocol-relative media URLs', () => {
  expect(renderMarkdown('![remote](//evil.example/image.png)')).not.toContain('src="//evil.example');
});
test('embeds a referenced Markdown note with a recursion limit', () => {
  const html = renderMarkdown('![[Welcome]]', {
    notes: { 'welcome.md': '# Welcome\n\n[[Welcome]]' },
    fileRoutePrefix: '/docs',
  });
  expect(html).toContain('<h1>Welcome</h1>');
  expect(html).toContain('class="obsidian-embed-note"');
  expect(html).toContain('/docs/welcome');
});

test('renders Obsidian callouts', () => {
  const html = renderMarkdown('> [!note] A note\n> Body text');
  expect(html).toContain('canvas-callout canvas-callout-note');
  expect(html).toContain('canvas-callout-title');
  expect(html).toContain('A note');
  expect(html).toContain('Body text');
});

test('keeps plain blockquotes as blockquotes', () => {
  const html = renderMarkdown('> just a quote');
  expect(html).toContain('<blockquote>');
  expect(html).not.toContain('canvas-callout');
});

test('renders inline tags', () => {
  const html = renderMarkdown('see #hello/world and #plain');
  expect(html).toContain('<span class="canvas-tag">#hello/world</span>');
  expect(html).toContain('<span class="canvas-tag">#plain</span>');
});

test('does not tagify code spans or code fences', () => {
  const inline = renderMarkdown('use `#notatag` here');
  expect(inline).toContain('<code>#notatag</code>');
  expect(inline).not.toContain('canvas-tag');

  const fence = renderMarkdown('```js\nconst x = "#nope";\n```');
  expect(fence).not.toContain('canvas-tag');
});

test('renders inline and display math', () => {
  const inline = renderMarkdown('energy $E = mc^2$ here');
  expect(inline).toContain('canvas-math');
  expect(inline).toContain('katex');

  const display = renderMarkdown('$$\nE = mc^2\n$$');
  expect(display).toContain('canvas-math-display');
});

test('renders footnotes', () => {
  const html = renderMarkdown('Text with a note[^1].\n\n[^1]: The note body.');
  expect(html).toContain('canvas-footnote-ref');
  expect(html).toContain('canvas-footnotes');
  expect(html).toContain('The note body.');
});

test('emits mermaid placeholder for mermaid fences', () => {
  const html = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');
  expect(html).toContain('canvas-mermaid-block');
  expect(html).toContain('data-code=');
});
