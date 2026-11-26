<p align="center">
  <a href="https://pancode.dev"><img src="https://raw.githubusercontent.com/akougkas/pancode/main/assets/banner.webp" alt="PanCode: systems software for coding agents" width="100%" /></a>
</p>

# PanCode

**One harness for the models and coding agents you already use.**

PanCode is a harness for development work: Panos, its orchestrator agent,
plans your task, runs it on the models you connect and hands parts of it to
workers. It exists for what a single agent leaves open: routing across
providers, checking finished work against what actually ran, sandboxed
commands, memory that outlives a session, and fleets of agents. It works
beside the coding agents you already have and brings them under one harness
through ACP and delegation.

<p align="center">
  <a href="LICENSE"><img alt="PanCode License 1.0" src="https://img.shields.io/badge/license-PanCode%201.0-07e4b4?labelColor=000000&amp;style=flat-square" /></a>
  <a href="https://pancode.dev"><img alt="Website: pancode.dev" src="https://img.shields.io/badge/docs-pancode.dev-4aa8ff?labelColor=000000&amp;style=flat-square" /></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#your-first-task">First task</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://pancode.dev">Website</a>
</p>

## Get started

You need a model that supports tool calling. Linux, macOS and WSL are the
primary platforms. The installer downloads one verified archive that holds
PanCode and the Node.js it runs on, and needs no root:

```bash
curl -fsSL https://pancode.dev/install.sh | sh
```

On native Windows, run `irm https://pancode.dev/install.ps1 | iex` in
PowerShell. Windows has no command sandbox and the test suites run on Linux
only, so WSL is the recommended route.

The installer puts the launcher at `~/.local/bin/pancode`. If your shell
cannot find `pancode`, follow the installer's `PATH` instruction, then run
`command -v pancode` to see which file the bare name reaches.

<details>
<summary><strong>npm, building from source, HPC login nodes</strong></summary>

With Node.js 22.19 or newer already installed:

```bash
npm install -g @akougkas/pancode
```

From source, build the v0.9.0 release:

```bash
git clone --branch v0.9.0 https://github.com/akougkas/pancode.git
cd pancode
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/pancode" --version
command -v pancode
```

The installer supports x64 Linux with glibc 2.17 or newer, including HPC
login nodes. [HPC clusters](docs/guide/hpc-clusters.md) covers proxies, older
glibc, mirrors and air-gapped sites, and
[installation and lifecycle](docs/guide/installation-and-lifecycle.md) covers
upgrade, rollback, reset and uninstall.

</details>

## Your first task

Start PanCode in a project. The first launch connects a model: it offers what
it found on this machine, or you pick an API key, a subscription, a model
server or a setup file from your lab.

```bash
cd /path/to/your/project
pancode
```

Ask a read-only question first:

> Explain how this repository builds and runs its tests. Do not change files.

Then ask for one change with a finish line, such as the test that must pass:

> The test in tests/test_solver.py fails. Make the smallest fix, run the
> tests, show me the diff, and tell me anything you could not verify.

`/view` shows the evidence for the change, `/usage` what it cost, and
`/rewind` restores your files from the snapshot taken before it. The same
task runs from a script with `pancode run`, which prints the answer and exits
with a status your CI can read:

```bash
pancode run --read-only "Summarize this repository and how to run its tests."
```

## What you get

- **Terminal and desktop.** The terminal is the primary interface, and
  `pancode gui` serves a desktop app (alpha) from your machine on the same
  runtime, settings and sessions. [Commands and modes](docs/guide/commands-and-modes.md) · [Desktop](docs/guide/gui.md)
- **Panos and fleets of workers.** Panos dispatches bounded workers on this
  machine or on SSH nodes you have verified, and `pancode fleet run` runs a
  saved playbook as a fleet. [Fleet dispatch](docs/guide/fleet-dispatch.md)
- **Routing across any provider.** `pancode configure` connects local servers,
  lab gateways, cloud API keys and subscriptions such as ChatGPT, Claude and
  GitHub Copilot, and a 32K local model gets the same tools and checks as a
  frontier API. [Connect a model](docs/guide/configuration-and-targets.md)
- **Safety.** Commands run in an OS sandbox (bubblewrap on Linux,
  `sandbox-exec` on macOS), and a floor that no autonomy level removes refuses
  wiping your home directory or rewriting PanCode's own settings. [Sandbox and safety](docs/guide/sandbox-and-safety.md)
- **Verification.** A finished task is a claim that PanCode checks against
  the commands that ran, and `pancode run --verify "<cmd>" --fail-on-verify`
  exits 1 when the check fails. [Quality policies](docs/guide/quality-policy.md)
- **Memory.** PanCode keeps requirements, failed attempts and diagnoses in
  session memory, and `pancode memory` reviews the notes that outlive a
  session. [Proactive memory](docs/guide/proactive-memory.md)
- **PanHub packs and skills.** `pancode hub` installs plugins, skills, agents,
  prompts, playbooks and extensions, each pinned by a SHA-256 of its whole
  tree, with `/hub` or Alt+L in the terminal. [PanHub](hub/README.md)
- **PanKit, the agent toolkit.** PanCode ships MCP servers for node facts,
  software modules, Spack, Darshan I/O traces, scientific data, dataset
  catalogs and the project store, and `pankit` serves them to Claude Code,
  Codex or any other MCP host. [PanKit](packages/kit/README.md)
- **ACP beside other agents.** `pancode acp` serves PanCode to ACP editors, and
  Panos can delegate a task to an installed coding agent, and
  `pancode interop adopt` brings that agent's skills, agents and prompts in
  after review. [Interoperability](docs/guide/interop.md)

> **Pre-1.0.** Commands and settings can change between minor releases.

PanCode needs no account and sends nothing home. It is source-available and
free for individuals, small organizations, and noncommercial research and
teaching. See [License](#license).

## For AI agents: installing PanCode

If a user asked you to install or drive PanCode, every step here is
non-interactive.

```bash
curl -fsSL https://pancode.dev/install.sh | sh -s -- --no-gui
export PATH="$HOME/.local/bin:$PATH"
"$HOME/.local/bin/pancode" --version
pancode configure --list
pancode configure --id local --runtime ollama \
  --url http://127.0.0.1:11434 --model <model> --set-orchestrator
pancode doctor
pancode run --read-only "Summarize this repository and how to run its tests."
```

`pancode configure --list` names every runtime and what it needs, and
`--api-key-env <VAR>` names a key variable so no key is written down. For
GitHub Copilot, the user signs in with `copilot login` or `gh auth login`,
then `pancode tools install copilot-sdk` and
`pancode configure --id copilot --runtime copilot-sdk --model <model> --set-orchestrator`.
Subscription sign-ins, the interactive terminal, project trust and sending a
report are the user's to do. [Exit codes and output](docs/guide/exit-codes-and-output.md)
documents every `pancode run` flag, exit code and JSON field.

## Documentation

| You want to | Start here |
| --- | --- |
| Get productive in the first hour | [Documentation map](docs/README.md) |
| Install, connect, troubleshoot | [Installation](docs/guide/installation-and-lifecycle.md) · [Connect a model](docs/guide/configuration-and-targets.md) · [Troubleshooting](docs/guide/troubleshooting.md) |
| Run on a cluster | [HPC clusters](docs/guide/hpc-clusters.md) · [PanStore](docs/guide/panstore.md) · [PanKit](docs/guide/pankit.md) |
| Find a command or setting | [Commands and modes](docs/guide/commands-and-modes.md) · [Configuration reference](docs/guide/configuration-reference.md) · [Environment variables](docs/guide/environment-variables.md) |
| Script it | [Exit codes and output](docs/guide/exit-codes-and-output.md) · [Tool usage](docs/guide/tool-usage.md) |
| Define checks or coordinate workers | [Quality policies](docs/guide/quality-policy.md) · [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| Extend PanCode | [PanHub](docs/guide/panhub.md) · [Plugins](docs/guide/plugins.md) · [Extensions](docs/guide/harness-extensions.md) · [Extension API](docs/guide/sdk.md) · [Interop](docs/guide/interop.md) |
| Understand what PanCode may touch | [Sandbox and safety](docs/guide/sandbox-and-safety.md) · [Safety model](docs/architecture/safety-model.md) |
| Learn a word | [Glossary](docs/guide/glossary.md) |
| Explore the implementation | [Architecture](docs/architecture/architecture.md) |

The same guides, with tutorials and research pages, are on
[pancode.dev](https://pancode.dev/docs.html), and PanCode searches them for
you from inside a session.

## Contribute and get help

Questions are welcome as
[issues](https://github.com/akougkas/pancode/issues/new?template=question.yml). To ask one or
report a bug, run `/report` inside PanCode or `pancode report` in a shell: it
fills in your version and setup, masks private details, and shows you the
text before it is sent.

[Issues](https://github.com/akougkas/pancode/issues) ·
[Contributor guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## License

PanCode is source-available under the PanCode License 1.0. In plain words:

- PanCode is free to use for individuals, for small organizations (fewer than
  100 people and under 1,000,000 USD in yearly revenue), and for
  noncommercial research and teaching.
- Larger organizations need a commercial license from the author. One person
  may evaluate PanCode for such an organization for up to 32 days.
- Nobody may sell PanCode or offer it as a paid hosted service. Using PanCode
  to produce your own work, paid work included, is not selling it.

This summary is not the license. The full terms are in [LICENSE](LICENSE).

## Author

PanCode is written and maintained by Anthony Kougkas
([@akougkas](https://github.com/akougkas)). For a commercial license, write
to `a.kougkas@gmail.com`.

PanCode builds on the [Pi agent framework](https://github.com/earendil-works/pi),
[ACP](https://agentclientprotocol.com) and [MCP](https://modelcontextprotocol.io).
Its panes are powered by [herdr](https://github.com/herdrdev/herdr) (Apache-2.0),
whose license ships beside the installed binary. Dependency and component
notices are in [NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Copyright 2026 Anthony Kougkas.
