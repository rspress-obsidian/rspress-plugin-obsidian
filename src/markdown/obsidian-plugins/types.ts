/**
 * The contract between the markdown pipeline and the Obsidian community
 * plugins it reproduces (Tasks, Kanban, Excalidraw, Bases, Templater).
 *
 * Each plugin is one {@link ObsidianPluginFeature} under
 * `src/markdown/obsidian-plugins/<id>/`. The pipeline calls its hooks at fixed
 * points — a whole note, a fenced block, an embed, a template, the page list —
 * and hands it a {@link PluginRenderContext} that renders markdown through
 * every stage the page itself goes through, so a link inside a Kanban card or
 * a Tasks result resolves, and a tag links, exactly as it would in a note.
 */
import type { RspressPlugin } from "@rspress/core";
import type { Code, PhrasingContent, Root, RootContent } from "mdast";
import type { VFile } from "vfile";
import type {
	ContentIndex,
	ContentPage,
	NormalizedPluginOptions,
	ParsedWikiLink,
	ResolveContext,
	ResolvedWikiLink,
	RspressPluginMarkdownOptions,
} from "../types.js";

export type BuilderConfig = NonNullable<RspressPlugin["builderConfig"]>;

/** Identifier of a reproduced Obsidian plugin; also its diagnostic scope. */
export type ObsidianPluginId = "tasks" | "kanban" | "excalidraw" | "bases" | "templater";

/** What a feature may use while a note is being rendered. */
export interface PluginRenderContext {
	file: VFile;
	options: NormalizedPluginOptions;
	/** The note being rendered: the compiled page, or a note embedded in it. */
	currentPage: ContentPage;
	/** The content index `currentPage` belongs to (docs or vault). */
	index: ContentIndex;
	/** Root of the tree `currentPage` belongs to (the docs root or the vault). */
	docsRoot: string;
	/** The site's Rspress `base`, always `/…/`. */
	siteBase: string;
	/** `page`: the compiled file. `embed`: a transcluded note, or markdown a feature renders. */
	mode: "page" | "embed";
	/** The tree is a whole note — a compiled page, or an embed with no `#subpath`. */
	wholeNote: boolean;
	/** The markdown the tree was parsed from, with `%%comments%%` blanked (same offsets). */
	source: string;
	/**
	 * Prefix for every id the document emits: `""` on the compiled page, a
	 * unique namespace inside an embed, so a transcluded note's anchors never
	 * collide with the host's.
	 */
	idPrefix: string;
	/** Render one line of markdown to inline HTML through every stage, as text of `page`. */
	renderInline(markdown: string, page?: ContentPage): Promise<string>;
	/** Render block markdown to HTML through every stage, as if it were part of `page`. */
	renderBlock(markdown: string, page?: ContentPage): Promise<string>;
	/** Resolve a wikilink written in `page` (default: `currentPage`), across docs and vault. */
	resolve(parsed: ParsedWikiLink, page?: ContentPage): Promise<ResolvedWikiLink>;
	/** The content index any file belongs to. */
	indexFor(absolutePath: string): Promise<ContentIndex>;
	/** Every published index (docs, then the vault): what a site-wide query reads. */
	publishedIndexes(): Promise<readonly ContentIndex[]>;
	/**
	 * Report a diagnostic under the feature's scope. Without `mode` it follows
	 * `onPluginError` (`"error"` fails the build); `"warn"` never fails.
	 */
	report(message: string, mode?: "warn" | "fail"): void;
}

/** What a feature may use while the page list is assembled. */
export interface PluginBuildContext {
	options: NormalizedPluginOptions;
	/** Absolute docs root (`config.root`). */
	docsRoot: string;
	/** Absolute vault root, when a vault is published. */
	vaultRoot?: string;
	vaultRoutePrefix: string;
	/** The site's Rspress `base`, always `/…/`. */
	siteBase: string;
	docs: ContentIndex;
	vault?: ContentIndex;
	resolveOptions: NonNullable<ResolveContext["options"]>;
}

/** A page a feature publishes through Rspress's `addPages`. */
export interface PluginPage {
	routePath: string;
	/** MDX source of the page; compiled through the same remark pass as notes. */
	content?: string;
	/** Or an existing file to compile at `routePath`. */
	filepath?: string;
}

type PageDataHook = NonNullable<RspressPlugin["extendPageData"]>;
type SearchIndexHook = NonNullable<RspressPlugin["modifySearchIndexData"]>;

export interface ObsidianPluginFeature {
	id: ObsidianPluginId;
	/** The plugin's name, as Obsidian users know it. */
	label: string;
	/** The option that turns the feature on, named in diagnostics. */
	enableOption: keyof RspressPluginMarkdownOptions;
	isEnabled(options: NormalizedPluginOptions): boolean;
	/** Fence languages (lowercase) the feature renders. */
	fences?: readonly string[];
	/** Replace a fenced block; `undefined` leaves it as code. */
	renderFence?(node: Code, ctx: PluginRenderContext): Promise<RootContent[] | undefined>;
	/**
	 * Replace a whole note's content (a Kanban board, an Excalidraw drawing).
	 * Called first, before any other stage; `undefined` when the note is not
	 * the feature's.
	 */
	renderNote?(tree: Root, ctx: PluginRenderContext): Promise<RootContent[] | undefined>;
	/** Rewrite the tree in place once `%%comments%%` are gone, before fences render. */
	transformTree?(tree: Root, ctx: PluginRenderContext): Promise<void>;
	/** Render `![[target]]`; `undefined` falls through to the built-in embeds. */
	renderEmbed?(
		parsed: ParsedWikiLink,
		ctx: PluginRenderContext,
	): Promise<PhrasingContent | undefined>;
	/**
	 * Expand a template being applied to a new note (the daily-notes template),
	 * after the core `{{date}}`/`{{title}}` tokens — the order Obsidian runs them.
	 */
	expandTemplate?(template: string, ctx: PluginRenderContext): Promise<string>;
	/**
	 * Pages to publish. Runs before any note compiles and before attachments
	 * are staged, so it is also where a feature registers its file routes
	 * (`setPublishedFileRoutes`).
	 */
	addPages?(ctx: PluginBuildContext): Promise<PluginPage[]>;
	/**
	 * Folders (relative to the vault, or to the docs root when there is no
	 * vault) whose files are never indexed or published.
	 */
	excludedFolders?(options: NormalizedPluginOptions): string[];
	/** Client components rendered on every page (DOM enhancers, like Mermaid's). */
	globalUIComponents?(): string[];
	/** Components the remark output references by name as JSX. */
	globalComponents?(): string[];
	/** Rsbuild config the feature needs (aliases, extra public directories). */
	builderConfig?(options: NormalizedPluginOptions): BuilderConfig;
	extendPageData?: PageDataHook;
	modifySearchIndexData?: SearchIndexHook;
}
