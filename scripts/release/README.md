# Releasing PanCode

The maintainer's reference for what a release is, how to cut one and the settings it needs. A contributor opening a pull request does not need it; see [CONTRIBUTING.md](../../CONTRIBUTING.md). [scripts/README.md](../README.md) lists the scripts in this directory.

## What a release is

One commit, built once, published to four places:

| Where | What |
| --- | --- |
| npm | `@akougkas/pancode@<version>`, for people who bring their own Node.js |
| GitHub release `v<version>` | One bundle per platform (`pancode-<version>-<target>.tar.gz`), the npm tarball, `install.sh`, `install.ps1`, `install.cmd` and `SHA256SUMS` over all of them |
| `main` | Fast-forwarded to the released commit (stable releases) |
| `gh-pages` | The website (stable releases) and `channel/latest` and `channel/beta`, one line each naming a version |

A bundle is the Node.js pinned in `scripts/release/node-runtime.json`, npm, and the packed package with the production dependencies `pnpm-lock.yaml` names. The installers and `pancode upgrade` read a channel file, check the bundle against `SHA256SUMS` and unpack it; they resolve nothing from a package registry. Published tags, npm versions and release assets never change.

A version with no suffix (`0.9.0`) is stable: npm `latest`, a GitHub release marked Latest, `main`, the website and both channel files. A version ending in `-rc.N` is a pre-release: npm `beta`, a GitHub pre-release and `channel/beta` only. Any other version, such as `0.9.1-dev`, is a development version: it is built and tested on every push and never published.

## The pipeline

`.github/workflows/ci.yml` is the only pipeline. It runs on every push to a version branch, on every pull request, and when dispatched.

| Job | What it proves |
| --- | --- |
| `check` | Typecheck, lint, GUI check and hub check |
| `build` | `scripts/release/build.mjs` builds the npm tarball, every bundle, the installers and the website once, and uploads them as the `release` artifact |
| `ci (22)`, `ci (24)` | The test tiers and the npm install check, against the `dist/` inside that tarball, on both supported Node majors. These are the branch-protection check names |
| `install (<target>)` | `scripts/release/smoke.mjs` installs that target's bundle with the release's own installer in a throwaway home, runs the three commands, upgrades to a next version through `pancode upgrade`, rolls back and uninstalls. It runs on Linux x64 and arm64, Alpine (musl) x64 and arm64, CentOS 7 (glibc 2.17), macOS arm64 and x64, and Windows x64 and arm64 |
| `browser smoke`, `gui api smoke` | The desktop app in the runner's Chrome and through its HTTP API |
| `publish` | Only for a dispatch with `release` checked, after every job above passed, behind the `release` environment. `scripts/release/publish.mjs` publishes the files the other jobs tested |

`pnpm run ci` runs the same gate on one machine: the checks beside the build, the tests against the built tarball, then the install smoke of this machine's bundle. `pnpm run release:build -- --out <dir>` and `pnpm run release:smoke -- <dir>/assets` run the two halves alone.

## Cutting a release

1. Set the version in `package.json`, `apps/pancode-gui/package.json`, `assets/acp-registry/agent.json` and every `packages/*/package.json`; the build refuses manifests that disagree. For a stable release also set `version` and `publishedVersion` in `site/product.json` and the `--branch v<version>` pin in `README.md`.
2. Retitle the first `CHANGELOG.md` section `## <version> - YYYY-MM-DD`. Its body becomes the GitHub release notes.
3. Commit on the version branch, then commit the docs snapshot of that commit: `python3 site/sync-docs.py --snapshot-ref <release commit>`.
4. Push the version branch and let the push run of `ci.yml` pass.
5. Dispatch the release from the version branch:

   ```bash
   gh workflow run ci.yml --repo akougkas/pancode --ref v090 -f release=true
   ```

6. When every job has passed, the `publish` job waits. Approve the `release` environment in the run's page. That approval is the release decision; nothing else in the pipeline can publish.

`publish` then runs in this order: npm, the GitHub release and its tag, `main`, `gh-pages`. The channel file moves last, so no installer or update check hears about a version before its bundle can be downloaded. Each step first reads what is already published. If the job fails, fix the cause and rerun it with `gh run rerun <run id> --failed --repo akougkas/pancode`; it asks for approval again and completes only the open steps. Bytes that differ from what an earlier run published stop it.

After a stable release, create the next version branch from `main` and set the next development version.

### The first release of a package name

npm trusted publishing cannot create a package, so the first version of `@akougkas/pancode` is published by hand, from the files the run built:

```bash
gh run download <run id> --repo akougkas/pancode --name release --dir <dir>
npm publish <dir>/assets/akougkas-pancode-<version>.tgz --access public
```

Do this while `publish` waits for approval, then approve. The job finds that npm already serves those bytes and continues with GitHub, `main` and the website. Then attach the trusted publisher, described under Owner configuration, so later releases need only the approval.

## Rehearsing

A change to the release scripts is rehearsed without publishing anything, against a loopback npm registry such as Verdaccio and a local bare repository:

```bash
pnpm run release:build -- --out <dir>
node scripts/release/publish.mjs <dir> --registry http://127.0.0.1:4873/ --remote <bare repository>
```

The rehearsal publishes to that registry, fast-forwards `main` and writes `gh-pages` in that repository, and skips the GitHub release, which only GitHub can hold. Both flags are refused under GitHub Actions. The release directory must come from a committed tree with a stable or `-rc.N` version.

## Moving the bundled Node.js

```bash
node scripts/release/pin-node.mjs <version>
```

It rewrites `scripts/release/node-runtime.json` with the archive URL and SHA-256 for every target, after checking the official checksum file against the Node.js release keys with `gpgv`. The musl and glibc 2.17 archives come from unofficial-builds.nodejs.org and are unsigned; review their hashes in the diff. Every build checks each archive against its pin.

## Checking a release as a user

```bash
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify pancode-<version>-<target>.tar.gz --repo akougkas/pancode
npm audit signatures
```

Every release asset carries a GitHub build attestation naming this repository and `ci.yml`. A version published through trusted publishing also carries npm provenance.

## Owner configuration

Configured once on `akougkas/pancode`.

**npm.** After the first version exists:

```bash
npm trust github @akougkas/pancode --file ci.yml --repo akougkas/pancode --env release --allow-publish
```

Then set the package to require two-factor authentication and disallow tokens. No workflow holds an npm token; `publish` authenticates with the run's OIDC identity, which npm accepts only from `ci.yml` in the `release` environment.

**The `release` environment** has the owner as required reviewer and admits a Tag rule `v*` and a Branch rule `v[0-9][0-9][0-9]`, so only a version branch reaches the approval. It holds the variable `RELEASE_APP_ID` and the secret `RELEASE_APP_PRIVATE_KEY`. GitHub enforces required reviewers on a personal account only for a public repository. Leave Prevent self-review unchecked, because the owner also dispatches releases.

**The GitHub App `pancode-release`** has Contents read and write, Workflows read and write and Metadata read, no webhook, and is installed on this repository only. `publish` mints its installation token after approval and uses it for the release, the tag, `main` and `gh-pages`. Workflows permission lets the `main` promotion carry workflow changes, and the App's `gh-pages` push starts the Pages build, which a `GITHUB_TOKEN` push does not.

**Rulesets.** `main` cannot be deleted or force-pushed by anyone. Changes reach `main` by pull request with `ci (22)` and `ci (24)`, and the App bypasses that to promote a release whose run passed them. Only the App creates `v*` tags. Nobody updates or deletes a `v*` tag.

**Release immutability** (Settings, Releases) seals a published release's tag and assets. `publish` attaches every asset to a draft and then publishes it, which is the order immutability needs.

**Pages** serves `gh-pages` with the custom domain `pancode.dev`. The first stable release creates the branch; point Pages at it once.

The first release of a repository starts with the version branch as the default branch. Make `main` the default after it exists.

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
