# Releasing PanCode

The maintainer's reference for branches, releases and the repository settings a release needs. A contributor opening a pull request does not need it; see [CONTRIBUTING.md](../../CONTRIBUTING.md). The modules in this directory are the pieces of `scripts/release.mjs` and `scripts/release-candidate.mjs`; [scripts/README.md](../README.md) lists them.

## Branches and releases

Development happens on the version branch, currently `v090`. Keep local
and remote version branches synchronized with ordinary pushes. `main` moves
only by fast-forward when a stable release completes. Published tags and npm
versions are immutable. The completed stable release deletes its version branch;
create the next version branch from the released `main` when development resumes.

A stable release means the same qualified version is available on npm and
GitHub, `main` points to its source commit, and the public website serves its
prepared docs and installers. There is no atomic transaction across these
services: publish npm first, then the GitHub tag/release, then promote `main` and
`gh-pages`. A partial failure is resumed with the original artifact. Never move
a published tag, rebuild a published candidate, or republish different bytes.

Pushes to a version branch and pull requests run only the browser smoke
(`browser-smoke.yml`), which creates no `ci` check. Qualification is deliberate;
the required check names remain `ci (22)` and `ci (24)`. Development qualification
accepts an `Unreleased` changelog and prepares an isolated website preview from
the candidate version. Publication separately requires a final version, dated
nonempty release notes, and matching committed website metadata. Full
investigation also limits concurrent test files to two so subprocess fixtures
do not compete with hundreds of cold boots. One manual `ci.yml` run
checks source, builds and packs once, tests selected root/GUI behavior and the
installed package on Node 22, runs the same tests and boot on Node 24, and
publishes no result unless both pass. Its immutable
`candidate-<sha>` artifact includes the versioned npm tarball, SHA-256 receipt,
four installers extracted from that archive, release notes, and a prepared
website. `results-<sha>` and `results24-<sha>` record the actual test counts. The development defaults select the root and GUI files listed in `scripts/ci-tests.mjs`; package and runtime
checks remain part of explicit qualification. `pnpm run test:list` lists every selected
file and every contract/GUI file reserved for full investigation. Redundant
prose and appearance-specific tests are retired with maintainer approval. `test:full`, `test:gui:full`, and maintenance checks stay manual.

Release with one command in a visible terminal:

```bash
pnpm run release -- --check      # read-only readiness report; needs no terminal and writes nothing
pnpm run release                 # the release
pnpm run release -- --platforms  # the release, with Windows and macOS boots added to its CI run
```

`scripts/release.mjs` is the only release driver. It never pushes before every
local gate is green, and every remote write asks for a typed phrase such as
`push v090` or `publish pancode@0.9.0`. One release command runs per
clone at a time, under a lock in
`$(git rev-parse --git-common-dir)/pancode-release/`. Qualification and packing
refuse `/tmp` and `TMPDIR` paths longer than 40 characters; export a short
private one such as `TMPDIR=$HOME/.cache/cr`.

Before releasing, set the agreed version consistently in `package.json`, the GUI
manifest, and both `version` and `publishedVersion` in `site/product.json`. Add dated release notes in
`CHANGELOG.md` and update version references such as the README source-install
command. Commit the candidate on the version branch. The command refuses a dirty
tree or inconsistent versions; it does not invent release notes or bump versions.

The command then runs these steps in order:

1. Readiness, in seconds. `pnpm run preflight -- --release` checks versions, the
   dated changelog heading and nonempty notes, release readiness, the size
   budgets the source tree decides, and the local tools. The command then checks
   that `gh` is authenticated, that `npm whoami` answers, that `origin/main` is
   an ancestor of the candidate, that tag `v<version>` is free or already at
   the candidate, and that GitHub holds the owner configuration below: a public
   repository, the `release` environment with the owner as required reviewer,
   its deployment rules, variable and secret, and the rulesets. Every problem is
   listed at once and nothing has been built or pushed. `--check` stops here after printing whether a local qualification
   and a `ci.yml` run already exist for the commit.
2. Local qualification, without confirmation because it writes nothing remote.
   `scripts/release-candidate.mjs qualify` builds and packs once, then tests the
   package and boots an installed copy on Node 22 and 24 at once, under the same
   time zone, locale and pinned `rg` and `fd` as CI. A passed qualification of
   the same commit is reused. It uses this process's Node for its own major and
   `nvm`'s newest install of the other. This step is skipped when a `ci.yml`
   run of the commit already exists.
3. Push and CI. After the phrase `push <branch>`, the command pushes the version
   branch and dispatches one `ci.yml` run for the exact commit, then watches it.
   An existing run of the commit is used instead: an unfinished one is watched,
   a failed one has its failed jobs rerun on confirmation, and a successful one
   is reused if its `candidate-<sha>`, `results-<sha>` and `results24-<sha>`
   artifacts are still live.
4. Verification of the CI artifact. The command downloads the three artifacts,
   runs `release-publish.mjs verify` against the run, and runs npm's own dry
   run of the qualified tarball under the release's dist-tag. The published
   bytes are always the CI artifact, never a local pack.
5. npm, by the owner. After the phrase `publish <name>@<version>`, the command
   runs `npm publish` on the qualified tarball in the terminal so npm's
   two-factor prompt works. If npm already serves the same bytes it publishes
   nothing; different bytes stop the release. An accepted publish is recorded,
   so it is never offered twice while npm propagates.
6. GitHub, with the owner's approval. After the phrase `release v<version>`, the
   command dispatches `release.yml` and watches it. **The owner approves the
   protected `release` environment in GitHub.** Agents leave the npm publish
   and this approval to the owner. The release job waits for npm to serve the
   exact bytes, creates or repairs the draft, pins it to the candidate, uploads
   the versioned tarball and four installers, and publishes the tag and release.
   A stable release becomes Latest, fast-forwards `main`, commits the prepared
   site to `gh-pages`, and deletes the remote version branch.
7. Closeout. After a stable release the command offers to forward the npm
   `beta` dist-tag when it fell behind, then to
   fast-forward local `main` and, when `origin/main` is the candidate, delete
   the finished local version branch.

A version with a prerelease suffix, such as `0.9.0-rc.0`, goes to npm's `beta`
dist-tag and a GitHub prerelease that is not Latest; the suffix alone selects
this. Its approval covers only the tag and prerelease, so `main`, the site and
the version branch stay as they are. A stable version goes to `latest`.

For retries, run the command again. Readiness is checked again, the `ci.yml`
run of the commit and the qualified bytes on npm are reused, and a new
`release.yml` run is dispatched, whose job repairs draft GitHub assets and
completes only the steps still open. If an artifact expires, prepare a new
candidate commit; do not rebuild a previously qualified commit. A different npm
integrity or tag commit stops the operation.

The command always releases the checked-out head. If a release-tooling bug
appears after npm accepted the version, the owner finishes by dispatching
`release.yml` by hand for the published candidate. Once npm serves it, the
workflow may finish from a version-branch head that adds only release-tooling
files (`scripts/release*.mjs`, `scripts/release/`, `release.yml`,
`tests/contracts/release-*.test.ts`). With other later commits, `mode: finish`
requires npm to already serve the exact qualified bytes and the candidate to be
an ancestor of the branch head, completes only the tag, GitHub release, main
and website steps still open, never republishes, and leaves the version branch
in place. The tag, tarball and website still come from the candidate.

`pnpm run release:rehearse` is optional and not part of a routine release. Use
it after changing release tooling or workflows. It qualifies locally, pushes
the commit to a temporary `rehearse/*` branch after a typed phrase, runs one
`ci.yml` run with the publisher's rehearsal jobs (`--platforms` adds the
Windows and macOS boots), then cancels its unfinished runs and deletes the
branch. It starts from a version branch, accepts a development version and an
`Unreleased` changelog, and changes no package, tag, `main` or site. Prove Windows changes on a native Windows clone with
`core.autocrlf=false` before pushing them.

## Owner configuration

The owner configures `akougkas/pancode` once, before its first release.
`pnpm run release` reads the configuration back and refuses to start while
any piece is missing, and `release.yml` fails at the step that needs it.

npm holds no trusted publisher and CI holds no npm token. The owner publishes
the unscoped `pancode` package with npm two-factor approval inside
`pnpm run release`, and `release.yml` only verifies that npm serves the
qualified bytes. A rehearsal cannot prove npm's authorization without
publishing a new version; `npm publish --dry-run` does not verify it.

Every registry read and every `npm publish` and `npm dist-tag` the release
runs names `https://registry.npmjs.org/` with `--registry`, so an npm config
that points at a mirror never receives the publish. For a local rehearsal
only, `PANCODE_RELEASE_REGISTRY=http://127.0.0.1:<port>/` (or
`http://localhost:<port>/`) names a loopback registry instead; any other value,
or any value under GitHub Actions, stops the release.

The GitHub App `pancode-release` (App ID 5919481) has **Contents: read/write**,
**Workflows: read/write**, **Actions: read** and **Metadata: read**, no
webhook, and is installed on `akougkas/pancode` only. Workflows permission lets
main promotion carry workflow changes; Actions read verifies the
qualification. The `release` environment holds the variable `RELEASE_APP_ID`
(`5919481`) and the secret `RELEASE_APP_PRIVATE_KEY`. After the owner approves
the job, `release.yml` mints an installation token for this repository from
them and makes every GitHub write with it; it has no `GITHUB_TOKEN` fallback,
and the publisher refuses a token from any App other than `pancode-release`.
The App's `gh-pages` push triggers the Pages build; `GITHUB_TOKEN` pushes do
not.

The `release` environment has the owner as required reviewer and admits only
a **Tag** deployment rule `v*` and a **Branch** deployment rule
`v[0-9][0-9][0-9]`, so publication from a version branch such as `v090`
reaches the approval gate and nothing else does. GitHub enforces required
reviewers only on a public repository of a personal account, so the
repository is public before the first release. Leave Prevent self-review
unchecked, because the owner also dispatches releases. An agent authenticated
with the owner's admin credentials could technically approve or bypass the
gate; a strict owner-only boundary requires separate agent credentials and
disabling administrator bypass.

Four rulesets protect the release refs, each with only the bypass it needs:

- `main` structure: deletion and non-fast-forward updates are blocked, with no
  bypass.
- `main` merges: pull requests and the required checks `ci (22)` and
  `ci (24)`, with the App as bypass actor. The release promotion does not
  satisfy these checks on main: `release.yml` verifies that npm serves the
  qualified bytes and that the manual qualification run passed `ci (22)` and
  `ci (24)` on the commit, then the App fast-forwards main through this
  bypass.
- `v*` tag creation, with the App as bypass actor, so only a release creates a
  tag.
- `v*` tag updates and deletions, with no bypass. Never grant an App a bypass
  of published-tag immutability.

The repository topics come from `.github/repository-metadata.json`.

The first release starts from an empty repository. Its version-branch push
makes that branch the default, so the release job leaves it in place and says
so; the owner then makes `main` the default branch and deletes the version
branch. The job also starts `gh-pages` as an orphan branch, which GitHub Pages
does not serve until the owner points Pages at it with the custom domain
`pancode.dev`. If the job's wait for `/version.json` runs out first, rerun its
failed job; it completes only the steps still open.

Workflow changes can be committed and rehearsed on the version branch without
publishing. Decide the next release's product scope and version metadata when the
owner asks to cut it.

Manual qualification tests the actual archived package under isolated homes. Release
publication consumes that artifact and its successful qualification record;
there is no second build or test run in the publishing workflow.

## Contributor license check

The contributor check is CLA Assistant (cla-assistant.io), a hosted GitHub App.
It sets the commit status `license/cla`, keeps signatures in its own service and
comments on the pull request; it writes no file, branch or commit in this
repository. Set it up before the repository is made public:

1. Publish the text of `CLA.md` as a public gist owned by `akougkas`.
2. Sign in at cla-assistant.io as `akougkas` and link `akougkas/pancode` to that
   gist.
3. Allowlist the release GitHub App, so its pull requests and pushes need no
   signature.
4. Add `license/cla` as a required status check in the ruleset that protects
   the version branches and `main`, with the owner and the release App on its
   bypass list.
5. Open a test pull request from a second GitHub account and confirm the status
   goes from pending to success once that account signs.

When `CLA.md` changes, update the gist; CLA Assistant then asks contributors to
sign the new version.
