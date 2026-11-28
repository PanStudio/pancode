# Contributing to PanCode

PanCode is systems software for coding agents, developed and maintained by Anthony Kougkas ([@akougkas](https://github.com/akougkas)). You do not need to know the codebase to help: reports from real use are as useful as code.

PanCode is pre-1.0, so public interfaces can change between minor releases. User-visible changes go in [CHANGELOG.md](CHANGELOG.md), participation follows the [Code of Conduct](CODE_OF_CONDUCT.md), security problems go through [SECURITY.md](SECURITY.md) and never a public issue, and [SUPPORT.md](SUPPORT.md) says where to ask for help.

## Ways to contribute

- **Report a problem or ask for a feature.** Inside PanCode, `/report bug`, `/report feature` or `/report question` drafts the report, masks paths, host names and secrets, and shows you the exact text before anything is sent. `pancode report` does the same from a shell. You can also open an [issue](https://github.com/PanStudio/pancode/issues/new/choose) by hand.
- **Ask a question.** Open a [question](https://github.com/PanStudio/pancode/issues/new?template=question.yml) issue.
- **Share how a model or machine worked.** Local models, cluster login nodes and unusual terminals are where reports help most. Open a [question](https://github.com/PanStudio/pancode/issues/new?template=question.yml) issue and say what you ran.
- **Fix the docs.** The guides under `docs/guide/` ship in the npm package and are what PanCode reads to answer questions about itself, so a correction there reaches every user.
- **Change the code.** Set up a checkout as below, keep the change focused, and open a pull request against the current version branch.

## Set up a checkout

Requirements:

- Node.js 22.19 or later. CI tests Node 22 and 24; `.nvmrc` names 22.
- pnpm 10.34.5, pinned by `packageManager` in `package.json`. Corepack, which ships with Node, provides it.
- git, ripgrep (`rg`) and fd (`fd`, or `fdfind` on Debian and Ubuntu) on `PATH`.
- Linux or macOS. Native Windows is best effort.

```bash
git clone https://github.com/PanStudio/pancode.git
cd pancode
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run doctor:dev
pnpm run hooks:install
pnpm run build
```

`doctor:dev` checks the requirements above and the installed dependencies, and names the fix for anything missing. It exits nonzero when a required tool is absent.

`hooks:install` adds pre-commit and pre-push guards that refuse any path `.gitignore` excludes, including one staged with `git add -f`. Keep private plans, prompts and notes under the ignored `.mine/`; `pnpm run lint` fails if an ignored path is ever tracked.

## Run tests

Run the test files that cover your change:

```bash
pnpm run test:file -- tests/contracts/<name>.test.ts
pnpm run test:file -- tests/contracts/<one>.test.ts tests/extended/<two>.test.ts
```

`test:file` runs `node --test` with `tests/harness/tmp-root.ts` preloaded, so each run gets its own temporary directory and PanCode home and never touches yours. Some tests spawn `dist/cli/index.js` or start `dist/worker/entry.js`; run `pnpm run build` again after changing code those processes run.

Tests live in `tests/contracts/` (behavior contracts), `tests/extended/` (slower regressions) and `apps/pancode-gui/tests/` (the GUI). `pnpm run test` runs the default contract selection and `pnpm run test:list` prints which files each selection holds. Use `tests/harness/scratch-env.ts` for state isolation inside a test, and never replace `process.stdout.write` across async test boundaries.

## Submitting changes

1. Cut a focused branch (`fix/session-resume` or `feat/cli-inspect`) from the current version branch, which is `v` plus the digits of the `package.json` version, such as `v090` for 0.9.0. Open the pull request against that branch. `main` moves only when a release ships.
2. Add or update tests that exercise the changed behavior.
3. Write commit subjects as conventional commits of at most 72 characters:
   ```text
   fix(session): preserve branch selection on resume
   docs: clarify worker permission scope
   feat(cli): add target inspection option
   ```
4. Before requesting review, run `pnpm run typecheck`, `pnpm run lint`, focused `pnpm run test:file` runs for the behavior you changed, and `pnpm run test`. `pnpm run ci` is the whole gate CI runs and takes several minutes; it is not a routine check.

Every source file opens with two SPDX lines naming its license (`LicenseRef-PanCode-1.0`, or `Apache-2.0` under `packages/sdk/`) and the copyright holder. For a new file, run `node scripts/license-headers.mjs --write`; `pnpm run lint` fails on a file without them.

Contributions are accepted under the [Contributor License Agreement](CLA.md): you keep your copyright and grant the maintainer the rights to ship your work under the PanCode License 1.0 and its commercial license, and changes to `packages/sdk/` are also licensed under the Apache License 2.0. Once the `license/cla` check is enabled, your first pull request asks you to sign through it, and it must pass before a pull request is merged.

## Validation reference

| Command | Purpose |
| --- | --- |
| `pnpm run doctor:dev` | Check the local toolchain and installed dependencies. |
| `pnpm run test:file -- <files>` | Run focused test files under the isolated state harness. |
| `pnpm run check` | Fast loop (a few seconds): `typecheck` and Biome errors at once. Run `lint` as well before you report. |
| `pnpm run typecheck` | Check TypeScript across source, tests and scripts with `tsrs --fast`, falling back to `tsc` where tsrs cannot run. See [Typechecking](#typechecking). |
| `pnpm run typecheck:tsc` / `pnpm run typecheck:compare` | Check with TypeScript's own `tsc`, or run both and fail if their diagnostics differ. Use them when `typecheck` reports something surprising or stays silent about an error you expect. |
| `pnpm run lint` | Check formatting and Biome rules (any warning fails), source boundaries, license headers, catalog pins and repository hygiene. |
| `pnpm run check:gui` | Check GUI browser and server TypeScript, lint rules and client bundle budgets. |
| `pnpm run build` | Build `dist/` without emptying it, so a running PanCode from this tree keeps working; chunks no live process needs are pruned afterwards. |
| `pnpm run build:release` | Clean build that empties `dist/` first. Use it for packaging, never in a tree another session runs from. |
| `pnpm run test` | Default contract selection. Needs a build. |
| `pnpm run test:gui` | Default GUI selection. |
| `pnpm run test:full` | Every root test file, including extended regressions. |
| `pnpm run ci` | The whole gate on this machine's Node: the checks beside a release build, the test tiers against the built tarball, the npm install check, then an install, upgrade, rollback and uninstall of this machine's bundle. CI runs the same steps on Node 22 and 24 and on every platform. |
| `pnpm run release:build -- --out <dir>` | Build the release directory: the npm tarball, this machine's bundle, the installers and the website. |
| `pnpm run release:smoke -- <dir>/assets` | Install the built bundle in a throwaway home and take it through upgrade, rollback and uninstall. |

[scripts/README.md](scripts/README.md) lists every package script and the script file behind it.

## Typechecking

`pnpm run typecheck` runs [tsrs](https://github.com/oxc-project/tsrs), a Rust port of the TypeScript 7 checker, in `--fast` mode: about a second where `tsc` takes several. tsrs is a development dependency only and is not in the published package. Where tsrs cannot run, such as on win32-arm64 (no native package), after an install without optional dependencies, or when it crashes, the command prints `typecheck: using tsc, the slower reference compiler, because ...` and checks with `tsc` instead. `PANCODE_TYPECHECK=tsc` forces that path. The exit code is the checker's: tsrs exits 2 and `tsc` exits 1 or 2 on type errors.

`tsc` stays authoritative:

- The gate (`pnpm run ci` and the `check` job of `.github/workflows/ci.yml`) runs `pnpm run typecheck:compare`, so the gate is `tsc`'s verdict, and it also fails when tsrs reports anything different.
- `tests/contracts/typecheck-corpus.test.ts` (core tier) holds `tsc`, tsrs and `tsrs --fast` to the diagnostics recorded in `tests/fixtures/typecheck-corpus/expected.txt`. The corpus injects errors under the options PanCode relies on: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, NodeNext `.js` specifiers, `paths` aliases, JSON modules, `isolatedModules`, TSX and declaration emit. It also covers the `file(line,col): error TSnnnn:` output agents parse, and the fallback.
- The GUI keeps its own `tsc` in `pnpm run check:gui`.

**Version pairing.** The root's reference compiler, `@typescript/native`, is the TypeScript release that tsrs ports: `tsrs.typescriptVersion` in `node_modules/tsrs/package.json`. The corpus test fails when they differ. Bump both in one commit, refresh the record with `TYPECHECK_CORPUS_WRITE=1 pnpm run test:file -- tests/contracts/typecheck-corpus.test.ts`, review the `expected.txt` diff, then run `pnpm run typecheck:compare`.

**When tsrs and tsc differ, `tsc` is right** until proven otherwise:

1. The change is judged by `tsc`'s diagnostics.
2. Reduce the difference to a minimal case and file it at [oxc-project/tsrs](https://github.com/oxc-project/tsrs/issues). The project takes issues, not pull requests.
3. If only `--fast` differs, drop `--fast` in `scripts/typecheck.mjs`. Otherwise set `typecheck` back to `tsc -p tsconfig.tests.json`, which leaves the `--fast` speed behind but changes nothing else.
4. Add the case to the corpus in the commit that moves to a tsrs release that fixes it.

## GUI development

Run the API server and browser client in separate terminals. The API listens on
4317 and Vite on 4318; open the printed access link on the Vite port.

```bash
pnpm --filter pancode-gui dev:server
pnpm --filter pancode-gui dev:client
pnpm run check:gui
pnpm --filter pancode-gui test:full
```

The root build supplies both the CLI and `dist/gui/client`; the source server can
use that client build. Rebuild after changing the shared configure wizard: GUI
setup hosts a fixed `configure --gui-host` child through `server/process-policy.ts`.
The browser presents typed prompts; the CLI retains provider I/O, credential
storage, model checks, and settings writes. Keep setup replies out of operation,
conversation, and lifecycle logs. Validate first-run changes with isolated
`PANCODE_HOME` and a local model fixture.

## Architecture boundaries

The lint suite enforces the boundary rules `rule1` to `rule17` in `tests/boundaries/check-boundaries.ts`. The main invariants:
1. Only `src/engine/**` may import `@earendil-works/pi-*` packages (including type imports).
2. Worker imports from domains are type-only except for declared provider rehydration seams.
3. Domains communicate exclusively via contracts and events; do not cross-import another domain's `extension.ts`.
4. `src/tools/**` must not import the interactive UI.
5. Turn-runtime modules must not import `src/entry/**`; entry points compose dependencies.
6. Preserve the protected instant-shell import graph and its declared entry seams.

See [architecture invariants](docs/architecture/architecture.md#boundary-invariants) for details. Keep CLI subcommands dynamically imported to preserve fast `--help` and startup.

## PanHub packs and skills

`hub/packs/` holds six pack kinds: plugin, extension, skill, agent, prompt and playbook (see the [PanHub guide](hub/README.md)).

```bash
pancode hub validate <pack-path> --json
pancode hub register <pack-path> --project
pancode hub install <kind>:<name> --project
```

After changing a bundled pack or a curated skill, refresh and check the pins:

```bash
pnpm run hub:pin && pnpm run hub:check
pnpm run skills:pin && pnpm run skills:check
```

## Developing with agents

Source code, TypeScript types and schemas are authoritative. [PANCODE-DEV.md](PANCODE-DEV.md) is the handbook for code changes in this repository. Prefer `rg` and targeted source reads over long prose, and do not invent commands, settings or benchmark numbers.

## README contract

The README is the GitHub and npm landing page. Keep installation, capabilities,
interface captures, model choices, and references easy to scan. Details belong
in the guides; command-heavy material and agent orientation use foldable blocks.

- Open with a hero: the banner, what PanCode is in one sentence, one
  supporting line, the one-line install, and a capture of PanCode working.
  Use absolute HTTPS image URLs so npm can render them.
- Sections, in order: What is PanCode, Why PanCode, Get started (Install,
  Your first session), What you can do, Interfaces, Models and providers,
  HPC and science, Safety and control, For AI agents, Documentation,
  Contribute and get help, License, Author.
- Each image sits under a `<!-- Media slot: ... -->` comment. To change a
  capture, replace the file under `assets/` and keep its path and alt text
  accurate.
- The tagline, the descriptions and the license summary match `package.json`,
  `.github/repository-metadata.json` and the website. Change them together.
- Keep the source installation under Get started, including launcher path
  verification. It clones `main` until the first dated release and the latest
  release tag after that; `readme-install-block` in `pnpm run lint` checks it.
  Release chronology belongs in `CHANGELOG.md`. While a
  release candidate is out, a note under the install commands says which
  version they install and how to get the candidate; drop it at the stable
  release.
- Keep the **For AI agents** section exact and machine-friendly: commands that
  run as written, the `run` flags and exit codes, the files to read, and what
  to leave to the human.
- Update this layout contract when changing the landing page structure.
  Routine hygiene checks installation correctness and links, not editorial layout.

## Releases

The maintainer releases by dispatching `.github/workflows/ci.yml` with `release` checked and approving its `publish` job. The branch model, the release steps and the repository settings they need are in [scripts/release/README.md](scripts/release/README.md).
