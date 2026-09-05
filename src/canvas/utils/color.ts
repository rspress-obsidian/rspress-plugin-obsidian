const CANVAS_PRESET_COLORS: Record<string, string> = {
  '1': 'var(--canvas-color-1)',
  '2': 'var(--canvas-color-2)',
  '3': 'var(--canvas-color-3)',
  '4': 'var(--canvas-color-4)',
  '5': 'var(--canvas-color-5)',
  '6': 'var(--canvas-color-6)',
};

const CSS_NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const CSS_PERCENT = `${CSS_NUMBER}%`;
const CSS_ALPHA = `${CSS_NUMBER}%?`;
const RGB_COMPONENT = `${CSS_NUMBER}%?`;
const HSL_HUE = `${CSS_NUMBER}(?:deg|grad|rad|turn)?`;

function isSafeCssColor(value: string): boolean {
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
  if (/^var\(--[a-z0-9_-]+\)$/i.test(value)) return true;

  const rgbComma = new RegExp(
    `^rgba?\\(\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}(?:\\s*,\\s*${CSS_ALPHA})?\\s*\\)$`,
    'i',
  );
  const rgbSpace = new RegExp(
    `^rgba?\\(\\s*${RGB_COMPONENT}\\s+${RGB_COMPONENT}\\s+${RGB_COMPONENT}(?:\\s*\\/\\s*${CSS_ALPHA})?\\s*\\)$`,
    'i',
  );
  if (rgbComma.test(value) || rgbSpace.test(value)) return true;

  const hslComma = new RegExp(
    `^hsla?\\(\\s*${HSL_HUE}\\s*,\\s*${CSS_PERCENT}\\s*,\\s*${CSS_PERCENT}(?:\\s*,\\s*${CSS_ALPHA})?\\s*\\)$`,
    'i',
  );
  const hslSpace = new RegExp(
    `^hsla?\\(\\s*${HSL_HUE}\\s+${CSS_PERCENT}\\s+${CSS_PERCENT}(?:\\s*\\/\\s*${CSS_ALPHA})?\\s*\\)$`,
    'i',
  );
  return hslComma.test(value) || hslSpace.test(value);
}

/**
 * Resolve a JSON Canvas `canvasColor` value to a CSS color.
 * JSON Canvas presets (`"1"`–`"6"`) and the supported CSS color forms pass
 * through; malformed or unsupported values use the supplied fallback.
 */
export function resolveColor(color: string | undefined, fallback: string): string {
  const value = color?.trim();
  if (!value) return fallback;
  return CANVAS_PRESET_COLORS[value] || (isSafeCssColor(value) ? value : fallback);
}

const GROUP_PRESET_BGS: Record<string, string> = {
  '1': 'rgba(239, 68, 68, 0.03)',
  '2': 'rgba(249, 115, 22, 0.03)',
  '3': 'rgba(234, 179, 8, 0.03)',
  '4': 'rgba(34, 197, 94, 0.03)',
  '5': 'rgba(6, 182, 212, 0.03)',
  '6': 'rgba(168, 85, 247, 0.03)',
};

const NODE_PRESET_BGS: Record<string, string> = {
  '1': 'var(--canvas-bg-color-1-tint)',
  '2': 'var(--canvas-bg-color-2-tint)',
  '3': 'var(--canvas-bg-color-3-tint)',
  '4': 'var(--canvas-bg-color-4-tint)',
  '5': 'var(--canvas-bg-color-5-tint)',
  '6': 'var(--canvas-bg-color-6-tint)',
};

/**
 * Resolve a node background color from a `canvasColor` value.
 * Preset colors use the theme's translucent tints; explicit supported CSS
 * colors are retained, while malformed values use the node/group default.
 */
export function resolveBgColor(
  color: string | undefined,
  type: 'group' | 'other',
): string | undefined {
  const fallback = type === 'group' ? 'var(--canvas-group-bg)' : 'var(--canvas-node-bg)';
  const value = color?.trim();
  if (!value) return fallback;
  const preset = type === 'group' ? GROUP_PRESET_BGS[value] : NODE_PRESET_BGS[value];
  return preset || resolveColor(value, fallback);
}

