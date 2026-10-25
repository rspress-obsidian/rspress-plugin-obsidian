---
title: Templater
description: Run Templater templates on empty daily, folder and regex-matched notes and render dynamic commands when the site is built, without publishing the templates folder.
---

# Templater

The [Templater](https://silentvoid13.github.io/Templater/) plugin fills notes
from templates written with `<% … %>` commands. In Obsidian a template runs
when a note is created from it. A published site has three such moments, and
with `enableTemplater` the site runs Templater at each of them:

- an empty **daily note** filled from the daily-notes template;
- an empty note matched by a **folder template** or a **file regex template**;
- a **dynamic command** `<%+ … %>`, which Templater runs whenever the note is
  shown in reading view.

A build has no editor, no person to answer a prompt, and must give the same
page on every run; [Limitations](#limitations) lists what that rules out, and
the [compatibility table](/obsidian-compatibility#plugin-ecosystem) sums it up.
The demo vault's [Templater](/vault/Plugins/Templater/Templater) note shows
folder templates and dynamic commands rendered.

## Enable it

```ts
markdown({
  vaultRoot: "./vault",
  enableTemplater: true,
  enableDailyNotes: true,
  dailyNotes: { folder: "Daily", template: "Templates/Daily" },
  templater: { now: "2026-10-08" }, // pin the clock for a reproducible build
});
```

Templater needs no extra package. The bundled stylesheet
(`enableDefaultStyles`) only styles the error marker. `enableTemplater` and
the `templater` object are listed with every other option in the
[API reference](./api.md#obsidian-plugins); the keys of `templater` are documented
[below](#options).

## Options

The vault's `.obsidian/plugins/templater-obsidian/data.json` is read, in either
of Templater's settings layouts, and a key set in `templater` wins over it.
Templater 2.x keeps *Trigger Templater on new file creation*, the
folder/file-template switches and *Enable system commands* in the device's
local storage, outside the vault: the site then takes trigger-on-creation as
on, reads the template mode from `trigger_on_file_creation_mode`, and takes
system commands as off. Only one of the vault's folder or file regex modes is
active at a time, as in Templater.

| Option | Templater setting | Default | Meaning |
|---|---|---|---|
| `templatesFolder` | `templates_folder` | none | The folder holding raw templates; never published. |
| `triggerOnFileCreation` | `trigger_on_file_creation` | `true` | Run Templater over the daily-note, folder and file regex templates. |
| `folderTemplates` | `folder_templates` | none | `{ folder, template }[]`; setting it turns folder templates on, whatever the vault's mode. |
| `fileTemplates` | `file_templates` | none | `{ regex, template }[]`; setting it turns file regex templates on. |
| `ignoreFolders` | `ignore_folders_on_creation` | none | Vault folders whose notes never trigger Templater. |
| `userScriptsFolder` | `user_scripts_folder` | none | The user scripts folder; never published, its scripts never run. |
| `renderCommands` | — | `"dynamic"` | `"dynamic"` evaluates only `<%+ %>` commands in published notes; `"all"` evaluates every command. |
| `now` | — | the build time | The clock `tp.date`, `moment()`, `new Date()` and `Date.now()` read: a `Date`, `YYYY-MM-DD`, or that with a time. |
| `readVaultSettings` | — | `true` | Read the vault's `data.json` at all. |

Folders and template paths are relative to the vault (or to the docs root
without a vault).

## Keep templates private

The templates folder holds raw templates. It is left out of the content index,
so it gets no page and no search entry, the way Obsidian never shows a
template as a note of its own. The user scripts folder is left out too. A
template can still be included with `tp.file.include("[[Header]]")`: the site
reads it from disk.

## Fill new notes from templates

**Daily notes.** With `enableDailyNotes` and a `dailyNotes.template`, the
daily-notes stage fills an empty daily note: the core tokens (`{{date}}`,
`{{title}}`, …) are expanded first, then Templater runs over the result, as it
does after the core plugin creates the note. The core tokens use the build
time, not `templater.now`.

**Folder and file regex templates.** A published note whose body is empty
(frontmatter and `%%comments%%` alone count as empty) is filled from the
template its rule names, as Templater does when the note is created:

- folder templates: the deepest folder with a rule wins, and `/` matches every
  note;
- file regex templates, tried after the folder templates, top to bottom,
  against the note's vault path (with `.md`); the first match wins.

When daily notes have a template, daily notes are left to it. A note with any
text of its own is never touched; neither is a note under an ignored folder or
the templates folder. The template's own frontmatter becomes the note's
properties in Obsidian; here it is not rendered into the page.

All of this happens only while `triggerOnFileCreation` is on.

## Commands in published notes

A note that was not created from a template shows its commands as written,
exactly as Obsidian's reading view does, and each one is reported, so a
template that was never applied is noticed:

```markdown
Made <% tp.date.now() %>          ← shown as written, with a warning
Updated <%+ tp.file.last_modified_date() %>   ← runs when the page is built
```

A dynamic command (`<%+ %>`, or `<%*+ %>` for statements) runs in reading
view, so it runs when the page is built. Its output is text: Templater writes
it into the page's text, not as markdown. Commands in code blocks, inline
code, link text and HTML are never read.

`renderCommands: "all"` evaluates every command of a published note, as if
Templater's *Replace templates in the active file* had run over it, including
`<%* if … %>` blocks that span paragraphs and commands inside code. Its output
is parsed as markdown. Kanban boards and Excalidraw drawings are skipped.

## Write templates

| Syntax | Meaning |
|---|---|
| `<% expr %>` | Writes the expression's value. |
| `<%* statements %>` | Runs statements; writes through `tR` (`tR += "…"`, `tR = ""`). |
| `<%+ … %>`, `<%*+ … %>` | Dynamic: runs when the note is shown. |
| `<%-` / `-%>` | Removes one line break before / after the command. |
| `<%_` / `_%>` | Removes all whitespace before / after the command. |

A block opened in one command can close in a later one, as in Templater. A
command ends at the first `%>`, even inside a string.

Templates are interpreted as a JavaScript subset, never run as JavaScript:
`const`/`let`, assignment to variables, `++`/`--`, `if`/`else`,
`for (… of …)` (with `[key, value]` destructuring), `return`, arrow functions,
object, array, template and regex literals, `await`, `??`, `?.`, `typeof`,
the ternary and the usual operators. The common methods of strings, arrays,
numbers and dates work, as do `Math`, `JSON`, `Object.keys`/`values`/
`entries`/`fromEntries`, `String`, `Number`, `Boolean`, `parseInt`,
`parseFloat`, `Array.isArray`, `new Date(…)` and `moment`, plus Obsidian's
array helpers `contains`, `first`, `last` and `unique`.

Not available: `while`, `switch`, classic `for (;;)`, `function`, `class`,
`try`/`throw`, `var`, assignment to properties, and `eval`, `Function`,
`import()`, `require`, `process`, `globalThis`, `fetch`, `window` or prototype
access (`constructor`, `__proto__`). A template reaches only `tp`, `moment`
and the built-ins above.

### The `tp` object

| Module | Supported |
|---|---|
| `tp.date` | `now(format, offset, reference, reference_format)` with an offset in days or as an ISO 8601 duration (`"P-1M"`), `tomorrow`, `yesterday`, `weekday`; formats default to `YYYY-MM-DD` |
| `tp.file` | `title`, `content`, `tags`, `creation_date`, `last_modified_date`, `folder(absolute)`, `path(relative)`, `exists`, `find_tfile`, `include("[[Note#Heading]]")` (also `#^block` or a file object; included commands run, ten levels deep at most), `selection` (empty), `cursor` (removed) |
| `tp.frontmatter` | Every property of the note: `tp.frontmatter.status`, `tp.frontmatter["due date"]` |
| `tp.config` | `target_file`, `template_file`, `run_mode`, `active_file` |
| `tp.hooks` | `on_all_templates_executed` callbacks run once the template is expanded |
| `moment` | `moment()`, `moment(text, format)`, `format`, `add`, `subtract`, `startOf`, `endOf`, `weekday`, `diff`, `isBefore`, `isAfter`, `isSame`, the date-part getters and setters, … |

File objects (`tp.config.target_file`, `find_tfile`) have `path`, `name`,
`basename`, `extension`, `stat` and `parent`. `tp.file.include` looks for a
published note first, then a path from the vault root or the templates folder.

Dates use moment's formats and its default locale (weeks start on Sunday). Set
`templater.now` so every `tp.date` call, `moment()` and `new Date()` give the
same page on every build.

## Output and styling

A command's output is text in the page. A failed command is replaced by an
inline `templater-error` marker naming the problem, which the bundled
stylesheet (`enableDefaultStyles`) colours as an error.

## Errors

A failing command (an unknown function, a missing include, `tp.app`,
`Math.random()`) is replaced by its `templater-error` marker and the rest of
the note renders. A syntax error in a `<%* %>` command, an unclosed `<%`, or a
template that runs past its step budget stops the whole template, which
renders as one marker. A folder or regex rule naming a template that does not
exist replaces the note with a "Couldn't find template" marker. All of these
are reported through [`onPluginError`](./api.md#diagnostics), whose default, `"error"`, fails the
build.

Warnings never fail the build: a command shown as written, an invalid
`templater.now`, and the calls in [Limitations](#limitations).

## Limitations

What needs an editor, a person or the network renders its closest static
value:

| Call | On the site |
|---|---|
| `tp.system.prompt(text, default)` | The default value; empty, with a warning, when there is none. |
| `tp.system.suggester(…)` / `multi_suggester(…)` | The default value, else the first item / the default values; a warning. |
| `tp.system.clipboard()` | Empty; a warning. |
| `tp.file.cursor_append(…)` | Nothing is inserted; a warning. |
| `tp.file.create_new` | Skipped (the vault is never changed), but returns the file it would have created, so `[[<% (await tp.file.create_new(…)).basename %>]]` writes the same link Obsidian would; a warning. |
| `tp.file.move`, `rename`, `delete` | Skipped (the vault is never changed); a warning. |
| `tp.web.daily_quote`, `random_picture`, `request` | Empty: the network stays off, so builds work offline and give the same page every time; a warning. |
| `tp.user.*` | User scripts are arbitrary JavaScript and system commands are shell commands; neither runs during a build. Empty; a warning. |
| `tp.app`, `tp.obsidian`, `app` | Obsidian's live API does not exist on a site: an error. |
| `Math.random()` | Refused, since a page must not change between builds: an error in place. |

Templater's own dynamic commands are evaluated when a template is applied
(where their `+` is read as a unary plus); the site keeps them for the reading
view instead, which is what they are written for.
