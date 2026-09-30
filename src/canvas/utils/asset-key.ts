/**
 * Canonical key for an asset/note reference in a canvas document.
 *
 * The writer (`canvas/index.ts`) stores assets and embedded notes under this
 * key, and the reader (`canvas/utils/markdown.ts`) looks targets up with it —
 * so both sides must fold the reference identically or a target like
 * `../images/photo.png` resolves on one side and 404s on the other. `..`
 * segments are resolved (popped), not dropped, and matching is
 * case-insensitive because Obsidian vaults are matched case-insensitively.
 */
export function normalizeAssetKey(value: string): string {
	const [assetPath = ""] = value.split("#");
	const segments: string[] = [];
	for (const segment of assetPath.replace(/\\/g, "/").split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/").toLowerCase();
}
