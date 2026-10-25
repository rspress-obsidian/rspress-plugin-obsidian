## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran and what you saw. For rendering changes, a before/after screenshot. -->

## Checklist

- [ ] Commit messages are [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `perf:`, …): semantic-release picks the version from them
- [ ] `bun run lint`, `bun run typecheck` and `bun test` pass
- [ ] A behavior change has a test that fails without it
- [ ] User-facing options or output are reflected in `docs/` (and `docs/obsidian-compatibility.md` if support changed)
