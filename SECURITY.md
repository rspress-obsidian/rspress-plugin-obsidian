# Security policy

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/rspress-obsidian/rspress-plugin-obsidian/security/advisories/new).
Please do not open a public issue for a vulnerability. Include the plugin
version, the configuration and a minimal note, board or vault that reproduces
it.

## Supported versions

Only the latest release receives security fixes.

## Trust model

The vault is trusted input. Notes go through the same Markdown pipeline as any
Rspress docs page, so raw HTML in a note reaches the published page as HTML,
and anything that can write to the vault can write to the published site. That
is not a vulnerability in this plugin.

In scope: output the plugin builds itself that lets content do more than the
same content could as an Rspress docs page, such as script running from a
canvas card or a Mermaid diagram in a canvas, an unsafe URL scheme surviving
into a link or frame, or an embed loading another site's content in an
unsandboxed frame. See
[Vault content is trusted input](./README.md#vault-content-is-trusted-input).

Also in scope: content the plugin promises to keep off the site reaching the
build output (pages, search index, page outline, graph data, canvas board data
or copied files), since a leak there publishes what the vault owner kept
private. That covers a note with `publish: false` and the attachments only such
notes use; dotfiles, dot-folders and `_`-prefixed paths; folders the plugin
leaves out of the content index, such as the Templater templates folder;
`%%comments%%`; `<!-- comments -->` in canvas text cards and in the notes
canvas file cards show; and the text, path and subpath of the private file a
canvas file card names. Report such a leak privately, as above. See
[Security](./docs/markdown/guide/advanced.md#security).
