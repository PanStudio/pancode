// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPancodeVersionLabel } from "../core/build-info.js";
import { readSettings, settingsPath, updateSettings } from "../core/config.js";
import {
	type OutputStyle,
	type PanesSettings,
	type SmoothStreaming,
	type TuiMode,
	WORKER_PERMISSION_MODES,
	type WorkerPermissionMode,
} from "../core/defaults.js";
import type { FundingBinding, FundingPool } from "../core/funding-config.js";
import { FUNDING_ID_PATTERN, FUNDING_PAYERS, FUNDING_PERIODS, isInstitutionalPool } from "../core/funding-config.js";
import { resolvePackageRoot } from "../core/package-root.js";
import { getAtPath, resolveMemoryRoute } from "../core/session-routing.js";
import { SHARED_SETTINGS_AREAS, type SharedSettingsAreaId, settingsPlacementForPath } from "../core/settings-areas.js";
import { formatControlValue, orderSettingsEntries, type SettingControl } from "../core/settings-controls.js";
import { renderUsdLimit } from "../core/telemetry/render.js";
import { resolvePancodeDirs } from "../core/xdg.js";
import { getVersionInfo } from "../domains/install/version.js";
import { targetFundingEvidence } from "../domains/providers/funding-evidence.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import {
	describeLocalCapacity,
	observeHostCapacityFacts,
	resolveLocalConcurrency,
} from "../domains/scheduling/local-capacity.js";
import { autonomyFromUserInput } from "../lib/autonomy/autonomy.js";
import { ask, askYesNo } from "./ask.js";
import { emptyArgs } from "./configure-args.js";
import { editSettingControl, orderedAreaControls } from "./configure-controls.js";
import { editSettings } from "./configure-editor.js";
import { runInteropReview } from "./configure-interop.js";
import { canRunOnboarding, runOnboardingWizard } from "./configure-onboarding.js";
import { ConfigureNavigation, type ConfigurePrompts } from "./configure-prompts.js";
import { assignTarget } from "./configure-routing.js";
import { describeTargetFunding } from "./configure-target.js";
import {
	pickRuntimeViaCategory,
	runTargetRemove,
	runTargetRename,
	runTargetSetupInteractive,
} from "./configure-target-setup.js";
import { shortenPath } from "./install-presenter.js";

/**
 * The runtime configuration screens.
 *
 * Every screen is one `SectionSpec`: a title, the values it shows, and the
 * actions that change them. Rendering goes through the lifecycle presenter, so
 * `configure` degrades on a pipe and under NO_COLOR exactly as `reset`,
 * `upgrade`, and `uninstall` do. Navigation goes through `pickEntry`, which
 * uses the arrow-key selector on a terminal and the numbered readline prompt
 * everywhere else, so Escape leaves a screen without the screen having to teach
 * a token for it, and a scripted run still has a way to answer.
 */

export interface SectionIo {
	rl: ConfigurePrompts;
	out: NodeJS.WritableStream;
	/** Both ends of this run, for an action that opens a picker of its own. */
	streams: ConfigureStreams;
	/** Confirm one change on the transcript, in the presenter's voice. */
	ok: (text: string) => void;
	warn: (text: string) => void;
	/** Target setup sends its test request before saving; off with `--no-verify`. */
	verify: boolean;
}

interface SectionAction {
	controlPath?: string;
	/** A setting path that places an action without a setting of its own beside that setting's group. */
	place?: string;
	label: string;
	hint?: string | (() => string);
	run: (io: SectionIo) => Promise<void>;
}

export interface SectionSpec {
	/** The `--section` value, which is the area id. */
	id: string;
	title: string;
	/** What the main menu says this screen covers. */
	summary: string;
	fields: () => Array<readonly [string, string]>;
	actions: ReadonlyArray<SectionAction>;
}

const NONE = "(none)";
const onOff = (value: boolean): string => (value ? "enabled" : "disabled");
/** `auto` shows what this host resolves it to for the local node, as one short phrase. */
function concurrencyLabel(concurrency: "auto" | number): string {
	if (concurrency !== "auto") return String(concurrency);
	const local = resolveLocalConcurrency("auto", observeHostCapacityFacts());
	return `auto · ${describeLocalCapacity(local) ?? `local ${local.limit}`}`;
}

const listOr = (values: ReadonlyArray<string>, fallback = NONE): string =>
	values.length > 0 ? values.join(", ") : fallback;

/** Read a bounded integer, leaving the setting alone when the answer is not one. */
async function askInteger(
	io: SectionIo,
	label: string,
	current: number,
	apply: (value: number) => void,
	min = 0,
): Promise<void> {
	const answer = await ask(io.rl, label, String(current));
	if (answer === null) return;
	const parsed = Number(answer);
	if (!Number.isSafeInteger(parsed) || parsed < min) {
		io.warn(`${label} must be a whole number of at least ${min}; left at ${current}\n`);
		return;
	}
	const value = parsed;
	apply(value);
	io.ok(`${label} set to ${value}`);
}

/** Read one of a fixed set of words, leaving the setting alone otherwise. */
async function askChoice(
	io: SectionIo,
	label: string,
	allowed: ReadonlyArray<string>,
	current: string,
	apply: (value: string) => void,
): Promise<void> {
	const answer = await io.rl.choose(label, allowed, current);
	if (answer === null) return;
	const value = answer.trim().toLowerCase();
	if (!allowed.includes(value)) {
		io.warn(`${label} must be one of ${allowed.join(", ")}; left at ${current}\n`);
		return;
	}
	apply(value);
	io.ok(`${label} set to ${value}`);
}

async function runTargetWizard(io: SectionIo, options: Parameters<typeof runOnboardingWizard>[1]): Promise<void> {
	const before = readSettings().targets;
	io.rl.clearScreen();
	const code = await runOnboardingWizard(io.streams, options);
	if (code === 130) throw new ConfigureNavigation("quit");
	if (code !== 0) {
		// Keep the actual save error visible until the user has read it.
		await io.rl.text("Press Enter to return");
		io.warn("Target settings were not saved.");
		return;
	}
	const changed = readSettings().targets.find(
		(target) => JSON.stringify(target) !== JSON.stringify(before.find((entry) => entry.id === target.id)),
	);
	if (changed) io.ok(`Target ${changed.id} saved`);
}

async function askFundingNumber(rl: ConfigurePrompts, label: string): Promise<number | undefined> {
	const answer = (await rl.text(label)).trim();
	if (answer === "") return undefined;
	const value = Number(answer);
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(answer) || !Number.isFinite(value))
		throw new Error(`${label}: expected a non-negative decimal number`);
	return value;
}

async function declareFundingPool(rl: ConfigurePrompts): Promise<FundingPool> {
	const pool: FundingPool = { scheme: "declared" };
	const payer = await rl.choose("Payer", ["unknown", ...FUNDING_PAYERS], "unknown");
	if (payer !== "unknown") {
		const known = FUNDING_PAYERS.find((value) => value === payer);
		if (known === undefined) throw new Error("choose personal, sponsor, employer, none, or unknown");
		pool.payer = known;
	}
	const unit = (await rl.text("Native unit (e.g. credits, tokens, compute-hours; blank to skip)")).trim();
	if (unit) pool.nativeUnit = unit;
	const amount = await askFundingNumber(rl, "Fee amount (blank to skip)");
	if (amount !== undefined) {
		const currency = (await rl.text("Fee currency (ISO 4217, e.g. USD)")).trim().toUpperCase();
		const periodChoice = await rl.choose("Fee period", FUNDING_PERIODS, "month");
		const period = FUNDING_PERIODS.find((value) => value === periodChoice);
		if (period === undefined) throw new Error("choose a fee period from the list");
		pool.fee = { amount, currency, period };
	}
	if (isInstitutionalPool(pool) || (await askYesNo(rl, "Declare grant or prepaid credit facts?", false))) {
		const expiresAt = (await rl.text("Grant expiry (UTC, YYYY-MM-DDTHH:MM:SSZ)")).trim();
		const grantAmount = await askFundingNumber(rl, "Grant amount in the native unit (blank if unknown)");
		pool.grant = { expiresAt, ...(grantAmount !== undefined ? { amount: grantAmount } : {}) };
	}
	if (await askYesNo(rl, "Declare local electricity facts?", false)) {
		const activeWatts = await askFundingNumber(rl, "Active watts (blank if unknown)");
		const idleWatts = await askFundingNumber(rl, "Idle watts (blank if unknown)");
		if (activeWatts !== undefined && idleWatts !== undefined && activeWatts < idleWatts)
			throw new Error("Active watts must be at least idle watts");
		const ratePerKwh = await askFundingNumber(rl, "Electricity rate per kWh (blank if unknown)");
		const tariff =
			ratePerKwh === undefined
				? undefined
				: { ratePerKwh, currency: (await rl.text("Electricity currency (ISO 4217, e.g. USD)")).trim().toUpperCase() };
		pool.local = {
			...(activeWatts !== undefined ? { activeWatts } : {}),
			...(idleWatts !== undefined ? { idleWatts } : {}),
			...(tariff !== undefined ? { tariff } : {}),
		};
	}
	return pool;
}

async function configureTargetFunding(io: SectionIo): Promise<void> {
	const settings = readSettings();
	const targets = settings.targets.map((target) => target.id);
	if (targets.length === 0) {
		io.warn("Add a target before binding a funding pool.");
		return;
	}
	const id = await io.rl.choose("Target for funding", targets, targets[0] ?? "");
	const target = settings.targets.find((entry) => entry.id === id);
	if (target === undefined) throw new Error("choose a configured target");
	const evidence = targetFundingEvidence(target);
	const declared = Object.keys(settings.funding).filter((key) => settings.funding[key]?.scheme === "declared");
	const choices = [
		"unknown / skip",
		"declare and bind a new pool",
		...(declared.length > 0 ? ["bind an existing declared pool"] : []),
		...(evidence.observation !== undefined ? ["record detected scheme in a new pool"] : []),
		...(target.funding !== undefined ? ["remove binding"] : []),
	];
	const action = await io.rl.choose(
		`Funding for ${id}; hint: ${evidence.hint} (not a billing plan)`,
		choices,
		choices[0] ?? "",
	);
	let binding: FundingBinding | undefined;
	let pool: FundingPool | undefined;
	switch (action) {
		case "unknown / skip":
			return;
		case "remove binding":
			break;
		case "bind an existing declared pool":
			binding = { pool: await io.rl.choose("Declared pool", declared, declared[0] ?? "") };
			if (!declared.includes(binding.pool)) throw new Error("choose an existing declared funding pool");
			break;
		case "declare and bind a new pool":
		case "record detected scheme in a new pool": {
			const key = (
				await io.rl.text("New pool id (letters, digits, hyphens or underscores; no account identifiers)")
			).trim();
			if (!FUNDING_ID_PATTERN.test(key) || Object.hasOwn(Object.prototype, key) || Object.hasOwn(settings.funding, key))
				throw new Error("choose a new pool id starting with a letter");
			binding = { pool: key };
			if (action === "declare and bind a new pool") pool = await declareFundingPool(io.rl);
			else {
				if (evidence.observation === undefined) throw new Error("the current login does not support detection");
				pool = { scheme: "detected" };
				binding.detection = { ...evidence.observation, verifiedAt: new Date().toISOString() };
			}
			break;
		}
		default:
			throw new Error("choose a funding action from the list");
	}
	updateSettings((draft) => {
		const current = draft.targets.find((entry) => entry.id === id);
		if (current === undefined) throw new Error(`target ${id} no longer exists`);
		if (binding === undefined) {
			delete current.funding;
			return;
		}
		if (pool !== undefined) {
			if (Object.hasOwn(draft.funding, binding.pool)) throw new Error(`pool ${binding.pool} already exists`);
			if (binding.detection && targetFundingEvidence(current).observation?.loginStamp !== binding.detection.loginStamp)
				throw new Error("the target login or route changed; reopen funding to check it again");
			draft.funding[binding.pool] = pool;
		} else if (draft.funding[binding.pool]?.scheme !== "declared") {
			throw new Error(`pool ${binding.pool} is no longer declared`);
		}
		current.funding = binding;
	});
	io.ok(binding === undefined ? `Funding binding removed from ${id}` : `Funding pool ${binding.pool} bound to ${id}`);
}

/**
 * The hand-written parts of the configure screens, named by subject. Each part's summary rows open the area
 * PART_AREA names; each action lands in the area its setting lives in, so the screens follow the shared areas.
 */
const CONTENT_PARTS = {
	connections: {
		fields: () => {
			const settings = readSettings();
			const rows: Array<readonly [string, string]> = [];
			for (const target of settings.targets) {
				rows.push([
					target.id,
					`${target.runtime} · ${target.url ?? "provider default"} · ${target.defaultModel ?? "no default model"}`,
				]);
				rows.push([`Funding for ${target.id}`, describeTargetFunding(target, settings.funding)]);
			}
			return rows.length ? rows : [["Connections", "No connections yet. Choose Add a target to connect a provider."]];
		},
		actions: [
			{
				label: "Add a target",
				place: "targets",
				hint: "register a provider endpoint",
				run: async (io) => {
					if (canRunOnboarding(io.streams)) {
						await runTargetWizard(io, {
							mode: readSettings().targets.length === 0 ? "first" : "add",
							verify: io.verify,
						});
						return;
					}
					const runtime = await pickRuntimeViaCategory(io.rl);
					if (runtime) await runTargetSetupInteractive(io.rl, runtime, emptyArgs());
				},
			},
			{
				label: "Edit a target",
				place: "targets",
				hint: "endpoint, credentials, model, capabilities",
				run: async (io) => {
					const targets = readSettings().targets;
					if (targets.length === 0) return;
					const id = await io.rl.choose(
						"Target to edit",
						targets.map((target) => target.id),
						targets[0]?.id ?? "",
					);
					const target = targets.find((entry) => entry.id === id);
					if (!target) return;
					if (canRunOnboarding(io.streams)) {
						await runTargetWizard(io, { mode: "edit", target });
					} else {
						const runtime = getRuntimeRegistry().get(target.runtime);
						if (runtime) await runTargetSetupInteractive(io.rl, runtime, { ...emptyArgs(), id });
					}
				},
			},
			{
				label: "Rename a target",
				place: "targets",
				run: async (io) => {
					const ids = readSettings().targets.map((target) => target.id);
					if (ids.length === 0) return;
					const id = await io.rl.choose("Target to rename", ids, ids[0] ?? "");
					const name = await ask(io.rl, "New target id", id);
					if (!name || name === id) return;
					if (ids.includes(name)) {
						io.warn(`Target id already exists: ${name}`);
						return;
					}
					if (runTargetRename(id, name) === 0) io.ok(`Renamed ${id} to ${name}`);
					else io.warn(`Could not rename target ${id}`);
				},
			},
			{
				label: "Remove a target",
				place: "targets",
				run: async (io) => {
					const settings = readSettings();
					const ids = settings.targets.map((target) => target.id);
					if (ids.length === 0) {
						io.warn("No targets to remove.");
						return;
					}
					io.out.write(`  Registered: ${ids.join(", ")}\n`);
					const chosen = await io.rl.choose("Target to remove", ids, ids[0] ?? "");
					if (chosen === null || !ids.includes(chosen)) return;
					if (await askYesNo(io.rl, `Remove target '${chosen}'?`, false)) {
						if (runTargetRemove(chosen) === 0) io.ok(`Removed target ${chosen}`);
						else io.warn(`Could not remove target ${chosen}`);
					}
				},
			},
			{
				label: "Funding for a target",
				place: "targets[].funding",
				hint: "optional fee, grant or electricity facts; does not send requests",
				run: configureTargetFunding,
			},
		],
	},
	chatModel: {
		fields: () => {
			const settings = readSettings();
			return [
				["Chat target", settings.chat.target ?? NONE],
				["Chat model", settings.chat.model ?? "(target default)"],
				["Chat thinking", settings.chat.thinkingLevel],
				["Favorites", listOr(settings.chat.modelPicker.favorites)],
				["Model cycle set", listOr(settings.chat.modelPicker.cycleSet)],
				["Max output tokens", String(settings.chat.maxOutputTokens)],
				["Prompt prewarm", onOff(settings.chat.prewarm)],
			];
		},
		actions: [
			{
				label: "Choose the chat model",
				controlPath: "chat.target",
				hint: "select a connection, then a model PanCode can list for it",
				run: async (io) => assignTarget(io, "chat"),
			},
		],
	},
	workers: {
		fields: () => {
			const settings = readSettings();
			return [
				["Fleet target", settings.fleet.default.target ?? NONE],
				["Fleet model", settings.fleet.default.model ?? "(target default)"],
				["Fleet thinking", settings.fleet.default.thinkingLevel],
				["Concurrency limit", concurrencyLabel(settings.fleet.concurrency)],
				["Max retries", String(settings.fleet.retry.maxRetries)],
				["Tool calls per run", String(settings.fleet.limits.toolCallsPerRun)],
				["Run timeout", `${settings.fleet.limits.internalRunTimeoutMs / 1000}s`],
				["Worker profiles", listOr(Object.keys(settings.fleet.profiles))],
				[
					"Agent routes",
					listOr(Object.entries(settings.fleet.agentProfiles).map(([agent, profile]) => `${agent} -> ${profile}`)),
				],
				["Remote nodes", listOr(settings.fleet.nodes.map((node) => node.id))],
			];
		},
		actions: [
			{
				label: "Choose the default fleet model",
				controlPath: "fleet.default.target",
				hint: "select a connection, then a model PanCode can list for it",
				run: async (io) => assignTarget(io, "fleet"),
			},
		],
	},
	context: {
		fields: () => {
			const settings = readSettings();
			const memoryRoute = resolveMemoryRoute(settings);
			return [
				["Auto-compaction", onOff(settings.context.compaction.auto)],
				["Compaction threshold", String(settings.context.compaction.threshold)],
				["Compaction model", settings.context.compaction.model ?? "(chat model)"],
				["Working-set eviction", onOff(settings.context.workingSet.enabled)],
				["Tool result cap (bytes)", String(settings.context.toolResultMaxBytes)],
				[
					"Memory target",
					`${memoryRoute.source === "chat" ? "Chat route (no memory model set): " : ""}${memoryRoute.target ?? "(unset)"}`,
				],
				["Memory model", memoryRoute.model ?? (memoryRoute.source === "chat" ? "(unset)" : "(target default)")],
				["Proactive memory", onOff(settings.context.memory.enabled)],
			];
		},
		actions: [
			{
				label: "Choose the proactive-memory model",
				controlPath: "context.memory.target",
				hint: "optional; with no memory model set, memory uses the chat route",
				run: async (io) => assignTarget(io, "memory"),
			},
		],
	},
	safety: {
		fields: () => {
			const settings = readSettings();
			return [
				["Autonomy level", settings.safety.autonomy],
				["Worker permissions", settings.fleet.permissions.mode],
				[
					"Session cost limit",
					settings.safety.limits.sessionCostUsd === 0 ? "none" : renderUsdLimit(settings.safety.limits.sessionCostUsd),
				],
				["Turn tool budget", String(settings.safety.limits.chatToolCallsPerTurn)],
				["Review watchdog", onOff(settings.safety.review.enabled)],
				["External agent governance", settings.integrations.externalAgents.defaults.toolGovernance],
			];
		},
		actions: [
			{
				label: "Autonomy level",
				controlPath: "safety.autonomy",
				hint: "default | yolo",
				run: async (io) => {
					io.out.write(
						"  default edits the workspace and runs recognized checks; unfamiliar commands ask.\n  yolo never asks; it keeps default's sandbox and safety judge and refuses what would need your approval.\n  Unconfined yolo (safety.yoloConfinement, accepted once) blocks only on the yolo floor and approved safety.yaml rules.\n",
					);
					await askChoice(io, "Autonomy level", ["default", "yolo"], readSettings().safety.autonomy, (value) => {
						updateSettings((draft) => {
							draft.safety.autonomy = autonomyFromUserInput(value) ?? draft.safety.autonomy;
						});
					});
				},
			},
			{
				label: "Worker permission mode",
				controlPath: "fleet.permissions.mode",
				hint: WORKER_PERMISSION_MODES.join(" | "),
				run: async (io) => {
					await askChoice(
						io,
						"Worker permission mode",
						WORKER_PERMISSION_MODES,
						readSettings().fleet.permissions.mode,
						(value) => {
							updateSettings((draft) => {
								draft.fleet.permissions.mode = value as WorkerPermissionMode;
							});
						},
					);
				},
			},
			{
				label: "Session cost limit",
				controlPath: "safety.limits.sessionCostUsd",
				hint: "USD",
				run: async (io) => {
					const current = readSettings().safety.limits.sessionCostUsd;
					const answer = await ask(io.rl, "Session cost limit in USD (0 for no limit)", String(current));
					if (answer === null) return;
					const parsed = Number(answer);
					if (!Number.isFinite(parsed) || parsed < 0) {
						io.warn(`Session cost limit must be 0 or greater; left at ${renderUsdLimit(current)}\n`);
						return;
					}
					updateSettings((draft) => {
						draft.safety.limits.sessionCostUsd = parsed;
					});
					io.ok(parsed === 0 ? "Session cost limit removed" : `Session cost limit set to ${renderUsdLimit(parsed)}`);
				},
			},
			{
				label: "Turn tool budget",
				controlPath: "safety.limits.chatToolCallsPerTurn",
				run: async (io) => {
					await askInteger(
						io,
						"Turn tool budget",
						readSettings().safety.limits.chatToolCallsPerTurn,
						(value) => {
							updateSettings((draft) => {
								draft.safety.limits.chatToolCallsPerTurn = value;
							});
						},
						1,
					);
				},
			},
			{
				label: "Turn-end review watchdog",
				controlPath: "safety.review.enabled",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.safety.review.enabled = !draft.safety.review.enabled;
						next = draft.safety.review.enabled;
					});
					io.ok(`Review watchdog ${onOff(next)}`);
				},
			},
		],
	},
	display: {
		fields: () => {
			const settings = readSettings();
			return [
				["TUI mode", settings.interface.mode],
				["Output style", settings.interface.outputDetail],
				["Smooth streaming", settings.interface.smoothStreaming],
				["Terminal progress", onOff(settings.interface.terminalProgress)],
				["Desktop notifications", onOff(settings.interface.desktopNotifications)],
				["Retry transient errors", onOff(settings.chat.retry.enabled)],
				["Max retries", String(settings.chat.retry.maxRetries)],
			];
		},
		actions: [
			{
				label: "Smooth streaming",
				controlPath: "interface.smoothStreaming",
				hint: "off | auto | on",
				run: async (io) => {
					await askChoice(
						io,
						"Smooth streaming",
						["off", "auto", "on"],
						readSettings().interface.smoothStreaming,
						(value) => {
							updateSettings((draft) => {
								draft.interface.smoothStreaming = value as SmoothStreaming;
							});
						},
					);
				},
			},
			{
				label: "Terminal progress indicator",
				controlPath: "interface.terminalProgress",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.interface.terminalProgress = !draft.interface.terminalProgress;
						next = draft.interface.terminalProgress;
					});
					io.ok(`Terminal progress ${onOff(next)}`);
				},
			},
			{
				label: "Startup layout",
				controlPath: "interface.panes.layout",
				hint: "off | workers | cockpit",
				run: async (io) => {
					await askChoice(
						io,
						"Startup layout",
						["off", "workers", "cockpit"],
						readSettings().interface.panes.layout,
						(value) => {
							updateSettings((draft) => {
								draft.interface.panes.layout = value as PanesSettings["layout"];
							});
						},
					);
				},
			},
			{
				label: "TUI mode",
				controlPath: "interface.mode",
				hint: "regular | fullscreen",
				run: async (io) => {
					await askChoice(io, "TUI mode", ["regular", "fullscreen"], readSettings().interface.mode, (value) => {
						updateSettings((draft) => {
							draft.interface.mode = value as TuiMode;
						});
					});
				},
			},
			{
				label: "Output style",
				controlPath: "interface.outputDetail",
				hint: "compact | standard | detailed",
				run: async (io) => {
					await askChoice(
						io,
						"Output style",
						["compact", "standard", "detailed"],
						readSettings().interface.outputDetail,
						(value) => {
							updateSettings((draft) => {
								draft.interface.outputDetail = value as OutputStyle;
							});
						},
					);
				},
			},
			{
				label: "Desktop notifications",
				controlPath: "interface.desktopNotifications",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.interface.desktopNotifications = !draft.interface.desktopNotifications;
						next = draft.interface.desktopNotifications;
					});
					io.ok(`Desktop notifications ${onOff(next)}`);
				},
			},
		],
	},
	workspace: {
		fields: () => {
			const settings = readSettings();
			const rows: Array<readonly [string, string]> = [
				["Startup layout", settings.interface.panes.layout],
				["Task worktree root", settings.fleet.worktrees.root],
				["Trust project imports", settings.integrations.projectResources.trustProjectImports ? "trusted" : "untrusted"],
				["External ACP agents", String(settings.integrations.externalAgents.entries.length)],
				["Provider packages", listOr(settings.integrations.providerPackages)],
				["Hub remote sync", onOff(settings.integrations.hub.sync)],
				["Git commit attribution", onOff(settings.integrations.git.commitAttribution)],
				["Autonomous commit author", settings.integrations.git.commitAuthor],
			];
			for (const agent of settings.integrations.externalAgents.entries)
				rows.push([agent.id, `${agent.command} (governance: ${agent.toolGovernance ?? "default"})`]);
			return rows;
		},
		actions: [
			{
				label: "Git commit attribution",
				controlPath: "integrations.git.commitAttribution",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.git.commitAttribution = !draft.integrations.git.commitAttribution;
						next = draft.integrations.git.commitAttribution;
					});
					io.ok(`Git commit attribution ${onOff(next)}`);
				},
			},
			{
				label: "Trust project imports",
				controlPath: "integrations.projectResources.trustProjectImports",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.projectResources.trustProjectImports =
							!draft.integrations.projectResources.trustProjectImports;
						next = draft.integrations.projectResources.trustProjectImports;
					});
					io.ok(`Project imports ${next ? "trusted" : "untrusted"}`);
				},
			},
			{
				label: "Review external ACP agents",
				hint: "runs the interop review",
				run: async (io) => {
					await runInteropReview({ rl: io.rl, streams: io.streams });
				},
			},
			{
				label: "Adopt from Claude Code, Codex and other agents",
				hint: "reviews skills, agents, prompts and MCP servers",
				run: async (io) => {
					const { runInteropAdoptionReview } = await import("./interop.js");
					await runInteropAdoptionReview({ rl: io.rl });
				},
			},
			{
				label: "Hub remote sync",
				controlPath: "integrations.hub.sync",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.hub.sync = !draft.integrations.hub.sync;
						next = draft.integrations.hub.sync;
					});
					io.ok(`Hub remote sync ${onOff(next)}`);
				},
			},
		],
	},
	advanced: {
		fields: () => {
			const dirs = resolvePancodeDirs();
			const info = getVersionInfo();
			return [
				["PanCode", readPancodeVersionLabel()],
				["Node.js", info.node],
				["Platform", info.platform],
				["Config dir", shortenPath(dirs.config)],
				["Data dir", shortenPath(dirs.data)],
				["State dir", shortenPath(dirs.state)],
				["Cache dir", shortenPath(dirs.cache)],
				["Settings file", shortenPath(settingsPath())],
				["Reference", shortenPath(join(resolvePackageRoot(), "docs", "guide", "configuration-reference.md"))],
			];
		},
		actions: [
			{
				label: "Run doctor",
				hint: "read-only health check",
				run: async (io) => {
					const { runDoctorCommand } = await import("./doctor.js");
					await runDoctorCommand([]);
					await io.rl.text("Press Enter to return");
				},
			},
			{
				label: "Show raw settings.yaml",
				run: async (io) => {
					const file = settingsPath();
					if (!existsSync(file)) {
						io.out.write("  settings.yaml does not exist yet.\n");
						return;
					}
					io.out.write(`\n--- ${shortenPath(file)} ---\n${readFileSync(file, "utf8")}--- end ---\n`);
					await io.rl.text("Press Enter to return");
				},
			},
			{
				label: "Edit all settings",
				hint: "VISUAL / EDITOR; validate before saving",
				run: async (io) => {
					if (await editSettings(io.rl)) io.ok("Settings saved; previous file kept at settings.yaml.bak");
				},
			},
		],
	},
} satisfies Record<string, Pick<SectionSpec, "fields" | "actions">>;

const PART_AREA: Record<keyof typeof CONTENT_PARTS, SharedSettingsAreaId> = {
	connections: "models",
	chatModel: "models",
	workers: "workers",
	context: "context",
	safety: "safety",
	display: "chat",
	workspace: "workspace",
	advanced: "advanced",
};

/** One area's screen: its parts' summary rows, and every hand-written action whose setting lives there. */
function areaContent(area: SharedSettingsAreaId): Pick<SectionSpec, "fields" | "actions"> {
	const parts = Object.entries(CONTENT_PARTS) as Array<
		[keyof typeof CONTENT_PARTS, Pick<SectionSpec, "fields" | "actions">]
	>;
	return {
		fields: () => parts.filter(([name]) => PART_AREA[name] === area).flatMap(([, part]) => part.fields()),
		actions: parts.flatMap(([name, part]) =>
			part.actions.filter(
				(action) => (action.controlPath ? settingsPlacementForPath(action.controlPath).area : PART_AREA[name]) === area,
			),
		),
	};
}

const GUIDED_CONTROL_PATHS = new Set([
	"chat.target",
	"chat.model",
	"fleet.default.target",
	"fleet.default.model",
	"context.memory.target",
	"context.memory.model",
	"safety.autonomy",
	"fleet.permissions.mode",
	"safety.limits.sessionCostUsd",
	"safety.limits.chatToolCallsPerTurn",
	"safety.review.enabled",
	"interface.smoothStreaming",
	"interface.terminalProgress",
	"interface.panes.layout",
	"interface.mode",
	"interface.outputDetail",
	"interface.desktopNotifications",
	"integrations.projectResources.trustProjectImports",
	"integrations.hub.sync",
	"integrations.git.commitAttribution",
]);

function settingControlAction(group: string, control: SettingControl): SectionAction {
	return {
		label: `${group} · ${control.label}`,
		hint: () => `${formatControlValue(getAtPath(readSettings(), control.path), control.path)} · ${control.description}`,
		run: async (io) => {
			if (await editSettingControl(io.rl, control)) io.ok(`${control.label} saved`);
		},
	};
}

export const SECTIONS: ReadonlyArray<SectionSpec> = SHARED_SETTINGS_AREAS.map((area) => {
	const content = areaContent(area.id);
	const catalog = orderedAreaControls(area.id);
	return {
		id: area.id,
		title: area.label,
		summary: area.description,
		fields: content.fields,
		actions: orderSettingsEntries(
			area.id,
			[
				...content.actions.map((action) => {
					const path = action.controlPath;
					if (!path) return action;
					const control = catalog.find(({ control }) => control.path === path)?.control;
					return {
						...action,
						label: `${settingsPlacementForPath(path).group} · ${path.endsWith(".target") ? action.label : (control?.label ?? action.label)}`,
						hint: () => `${formatControlValue(getAtPath(readSettings(), path), path)} · ${control?.description ?? ""}`,
					};
				}),
				...catalog
					.filter(({ control }) => !GUIDED_CONTROL_PATHS.has(control.path))
					.map(({ group, control }) => ({ ...settingControlAction(group, control), controlPath: control.path })),
			],
			(action) => action.controlPath ?? action.place ?? "",
		),
	};
});

/** The streams this run reads from and writes to, which the tests replace. */
export interface ConfigureStreams {
	in: NodeJS.ReadableStream;
	out: NodeJS.WritableStream;
}
