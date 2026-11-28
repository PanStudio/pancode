# Repository tooling

These tools build the checkout, check source and package contents, maintain
catalogs, install PanCode, and build, test and publish a release. The installer
scripts named in `release-manifest.json` also ship in the npm package and in
every bundle. The release flow itself is described in
[release/README.md](release/README.md).

Keep disposable output in a scratch directory you own outside the checkout, and
set `TMPDIR` to it before running commands that create temporary files. Never
use system `/tmp` or commit run output under `scripts/`.

## Package scripts

| Command | Purpose and effects |
| --- | --- |
| `pnpm run doctor:dev` | Check Node, pnpm, git, rg, fd and the installed dependencies against what this checkout needs; report python3, the git hooks and `dist/` as optional. Exits 1 when a required item is missing. |
| `pnpm run build` / `pnpm run build:release` / `pnpm run dev` | Build the CLI, the source pack, the code map and the preparsed YAML into `dist/`; the release build empties `dist/` first; `dev` watches source changes. |
| `pnpm run clean` | Remove `dist/`. |
| `pnpm run check` | Run `typecheck` and Biome (errors only) at once: the few-second loop before `pnpm run lint`. |
| `pnpm run typecheck` / `pnpm run typecheck:tsc` / `pnpm run typecheck:compare` | Typecheck source, tests and scripts with `tsrs --fast` (falling back to `tsc` with a notice where tsrs cannot run), with TypeScript's own `tsc`, or with both, failing if their diagnostics differ; `pnpm run ci` runs the last. See "Typechecking" in `CONTRIBUTING.md`. |
| `pnpm run format` / `pnpm run lint` | Format with Biome, or check formatting and Biome rules (any warning fails), source boundaries, license headers, catalog pins, resource paths and configuration consistency. No remote package refresh. |
| `pnpm run check:lane` | Run the gates a lane branch most often fails, for its diff against the base: environment guards, typecheck, lint (with the PanHub pins), the GUI check, OpenAPI freshness, and the test files the diff adds or imports. |
| `pnpm run check:gui` | Typecheck and lint the GUI app. |
| `pnpm run test:file -- <files>` | Run focused test files under `tests/harness/tmp-root.ts`, which gives each file its own temporary directory and PanCode home. |
| `pnpm run test` / `pnpm run test:gui` / `pnpm run test:list` | Run the default root or GUI selection in `ci-tests.mjs`, or list every selection. Root tests need a build. |
| `pnpm run test:full` / `pnpm run test:gui:full` | Run every root or GUI test file. `test:full` first refuses a `dist/` built from another commit (`check-dist.mjs`). |
| `pnpm run test:package` / `pnpm run check:packed-install -- --tarball <file> --prefix <dir>` | Exercise the installed package, or install a packed tarball alone into an empty prefix and check its commands, SDK exports and extension scaffold. |
| `pnpm run test:maintenance` | Run the keyboard routing and draft regressions. |
| `pnpm run hooks:install` | Install the pre-commit and pre-push guards against committing ignored files. |
| `pnpm run hub:check` / `pnpm run skills:check` | Verify local catalog content and generated projections against committed pins. |
| `pnpm run hub:pin` / `pnpm run skills:pin` | Refresh generated catalogs. PanHub pinning also fetches blessed remote packs. |
| `pnpm run hub:review -- --base <ref>` | Review every community row file that differs from a base ref. |
| `pnpm run economy:check` | Validate the public API reference tariff in `models/economy-rates.json` and print witness quotes. `-- --as-of <YYYY-MM-DD>` audits another day. |
| `pnpm run pi:surface-diff` / `pnpm run pi:surface-snapshot` | Review the consumed Pi declarations against their snapshot, or refresh it during dependency maintenance. |
| `pnpm run acp:schema` / `acp:schema:write` / `acp:schema:bump` | Check that the generated ACP wire-shape module matches the pinned upstream schemas, regenerate it from the pin, or move the pin to the newest upstream tags and regenerate. |
| `pnpm run herdr:pin` | Download and hash upstream Herdr's latest release, report whether a wire method PanCode sends is gone, and print the values a pin update needs. Edits nothing. |
| `pnpm run install:local -- --dry-run` | Preview installing this checkout. A real run can build, replace the launcher and run local repair. |
| `pnpm run ci` | The whole gate on this machine's Node, with the time zone, locale and pinned `rg` and `fd` that CI uses: the checks (`typecheck:compare`, `lint` with the PanHub pins, `check:gui`) beside a release build, the core, GUI and package test tiers against the built tarball, the npm install check, then the install smoke of this machine's bundle. `node scripts/ci.mjs check` and `node scripts/ci.mjs test <release dir>` run one part. |
| `pnpm run release:build -- --out <dir>` | Build the release directory: the npm tarball, the bundle for this machine (`--targets all` builds every platform), the installers, `SHA256SUMS` and the website. |
| `pnpm run release:smoke -- <dir>/assets` | Install this machine's bundle in a throwaway home with the release's installer, then run it, upgrade it, roll it back and uninstall it. |
| `pnpm run eval:onboarding` | Run the onboarding prompts against a live model in isolated homes and score each run. Calls the model. |
| `pnpm run eval:prompts -- --target <t> --model <m>` / `pnpm run eval:prompts:selftest` | Score the main-agent prompt on harness-use tasks (see `prompt-eval/README.md`), or check the scorers against recorded runs. Calls the model; writes results under `TMPDIR`. |

## Files

Build:

- `build.ts`: runs tsup for the CLI and worker bundles; `--clean` empties `dist/` first and `--watch` rebuilds on change.
- `build-output.ts`: shared stage timing, size and color output for the build steps.
- `chunk-merge.ts`: tsup plugin that merges esbuild's split chunks into the few files each boot path loads.
- `build-source-pack.ts`: packs the TypeScript source PanCode never reads at runtime into `dist/assets/source.pack`.
- `source-pack-plan.mjs` (+ `.d.mts`): decides which source files ship loose and which go into the source pack.
- `build-codewiki-asset.ts`: writes the package's own code map, `dist/assets/codemap.json.gz`.
- `build-preparsed-yaml.ts`: writes `dist/assets/preparsed-yaml.json` so startup skips parsing package-owned YAML.
- `build-windows-launcher.mjs`: builds and checks the native Windows launchers under `assets/windows-launcher/`.

Checks and tests:

- `doctor-dev.mjs`: `pnpm run doctor:dev`.
- `check.mjs`: `pnpm run check`.
- `typecheck.mjs`: `pnpm run typecheck`.
- `typecheck-compare.mjs`: `pnpm run typecheck:compare`.
- `check-hygiene.ts`: the source, documentation and packaging checks `pnpm run lint` runs after Biome, including `python3 site/sync-docs.py --check` for the website's documentation snapshot.
- `check-lane.mjs` (+ `.d.mts`): `pnpm run check:lane`.
- `ci-tests.mjs`: the root, GUI, package and full test selections and their runner.
- `ci-tools.mjs`: fetches the pinned ripgrep and fd release archives the test tiers use, locally and in CI.
- `gate-env.mjs` (+ `.d.mts`): pins one time zone and locale for every gate process.
- `check-dist.mjs`: refuses a `dist/` built from another commit before `test:full`.
- `check-economy-rates.ts`: `pnpm run economy:check`.
- `check-packed-install.mjs`: `pnpm run check:packed-install`.
- `pnpm.mjs`: starts pnpm from scripts, falling back to `corepack pnpm` when no `pnpm` command is on `PATH`.
- `package-files.ts`: decides whether a repository path ships, from the `package.json` `files` list.
- `license-headers.mjs` (+ `.d.mts`): inserts or checks the two SPDX lines on every tracked source file in scope; lint runs the check.
- `third-party-notices.mjs`: writes or checks `THIRD-PARTY-NOTICES.md` for every third-party package the build copies into `dist/`; lint runs the check.
- `git-guard.mjs`: the git hooks `pnpm run hooks:install` installs.
- `bench-tui.ts`, `bench-tui-feedback.ts`: terminal UI render and end-to-end feedback latency benchmarks (see `docs/architecture/tui-design.md`).
- `handbook-bench.mjs` (+ `.d.mts`): scores a handbook by what it does for the agents that read it.
- `eval-onboarding.ts`: `pnpm run eval:onboarding`.
- `prompt-eval/`: `pnpm run eval:prompts`; see its README.

Catalogs and pins:

- `pin-hub.ts`: `pnpm run hub:pin` and `hub:check`; writes `hub/index.yaml`.
- `pin-hub-remote.ts`: index rows for first-party and community packs.
- `pin-skills.ts`: `pnpm run skills:pin` and `skills:check`; writes `hub/packs/skills/registry.yaml` and `skill-marketplace.json`.
- `generate-hub-marketplace.ts`: writes `.claude-plugin/marketplace.json` from the pinned packs.
- `hub-review.ts`: `pnpm run hub:review`.
- `hub-root.mjs`: PanHub root key tool, run by the maintainer on an offline machine.
- `hub-sign.mjs`: PanHub index signing tool, run by CI with a certified signing key.
- `acp-schema.ts`, `acp-schema.pin.json`: `pnpm run acp:schema` and the upstream schema pin it reads.
- `herdr-pin.ts`: `pnpm run herdr:pin`.
- `pi-surface-diff.ts`: `pnpm run pi:surface-diff` and `pi:surface-snapshot`.
- `media-assets.py`: synchronizes and verifies tracked media assets (see `assets/README.md`).

Install:

- `install.sh`, `install.ps1`, `install.cmd`: the installers for Unix, PowerShell and CMD. They are release assets, the website serves them, and they ship in the package, where `pancode upgrade` runs them.
- `native-install.cjs`: the installers' step inside the installed package that writes the launcher and install record and switches versions.
- `install-local.sh`: `pnpm run install:local`.

Release (see [release/README.md](release/README.md)):

- `ci.mjs`: `pnpm run ci`, and the `check` and `test` steps `.github/workflows/ci.yml` runs.
- `release/build.mjs`: `pnpm run release:build`. Builds the npm tarball, the bundles, the installers, `SHA256SUMS` and the website into one directory.
- `release/bundle.mjs`: assembles one bundle per target from the pinned Node.js, the npm tarball and the lockfile's production dependencies.
- `release/node-runtime.json`, `release/pin-node.mjs`: the Node.js release every bundle carries, with the SHA-256 of its archive per target, and the script that writes that file after checking the Node.js release signature.
- `release/smoke.mjs`: `pnpm run release:smoke`.
- `release/publish.mjs`: the `publish` job's step: npm, the GitHub release, `main`, then the website and the channel files.
- `release/tested-run.mjs`: the `tested run` and `publish` jobs' check: finds the green push run of the commit being released and checks its `release` artifact against `SHA256SUMS` and the commit.
- `release-version-policy.mjs` (+ `.d.mts`): which package versions and changelog headings a checkout or release accepts.
- `check-release.mjs`: audits the built `dist/` and the packed tarball's contents.
- `release-manifest.json`: runtime files the installed package must contain.
- `release-audit.mjs` (+ `.d.mts`): audits the exact bundled dependency versions for advisories.
- `packed-license.mjs` (+ `.d.mts`): checks the packed LICENSE and NOTICE against the committed files.
- `report-credits.mjs`: lists reporters who opted in to credit and regenerates `CHAMPIONS.md`.
- `report-dataset.ts`: turns consented report bundles into a dataset release.

CI builds the release once per run. The required `ci (22)` and `ci (24)` checks
test that build, the `install` jobs install its bundles on each platform, and a
release publishes the same files from the `publish` job.
