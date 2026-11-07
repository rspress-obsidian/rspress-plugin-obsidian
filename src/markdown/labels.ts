import { humanizeBaseName } from "../shared/slug.js";
import type { ContentPage, ParsedWikiLink } from "./types.js";

/**
 * The text Obsidian shows for a wikilink: the alias when there is one, else the
 * target exactly as typed (`[[2024-01-15]]` stays `2024-01-15`, `[[my_note]]`
 * stays `my_note`), with a subpath shown as `Note > Heading` / `Note > ^id`
 * and a same-page `[[#Heading]]` as just `Heading`.
 */
export function wikiLinkDisplayText(parsed: ParsedWikiLink): string {
	if (parsed.alias) return parsed.alias;
	const subpath = parsed.subpath;
	const parts =
		subpath?.kind === "block"
			? [`^${subpath.value}`]
			: (subpath?.value
					.split("#")
					.map((part) => part.trim())
					.filter(Boolean) ?? []);
	const target = parsed.target.trim();
	return (target ? [target, ...parts] : parts).join(" > ");
}

/**
 * Human-facing label for a page in the backlinks panel: the frontmatter
 * `title`, else the page's `# heading`, else a humanized filename. A section
 * heading names a part of the note, not the note (a Kanban board's first
 * heading is a lane), so only a top-level one counts. A raw basename
 * ("getting-started") reads like debug output, so it is the last resort.
 */
export function backlinkLabel(page: ContentPage): string {
	if (page.title) {
		return page.title;
	}
	const titleHeading = page.headings.find(
		(heading) => heading.topLevel !== false && (heading.depth ?? 1) === 1,
	)?.rawText;
	if (titleHeading) {
		return titleHeading;
	}
	return humanizeBaseName(page.baseName) || page.baseName;
}
