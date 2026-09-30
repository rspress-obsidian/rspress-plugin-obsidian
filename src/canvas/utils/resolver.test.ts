import { expect, test } from "bun:test";
import { resolveFileRoute } from "./resolver";

test("resolves .md file to a case-preserving route", () => {
	expect(resolveFileRoute("Welcome.md")).toBe("/Welcome");
});

test("resolves .md file with prefix", () => {
	expect(resolveFileRoute("Welcome.md", "/vault")).toBe("/vault/Welcome");
});

test("preserves spaces in path segments", () => {
	expect(resolveFileRoute("create a link.md")).toBe("/create a link");
});

test("handles subpath separately (caller responsibility)", () => {
	const route = resolveFileRoute("Notes.md", "/vault");
	expect(`${route}#section`).toBe("/vault/Notes#section");
});

test("drops a trailing index segment", () => {
	expect(resolveFileRoute("foo/index.md")).toBe("/foo");
	expect(resolveFileRoute("foo/index.md", "/vault")).toBe("/vault/foo");
	expect(resolveFileRoute("index.md")).toBe("/");
	expect(resolveFileRoute("index.md", "/vault")).toBe("/vault");
});

test("prefixes an attachment exactly as it prefixes the note beside it", () => {
	// The markdown plugin stages vault attachments into `public/<prefix>/` during
	// the build, so `/vault/media/clip.png` is where the file actually is. The
	// prefix used to be dropped for anything that was not markdown, which was
	// invisible while the canvas inlined its media as data URLs and fatal for the
	// rest: a PDF carrying a `#page=` subpath fell through to `/media/sample.pdf`
	// and rendered the site's 404 page inside the frame.
	expect(resolveFileRoute("media/clip.png", "/vault")).toBe("/vault/media/clip.png");
	expect(resolveFileRoute("pic.png", "/docs")).toBe("/docs/pic.png");
});

test("keeps a site-root path as it is", () => {
	expect(resolveFileRoute("diagram.png")).toBe("/diagram.png");
	expect(resolveFileRoute("/assets/image.png")).toBe("/assets/image.png");
	expect(resolveFileRoute("assets/images/diagram.png")).toBe("/assets/images/diagram.png");
});

test("preserves non-MD extension case", () => {
	expect(resolveFileRoute("Image.PNG")).toBe("/Image.PNG");
});

test("handles .mdx files", () => {
	expect(resolveFileRoute("Guide.mdx")).toBe("/Guide");
	expect(resolveFileRoute("Guide.mdx", "/vault")).toBe("/vault/Guide");
});

test("handles uppercase markdown extensions", () => {
	expect(resolveFileRoute("Note.MD")).toBe("/Note");
});

// `.markdown` is not an Rspress page extension; `deriveRoutePath` only strips
// `.md`/`.mdx`, so the route keeps its extension.
test("keeps the .markdown extension", () => {
	expect(resolveFileRoute("Readme.markdown")).toBe("/Readme.markdown");
});

test("preserves nested path case", () => {
	expect(resolveFileRoute("Notes/Subfolder/Note.md", "/vault")).toBe("/vault/Notes/Subfolder/Note");
});

// Canvas file-node links and the markdown plugin's published routes now come from
// one implementation (`src/route-path.ts`), so the old cross-implementation drift
// guard is gone with the copy it guarded.
