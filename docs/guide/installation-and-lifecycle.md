# Installation and Lifecycle Operations

This guide covers how you install PanCode, where it keeps its files, and how you
upgrade, roll back, reset, move between install methods and uninstall it. Use it
to choose an install method, find a file on disk, or recover an installation.
The [architecture overview](../architecture/architecture.md) explains the installed runtime and its entry points.

## Install PanCode

To install PanCode on Linux or macOS, run `curl -fsSL https://pancode.dev/install.sh | sh`.

On Windows, run `irm https://pancode.dev/install.ps1 | iex` in PowerShell. Both installers bring a private Node runtime. For npm or source installs, see the methods below.

## Installation methods

PanCode installs with `scripts/install.sh` (or `scripts/install.ps1` on Windows), which brings a private Node.js runtime; from the npm registry as
`pancode` using npm, pnpm, or Bun; or from a source checkout using the
pinned pnpm workflow. The [README quick start](../../README.md#get-started) covers
installing and first run. The package routes require Node.js `>=22.19.0`,
including installations managed by Bun; the installer satisfies that itself. On
an older Node, the package's `pancode` command says so before loading anything
else and names the installer, or a newer Node given by `PANCODE_NODE`.
[HPC clusters](hpc-clusters.md) covers cluster login nodes, old glibc, proxies and
airgapped sites.

On native Windows, which is best effort, run
`irm https://pancode.dev/install.ps1 | iex` in PowerShell.
[install.cmd](../../scripts/install.cmd) is a CMD bootstrap: it downloads
`install.ps1` from that address, runs it with the arguments it was given, and
returns its exit status. Both install the same layout under
`%LOCALAPPDATA%\pancode\install` with the launcher
`%USERPROFILE%\.local\bin\pancode.exe`, and need no administrator rights.
The launcher is a small native program that reads `pancode.launch` beside it
and starts the managed Node with your arguments unchanged, so cmd.exe never
expands `%NAME%` or splits on `&` in them. The installer copies it only when its
bytes match the SHA-256 pinned in the package. An
npm or pnpm global install starts PanCode through npm's own `pancode.cmd`,
which cmd.exe expands. `install.sh` run from an MSYS, MinGW or Cygwin shell stops and names the
PowerShell command. A relative path given to `install.ps1` for the install
directory, the bin directory or `-Package` resolves against the PowerShell
location, not the process directory. Linux, macOS and WSL are the primary
platforms.

A checkout or other unbundled source run of a development tree reports its version as
`<version>-dev (unreleased · source)`. A bundle built from a checkout reports
`<version>-dev (unreleased · <sha>)`, with `-dirty` after the commit when the tree had
uncommitted changes. A release, including a published `-rc` prerelease, reports the plain
version. The banner, `--version`, `pancode doctor` and the ACP handshake all use this
label, and extension version ranges are checked against the version without `-dev`, the release the
development tree is becoming.

### npm install-scripts warning

npm versions that gate dependency install scripts behind `allowScripts` may print, on
`npm install -g pancode`, that `@google/genai` (preinstall) and `protobufjs`
(postinstall) have install scripts not yet covered by `allowScripts`. The installation is
complete and works without them: the `@google/genai` preinstall is `echo 'preinstall: no-op'`,
and the `protobufjs` postinstall only prints a warning when a package that depends on it
pins a version range in a style it does not recommend. Neither builds, downloads or writes
anything PanCode needs, so skipping them is safe. To silence the warning, allow them as
npm suggests, once with `npm install -g --allow-scripts=@google/genai,protobufjs pancode`
or for every global install with
`npm config set allow-scripts=@google/genai,protobufjs --location=user`.

### Try a pre-release

The `latest` channel contains stable releases. `beta` contains release candidates
such as `0.9.1-rc.1`. Checkout versions ending in `-dev` remain unpublished and
display as unreleased.

```bash
curl -fsSL https://pancode.dev/install.sh | sh -s -- --channel beta
npm install -g pancode@beta
bun add -g pancode@beta
pancode upgrade --channel beta
```

```powershell
& ([scriptblock]::Create((irm https://pancode.dev/install.ps1))) -Channel beta
```

Upgrade and both installers resolve `beta` to the newest of `beta` and `latest`
by SemVer precedence. A missing `beta` tag falls back to stable. npm and Bun use their selected dist-tag;
publication forwards those tags to stable when they point lower. A bare upgrade
follows the managed installation's recorded channel, or uses `latest` for a
package-manager installation.

The installers read the channel's dist-tags with npm from their own work
directory, and `pancode upgrade` starts the installer or npm from the
directory it installs into. A project `.npmrc` in the directory you run them
from does not choose the registry; your user `~/.npmrc`, the global npmrc and
`npm_config_registry` still do. A channel that resolves to a version older than
the active one is refused before anything is installed. The one exception is
leaving a pre-release for the stable release, described below. To move down in
any other case, name the version with `--version`, or use `--rollback`.

Return to stable with `pancode upgrade --channel latest`. From a pre-release
that is newer than stable, such as a release candidate, `upgrade` installs the
lower stable version with one notice: it runs the installer that shipped with
the installed version and passes it `--leave-prerelease`.

Running the installer directly needs that flag for the same move
(`-LeavePrerelease` in PowerShell):

```bash
sh install.sh --channel latest --leave-prerelease
```

```powershell
.\install.ps1 -Channel latest -LeavePrerelease
```

Without the flag the installer refuses and names it:
`the latest channel resolved to <stable>, older than the active <version>; the installation was left unchanged. To leave the pre-release for stable <stable>, pass --leave-prerelease; to return to the previous install, use --rollback.`
The flag applies to the `latest` channel only. A stable install, another
channel, a recorded channel, background updates and a plain `pancode upgrade`
keep the refusal.

The hosted script at `https://pancode.dev/install.sh` downloads the
installer of the release its channel names, and for `latest` that is the newest
stable release's installer.

An explicit channel selection clears an installer's version pin.
Managed installs retain the previous
binary for `pancode upgrade --rollback`; rollback turns background updates off.
Global npm/Bun users reinstall `pancode@latest` with their package manager.

### The installer layout

| Path (Linux default) | Contents |
| --- | --- |
| `~/.local/share/pancode-install/runtime/node-v<ver>-<build>/` | The managed Node.js. macOS uses `~/Library/Application Support/pancode/install`, Windows `%LOCALAPPDATA%\pancode\install`; `--install-dir`, `PANCODE_INSTALL_DIR` or `PANCODE_HOME/install` override it. |
| `.../versions/<version>/lib/node_modules/pancode/` | One package prefix per installed version. The manifest names the current and previous ones, which always stay. See [Pruning](#pruning-versions-and-runtimes) for when the others go. |
| `.../install.json` | Manifest naming the Node, the current and previous prefixes, the launcher, the channel, any version pin, whether background updates are on, whether a package manager wraps the install, and whether the installer added the launcher directory to `PATH`. Activating a version is one atomic write of this file. |
| `.../launchers/` | The launcher's helper script. Each running launcher also writes one receipt under the state root's `launches/`, naming its install root, version and Node, which pruning and `uninstall` check before they remove anything; a launcher that cannot write it (a read-only state root) still runs. Receipts whose local process is gone are removed. |
| `.../.installer-owner`, `.../.install-lock/` | The ownership marker that stops an installer from claiming a directory that already holds `runtime/` or `versions/`, and the lock held while an install, rollback or uninstall runs. Each installer reclaims a lock on its own when this machine wrote it, the owner pid is gone and the lock is older than 10 minutes, which covers a lock an interrupted `pancode uninstall` or prune left behind. A lock held by a live process, a foreign host or a recent crash stops the run with exit status 75, and deleting only that directory once its owner has exited clears it. |
| `~/.local/bin/pancode` (`%USERPROFILE%\.local\bin\pancode.exe` and `pancode.launch` on Windows) | A small launcher that reads the manifest on each start and runs the managed Node on the current prefix. On Linux and macOS each activation points it at the current Node; on Windows it keeps the Node of the first install, because an install that started from an older `pancode.cmd` may still be running it and `cmd.exe` rereads a running `.cmd` file. |

#### Pruning versions and runtimes

Every activation (install, `upgrade`, a background update and `--rollback`) prunes the
install root with one rule on every platform. It keeps the current and previous
versions, a desktop manager's version, the launcher's helper and every version or
Node named by a live session receipt, a running build record, the desktop app's
background service, or a process of the current user that runs from the root
(`/proc` on Linux, `ps` on macOS, CIM on Windows). When that inventory is complete,
everything else goes at once, including a same-version reinstall. When it is not,
such as on a network filesystem or with an unreadable receipt, versions and runtimes
from the last seven days and the newest three stay. A file Windows has locked is
skipped and retried at the next activation. The installer prints what it removed and
kept, for example
`[install] removed 15 unused versions (2.8 GB), 0 runtimes; kept 0.9.1 (current), 0.9.1-rc.3 (previous)`.
To preview or run it by hand, under the install lock:

```bash
node ~/.local/share/pancode-install/versions/<current>/lib/node_modules/pancode/scripts/native-install.cjs \
  prune ~/.local/share/pancode-install --dry-run [--json]
```

The install root sits beside the data root rather than inside it, so
`pancode reset` and `uninstall --keep-config` never delete the Node that runs
them. The Node runtime adds about 210 MB to a version, and the optional Claude Agent SDK
component adds about 224 MB under the data root when it is provisioned. The installer
refuses to start with under 750000 KB (about 732 MB) free at the install root.

Repository development uses pnpm 10.34.5 and `pnpm-lock.yaml`. Registry
consumers install the built package and do not need the repository toolchain.
This guide describes the default directories, file purposes, permissions, and
lifecycle operations.

### Installer options

These are all the flags `install.sh` parses. Options that take a value also
accept the `--flag=value` form, and flags pass through `curl ... | sh -s -- <flags>`.
An unknown option stops the run with `[install] error: unknown option: <flag> (see --help)`
and exit status 1, as does every other installer failure except a held install
lock, which exits 75. `--help` exits 0.

| Flag | Environment | Effect |
| --- | --- | --- |
| `--version <spec>` | `PANCODE_VERSION` | An exact version such as `0.9.0` (a leading `v` is dropped) or a dist-tag of up to 32 lowercase letters, digits and hyphens that starts with a letter. Anything else is refused. An exact version pins the install. Default: the channel. |
| `--channel <name>` | `PANCODE_CHANNEL` | `latest` (default) or `beta`. |
| `--package <file.tgz>` | `PANCODE_PACKAGE` | Install a local `npm pack` tarball instead of the registry package. This pins the install. |
| `--node-version <v>` | `PANCODE_NODE_VERSION` | Node.js major such as `24` (default, newest 24.x) or an exact version. A version below 22.19.0 is refused. |
| `--node-tarball <file>` | `PANCODE_NODE_TARBALL` | A local Node.js tarball for airgapped sites. It must keep its release name, `node-v<ver>-<build>.tar.xz` or `.tar.gz`, with `SHASUMS256.txt` beside it or named by `PANCODE_NODE_SHASUMS`. |
| `--leave-prerelease` | none | With the `latest` channel, move from an active pre-release to the stable release even when stable is older. Without it a channel that resolves below the active version is refused. With any other channel or version the run stops with `--leave-prerelease only moves to the latest channel, not <name>`. `pancode upgrade --channel latest` passes it when you leave a pre-release. |
| `--refresh-runtime` | none | Download Node again even when the wanted one is already present. |
| `--install-dir <dir>` | `PANCODE_INSTALL_DIR` | The install root. Defaults: `$XDG_DATA_HOME/pancode-install` on Linux, `~/Library/Application Support/pancode/install` on macOS, `$PANCODE_HOME/install` when `PANCODE_HOME` is set. |
| `--bin-dir <dir>` | `PANCODE_BIN_DIR` | Where the `pancode` launcher goes. Default `~/.local/bin`. |
| `--include-claude-sdk` | none | Provision the optional Claude Agent SDK component, about 224 MB, with `pancode tools install claude-sdk` after the package installs. See [Lean install](#lean-install-the-claude-agent-sdk). |
| `--modify-path` | `PANCODE_MODIFY_PATH=1` | Append a `PATH` line for the bin dir to the shell startup file: `~/.zshrc` (or `$ZDOTDIR/.zshrc`) for zsh, `~/.bashrc` for bash, `$XDG_CONFIG_HOME/fish/config.fish` (default `~/.config/fish/config.fish`) with `fish_add_path` for fish, `~/.profile` otherwise. The line carries the marker `# added by pancode install.sh`, so a rerun does not add it twice. |
| `--no-modify-path` | none | Leave startup files unchanged. This is the default; the installer prints the line to add instead. |
| `--auto-update` | `PANCODE_AUTO_UPDATE=1` | Turn background updates on. They apply to unpinned installs only. |
| `--no-auto-update` | `PANCODE_AUTO_UPDATE=0` | Turn background updates off and record the choice. |
| `--rollback` | none | Point the launcher at the previous installed version. Needs the manifest and a complete previous install. Without `install.json` the run stops with `no installer manifest at <root>/install.json; nothing to roll back`. `--dry-run` prints `would roll back <root> from <current> (versions/<dir>) to <previous> (versions/<dir>)` and changes nothing. |
| `--no-post-install` | none | Skip the `pancode upgrade --post-install` run after installing. |
| `--gui` | `PANCODE_INSTALL_GUI=1` | Install the desktop app without asking. See [Desktop app offer](#desktop-app-offer-linux-and-wsl). |
| `--no-gui` | `PANCODE_INSTALL_GUI=0` | Skip the desktop app. |
| `--force`, `-f` | none | Replace a `pancode` launcher this installer did not write, including a symlink that points outside the install. A symlink into an npm install of PanCode is replaced without it, with a warning. |
| `--dry-run` | none | Print the platform, Node build, package, install root and launcher, then what would run. Nothing is downloaded or changed. |
| `-h`, `--help` | none | Print the usage text. |

The installer always runs `pancode tools install herdr --json`, as `install.ps1` does, which downloads PanCode's pinned herdr into its own data directory unless that version is already there. `PANCODE_TOOLCHAIN_MIRROR` points it at a local or internal copy. A failure there never fails the install; bare `pancode` then starts in the plain terminal, where `/panes` and `pancode doctor` name the fix, and never downloads on first launch, so run `pancode panes install` when you have network access. After an upgrade moves the pin, launch installs the new pin. A herdr on `PATH` is never used to host PanCode.

`install.ps1` takes PowerShell parameters with the same meanings. It has no GUI
parameter, no unofficial Node mirror and no forced Node build.

| Parameter | Environment | Effect |
| --- | --- | --- |
| `-Version` | `PANCODE_VERSION` | Same grammar as `--version`. |
| `-Channel` | `PANCODE_CHANNEL` | `latest` (default) or `beta`. |
| `-Package` | `PANCODE_PACKAGE` | A local `npm pack` tarball. |
| `-NodeVersion` | `PANCODE_NODE_VERSION` | Node.js major (default `24`) or exact version. |
| `-NodeZip` | `PANCODE_NODE_TARBALL` | A local `node-v<ver>-win-<arch>.zip`, with `SHASUMS256.txt` beside it or named by `PANCODE_NODE_SHASUMS`. |
| `-InstallDir` | `PANCODE_INSTALL_DIR` | The install root. Defaults: `$PANCODE_HOME\install`, else `%LOCALAPPDATA%\pancode\install`. |
| `-BinDir` | `PANCODE_BIN_DIR` | Where `pancode.exe` goes. Default `%USERPROFILE%\.local\bin`. |
| `-IncludeClaudeSdk` | none | Provision the optional Claude Agent SDK component. |
| `-AddToPath` | none | Accepted and redundant, because the installer already appends the bin dir to the user `PATH` registry value and to the current session. |
| `-NoModifyPath` | `PANCODE_MODIFY_PATH=0` | Leave `PATH` unchanged and print `PATH changes disabled; use the launcher commands below.` when the bin dir is not on `PATH`. |
| `-AutoUpdate`, `-NoAutoUpdate` | `PANCODE_AUTO_UPDATE` | As the `install.sh` flags. |
| `-Rollback` | none | Point the launcher at the previous version. Without `install.json` a real run fails before creating anything with `no installer manifest at <root>\install.json; nothing to roll back`. With `-DryRun` it prints `would point <launcher> back at the previous version recorded in <root>\install.json` and changes nothing. Run directly, it only moves the launcher; `pancode upgrade --rollback` runs it and also records an older restored version in `home.json` (see [Upgrades](#b-upgrades-pancode-upgrade)). |
| `-NoPostInstall` | none | Skip `pancode upgrade --post-install`. |
| `-LeavePrerelease` | none | With the `latest` channel, move from an active pre-release to the stable release even when stable is older. With any other channel or version the run stops with `-LeavePrerelease only moves to the latest channel, not <name>`. |
| `-RefreshRuntime` | none | Download Node again. |
| `-Force` | none | Replace a launcher the installer did not write. |
| `-DryRun` | none | Print the plan and change nothing. |

`install.cmd` has no options of its own. It passes its arguments to
`install.ps1`, so a CMD user writes PowerShell parameter names such as
`-Version 0.9.0`. Both installers end with the next step for this home, then `Desktop app: pancode gui`
(`install.sh` leaves that line out under `--no-gui`).
The next step is `PanCode <version> is installed.`, `Next:  cd <your project> && pancode` and one line
about the first launch, such as `The first launch sets up a model. Found: ANTHROPIC_API_KEY.` or
`Chat uses <target> / <model>.` While the launcher
directory is not on `PATH`, a closing line names the launcher's full path to run until it is.

An `install.ps1` failure writes one `[install] error: <message>` line to stderr; an exception that is not an installer refusal also gets the `[install] error:` prefix and appends the failing script position. Run with `-File` or through `install.cmd`, the process then exits 1. Under `irm | iex` the script never calls `exit`, so the caller's PowerShell session stays open and the error line is the only signal.

An exact `--version` or a `--package` records a version pin. A pinned install
keeps its version across a bare `upgrade` and background updates, and has
background updates off. Rerunning the installer without an exact version or
local package follows the selected channel and clears the pin. A new install that carries no pin, no `--no-auto-update` and no
`PANCODE_AUTO_UPDATE=0` turns background updates on. A rerun without those
inputs preserves the recorded choice.

#### Installer environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `PANCODE_VERSION`, `PANCODE_CHANNEL`, `PANCODE_PACKAGE`, `PANCODE_NODE_VERSION`, `PANCODE_NODE_TARBALL`, `PANCODE_INSTALL_DIR`, `PANCODE_BIN_DIR`, `PANCODE_MODIFY_PATH`, `PANCODE_AUTO_UPDATE` | `install.sh`, `install.ps1` | Defaults for the options in the tables above. A flag beats the variable. |
| `PANCODE_HOME` | `install.sh`, `install.ps1` | Selects `$PANCODE_HOME/install` as the install root when no directory is given. |
| `PANCODE_INSTALL_GUI` | `install.sh` | `1` or `0`, as `--gui` and `--no-gui`; unset asks on a terminal. Any other value stops the run with `PANCODE_INSTALL_GUI must be 1 or 0, got '<value>'`. |
| `PANCODE_INSTALL_ALLOW_SUDO` | `install.sh` | Any non-empty value lets root install when `SUDO_USER` is set. Without it the installer refuses to run under `sudo`, because it installs into the invoking home directory. |
| `PANCODE_NODE_MIRROR` | both | Base URL, `https://` or `file://`, laid out like `https://nodejs.org/dist`. |
| `PANCODE_NODE_UNOFFICIAL_MIRROR` | `install.sh` | The same for `unofficial-builds.nodejs.org`. |
| `PANCODE_NODE_SHASUMS` | both | `SHASUMS256.txt` for a local Node tarball kept elsewhere. |
| `PANCODE_NODE_KEYRING` | both | A local copy of the Node.js release keyring. |
| `PANCODE_REQUIRE_SIGNATURE` | both | `1` fails the install unless an OpenPGP signature on `SHASUMS256.txt` verified. Unset, both installers refuse a Node download in three cases: nodejs.org serves no `SHASUMS256.txt.asc`, a key outside the Node.js release keyring signed it, or the `SHASUMS256.txt.asc` nodejs.org served holds no signature the tool could verify. The error ends with `refusing to install. PANCODE_REQUIRE_SIGNATURE=0 relies on the checksum alone.`, and `0` accepts those three cases and installs on the HTTPS checksum. A signature that verifies as bad stops the install at any value. `install.ps1` verifies only when `gpgv` is on `PATH`. In every other case it states the reason before relying on the HTTPS checksum: `no gpgv on PATH`, `no SHASUMS256.txt.asc signature` (a mirror or a local zip), `the Node.js release keys could not be fetched` or `gpgv could not check the signature`, followed by `; verifying the checksum from SHASUMS256.txt over HTTPS`. |
| `PANCODE_NODE_BUILD` | `install.sh` | Force a Node build: `linux-x64`, `linux-arm64`, `linux-x64-glibc-217`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64` or `darwin-arm64`. |
| `PANCODE_INSTALL_MANAGER` | `native-install.cjs` | Records a wrapping package manager such as `winget` in the manifest. |
| `npm_config_registry`, `https_proxy`, `http_proxy` | `npm`, `curl`, `wget` | A package registry mirror and proxies for the downloads. |

The [HPC clusters](hpc-clusters.md) page covers mirrors, proxies and signature
checks in context. Background updates and `pancode upgrade` set
`PANCODE_NODE_VERSION` for the installer they run, and background updates also
set `PANCODE_BACKGROUND_UPDATE` and `PANCODE_BACKGROUND_CURRENT`; see the
[environment reference](environment-variables.md).

### Lean install: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk`, pinned to `0.3.292`, is not a dependency of the
published package. The build keeps it as a development dependency for types, and
`tsup` leaves it external. Its platform package carries a proprietary binary of
about 224 MB, and only the `claude-sdk` runtime uses it, so PanCode provisions
it as a separate per-user component in
`<data>/components/claude-agent-sdk/0.3.292/`, where `<data>` is the data root
`pancode paths` prints. Every install method works this way, and no
package-manager flag changes it. The component sits outside every version's
package root, so `upgrade` and background updates keep it. A PanCode version
that pins another SDK version provisions that version in its own directory beside
it.

Everything except the `claude-sdk` runtime works without the component: boot,
`pancode doctor`, and every other target and worker runtime. Nothing fails at
startup. `--include-claude-sdk` (`-IncludeClaudeSdk`) makes the installer run
`pancode tools install claude-sdk` after the package installs, and a failure
there fails the install with the previous launcher still active. Without the flag,
the component is needed when a `claude-sdk` target is configured or a
`claude-sdk` worker is dispatched, and at that moment
[claude-sdk-install.ts](../../src/domains/lifecycle/claude-sdk-install.ts) looks
for it in this order:

1. `PANCODE_CLAUDE_SDK_DIR`, an absolute administrator-prepared prefix holding
   `node_modules/@anthropic-ai/claude-agent-sdk`. It is never modified, and when
   it is set nothing else is consulted.
2. The per-user component above, then, inside a `pancode campaign run`
   entry, the operator's own copy, which the entry reads and never writes.
3. A package-local copy, such as the one in a development checkout.

When none resolves:

- **An operator who can answer.** The configure wizard, the line-prompt target
  setup and an attended dispatch ask once:
  `The Claude SDK runtime needs a separate component. Install it now?`
  The wizard and a dispatch offer **Install now** and **Not now**, and the line prompt
  takes yes or no; each defaults to declining. Accepting runs the Node that runs PanCode
 with its paired npm, `npm install --prefix <staging> --save-exact --omit=dev --include=optional @anthropic-ai/claude-agent-sdk@0.3.292`,
  in a staging directory beside the component with a 10 minute limit. PanCode checks that
  the package exports `query` and renames the staging directory into place. The
  command inherits the environment, so `https_proxy`, `http_proxy`, `no_proxy`,
  `npm_config_registry` and `NODE_EXTRA_CA_CERTS` apply. Parallel dispatches share one
  decision per component directory for the life of the process, including a decline
  or a failure.
- **Any other case.** A headless `pancode run --agent`, `pancode configure --runtime claude-sdk`
  with flags, and a declined offer have nobody to ask. The run or command fails with
  `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk@0.3.292. Run: pancode tools install claude-sdk. This installs a separate component at <data>/components/claude-agent-sdk/0.3.292; it does not change PanCode's installation.`
  (error code `CLAUDE_AGENT_SDK_UNAVAILABLE`). When `PANCODE_CLAUDE_SDK_DIR` is set
  and holds no SDK, the message names that prefix instead.

`pancode tools install claude-sdk` takes no extra arguments and no `--force`.
It prints `Claude SDK component available at <path>`, or `{"id":"claude-sdk","path":"<path>"}`
with `--json`, and does nothing when the component is already there. A managed install
uses the npm paired with its own Node; an unmanaged Linux install may use an `npm` on
`PATH`. PanCode never downloads Node or npm, so without one the command fails and
names `PANCODE_CLAUDE_SDK_DIR` as the other way in.

### Desktop app offer (Linux and WSL)

After a successful install, `install.sh` offers
`pancode gui background install` on Linux, which includes WSL, and on macOS. The offer is
skipped when the background app already reports `installed`. The default is to
ask, and only when stdout is a terminal and `/dev/tty` is readable, so a pipe
from `curl` with no terminal skips it. The prompt reads
`Add the PanCode desktop app? It starts at login and appears in your app menu. [Y/n]`,
or on macOS `Add the PanCode desktop app? It starts at login; open it with pancode gui. [Y/n]`.
Enter or `y` installs; anything else skips. `--gui` installs without asking and
`--no-gui` skips; `PANCODE_INSTALL_GUI` sets the same choice. A failed
install is a warning, not an installer failure:
`the desktop app was not set up. Retry with: pancode doctor --fix (verified service handover waits until active work finishes)`. The installer runs `pancode gui background install --handover`, which takes over a verified idle background app that another installation owns and keeps its address and credentials.

The installer does not echo the command's JSON report. After a successful
install it states the outcome in two lines. The first is
`desktop app installed; it starts at login and is in your app menu as PanCode, or run: pancode gui`,
on macOS `desktop app installed; it starts at login; open it with: pancode gui`,
or, when the report shows the Windows shortcut installed under WSL,
`desktop app installed; open PanCode from the Windows Start Menu or your app menu, or run: pancode gui`.
The second is `the desktop app uses PanCode's saved credentials; save a key that lives only in your shell with: pancode auth login <target>`.
The `origin` in the report from `gui background install` names the port the app
actually listens on, which is `7373` while another program holds `4343`.

On Linux the background app starts at login and appears in the app menu; under
WSL it also adds a Start Menu shortcut and a sign-in entry on Windows. On macOS it
starts at login as a launchd agent. Elsewhere the default offer is silent, and an
explicit `--gui` (or `PANCODE_INSTALL_GUI=1`) warns
`the desktop app runs as a login service on Linux and macOS only; start it here with: pancode gui`.
`install.ps1` has no GUI parameter. Both installers end with
`Desktop app: pancode gui`, which starts a private server for that terminal.
[The desktop app](gui.md) covers the app itself.

### Start, change settings, or recover

| Task | Command | Result |
| --- | --- | --- |
| Set up a new installation | `pancode configure` | Guided setup: choose the kind of model access you already have, select a discovered model, review what PanCode checked, then start `pancode`. |
| Change a connection | `pancode configure --section models` | Open Models to add or edit connections, credentials, and available models. |
| Choose models for each role | `pancode configure --settings` | Open Models, Workers, or Context and memory to choose the target and model used for that work. |
| Change any setting or repair YAML | `pancode configure --edit` | Edit a draft, validate, and save with a backup. |
| Diagnose the installation | `pancode doctor` | Read-only diagnosis. `pancode doctor --fix` repairs structure and permissions, and records fleet preflight results. |
| Review an available update in the TUI | `/upgrade` | Recheck the release, show exactly what is preserved, and ask before replacing an npm-global or installer install. It follows the channel an installer install recorded and leaves a pinned install alone. After success, PanCode asks you to exit and restart. A user-writable npm, pnpm, Bun or Volta install on Linux or macOS is not replaced under the running session: `/upgrade` arms the update to run after every session of that install has quit. |
| Finish a package-manager update | `pancode upgrade --post-install` | Apply the local installation checks. |
| Undo the last installer upgrade | `pancode upgrade --rollback` | Make the previous version current again and turn background updates off. A version pin moves to the restored version. |
| Start configuration over | `pancode reset --settings` | Delete `settings.yaml`, keep credentials and history, then print `pancode configure` as the next step. |
| Emulate a fresh user | `pancode reset --all` | Delete all four user roots and recreate the empty structure, then print `pancode configure` as the next step. |
| Remove PanCode | `pancode uninstall` | Remove the config, data, state and cache roots. It also removes the launcher, and for an installer install the managed Node and every version. |

Reset and uninstall preview their scope and ask for confirmation. Use
`--dry-run` to inspect without changing anything. Use `reset --settings` when your intent
is to start model setup over, and `reset --state` to clear sessions. Project
`.pancode/` directories survive these user-level operations.

The installers prepare the launcher and directory structure, then end with
`Next:  cd <your project> && pancode`. A new home starts `pancode configure` by itself on that
first launch. Neither installer asks you to configure delegation peers
before your primary model is set up. Upgrading preserves settings and
credentials; reinstalling the package alone does not reset them.

A launch never downloads the pane host into a home that never had it, which is
what an npm, pnpm or Bun install sees on its first launch. Bare `pancode` runs in
the plain terminal without a launch notice until you run `pancode panes install`;
`/panes`, `/files`, Alt+E and `pancode doctor` name that command meanwhile.
When an upgrade moves the pane host pin in a home that had panes, the next launch
installs the new pin once (`PanCode: setting up terminal panes (one time)...`).
If that fails, it says so once, continues in the terminal, and does not try again
for 24 hours; `pancode panes install` retries at any time.

A returning user whose home already exists but has no saved chat route is not
sent back through configure when a route can be detected; the contract is in
[configuration and targets](configuration-and-targets.md), and the code is
[detect-chat-routes.ts](../../src/cli/detect-chat-routes.ts). A saved chat route
that cannot be used is kept: with no model or a runtime that cannot drive the main
agent, startup exits 2 and names `pancode configure`, and with a missing
credential the session opens with that route unavailable. A new home starts
`pancode configure`.

---

## 1. Directory Layout & Platform Defaults

PanCode follows standard platform specifications for user configurations, databases, and caches, but allows full environment overrides.

### Platform Defaults
| Operating System | Config (`configDir`) | Data (`dataDir`) | State (`stateDir`) | Cache (`cacheDir`) |
| :--- | :--- | :--- | :--- | :--- |
| **Linux / Unix** | `~/.config/pancode` | `~/.local/share/pancode` | `~/.local/state/pancode` | `~/.cache/pancode` |
| **macOS** | `~/Library/Application Support/pancode/config` | `~/Library/Application Support/pancode/data` | `~/Library/Application Support/pancode/state` | `~/Library/Caches/pancode` |
| **Windows** | `%APPDATA%\pancode\config` | `%APPDATA%\pancode\data` | `%LOCALAPPDATA%\pancode\state` | `%LOCALAPPDATA%\pancode\cache` |

Run `pancode paths [--json]` to print the resolved table for the current environment.

### Environment Overrides
You can redirect PanCode's folders using environment variables:
*   `PANCODE_HOME`: Sets a symmetric tree: `$PANCODE_HOME/config`, `$PANCODE_HOME/data`, `$PANCODE_HOME/state`, and `$PANCODE_HOME/cache`.
*   `PANCODE_CONFIG_DIR`: Overrides the configuration directory only (takes precedence over `PANCODE_HOME`).
*   `PANCODE_DATA_DIR`: Overrides the data directory only (takes precedence over `PANCODE_HOME`).
*   `PANCODE_STATE_DIR`: Overrides the state directory only (takes precedence over `PANCODE_HOME`).
*   `PANCODE_CACHE_DIR`: Overrides the cache directory only (takes precedence over `PANCODE_HOME`).

On Linux an empty or relative `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` or `XDG_CACHE_HOME` reads as unset, as the XDG Base Directory specification requires.

The four resolved roots are ownership boundaries. They must be absolute,
distinct, non-nesting, and below the home directory. `PANCODE_HOME` set to the
home directory or above it is refused as well, because it would put the four roots
straight into the home. PanCode resolves existing symlinked parents while
checking this rule, so two spellings of the same directory are not treated as
separate roots. Bootstrap and upgrade refuse an unsafe layout before writing;
reset and uninstall refuse it before previewing or deleting. `pancode doctor`
shows the conflicting roles and paths. Correct the overrides rather than moving
files with a destructive lifecycle command.

### The Project `.pancode/` Directory

The tables above cover the per-user roots. A repository PanCode works in also grows a
`.pancode/` directory, and everything in it falls into one of three kinds:

*   **Operator input.** You wrote it. PanCode only reads it. Deleting it removes a
    behavior you configured and nothing else.
*   **Runtime state.** PanCode wrote it. It is derived from your repository and can be
    regenerated, though not always cheaply.
*   **Overlay.** You wrote it, and it composes with a directory PanCode ships. The
    overlay column below says how.

| Path | Kind | What it is | Safe to delete? | `context reset` |
| :--- | :--- | :--- | :--- | :--- |
| `.pancode/settings.yaml`, `.pancode/settings.local.yaml` | Operator input | Project settings layered over the user's `settings.yaml`. Precedence is built-in < user < project < project-local. | Yes; the user-level settings apply again. | Kept |
| `.pancode/safety.yaml` | Operator input | Per-repository command allowlist consulted before execute actions. | Yes; approvals return to per-action prompting. | Kept |
| `.pancode/hooks.yaml`, `.pancode/hooks.local.yaml` | Operator input | Project-declared hooks. | Yes. | Kept |
| `.pancode/rules/**/*.md` | Operator input | Path-scoped project rules injected into the prompt. | Yes. | Kept |
| `.pancode/profile.yaml` | Operator input | Operator profile; closed enums and bounded path lists. | Yes. | Kept |
| `.pancode/playbooks/*.md`, `.pancode/playbooks/commands.yaml` | Overlay | Playbooks the fleet runs and their command registry. Adds to the builtin playbooks that ship in the package. | Yes; builtin playbooks remain. | Kept |
| `.pancode/agents/*.md` | Overlay | Project agent recipes. Composes with shipped builtins and the user's `~/.config/pancode/agents`; a project recipe reusing a builtin id is **ignored**, not applied, with a note on stderr. | Yes; shipped agents remain. | Kept, and named |
| `.pancode/skills/**` | Overlay | Loose project skills placed here by the operator, trusted as repository-local. PanHub installs use the managed pack directory below. | Yes; loose skills must be restored by the operator. | Kept, and named |
| `.pancode/plugins/<name>/`, `.pancode/plugins/state.json` | Operator input | Installed plugin, skill, agent, prompt and playbook packs and their scoped state. `pancode hub install skill:<name> --project` installs here. They load only while their package identities are approved. An operator install into new or trusted state can approve its written identities; identical reinstalls, disables and removals preserve consent ([PanHub](panhub.md)). The bundled `hub/` remains the catalog source. | Use `pancode hub remove <kind>:<name> --project` to keep package state consistent. | Kept, not named |
| `PANCODE.md` (repository root) | Runtime state | The generated project handbook. Human-reviewable, but written by `context init`. | Yes; regenerate with `pancode context init`. | Kept unless `--all` |
| `.pancode/codemap.json` | Runtime state | Structural index, schema v5. | Yes; rebuilt by `pancode context index`. | **Removed** |
| `.pancode/state.json` | Runtime state | Index fingerprint and freshness stamps. | Yes; forces a rebuild. | **Removed** |
| `.pancode/proposals/` | Runtime state | Ignored handbook drafts from `context init --propose`. | Yes. | **Removed** |
| `.pancode/handoffs/` | Runtime state | Session handoff notes. | Yes. | **Removed** |
| `.pancode/wiki/` | Runtime state | The generated Markdown wiki plus `meta.json`. The most expensive artifact here: one model dispatch per page. | Yes, but regenerating costs a full `pancode context wiki` run. | Kept, and named |
| `.pancode/wiki-prev/` | Runtime state | Previous wiki, retained for rollback during generation. | Yes. | Kept, not named |
| `.pancode/worktrees/` | Runtime state | Git worktrees for task branches and `compete` candidate groups; `fleet.worktrees.root` can place local task trees elsewhere. | Prefer `git worktree remove`; a plain delete leaves git metadata behind. | Kept, not named |

`~/.config/pancode/runtimes/` holds third-party runtime plugins. It lives under the
user configuration directory, not in any repository.

None of `.pancode/` is published by PanCode's own package. The directories the package ships
(`src/domains/agents/builtins/`, the builtin playbooks, the whole `hub/` catalog
with its index, packs and skill provenance records, `src/domains/prompts/fragments/`,
`models/`) are read from the installed package root; the `.pancode/`
entries above compose with them and never replace them on disk. Builtin agent recipes bind
skills straight out of the package catalog; the operator's own session reaches the same
catalog only as a marketplace, through `pancode hub install skill:<name>` or `/skill <name>`.

---

## 2. File & Permissions Matrix

The core files are created automatically during the first run. `settings.yaml`, `credentials.yaml` and `home.json` are written owner-only (`0o600`). `doctor` reports a `settings.yaml` that is wider than owner-only as a warning and a `credentials.yaml` that is not `0o600` as an error, and `doctor --fix` tightens both. Session directories, transcripts, spilled tool output and `runs.json` are owner-only too (`0o700` directories, `0o600` files), and boot closes any state subdirectory that is group- or world-readable, without recursing. A home shared through a group loses that access at boot; share a session with `pancode telemetry share` instead. `doctor` warns when the state or data root is open to other users, and `doctor --fix` tightens a root that passes the ownership test `reset` uses. Other initialized files and directories use either the explicit mode shown below or the platform default produced by the writer and process umask. On Windows the mode checks do not run and the directory's ACL protects these files, except that before each `credentials.yaml` write the config directory is made owner-only (the current account and SYSTEM, inherited by new files) and the file itself is made owner-only after it; `doctor` warns when the file's ACL grants anyone else, reading it by SID so a localized Windows names no false principal, and `doctor --fix` reapplies both.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and interface preferences. | `0o600` (rw-------) | Removed by uninstall (unless `--keep-config`) and by `reset --settings`. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `pancode auth`. | `0o600` (rw-------) | Removed by uninstall (unless `--keep-config`) and by `reset --auth`. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **Config** | `workspace-trust/` | Project approvals from `pancode config trust`, one record per workspace. Operator decisions rather than disposable state, so they survive `reset --state` and `uninstall --keep-config`. | `0o600` (rw-------) | Removed by uninstall (unless `--keep-config`) and by `reset --all`. |
| **State** | `home.json` | Install metadata: PanCode version, node, platform, `installedAt` (written once at first install) or `repairedAt` (when metadata is reconstructed over a preexisting config, data, or state root), `upgradedAt` and `upgradedFrom` (stamped on a version change), `noticedVersion` (the version whose one-time upgrade notice the interactive launch has shown), and `containedYoloNoticedAt` (when the one-time contained-yolo notice was shown; the notice never writes `settings.yaml`). | `0o600` (rw-------) | Removed by uninstall / `reset --state`. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. At the cap a write evicts undecided proposals first; a record this build cannot read is dropped at the next store write. A store of another version is never touched and reads as an error. `doctor` names a partly unreadable store, and `doctor --fix` rewrites it without the records this build cannot read. | `0o600` (rw-------) | Removed by uninstall / `reset --data`. |
| **Data** | `tools/<id>/<version>/` | One pinned external program PanCode downloaded on request (`pancode tools install <id>`), with its upstream license text and a `pancode-install.json` recording url, sha256, platform and install time. Binaries `0o755`, documents `0o644`. Only the pinned version is kept: a successful install prunes the versions it supersedes. | `0o755` dir | `pancode tools remove <id>` deletes every version of one tool; removed by uninstall / `reset --data`. |
| **State** | `telemetry/{process,sessions,runs}/<id>/` | One telemetry scope per process, session and run: its hash-chained `journal.jsonl` segments (safety decisions, approvals and tool facts included), content-addressed `objects/`, and `bundle.json` once sealed. Beside them, `telemetry/consent.json` (research content consent) and `telemetry/install.json` (this installation's random id). See [Layout](../architecture/telemetry.md#layout). | `0o600` (rw-------) for journals, objects, seals and consent | `pancode telemetry prune --apply` applies retention; removed by uninstall / `reset --state`. |
| **State** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`, with spilled tool output beside them. | `0o700` directories, `0o600` files | Removed by uninstall / `reset --state`. |

---

## 3. Bootstrap Initialization

When PanCode boots (or after a reset), it calls `initializePancodeHome()` (see [init.ts](../../src/core/init.ts)) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates the four roots (`config`, `data`, `state`, `cache`) and their skeletons: `agents` under config, `memory` under data, and `sessions`/`interviews`/`scratch` under state. Telemetry creates `<stateDir>/telemetry/` on its first write.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config at `0o600`. An existing file is never read, validated, or rewritten by initialization, and no `settings.yaml.lock` is taken for it.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates a YAML file containing a managed-file comment and an empty object (`{}`), then locks its permissions immediately to owner-only read-write (`0o600`). An existing file takes no `credentials.yaml.lock`, so a boot over a set-up home creates no lock file in the config root.
4.  **Install Metadata**: Writes `home.json` with `installedAt` exactly once when no config, data, or state root existed before initialization. If PanCode reconstructs missing metadata over a preexisting config, data, or state root, it writes `repairedAt` instead of inventing an installation time. A cache-only root does not count as a preexisting home for this decision. A later version, platform, or node change preserves whichever original timestamp exists and stamps `upgradedAt`; a version change also records the previous version as `upgradedFrom`. When a newer PanCode last used the home, an older binary leaves `home.json` alone: the interactive start says so and asks before continuing (default no), and accepting records the downgrade so later starts do not ask. Headless `run` and ACP exit 2 instead unless `PANCODE_ALLOW_OLDER=1` is set, and `doctor` names both versions and every `pancode` on `PATH`. A `-dev` or `-rc` build of the same release does not count as older.

---

## 4. Source Checkout Install

Use the local source installer from the cloned repository:

```bash
git clone https://github.com/akougkas/pancode.git
cd pancode
pnpm run install:local
hash -r
pancode --version
```

[install-local.sh](https://github.com/akougkas/pancode/blob/main/scripts/install-local.sh) is idempotent and auditable. Its flags are `--skip-deps`, `--no-build`, `--dry-run`, `--force` (`-f`) and `--help` (`-h`); an unknown option exits 1. It:

- verifies `node` satisfies `package.json` `engines.node`;
- runs `pnpm install --frozen-lockfile` to sync dependencies with the workspace lockfile unless `--skip-deps` is passed;
- runs `pnpm run build` unless `--no-build` is passed;
- verifies `dist/cli/index.js` exists and is executable;
- creates `${PANCODE_BIN_DIR:-$HOME/.local/bin}` (a leading `~` or `~/` expands to the home directory) and symlinks `pancode` to `dist/cli/index.js` there, refusing to replace a non-symlink, and refusing a symlink that points outside the repository unless `--force` is passed;
- warns if that bin dir is not on `PATH`, and warns when another `pancode`
  earlier on `PATH` shadows the freshly linked one;
- runs `node dist/cli/index.js upgrade --post-install` and then
  `node dist/cli/index.js doctor --fix` with the caller's environment, so a fresh
  install passes plain `pancode doctor` with no manual steps. A failure in
  either step exits 1.

The script ends with `Verify the install you just made:` and the launcher it
linked, named by path (`<link path> --version`), because a bare `pancode` can
answer for an older install earlier on `PATH`. A `hash -r` or `rehash` hint
follows, then two closing lines: `Run: pancode` and
`Desktop app: pancode gui`.

On a machine where PanCode has never run, plain `pancode doctor` prints one
`WARN installation  not set up yet` row, exits 0, and creates nothing (it is a
read-only diagnosis, and an untouched home is not a broken one). Launching
`pancode`, running `pancode configure`, or `pancode doctor --fix`
creates everything; once any root exists, doctor reports each missing piece and
exits 1 until it is repaired.

First-run target setup after install:

**Option A: Local Model / API Key Target**
```bash
pancode configure --list
pancode configure --id local-lmstudio --runtime lmstudio --url http://localhost:1234 --model your-model --set-orchestrator --set-fleet-default
pancode targets use local-lmstudio
pancode targets --probe
pancode
```

**Option B: Subscription Target (OAuth / Claude Code)**
```bash
# Authenticate ChatGPT Plus/Pro or Claude Pro/Max subscription
pancode auth login openai-codex
pancode auth login anthropic-max

# Authenticate Claude CLI for worker targets
claude auth login

# Configure OAuth subscription target
pancode configure --id claude-sub --runtime anthropic-max --model your-claude-model --set-orchestrator

# Configure Claude Code SDK worker target
pancode configure --id claude-sdk-worker --runtime claude-sdk --model your-claude-model --set-fleet-default

pancode targets use claude-sub --orchestrator-model your-claude-model
pancode targets --probe
pancode
```

For a GitHub Copilot seat, sign in with the official Copilot CLI (`copilot login`) or the GitHub CLI (`gh auth login`); PanCode uses that login through the official Copilot SDK and never signs in itself:
```bash
pancode auth login copilot-sdk   # checks the login; in a terminal it offers to run `copilot login`
pancode configure --id copilot --runtime copilot-sdk --set-orchestrator
pancode auth status copilot-sdk
```

`pancode configure --runtime claude-sdk` exits 1 and prints the install command when the Claude Agent SDK is missing; see [Lean install](#lean-install-the-claude-agent-sdk).

If a shell still runs a `pancode` path that no longer exists, such as a removed
`~/.local/bin/pancode`, clear its command cache with `hash -r` in Bash or `rehash` in Zsh.

## 5. Lifecycle Commands

PanCode provides commands to manage these operations safely. For a complete catalog of operational errors, permission denial handling, and remediation procedures, see [troubleshooting.md](troubleshooting.md).

### A. Integrity Diagnostics (`pancode doctor`)
Runs a series of health sweeps across the environment:
*   Validates `settings.yaml` against the strict schema, reporting exact key paths, read-only.
*   Asserts owner-only permissions on credentials (`0o600`) and warns when `settings.yaml` is wider than owner-only.
*   Reports the installed PanCode, Node, platform, and engine package readiness.
*   Checks config, data, state, cache, and state metadata freshness. It also warns when an OpenAI-compatible or Anthropic-compatible target appears to be a native LM Studio or Ollama server that should be converted.
*   *Recovery:* Run `pancode doctor --fix` to create missing directories and templates, repair credential and settings permissions, refresh install metadata, and record fleet preflight results. Settings are always validated against the current schema, which reports any key outside it as unknown. `--fix` rewrites YAML 1.1 `on`/`off` booleans in place; it never removes or renames keys, so an unknown key needs deliberate editing. The rows, levels and exit codes are in [Doctor](doctor.md).

### B. Upgrades (`pancode upgrade`)
Replaces the package, refreshes state metadata and runs the installation checks.
```bash
pancode upgrade [--dry-run] [--channel=<latest|beta>] [--refresh-runtime] [--restart] [--json]
pancode upgrade --post-install [--dry-run] [--channel=<latest|beta>] [--json]
pancode upgrade --rollback [--dry-run]
```
`--channel` also takes a separate value (`--channel beta`). Without it an installer
install uses the channel recorded in its manifest and every other layout uses
`latest`. An unknown argument, a bad channel, an unsafe directory layout and the
flag conflicts below exit 2; a failed install or integrity check exits 1;
an install held by other processes exits 75;
a completed run, a dry run and a run that is already current exit 0. `--json` emits
one report document with `command`, `title`, `method`, `status`, `items`, `steps`,
`warnings`, `errors`, `advice` and `summary`.

On a source checkout, the command refreshes `home.json` and prints the checkout
path and source update steps. Fetch tags, choose the desired release, and run
`pnpm run install:local`; the installer runs `upgrade --post-install` and then
`doctor --fix`.

For npm global installs, `upgrade` derives the prefix from the running package,
including custom prefixes, and runs post-install checks through the exact installed
entry. Another launcher on `PATH` cannot take over those checks. An older dist-tag
does not trigger a downgrade. npm replaces the package in place, so on a prefix the
current user can write, `upgrade` first checks for other processes of the install.
While any other session, update lease or `pancode` process of the same root is
running it replaces nothing. It lists each holder as `pid@host`, prints the command
to rerun after they quit or to run `/upgrade` in a session to install after every
session quits, and exits 75. A held lease also stops a second `upgrade` from starting
in parallel, and SIGINT or SIGTERM stops npm before it releases the lease.

For an installer install, `upgrade` runs the installer that shipped with the
running package against the same install root and launcher directory. The new
version lands in a new prefix beside the old ones and must start before one
atomic manifest write makes it current, so a candidate that fails its checks
leaves the working version active. Post-install checks then run through the new
entry. The managed Node stays as it is unless you pass `--refresh-runtime`, which
moves to the newest Node LTS the installer picks.

The installer upgrade passes the recorded channel, install root and launcher
directory, a recorded version pin, `--no-auto-update` when background updates are
off, and `--no-post-install`, because `upgrade` runs the post-install checks
itself through the new entry. It sets `PANCODE_NODE_VERSION` to the recorded
runtime unless `--refresh-runtime` is given. It does not pass
`--include-claude-sdk`, and an SDK component already provisioned stays in place; see
[Lean install](#lean-install-the-claude-agent-sdk).

A bare `upgrade` honors a version pin from an exact installer `--version` or a
local `--package`. An explicit `pancode upgrade --channel latest|beta`
clears that pin and follows the selected channel. Rerunning the installer with
no exact version or local package also follows its channel and clears the pin;
`--version latest|beta` is an explicit way to do so. Add `--auto-update`
(`-AutoUpdate`) to turn background updates back on when they were disabled.
Source: `src/cli/upgrade.ts` and `scripts/install.sh`.

On a pinned install, `upgrade` prints `Pinned version: <X>` in place of the
`Available version` and `Channel` lines, then
`This install is pinned to <X> since <date> (<origin>); release with pancode upgrade --channel <channel>. Upgrade and background updates leave it there.`
and the installer command that follows the recorded channel again:
`sh <root>/scripts/install.sh --version <channel> --auto-update --install-dir <dir> --bin-dir <dir>`,
or `powershell ... -File <root>\scripts\install.ps1 -Version <channel> -AutoUpdate ...`
on Windows.

`pancode upgrade --rollback` makes the previous version current again after
checking that it starts, and turns background updates off until you turn them on
with the installer's `--auto-update`. It runs the installer's `--rollback` (`-Rollback`) and
needs an installer install: any other layout exits 2 with
`Rollback works only for native installer installs, made by install.sh or install.ps1`,
and an npm, pnpm or Bun layout also gets the owning manager's command. That command names
the exact version this home ran before its last version change, from `upgradedFrom` in the
state root's `home.json`, or `<version>` when none is recorded. An installer install with no previous version fails up front with
`No previous version is installed, so there is nothing to roll back to` and exits 1,
with or without `--dry-run`. Otherwise `--dry-run` prints
`Would switch the launcher from <current> to <previous> and turn background updates off.`
and exits 0. A real run relays the installer's lines,
`Rolled back to <previous>; <replaced> stays installed and another rollback returns to it`
and `Background updates disabled until explicitly enabled`, then notes that sessions
already running keep the old version and that `pancode --resume` in the project
picks one up on the restored version. When the restored version is older
than the one `home.json` records, a successful rollback also records it there as an accepted
downgrade, so the older version opens the home the newer one used without the newer-version prompt
and without `PANCODE_ALLOW_OLDER=1` for headless runs and ACP. Sessions are not converted back: a version
refuses a session in a newer format than it reads and asks for an upgrade. A rollback to a newer version (the second rollback
returning to the version just replaced) leaves `home.json` as it is, and that version's next start
records the upgrade. If the record cannot be written, a warning says the restored version will ask
first. A failed installer run exits 1 with
`Rollback failed; the active version is unchanged`. A version pin moves to the
restored version, so the next bare `upgrade` keeps that version, and the second line then ends with
`; pinned <version>`. `--rollback` cannot combine with `--post-install`,
`--refresh-runtime` or `--restart`.

Inside the TUI, `/upgrade` offers the same replacement for installer installs and for
an npm-global install it can replace, and an after-quit update for a user-writable
npm, pnpm, Bun or Volta install on Linux or macOS. It first checks that
the session is idle, then shows the current and available versions, package
prefix, preserved user data, and post-install checks. For an installer install it
follows the channel the install recorded (`beta`, otherwise `latest`), and
the approval text says the new version installs beside the current one under the
install root, the launcher switches, and the current version stays for rollback. For
an npm install it says the replacement touches only the npm package in the prefix.
Nothing is replaced until you choose **Upgrade now**. On success, a persistent
restart-required notice is shown and PanCode asks whether to exit now; start
`pancode` again and use `/resume`. Choosing **Not now** leaves the quiet update
reminder in place.

For an install that updates after quit, the choice is **Install after quit** instead.
The approval text says the package manager replaces the install in place, so it runs
only after this session and every other session of the install have exited. Choosing
it arms one detached wrapper for this session and reports how many other sessions it
will wait for. A second `/upgrade` while an update is pending reports that one is
already pending and starts nothing.

`/upgrade` leaves a pinned installer install alone. It prints
`This install is pinned to <X> since <date> (<origin>); release with pancode upgrade --channel <channel>, so /upgrade leaves it there. To follow its channel again, run:`
followed by the same installer command `upgrade` prints. A source checkout is told
`This source checkout updates through git, not the package registry. Run:` with its
git steps. Homebrew, winget, repository-local, unknown, and any pnpm or Bun installation whose prefix
the user cannot write receive their owner-specific shell instructions instead of an unsafe in-process replacement.

To update and return to the project from a shell, finish the turn, leave with
`/quit`, and run:

```bash
pancode upgrade --restart
```

Relaunch happens only after successful installation and checks. It starts the
installed PanCode in the current directory with no arguments, as a fresh session;
`pancode --continue` picks up the last conversation instead. `--restart` requires a terminal (exit 2 with
`--restart requires an interactive terminal; after upgrading, run pancode --continue in this project`)
and cannot combine with `--json`, `--post-install` or `--rollback`. A dry run never installs or relaunches.
If the relaunch itself fails the command exits 1 after reporting that the upgrade completed.

For pnpm, Bun, other package-manager, repository-local, and cached installations, first update
with the package manager that owns that installation, then run:

```bash
pancode upgrade --post-install
pancode doctor
```

`--post-install` applies the local checks without querying the registry or
reinstalling a package. Its `--dry-run` previews only those local operations.
It initializes missing home structure, then checks installation integrity
(engine runtime, directory layout, the four roots, `settings.yaml` and state
metadata); a failed check exits 1 and points at `pancode doctor --fix`.

When none of the config, data or state roots exists yet, which is a first
install, a real `--post-install` run creates the home before it checks it. The
home is then recorded as installed (`installedAt`) and reports no repair. A dry
run creates nothing.

Without `--post-install`, a pnpm, Bun, Homebrew, WinGet, local, or unknown layout is
never replaced through npm. A real run prints the owning manager's command and
exits 1 with `This installation needs a package-manager update; no package was replaced.`;
a dry run prints the same and exits 0. The commands are
`pnpm add -g pancode@<channel>`, `bun add -g pancode@<channel>`,
`brew upgrade pancode` and `winget upgrade --id PanCode.PanCode --exact`; an unknown
layout is told to use its original manager and then run
`pancode upgrade --post-install`. Keep the original manager's global directory or
prefix when updating or removing the package. On Windows, where npm, pnpm and npx are `.cmd` shims, PanCode starts them through `cmd.exe /d /s /c` and only with arguments `cmd.exe` cannot reinterpret; an update whose arguments would need quoting is refused instead of run. `doctor --fix` rebuilding a source checkout (`pnpm run build`) and `fleet nodes install` or `setup` packing this build (`npm pack`) launch them the same way. Package removal preserves PanCode's user configuration and
sessions; the uninstall operation below deliberately removes those roots.

After a successful upgrade, and when this state root owns the desktop app's
background service, `upgrade` runs `pancode gui background restart --if-idle` and
prints its one-line result. A failure there is a warning, not a failed upgrade.
A `--post-install` run does the same, so an installer that runs it on its own
restarts the app too; the post-install runs that `upgrade` starts leave the
restart to it, so the app restarts once.

Every installer upgrade lands in a new `versions/<version>` prefix, and two
versions of one installer install count as one installation when the app is
checked. A desktop app the previous version installed is therefore accepted by
`pancode gui`, `gui background restart` (which also re-pins the app's launch
paths to the running version), `reset` and `uninstall`. An app that belongs to a
different installation is refused: `reset` and `uninstall` stop with
`Background service belongs to another installation; PanCode state was left unchanged.`
and exit 1, and `gui` will not take it over.

An incomplete post-install step makes the bootstrap installer exit nonzero and
print `pancode upgrade --post-install` as the retry command. The package remains
installed and the previous version stays available through `--rollback`.

#### Tracking and moving between install methods

`pancode doctor`, `pancode paths` (the `tracking` row) and `pancode upgrade --dry-run`
say what an installer install follows, for example `follows latest` or
`pinned to 0.9.0 since 2026-11-24 (installed from a package file); release with pancode upgrade --channel latest`.

`pancode upgrade --post-install`, which every installer runs, tidies up after a move to
another method:

| Move | What post-install does |
| --- | --- |
| Installer to a source checkout, npm, pnpm or Bun | Names the installer root left behind with its size and the command `pancode uninstall --inactive`, and warns when that root's launcher still comes first on `PATH`. `pancode doctor` warns about the same root. |
| Any method, with the desktop app's background service installed from another one | Moves the app to this installation, as `pancode gui background install --handover` does. While it has active work the move is refused, and the command to run later is printed. |
| A newer version of the same installation | Prints `pancode gui background restart` for the background app. |

#### Upgrade notice

The first interactive launch after the recorded version changes shows one sticky
notice, `pancode: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.`,
and stamps `noticedVersion` in the state `home.json` so it appears once per
version. When the new version lists changes at the keyboard, the notice names them
after `What changed at the keyboard:` and ends with `Full notes: CHANGELOG.md, section <to>.`
It follows any version change, whether `upgrade`, a package manager or a
background update made it.

#### Quiet update hints

Interactive sessions start an update monitor after the first full frame and a
five-second delay. Registry requests have a 2.5-second timeout and are cached for
24 hours, including failed attempts, so an offline session stays quiet. They go to
the registry named by `npm_config_registry` or `NPM_CONFIG_REGISTRY` when it is an
`http` or `https` URL, so a mirror announces the version its own `npm install`
fetches, and to `registry.npmjs.org` otherwise. npm,
pnpm, Bun, Homebrew, winget and installer installs, and a source checkout at a release
version, check the `latest` tag. A release candidate also
reads `beta`, and an installer install reads the channel it recorded instead.
A source checkout on a `-dev` version, local or npx copies, unknown layouts and pinned
installer installs skip registry checks. A source checkout's notice reads
`v<version> available · pancode upgrade prints the git steps`, because it updates
through git. Installed files are also checked once a minute for
a version change or a rebuild since this process started.

When the build a running session started from is replaced on disk, the session
warns once, then keeps a short `build replaced · /restart` line in the footer
until the process ends, so `/restart` clears it. A feature whose code the
rebuild deleted shows the reinstall advice as a notice instead of a stack, and
the session keeps running. Over ACP the failed request carries the
`incomplete_installation` code and asks the client to restart the agent from the
editor. Every build, each `pnpm run dev` watch rebuild included, writes a fresh
id to `dist/build.json`. A rebuild does not empty `dist/`: hashed chunks
from earlier builds stay until no live process from that checkout still runs
the build that lists them. Each long-lived process records its build in
`dist/builds/holds/`, the last five builds keep their file lists in
`dist/builds/`, and the build deletes every other chunk, so with no session
running the result equals a clean build. A session that outlives a rebuild
therefore keeps loading its own features; workers, pane viewers and GUI
sessions started afterwards run the new build.
`node --import tsx scripts/build.ts --clean` empties `dist/` first, and `pnpm run build:release`, which release packages are built with, runs it that way; a session still running from that checkout can then miss a feature it has not loaded yet. In PanCode's
own source tree, running from that tree's build, the model is also told once
that the code it edited is not what runs and to `/restart` before verifying.

The result is one muted footer line, visible only when the editor is empty and
there is no turn, worker, local command, queued message, overlay, or other
notice. It hides during work, returns when the session is idle, and persists
until it is dismissed or `/upgrade` confirms the installation is current or
updated. It never opens a prompt, writes a conversation message, or sends a
desktop notification. Apart from the installer's background updates below, it
never starts an upgrade by itself. An update hint appears at most once per
session and once per day across sessions; the same version is suggested no more
than once a week. Cache records live under the resolved cache directory. The wording of the line depends on the install; see [Background updates](#background-updates).

Set `PANCODE_UPDATE_CHECK=0` or `NO_UPDATE_NOTIFIER=1` to disable the monitor,
and with it background updates. CI, headless runs, ACP, and CLI subcommands do
not start it. Explicit upgrades remain available when the monitor is disabled.

#### Background updates

`interface.autoUpdate` (default `true`) and `PANCODE_AUTO_UPDATE=0` decide whether
the monitor installs by itself. Neither disables the update notice. Installer
installs and package-manager installs update differently, because a package manager
replaces the install in place and a running session loads code lazily from it.

An installer install updates itself while the session runs. When the monitor
finds a newer release on the install's channel and the session is idle, it runs
the installer that shipped with the running package for that release, at most
once a day. The new version is installed beside the current one and activated
for the next start; the running session keeps its version, and the footer says
`Updated to v<version> · restart pancode to use it; this session keeps v<running>; upgrade --rollback undoes`.
Background updates skip the post-install checks, never edit `PATH`, keep the
managed Node, and need no administrator rights. If the install was pinned, opted
out, moved to another channel or updated by someone else while the update ran,
the new version is not activated. An installer run that finds the install lock
held (exit 75) is not recorded as a failure, and a later probe tries again.

An npm, pnpm, Bun or Volta install on Linux or macOS updates after the session
quits, never during it. The conditions are a user-writable package prefix, a
non-root user, no `sudo`, and an install that the package manager owns. While the
session runs the footer says `v<version> available · installs after you quit`, with
`; the last attempt waited for <holders>` when an earlier wrapper gave up. When the
session exits, PanCode starts one detached wrapper that waits until no process of that
install is left, runs the package manager for that exact version, and writes a result
file. The wrapper waits up to 30 minutes for other sessions, then gives up for that
quit, and caps the package-manager run itself at 10 minutes. `/upgrade` arms the same
wrapper on request. The next interactive launch reports the outcome once, as
`Updated to v<version> · installed by <manager> after your last session` or
`background update to v<version> failed (<detail>); log: <path>; run <command>`.
Windows, root, `sudo` and a prefix this user cannot write keep the plain notice
`v<version> available · <exact upgrade command>`. Homebrew and winget replace their own
installs, so their notice names `brew upgrade pancode` or
`winget upgrade --id PanCode.PanCode --exact`; a winget install ignores the version pin
its installer record carries, because winget owns that version.

A launch that starts while a wrapper holds the install waits up to 120 seconds for it
to finish, printing `PanCode is updating (<manager>); waiting…`. When the wrapper
is still running after 120 seconds the launcher exits 75 and names the wrapper's log.
`doctor` shows the auto-update state and the last background result; see [Doctor](doctor.md).

Background updates are off for a pinned install and after a rollback. Turn them
off with the installer's `--no-auto-update` (`-NoAutoUpdate`), which is recorded
in `install.json`, with `interface.autoUpdate: false`, or for one process with
`PANCODE_AUTO_UPDATE=0`. Turn the installer's recorded choice
back on with `--auto-update` (`-AutoUpdate`) on an unpinned install. With updates
off, the footer says `v<version> available · pancode upgrade to install` (with `--channel=<channel>`
after `upgrade` for a recorded prerelease channel) for installer installs.

### C. System Resets (`pancode reset`)
Selective recovery wipes:
```bash
pancode reset --state|--data|--cache|--auth|--settings|--all [--dry-run] [--yes] [--json]
```
Levels are combinable except `--all`, which exits 2 with `--all cannot be combined with --state, --data, --cache, --auth, or --settings`. With no level, reset exits 2 without touching anything, because a default would delete every transcript. Each level clears exactly the root or file it names and nothing else, then recreates the empty structure unless `--dry-run` is present. `--yes` (`-y`) skips the confirmation prompt and is required when there is no terminal to confirm on; without a terminal, `--yes` or `--dry-run`, the command exits 2 with `pancode reset: needs a terminal to confirm; pass --yes to skip the prompt`. A dry run never needs it. An unknown flag and an unsafe directory layout also exit 2. A declined confirmation exits 0; a failure to delete exits 1.

Before clearing state, reset stops and removes an owned background app service through its
ownership checks, and lists `Removed Background service` among the completed steps.
Independent desktop launchers remain installed. If this build does not include the
desktop app to verify the service with, or the service cannot be stopped, reset
exits 1 with `PanCode state was preserved` before deleting any user root; a dry run reports
the same limit and exits 0. Previews never stop processes. Reinstall the optional
background service explicitly if needed after a state reset.

Every run lists each root or file with its size, and the state root also shows
its first entries, all read off the disk on that run, before removing anything;
`--dry-run` prints the identical listing. That listing, not this page and not
`--help`, is the authoritative inventory of what a level covers, because a
remembered list drifts as soon as a new artifact is written into a root. The
roots and files that survive are listed too (`Survives: ...`). After a `--settings` or `--all` reset the command prints
`pancode configure` as the next step, and after `--auth` it prints
`pancode configure --section models`.

*   `--state`: Deletes the state root only. It holds every session transcript and the telemetry journals beside it, so a reset is the end of `resume`, `/view`, and their history. Project approvals live in the config root and survive it. Its preview carries that note.
*   `--data`: Deletes the data root only: memory, the project store (`store/`, every tag's blobs and records) and any vendored external tools (durable products). Stored blobs and records are not recoverable once deleted, so copy out what you need first; the [`store` tool's](tool-usage.md#store-keep-results-and-datasets-outside-the-working-tree) `get` gives each blob's path. Vendored tools can be fetched again: `pancode tools install <id>` downloads them again.
*   `--cache`: Deletes the cache root only.
*   `--auth`: Deletes `credentials.yaml` only. Removes all saved keys.
*   `--settings`: Deletes `settings.yaml` only, which reverts preferences to default. Credentials stay.
*   `--all`: Deletes all four roots whole (config with everything under it, data, state, cache) and recreates a fresh empty environment.

### D. Uninstallation (`pancode uninstall`)
`pancode uninstall` is the single uninstall path for every install method. It
removes all four roots (config, data, state, cache) and the launcher:

```bash
pancode uninstall [--keep-binary] [--keep-package] [--keep-config] [--keep-data] [--dry-run] [--yes] [--json]
pancode uninstall --inactive [--dry-run] [--yes] [--json]
```

Preview first, then remove:

```bash
pancode uninstall --dry-run
pancode uninstall --yes
hash -r
```

`--keep-config` preserves the whole config root (`settings.yaml`, `credentials.yaml` and anything else
in it) and `--keep-data` preserves the data root (memory, the project store and vendored tools). The cache and
state roots always go. `--yes` (`-y`) skips the confirmation prompt. Without a terminal, `--yes` or
`--dry-run`, the command exits 2 with `pancode uninstall: needs a terminal to confirm; pass --yes to skip the prompt`.
An unknown flag and an unsafe directory layout exit 2. A declined confirmation exits 0. A lock held by an installer,
another running session, an unverifiable desktop app installation or a failed delete exits 1.
`uninstall`, and `reset` with `--state`, `--data` or `--all`, stop with exit 1 while a session is still open on this state
root: one alive on this host, or one on another host whose heartbeat is under 180 seconds old. `--yes` does not override
this, and `--dry-run` lists the sessions and exits 0. Close them or run `pancode session terminate <id>`.

PanCode's private pane hosts (the herdr servers under the state root's `mux/` directory) are stopped
first on Linux and macOS; one that does not stop is listed as kept. Owned desktop app background services are stopped and disabled next, and their desktop launchers are
removed using the app's ownership manifests. A build that does not include the desktop app cannot verify them,
so uninstall leaves them and the state root's `gui` directory in place and prints
`pancode gui background uninstall && pancode gui launcher uninstall` to run from a build that has it.
A desktop launcher another installation wrote is listed as `belongs to another installation; kept`,
and the state root's `gui` directory stays with it.

An installer root this binary does not run from, left behind when the launcher moved to a
checkout or a package manager, is listed as `Inactive install` and removed the same way;
`--keep-binary` keeps it. `pancode uninstall --inactive` removes only such roots and the
installer launcher that still names them, and keeps every home, the running installation and
the desktop app. It refuses with exit 1 while a process runs from the root, naming each one
(`pid N (launched from it)`, or `pid N@host` for another host). It also refuses while the
desktop app's `server.json`, a `pancode-gui-*.service` unit or a `dev.pancode.*.desktop` entry
still starts from the root, names that file, and advises
`pancode gui background install --handover`. It cannot combine with a `--keep-*` flag. For an installer install, uninstall also removes the managed Node and
every installed version: only what the installer created inside the install root
(`runtime/`, `versions/`, `launchers/`, `.active/`, `install.json` and its ownership
marker), then the root itself if nothing else is left in it. It takes the
installer's lock first and refuses while another session started from that
install is still running (`Another native session (pid N) is still running; close it before uninstalling`).
The `PATH` block `install.sh --modify-path` appended for this launcher's directory, the
`# added by pancode install.sh` line and the exact `export PATH=...` or `fish_add_path` line
after it, is removed with the launcher and kept with it under `--keep-binary`. It is also kept,
under `Kept, and why`, while any other program shares that directory (pipx, uv and
`pip --user` install into `~/.local/bin` too and rely on the line). The edit changes only those
bytes, lands at the target of a symlinked startup file, and replaces the file through a synced
rename that keeps its mode and owner, so a failure leaves the original as it was. Any other line
in a shell startup file that mentions PanCode is reported as a `Shell config` row and never
edited. The candidates are the files `install.sh --modify-path` writes: `~/.bashrc`, `~/.zshrc`,
`$ZDOTDIR/.zshrc` when `ZDOTDIR` is absolute, `~/.profile`, and fish's `config.fish` under an
absolute `$XDG_CONFIG_HOME` or `~/.config`. A file is reported when it contains `pancode` or
`PANCODE`. On Windows, the user `PATH` entry `install.ps1` added is removed whenever its
manifest records `pathAdded`. On Windows, where a running `node.exe`
is locked, the launcher and runtime are removed a few seconds after the command exits.

For an npm global install on Linux or macOS, uninstall runs
`npm uninstall -g --prefix <prefix> pancode` last; `--keep-package` or
`--keep-binary` keeps the package. 
Every run ends with `Removed:` and `Kept, and why:` lists, which `--json` reports as `removed`
and `kept`.

`--dry-run` prints the roots and the optional launcher action without changing
anything, and enumerates the same resolved absolute paths the real run would
remove. It prints binary-removal guidance for the active launcher, npm-global
installs, npm links, and the local source symlink. When another `pancode` earlier on `PATH`
survives the uninstall, the run says so.

#### Per-project `.pancode/` directories

Uninstall removes the four roots under your home directory. The `.pancode/`
directory PanCode writes inside each repository it runs in is not one of them and
is never removed here. Every project is recorded in the session metadata under
the state root, so both the real run and `--dry-run` list the surviving
`.pancode/` directories and name the command that clears one:

```bash
pancode context reset --all
```

That command works on the current directory, so run it from inside each listed
project. The listing is printed before the roots are removed, because the record
it reads lives in one of them, and before the launcher is unlinked, because
`pancode context reset` needs the binary that is about to go. Clear the projects
first, or pass `--keep-binary`. Neither the preview nor the real run deletes project
data. To wipe state selectively
while keeping settings or credentials, use `pancode reset --state` instead of
uninstalling. If the launcher is already gone but state remains, run the
checkout's built entry directly: `node dist/cli/index.js uninstall --yes`.

#### What uninstall will and will not remove

Ownership is identity, not shape. `uninstall` and `reset` delete a root only when they can
prove it is PanCode's own: it is the platform default for its role, its directory is named
`pancode`, or it holds its role's file (`settings.yaml` for config, `home.json` for state,
and the `.pancode-root` marker PanCode writes when it creates a data or cache root).
The home directory, anything above it, `~/.local` and the shared XDG base directories
(`~/.config`, `~/.local/share`, `~/.local/state`, `~/.cache` or their `XDG_*` values) never
qualify. A root that fails the rule, for example `PANCODE_CONFIG_DIR=~/.config`, is not
touched: `uninstall` lists it under `Kept, and why` and `reset` reports it as a failure, and
both exit 1. `uninstall --dry-run` shows the same kept rows.

A `data` or `cache` root under `PANCODE_HOME` that has no marker, such as one that
already existed when PanCode first used the home (a scratch
allocation such as `/scratch/<user>/data`), counts as PanCode's only while every entry
in it is one PanCode creates there (`memory`, `tools`, `components` and `store` in data;
its own cache directories and files in cache). Anything else keeps the root, with the first
foreign entry named.

The launcher is removed only when it resolves
to *this* installation's own entry, `dist/cli/index.js` or the `bin/pancode.cjs`
guard that package managers link. The spelling of the target never qualifies it, so a
symlink into a different PanCode checkout, or a target that is not a file, is kept
and cannot strand another installation.

The launcher path is the one the installer manifest records for an installer install,
`bin/pancode` under the prefix for an npm global install, and
`$PANCODE_BIN_DIR/pancode` (default `~/.local/bin`) otherwise.

| At the launcher path | Outcome |
| --- | --- |
| A launcher script the installer wrote for this install root | Removed |
| A symlink resolving to this installation's entry | Removed |
| A symlink resolving to a different PanCode installation | Kept, with the path it points at and the exact `rm` that removes it |
| A symlink to a directory named `index.js` | Kept, because a directory is not an entry |
| A real file | Kept, with a note to remove it through the package manager that put it there |
| A dangling symlink naming a pancode entry | Removed, and reported as dangling. Leaving it would put a broken `pancode` on PATH after an uninstall that claimed to finish |
| A dangling symlink naming anything else | Kept, with the exact `rm` |

#### Partial failure

A recursive delete can stop halfway: an unwritable parent leaves some children
removed and some in place. `reset` and `uninstall` collect per-path failures
instead of throwing the first one. Every selected root still gets its attempt,
the skeleton is rebuilt, each surviving path is named with the reason it
resisted, and the command exits 1 with the exact invocation to rerun. Both
commands are idempotent, so the recovery is always the same: fix the permission
or release the handle, then run the identical command again and it resumes from
whatever is left. A partial delete never reports global success.

### E. Interactive Configuration (`pancode configure`)

`pancode configure` is the guided setup and the settings editor. Its launcher
(**Guided setup**, **Connect by endpoint**, **Settings**), the
seven settings areas and the first-run, add-target, edit-target and
cancellation paths are described in [configuration and targets](configuration-and-targets.md).
An unconfigured interactive `pancode` opens this launcher and continues into
chat after a successful setup.

```bash
pancode configure
pancode configure --quick
pancode configure --settings
pancode configure --section models
```

Lifecycle facts that belong here:

- `--section <area>` takes `models`, `chat`, `workers`, `context`, `safety`, `workspace`
  or `advanced`; any other value exits 2 with `unknown section` and the seven ids. Health
  checks are `pancode doctor`. Without a
  terminal it prints the area's values and exits.
- `--quick` needs a terminal. Without one it exits 2 with
  `--quick needs a terminal; use --id and --runtime for unattended setup`.
- `--json` emits the effective user settings, with defaults, as formatted JSON.
- `--edit` opens a temporary settings draft in `VISUAL`/`EDITOR`, validates it before
  saving, and keeps the previous file as `settings.yaml.bak`. It can repair a file that is
  too malformed to open the regular menu.
- Leaving first-run setup before any target is saved exits 130 with
  ``configuration cancelled; no target saved. Run `pancode configure` when you are ready.``
  A bare `pancode` launch reads that status as "nothing was configured".
- A version-1 settings file is not read or converted; move it aside and the next run
  writes a version-2 file with the defaults.

---

## 6. Residues Checklist for Manual Purging

If you are removing PanCode completely from your system, verify that all categories of residues are removed:

1.  **System Roots**:
    *   `~/.config/pancode`
    *   `~/.local/share/pancode`
    *   `~/.local/state/pancode`
    *   `~/.cache/pancode`
2.  **Local Source Bin Link**:
    *   `${PANCODE_BIN_DIR:-$HOME/.local/bin}/pancode`
3.  **Global Bin Links**:
    *   A pnpm or Bun global package: uninstall prints the manager's remove command. An npm global package is removed by uninstall unless you kept it.
4.  **Installer Root** (installer installs only; `pancode uninstall` removes it):
    *   `~/.local/share/pancode-install` on Linux, `~/Library/Application Support/pancode/install` on macOS, `%LOCALAPPDATA%\pancode\install` on Windows, or the `--install-dir` you chose.
    *   An installer root no longer in use after a move to another method: `pancode uninstall --inactive` removes it.
    *   Only lines you edited yourself in a shell startup file; uninstall removes the exact `PATH` block `--modify-path` added, unless other programs share the launcher's directory, and reports any other line that mentions PanCode.
5.  **Desktop App** (only if you installed it):
    *   Run `pancode gui background uninstall` and `pancode gui launcher uninstall`, which `uninstall` also does for an app whose ownership it can verify.
6.  **Per-Repository State**:
    *   `.pancode/` in every repository PanCode has worked in, and the generated `PANCODE.md` beside it. See [The Project `.pancode/` Directory](#the-project-pancode-directory) for what each entry is before deleting.
    *   Remove `.pancode/worktrees/` with `git worktree remove` rather than `rm -rf`, so git does not keep stale worktree metadata.

---

## 7. Headless and CI Execution Behavior

PanCode supports headless operation for automation and continuous integration.

When executing tasks headlessly using `pancode run`, interactive permission prompting is unavailable and the `ask_user` interview tool is not registered unless `--answers <file.yaml>` scripts the author's answers, and then it answers only extension interviews and `operator_only` questions while an ordinary `ask_user` call is refused ([Script the author with --answers](commands-and-modes.md#script-the-author-with---answers)). The engine resolves permission requests using a deterministic model:
- **Main-agent auto-denial:** At autonomy `default` the safety judge first reviews a call that would park, against the task prompt and nothing the agent wrote: an allow runs it and a block returns the judge's refusal. A main-agent call that still parks for operator authorization, because the judge gave no verdict or the ask is one only the operator answers, is denied with `pancode run cannot confirm permission requests; rerun interactively to approve this action.` At `yolo`, which a headless run takes only from `--autonomy yolo`, nothing parks. The parked call is cancelled with that reason, and the headless turn finishes according to the resulting assistant outcome. The headless session prompt states this up front: no operator is attached, approval-required calls are denied, and the model should use recognized commands and typed checks and report what could not run.
- **Worker non-stall policy:** Dispatched workers use `fleet.permissions.mode`. Under the default `judge`, the main session's safety judge decides a native local worker's ordinary ask while the run is at `default`, and `deny` applies wherever no judge can answer. `deny` turns a refused call into a structured tool denial that returns to the worker model, and the run continues. Only execute-class refusals count, including main-authority denials by the judge: the third one ends the run with worker exit 3 and outcome `failed/permission_required`, whose reason names every refused command. `fail` ends the run at the first refusal with the same outcome. The exit codes and the reason text are in [Exit codes and output](exit-codes-and-output.md).
- **CI behavior:** Neither path waits for an interactive prompt. Exit status still reflects the final headless or dispatch result rather than the mere fact that a permission ask occurred.

---

## 8. What the npm Package Ships

The published package carries PanCode's own TypeScript source and code map so
that it can answer questions about itself, but in compressed form:

- **Packed source.** Every `.ts` file under `src/`, except the extension scaffold
  templates in `src/domains/extensions/authoring/templates/`, is stored in one
  file, `dist/assets/source.pack`: an 8-byte `PANSRC01` magic, a 4-byte index length, a JSON
  index, and one brotli stream per file (`src/core/source-pack.ts`). Other files under
  `src/`, such as prompt fragments and recipes, ship loose. PanSDK, the public
  authoring surface, ships compiled with bundled declarations in `dist/sdk/` and is
  imported as `pancode/sdk/extension`, `pancode/sdk/testing`, `pancode/sdk/tool`,
  `pancode/sdk/pack` and `pancode/sdk/mcp-server` ([PanSDK](sdk.md)).
- **Code map.** PanCode's own code map ships gzipped as `dist/assets/codemap.json.gz`.
  `code_nav` with `source: "pancode"` reads it.

In an installed package, the `read` tool serves a packed file when the loose file
is absent from `src/`, and a packed directory still reads as a directory.
`code_nav` and the component inventory see packed files too. `grep`, `find` and
`bash` do not, and the session prompt says so in an installed package. A built
source checkout has a pack too, but its real files take precedence.

## 9. First-Use Downloads and Air-Gapped Hosts

A few optional assets are not in the package. PanCode downloads each one the first
time it is needed, checks it against a pinned sha256, and caches it under the
cache root (`src/core/pinned-asset.ts`). A file that fails the check is never
loaded.

| Asset | Fetched when | Source | Cache path | Bound |
| --- | --- | --- | --- | --- |
| Ruby and C# tree-sitter grammars | The code map first indexes a `.rb` or `.cs` file | `https://cdn.jsdelivr.net/npm/@vscode/tree-sitter-wasm@0.3.1/wasm/<file>` | `<cache>/grammars/@vscode__tree-sitter-wasm@0.3.1/<file>` | 5 s per download, connect included |
| HDF5/NetCDF-4 and Parquet readers (h5wasm, hyparquet) | The `data` tool first opens such a file | The pinned npm registry tarball | `<cache>/data-readers/<name>@<version>/` | 20 s per download |

The grammars for TypeScript, TSX, JavaScript, Python, Go, Rust, C, C++ and Java
ship in `dist/assets/grammars/` and need no network.

A failed grammar or reader download writes a `<path>.unavailable.json` record
beside the cache path. For 10 minutes no process on the host retries that asset,
so an air-gapped node pays the timeout once per window rather than once per
session. When the record cannot be written, as in an unwritable cache directory,
the next process tries again at once. A later successful download removes the record.

On a host with no network:

- Indexing still completes. Ruby and C# files fall back to line-pattern symbol
  extraction, and `code_nav` symbol and outline results carry a `grammarNote`
  saying those symbols come from line patterns, quoting the recorded failure, and
  recommending `grep` for an exhaustive search.
- The `data` tool refuses HDF5, NetCDF-4 and Parquet files with the URL, sha256
  and cache path to pre-seed, and names a `run_script` fallback. See
  [data](tool-usage.md#data-inspect-structured-files-through-the-gateway).
- A System One route bound to the `julia-1` engine fetches its 34 MB tokenizer
  from the published model repository, pinned by revision and sha256, with a
  120 s bound. Offline, PanCode keeps its byte-length check, which only makes that
  engine abstain more often.

To pre-seed an offline host, download the file on a connected machine and copy
it to the cache path in the table, under the cache root of the account that runs
PanCode. The hash is checked when it is loaded. Once a grammar is cached, the next
index update parses again the files that fell back to line patterns, even if
their content has not changed.
