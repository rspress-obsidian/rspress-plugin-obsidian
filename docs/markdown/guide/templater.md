---
description: Templater templates applied to new notes and dynamic commands, run when the site is built.
---

# Templater

The [Templater](https://silentvoid13.github.io/Templater/) plugin fills notes
from templates written with `<% … %>` commands. In Obsidian a template runs at
one moment: when a note is created from it. A published site has exactly three
such moments, and with `enableTemplater` it runs Templater at each of them:

- an empty **daily note** filled from the daily-notes template;
- an empty note matched by a **folder template** or a **file regex template**;
- a **dynamic command** `<%+ … %>`, which Templater runs whenever the note is
  shown in reading view.

```ts
markdown({
  vaultRoot: "./vault",
  enableTemplater: true,
  enableDailyNotes: true,
  dailyNotes: { folder: "Daily", template: "Templates/Daily" },
  templater: { now: "2026-10-08" },
});
```

## The templates folder

Templater's *Template folder location* (`templates_folder`) holds raw
templates. They are never published: the folder is left out of the content
index, so it gets no page and no search entry, the way Obsidian never shows a
template as a note of its own. The user scripts folder
(`user_scripts_folder`) is left out too. A template can still be included
with `tp.file.include("[[Header]]")`: the site reads it from disk.

## Templates applied to new notes

**Daily notes.** When the daily-notes stage fills an empty daily note, the
core tokens (`{{date}}`, `{{title}}`, …) are expanded first, then Templater
runs over the result, as it does after the core plugin creates the note.

**Folder and file regex templates.** A published note whose body is empty
(frontmatter alone counts as empty) is filled from the template its rule
names, as Templater does when the note is created:

- folder templates (`folder_templates`): the deepest folder with a rule wins,
  and `/` matches every note;
- file regex templates (`file_templates`): tried top to bottom against the
  note's vault path; the first match wins.

Daily notes are left to the daily-notes stage. A note with any text of its
own is never touched; neither is a note under *Excluded folders*
(`ignore_folders_on_creation`). The template's own frontmatter becomes the
note's properties in Obsidian; here it is not rendered into the page.

All of this happens only when *Trigger Templater on new file creation*
(`trigger_on_file_creation`) is on.

## Commands in published notes

A note that was not created from a template shows its commands as written,
exactly as Obsidian's reading view does, and each one is reported, so a
template that was never applied is noticed:

```markdown
Made <% tp.date.now() %>          ← shown as written, with a warning
Updated <%+ tp.file.last_modified_date() %>   ← runs when the page is built
```

A dynamic command runs in the reading view, so it runs at build time. Its
output is text (Templater writes it into the page's text, not as markdown).
Commands in code blocks, inline code and link text are never read.

`templater.renderCommands: "all"` evaluates every command of a published note,
as if Templater's *Replace templates in the active file* had run over it,
including `<%* if … %>` blocks that span paragraphs.

## The template language

Templates are interpreted by a JavaScript subset, never run as JavaScript:
`const`/`let`, assignment, `++`/`--`, `if`/`else`, `for (… of …)` (with
`[key, value]` destructuring), arrow functions, template and regex literals,
`await`, the ternary and the usual operators, and the common methods of
strings, arrays, numbers, dates, `Math`, `JSON`, `Object` and `moment`.
Obsidian's array helpers `contains`, `first`, `last` and `unique` work too.
There is no `eval`, `Function`, `import()`, `require`, `process`,
`globalThis` or prototype access (`constructor`, `__proto__`): a template
reaches only `tp`, `moment` and those helpers.

| Syntax | Meaning |
|---|---|
| `<% expr %>` | Writes the expression's value. |
| `<%* statements %>` | Runs statements; writes through `tR` (`tR += "…"`, `tR = ""`). |
| `<%+ … %>` | Dynamic: runs when the note is shown. |
| `<%-` / `-%>` | Removes one line break before / after the command. |
| `<%_` / `_%>` | Removes all whitespace before / after the command. |

A block opened in one command can close in a later one, as in Templater. A
command ends at the first `%>`, even inside a string.

## The `tp` object

| Module | Supported |
|---|---|
| `tp.date` | `now(format, offset, reference, reference_format)` with an offset in days or as an ISO 8601 duration (`"P-1M"`), `tomorrow`, `yesterday`, `weekday` |
| `tp.file` | `title`, `content`, `tags`, `creation_date`, `last_modified_date`, `folder`, `path`, `exists`, `find_tfile`, `include("[[Note#Heading]]")` (also `#^block`; included commands run, ten levels deep at most), `selection` (empty), `cursor` (removed) |
| `tp.frontmatter` | Every property of the note: `tp.frontmatter.status`, `tp.frontmatter["due date"]` |
| `tp.config` | `target_file`, `template_file`, `run_mode`, `active_file` |
| `tp.hooks` | `on_all_templates_executed` callbacks run once the template is expanded |
| `moment` | `moment()`, `moment(text, format)`, `format`, `add`, `subtract`, `startOf`, `endOf`, `weekday`, `diff`, `isBefore`, … |

Dates use moment's formats and its default locale (weeks start on Sunday). Set
`templater.now` to pin the date every `tp.date` call, `moment()` and
`new Date()` see, so a build is the same on every run.

## Limits

A static build has no editor, no person to answer a prompt, and must give the
same page on every run. What needs those renders its closest static value and
is reported as a warning:

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
| `tp.app`, `tp.obsidian`, `app` | Obsidian's live API does not exist on a site: an error in place. |
| `Math.random()` | Refused: a page must not change between builds. An error in place. |

A command that fails — unsupported syntax, an unknown function, a missing
include — is replaced by an inline `templater-error` marker naming the
problem, and reported through `onPluginError`. The rest of the note renders.

Templater's own dynamic commands are evaluated when a template is applied
(where their `+` is read as a unary plus); the site keeps them for the reading
view instead, which is what they are written for.

## Settings

The vault's `.obsidian/plugins/templater-obsidian/data.json` is read, in
either of Templater's settings layouts. Templater 2.x keeps *Trigger on new
file creation* and *Enable system commands* in the device's local storage,
outside the vault: the site then takes trigger-on-creation as on and system
commands as off. Options set in `templater` win over the vault.

| Option | Setting | Default |
|---|---|---|
| `readVaultSettings` | — | `true` |
| `templatesFolder` | `templates_folder` | none |
| `triggerOnFileCreation` | `trigger_on_file_creation` | `true` |
| `folderTemplates` | `folder_templates` (with *Folder templates* matching) | none |
| `fileTemplates` | `file_templates` (with *File regex templates* matching) | none |
| `ignoreFolders` | `ignore_folders_on_creation` | none |
| `userScriptsFolder` | `user_scripts_folder` | none |
| `renderCommands` | — | `"dynamic"` |
| `now` | — | the build time |
