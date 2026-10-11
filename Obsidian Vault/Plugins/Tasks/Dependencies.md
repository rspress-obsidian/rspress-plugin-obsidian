# Dependencies

A task with 🆔 can be waited on: another task lists that id after ⛔. While the
first task is open, the second is blocked.

- [ ] Choose the hosting provider 🆔 host
- [ ] Set up the DNS records ⛔ host 🆔 dns
- [ ] Turn on HTTPS ⛔ dns
- [x] Buy the domain 🆔 domain ✅ 2026-10-01
- [ ] Point the domain at the site ⛔ domain

## Blocked

```tasks
path includes {{query.file.path}}
is blocked
```

## Ready to start

```tasks
path includes {{query.file.path}}
not done
is not blocked
```

## Blocking others

```tasks
path includes {{query.file.path}}
is blocking
```
