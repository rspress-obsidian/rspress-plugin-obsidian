# Templater

The [Templater plugin](https://silentvoid13.github.io/Templater/) fills new notes from templates written with `<% … %>` commands. This vault keeps its templates in `Templates/`, which Templater's settings name as the templates folder, so the site never publishes them, exactly as they never show up as notes of their own.

## Notes created from a template

The notes below are empty files on disk. Templater's folder templates (`.obsidian/plugins/templater-obsidian/data.json`) say that a new note in `Meetings/` is filled from `Templates/Meeting.md`, and one in `Journal/` from `Templates/Journal.md`. The site fills each the way Obsidian did when the note was created:

- [[Weekly sync]]: a meeting note, reading its own `status` property, looping over attendees and including a partial template.
- [[Retrospective]]: the same template, with no `status` set.
- [[2026-10-05]] and [[2026-10-04]]: journal pages whose dates come from the note's title, with a branch for Sundays.

## Commands in a published note

A note that is not new keeps its commands as written, as in Obsidian's reading view: `<% tp.date.now() %>` only runs when a template is applied. A dynamic command, `<%+ … %>`, runs when the note is shown:

- This note is called <%+ tp.file.title %>, in the folder <%+ tp.file.folder(true) %>.
- It has the tags <%+ tp.file.tags.join(", ") %>.
- A week from the build date is <%+ tp.date.now("dddd D MMMM", 7) %>.
- The first line of this note's second section is: <%+ tp.file.include("[[Templater#Notes created from a template]]").split("\n")[0] %>

#plugins/templater

## The template language

A template is markdown with commands in it:

```markdown
<%* const attendees = ["Ana", "Ben"] -%>
## <% tp.file.title %>

<%* for (const name of attendees) { -%>
- [ ] <% name %>
<%* } -%>
```

- `<% expression %>` writes the value of a JavaScript expression.
- `<%* statements %>` runs JavaScript; it writes nothing unless it appends to `tR`.
- `<%-` / `-%>` remove one line break before / after the command; `<%_` / `_%>` remove all whitespace.
