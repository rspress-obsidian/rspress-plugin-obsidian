# <% tp.date.now("dddd D MMMM YYYY", 0, tp.file.title, "YYYY-MM-DD") %>

Back to [[Templater]] · a day after <% tp.date.now("D MMMM", -1, tp.file.title, "YYYY-MM-DD") %>

> [!tip] Week <% moment(tp.file.title, "YYYY-MM-DD").format("w") %>
> The week’s Monday is <% tp.date.weekday("D MMMM", 1, tp.file.title, "YYYY-MM-DD") %>.

<%* if (moment(tp.file.title, "YYYY-MM-DD").day() === 0) { -%>
Sunday: plan the week ahead.
<%* } else { -%>
A working day.
<%* } -%>

<% tp.file.include("[[Partials/Signature]]") %>
