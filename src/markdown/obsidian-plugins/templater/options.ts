/** A folder template: an empty new note in `folder` (or below it) is filled from `template`. */
export interface TemplaterFolderTemplate {
	/** Vault-relative folder; `/` matches every note. */
	folder: string;
	/** Vault-relative template path, such as `Templates/Meeting.md`. */
	template: string;
}

/** A file regex template: an empty new note whose vault path matches `regex` is filled from `template`. */
export interface TemplaterFileTemplate {
	/** A JavaScript regular expression, tested against the note's vault-relative path. */
	regex: string;
	template: string;
}

/** Options for the Templater feature (`enableTemplater`). */
export interface TemplaterOptions {
	/**
	 * Read the vault's Templater settings
	 * (`.obsidian/plugins/templater-obsidian/data.json`). An option set here wins
	 * over the vault's setting. Default: `true`.
	 */
	readVaultSettings?: boolean;
	/**
	 * The folder holding raw templates (Templater's "Template folder
	 * location", `templates_folder`). It is never indexed or published.
	 * Relative to the vault, or to the docs root without a vault.
	 */
	templatesFolder?: string;
	/**
	 * Run Templater over a template applied to a new note: the daily-note
	 * template, folder templates and file regex templates
	 * (`trigger_on_file_creation`). Default: the vault's setting, else `true`.
	 */
	triggerOnFileCreation?: boolean;
	/**
	 * Folder templates (`folder_templates`), applied to an empty published
	 * note; the deepest matching folder wins. Setting this turns folder
	 * templates on, whatever the vault's matching mode.
	 */
	folderTemplates?: TemplaterFolderTemplate[];
	/**
	 * File regex templates (`file_templates`), tried top to bottom after the
	 * folder templates. Setting this turns them on.
	 */
	fileTemplates?: TemplaterFileTemplate[];
	/**
	 * Folders whose new notes never trigger Templater
	 * (`ignore_folders_on_creation`). Vault-relative.
	 */
	ignoreFolders?: string[];
	/**
	 * The user scripts folder (`user_scripts_folder`). Its scripts never run
	 * on a static site; the folder is kept out of the site.
	 */
	userScriptsFolder?: string;
	/**
	 * Which commands a published note evaluates. `"dynamic"`: only `<%+ … %>`,
	 * as Obsidian's reading view does; `<% %>` and `<%* %>` stay as written
	 * and are reported. `"all"`: every command, as if Templater's "Replace
	 * templates in the active file" had run on each note. Default: `"dynamic"`.
	 */
	renderCommands?: "dynamic" | "all";
	/**
	 * The clock `tp.date`, `moment()` and `new Date()` read. Pin it (a `Date`
	 * or `YYYY-MM-DD[THH:mm[:ss]]`) for reproducible builds. Default: the build time.
	 */
	now?: Date | string;
}
