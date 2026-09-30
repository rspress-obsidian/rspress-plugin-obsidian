import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of this module — the package root's `dist/` in the published
 * bundle, `src/` when running from source.
 *
 * `__dirname` is checked first because it exists in the CommonJS bundle and
 * needs no shim. Falling back to `import.meta.url` (the ESM build) would be
 * rewritten by esbuild for CJS into a `document.baseURI`-based expression that
 * throws wherever a DOM global exists in the same process (jsdom/happy-dom test
 * environments). Do not use `import.meta.dirname`: esbuild erases it in the CJS
 * bundle and leaves `undefined`.
 */
export const moduleDir =
	typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a file that exists in one of two layouts: the published bundle
 * (`dist/<...>`) or the source tree (`src/<...>`). Candidates are tried in
 * order and the first that exists wins.
 *
 * @throws If none of the candidates exist. Returning a plausible-looking path
 *   instead would hand Rspress a file that is never there, and the failure
 *   would surface much later as an unexplained missing-stylesheet or
 *   missing-component error; the thrown message names every path that was
 *   tried.
 */
export function resolveRuntimeFile(...candidates: string[]): string {
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	const tried = candidates.map((candidate) => `  - ${candidate}`).join("\n");
	throw new Error(
		`rspress-plugin-obsidian: no runtime file found; the package layout does not match either build. Tried:\n${tried || "  (no candidates given)"}`,
	);
}
