// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SettingsAreaId } from "../core/settings-areas.js";
import { isExtensionCommandToken } from "../domains/extensions/operator-commands.js";
import {
	PANE_PEER_IDS,
	PANES_PRESET_IDS,
	PANES_PRESETS,
	type PanePeerId,
	type PanesStatus,
	resolvePanesPresetId,
} from "../domains/mux/operations.js";
import { isPancodeHostSocket } from "../domains/mux/workspace/platform.js";
import type { ExtensionReloadOutcome } from "../entry/extension-reload.js";
import { pinnedProgramMissing } from "../lib/programs/index.js";
import type { NoticeLevel } from "./notice-source.js";
import type {
	BuiltinSlashCommand,
	SlashCommand,
	SlashCommandContext,
	SlashCommandKind,
} from "./slash-command-types.js";
import { COMPACT_POSITIONALS, CONTEXT_SLASH_COMMANDS } from "./slash-handlers/context.js";
import { FLEET_SLASH_COMMANDS } from "./slash-handlers/fleet.js";
import { HARNESS_SLASH_COMMANDS } from "./slash-handlers/harness.js";
import { MEMORY_SLASH_COMMANDS } from "./slash-handlers/memory.js";
import { MODEL_SLASH_COMMANDS } from "./slash-handlers/model.js";
import { SESSION_SLASH_COMMANDS } from "./slash-handlers/session.js";
import { usageError } from "./slash-handlers/usage-error.js";
import { WORK_SLASH_COMMANDS } from "./slash-handlers/work.js";
import { matchFromSpec, type ParsedArgs, usageLine } from "./slash-spec.js";

/**
 * Ported from pi-coding-agent's BUILTIN_SLASH_COMMANDS registry. Each entry owns
 * one user-facing slash command: how it parses, which SlashCommand kinds it
 * produces, and how those kinds execute. Adding a new command is one entry
 * rather than extending two parallel switches.
 *
 * This module is a CLI seam, which constrains what it may import.
 * `src/cli/run.ts` reaches `parseSlashCommand` here so a headless
 * `pancode run "/typo"` refuses the token by the same shape test and the same
 * registry membership the editor uses; a second copy of the parser would drift
 * from this one on the first command added. That makes the CLI a reacher of
 * everything this file statically imports, so nothing here may reach the
 * interactive render graph: no theme, no overlay frame, no overlay module, no
 * `../engine/tui.js`. Those modules share one bundle chunk with the instant
 * shell's Stage 0 closure, and a second, disjoint reacher makes esbuild split
 * it, which is a startup-latency regression rather than a style problem. The
 * parse-time data tables the registry needs live in leaves for that reason,
 * such as `COUNCIL_SYNTHESIS_LABEL` in `./council.js`. Import from those,
 * not from overlays that re-export them.
 *
 * Boundaries rule6 in `tests/boundaries/check-boundaries.ts` refuses a violation
 * at lint time; `tests/extended/instant-shell-import-graph.test.ts` is the
 * measurement it protects.
 *
 * The registry entries live in `./slash-handlers/`, and this file imports them
 * statically, so the same constraint holds for every module there.
 */

export type { SettingsAreaId };

/** `/panes peer <peer> [brief] [--cwd <path>]`; a bare verb lists the peers this machine can open. */
function panesPeerFromArgs(parsed: ParsedArgs): SlashCommand {
	if (parsed.positionals.length === 0) return { kind: "panes-peers" };
	if (parsed.error) return usageError("panes", parsed.error, "peer");
	const peer = parsed.positionals[0] ?? "";
	if (!(PANE_PEER_IDS as ReadonlyArray<string>).includes(peer)) {
		return usageError("panes", `${peer} is not a peer PanCode can open. Name one of ${PANE_PEER_IDS.join(", ")}`, "peer");
	}
	const cwd = parsed.flags.get("--cwd");
	return {
		kind: "peer-pane",
		peer: peer as PanePeerId,
		...(parsed.rest?.trim() ? { brief: parsed.rest.trim() } : {}),
		...(typeof cwd === "string" ? { cwd } : {}),
	};
}

function usageNotice(entry: BuiltinSlashCommand, subcommand?: string): string {
	return usageLine(entry, subcommand).trim();
}

/**
 * Prints the one usage answer and keeps the draft: a bare command is a
 * question and gets its usage as information; anything else is a mistake and
 * gets an error naming the reason, then the usage line.
 */
export function answerUsage(
	command: Extract<SlashCommand, { kind: "usage-error" }>,
	ctx: SlashCommandContext,
): "rejected" {
	const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === command.command);
	const usage = entry ? usageNotice(entry, command.subcommand) : `usage: /${command.command}`;
	const reason = command.reason?.trim().replace(/\.+$/u, "") ?? "";
	if (command.bare === true || reason.length === 0) ctx.notice("info", usage);
	else ctx.notice("error", `${reason}. ${usage}`);
	ctx.render?.();
	return "rejected";
}

/**
 * `/panes` output, as plain lines. Pure so the contract test asserts the text
 * an operator reads rather than the object behind it, and so the registry keeps
 * its promise not to reach a renderer.
 */
function formatPanesStatus(status: PanesStatus): ReadonlyArray<string> {
	// What an operator asks first: can PanCode open panes here, and which are open.
	// The settings and wire facts follow on one details line, in words.
	const host = status.server ? `Herdr ${status.server.version}` : "the pane host";
	const lead = status.available
		? `Panes: ${host} is available. PanCode opens panes beside this one, ${status.mode === "embedded" || isPancodeHostSocket(status.socketPath ?? undefined) ? "in its own workspace" : "as a guest in this workspace"}.`
		: `Panes: unavailable. ${status.reason}`;
	const row = (label: string, value: string): string => `  ${label.padEnd(12)} ${value}`;
	const files =
		status.yazi.mode === "closed" || status.yazi.paneId === null
			? status.settings.yazi.enabled
				? "closed · /files opens it"
				: "off · turn on Files pane in /settings (Workspace), then /files opens it"
			: `open${status.yazi.paneCwd ? ` in ${status.yazi.paneCwd}` : ""} · picks land in the composer as @ mentions${status.yazi.droppedLines > 0 ? ` · ${status.yazi.droppedLines} picks dropped` : ""}`;
	const lines = [lead, row("Files pane", files)];
	for (const dock of status.docks) {
		const share = `${(dock.targetShare * 100).toFixed(0)}% of the window`;
		const slot = `${dock.slot[0]?.toUpperCase() ?? ""}${dock.slot.slice(1)} dock`;
		lines.push(row(slot, dock.hidden ? `hidden; it takes ${share} when shown` : `shown · ${share}`));
	}
	if (status.panes.length === 0) lines.push(row("Open now", "none"));
	else
		for (const [index, pane] of status.panes.entries()) {
			const notes = [pane.adopted ? "adopted from an earlier session" : "", pane.pending ? "opening" : ""].filter(Boolean);
			lines.push(row(index === 0 ? "Open now" : "", `${pane.label}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`));
		}
	// One preset per row, command first, so each reads as something to type.
	for (const [index, preset] of PANES_PRESETS.entries())
		lines.push(row(index === 0 ? "Open one" : "", `/panes open ${preset.id} · ${preset.summary}`));
	if (status.available) {
		const alerts =
			status.settings.notifications === "failures"
				? "Herdr toasts for failed runs"
				: status.settings.notifications === "all"
					? "Herdr toasts for every finished run"
					: "no Herdr toasts";
		lines.push(
			row(
				"Details",
				`${status.socketPath ? `socket ${status.socketPath} · ` : ""}${status.server ? `protocol ${status.server.protocol} · ` : ""}${alerts} · journal ${status.settings.journal ? "on" : "off"}`,
			),
		);
	}
	return lines;
}

const PANES_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "attach",
		rank: 3,
		acp: false,
		description: "Let another terminal watch this session, answer its approvals, or pair",
		group: "PanCode",
		kinds: ["attach"],
		args: {
			subcommands: { observe: {}, approve: {}, pair: {}, off: {} },
		},
		subcommandDescriptions: {
			observe: "Open attach for watchers only",
			approve: "Also let attached clients answer the approval card",
			pair: "Also let attached clients steer or start turns with plain text",
			off: "Close the attach socket and drop every client",
		},
		fromArgs(parsed) {
			if (parsed.error) return usageError("attach", parsed.error, parsed.subcommand);
			if (parsed.positionals.length > 0) return usageError("attach", `Unexpected argument: ${parsed.positionals[0]}`);
			const action = parsed.subcommand;
			if (action === "observe" || action === "approve" || action === "pair" || action === "off")
				return { kind: "attach", action };
			return { kind: "attach", action: "status" };
		},
		handle(command, ctx) {
			if (command.kind !== "attach") return;
			if (!ctx.attach) {
				ctx.notice("warn", "attach is available only in the interactive terminal");
				return "rejected";
			}
			if (command.action === "status") {
				ctx.notice("info", ctx.attach.status());
				return;
			}
			const ceiling =
				command.action === "off"
					? null
					: command.action === "observe"
						? "observer"
						: command.action === "approve"
							? "approver"
							: "pair";
			void ctx.attach.admit(ceiling).then((result) => ctx.notice(result.level, result.text));
		},
	},
	{
		name: "panes",
		rank: 3,
		acp: false,
		description: "Show pane status, watch a run, open a utility pane or a coding peer",
		group: "PanCode",
		kinds: ["panes", "panes-show", "panes-open", "panes-zoom", "panes-close", "panes-peers", "peer-pane"],
		args: {
			subcommands: {
				peer: {
					parseFlagsBeforeRest: true,
					flags: [{ name: "--cwd", takesValue: true, valueName: "path" }],
					positionals: [
						{ name: "peer", required: true },
						{ name: "brief", required: false, rest: true },
					],
				},
				show: { positionals: [{ name: "run-or-agent", required: true }] },
				// A rest positional, so an argv pane keeps its own flags: the parser
				// would otherwise refuse `--follow` as an unknown flag of `/panes`.
				open: { positionals: [{ name: "preset-or-argv", required: true, rest: true }] },
				zoom: { positionals: [{ name: "target", required: false }] },
				close: { positionals: [{ name: "target", required: false }] },
			},
		},
		subcommandDescriptions: {
			peer: "Open a coding peer in a PanCode-owned interactive pane",
			show: "Watch a live run or agent in the watch pane",
			open: `Open a utility pane (${PANES_PRESET_IDS.join(", ")}, \`files --once\` for one pick, or a command)`,
			zoom: "Toggle zoom on a PanCode-owned pane (default: the watch pane)",
			close: "Close a PanCode-owned pane, or all of them",
		},
		fromArgs(parsed) {
			if (parsed.subcommand === "peer") return panesPeerFromArgs(parsed);
			if (parsed.error) return usageError("panes", parsed.error, parsed.subcommand);
			if (parsed.subcommand === "show") {
				return { kind: "panes-show", target: parsed.positionals[0] ?? "" };
			}
			if (parsed.subcommand === "open") {
				const rest = (parsed.rest ?? "").trim();
				if (rest.length === 0) return usageError("panes", "Missing required argument: preset-or-argv", "open");
				const argv = rest.split(/\s+/).filter((token) => token.length > 0);
				const first = argv[0] ?? "";
				// A bare preset name is a preset; anything else is operator argv,
				// which the tool surface deliberately cannot ask for.
				const preset = resolvePanesPresetId(first);
				if (argv.length === 1 && preset !== null) return { kind: "panes-open", preset };
				if (argv.length === 2 && preset === "files" && argv[1] === "--once") {
					return { kind: "panes-open", preset: "files", once: true };
				}
				return { kind: "panes-open", argv };
			}
			if (parsed.subcommand === "zoom") {
				return { kind: "panes-zoom", target: parsed.positionals[0] ?? "" };
			}
			if (parsed.subcommand === "close") {
				return { kind: "panes-close", target: parsed.positionals[0] ?? "all" };
			}
			if (parsed.positionals.length > 0) {
				return usageError("panes", `Unexpected argument: ${parsed.positionals[0]}`);
			}
			return { kind: "panes" };
		},
		handle(command, ctx) {
			if (command.kind === "panes-peers") {
				const listing = ctx.panes?.peers?.();
				if (!listing || !ctx.panes) {
					return answerUsage(
						{
							kind: "usage-error",
							command: "panes",
							subcommand: "peer",
							reason: `Name the coding agent to open beside PanCode: ${PANE_PEER_IDS.join(", ")}. A brief after it becomes its first prompt`,
						},
						ctx,
					);
				}
				// The bare verb answers "which agents would open here?" with what is on this machine.
				const status = ctx.panes.status();
				const width = Math.max(...listing.map((row) => row.peer.length));
				const lines = [
					status.available
						? "Peers: coding agents PanCode can open in a pane beside this one. PanCode does not track or review their work."
						: `Peers: none can open now. ${status.reason}`,
					...listing.map(
						(row) => `  ${row.peer.padEnd(width)}  ${row.found ? "installed" : `not found; install ${row.binary} to use it`}`,
					),
					`  ${"Open one".padEnd(width)}  /panes peer <agent> [brief]; the brief becomes its first prompt, and --cwd <path> picks its folder`,
				];
				// One write is one block: a write per line drew a spacer between rows wherever a row wrapped.
				ctx.io.stdout(`${lines.join("\n")}\n`);
				ctx.render?.();
				return;
			}
			const panes = ctx.panes;
			if (!panes) {
				// Inactive by choice, not unavailable: the operations object exists in
				// every `--with-panes` session, even one where no pane host answered.
				ctx.notice("info", panesInactiveWords("panes are inactive"));
				return;
			}
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			if (command.kind === "peer-pane") {
				runLocal(async () => {
					const result = await panes.handoff({
						peer: command.peer,
						...(command.brief ? { brief: command.brief } : {}),
						...(command.cwd ? { cwd: command.cwd } : {}),
					});
					if (result.status === "opened") {
						ctx.notice(
							"success",
							`Opened ${command.peer} in a pane beside this one, working in ${result.cwd}. It runs on its own: PanCode keeps no run record of it and does not review its changes.`,
						);
					} else if (result.status === "missing-binary") {
						ctx.notice("warn", result.detail);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes") {
				runLocal(async () => {
					ctx.io.stdout(`${formatPanesStatus(panes.status()).join("\n")}\n`);
					ctx.render?.();
				});
				return;
			}
			if (command.kind === "panes-show") {
				runLocal(async () => {
					const result = await panes.show(command.target);
					if (result.status === "watching") {
						ctx.notice("success", `the workers dock is following ${result.agentId} (${result.runId})`);
					} else if (result.status === "not-found") {
						const known = result.candidates.length > 0 ? `; live runs: ${result.candidates.join(", ")}` : "";
						ctx.notice("warn", `no live run matches ${result.target}${known}`);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes-open") {
				runLocal(async () => {
					const result = await panes.open({
						...(command.preset ? { preset: command.preset } : {}),
						...(command.argv ? { argv: command.argv } : {}),
						...(command.once ? { once: true } : {}),
					});
					if (result.status === "opened") {
						// The in-terminal chooser has already restored the TUI by the
						// time this resolves. A pick emitted its composer notice; an empty
						// chooser was cancellation and deliberately stays silent.
						if (result.paneId !== null) {
							ctx.notice(
								"success",
								result.existing
									? `focused pane ${result.label} (${result.paneId})`
									: `opened pane ${result.label} (${result.paneId})`,
							);
						}
					} else if (result.status === "missing-binary") {
						// This is a synchronous slash-surface line, not a transient pane-host
						// notification. It remains visible when no pane was ever created and
						// reuses the exact doctor/tools diagnostic including the install hint.
						ctx.io.stdout(`${result.detail}\n`);
						ctx.render?.();
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind === "panes-zoom") {
				runLocal(async () => {
					const result = await panes.zoom(command.target);
					if (result.status === "zoomed") {
						ctx.notice("success", `toggled zoom on ${result.label} (${result.paneId})`);
					} else if (result.status === "not-found") {
						ctx.notice("warn", `no PanCode-owned pane matches ${result.target}`);
					} else {
						ctx.notice("warn", result.reason);
					}
				});
				return;
			}
			if (command.kind !== "panes-close") return;
			runLocal(async () => {
				const result = await panes.close(command.target);
				if (result.status === "closed") {
					const what = result.labels.length > 0 ? `: ${result.labels.join(", ")}` : "";
					ctx.notice(result.closed > 0 ? "success" : "info", `closed ${result.closed} pane(s)${what}`);
				} else if (result.status === "not-found") {
					ctx.notice("warn", `no PanCode-owned pane matches ${result.target}`);
				} else {
					ctx.notice("warn", result.reason);
				}
			});
		},
	},
	{
		name: "files",
		rank: 3,
		acp: false,
		description: "Show or hide the files pane; picks land in the composer as @ mentions",
		group: "PanCode",
		kinds: ["files"],
		args: { subcommands: { open: {}, hide: {}, close: {}, pick: {} } },
		subcommandDescriptions: {
			open: "Open or reveal the files pane and move the keyboard into it",
			hide: "Hide the files pane; Yazi keeps running and keeps its directory",
			close: "Close the files pane and end Yazi",
			pick: "Borrow the files pane for one selection, then close it",
		},
		fromArgs(parsed, trimmed) {
			const action = parsed.subcommand;
			if (action === "open" || action === "hide" || action === "close" || action === "pick") {
				return parsed.error ? usageError("files", parsed.error, action) : { kind: "files", action };
			}
			// `toggle` is what the bare command does; it stays accepted though it is not listed.
			if (/^\/files\s+toggle$/u.test(trimmed) || !parsed.error) return { kind: "files", action: "toggle" };
			return usageError("files", parsed.error);
		},
		handle(command, ctx) {
			if (command.kind !== "files") return;
			const panes = ctx.panes;
			if (!panes) {
				ctx.notice("info", panesInactiveWords("the files pane is inactive"));
				return;
			}
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			runLocal(async () => {
				const result = await panes.files(command.action);
				if (result.status === "opened") {
					// The in-terminal chooser reports through its own composer notice.
					if (result.paneId !== null) {
						// A managed files dock splits down from this pane; without the layout tier the
						// pane host makes a plain split to the right, and the dock report shows it closed.
						const docked = (await panes.docks()).some((dock) => dock.slot === "files" && dock.state === "visible");
						ctx.notice(
							"success",
							`${result.revealed ? "Files pane shown" : result.existing ? "Files pane focused" : "Files pane opened"} ${docked ? "below" : "beside"} this one. Picks land in the composer as @ mentions; /files hides it.`,
						);
					}
				} else if (result.status === "hidden") {
					ctx.notice("info", "Files pane hidden; /files shows it again in the same directory.");
				} else if (result.status === "closed") {
					ctx.notice("info", "Files pane closed.");
				} else if (result.status === "missing-binary") {
					ctx.io.stdout(`${result.detail}\n`);
					ctx.render?.();
				} else if (result.status === "refused" && /interface\.panes\.files\.enabled/u.test(result.reason)) {
					// The gate's reason names the key; the operator also needs where to flip it.
					ctx.notice(
						"warn",
						"The files pane is off. Turn on Files pane in /settings (Workspace), or set interface.panes.files.enabled: true, then run /files again.",
					);
				} else {
					ctx.notice("warn", result.reason);
				}
			});
		},
	},
];

const CANONICAL_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	...HARNESS_SLASH_COMMANDS,
	...WORK_SLASH_COMMANDS,
	...CONTEXT_SLASH_COMMANDS,
	...FLEET_SLASH_COMMANDS,
	...MEMORY_SLASH_COMMANDS,
	...PANES_SLASH_COMMANDS,
	...MODEL_SLASH_COMMANDS,
	...SESSION_SLASH_COMMANDS,
];

/**
 * Why a pane feature is off in this session. A home without PanCode's pane host is told the install, since launch
 * does not say it on every start (bt-11 #4); otherwise the ways to start a session with panes.
 */
export function panesInactiveWords(lead: string): string {
	if (pinnedProgramMissing("herdr")) {
		return `${lead}: terminal panes are not installed. Run \`pancode panes install\`, then restart \`pancode\``;
	}
	return `${lead}: this session started without panes. Restart \`pancode\` in a plain terminal to open its own pane host, or run \`pancode --with-panes\` inside herdr`;
}

const contextCommand = CANONICAL_SLASH_COMMANDS.find((entry) => entry.name === "context");
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	...CANONICAL_SLASH_COMMANDS,
	...(contextCommand
		? [
				{
					...contextCommand,
					aliases: [],
					name: "compact",
					rank: 1 as const,
					acp: false as const,
					kinds: [],
					description: "Shrink session context (alias for /context compact)",
					args: { positionals: [...COMPACT_POSITIONALS] },
					subcommandDescriptions: {},
					fromArgs: (parsed: ParsedArgs): SlashCommand =>
						parsed.error
							? { kind: "usage-error", command: "compact", reason: parsed.error }
							: { kind: "compact", instructions: parsed.rest },
				},
			]
		: []),
];

export const HANDLER_BY_KIND = new Map<SlashCommandKind, BuiltinSlashCommand>();
const COMMAND_NAMES = new Set<string>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	if (COMMAND_NAMES.has(entry.name)) {
		throw new Error(`BUILTIN_SLASH_COMMANDS: command name "${entry.name}" is registered more than once`);
	}
	COMMAND_NAMES.add(entry.name);
	for (const kind of entry.kinds) {
		if (HANDLER_BY_KIND.has(kind)) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: kind "${kind}" is owned by multiple entries`);
		}
		HANDLER_BY_KIND.set(kind, entry);
	}
}

/** Alias name to the command line it stands for, without the leading slash. */
const ALIAS_TARGETS = new Map<string, { command: string; line: string }>();
for (const entry of BUILTIN_SLASH_COMMANDS) {
	for (const alias of entry.aliases ?? []) {
		if (COMMAND_NAMES.has(alias.name)) {
			throw new Error(`BUILTIN_SLASH_COMMANDS: alias "${alias.name}" of /${entry.name} equals the command /${alias.name}`);
		}
		const other = ALIAS_TARGETS.get(alias.name);
		if (other) {
			throw new Error(
				`BUILTIN_SLASH_COMMANDS: alias "${alias.name}" is claimed by both /${other.command} and /${entry.name}`,
			);
		}
		ALIAS_TARGETS.set(alias.name, {
			command: entry.name,
			line: alias.args ? `${entry.name} ${alias.args}` : entry.name,
		});
	}
}

/** Every name a typed `/name` reaches a built-in by, so an extension's bare alias never takes one. */
export const BUILTIN_SLASH_NAMES: ReadonlySet<string> = new Set([...COMMAND_NAMES, ...ALIAS_TARGETS.keys()]);

/** `/clear foo` becomes `/new foo`; anything that is not an alias comes back unchanged. */
function resolveAlias(trimmed: string): string {
	const match = /^\/([A-Za-z][A-Za-z0-9-]*)(?=\s|$)/u.exec(trimmed);
	const target = match ? ALIAS_TARGETS.get(match[1] ?? "") : undefined;
	if (!match || !target) return trimmed;
	const rest = trimmed.slice(match[0].length).trim();
	return `/${target.line}${rest ? ` ${rest}` : ""}`;
}

/**
 * A token that could only have been meant as a command: one word of letters,
 * digits, hyphens, or colons after the leading slash. Colons are included so
 * namespaced forms such as `/skill:name` fail closed instead of becoming
 * model input.
 *
 * A spelling that names no command would otherwise reach the model as prose.
 * Measured: `/compact` sent that way was answered "/compact (completed)" in six
 * output tokens while context stayed at 9%, no compaction summary was written,
 * and no hook fired. The operator read a completion that never happened. Only
 * active commands run, so anything command-shaped that the registry does not
 * claim fails here rather than being answered by a model that will invent a
 * result.
 *
 * The shape test is what keeps that from swallowing ordinary text, because a
 * leading slash is also how an absolute path starts. `/home/user/notes` and
 * `/not/a/command` carry a separator, so they are not one word and still reach
 * the model unchanged.
 *
 * One word followed by prose stays ambiguous: `/status please` is the defect
 * and `/tmp is full` is a sentence, and nothing in the text separates them. It
 * resolves as a command, so a sentence that has to open this way needs
 * COMMAND_ESCAPE.
 */
const COMMAND_SHAPED_TOKEN = /^[A-Za-z][A-Za-z0-9:-]*$/u;

/**
 * Prefix that sends a command-shaped line to the model as text.
 *
 * A leading space cannot be the escape: the terminal engine trims the submitted
 * line inside its own submit path, so the parser only ever sees text with the
 * whitespace already gone. A backslash survives the trim. It claims one
 * character and only in front of a slash, so `\\server\share` and
 * `\note to self` are still ordinary text.
 */
const COMMAND_ESCAPE = "\\/";

/** Pure slash-command parser: no I/O, no side effects. Walks the registry in order. */
/**
 * One notice line for a reload outcome. Success when the generation committed
 * cleanly; warn when it committed with dropped hooks or declaration issues;
 * error when it was refused and the previous generation stays active.
 */
export function formatExtensionReloadNotice(outcome: ExtensionReloadOutcome): [NoticeLevel, string] {
	if (outcome.status !== "committed") {
		return ["error", `extensions: reload rejected (${outcome.reason}); generation ${outcome.generation} stays active`];
	}
	const delta = outcome.changed
		? `changed: +${outcome.added.length} -${outcome.removed.length} ~${outcome.modified.length}`
		: "unchanged";
	const issueCount = outcome.hooks.fileIssues + outcome.hooks.issues;
	const hookParts = [`${outcome.hooks.registered} registered`];
	if (outcome.hooks.dropped > 0) hookParts.push(`${outcome.hooks.dropped} dropped`);
	if (issueCount > 0) hookParts.push(`${issueCount} issue${issueCount === 1 ? "" : "s"}`);
	if (outcome.hooks.overridden > 0) hookParts.push(`${outcome.hooks.overridden} overridden`);
	const level: NoticeLevel = outcome.hooks.dropped > 0 || issueCount > 0 ? "warn" : "success";
	return [level, `extensions: generation ${outcome.generation} committed (${delta}); hooks: ${hookParts.join(", ")}`];
}

/**
 * A rejected `/modle` stays in the composer as an editable draft, so typing
 * `/thinking` after it submits `/modle/thinking`. Every segment of that token is
 * command-shaped and the last one is a command, which a path such as
 * `/tmp/x is broken` is not; the line is refused like the typo, not sent to the model.
 */
function isComposedCommandToken(token: string): boolean {
	const segments = token.split("/");
	if (segments.length < 2 || !segments.every((segment) => COMMAND_SHAPED_TOKEN.test(segment))) return false;
	const kind = parseSlashCommand(`/${segments[segments.length - 1]}`).kind;
	return kind !== "unknown" && kind !== "unknown-command" && kind !== "empty";
}

export function parseSlashCommand(input: string): SlashCommand {
	if (/^\s*\/rename\s+$/u.test(input)) {
		return { kind: "usage-error", command: "rename", reason: "Session name must not be empty or whitespace-only" };
	}
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (trimmed.startsWith(COMMAND_ESCAPE)) return { kind: "unknown", text: trimmed.slice(1) };
	const resolved = resolveAlias(trimmed);
	for (const entry of BUILTIN_SLASH_COMMANDS) {
		const match = entry.match ? entry.match(resolved) : matchFromSpec(entry, resolved);
		if (match) return match;
	}
	if (trimmed.startsWith("/")) {
		const token = trimmed.slice(1).split(/\s+/u)[0] ?? "";
		if (COMMAND_SHAPED_TOKEN.test(token) || isExtensionCommandToken(token) || isComposedCommandToken(token))
			return { kind: "unknown-command", token, text: trimmed };
	}
	return { kind: "unknown", text: trimmed };
}
