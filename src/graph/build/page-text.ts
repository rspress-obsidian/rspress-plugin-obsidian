import { blankCommentRanges, findCommentRanges } from "../../markdown/comments.js";
import { stripFrontmatter } from "../../shared/frontmatter.js";

/**
 * A note's visible source: frontmatter removed, `%% … %%` and `<!-- … -->`
 * comments blanked (newlines kept, so `line:` and `section:` searches still see
 * the note's line structure). Comments are hidden on the published page, so
 * neither the hover preview nor the graph search may surface them.
 */
export function toVisibleSource(source: string): string {
	const body = stripFrontmatter(source);
	const withoutObsidianComments = blankCommentRanges(body, findCommentRanges(body));
	return withoutObsidianComments.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
		comment.replace(/[^\n]/g, " "),
	);
}
