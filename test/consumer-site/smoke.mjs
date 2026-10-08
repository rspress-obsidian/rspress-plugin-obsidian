// Smoke check for the consumer fixture's `rspress build` output. Plain Node (no
// dependencies) because it runs inside the copied fixture, which only has the
// packed plugin and Rspress installed.
//
// It asserts that each feature reached the built site through the published
// tarball: resolved wikilinks and callouts (markdown), a rendered board
// (canvas), diagram placeholders (the optional mermaid path), and the browser
// chunks the shipped runtime entries compile into (graph panel, hover previews).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const out = path.join(import.meta.dirname, "doc_build");
const failures = [];

function check(condition, message) {
	if (!condition) failures.push(message);
}

function read(relative) {
	const file = path.join(out, relative);
	if (!existsSync(file)) {
		failures.push(`missing ${relative}`);
		return "";
	}
	return readFileSync(file, "utf8");
}

function walk(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

check(read("index.html").includes("Consumer fixture"), "index.html lacks the site title");

const welcome = read("vault/Welcome.html");
check(/href="\/vault\/Second(%20| )note/.test(welcome), "Welcome: [[Second note]] did not resolve to its route");
check(/class="[^"]*callout/.test(welcome), "Welcome: callout was not rendered");
check(welcome.includes("Transcluded into the welcome page"), "Welcome: section embed was not transcluded");
check(/class="[^"]*katex/.test(welcome), "Welcome: inline math was not rendered");
check(welcome.includes('href="/tags/fixture'), "Welcome: #fixture is not a tag link");
check(read("tags/fixture.html").includes("Welcome"), "tag page /tags/fixture does not list Welcome");

const second = walk(path.join(out, "vault")).find((file) => /Second(%20| )note\.html$/.test(file));
check(second !== undefined, "vault/Second note page was not emitted");
if (second) {
	check(readFileSync(second, "utf8").includes("obsidian-mermaid-block"), "Second note: mermaid placeholder missing");
}

// A board page is a client-rendered shell that fetches the board's JSON, so the
// HTML proves only that the route exists; the JSON proves the board was
// published, with its file card resolved against the vault.
const boards = walk(path.join(out, "canvas")).filter((file) => file.endsWith(".html"));
check(
	boards.some((file) => readFileSync(file, "utf8").includes("canvas-container")),
	"no canvas page was emitted for the board",
);
const boardJson = read("__canvases__/Board.json");
if (boardJson) {
	const board = JSON.parse(boardJson);
	const nodes = Array.isArray(board.nodes) ? board.nodes : [];
	check(nodes.length === 2, `published board has ${nodes.length} nodes, expected 2`);
	const fileCard = nodes.find((node) => node.id === "file");
	const kind = fileCard?.resolvedFile?.kind;
	check(
		kind !== undefined && kind !== "missing" && kind !== "private",
		`board file card did not resolve to the vault note (kind: ${kind})`,
	);
}

const scripts = walk(path.join(out, "static", "js")).filter((file) => file.endsWith(".js"));
const bundle = scripts.map((file) => readFileSync(file, "utf8")).join("\n");
check(scripts.length > 0, "no JavaScript was emitted");
// The graph data is a virtual module compiled into the client bundle; the
// second note's route appearing there means the graph plugin's runtime entries
// were resolved from the tarball and bundled.
check(/\/vault\/Second(%20| )note/.test(bundle), "graph data does not include the vault pages");

// `MERMAID=installed|absent` says which leg this is. Without the optional peer
// the site must still build (the plugins alias it away) and ship no renderer;
// with it, the renderer's lazy chunk must be there.
const mermaidLeg = process.env.MERMAID;
if (mermaidLeg === "installed" || mermaidLeg === "absent") {
	check(
		bundle.includes("flowchart-v2") === (mermaidLeg === "installed"),
		mermaidLeg === "installed"
			? "mermaid is installed but its renderer was not bundled"
			: "mermaid is absent but a renderer was bundled",
	);
}

const styles = walk(path.join(out, "static", "css"))
	.filter((file) => file.endsWith(".css"))
	.map((file) => readFileSync(file, "utf8"))
	.join("\n");
check(styles.includes(".callout"), "default markdown styles were not bundled");
check(styles.includes(".kanban-plugin__board"), "the plugin features' styles were not bundled");

// The reproduced Obsidian plugins, rendered at build time from the tarball.
const tasks = read("vault/Tasks.html");
check(tasks.includes("plugin-tasks-query-result"), "Tasks: the query block was not rendered");
check(tasks.includes("Ship the release"), "Tasks: the query did not list the open task");
check(read("vault/Roadmap.html").includes("kanban-plugin__board"), "Kanban: the board was not rendered");
const sketch = read("vault/Sketch.excalidraw.html");
check(sketch.includes("excalidraw-svg"), "Excalidraw: the drawing was not drawn");
check(/href="\/vault\/Welcome"/.test(sketch), "Excalidraw: the element link did not resolve");
const base = read("bases/Projects.html");
check(base.includes("bases-container"), "Bases: the .base page was not rendered");
check(base.includes("Alpha") && base.includes("Beta"), "Bases: the view did not list the folder's notes");
check(
	read("vault/Daily/2024-05-15.html").includes("Wednesday, May 15, 2024"),
	"Templater: the daily note was not filled from its template",
);
check(!existsSync(path.join(out, "vault", "Templates")), "Templater: the templates folder was published");

if (failures.length > 0) {
	console.error(`consumer smoke check failed:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
	process.exit(1);
}
console.log(`consumer smoke check passed (${scripts.length} scripts)`);
