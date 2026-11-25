## First problems

| You see | Do this |
| --- | --- |
| `pancode: command not found` after installing | Open a new shell, or run the `export PATH=...` line the installer printed last. |
| `<target> at <url> did not answer (...)` | Start the model server, or change the address with `/config`. |
| `<provider> has no key or sign-in stored.` or HTTP 401 | Run the `pancode auth login` command it names, or fix the key in `/config`. |
| `... reports no tool support` | Pick a model that calls tools with `/model`. |
| `shell sandbox` is `WARN` in doctor | On Linux, install `bubblewrap`. PanCode still works; more commands ask first. |
| A call was denied because nobody answered | Name the action in your request, or set `safety.unattendedAfterSeconds: 0` to wait for you. |

## A connection is unavailable

Start with these diagnostics:

```sh
pancode doctor
pancode targets --probe
```

Check that the selected endpoint is reachable, required credentials are present, and the model is loaded. A local server with an empty model list usually needs a model loaded before setup can finish. In **Connections**, reopen Guided setup or repair the saved connection.

For slow first responses from a local model, check the server's load state and capacity. Live tool-use behavior can be investigated with `pancode doctor --deep`; it makes generation requests.

## Settings fail to load

PanCode uses a strict version-2 settings schema. Invalid or retired keys produce a diagnostic naming the path. `pancode upgrade` applies the registered migration and preserves the original version-1 settings as a backup. Plain `pancode doctor` previews the fix for a retired value, and `doctor --fix` applies it.

Use [Configuration essentials](/docs/guide/configuration-reference.html) to find the settings layers and the full reference.

## A terminal shortcut does not arrive

Open **Ctrl+G** and choose the corresponding menu action. A terminal or multiplexer may intercept Alt shortcuts. **Ctrl+J** is the portable newline; `/help` shows your effective bindings.

If a files or companion pane is unavailable, run `pancode doctor` and read its `panes` and `external tool` rows. `pancode panes install` adds a missing pane host, and `pancode tools install yazi` adds the file browser. See [files and terminal panes](/docs/guide/panes-and-files.html).

## Work stopped or a check failed

Read the recorded command and output in the desktop's **Artifacts** card or terminal `/view`. A failed test can point to a useful next task; ask PanCode to explain the failure before changing the test's acceptance criteria.

For an interrupted context handoff, inspect `/context` and follow [save and resume work](/docs/guide/context-continuity.html).

## Report a problem to the maintainers

`/report` in the terminal and `pancode report` in a shell draft a bug report, a feature request or a question. `--last` adds what PanCode observed in the newest session in this folder.

```sh
pancode report bug --title "footer flickers on resize" --last --dry-run
```

You review the draft exactly as it will be posted. Local paths, user, host, project and branch names, e-mail and IP addresses, and secrets are masked first, and a draft that still holds this machine's names is refused. Nothing is sent until you press `s` in the terminal, answer the prompt in a shell, or pass `--yes`. `--dry-run` stops after the preview.

With a signed-in `gh`, PanCode searches GitHub for the same problem, then posts a public issue under your account. Without `gh` it opens a prefilled form in the browser. A diagnostic bundle is opt-in, encrypted for the maintainers, and shared only from your own shell. PanCode never sends anything on its own.

## Exit codes

Every `pancode` command uses the same exit codes, so a script can tell why a run stopped:

| Code | Meaning |
| --- | --- |
| `0` | Success, including `--help`, `--version`, and a `--dry-run`. |
| `1` | Operational failure: an unreachable model, unresolved doctor findings, or a worker whose changes were withheld or who did no work. |
| `2` | Usage error: an unknown command, flag, target, or agent, or a global flag placed after the subcommand. |
| `3` | A dispatched worker was stopped by its permission refusal limit (`permission_required`), or a headless yolo run ended after too many safety-judge blocks (`judge-streak`). |
| `4` | The priced spend ceiling was reached: `safety.limits.sessionCostUsd` (5 USD by default) or `run --max-cost-usd`. A headless yolo run that reaches its autonomous tool-call, time or token cap also exits 4. |
| `5` | `pancode run --answers <file.yaml>` met an author question the file does not script. |
| `75` | An install or upgrade is busy; nothing changed, so retry later. |
| `124` | `pancode run --timeout` elapsed. |
| `141` | The reader of a `pancode run` stdout closed, as in `pancode run ... \| head -1`. |
| `129`, `130`, `143` | Stopped by SIGHUP, SIGINT, or SIGTERM. |

A few commands, such as `fleet events`, `telemetry verify`, `research start`, and `arena run`, give small codes their own meaning; the full guide lists them. In a headless `pancode run`, the answer or JSON stream goes to stdout, while progress and diagnostics go to stderr. [Automate with pancode run](/docs/guide/exit-codes-and-output.html) has the details.
