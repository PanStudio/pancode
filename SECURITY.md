# Security policy

PanCode is pre-1.0 software. Security fixes ship in the newest release, so
the first step for any concern is to update to it.

| Version | Status |
| --- | --- |
| `0.9.x` | Current line, starting with its release candidates. Security fixes land here. |

## Reporting a vulnerability

Please do **not** open a public GitHub issue or pull request for a
security problem, and do not send one with `/report bug`.

Report it through GitHub private vulnerability reporting on
`PanStudio/pancode`: open a draft advisory at
<https://github.com/PanStudio/pancode/security/advisories/new>. Only the
maintainer and you can see it. `pancode report security` prints the same
link and files nothing public.

A useful report includes:

- The affected version (`pancode --version`) or commit.
- The smallest reproduction or proof of concept you have.
- What you observed: information disclosure, code execution, privilege
  escalation, credential exposure, or a safety policy that did not hold.
- Whether it needs a specific runtime, target, model, platform or setting.

Remove secrets from logs and screenshots before sending. You do not need a
complete analysis to report; a clear description of what you saw is enough to
start.

## What to expect

- An acknowledgement within five working days.
- A coordinated fix. The maintainer shares a target date for the patch and,
  if you want it, credits you in the release notes.
- Public disclosure after a fix ships, unless you ask for earlier disclosure
  or the issue is already public.

## Scope

In scope:

- The `pancode` command and its subcommands, the terminal interface,
  headless `pancode run`, and the ACP server.
- The desktop app (alpha) and its local server: authentication, launch links,
  origin checks, session access and the background service.
- The installers, `pancode upgrade` and `pancode uninstall`.
- The OS sandbox and what it hides, the damage-control rules, approval asks,
  project trust and the project safety policy.
- Credential storage, redaction, and anything that could send a credential
  to a place the operator did not choose.
- Dispatched workers and fleet nodes, MCP servers, extension runtimes and
  delegation to other coding agents, including how their permissions are
  mediated.
- Reports, diagnostic bundles and encrypted shares.
- Session, run and telemetry records on disk.

Out of scope:

- Issues confined to an upstream project with no demonstrated impact on
  PanCode. Do report an exploitable problem in a dependency PanCode ships or
  an integration it provides, even when an upstream advisory already exists.
- Attacks that require an attacker who already has read or write access to
  the user's home directory.
- Bugs in third-party model providers or local model runtimes. Report those
  upstream.
- Social engineering and spam.

## Running PanCode safely

PanCode edits files, runs commands, dispatches workers and calls the model
endpoints you configure. Where the host has a sandbox backend (bubblewrap on
Linux, Seatbelt on macOS), it runs shell commands inside an OS sandbox under
`safety.sandbox`, which defaults to `auto`. The
[safety model](docs/architecture/safety-model.md) describes what the sandbox
hides and how approvals work, and each release's
[changelog](CHANGELOG.md) lists the known limits.

The sandbox narrows what a command can reach. It does not make an untrusted
repository safe to run unattended. Review a project's PanCode configuration
before you trust it, read an approval card before you answer it, and keep the
desktop app's launch links private. Do not paste API keys, private source or
proprietary prompts into public issues or pull requests; `/report` masks
paths, host names and secrets and shows you the text before it is sent.
