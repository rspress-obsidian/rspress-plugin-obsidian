# Statuses

This vault's Tasks settings (`.obsidian/plugins/obsidian-tasks-plugin/data.json`)
add custom statuses next to Todo and Done. Each task here keeps its status
character in `data-task` and its status name and type in
`data-task-status-name` / `data-task-status-type`, as in Obsidian.

- [ ] Todo: an open task
- [/] In Progress: half done
- [?] Question: waiting for an answer (type `ON_HOLD`)
- [!] Important: still open (type `TODO`)
- [>] Forwarded: handed on, so it counts as done (type `NON_TASK`)
- [x] Done: finished ✅ 2026-10-03
- [-] Cancelled: dropped ❌ 2026-10-04

## Grouped by status type

```tasks
path includes {{query.file.path}}
group by status.type
sort by status.name
```

## Only the open ones

```tasks
path includes {{query.file.path}}
not done
hide backlinks
```
