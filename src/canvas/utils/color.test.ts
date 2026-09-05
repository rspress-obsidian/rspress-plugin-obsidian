import { expect, test } from 'bun:test';
import { resolveBgColor, resolveColor } from './color';

test('resolves JSON Canvas presets and supported CSS colors', () => {
  expect(resolveColor('1', 'fallback')).toBe('var(--canvas-color-1)');
  expect(resolveColor('#ff0000', 'fallback')).toBe('#ff0000');
  expect(resolveColor('rgb(255, 0, 0)', 'fallback')).toBe('rgb(255, 0, 0)');
  expect(resolveColor('hsl(120, 100%, 50%)', 'fallback')).toBe('hsl(120, 100%, 50%)');
  expect(resolveColor('var(--custom-canvas-color)', 'fallback')).toBe(
    'var(--custom-canvas-color)',
  );
});

test('rejects unsupported or unsafe CSS color strings', () => {
  const fallback = 'var(--canvas-edge-color)';
  expect(resolveColor('red; background: url(https://evil.test)', fallback)).toBe(fallback);
  expect(resolveColor('rgb(255, 0, 0); color: blue', fallback)).toBe(fallback);
  expect(resolveColor('var(--color, red)', fallback)).toBe(fallback);
  expect(resolveColor('not-a-color', fallback)).toBe(fallback);
});

test('uses explicit colors for node and group backgrounds', () => {
  expect(resolveBgColor('2', 'other')).toBe('var(--canvas-bg-color-2-tint)');
  expect(resolveBgColor('#123456', 'other')).toBe('#123456');
  expect(resolveBgColor('hsl(240 100% 50% / 25%)', 'group')).toBe(
    'hsl(240 100% 50% / 25%)',
  );
  expect(resolveBgColor('unsafe', 'group')).toBe('var(--canvas-group-bg)');
});
