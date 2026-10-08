import { useMemo, useState } from "react";
import { useNavigateTo } from "../../shared/usePathname.js";
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
	/**
	 * The site `base` (`/…/`). Candidate hrefs are routes; the rendered href
	 * carries the base so opening a match in a new tab works, while a plain
	 * click navigates by route through the router, which adds the base itself.
	 */
	base?: string;
}

const CANDIDATE_LIMIT = 50;

function withBase(route: string, base: string): string {
	if (base === "/" || !route.startsWith("/") || route.startsWith(base)) return route;
	return `${base}${route.slice(1)}`;
}

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

export default function WikiPicker({ candidates, query, alias, base = "/" }: WikiPickerProps) {
	const matches = useMemo(() => parseCandidates(candidates), [candidates]);
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const navigateTo = useNavigateTo();

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
								<a
									href={withBase(candidate.href, base)}
									title={candidate.description}
									onClick={(event) => {
										// A plain click is a route change inside the app, like
										// Rspress's own links; modified clicks keep the browser's
										// new-tab and download behaviour.
										if (
											event.button !== 0 ||
											event.metaKey ||
											event.ctrlKey ||
											event.shiftKey ||
											event.altKey
										) {
											return;
										}
										event.preventDefault();
										setIsOpen(false);
										navigateTo(candidate.href);
									}}
								>
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
