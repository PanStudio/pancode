## Install

You need a model with tool calling. Linux, macOS and WSL are the primary platforms; native Windows is best effort. Every command below installs the latest release. Choose the tab for your system.

::: tabs Install method
### macOS, Linux and WSL

```sh
curl -fsSL https://pancode.dev/install.sh | sh
```

The installer brings its own Node.js 24 and needs no root, including on x64 HPC login nodes with glibc 2.17 or newer. It checks the Node download against its published SHA-256 checksums, and their OpenPGP signature when `gpg` is installed. It installs under `~/.local/share/pancode-install` on Linux or `~/Library/Application Support/pancode/install` on macOS, and writes the launcher `~/.local/bin/pancode`.

On Linux, an install run from a terminal ends by offering the desktop app, which starts at login and appears in your app menu. The optional Claude Agent SDK, about 224 MB, is skipped; PanCode offers to fetch it the first time you need it.

Pass options after `sh -s --`. For example, `--modify-path` adds the launcher directory to your shell profile, `--gui` sets up the desktop app without asking, and `--include-claude-sdk` installs the SDK now:

```sh
curl -fsSL https://pancode.dev/install.sh | sh -s -- --modify-path
```

On a cluster, read [Install on a cluster](/docs/guide/hpc-clusters.html).

Commands PanCode runs are sandboxed with bubblewrap on Linux and WSL. On macOS they run under `sandbox-exec`, whose profile has not yet been verified on a real Mac. See [Sandbox and safety](/docs/guide/sandbox-and-safety.html).

### PowerShell

Native Windows is best effort, so use the current stable release. Release checks only start the package on Windows, Windows has no command sandbox, and WSL with the macOS, Linux and WSL command is the better-tested route. The install needs no administrator rights, brings its own Node.js 24, and adds the launcher to your user `PATH`.

```powershell
irm https://pancode.dev/install.ps1 | iex
```

PowerShell shows `PS C:\>` at the prompt. If `curl ... | sh` reports that `sh` is not recognized, you are in Windows rather than WSL.

### CMD

The same best-effort install, started from CMD.

```bat
powershell -NoProfile -Command "irm https://pancode.dev/install.ps1 | iex"
```

CMD shows `C:\>` without the `PS`. If you see `'irm' is not recognized as an internal or external command`, you ran the PowerShell command in CMD; use the command above.

### npm

With your own **Node.js 22.19 or newer** on `PATH`:

```sh
npm install -g pancode
```

### bun

```sh
bun add -g pancode
```

bun installs the package, but `pancode` still runs on Node.js, so it needs **Node.js 22.19 or newer** on `PATH` too.
:::

## Confirm the installation

Open a new terminal and run:

```sh
pancode --version
```

It prints the installed version. If the shell says `pancode: command not found`, the launcher directory is not on your `PATH` yet. Add the line the installer printed to `~/.bashrc` or `~/.zshrc`, or install again with `--modify-path`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`command -v pancode` shows which file the name runs. If it is not `~/.local/bin/pancode`, an older install comes first on your `PATH`; remove it or reorder `PATH`. `pancode doctor` checks the installation and connections.

## Open a project

```sh
cd /path/to/your/project
pancode configure
pancode
```

On first launch, **Guided setup** asks what you have: an API key, a subscription, a model server or gateway, or a setup file from your lab or team. It sends the model one short test request and saves when the model answers. PanCode has no account of its own; your provider may require credentials and charge for inference.

A new installation starts guided setup by itself, so `pancode configure` is optional. If you have used PanCode before and no chat route is saved, it looks for a route it can use, such as a provider key in your environment, and opens chat with it. A model server found on a local port is used only after you say yes.

`/config` opens your connections inside a session, where **Add a target** runs setup again.

Prefer the desktop alpha? It is served from your own machine, opens in your browser, and shares the terminal's saved connections and settings. See [the desktop app](/docs/guide/gui.html):

```sh
pancode gui --open
```

The browser has its own **Guided setup**; configuring in the terminal first is optional.

## Update, roll back and remove

Installer installs update themselves in the background, at most once a day. On Linux and macOS, npm, pnpm, bun, and volta installs whose prefix you own update after an interactive session quits and no other process of that install remains. Set `interface.autoUpdate: false` or `PANCODE_AUTO_UPDATE=0` to keep only the notice. `/upgrade` reviews an update from inside the terminal. From the shell, update with the tool that installed it:

| Installed with | Update | Remove the program |
| --- | --- | --- |
| Installer | `pancode upgrade`. The new version installs beside the current one and must start before the launcher switches to it. | `pancode uninstall` |
| npm | `pancode upgrade` | `npm uninstall -g pancode` |
| bun | `bun add -g pancode@latest`, then `pancode upgrade --post-install` | `bun remove -g pancode` |

The installer keeps the previous version. `pancode upgrade --rollback` makes it current again. An install made with an exact `--version` stays pinned to that version until you run the installer with `--version latest`.

If an upgrade is refused over a setting the installed version cannot repair, the installer prints the new version's own `doctor --fix` command to run.

`pancode uninstall` removes your settings, credentials, sessions and caches, the launcher, the desktop app's background service, the managed Node and every package version of an installer install, and the package of an npm global install. It previews what it will delete and asks first, and it stops with exit 1 while a session is open on this state directory. Add `--keep-binary` to keep the program, `--keep-config` to keep settings and credentials, or `--dry-run` to only look. Removing the program with npm or bun keeps those files. Project `.pancode/` directories are never removed.

If pancode.dev is unreachable, the latest GitHub release carries the full installer, at `https://github.com/akougkas/pancode/releases/latest/download/install.sh`.

## Give PanCode a useful first task

Start with a read-only question:

> Explain how this repository builds and runs its tests. Do not change files.

Then ask for one change with a finish line, such as the test that must pass:

> The test in tests/test_solver.py fails. Make the smallest fix, run the tests, show me the diff, and tell me anything you could not verify.

`/view` shows the evidence for the change, `/usage` what it cost, and `/rewind` restores your files from the snapshot taken before it. The same task runs from a script, which prints the answer and exits with a status your CI can read:

```sh
pancode run --read-only "Summarize this repository and how to run its tests."
```

Follow the [desktop and terminal walkthrough](/tutorials/desktop-and-terminal.html), or try [a numerical change with seven tests](/tutorials/temperature-calibration.html).

## Keep going

- [Connect a model](/docs/guide/configuration-and-targets.html): setup, model selection, and saved settings.
- [Commands and shortcuts](/docs/guide/commands-and-modes.html): the controls you'll use most.
- [Tools and permissions](/docs/guide/tool-usage.html): understand changes and review checks.
- [Check your installation](/docs/guide/doctor.html): diagnose a connection or setup problem.

## When you need more detail

These web guides cover the essentials. Detailed documentation ships with PanCode; ask it to look up the bundled guide for the feature you're using. Each page also links to its full source guide.
