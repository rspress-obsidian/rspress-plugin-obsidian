import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

/**
 * Rules the module graph has to keep, checked rather than remembered.
 *
 * `untangle` collapsed most of the duplication in this codebase into single
 * owners; these are the edges that would quietly come back if nobody looked:
 * a browser module dragging a node dependency into the client bundle, a cycle
 * between two modules that makes "which one owns this" unanswerable, or a
 * feature reaching sideways into another one.
 */

const SRC = path.join(import.meta.dir, "..", "src");
const FEATURES = ["markdown", "canvas", "graph"];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

interface Edge {
	/** The specifier as written. */
	specifier: string;
	/** The resolved file, when the specifier is relative and exists. */
	target?: string;
	/** `import type` / `export type`: erased, so it never reaches a bundle. */
	typeOnly: boolean;
}

/** Every relative import of a source file, with `type` imports marked. */
function edgesOf(file: string): Edge[] {
	const source = readFileSync(file, "utf-8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	const edges: Edge[] = [];
	for (const match of source.matchAll(
		/(import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g,
	)) {
		const specifier = match[3] ?? "";
		const typeOnly = Boolean(match[2]);
		if (!specifier.startsWith(".")) {
			edges.push({ specifier, typeOnly });
			continue;
		}
		const base = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
		const target = [base, base.replace(/\.ts$/, ".tsx")].find((candidate) => {
			try {
				return statSync(candidate).isFile();
			} catch {
				return false;
			}
		});
		edges.push({ specifier, target, typeOnly });
	}
	return edges;
}

function isNodeBuiltin(specifier: string): boolean {
	return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

const files = sourceFiles(SRC);
const edges = new Map(files.map((file) => [file, edgesOf(file)]));

/** Why `file` cannot run in a browser, or `undefined` when it can. */
function nodeDependency(file: string, seen = new Set<string>()): string | undefined {
	if (seen.has(file)) return undefined;
	seen.add(file);
	for (const edge of edges.get(file) ?? []) {
		if (edge.typeOnly) continue;
		if (isNodeBuiltin(edge.specifier))
			return `${path.relative(SRC, file)} imports ${edge.specifier}`;
		if (edge.target) {
			const reason = nodeDependency(edge.target, seen);
			if (reason) return reason;
		}
	}
	return undefined;
}

function isBrowserCode(file: string): boolean {
	const relative = `/${path.relative(SRC, file)}`;
	return /\/(runtime|components|hooks)\//.test(relative) || relative.endsWith(".tsx");
}

/** One cycle per strongly connected component that is not a single node. */
function importCycles(): string[][] {
	const state = new Map<string, "open" | "closed">();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const visit = (file: string) => {
		state.set(file, "open");
		stack.push(file);
		for (const edge of edges.get(file) ?? []) {
			// A cycle through `import type` erases before the module runs: the
			// two modules never hold each other at runtime. A cycle through a
			// value import means neither can be understood without the other.
			if (!edge.target || edge.typeOnly) continue;
			const seen = state.get(edge.target);
			if (seen === "open") cycles.push([...stack.slice(stack.indexOf(edge.target)), edge.target]);
			else if (seen === undefined) visit(edge.target);
		}
		stack.pop();
		state.set(file, "closed");
	};
	for (const file of files) if (!state.has(file)) visit(file);
	return cycles;
}

describe("module graph", () => {
	test("is scanned at all", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	test("has no import cycles", () => {
		const cycles = importCycles().map((cycle) =>
			cycle.map((file) => path.relative(SRC, file)).join(" -> "),
		);
		expect(cycles).toEqual([]);
	});

	test("browser code reaches no node builtin, however deep", () => {
		// Not just "does not import `node:fs`": one pure-looking helper imported
		// through a node module drags the whole chain into the client bundle.
		const offenders = files
			.filter(isBrowserCode)
			.map((file) => nodeDependency(file))
			.filter((reason): reason is string => reason !== undefined);
		expect(offenders).toEqual([]);
	});

	test("the markdown feature never imports canvas or graph", () => {
		// markdown owns the content index and link resolution; the other two
		// reuse it at build time. An import back the other way would make the
		// direction arbitrary and the shared primitives impossible to place.
		const offenders: string[] = [];
		for (const file of files) {
			const relative = path.relative(SRC, file);
			if (!relative.startsWith("markdown/")) continue;
			for (const edge of edges.get(file) ?? []) {
				for (const feature of ["canvas", "graph"]) {
					if (new RegExp(`(^|/)${feature}/`).test(edge.specifier)) {
						offenders.push(`${relative} -> ${edge.specifier}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every feature directory is actually one", () => {
		expect(
			FEATURES.filter((feature) => !files.some((file) => file.startsWith(path.join(SRC, feature)))),
		).toEqual([]);
	});
});
