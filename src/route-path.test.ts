import { describe, expect, test } from "bun:test";
// Rspress's own route normalizer — not public API, which is why the plugin
// carries a port; this test keeps the two in lockstep.
import { normalizeRoutePath as rspressNormalizeRoutePath } from "@rspress/core/dist/node/route/normalizeRoutePath.js";
import fc from "fast-check";
import { extensionOf } from "./shared/media-exts.js";
import {
	deriveDocsRoutePath,
	deriveRoutePath,
	encodeRoutePath,
	isIndexRoute,
	normalizeFsPath,
	normalizeRoutePath,
	normalizeRoutePrefix,
	routeHref,
} from "./shared/route-path.js";

describe("normalizeRoutePath", () => {
	test("drops the extension and a trailing index segment", () => {
		expect(normalizeRoutePath("Notes/Setup.md")).toBe("Notes/Setup");
		expect(normalizeRoutePath("guide/index.md")).toBe("guide");
		expect(normalizeRoutePath("index.md")).toBe("");
	});

	test("filters empty, current and parent segments", () => {
		// Windows separators and a `./` prefix both reach this function: a canvas
		// card may reference `./note.md` while the index never does.
		expect(normalizeRoutePath("Notes\\Sub\\Note.md")).toBe("Notes/Sub/Note");
		expect(normalizeRoutePath("./note.md")).toBe("note");
		expect(normalizeRoutePath("a/../b/note.md")).toBe("a/b/note");
		expect(normalizeRoutePath("/leading/slash.md")).toBe("leading/slash");
	});

	test("keeps case and spaces, and leaves non-markdown extensions alone", () => {
		expect(normalizeRoutePath("create a link.md")).toBe("create a link");
		expect(normalizeRoutePath("Deep/Nested/Note.mdx")).toBe("Deep/Nested/Note");
		expect(normalizeRoutePath("diagram.png")).toBe("diagram.png");
	});
});

describe("deriveRoutePath", () => {
	test("renders the root route for an index page", () => {
		expect(deriveRoutePath("index.md")).toBe("/");
		expect(deriveRoutePath("guide/index.md")).toBe("/guide");
	});

	test("applies the prefix without doubling the root", () => {
		expect(deriveRoutePath("Welcome.md", "/vault")).toBe("/vault/Welcome");
		expect(deriveRoutePath("index.md", "/vault")).toBe("/vault");
	});
});

describe("routeHref", () => {
	test("appends the trailing slash an index page needs", () => {
		// Rspress writes `<route>/index.html` for an index page and normalizes a
		// slash-less route to `<route>.html`, which is not a file it produced.
		expect(routeHref("/markdown", "markdown/index.md")).toBe("/markdown/");
		expect(routeHref("/vault", "vault/index.md")).toBe("/vault/");
		expect(routeHref("/", "index.md")).toBe("/");
	});

	test("leaves a leaf page alone, and encodes its segments", () => {
		expect(routeHref("/vault/Welcome", "vault/Welcome.md")).toBe("/vault/Welcome");
		expect(routeHref("/vault/create a link", "vault/create a link.md")).toBe(
			"/vault/create%20a%20link",
		);
		expect(routeHref("/vault/create a link", "vault/create a link/index.md")).toBe(
			"/vault/create%20a%20link/",
		);
	});

	test("treats mdx and nested index paths the same way", () => {
		expect(isIndexRoute("guide/index.mdx")).toBe(true);
		expect(isIndexRoute("index.md")).toBe(true);
		expect(isIndexRoute("guide/index-notes.md")).toBe(false);
		expect(isIndexRoute("guide/getting-started.md")).toBe(false);
	});
});

describe("normalizeRoutePrefix", () => {
	test("returns the fallback when unset or empty", () => {
		expect(normalizeRoutePrefix(undefined)).toBe("");
		expect(normalizeRoutePrefix("")).toBe("");
		expect(normalizeRoutePrefix(undefined, "/vault")).toBe("/vault");
		expect(normalizeRoutePrefix("/", "/vault")).toBe("/vault");
	});

	test("adds a leading slash, drops trailing slashes and stray segments", () => {
		expect(normalizeRoutePrefix("vault")).toBe("/vault");
		expect(normalizeRoutePrefix("/vault/")).toBe("/vault");
		expect(normalizeRoutePrefix("//vault//notes//")).toBe("/vault/notes");
		expect(normalizeRoutePrefix("vault/./notes")).toBe("/vault/notes");
	});
});

describe("normalizeFsPath (property)", () => {
	test("property: idempotent — re-normalizing a normalized path is a no-op", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const once = normalizeFsPath(input);
				return normalizeFsPath(once) === once;
			}),
		);
	});

	test("property: output never contains a backslash", () => {
		fc.assert(fc.property(fc.string(), (input) => !normalizeFsPath(input).includes("\\")));
	});
});

describe("normalizeRoutePrefix (property)", () => {
	test("property: idempotent with the default fallback", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const once = normalizeRoutePrefix(value);
				return normalizeRoutePrefix(once) === once;
			}),
		);
	});

	test("property: result is empty or a slash-rooted path without a trailing slash", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const result = normalizeRoutePrefix(value);
				return result === "" || (result.startsWith("/") && !result.endsWith("/"));
			}),
		);
	});
});

describe("encodeRoutePath (property)", () => {
	test("property: preserves the slash structure and emits no spaces", () => {
		fc.assert(
			fc.property(fc.string(), (routePath) => {
				const encoded = encodeRoutePath(routePath);
				return encoded.split("/").length === routePath.split("/").length && !encoded.includes(" ");
			}),
		);
	});
});

describe("deriveDocsRoutePath", () => {
	const langs = ["en", "zh"];
	const versions = ["v1", "v2"];
	const paths = [
		"index.md",
		"guide.md",
		"guide/index.md",
		"en/guide.md",
		"zh/guide.md",
		"en/index.md",
		"zh/index.mdx",
		"v1/en/guide.md",
		"v2/zh/api/index.md",
		"v2/guide.md",
		"fr/guide.md",
		"Notes/My Page.md",
	];

	test.each([
		["en", "v1"],
		["en", ""],
		["", ""],
	])("matches Rspress with lang %p and version %p", (lang, version) => {
		for (const relativePath of paths) {
			const expected = rspressNormalizeRoutePath(
				relativePath,
				lang,
				version,
				lang ? langs : [],
				version ? versions : [],
			).routePath.replace(/(.)\/$/, "$1");
			const actual = deriveDocsRoutePath(relativePath, {
				lang: lang || undefined,
				langs: lang ? langs : [],
				version: version || undefined,
				versions: version ? versions : [],
			});
			expect([relativePath, actual]).toEqual([relativePath, expected]);
		}
	});

	test("drops the default locale from a docs route", () => {
		expect(deriveDocsRoutePath("en/guide.md", { lang: "en", langs })).toBe("/guide");
		expect(deriveDocsRoutePath("zh/guide.md", { lang: "en", langs })).toBe("/zh/guide");
	});
});

describe("extensionOf", () => {
	test("reads the extension of the last path segment only", () => {
		expect(extensionOf("media/Clip.MP4")).toBe("mp4");
		expect(extensionOf("SVG")).toBe("");
		expect(extensionOf("PDF")).toBe("");
		expect(extensionOf("v1.2/Notes")).toBe("");
		expect(extensionOf(".env")).toBe("");
	});
});
