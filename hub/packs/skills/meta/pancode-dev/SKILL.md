---
name: pancode-dev
description: "Develop PanCode inside its own repository: orient on the running build versus the workspace, trace owners, avoid the checks that fail landings, apply each edit the right way and hand the work back. Use before changing PanCode source, prompts, tools or PanHub; pair with pancode-test for validation."
triggers:
  - develop PanCode in its own repository
  - implement a PanCode sprint packet
  - change PanCode context or session lifecycle
  - edit PanCode skills tools or prompts
  - work a PanCode lane brief or spec
version: 0.7.2
license: LicenseRef-PanCode-1.0
pancode:
  registry-id: akougkas/pancode
  source-url: https://github.com/akougkas/pancode/tree/main/hub/packs/skills/meta/pancode-dev
  audit: pass
  model-size: any
---

# PanCode self-development

Use this when the task changes PanCode inside its own repository. Load
`pancode-test` when you choose checks. The lane brief, the spec and
`.pancode/rules/` outrank this skill; the repository handbook is already in
your prompt.

## Know which PanCode you are

Two trees are involved and they are usually different directories.

- The running PanCode is the build that started this session;
  `pancode --version` prints its commit. Prompt
  fragments, built-in agent recipes, tool code, bundled docs and
  `code_nav(source="pancode")` come from that root.
- The workspace is the checkout or worktree you edit. The repository handbook,
  `.pancode/rules/` and these two skills (when no installed package owns
  their names) come from the workspace.

An edit in the workspace does not change the running session except where
[references/live-edit.md](references/live-edit.md) says so. Read that table
after your first edit and before you claim a change works. Never make an edit
live by touching the running install: no build in its checkout, no
`scripts/install-local.sh`, no `pnpm run install:local`, no launcher relink.
Other sessions run from it. Build the workspace and start a separate candidate
process from the workspace's own `dist/cli/index.js`.

## Establish the assignment

Read the brief or spec fully; its acceptance criteria are the contract. Check
`git status`, the branch and `git log -1`, and confirm you are in the assigned
worktree, not the main checkout. When the brief is silent: change source,
add at most one focused regression test per defect in the nearest existing
test file, make only the inventory rows lint demands in `docs/`, and never
edit `CHANGELOG.md`. Proposed changelog lines and deferred docs go in the
handback. A spec that is wrong or unsafe as written is a question, not a
license to improvise.

## Trace before changing

Find the owner and its callers with `code_nav` or `grep`, then read the
contract, the nearest tests and the architecture page for that area. Use
[references/change-map.md](references/change-map.md) for owners and for the
seams a setting, tool, command or contract type must touch. Put policy in the
owning domain and compose at the entry seam. The hard invariants in
the repository handbook are enforced by `pnpm run lint`.

## What failed landings

- Composition root: `src/entry/orchestrator.ts` is at its line ceiling and
  may not gain module-scope functions or feature imports (rule15). Put wiring
  in the owning domain and call it from one existing line.
- Export hygiene: an `export function` whose name appears in one file fails
  lint. Remove the keyword, then `pnpm exec biome check --write <file>`.
- GUI contract: after editing `src/core/telemetry/dto.ts` or a schema module
  it imports, `src/engine/acp/types.ts` or a `types-*.ts` module beside it,
  or `apps/pancode-gui/contracts/*.ts`,
  run `pnpm --filter pancode-gui run openapi` and commit
  `apps/pancode-gui/contracts/openapi.json`. Only `test:gui` catches a
  stale file.
- Files parallel lanes collide in: `src/session-control/slash-commands.ts`,
  `src/domains/report/index.ts`, `src/interactive/interactive-application.ts`,
  `src/domains/dispatch/extension.ts`, `src/interactive/overlay-lifecycle.ts`,
  `src/entry/orchestrator.ts`. Add your entry as one hunk,
  leave neighbours unformatted and unordered as they are, and never add a
  required field to a shared entry type inside a feature commit.
- A new test file runs in no gate until `scripts/ci-tests.mjs` lists it.
- Strict types: optional properties are spread in, never assigned
  `undefined`; relative imports end in `.js`; type imports use `import type`.
- PanHub edits: bump the version in `SKILL.md` and `plugin.json`, then
  `pnpm run skills:pin` and `pnpm run hub:pin`.

## Flywheel

Report sharing is turned off in this build, so `pancode dev flywheel` has no
backlog to rank: without `--sweep` or `--forget` it prints that sharing is
off and exits 2. Choose, scope and prioritise PanCode work from the open issues
instead. A `has-bundle` issue names a bundle only a maintainer holds; never
ask for one unless the maintainer offers it.

## Git in a shared repository

Every worktree shares one `.git/config`, one stash and one object store.
Never `git stash`, never move a branch by relative ref, never commit in the
main checkout, never merge or rebase other lanes in. Before any git-driven
runner (`git bisect run`, hooks, `git rebase --exec`) unset `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_PREFIX` for the
command it runs; a test fixture's `git config` otherwise writes the shared
config.

Commit small conventional commits with the trailer the brief names. After
each commit read it back: `git log -1 --format='%an <%ae>%n%B'`. PanCode's commit
attribution may set the author or append trailers
(`integrations.git.commitAttribution`, `integrations.git.commitAuthor`). If
the result differs from what the brief requires, stop and report it; do not
rewrite history to hide it.

## Delegating

A dispatched worker does not inherit your loaded skills. Put the rules it
needs in the task or briefing: owned files, the traps above that apply, the
checks to run and what to return. Parallel workers need disjoint write roots.
You own shared registries and integration.

## Hand back

Run the checks `pancode-test` selects, verify the behaviour live unless
the brief waives it, then write the handback in
[references/lane.md](references/lane.md). Separate what a test proved, what a
built process proved, what a live model proved and what was not run.
