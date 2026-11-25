Two people can work in one project folder with PanCode, and so can you in two terminals. What they share is the folder: its files and the project settings committed under `.pancode/`. Each session, its transcript, its credentials and its approvals stay with the person who started it, and the project settings can make PanCode stricter for everyone but never looser.

::: note Version scope
The output below is from PanCode run against a fresh PanCode home and a new Git repository; paths are shortened to the default layout.
:::

::: needs
- PanCode installed for each person, in their own account.
- A project folder each of you can open: a shared filesystem, or a clone of the same repository.
:::

## Open a second terminal

Run `pancode` in the folder from a second terminal while the first is still open. The second launch never joins the first one's session. It prints:

```text
PanCode: this folder already has a PanCode in another terminal; this one has its own panes.
```

It then starts its own private pane host, with its own session and its own docks. A folder can have up to four pane hosts at once. A fifth terminal runs without panes, still with its own session, until one of the four exits.

The two sessions see each other's work only as changed files on disk. Give each one a different part of the tree, and read `git diff` before you commit what either produced.

## Keep your state yours

Each person's sessions, transcripts and approvals live in their own PanCode home, never in the project. `pancode paths` shows where:

```text
config   /home/you/.config/pancode
data     /home/you/.local/share/pancode
state    /home/you/.local/state/pancode
cache    /home/you/.cache/pancode
project  /home/you/lab-model
```

These directories are created owner-only (`0700`), and session transcripts are under `state/sessions`. On a shared machine, keep `PANCODE_HOME` and the state directory out of shared project space. If a state directory is open to other users, `pancode doctor` says so:

```text
WARN state dir mode         /home/you/.local/state/pancode is 755: group or other users can enter it and read session transcripts (run `pancode doctor --fix`, or `chmod 700` it when the directory is not PanCode's alone)
```

`pancode doctor --fix` closes it and reports `tightened to 700`.

## Commit project settings that only tighten

`.pancode/settings.yaml` holds settings for everyone who opens the folder. Here a project lowers the session spending ceiling and tries to loosen two other controls:

```yaml title=.pancode/settings.yaml
version: 2
safety:
  autonomy: yolo
  limits:
    sessionCostUsd: 2
    chatToolCallsPerTurn: 200
```

Nobody's PanCode reads this file until that person approves it. Run `pancode config trust settings` to see the captured bytes and the command that approves exactly those bytes:

```text
Review the captured files above. Approve exactly these bytes with:
pancode config trust settings --hash 8917fe3bce74889bee87a978044311d803678e1ae96dbd6f19d3af95c796a061
```

After the approval, `pancode config inspect` shows what the project actually changed:

```text
! settings project: /home/you/lab-model/.pancode/settings.yaml: safety.autonomy: project autonomy may only tighten the level in user settings; project value ignored
! settings project: /home/you/lab-model/.pancode/settings.yaml: safety.limits.chatToolCallsPerTurn: a project may only tighten a limit from user settings; project value ignored
safety.limits.sessionCostUsd = 2  [project]
```

The lower spending ceiling applies. `yolo` and the higher tool-call limit were dropped, because the user's own settings allow less. A project can tighten `yolo` to `default`, never the reverse, and the same rule covers the sandbox, snapshots, worker permissions and every safety and fleet limit.

::: result What the approval covers
The approval is yours, for this folder and these bytes. It is stored in your config directory, so a teammate approves the same file separately. If the file changes, PanCode ignores it again until each of you reviews the new bytes.
:::

## Keep personal overrides out of Git

`.pancode/settings.local.yaml` is a second project layer for overrides of your own. The first time PanCode generates a file in `.pancode/`, it writes an allow-list `.pancode/.gitignore` that keeps `*.local.yaml` and generated files out of Git while authored settings, skills and rules can be committed.

Project layers never carry credentials. Keys such as `auth`, `apiKey`, `token`, `secret` and `password` are dropped with a diagnostic, and a project target that points at a URL is never sent your stored or environment keys. Each person keeps their key in their own settings or credential store.

::: limits
- Approval is per person, per interface and per folder. Approving settings does not approve the project's hooks, safety rules, extensions or plugins.
- Two sessions in one folder do not coordinate their edits. Split the work, and review the diff before committing.
- A pane host per terminal is verified on Linux only.
:::

::: next
- [Settings layers and project trust](/docs/guide/configuration-and-targets.html)
- [Panes and the pane host](/docs/guide/panes-and-files.html)
- [Connect PanCode on an HPC login node](/docs/guide/hpc-clusters.html)
:::
