PanCode in the terminal can open panes of its own beside the conversation: a file browser below and a live view of workers on the right. Each is a dock. One key shows or hides it, and hiding keeps it running. Herdr, a terminal multiplexer, hosts the panes.

::: note Version scope
Bare `pancode` in an interactive terminal opens its own private pane host, with no question to answer. The files dock is off until you enable it. Keys, commands, and settings may change. The pane host has builds for Linux, macOS, and Windows x64; elsewhere PanCode runs in the plain terminal.
:::

::: needs
- The pane host. The installer provisions it and a launch after an upgrade installs the new pin. After an npm or bun install, or when the installer could not fetch it, run `pancode panes install`; until then PanCode starts in the plain terminal and says so once.
- Yazi for the files dock: `pancode tools install yazi`.
:::

## Turn panes on

Panes are on whenever the terminal allows them. Start PanCode in your project:

```sh
pancode
```

It opens its own pane host and hands the terminal back when you quit. The host is PanCode's own pinned copy of Herdr; a Herdr of yours on `PATH`, with its config and sessions, is never used or touched.

Inside your own Herdr session, bare `pancode` opens its host nested in that pane; `pancode --with-panes` joins your session as a guest instead. A session started inside tmux, Zellij, or screen stays in the plain terminal with no docks: `/files` becomes a one-time full-screen picker and Alt+W opens the worker list inside PanCode.

## Two docks, one habit

::: compare
| Dock | Key | Where it opens | Also enable |
| --- | --- | --- | --- |
| Workers | Alt+W | Right of the conversation | Nothing |
| Files | Alt+E | Below | `interface.panes.files.enabled` |
:::

Press the key once to show a dock and again to hide it. A hidden dock moves to a parked tab and keeps its state: the file browser stays in its directory. Press the key twice quickly to close the dock and end its program. Quitting PanCode closes both.

Drag a divider to resize a dock; the size is kept when you hide and show it. A dock never takes more than half the window, and one that cannot fit says how much room it needs. `/panes` prints which docks are visible, hidden, or closed. The same keys are under Ctrl+G, then `w` or `e`.

## Pick files with Yazi

`/files` or Alt+E opens Yazi and moves the keyboard into it. Select files and press Ctrl+Y. PanCode appends them to your draft as `@path` references and returns you to the composer without sending anything. One pick carries up to 32 paths.

Yazi runs on a profile and theme that PanCode generates, so your own Yazi configuration is untouched. Set `interface.panes.files.profile: user` to use yours instead. `/files hide` and `/files close` do what the key does.

## Watch workers live

Alt+W opens a dashboard with one card per worker in this session: the agent and task, its state, the model, tool calls against its budget, tokens, cost when it is known, and what the worker is doing now. Running workers come first.

Move with the arrow keys and press Enter to fill the dock with one worker's live stream; Escape returns to the cards. `q` hides the dock. The dashboard only reads recorded run files, so it cannot change a run, and it does not open by itself when a worker starts.

::: limits
- As a guest in your own Herdr, docks need a recent protocol; an older Herdr can open panes but cannot hide them.
- `/panes peer <agent> [brief]` opens another coding agent in a pane for you to work in. It is a handoff with no run record.
:::

::: next
- [Files and terminal panes guide](/docs/guide/panes-and-files.html)
- [Coordinate the coding agents you already use](/tutorials/coordinate-your-coding-agents.html)
- [Work from a laptop with remote workers](/tutorials/work-from-a-laptop-with-remote-workers.html)
:::
