## Add a file browser or companion shell

The terminal can open a files pane, a live workers dashboard, logs, a shell, an extension's pane, or an installed coding peer beside the conversation.

Bare `pancode` in an interactive terminal opens its own private pane host with no question to answer. The host is a pinned copy of **Herdr** that the installer provisions. When the host is not installed, PanCode starts in the plain terminal without a notice, and `/panes`, `/files`, and Alt+E name `pancode panes install`.

After an npm or bun install, add the pane host yourself. The file browser is a separate install either way:

```sh
pancode panes install
pancode tools install yazi
```

To join a Herdr session of your own as a guest, open a pane in your project, then run:

```sh
pancode --with-panes
```

The option joins the current Herdr session. It does not create a pane host from a plain terminal. For the files pane, also enable it in your PanCode settings:

```yaml
interface:
  panes:
    files:
      enabled: true
```

Check `pancode doctor` if the host or files engine is unavailable.

## Use the files pane

`/files` or **Alt+E** opens the file browser and gives it keyboard focus. Select a file and press **Ctrl+Y** to insert it as an `@file` mention and return focus to PanCode. `/files` or Alt+E then hides the pane: the browser keeps running and keeps its directory. Press the key twice quickly, or run `/files close`, to end it.

## Docks hide instead of closing

The files and workers panes are docks with fixed places. **Alt+E** and **Alt+W** show or hide them, and a second press within a moment closes one. Alt+W opens a dashboard with a card for each worker in the session; Enter follows one worker's live stream.

An installed extension can open its own pane below the conversation, in the `extension` dock. The music extension pack, installed with PanCode, plays focus radio there with `/music` or **Alt+A**.

| Command | Companion pane |
| --- | --- |
| `/panes open shell` | A login shell in the workspace |
| `/panes open logs` | The newest dispatched run's event journal |
| `/panes show <run-or-agent>` | A live worker view |
| `/panes peer <agent> [brief]` | An interactive coding-agent handoff |

A session started inside tmux, Zellij, or screen stays in the plain terminal without panes. For editor and agent connections, see [interoperability](/docs/guide/interop.html).
