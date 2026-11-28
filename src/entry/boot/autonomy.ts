// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { join } from "node:path";
import { setToolEnvAutonomy } from "../../core/bash-exec.js";
import { type PancodeSettings, readSettings } from "../../core/config.js";
import { installInternalGitPolicy } from "../../core/internal-git.js";
import { createGitHooksFingerprinter } from "../../core/sandbox/git-hooks-fingerprint.js";
import { sessionTelemetryContext } from "../../core/telemetry/context.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { ToolNames } from "../../core/tool-names.js";
import { surfaceSpecPlacement } from "../../core/tool-surface.js";
import { turnAllowsTool } from "../../core/turn-constraints.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { autonomyCeilingRefusal, launchAutonomyRefusal, yoloRootRefusal } from "../../core/yolo-host.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import {
	type CapabilityGate,
	type CapabilityMatch,
	capabilityCorpus,
} from "../../domains/middleware/capability-gate.js";
import type { MiddlewareRegistrar } from "../../domains/middleware/contract.js";
import {
	createMarketplaceOfferRegistration,
	createMiddlewareToolChoiceControl,
	createSkillsReminderRegistration,
} from "../../domains/middleware/index.js";
import type { PromptsContract } from "../../domains/prompts/contract.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { OneShotPort } from "../../domains/providers/one-shot.js";
import type { ResourcesContract } from "../../domains/resources/contract.js";
import {
	discoverMarketplaceSkills,
	installedSkillNames,
	installSkill,
	suggestableSkills,
} from "../../domains/resources/index.js";
import {
	type AutonomyHalt,
	autonomousCaps,
	autonomyHaltNotice,
	autonomyHaltReason,
	createAutonomyWindow,
	settledCallTokens,
} from "../../domains/safety/autonomy-window.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import {
	createGitHookDriftGuard,
	type GitHookDriftGuard,
	gitHookDriftNotice,
} from "../../domains/safety/hook-drift.js";
import { createInternalGitPolicy } from "../../domains/safety/internal-git-policy.js";
import { SAFETY_JUDGE_CONSECUTIVE_BLOCKS, type SafetyJudgeSeat } from "../../domains/safety/safety-judge.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { SystemOne } from "../../domains/system-one/types.js";
import {
	type AutonomyLevel,
	admissionAutonomy,
	containedYolo,
	effectiveYoloConfinement,
	modelMayActivateSkills,
} from "../../lib/autonomy/autonomy.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import { effectiveToolNames } from "../../tools/agent-tools.js";
import type { ToolRegistry } from "../../tools/registry/contract.js";
import type { BootOptions } from "../boot-options.js";
import type { createFlowLedger } from "../flow-ledger.js";
import { createJudgeScreen, createSafetyJudgeCompletion, createSafetyJudgeHost } from "../safety-judge-host.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootAutonomyCells {
	readonly chat: ChatLoop;
	readonly effectiveSettingsForDispatch: (() => Readonly<PancodeSettings>) | null;
	readonly getCurrentSettings: () => PancodeSettings;
	readonly safetyJudgeOneShot: OneShotPort;
	readonly systemOne: SystemOne;
	readonly toolRegistry: ToolRegistry;
	workerAskJudgeForDispatch: {
		seat: () => SafetyJudgeSeat;
		autonomy: () => AutonomyLevel;
		operatorAutonomy: () => AutonomyLevel;
		hookDrift: () => GitHookDriftGuard;
	} | null;
}

/** What buildBootAutonomy reads from the names bootOrchestrator built before it. */
export interface BootAutonomyInput {
	admitModelFlow: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	bus: TelemetryHub;
	capabilityGate: CapabilityGate;
	config: ConfigContract | undefined;
	flowLedger: ReturnType<typeof createFlowLedger>;
	interactive: boolean;
	middlewareRegistrar: MiddlewareRegistrar;
	options: BootOptions;
	prompts: PromptsContract | undefined;
	providers: ProvidersContract;
	resources: ResourcesContract | undefined;
	safety: SafetyContract;
	session: SessionContract | undefined;
	cells: BootAutonomyCells;
}

/**
 * Stages P6 and P7: the effective-autonomy resolvers and the root yolo refusal, skill discovery and its nudges, the
 * autonomous window, the safety judge, the git hook drift guard and internal git policy, and the worker ask judge port.
 */
export function buildBootAutonomy(input: BootAutonomyInput) {
	const {
		admitModelFlow,
		bus,
		capabilityGate,
		config,
		flowLedger,
		interactive,
		middlewareRegistrar,
		options,
		prompts,
		providers,
		resources,
		safety,
		session,
	} = input;
	const { cells } = input;
	// Autonomy is hot-reloaded for interactive and headless admissions. ACP
	// server prompts use the snapshot captured at session/new.
	let activeAcpSessionAutonomy: AutonomyLevel | null = null;
	// Root outside a container never runs yolo (#407). The uid and the
	// container do not change while the process runs, so it is read once.
	const yoloRefusal =
		yoloRootRefusal() ?? launchAutonomyRefusal(options.acp?.autonomyCeiling) ?? autonomyCeilingRefusal();
	// The one effective-autonomy resolution. Every admission surface (registry
	// admission, dispatch plan provenance, ACP session snapshot) resolves
	// through these two functions so a fallback added to one surface cannot
	// silently skip another. The root refusal is enforced here too, so no
	// surface that reaches yolo some other way (a hot-reloaded settings file)
	// runs it.
	const resolveBaselineAutonomy = (): AutonomyLevel => {
		const level =
			cells.effectiveSettingsForDispatch?.().safety.autonomy ??
			(options.headless !== undefined ? (options.headless.autonomy ?? "default") : undefined) ??
			options.autonomy ??
			(config?.get() ?? readSettings()).safety.autonomy ??
			"default";
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	const resolveEffectiveAutonomy = (): AutonomyLevel => {
		const level = activeAcpSessionAutonomy ?? resolveBaselineAutonomy();
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	// Contained yolo (ob-yolo D1) admits, judges and permits workers exactly as
	// default does; only where a call would wait for a person does it differ,
	// which `unattendedAsks` tells the registry. Prompts, auto-continuation and
	// the footer keep the operator's level.
	const resolveSafetySettings = () => (cells.effectiveSettingsForDispatch?.() ?? config?.get() ?? readSettings()).safety;
	const resolveAdmissionAutonomy = (): AutonomyLevel =>
		admissionAutonomy(resolveEffectiveAutonomy(), effectiveYoloConfinement(resolveSafetySettings()));
	const unattendedYolo = (): boolean =>
		containedYolo(resolveEffectiveAutonomy(), effectiveYoloConfinement(resolveSafetySettings()));
	// Every bash command this session runs carries its live level as an autonomy ceiling, and the contained pin while
	// it runs contained yolo, so a pancode it starts cannot take more autonomy or less confinement than it has.
	setToolEnvAutonomy(resolveEffectiveAutonomy, unattendedYolo);
	const skillDiscoveryEnabled = options.noSkills !== true && options.headless?.noSkills !== true;
	let readySkillSnapshot: { key: string; count: number; skills: ReturnType<typeof suggestableSkills> } | undefined;
	const getReadySkillCount = (): number => {
		if (!resources) return 0;
		const cwd = process.cwd();
		// Skill loading reads and hashes the filesystem. Reuse the count across
		// warm/real requests and reminders until the same source epoch that
		// invalidates prompt composition changes (/reload hub, config, etc.).
		// Descriptions from here reach models through the [Skills] reminder and the
		// relevance ranker, so this reads verified trees, never the display listing.
		if (!prompts) {
			const skills = suggestableSkills(resources.skills(cwd).items);
			readySkillSnapshot = { key: cwd, count: skills.length, skills };
			return skills.length;
		}
		const key = JSON.stringify([
			cwd,
			prompts.inputEpoch(),
			skillDiscoveryEnabled,
			config?.get().integrations.hub.trustProjectImports === true,
			options.skillPaths ?? options.headless?.skillPaths ?? [],
		]);
		if (readySkillSnapshot?.key === key) return readySkillSnapshot.count;
		const skills = suggestableSkills(resources.skills(cwd).items);
		const count = skills.length;
		readySkillSnapshot = { key, count, skills };
		return count;
	};
	// FW-1: task-ranked advice is cheap enough for attended and headless turns;
	// it names loadable workflows directly and preserves the activation policy.
	if (resources && skillDiscoveryEnabled) {
		const rankReminderCapabilities = (task: string): ReadonlyArray<CapabilityMatch> => {
			const constraints = cells.chat.currentTurnConstraints?.();
			if (!turnAllowsTool(constraints, "gateway")) return [];
			const surface = new Set(
				effectiveToolNames({ registry: cells.toolRegistry, ...(constraints ? { turnConstraints: constraints } : {}) }),
			);
			return capabilityGate.rank({
				kind: "capabilities",
				task,
				limit: 3,
				...capabilityCorpus(
					cells.toolRegistry.listAll().filter((spec) => surface.has(spec.name)),
					(spec) => surfaceSpecPlacement(spec, surface) === "gateway",
				),
			});
		};
		const rankReminderSkills = (task: string): ReadonlyArray<CapabilityMatch> => {
			getReadySkillCount();
			return capabilityGate.rank({
				kind: "skills",
				task,
				workspace: process.cwd(),
				candidates: (readySkillSnapshot?.skills ?? []).map((skill) => ({
					id: skill.name,
					description: skill.description,
					triggers: Array.isArray(skill.metadata.triggers)
						? skill.metadata.triggers.filter((value): value is string => typeof value === "string")
						: [],
				})),
			});
		};
		middlewareRegistrar.registerHook(
			createSkillsReminderRegistration({
				getTurnConstraints: () => cells.chat.currentTurnConstraints?.(),
				contextPlacement: () => {
					const spec = cells.toolRegistry.get(ToolNames.Context);
					return spec ? surfaceSpecPlacement(spec, null) : "direct";
				},
				countModelVisibleSkills: getReadySkillCount,
				loadedSkillNames: () => (session?.current()?.skillActivations ?? []).map((activation) => activation.name),
				rankCapabilities: rankReminderCapabilities,
				rankSkills: rankReminderSkills,
				// The snapshot is verified per epoch and a revocation takes effect on the
				// next read, so what is about to print is checked again. Only the shown
				// skills' trees are walked. An unverifiable match is simply not offered.
				verifyRankedSkills: (matches) => {
					try {
						const skills = readySkillSnapshot?.skills ?? [];
						const shown = skills.filter((skill) => matches.some((match) => match.id === skill.name));
						const verified = new Set(resources.skillsStillVerified(shown, process.cwd()).map((skill) => skill.name));
						return matches.filter((match) => verified.has(match.id));
					} catch {
						return [];
					}
				},
				// Same lookup context(scope="skills") lists under its Marketplace
				// heading, minus what is already installed, so the count the
				// reminder quotes is the count the listing will show.
				countInstallableSkills: () => {
					if (!skillDiscoveryEnabled) return 0;
					const installed = installedSkillNames(resources.skillsForDisplay(process.cwd()).items, process.cwd());
					return discoverMarketplaceSkills({ cwd: process.cwd() }).skills.filter((skill) => !installed.has(skill.name))
						.length;
				},
				modelMayActivateSkills: () => modelMayActivateSkills(),
			}),
		);
	}
	// Marketplace self-promotion: coordinator-only by this wiring (never a dispatch worker), local matcher, no offer
	// under yolo, operator-consented installs only, each offer and outcome journaled as `skill.offer`. The
	// registration also checks the own-marketplace source gate before installing.
	if (resources && skillDiscoveryEnabled) {
		middlewareRegistrar.registerHook(
			createMarketplaceOfferRegistration({
				interactive,
				askAllowed: () => resolveEffectiveAutonomy() !== "yolo",
				record: (payload) => bus.emit("skill.offer", payload, sessionTelemetryContext(session?.current()?.id)),
				listInstalledSkills: () => resources.skillsForDisplay(process.cwd()).items,
				getTurnConstraints: () => cells.chat.currentTurnConstraints?.(),
				listInstalledSkillNames: () => [
					...installedSkillNames(resources.skillsForDisplay(process.cwd()).items, process.cwd()),
				],
				listMarketplaceEntries: () => discoverMarketplaceSkills({ cwd: process.cwd() }).skills,
				installEntry: (entry, scope) => {
					const installed = installSkill({ source: `skill:${entry.name}`, scope, name: entry.name, cwd: process.cwd() });
					return {
						path: installed.path,
						sourceUrl: installed.sourceUrl,
						installedHash: installed.installedHash,
						warnings: installed.warnings,
					};
				},
			}),
		);
	}
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The autonomous window (ob-yolo D6): at yolo, how far PanCode runs on its own
	// before it pauses for the operator. A halt cancels the turn and latches
	// until the operator speaks; `chat` is built further down, and nothing
	// halts before the first turn runs.
	let lastAutonomyHalt: AutonomyHalt | null = null;
	const autonomyWindow = createAutonomyWindow({
		caps: () => autonomousCaps(resolveEffectiveAutonomy(), cells.getCurrentSettings().safety.limits),
		session: () => session?.current()?.id ?? null,
		confinement: () => effectiveYoloConfinement(cells.getCurrentSettings().safety),
		emit: (name, payload, sessionId) => bus.emit(name, payload, sessionTelemetryContext(sessionId)),
		onHalt: (halt) => {
			lastAutonomyHalt = halt;
			const prefix = autonomyHaltReason(halt);
			// Synchronous, inside the call that crossed the line: the cancel can only reach the turn that halted.
			cells.chat.cancel({
				reason: `[PanCode] ${autonomyHaltNotice(
					halt,
					options.headless !== undefined ? "headless" : "interactive",
					autonomyWindow.openDecisions(true),
				)}`,
				source: "autonomy",
				auditReason: `${prefix}: ${halt.detail}`,
				// A cap lets a started tool call finish and stops before the next request (F-C16); a judge halt is immediate.
				...(halt.kind === "judge" ? {} : { atToolBoundary: true }),
			});
		},
	});
	// After the drain hooks settled the chat, before persist closes the journal: the end carries the final usage.
	bus.subscribe("shutdown.drained", () => autonomyWindow.end());
	bus.subscribe("tool.settled", (payload, context) => {
		if (context?.agent.role === "main" && payload.inner !== true) autonomyWindow.toolCall();
	});
	bus.subscribe("call.settled", (payload, context) => {
		if (context?.agent.role === "main") autonomyWindow.tokens(settledCallTokens(payload.usage));
	});
	// The safety judge reviews what autonomy default would park for the operator
	// against the operator's own messages. Its round goes through System One's
	// one-shot port and request admission, built further down; nothing calls the
	// judge before the first tool call.
	const safetyJudge = createSafetyJudgeHost({
		settings: () => cells.getCurrentSettings(),
		complete: createSafetyJudgeCompletion({
			providers,
			oneShot: () => cells.safetyJudgeOneShot,
			flowRefusal: (destination) => admitModelFlow(destination),
		}),
		session: () => session,
		safety,
		// Past either threshold every later review would refuse in silence, so contained yolo ends the run (D4).
		// A main-session escalation fires inside the review of the block that crossed the line; the window halts once the
		// registry records that block, still inside the call. A worker's block has no such record and halts at once.
		onEscalation: (note) => {
			if (!unattendedYolo()) return;
			autonomyWindow.haltFor(
				"judge",
				note.consecutiveBlocks >= SAFETY_JUDGE_CONSECUTIVE_BLOCKS
					? `blocks under ${note.consecutiveBlocks} different rules in a row`
					: `${note.totalBlocks} blocks this session`,
				note.workerRunId === undefined,
			);
		},
		// `systemOne` and `chat` are built further down; nothing calls the judge before the first tool call.
		screen: createJudgeScreen({
			systemOne: () => cells.systemOne,
			providers,
			liveWindow: () => cells.chat.screenWindow(),
			flow: flowLedger,
		}),
	});
	// The git hook drift guard takes its baseline now, at session start: a hook
	// file added or changed later, however it got there, makes the next git
	// command that would run it outside the sandbox an operator-only ask.
	const hookFingerprinter = createGitHooksFingerprinter(process.cwd());
	const hookDrift = createGitHookDriftGuard({
		workspace: process.cwd(),
		fingerprint: () => hookFingerprinter.fingerprint(),
		// The cheap path PanCode's own status and diff probes check before each run.
		config: (dir) => hookFingerprinter.config(dir),
		onDrift: (changes) =>
			bus.emit("safety.git_hooks_changed", {
				message: gitHookDriftNotice(changes, process.cwd()),
				changes: changes.map(({ path, kind, key, size, firstLine }) => ({
					path,
					kind,
					...(key !== undefined ? { key } : {}),
					size,
					firstLine,
				})),
			}),
	});
	// Git PanCode runs itself (task worktrees, landing worker results) runs
	// outside any sandbox, so after drift it runs with hooks off at default
	// (src/domains/safety/internal-git-policy.ts, src/core/internal-git.ts).
	installInternalGitPolicy(
		createInternalGitPolicy({
			workspace: process.cwd(),
			guard: hookDrift,
			autonomy: resolveAdmissionAutonomy,
			emptyHooksDir: join(pancodeStateDir(), "git", "no-hooks"),
			onDrift: (record) =>
				bus.emit("safety.internal_git_drifted", {
					message: record.message,
					announce: record.announce,
					operation: record.operation,
					hardened: record.hardened,
					outcome: record.outcome,
					changes: record.changes.map(({ path, kind, key }) => ({
						path,
						kind,
						...(key !== undefined ? { key } : {}),
					})),
				}),
		}),
	);
	// The same seat answers dispatched workers' asks, so worker and main-session
	// blocks share one session's escalation counts.
	cells.workerAskJudgeForDispatch = {
		seat: () => safetyJudge,
		autonomy: resolveAdmissionAutonomy,
		operatorAutonomy: resolveEffectiveAutonomy,
		hookDrift: () => hookDrift,
	};
	// The operator spoke, typed or on an ask_user round: a fresh autonomy window.
	const operatorReturned = (): void => {
		const cleared = autonomyWindow.reopen();
		if (cleared === null) return;
		lastAutonomyHalt = null;
		// Resuming after a block streak is the operator's approval to review again.
		if (cleared.kind === "judge") safetyJudge.operatorApproved();
	};
	return {
		autonomyWindow,
		getReadySkillCount,
		hookDrift,
		middlewareToolChoice,
		operatorReturned,
		resolveAdmissionAutonomy,
		resolveBaselineAutonomy,
		resolveEffectiveAutonomy,
		safetyJudge,
		unattendedYolo,
		yoloRefusal,
		autonomyState: {
			get activeAcpSessionAutonomy() {
				return activeAcpSessionAutonomy;
			},
			set activeAcpSessionAutonomy(value: typeof activeAcpSessionAutonomy) {
				activeAcpSessionAutonomy = value;
			},
			get lastAutonomyHalt() {
				return lastAutonomyHalt;
			},
		},
	};
}
