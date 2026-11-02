# AGENTS.md

Guidance for agents working in this repository. Keep it short and specific.

## Git staging

**Never run `git add -A`, `git add .`, or `git commit -a`.**

This checkout lives under `~/.dsh/profiles/web/bundles/`, where the working directory also collects
local artifacts that do not belong in a commit: `.idea/`, editor and OS files, scratch copies, and
future tool output yet to be ignored. An indiscriminate add has already swept `.idea/` into a commit
(cleaned up in `4b18e8f`); ignore rules do not make `-A` safe, because a new artifact is not ignored
until someone edits `.gitignore`.

Stage the files you actually changed, by path:

```sh
git add index.js test/stream.test.mjs
git diff --cached --stat    # review every path before committing
git commit
```

## Tests

The suite is standalone — no `npm install`, no dsh checkout required:

```sh
npm test
```

CI runs it on Node 24 and 26, and validates `package.json` and `locale/en.json` as JSON. Keep the
suite passing before committing.

## Commits

Conventional-commit subjects, matching the existing history: `fix:`, `feat:`, `ci:`, `chore:`,
`test:`, `docs:`. Explain the behavior change and the evidence in the body; do not describe the
staging steps.

## Running inside a profile

The bundle is linked into the `web` profile. Host-side `index.js` changes are **not** hot-reloaded:
restart the DSH host to load a change. Bump `version` in `package.json` when behavior changes.
