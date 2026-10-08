# Query Gallery

Each block below is a Tasks query over this folder. `preset demo_open` is
defined in this vault's Tasks settings as `folder includes Plugins/Tasks/` and
`not done`.

## Boolean filters

```tasks
preset demo_open
(priority is above medium) OR (tag includes #marketing)
```

## Grouped by due date, most urgent first

```tasks
preset demo_open
has due date
group by due
sort by urgency
show urgency
```

## A tree of sub-tasks

```tasks
preset demo_open
path includes Launch Plan
heading includes launch day
show tree
```

## Fewer fields

```tasks
preset demo_open
limit 3
preset hide_date_fields
hide priority
hide backlinks
```

## Recently finished

```tasks
folder includes Plugins/Tasks/
done in or after 2026-10-01
group by status.name
```

## Explained

```tasks
not done
due before next month
(tag includes #docs) OR (path includes Dataview)
explain
```
