/**
 * `icon()` drawn with Lucide, Obsidian's icon set, from the optional
 * `lucide-static` peer. The package is never imported: its `icons/<name>.svg`
 * files are located and inlined at build time, so a site without it still
 * builds and shows each icon's name instead.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { moduleDir } from "../../../runtime-paths.js";
import { escapeHtmlAttribute } from "../../../shared/escape.js";

/** An icon drawn as inline SVG, or why it is drawn as its name. */
export type LucideIcon = { svg: string } | { problem: string };

const iconsDirs = new Map<string, string | undefined>();
const svgFiles = new Map<string, string | undefined>();

/**
 * The `icons` folder of `lucide-static`, resolved from `fromDir` (default: this
 * package's directory, as `isMermaidInstalled` resolves mermaid, so a hoisted,
 * pnpm or workspace install answers the way the site's build would), or
 * `undefined` when the peer is absent. Looked up once per directory.
 */
function lucideIconsDir(fromDir: string): string | undefined {
	if (iconsDirs.has(fromDir)) return iconsDirs.get(fromDir);
	let dir: string | undefined;
	try {
		const manifest = createRequire(path.join(fromDir, "noop.js")).resolve(
			"lucide-static/package.json",
		);
		const icons = path.join(path.dirname(manifest), "icons");
		dir = fs.existsSync(icons) ? icons : undefined;
	} catch {
		dir = undefined;
	}
	iconsDirs.set(fromDir, dir);
	return dir;
}

/**
 * The Lucide name `icon()` was given, as Obsidian takes it: `arrow-up` or its
 * icon id `lucide-arrow-up`, any case. Lucide's own aliases for renamed icons
 * (`check-circle` for `circle-check`) ship as files of their own, so they
 * resolve as well. `undefined` for a name no icon file can have.
 */
function lucideName(name: string): string | undefined {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/^lucide-/, "");
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : undefined;
}

/**
 * `icon(name)` as inline SVG with Obsidian's `svg-icon lucide-<name>` classes.
 * Lucide draws with `stroke="currentColor"`, so the icon takes the text colour.
 *
 * @param fromDir - Where `lucide-static` is resolved from.
 */
export function lucideIcon(name: string, fromDir: string = moduleDir): LucideIcon {
	const dir = lucideIconsDir(fromDir);
	if (!dir) {
		return {
			problem: "icon() draws each icon as its name: install `lucide-static` to draw Bases icons",
		};
	}
	const canonical = lucideName(name);
	const file = canonical ? path.join(dir, `${canonical}.svg`) : undefined;
	let source: string | undefined;
	if (file) {
		if (!svgFiles.has(file)) {
			let read: string | undefined;
			try {
				read = fs.readFileSync(file, "utf8");
			} catch {
				read = undefined;
			}
			svgFiles.set(file, read);
		}
		source = svgFiles.get(file);
	}
	const root = source?.replace(/<!--[\s\S]*?-->/g, "").trim();
	if (!canonical || !root?.startsWith("<svg")) {
		return { problem: `icon("${name}") is not a Lucide icon; it is drawn as its name` };
	}
	// The file's own `class="lucide lucide-x"` gives way to Obsidian's classes.
	const end = root.indexOf(">") + 1;
	const attributes = ` class="svg-icon lucide-${canonical} bases-icon" data-icon="${escapeHtmlAttribute(name)}" aria-hidden="true"`;
	const openTag = root
		.slice(0, end)
		.replace(/\s+class="[^"]*"/, "")
		.replace(/^<svg/, `<svg${attributes}`);
	return { svg: `${openTag}${root.slice(end)}` };
}
