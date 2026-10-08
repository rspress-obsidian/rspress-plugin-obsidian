# Tasks

The notes in this folder use the
[Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks): tasks
with due dates, priorities, recurrence and dependencies, and ` ```tasks `
blocks that collect them from the whole vault. The published site runs every
query when it is built, so each block below lists the same tasks Obsidian's
reading view shows.

- [[Launch Plan]]: tasks in Tasks' emoji format, under headings.
- [[Dataview Format]]: the same fields written as Dataview inline fields.
- [[Statuses]]: custom statuses from this vault's Tasks settings.
- [[Dependencies]]: tasks that wait for other tasks.
- [[Query Gallery]]: filters, sorting, grouping, layout and `explain`.

## Open tasks in this folder

```tasks
folder includes {{query.file.folder}}
not done
group by filename
sort by priority
```

## Due soon

```tasks
folder includes {{query.file.folder}}
not done
due before in two weeks
sort by due
short mode
```
