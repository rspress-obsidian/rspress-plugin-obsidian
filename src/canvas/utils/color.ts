const CANVAS_PRESET_COLORS: Record<string, string> = {
	"1": "var(--canvas-color-1)",
	"2": "var(--canvas-color-2)",
	"3": "var(--canvas-color-3)",
	"4": "var(--canvas-color-4)",
	"5": "var(--canvas-color-5)",
	"6": "var(--canvas-color-6)",
};

const CSS_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const CSS_PERCENT = `${CSS_NUMBER}%`;
const CSS_ALPHA = `${CSS_NUMBER}%?`;
const RGB_COMPONENT = `${CSS_NUMBER}%?`;
const HSL_HUE = `${CSS_NUMBER}(?:deg|grad|rad|turn)?`;

function isSafeCssColor(value: string): boolean {
	if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
	if (/^var\(--[a-z0-9_-]+\)$/i.test(value)) return true;

	const rgbComma = new RegExp(
		`^rgba?\\(\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}(?:\\s*,\\s*${CSS_ALPHA})?\\s*\\)$`,
		"i",
	);
	const rgbSpace = new RegExp(
		`^rgba?\\(\\s*${RGB_COMPONENT}\\s+${RGB_COMPONENT}\\s+${RGB_COMPONENT}(?:\\s*\\/\\s*${CSS_ALPHA})?\\s*\\)$`,
		"i",
	);
	if (rgbComma.test(value) || rgbSpace.test(value)) return true;

	const hslComma = new RegExp(
		`^hsla?\\(\\s*${HSL_HUE}\\s*,\\s*${CSS_PERCENT}\\s*,\\s*${CSS_PERCENT}(?:\\s*,\\s*${CSS_ALPHA})?\\s*\\)$`,
		"i",
	);
	const hslSpace = new RegExp(
		`^hsla?\\(\\s*${HSL_HUE}\\s+${CSS_PERCENT}\\s+${CSS_PERCENT}(?:\\s*\\/\\s*${CSS_ALPHA})?\\s*\\)$`,
		"i",
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
