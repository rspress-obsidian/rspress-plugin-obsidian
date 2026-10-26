/**
 * Class names for Mermaid diagram placeholders and their render states.
 *
 * Kept in a leaf module with no imports: the emitters (markdown notes, canvas
 * text nodes) and the client renderer must agree on these strings, and pulling
 * them from the renderer itself would drag `mermaid` into every bundle that
 * emits a placeholder.
 */
export const MERMAID_BLOCK_CLASS = "obsidian-mermaid-block";
export const MERMAID_RENDERED_CLASS = "obsidian-mermaid-rendered";
export const MERMAID_ERROR_CLASS = "obsidian-mermaid-error";
/** Marks a placeholder left as source because `mermaid` is not installed. */
export const MERMAID_UNAVAILABLE_ATTRIBUTE = "data-mermaid-unavailable";

/**
 * Shown (console and placeholder title) when a page has diagrams but the site
 * was built without the optional `mermaid` peer dependency.
 */
export const MERMAID_INSTALL_HINT =
	"Mermaid diagrams need the optional peer dependency `mermaid`: install it next to rspress-plugin-obsidian (`npm install mermaid`) and rebuild the site.";

/**
 * Mermaid's `securityLevel` setting, passed through to `mermaid.initialize`.
 *
 * `strict` (the default) runs mermaid's own sanitising pass over the
 * serialized SVG, which also strips unsafe link URLs; the looser levels allow
 * markup and handlers a strict build refuses.
 */
export type MermaidSecurityLevel = "strict" | "loose" | "antiscript" | "sandbox";

/**
 * Attribute carrying the configured security level on a placeholder.
 *
 * Each diagram renders at its own placeholder's level (unstamped or unknown:
 * `strict`), so a page that configured a looser level never hands it to a
 * diagram that did not ask for it. Reading it per block means the level is known
 * before the render starts, with no ordering dependency on when the client
 * component mounts.
 */
export const MERMAID_SECURITY_ATTRIBUTE = "data-security";

/**
 * Marks a container whose diagrams always render at `strict`, whatever their
 * placeholders stamp. Canvas boards carry it: their text comes from canvas files,
 * not from the site configuration that chooses a looser level for notes.
 */
export const MERMAID_STRICT_SCOPE_ATTRIBUTE = "data-mermaid-strict";
