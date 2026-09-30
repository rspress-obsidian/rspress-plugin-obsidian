/**
 * Flag each line of a document as content (`true`) or as frontmatter / inside a
 * code fence (`false`). Shared by the content index, the transclusion section
 * extractors and the comment scanner, so index-time and render-time boundary
 * detection agree.
 *
 * A leading `---` only starts frontmatter when a closing delimiter exists: a
 * document that opens with a thematic break would otherwise be treated as one
 * endless frontmatter block, which silently disables comment stripping, heading
 * extraction and tag extraction for the whole file.
 *
 * Node-free on purpose: the browser-side canvas renderer needs the same boundary
 * detection as the build-time index, and importing it from `content-index.ts`
 * would drag `node:fs` into the client bundle.
 */
export function getContentLineFlags(lines: string[]): boolean[] {
	const flags = new Array<boolean>(lines.length).fill(false);
	let inFence = false;
	let inFrontmatter =
		lines[0]?.trim() === "---" && lines.slice(1).some((line) => line.trim() === "---");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";

		if (inFrontmatter) {
			if (index > 0 && line.trim() === "---") {
				inFrontmatter = false;
			}
			continue;
		}

		if (/^(```|~~~)/.test(line.trim())) {
			inFence = !inFence;
			continue;
		}

		if (inFence) {
			continue;
		}

		flags[index] = true;
	}

	return flags;
}
