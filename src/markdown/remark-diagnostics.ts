import type { Text } from "mdast";
import type { VFile } from "vfile";

// Files that produced an "error"-mode diagnostic, with those diagnostics.
// Failure is deferred to the end of the top-level pass so one bad link does
// not abort resolution of the remaining wikilinks in the document; the
// failure then lists every diagnostic, because Rspress never prints
// `file.messages` and they would otherwise be invisible.
export const pendingFailures = new WeakMap<VFile, string[]>();

/**
 * A fatal `VFileMessage`, which is what `file.fail` throws in `"fail"` mode.
 *
 * The top-level pass must rethrow one so the build actually fails. So must
 * every catch that runs while rendering a transcluded document: swallowing it
 * turns `onDataviewError: "error"` (and the broken/ambiguous link modes) into a
 * warning the moment the offending note happens to be embedded, so the same
 * document fails one build and passes the next.
 */
export function isFatalVFileMessage(error: unknown): boolean {
	return typeof error === "object" && error !== null && "fatal" in error && error.fatal === true;
}

/**
 * Record one plugin diagnostic.
 *
 * Rspress never reads `file.messages`, so a warn-level diagnostic recorded
 * only there is invisible; print it to the console as well. A deferred one
 * is listed in the page's build failure instead (`failPendingDiagnostics`).
 *
 * `mode` picks where failure lands: `"fail"` throws immediately (the
 * option-driven error modes), `"defer"` marks the file so the top-level pass
 * can fail it once every link has been resolved.
 */
export function reportPluginDiagnostic(
	file: VFile,
	scope: string,
	message: string,
	mode: "warn" | "defer" | "fail" = "warn",
): void {
	const text = `[rspress-plugin-obsidian:markdown${scope ? `:${scope}` : ""}] ${message}`;
	if (mode === "fail") file.fail(text);
	file.message(text);
	if (mode === "defer") {
		const pending = pendingFailures.get(file);
		if (pending) pending.push(text);
		else pendingFailures.set(file, [text]);
		return;
	}
	console.warn(text);
}

/** Fail `file` with every deferred diagnostic it collected, if it collected any. */
export function failPendingDiagnostics(file: VFile): void {
	const pending = pendingFailures.get(file);
	if (!pending) return;
	file.fail(
		`[rspress-plugin-obsidian:markdown] One or more links or plugin blocks failed to resolve or render:\n${pending.map((text) => `  - ${text}`).join("\n")}`,
	);
}

/** Parents whose text belongs to another construct and must not be rewritten. */
export const SKIP_PARENT_TYPES: Record<string, true> = {
	link: true,
	linkReference: true,
	definition: true,
	inlineCode: true,
	code: true,
	html: true,
	mdxJsxTextElement: true,
	mdxJsxFlowElement: true,
	mdxFlowExpression: true,
	mdxTextExpression: true,
};

export function createTextNode(value: string): Text {
	return {
		type: "text",
		value,
	};
}
