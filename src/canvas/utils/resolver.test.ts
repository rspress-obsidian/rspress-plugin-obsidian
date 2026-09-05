import { expect, test } from 'bun:test';
import { resolveFileRoute } from './resolver';

test('resolves .md file to lowercase route', () => {
  expect(resolveFileRoute('Welcome.md')).toBe('/welcome');
});

test('resolves .md file with prefix', () => {
  expect(resolveFileRoute('Welcome.md', '/docs')).toBe('/docs/welcome');
});

test('replaces spaces with hyphens', () => {
  expect(resolveFileRoute('My Note.md')).toBe('/my-note');
});

test('handles subpath separately (caller responsibility)', () => {
  const route = resolveFileRoute('Notes.md', '/docs');
  expect(`${route}#section`).toBe('/docs/notes#section');
});

test('passes through non-MD files as-is', () => {
  expect(resolveFileRoute('diagram.png')).toBe('/diagram.png');
});

test('passes through non-MD files with prefix unchanged', () => {
  expect(resolveFileRoute('diagram.png', '/docs')).toBe('/diagram.png');
});

test('handles non-MD files with leading slash', () => {
  expect(resolveFileRoute('/assets/image.png')).toBe('/assets/image.png');
});

test('handles .mdx files', () => {
  expect(resolveFileRoute('Guide.mdx')).toBe('/guide');
  expect(resolveFileRoute('Guide.mdx', '/docs')).toBe('/docs/guide');
});

test('handles .markdown files', () => {
  expect(resolveFileRoute('Readme.markdown')).toBe('/readme');
});

test('handles uppercase extensions', () => {
  expect(resolveFileRoute('Note.MD')).toBe('/note');
  expect(resolveFileRoute('Image.PNG')).toBe('/Image.PNG');
});

test('handles nested paths', () => {
  expect(resolveFileRoute('Notes/Subfolder/Note.md', '/docs')).toBe('/docs/notes/subfolder/note');
});

test('non-MD nested paths pass through', () => {
  expect(resolveFileRoute('assets/images/diagram.png')).toBe('/assets/images/diagram.png');
});
