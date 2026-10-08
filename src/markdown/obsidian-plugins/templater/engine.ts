/**
 * Templater's template syntax: `<% %>` output commands, `<%* %>` execution
 * commands, `<%+ %>` dynamic commands and the whitespace controls `<%_`/`_%>`
 * (all whitespace) and `<%-`/`-%>` (one line break), read the way Templater's
 * engine reads them.
 *
 * A command ends at the first `%>`, even inside a string — exactly as in
 * Obsidian. The whitespace flag comes right after `<%`, before the command
 * type; the closing flag is the last character before `%>`.
 */
import { isStackOverflow, STACK_OVERFLOW_MESSAGE } from "../../interpreter-limits.js";
import {
	compileTemplate,
	type ProgramRuntime,
	runTemplate,
	type TemplateChunk,
	type TemplateProgram,
	TemplaterError,
} from "./interpreter.js";

type Whitespace = "single" | "all" | undefined;

/** One command as written in a template or a note. */
export interface TemplaterCommand {
	/** The command as written, `<%` to `%>`. */
	raw: string;
	/** Offsets of `raw` in the scanned text. */
	start: number;
	end: number;
	kind: "output" | "exec";
	/** A `<%+` command: evaluated when the note is shown, not when the template is applied. */
	dynamic: boolean;
	/** The JavaScript between the tags. */
	code: string;
	open: Whitespace;
	close: Whitespace;
}

const OPEN = "<%";
const CLOSE = "%>";
const WHITESPACE_FLAGS: Record<string, Whitespace> = { "-": "single", _: "all" };

/**
 * The commands in `text`, in order. A `<%` with no `%>` after it ends the
 * scan: it is reported as `unclosed`.
 */
export function scanCommands(text: string): { commands: TemplaterCommand[]; unclosed?: number } {
	const commands: TemplaterCommand[] = [];
	let cursor = 0;
	for (;;) {
		const start = text.indexOf(OPEN, cursor);
		if (start < 0) return { commands };
		const closing = text.indexOf(CLOSE, start + OPEN.length);
		if (closing < 0) return { commands, unclosed: start };
		const end = closing + CLOSE.length;
		let body = text.slice(start + OPEN.length, closing);
		const open = WHITESPACE_FLAGS[body[0] ?? ""];
		if (open) body = body.slice(1);
		// Templater's dynamic marker: `<%+`, `<%*+`, with optional spaces before it.
		const dynamicMatch = /^\s*(\*?)\+/.exec(body);
		let kind: TemplaterCommand["kind"] = "output";
		if (dynamicMatch) {
			kind = dynamicMatch[1] ? "exec" : "output";
			body = body.slice(dynamicMatch[0].length);
		} else if (body.startsWith("*")) {
			kind = "exec";
			body = body.slice(1);
		}
		const close = body.length > 0 ? WHITESPACE_FLAGS[body[body.length - 1] ?? ""] : undefined;
		if (close) body = body.slice(0, -1);
		commands.push({
			raw: text.slice(start, end),
			start,
			end,
			kind,
			dynamic: Boolean(dynamicMatch),
			code: body,
			open,
			close,
		});
		cursor = end;
	}
}

/** Templater's whitespace trim of the text after (`leading`) or before a command. */
function trimWhitespace(text: string, whitespace: Whitespace, leading: boolean): string {
	if (whitespace === "all") return leading ? text.trimStart() : text.trimEnd();
	if (whitespace !== "single") return text;
	if (leading) {
		if (text.startsWith("\r\n")) return text.slice(2);
		return text.startsWith("\n") || text.startsWith("\r") ? text.slice(1) : text;
	}
	if (text.endsWith("\r\n")) return text.slice(0, -2);
	return text.endsWith("\n") || text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** How a template is expanded. */
export interface ExpandOptions {
	/**
	 * Copy `<%+ %>` commands through untouched: a template applied to a note
	 * leaves its dynamic commands for the reading view.
	 */
	keepDynamic: boolean;
}

/** A template split into the chunks a program is compiled from. */
export function templateChunks(source: string, { keepDynamic }: ExpandOptions): TemplateChunk[] {
	const { commands, unclosed } = scanCommands(source);
	if (unclosed !== undefined) {
		const line = source.slice(0, unclosed).split("\n").length;
		throw new TemplaterError(`A command on line ${line} has no closing \`%>\`.`);
	}
	const chunks: TemplateChunk[] = [];
	let cursor = 0;
	let trailing: Whitespace;
	for (const command of commands) {
		if (keepDynamic && command.dynamic) continue;
		let text = source.slice(cursor, command.start);
		text = trimWhitespace(trimWhitespace(text, trailing, true), command.open, false);
		if (text) chunks.push({ kind: "text", value: text });
		chunks.push({ kind: command.kind, code: command.code, raw: command.raw });
		trailing = command.close;
		cursor = command.end;
	}
	const rest = trimWhitespace(source.slice(cursor), trailing, true);
	if (rest) chunks.push({ kind: "text", value: rest });
	return chunks;
}

/**
 * Expand a template: run every command and return the text it produces. A
 * template whose statements do not parse produces only `runtime.onError`'s
 * marker, as Templater aborts such a template.
 */
export async function expandCommands(
	source: string,
	runtime: ProgramRuntime,
	options: ExpandOptions,
): Promise<string> {
	if (!source.includes(OPEN)) return source;
	let program: TemplateProgram;
	try {
		program = compileTemplate(templateChunks(source, options));
	} catch (error) {
		// A template nested deeper than the parser's stack aborts like any syntax error.
		if (isStackOverflow(error)) return runtime.onError(STACK_OVERFLOW_MESSAGE, "");
		if (!(error instanceof TemplaterError)) throw error;
		return runtime.onError(error.message, "");
	}
	return await runTemplate(program, runtime);
}
