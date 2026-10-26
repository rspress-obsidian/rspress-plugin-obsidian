import type { Text } from "mdast";
import type { VFile } from "vfile";

// Files that produced an "error"-mode diagnostic, with those diagnostics.
// Failure is deferred to the end of the top-level pass so one bad link does
// not abort resolution of the remaining wikilinks in the document; the
// failure then lists every diagnostic, because Rspress never prints
// `file.messages` and they would otherwise be invisible. `cause` is the first
// error a deferred diagnostic carried, kept so the failure keeps its stack.
const pendingFailures = new WeakMap<VFile, { texts: string[]; cause?: Error }>();

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
 *
 * `cause` is the error behind the diagnostic, when there is one: it is
 * attached to the file message (and the failure), and a printed warning
 * includes its stack.
 */
export function reportPluginDiagnostic(
	file: VFile,
	scope: string,
	message: string,
	mode: "warn" | "defer" | "fail" = "warn",
	cause?: unknown,
): void {
	const text = `[rspress-plugin-obsidian:markdown${scope ? `:${scope}` : ""}] ${message}`;
	const error = cause === undefined || cause instanceof Error ? cause : new Error(String(cause));
	if (mode === "fail") file.fail(text, { cause: error });
	file.message(text, { cause: error });
	if (mode === "defer") {
		const pending = pendingFailures.get(file);
		if (!pending) pendingFailures.set(file, { texts: [text], cause: error });
		else {
			pending.texts.push(text);
			pending.cause ??= error;
		}
		return;
	}
	if (error === undefined) console.warn(text);
	else console.warn(text, error);
}

/** Whether `file` collected a deferred diagnostic that will fail it. */
export function hasPendingDiagnostics(file: VFile): boolean {
	return pendingFailures.has(file);
}

/** Fail `file` with every deferred diagnostic it collected, if it collected any. */
export function failPendingDiagnostics(file: VFile): void {
	const pending = pendingFailures.get(file);
	if (!pending) return;
	file.fail(
		`[rspress-plugin-obsidian:markdown] One or more links or plugin blocks failed to resolve or render:\n${pending.texts.map((text) => `  - ${text}`).join("\n")}`,
		{ cause: pending.cause },
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
