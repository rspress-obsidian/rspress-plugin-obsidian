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
 * Mermaid's configuration is global, so one stamped value configures every
 * diagram on the page. Reading it at scan time means the level is known
 * before the first render starts, with no ordering dependency on when the
 * client component mounts.
 */
export const MERMAID_SECURITY_ATTRIBUTE = "data-security";
