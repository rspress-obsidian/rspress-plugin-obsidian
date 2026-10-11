---
type: meeting
---
<%* const attendees = ["Ana", "Ben", "Chloé"] -%>
## <% tp.file.title %>

- Date: <% tp.date.now("dddd D MMMM YYYY") %>
- Status: <% tp.frontmatter.status ?? "planned" %>
- Agenda: <% await tp.system.prompt("Agenda?", "status updates") %>

### Attendees

<%* for (const name of attendees) { -%>
- [ ] <% name %>
<%* } -%>

### Notes

<% tp.file.include("[[Partials/Signature]]") %>
