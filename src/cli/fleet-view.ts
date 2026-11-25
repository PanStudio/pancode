// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode fleet view <runId|fleetRootId> [--follow]`.
 *
 * Given a fleet root id it renders a step index instead; see the fleet root
 * index section below for why a root cannot be rendered as a run.
 *
 * A read-only viewer for one dispatched run, built from durable state only:
 * the run ledger envelope, the run's display feed
 * (src/domains/dispatch/run-feed.ts), and the run's sealed record once
 * it settles. It shares no memory with the orchestrator, has zero dependency on any
 * pane host, and works over a plain SSH session.
 *
 * Everything the viewer prints comes from `renderRunView`, a pure function over
 * a `RunViewModel`. `--follow` paints that same output into an alternate screen
 * and re-polls the feed at the monitor tool's `WAIT_POLL_MS` cadence until
 * the feed's terminal line lands; it then stays open until `q`. Without
 * `--follow` the snapshot goes to stdout and the process exits.
 *
 * Trust rules the render obeys:
 *   - The run record is checked through `readRunTrust` before any of
 *     its fields are shown. A record that fails integrity contributes its
 *     failure reason and nothing else.
 *   - Task text is operator-supplied and worker-adjacent, so it is sanitized
 *     and bounded before rendering, per the `DispatchRunIdentity` warning in
 *     src/core/telemetry/live-events.ts. Journal event details cross the same seam and
 *     get the same treatment.
 *
 * Terminal primitives come from src/engine/tui-primitives.ts, never from the
 * src/engine/tui.js barrel, and that is load-bearing. See the header of
 * tui-primitives.ts for why an edge from here to the barrel breaks the Stage 0
 * instant-shell chunk budget.
 */

import { readFileSync } from "node:fs";
import { GLYPH } from "../core/glyphs.js";
import type { ColorDepth } from "../core/terminal-preferences.js";
import { pancodeStateDir, resetXdgCache } from "../core/xdg.js";
import type { LedgerSnapshot } from "../domains/dispatch/state.js";
import { readLedgerSnapshot } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { fleetInspectionScope, resolveFleetRootId } from "./fleet-project-scope.js";
import { DEFAULT_WIDTH, loadRunViewModel, MIN_WIDTH, resolveRunId, truncatePlain } from "./fleet-view-model.js";
import {
	COLOR_DEPTHS,
	createPanePaint,
	type LogsPaneScroll,
	type LogsPaneView,
	loadLogsPane,
	logsPaneView,
	PANE_CHROME_ROWS,
	PANE_DEFAULT_WIDTH,
	paneTier,
	renderLogsPane,
} from "./fleet-view-pane.js";
import { renderRunView, renderWatchView } from "./fleet-view-render.js";
import {
	CODE_STEP_PREFIX,
	FLEET_ROOT_PREFIX,
	fleetRunsDir,
	loadCodeStepViewModel,
	loadFleetRunViewModel,
	renderCodeStepView,
	renderFleetRunView,
} from "./fleet-view-root.js";

const HELP = `pancode fleet view <runId|fleetRootId> [--follow] [--all]
pancode fleet view <runId> --follow --pane [--all]
pancode fleet view <runId> --json [--all]
pancode fleet view --watch <selection-file> [--dock-taps <file>] [--color-depth <depth>] [--all]

Follow one dispatched run from its durable state: the run ledger entry, the
run's display feed, and the run's sealed record once it settles.

Once the run's seal verifies, the snapshot also names the model the run
requested next to the models the providers reported, the cost with its pricing
provenance, and the label the route settled with.

A code step id (code-...) a fleet root lists shows the step's settled record
and its captured command output.

  --json       print the snapshot and the sealed run record as JSON
  --follow     keep tailing until the run's terminal line, then stay open (q exits)
  --pane       with --follow: the logs pane, one clipped row per event at the pane's
               width, detail from the TUI's output detail (the logs pane runs this)
  --watch      the workers dashboard: a board of this session's workers, and a
               live takeover of one (Enter, Esc back). The selection file asks
               for a takeover and scopes the board to a session. This is the
               process the workers dock (Alt+W) runs.
  --dock-taps  where the dashboard reports q (hide the dock) and Alt+W to PanCode;
               without it q quits
  --color-depth  with --watch: truecolor, 256, 16 or none, the depth PanCode paints at;
               the workers dock passes it because a pane inherits the multiplexer's
               environment (without it the dashboard reads NO_COLOR, TERM and COLORTERM)
  --all        allow inspection across every project (default: this project)

Without --follow the current snapshot is printed and the command exits.
The transcript comes from <state>/runs/<runId>/feed.jsonl, which the orchestrator
writes when fleet.history.journal is on (the default). A run dispatched with it
off shows its ledger and run record but no transcript.

Given the fleet root id that \`fleet run\` prints (fleet-<hex>), this prints the
run's step index instead: one line per step with its run id and outcome. Pass
one of those run ids back to see that step.
`;

/** Journal poll cadence, matching WAIT_POLL_MS in src/tools/monitor.ts. */
const POLL_MS = 250;

/** Raw-mode Ctrl-C arrives as a byte, not as SIGINT, so the follow loop matches it. */
const QUIT_CTRL_C = String.fromCharCode(3);
const QUIT_ESCAPE = String.fromCharCode(27);

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function fail(message: string): number {
	process.stderr.write(`pancode fleet view: ${message}\n`);
	return 2;
}

interface ParsedViewArgs {
	runId?: string;
	watchPath?: string;
	tapPath?: string;
	colorDepth?: ColorDepth;
	dirs?: {
		config?: string;
		data?: string;
		state?: string;
		cache?: string;
	};
	follow: boolean;
	pane: boolean;
	all: boolean;
	json: boolean;
	help: boolean;
}

function parseViewArgs(args: ReadonlyArray<string>): ParsedViewArgs | string {
	const parsed: ParsedViewArgs = { follow: false, pane: false, all: false, json: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--follow" || arg === "-f") {
			parsed.follow = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--pane") {
			parsed.pane = true;
			continue;
		}
		if (arg === "--all") {
			parsed.all = true;
			continue;
		}
		if (arg === "--watch") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return "--watch requires a selection-file path";
			parsed.watchPath = value;
			i += 1;
			continue;
		}
		if (arg === "--dock-taps") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return "--dock-taps requires a file path";
			parsed.tapPath = value;
			i += 1;
			continue;
		}
		if (arg === "--color-depth") {
			const value = args[i + 1];
			const depth = COLOR_DEPTHS.find((entry) => entry === value);
			if (depth === undefined) return `--color-depth takes one of ${COLOR_DEPTHS.join(", ")}`;
			parsed.colorDepth = depth;
			i += 1;
			continue;
		}
		const dirRole =
			arg === "--config-dir"
				? "config"
				: arg === "--data-dir"
					? "data"
					: arg === "--state-dir"
						? "state"
						: arg === "--cache-dir"
							? "cache"
							: null;
		if (dirRole !== null) {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) return `${arg} requires a directory path`;
			parsed.dirs ??= {};
			parsed.dirs[dirRole] = value;
			i += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg.startsWith("-")) return `unknown flag: ${arg}`;
		if (parsed.runId !== undefined) return `unexpected argument: ${arg}`;
		parsed.runId = arg;
	}
	if (parsed.watchPath !== undefined && parsed.runId !== undefined) {
		return "--watch follows the selection file; it does not take a run id";
	}
	if (parsed.watchPath !== undefined && parsed.follow) {
		return "--watch already follows; drop --follow";
	}
	if (parsed.tapPath !== undefined && parsed.watchPath === undefined) {
		return "--dock-taps belongs to --watch";
	}
	if (parsed.colorDepth !== undefined && parsed.watchPath === undefined) {
		return "--color-depth belongs to --watch";
	}
	if (parsed.json && (parsed.follow || parsed.watchPath !== undefined)) {
		return "--json prints one snapshot; drop --follow and --watch";
	}
	if (parsed.pane && !parsed.follow) {
		return "--pane belongs to --follow";
	}
	return parsed;
}

/**
 * Pin the already-resolved parent layout before any fleet-view read. These are
 * internal self-invocation flags rather than inherited raw environment: the
 * pane shell may discard or replace its environment, but it cannot reinterpret
 * the four absolute values already present in argv.
 */
function applyViewDirs(dirs: ParsedViewArgs["dirs"]): void {
	if (dirs === undefined) return;
	if (dirs.config !== undefined) process.env.PANCODE_CONFIG_DIR = dirs.config;
	if (dirs.data !== undefined) process.env.PANCODE_DATA_DIR = dirs.data;
	if (dirs.state !== undefined) process.env.PANCODE_STATE_DIR = dirs.state;
	if (dirs.cache !== undefined) process.env.PANCODE_CACHE_DIR = dirs.cache;
	resetXdgCache();
}

/**
 * The selection file is one line: the run id the watch view should render.
 * Empty, missing, or torn content reads as "no selection" and costs one poll
 * interval, never a crash; the writer (src/interactive/watch-pane.ts) replaces
 * the file atomically.
 */
function readWatchSelection(path: string): string | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const line = raw.split("\n", 1)[0]?.trim() ?? "";
	return line.length > 0 && line.length <= 128 ? line : null;
}

function terminalWidth(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns >= MIN_WIDTH ? columns : DEFAULT_WIDTH;
}

export async function runFleetView(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseViewArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`pancode fleet view: ${parsed}\n`);
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	applyViewDirs(parsed.dirs);
	const scope = fleetInspectionScope(parsed.all);
	if (parsed.watchPath !== undefined) {
		// The watch loop needs an interactive terminal for the same reason
		// --follow does; without one, print the selected run's snapshot and exit.
		if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
			const selected = readWatchSelection(parsed.watchPath);
			const model = selected === null ? null : loadRunViewModel(selected, { scope });
			process.stdout.write(`${renderWatchView(selected, model, terminalWidth()).join("\n")}\n`);
			return 0;
		}
		const { runWorkersDashboard } = await import("./fleet-board.js");
		return runWorkersDashboard({
			selectionPath: parsed.watchPath,
			tapPath: parsed.tapPath ?? null,
			scope,
			...(parsed.colorDepth !== undefined ? { colorDepth: parsed.colorDepth } : {}),
		});
	}
	if (parsed.runId === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	// A fleet root names a whole run, not a dispatched one, so it renders as the
	// step index rather than as a run. --follow has nothing to tail on a root:
	// the index changes only when a step settles.
	if (parsed.runId.startsWith(FLEET_ROOT_PREFIX)) {
		const root = resolveFleetRootId(parsed.runId, scope);
		if (!("rootId" in root)) {
			return root.candidates.length === 0
				? fail(`unknown fleet run '${parsed.runId}' (no record under ${fleetRunsDir()})`)
				: fail(`fleet root id '${parsed.runId}' is ambiguous: ${root.candidates.slice(0, 8).join(", ")}`);
		}
		const fleetModel = loadFleetRunViewModel(root.rootId, { scope });
		if (fleetModel === null) return fail(`unknown fleet run '${root.rootId}'`);
		if (parsed.json) return fail("--json takes a run id; view the fleet root without it to list its step run ids");
		if (parsed.pane) return fail("--pane follows a run id, not a fleet root");
		if (parsed.follow) {
			process.stderr.write("pancode fleet view: --follow applies to a run id, not a fleet root; printing the index\n");
		}
		process.stdout.write(`${renderFleetRunView(fleetModel, terminalWidth()).join("\n")}\n`);
		return 0;
	}
	const resolved = resolveRunId(parsed.runId, scope);
	if (!("runId" in resolved) && parsed.runId.startsWith(CODE_STEP_PREFIX)) {
		const step = loadCodeStepViewModel(parsed.runId, scope);
		if (step !== null) {
			if (parsed.follow || parsed.pane) return fail("a code step has settled; drop --follow and --pane");
			if (parsed.json) process.stdout.write(`${JSON.stringify(step, null, 2)}\n`);
			else process.stdout.write(`${renderCodeStepView(step, terminalWidth()).join("\n")}\n`);
			return 0;
		}
	}
	if (!("runId" in resolved)) {
		return resolved.candidates.length === 0
			? fail(`unknown run '${parsed.runId}' (not in the run ledger under ${pancodeStateDir()})`)
			: fail(`run id '${parsed.runId}' is ambiguous: ${resolved.candidates.slice(0, 8).join(", ")}`);
	}
	const runId = resolved.runId;
	const snapshot = loadRunViewModel(runId, { scope });
	if (snapshot === null) return fail(`unknown run '${runId}'`);
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}

	if (parsed.pane) {
		if (process.stdout.isTTY === true && process.stdin.isTTY === true) return followPane(runId, scope);
		// One frame of the pane, unpainted, so a pipe still reads what the pane would show.
		process.stderr.write("pancode fleet view: --pane needs an interactive terminal; printing one frame\n");
		const source = loadLogsPane(runId, scope);
		const frame =
			source === null
				? [`run ${runId} left the ledger.`]
				: renderLogsPane(
						logsPaneView(source, null).view,
						{ top: null },
						process.stdout.columns ?? PANE_DEFAULT_WIDTH,
						null,
						paneTier(),
						createPanePaint("none"),
					);
		process.stdout.write(`${frame.join("\n")}\n`);
		return 0;
	}
	// A non-TTY stdout has no alternate screen and no keypresses, so --follow
	// there would spin without ever being readable or quittable. Print the
	// snapshot and say why, rather than hanging a pipe.
	if (!parsed.follow || process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
		if (parsed.follow) {
			process.stderr.write("pancode fleet view: --follow needs an interactive terminal; printing a snapshot\n");
		}
		process.stdout.write(`${renderRunView(snapshot, terminalWidth()).join("\n")}\n`);
		return 0;
	}
	return followRun(runId, scope);
}

/**
 * The logs pane loop: the same poll cadence as {@link followRun}, the tier re-read from the selection file on each
 * tick, and the frame memoized on width, height, tier, scroll and the feed's position so an idle pane renders nothing
 * new. `↑` and `↓` scroll and stop following; `f` follows again; `q` hides the pane by ending its process.
 */
async function followPane(runId: string, scope: ReturnType<typeof fleetInspectionScope>): Promise<number> {
	const { ProcessTerminal, TuiAltScreen, isKeyRelease, matchesKey } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: (text) =>
			import("../engine/clipboard.js")
				.then(({ copyToSystemClipboard }) => copyToSystemClipboard(text, (sequence) => terminal.write(sequence)))
				.catch(() => "Copy failed: clipboard module did not load"),
	});
	let ledger: LedgerSnapshot | null = null;
	const rows = (): ReadonlyArray<RunEnvelope> => {
		ledger = readLedgerSnapshot(ledger);
		return ledger.runs;
	};
	const paint = createPanePaint();
	const scroll: LogsPaneScroll = { top: null };
	let tier = paneTier();
	let current: { key: string; view: LogsPaneView } | null = null;
	const load = (): void => {
		const source = loadLogsPane(runId, scope, rows);
		current = source === null ? null : logsPaneView(source, current);
	};
	load();
	let frameKey = "";
	let frame: string[] = [];

	const view = {
		render(width: number): string[] {
			if (current === null) return [truncatePlain(` run ${runId} left the ledger.`, Math.max(1, width))];
			const height = Math.max(PANE_CHROME_ROWS + 1, terminal.rows);
			const key = `${width}x${height}|${tier}|${current.key}|${scroll.top ?? "follow"}`;
			if (key !== frameKey) {
				frame = renderLogsPane(current.view, scroll, width, height, tier, paint);
				frameKey = key;
			}
			return frame;
		},
		invalidate(): void {
			frameKey = "";
		},
	};
	tui.addChild(view);

	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			load();
			tier = paneTier();
			tui.requestRender();
		}, POLL_MS);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			removeInput();
			tui.stop();
			resolve(0);
		};
		const removeInput = tui.addInputListener((data: string) => {
			if (isKeyRelease(data)) return undefined;
			if (data === "q" || matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
				finish();
				return { consume: true };
			}
			const maxTop = scroll.maxTop ?? 0;
			if (matchesKey(data, "up") || data === "k") scroll.top = Math.max(0, (scroll.top ?? maxTop) - 1);
			else if (matchesKey(data, "down") || data === "j") scroll.top = Math.min(maxTop, (scroll.top ?? maxTop) + 1);
			else if (data === "f") scroll.top = null;
			else return undefined;
			tui.requestRender();
			return { consume: true };
		});
		tui.start();
		tui.requestRender();
	});
}

/**
 * Alternate-screen follow loop on the PanCode terminal-engine primitives. The
 * component is a plain line source over the same pure renderer the snapshot
 * path uses, so the two surfaces cannot drift.
 */
async function followRun(runId: string, scope: ReturnType<typeof fleetInspectionScope>): Promise<number> {
	const { ProcessTerminal, TuiAltScreen } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		// #437: confirm copies through a system clipboard tool instead of a bare OSC 52.
		copySelection: (text) =>
			import("../engine/clipboard.js")
				.then(({ copyToSystemClipboard }) => copyToSystemClipboard(text, (sequence) => terminal.write(sequence)))
				.catch(() => "Copy failed: clipboard module did not load"),
	});
	// A follow polls every POLL_MS; runs.json is parsed again only when it changed, so an idle follow stays off the CPU
	// at the 1000-row cap (FL-24).
	let ledger: LedgerSnapshot | null = null;
	const rows = (): ReadonlyArray<RunEnvelope> => {
		ledger = readLedgerSnapshot(ledger);
		return ledger.runs;
	};
	let model = loadRunViewModel(runId, { scope, ledger: rows });
	let following = true;

	const view = {
		render(width: number): string[] {
			if (model === null) return [`run ${runId} left the ledger.`];
			const lines = renderRunView(model, width);
			lines.push("");
			lines.push(following ? `following${GLYPH.ellipsis} q to quit` : "run finished. q to quit");
			return lines;
		},
		invalidate(): void {},
	};
	tui.addChild(view);

	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			model = loadRunViewModel(runId, { scope, ledger: rows });
			if (model?.terminal === true) following = false;
			tui.requestRender();
		}, POLL_MS);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			removeInput();
			tui.stop();
			resolve(0);
		};
		const removeInput = tui.addInputListener((data: string) => {
			// The terminal is in raw mode, so Ctrl-C arrives as a byte rather than
			// as SIGINT and has to be honored here.
			if (data === "q" || data === QUIT_CTRL_C || data === QUIT_ESCAPE) {
				finish();
				return { consume: true };
			}
			return undefined;
		});
		tui.start();
		tui.requestRender();
	});
}
