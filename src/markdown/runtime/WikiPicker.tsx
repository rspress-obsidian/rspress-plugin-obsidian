import { useMemo, useState } from "react";
import type { WikiLinkCandidate } from "../types.js";

/**
 * Inline picker for an ambiguous vault search (`[[##query]]`, `[[^^query]]`).
 *
 * Obsidian opens a list of matches when a vault search finds more than one
 * target, and the reader picks the one they meant. A static build cannot open a
 * modal, so the matches are resolved while compiling and rendered here: a
 * button that expands a list of real links, filterable by typing.
 *
 * The candidates arrive as a JSON string because they are written into the MDX
 * attribute by the remark pass; a malformed value degrades to plain text rather
 * than breaking the page.
 */
interface WikiPickerProps {
	/** JSON array of `{ href, label, pageLabel, description? }` entries. */
	candidates: string;
	/** The query the reader typed, shown as the button's text. */
	query?: string;
	/** Link text when the link carried an alias. */
	alias?: string;
}

const CANDIDATE_LIMIT = 50;

function parseCandidates(value: string): WikiLinkCandidate[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is WikiLinkCandidate =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as WikiLinkCandidate).href === "string" &&
				typeof (entry as WikiLinkCandidate).label === "string",
		);
	} catch {
		return [];
	}
}

export default function WikiPicker({ candidates, query, alias }: WikiPickerProps) {
	const matches = useMemo(() => parseCandidates(candidates), [candidates]);
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");

	if (matches.length === 0) {
		// Nothing usable was serialized; show the source so the link is not lost.
		return <>{alias ?? query ?? ""}</>;
	}

	const needle = filter.trim().toLowerCase();
	const visible = (
		needle
			? matches.filter(
					(candidate) =>
						candidate.label.toLowerCase().includes(needle) ||
						candidate.pageLabel.toLowerCase().includes(needle),
				)
			: matches
	).slice(0, CANDIDATE_LIMIT);

	const buttonText =
		alias ?? (query ? `${matches.length} matches for ${query}` : `${matches.length} results`);

	return (
		<span className="rp-wiki-picker" data-open={isOpen ? "true" : "false"}>
			<button
				type="button"
				className="rp-wiki-picker-trigger"
				aria-expanded={isOpen}
				aria-label={`${buttonText} — choose a target`}
				onClick={() => setIsOpen((open) => !open)}
			>
				{buttonText}
			</button>
			{isOpen ? (
				<span className="rp-wiki-picker-panel" role="group" aria-label="Search results">
					<span className="rp-wiki-picker-filter">
						<input
							type="search"
							value={filter}
							placeholder="Filter results…"
							aria-label="Filter search results"
							onChange={(event) => setFilter(event.target.value)}
						/>
					</span>
					<ul className="rp-wiki-picker-list">
						{visible.map((candidate) => (
							<li key={candidate.href}>
								<a href={candidate.href} title={candidate.description}>
									<span className="rp-wiki-picker-label">{candidate.label}</span>
									<span className="rp-wiki-picker-page">{candidate.pageLabel}</span>
								</a>
							</li>
						))}
						{visible.length === 0 ? <li className="rp-wiki-picker-empty">No match</li> : null}
					</ul>
				</span>
			) : null}
		</span>
	);
}
