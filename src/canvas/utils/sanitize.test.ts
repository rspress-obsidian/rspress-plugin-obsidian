import { expect, test } from 'bun:test';
import { sanitizeHtml } from './sanitize';

test('removes script tags', () => {
  const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('<script');
  expect(cleaned).toContain('<p>Hello</p>');
  expect(cleaned).toContain('<p>World</p>');
});

test('removes style tags', () => {
  const html = '<style>body{color:red}</style><p>Hello</p>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('<style');
  expect(cleaned).toContain('<p>Hello</p>');
});

test('removes event handlers', () => {
  const html = '<p onclick="alert(1)">Hello</p>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('onclick');
  expect(cleaned).toContain('<p>Hello</p>');
});

test('sanitizes javascript: href', () => {
  const html = '<a href="javascript:alert(1)">Click</a>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('javascript:');
  expect(cleaned).toBe('<a>Click</a>');
});

test('sanitizes data: href', () => {
  const html = '<a href="data:text/html,<script>alert(1)</script>">Click</a>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('data:');
  expect(cleaned).toBe('<a>Click</a>');
});

test('preserves safe HTML', () => {
  const html =
    '<h1>Title</h1><p>Text with <strong>bold</strong> and <a href="https://example.com">link</a></p>';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).toContain('<h1>Title</h1>');
  expect(cleaned).toContain('<strong>bold</strong>');
  expect(cleaned).toContain('href="https://example.com"');
});

test('removes onerror from img', () => {
  const html = '<img src="x" onerror="alert(1)">';
  const cleaned = sanitizeHtml(html);
  expect(cleaned).not.toContain('onerror');
  expect(cleaned).toContain('<img');
});

test('handles empty string', () => {
  expect(sanitizeHtml('')).toBe('');
});

test('handles string with no HTML', () => {
  expect(sanitizeHtml('plain text')).toBe('plain text');
});
