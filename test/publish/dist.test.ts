import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';

const distDir = path.join(process.cwd(), 'dist'); // import.meta.dirname points at test/ subdir under bun test
const distEntry = path.join(distDir, 'index.js');

test('built package resolves its canvas component to an existing file', async () => {
  if (!existsSync(distEntry)) {
    throw new Error('dist/index.js missing — run `bun run build` before tests');
  }

  const mod = (await import(distEntry)) as {
    pluginObsidianCanvas: (options?: { vaultRoot?: string }) => {
      markdown?: { globalComponents?: string[] };
    };
  };

  const plugin = mod.pluginObsidianCanvas({ vaultRoot: import.meta.dirname });
  const components = plugin.markdown?.globalComponents;

  expect(components).toBeDefined();
  expect(components).toHaveLength(2);

  for (const componentPath of components ?? []) {
    expect(typeof componentPath).toBe('string');
    expect(existsSync(componentPath as string)).toBe(true);
  }
});
