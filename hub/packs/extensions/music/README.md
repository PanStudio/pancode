# Music

Focus radio in a dock pane below PanCode, played by [cliamp](https://cliamp.stream), a terminal music player. `/music` and `Alt+A` show or hide the pane, and the player keeps running while the pane is hidden. The model never touches the player unless you turn that on with `/music agent on`.

Music is a first-party PanHub extension, installed, updated and removed on its own like any other pack:

```sh
pancode hub install extension:music
pancode hub update extension:music     # moves to the release's pinned copy
pancode hub remove extension:music
```

It plays only in an interactive session inside a herdr pane host. Bare `pancode` opens its own private pane host, and `pancode --with-panes` started inside a herdr pane joins that one. Headless runs, `pancode acp` and sessions without the pane layer have no music pane; `/music` there replies `music is unavailable: this session has no pane host; run PanCode inside herdr`.

## What it is allowed to do

The manifest is the consent. Installing the pack approves this envelope, and an update that grows it asks again:

| Capability | Why |
| --- | --- |
| `binaries: cliamp 1.63.2` | The player. The host downloads the release for this platform at install, checks its SHA-256 against the manifest, and keeps it in `<data>/tools/ext/music/`. Only that copy runs; a `cliamp` on `PATH` is never used. The upstream license is fetched beside it. |
| `services.pane` | One terminal pane in the dock below PanCode running cliamp. It shares the slot with the View dock and every other extension's pane, so opening one closes the others. |
| `keys: alt+a` | Show or hide the pane from anywhere in the session, and `Ctrl+G` then `a` from the leader menu. Refused, with the reason in `/extensions`, when another binding holds the key. |
| `commands: music` with `alias: music` | `/music`, also reachable as `/ext:music:music`. |
| `tools: music` (execute) | The model's control, refused until `/music agent on`. As an execute tool it goes through the session's approval and autonomy rules. |
| `permissions.net` | The Radio Browser station lookup. Streams are played by cliamp, which runs outside the runtime's sandbox. |
| `permissions.fs: store` | The player's private home and the store keys below. |

## The pane

The pane opens below PanCode with at least 18 rows, because cliamp draws its spectrum only from 16 inner rows and the pane border takes two. It asks for 5 percent of the window's height, so the floor decides its size. Opening or showing it never steals keyboard focus. The status line reads `music` while the pane is visible and `music (hidden)` while it is parked; when cliamp exits, a toast says so and `/music` starts it again. The pane closes when PanCode exits and when the pack is disabled or removed.

cliamp is launched with `--playlist pancode --auto-play` and driven over its own IPC with `cliamp play`, `pause`, `toggle`, `stop`, `next`, `load pancode` and `status --json`, each with a five-second timeout. No keystrokes are sent into the pane.

### The player's private home

cliamp reads `CLIAMP_CONFIG_DIR` before any other config location and keeps its socket, log and history there. The pack points it at `home/` inside its store directory (`<state>/extensions/music/files/home/`), so your own `~/.config/cliamp` is never read or written, and a cliamp you run yourself keeps its own socket.

| File | Content |
| --- | --- |
| `config.toml` | `theme = "pancode"`, `visualizer = "Bars"`, `vis_volume_linked = false` (so a quiet stream still moves) and `repeat = "all"`. |
| `themes/pancode.toml` | cliamp's six colors, from PanCode's palette for the detected terminal background. |
| `playlists/pancode.toml` | The chosen station, then the focus list. |
| `plugins/pancode-dock.lua` | A cliamp hook plugin that binds `alt+a` inside the player. |
| `plugins/.trust.json` | cliamp's own approval manifest. |
| `dock-taps` | The file the plugin appends a line to on each `Alt+A` pressed inside cliamp. |

The first four are rewritten whenever the pane opens, so a theme or station change lands on the next open.

### Alt+A inside cliamp

When the pane has focus, cliamp gets the keyboard, so PanCode does not hear `Alt+A`. The generated plugin binds the key inside cliamp and appends a line to `dock-taps`; the pane service watches that file and presses the same action, so the pane hides and the keyboard returns to PanCode. cliamp runs a plugin only after its exact contents are approved; the pack wrote the plugin, so when the SHA-256 in `.trust.json` differs it runs `cliamp plugins trust pancode-dock --yes`.

A first tap of `Alt+A` acts at once. A second tap within 400 ms stops the stream and closes the pane, as `/music off` does.

## /music

```text
/music [on|off|pause|next|status|station <name or url>|agent on|off]
```

| Form | Behavior |
| --- | --- |
| `/music` | Closed: opens the pane and plays. Hidden: shows it. Visible: hides it. Playback is unchanged when showing or hiding. |
| `/music on` | Plays, opening the pane or showing a hidden one first. A paused player resumes with `cliamp play`, a stopped one with `cliamp toggle`. |
| `/music pause` | Silences the stream and keeps the pane where it is. `/music on` resumes. |
| `/music off` | Runs `cliamp stop`, then closes the pane, hidden or not. |
| `/music next` | Skips to the next station; opens the pane like `on` when it is closed. |
| `/music status` | Says what is playing or paused, read from `cliamp status --json`. |
| `/music station <name or url>` | Plays that station and remembers it for every later session. With the pane open, the playlist is swapped with `cliamp load pancode` and the pane keeps its place. |
| `/music agent on` / `off` | Lets the model drive the player with the `music` tool, or stops it. Off by default; remembered across sessions. |

Results print as a toast: positive when playing or shown, neutral when paused, stopped or hidden, a warning when something failed.

### Stations

A URL (`http://` or `https://`) plays as given. A name matches the focus list first, by case-insensitive substring of the title. Any other name is looked up in [Radio Browser](https://www.radio-browser.info/) (`order=votes`, `reverse=true`, `hidebroken=true`, `limit=1`, five-second timeout) and the most-voted working match plays. That lookup is the pack's only network request of its own.

The station `/music on` plays is the one `/music station` last chose, else the manifest's `station` default, `http://radio.cliamp.stream/lofi/stream`. After it, the playlist repeats the focus list:

| Station | Stream |
| --- | --- |
| cliamp Lofi | `http://radio.cliamp.stream/lofi/stream` |
| REYFM Lofi | `https://listen.reyfm.de/lofi_320kbps.mp3` |
| Lofi 24/7 | `http://usa9.fastcast4u.com/proxy/jamz?mp=/1` |
| Box Lofi Radio | `https://stream.zeno.fm/tabzverz0fctv` |
| SomaFM Groove Salad | `https://ice1.somafm.com/groovesalad-128-mp3` |
| SomaFM Drone Zone | `https://ice1.somafm.com/dronezone-128-mp3` |

All are MP3 streams, which cliamp decodes without ffmpeg. The macOS release of cliamp loads FLAC, Vorbis, Ogg and mpg123 from Homebrew, which `brew install bjarneo/cliamp/cliamp` brings along and the pinned copy does not.

## The music tool

Main sessions reach it as `extension_music__music` through the gateway. It takes `action`, one of `on`, `pause`, `off`, `next` or `status`, and does what `/music` does with the same words. Choosing a station and showing or hiding the pane stay with you. Until `/music agent on`, every call returns the error `music: the operator has not allowed the model to drive music (/music agent on)`; outside a pane host it returns the same reason `/music` gives.

When PanCode plays music is your call, written in the project's instructions, for example "start the music pane when a long test run begins and stop it when the run ends".

## Failures

| Situation | Reply |
| --- | --- |
| No pane host | `music is unavailable: this session has no pane host; run PanCode inside herdr` |
| cliamp was not downloaded | `cliamp 1.63.2 is not installed; reinstall the extension (pancode hub install extension:music)` |
| The window is too small for 18 rows | The pane service's reason, prefixed `the music pane:`. |
| Profile files cannot be written | `could not write the player profile: <error>` |
| cliamp is still starting or not answering | `cliamp is not answering; the pane may still be starting` |
| A control command fails | `cliamp next failed: <error>`, `cliamp load failed: <error>`, `cliamp pause failed: <error>` or `cliamp could not resume: <error>`, in cliamp's own words. |
| Station lookup fails | `Radio Browser answered HTTP <status> for "<name>"`, `no station named "<name>" in Radio Browser` or `station lookup failed: <error>` |
