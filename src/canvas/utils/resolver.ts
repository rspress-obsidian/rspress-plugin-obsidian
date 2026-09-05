const MD_EXTENSIONS: Record<string, true> = {
  '.md': true,
  '.mdx': true,
  '.markdown': true,
};

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.match(/\.\w+$/)?.[0] || '';
  return MD_EXTENSIONS[ext.toLowerCase()] === true;
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return '';
  const normalized = normalizePath(prefix);
  return normalized ? `/${normalized}` : '';
}
export function resolveFileRoute(filePath: string, prefix?: string): string {
  const normalizedPath = normalizePath(filePath);
  const ext = normalizedPath.match(/\.\w+$/)?.[0] || '';
  const isMarkdown = MD_EXTENSIONS[ext.toLowerCase()] === true;

  if (!isMarkdown) {
    return `/${normalizedPath}`;
  }

  const clean = normalizedPath
    .replace(/\.\w+$/i, '')
    .split('/')
    .map((segment) => segment.replace(/\s+/g, '-').toLowerCase())
    .join('/');
  return `${normalizePrefix(prefix)}/${clean}`.replace(/\/{2,}/g, '/');
}
