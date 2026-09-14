# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release of `rspress-plugin-obsidian` — unified Obsidian publishing suite for Rspress
- **Markdown plugin** (`rspress-plugin-obsidian-wikilink`): wikilinks, aliases, embeds, callouts (with fold state), backlinks, transclusion (page/heading/block/inline), tags (nested, unicode), Dataview (inline fields, queries, JS), daily notes (templates, navigation), media embeds, footnotes, highlights, comments
- **Canvas plugin** (`rspress-plugin-obsidian-canvas`): `.canvas` parser, React renderer with pan/zoom, edges, groups, background styles, mermaid support, editor mode
- **Graph plugin** (`rspress-plugin-graph-view`): build-time link extraction, runtime force-directed graph (GraphPanel + GraphSidebar), theme-aware colors, disk-cached build
- Vault sync watcher script for live development
- Comprehensive test suite: 445 unit tests + Playwright e2e tests
- Type-safe public API with granular subpath exports

[Unreleased]: https://github.com/Jacob-Valor/rspress-plugin-obsidian/releases
