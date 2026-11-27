import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionApiV2,
	ExtensionBinaries,
	ExtensionContextV2,
	ExtensionOutputV2,
	ExtensionPane,
} from "pancode/sdk/extension";

/** One playable station: what the player shows and what it opens. */
interface Station {
	title: string;
	url: string;
}

/**
 * Focus stations `/music next` cycles through after the chosen one. All are
 * MP3 streams, which cliamp decodes without ffmpeg, and each one played in
 * cliamp 1.63.2 when this list was written.
 */
const FOCUS_STATIONS: ReadonlyArray<Station> = [
	{ title: "cliamp Lofi", url: "http://radio.cliamp.stream/lofi/stream" },
	{ title: "REYFM Lofi", url: "https://listen.reyfm.de/lofi_320kbps.mp3" },
	{ title: "Lofi 24/7", url: "http://usa9.fastcast4u.com/proxy/jamz?mp=/1" },
	{ title: "Box Lofi Radio", url: "https://stream.zeno.fm/tabzverz0fctv" },
	{ title: "SomaFM Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3" },
	{ title: "SomaFM Drone Zone", url: "https://ice1.somafm.com/dronezone-128-mp3" },
];

/** Radio Browser's round-robin host; it redirects to a live mirror. */
const RADIO_BROWSER_SEARCH = "https://all.api.radio-browser.info/json/stations/search";
const PLAYLIST = "pancode";
const THEME = "pancode";
const PLUGIN = "pancode-dock";
/** cliamp draws its spectrum only from 16 inner rows up, and the pane border takes two more. */
const PANE_ROWS = 18;
const AGENT_KEY = "agentControl";
const STATION_KEY = "station";

type Result =
	| { status: "playing"; title: string | null; opened: boolean }
	| { status: "paused"; title: string | null }
	| { status: "stopped" }
	| { status: "shown" | "hidden"; playing: boolean; title: string | null }
	| { status: "failed"; reason: string };

function describe(result: Result): string {
	switch (result.status) {
		case "playing":
			return `${result.opened ? "music pane opened, playing" : "playing"}${result.title ? ` ${result.title}` : ""}`;
		case "paused":
			return `music paused${result.title ? ` on ${result.title}` : ""}; /music on resumes it`;
		case "stopped":
			return "music stopped and the pane closed";
		case "shown":
			return `music pane shown${result.playing && result.title ? `, playing ${result.title}` : ""}`;
		case "hidden":
			return `music pane hidden${result.playing ? ", still playing; /music off stops it" : ""}`;
		case "failed":
			return result.reason;
	}
}

function tone(result: Result): "positive" | "neutral" | "warning" {
	if (result.status === "failed") return "warning";
	return result.status === "playing" || result.status === "shown" ? "positive" : "neutral";
}

function isStreamUrl(value: string): boolean {
	return /^https?:\/\/\S+$/iu.test(value);
}

function titleForUrl(url: string): string {
	const known = FOCUS_STATIONS.find((station) => station.url === url);
	if (known) return known.title;
	try {
		const parsed = new URL(url);
		const tail = parsed.pathname.split("/").filter(Boolean).pop();
		return tail ? decodeURIComponent(tail) : parsed.host;
	} catch {
		return url;
	}
}

/**
 * A URL plays as given, a name matches the focus list first, and anything else
 * is looked up by name in the Radio Browser directory (most-voted working
 * match). The lookup is the only network call here, and it runs only for a
 * station the focus list does not have.
 */
async function resolveStation(input: string): Promise<Station | { error: string }> {
	const wanted = input.trim();
	if (wanted.length === 0) return { error: "name a station or paste a stream URL" };
	if (isStreamUrl(wanted)) return { title: titleForUrl(wanted), url: wanted };
	const needle = wanted.toLowerCase();
	const local = FOCUS_STATIONS.find((station) => station.title.toLowerCase().includes(needle));
	if (local) return local;
	const query = new URLSearchParams({ name: wanted, order: "votes", reverse: "true", hidebroken: "true", limit: "1" });
	try {
		const response = await fetch(`${RADIO_BROWSER_SEARCH}?${query.toString()}`, {
			// Radio Browser asks every client to identify itself.
			headers: { "User-Agent": "pancode-music/0.1.0" },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) return { error: `Radio Browser answered HTTP ${response.status} for "${wanted}"` };
		const body: unknown = await response.json();
		const first = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
		const url = typeof first?.url_resolved === "string" && first.url_resolved ? first.url_resolved : first?.url;
		if (typeof url !== "string" || !isStreamUrl(url)) return { error: `no station named "${wanted}" in Radio Browser` };
		const title = typeof first?.name === "string" && first.name.trim() ? first.name.trim() : titleForUrl(url);
		return { title, url };
	} catch (error) {
		return { error: `station lookup failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function writeIfChanged(file: string, content: string): void {
	try {
		if (readFileSync(file, "utf8") === content) return;
	} catch {
		// First write.
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** What music needs from the host, present only in an interactive session inside herdr. */
interface Player {
	context: ExtensionContextV2;
	pane: ExtensionPane;
	binaries: ExtensionBinaries;
	storeDir: string;
	/**
	 * The player's private home inside this extension's store. cliamp reads
	 * `CLIAMP_CONFIG_DIR` before any other config location and keeps its IPC
	 * socket there, so the operator's own `~/.config/cliamp` is never touched and
	 * a cliamp they run themselves keeps its socket.
	 */
	home: string;
}

/** The player, or why music cannot play here in one line. */
function player(context: ExtensionContextV2): Player | string {
	const { pane, binaries, storeDir } = context;
	if (!pane || !binaries || !storeDir)
		return "music is unavailable: this session has no pane host; run PanCode inside herdr";
	return { context, pane, binaries, storeDir, home: join(storeDir, "home") };
}

const tapFile = "home/dock-taps";

function renderPlaylist(stations: ReadonlyArray<Station>): string {
	return stations
		.map((station) => `[[track]]\npath = ${JSON.stringify(station.url)}\ntitle = ${JSON.stringify(station.title)}\n`)
		.join("\n");
}

function playlist(first: Station): Station[] {
	return [first, ...FOCUS_STATIONS.filter((station) => station.url !== first.url)];
}

/**
 * Lua for the one key bound inside the player: Alt+A appends a line to a file
 * PanCode watches, and PanCode treats it as the same key pressed outside.
 */
function renderPlugin(tapPath: string): string {
	return `-- Generated by the PanCode music extension. Changes are replaced and need approval again.
local p = plugin.register({
    name = ${JSON.stringify(PLUGIN)},
    type = "hook",
    permissions = {"keymap"},
})
p:bind("alt+a", "Hide the music pane and return to PanCode", function()
    cliamp.fs.append(${JSON.stringify(tapPath)}, "tap\\n")
end)
`;
}

async function cliamp(player: Player, args: string[]): Promise<{ ok: boolean; stdout: string; error: string }> {
	const result = await player.binaries.run("cliamp", args, {
		env: { CLIAMP_CONFIG_DIR: player.home },
		timeoutMs: 5_000,
	});
	const ok = result.exitCode === 0 && !result.timedOut;
	return {
		ok,
		stdout: result.stdout,
		error: ok ? "" : (result.stderr || result.stdout).trim() || "cliamp did not answer",
	};
}

async function playerStatus(player: Player): Promise<{ state: string; title: string | null } | null> {
	const result = await cliamp(player, ["status", "--json"]);
	if (!result.ok) return null;
	try {
		const parsed = JSON.parse(result.stdout) as { state?: unknown; track?: { title?: unknown } };
		return {
			state: typeof parsed.state === "string" ? parsed.state : "unknown",
			title: typeof parsed.track?.title === "string" ? parsed.track.title : null,
		};
	} catch {
		return null;
	}
}

/** Rewrites every generated file, so a theme or station change lands on the next open. */
async function writeProfile(player: Player, stations: ReadonlyArray<Station>): Promise<void> {
	const home = player.home;
	const palette = await player.pane.palette();
	writeIfChanged(
		join(home, "config.toml"),
		`# Generated by the PanCode music extension.\ntheme = "${THEME}"\nvisualizer = "Bars"\nvis_volume_linked = false\nrepeat = "all"\n`,
	);
	// The spectrum climbs low to mid to high; the accent marks what is selected.
	writeIfChanged(
		join(home, "themes", `${THEME}.toml`),
		[
			`accent = "${palette.accent}"`,
			`bright_fg = "${palette.strong}"`,
			`fg = "${palette.text}"`,
			`green = "${palette.low}"`,
			`yellow = "${palette.mid}"`,
			`red = "${palette.high}"`,
			"",
		].join("\n"),
	);
	writeIfChanged(join(home, "playlists", `${PLAYLIST}.toml`), renderPlaylist(stations));
	const plugin = renderPlugin(join(player.storeDir, tapFile));
	writeIfChanged(join(home, "plugins", `${PLUGIN}.lua`), plugin);
	const hash = createHash("sha256").update(plugin).digest("hex");
	let trusted = false;
	try {
		const manifest = JSON.parse(readFileSync(join(home, "plugins", ".trust.json"), "utf8")) as {
			plugins?: Record<string, unknown>;
		};
		trusted = manifest.plugins?.[PLUGIN] === hash;
	} catch {
		// No approval yet.
	}
	// The extension wrote the plugin, so it answers cliamp's approval prompt for it.
	if (!trusted) await cliamp(player, ["plugins", "trust", PLUGIN, "--yes"]);
}

async function chosenStation(player: Player, input?: string): Promise<Station | { error: string }> {
	if (input !== undefined) return resolveStation(input);
	const saved = (await player.context.store.get<Station>(STATION_KEY)).value;
	if (saved && typeof saved.url === "string" && typeof saved.title === "string") return saved;
	return resolveStation(String(player.context.options.station ?? FOCUS_STATIONS[0]?.url));
}

async function open(player: Player, station: Station): Promise<Result> {
	try {
		await writeProfile(player, playlist(station));
	} catch (error) {
		return { status: "failed", reason: `could not write the player profile: ${message(error)}` };
	}
	try {
		await player.pane.open({
			binary: "cliamp",
			args: ["--playlist", PLAYLIST, "--auto-play"],
			env: { CLIAMP_CONFIG_DIR: player.home },
			title: "music",
			rows: PANE_ROWS,
			share: 0.05,
			tap: { file: tapFile, action: "toggle" },
		});
	} catch (error) {
		return { status: "failed", reason: message(error) };
	}
	return { status: "playing", title: station.title, opened: true };
}

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/^pane: /u, "the music pane: ");
}

async function on(player: Player): Promise<Result> {
	const pane = await player.pane.state();
	if (pane === "closed") {
		const station = await chosenStation(player);
		return "error" in station ? { status: "failed", reason: station.error } : open(player, station);
	}
	if (pane === "hidden") await player.pane.reveal();
	const status = await playerStatus(player);
	if (status === null) return { status: "failed", reason: "cliamp is not answering; the pane may still be starting" };
	if (status.state !== "playing") {
		// IPC `play` only resumes a paused track; a stopped player starts with `toggle`.
		const resumed = await cliamp(player, [status.state === "stopped" ? "toggle" : "play"]);
		if (!resumed.ok) return { status: "failed", reason: `cliamp could not resume: ${resumed.error}` };
	}
	return { status: "playing", title: (await playerStatus(player))?.title ?? status.title, opened: false };
}

async function off(player: Player): Promise<Result> {
	if ((await player.pane.state()) === "closed") return { status: "stopped" };
	// Stop first so the stream ends even if the pane host is slow to close.
	await cliamp(player, ["stop"]);
	await player.pane.close();
	return { status: "stopped" };
}

async function pause(player: Player): Promise<Result> {
	if ((await player.pane.state()) === "closed") return { status: "stopped" };
	const status = await playerStatus(player);
	if (status === null) return { status: "failed", reason: "cliamp is not answering; the pane may still be starting" };
	if (status.state === "playing") {
		const paused = await cliamp(player, ["pause"]);
		if (!paused.ok) return { status: "failed", reason: `cliamp pause failed: ${paused.error}` };
	}
	return { status: "paused", title: status.title };
}

async function next(player: Player): Promise<Result> {
	if ((await player.pane.state()) === "closed") return on(player);
	const skipped = await cliamp(player, ["next"]);
	if (!skipped.ok) return { status: "failed", reason: `cliamp next failed: ${skipped.error}` };
	return { status: "playing", title: (await playerStatus(player))?.title ?? null, opened: false };
}

async function status(player: Player): Promise<Result> {
	if ((await player.pane.state()) === "closed") return { status: "stopped" };
	const playback = await playerStatus(player);
	if (playback === null) return { status: "failed", reason: "cliamp is not answering; the pane may still be starting" };
	return playback.state === "playing"
		? { status: "playing", title: playback.title, opened: false }
		: { status: "paused", title: playback.title };
}

async function station(player: Player, input: string): Promise<Result> {
	const picked = await chosenStation(player, input);
	if ("error" in picked) return { status: "failed", reason: picked.error };
	await player.context.store.set(STATION_KEY, picked);
	if ((await player.pane.state()) === "closed") return open(player, picked);
	// `load` swaps the running player's playlist and starts its first entry, so the pane keeps its place.
	writeIfChanged(join(player.home, "playlists", `${PLAYLIST}.toml`), renderPlaylist(playlist(picked)));
	const loaded = await cliamp(player, ["load", PLAYLIST]);
	if (!loaded.ok) return { status: "failed", reason: `cliamp load failed: ${loaded.error}` };
	return { status: "playing", title: picked.title, opened: false };
}

async function toggle(player: Player): Promise<Result> {
	const pane = await player.pane.state();
	if (pane === "closed") return on(player);
	try {
		if (pane === "hidden") await player.pane.reveal();
		else await player.pane.hide();
	} catch (error) {
		return { status: "failed", reason: message(error) };
	}
	const playback = await playerStatus(player);
	return {
		status: pane === "hidden" ? "shown" : "hidden",
		playing: playback?.state === "playing",
		title: playback?.title ?? null,
	};
}

function output(result: Result): ExtensionOutputV2 {
	return { text: describe(result), toast: { text: describe(result), tone: tone(result) } };
}

const ACTIONS = new Map<string, (music: Player) => Promise<Result>>([
	["on", on],
	["off", off],
	["pause", pause],
	["next", next],
	["status", status],
]);

const USAGE = "usage: /music [on|off|pause|next|status|station <name or url>|agent on|off]";

export default function extension(api: ExtensionApiV2): void {
	api.handle("music", async (args, context) => {
		const [verb = "", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
		if (verb === "agent") {
			const value = rest[0];
			if ((value !== "on" && value !== "off") || rest.length > 1) return { text: "usage: /music agent on|off" };
			await context.store.set(AGENT_KEY, value === "on");
			return {
				text:
					value === "on"
						? "the model may now play, pause, skip and stop music with the music tool"
						: "the music tool now refuses; only you drive the player",
			};
		}
		const music = player(context);
		if (typeof music === "string") return { text: music, toast: { text: music, tone: "warning" } };
		if (verb === "") return output(await toggle(music));
		if (verb === "station") {
			const name = rest.join(" ");
			return name.length > 0 ? output(await station(music, name)) : { text: "usage: /music station <name or url>" };
		}
		const run = rest.length === 0 ? ACTIONS.get(verb) : undefined;
		return run ? output(await run(music)) : { text: USAGE };
	});

	api.action("toggle", async (event, context) => {
		const music = player(context);
		if (typeof music === "string") return { text: music, toast: { text: music, tone: "warning" } };
		return output(event.key === "double" ? await off(music) : await toggle(music));
	});

	api.on("pane_changed", (event) => {
		if (event.event !== "pane_changed") return undefined;
		if (event.state !== "closed")
			return { text: "", status: { text: event.state === "hidden" ? "music (hidden)" : "music" } };
		return event.reason === "exited"
			? { text: "", status: null, toast: { text: "cliamp exited; /music starts it again", tone: "warning" } }
			: { text: "", status: null };
	});

	api.tool("music", async (input, context) => {
		if ((await context.store.get<boolean>(AGENT_KEY)).value !== true)
			return { text: "music: the operator has not allowed the model to drive music (/music agent on)", isError: true };
		const music = player(context);
		if (typeof music === "string") return { text: music, isError: true };
		const run = ACTIONS.get(String((input as { action?: unknown } | null)?.action));
		if (!run) return { text: "music: action must be on, pause, off, next or status", isError: true };
		const result = await run(music);
		return { text: describe(result), isError: result.status === "failed" };
	});
}
