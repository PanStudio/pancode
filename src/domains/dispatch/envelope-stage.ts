// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The envelope and permit stage of a dispatch: the settings snapshot it resolves against, the write mode, the
 * worker's permit and judge state, placement sandbox facts, and the sealed envelope with its static head.
 */

import { resolve as resolvePath } from "node:path";
import { bashShellPath } from "../../core/bash-shell.js";
import { sandboxAvailability, sandboxNetworkIsolation } from "../../core/sandbox/availability.js";
import type { SandboxAvailability } from "../../core/sandbox/types.js";
import { isHarnessExtensionToolName, isMcpToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import { turnDelegatesTool } from "../../core/turn-constraints.js";
import { isClaudeSdkTool } from "../../engine/claude/tool-safety.js";
import { attestedToolSchemaSignature } from "../../engine/worker-tools.js";
import { type AutonomyLevel, admissionAutonomy, effectiveYoloConfinement } from "../../lib/autonomy/autonomy.js";
import { networkToolsDisabled } from "../../tools/network-policy.js";
import { applyToolProfile } from "../../tools/profiles.js";
import { runtimeAttachesGateway } from "../../tools/surface.js";
import { gitCheckoutRoot } from "../../tools/task-worktree.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { INTERNAL_HELPER_RESULT_KINDS } from "../agents/result-contract.js";
import { isHoareResultContract } from "../agents/result-contract-types.js";
import { roleExcludes, toolActionClass } from "../agents/role-class.js";
import type { normalizeAgentSpec } from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import { enabledHarnessExtensionToolNames } from "../extensions/command-tools.js";
import { type RuntimeDescriptor, runtimeEnforcement } from "../providers/index.js";
import {
	mainGrantsUnavailable,
	resolveWorkerPermit,
	type WorkerMcpAttestation,
	type WorkerPermit,
} from "../safety/worker-permit.js";
import type { DispatchAdmissionStage } from "./admission-scope.js";
import type { DispatchRequest } from "./contract.js";
import {
	type EnvelopeInput,
	envelopeApproval,
	envelopeToolNames,
	resolveWorkerEnvelope,
	resolveWriteMode,
	type WithheldCapability,
	type WorkerEnvelope,
} from "./envelope.js";
import { dispatchResultContract } from "./execution-role.js";
import { fleetNodeSandboxAvailability } from "./fleet-preflight.js";
import { effectiveWorkerPermissionMode, judgeWithheldCause } from "./grant-authority.js";
import { requestedWriteNone, resolveRunRole } from "./obligation.js";
import type { DispatchPathScope } from "./path-scope.js";
import type { FleetPlacementPreview } from "./placement.js";
import { type ResolvedTarget, targetToolCapability } from "./target-resolution.js";
import { canonicalContextAttached } from "./worker-dynamic-prompt.js";

/** The level a worker's permit and ask routing take from the operator's settings: contained yolo is default. */
export function operatorAdmissionAutonomy(
	settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined | null,
): AutonomyLevel {
	return admissionAutonomy(settings?.safety.autonomy ?? "default", effectiveYoloConfinement(settings?.safety));
}

/** The settings snapshot a dispatch resolves against; absent in minimal bundles. */
export type EffectiveSettings = Readonly<ReturnType<ConfigContract["get"]>> | undefined;

/** Only the roots merge back from a rooted run's own worktree (ruling 3). */
export function lifecycleMergeRoots(envelope: WorkerEnvelope): { mergeRoots?: ReadonlyArray<string> } {
	return envelope.write.mode === "worktree" && envelope.write.roots.length > 0
		? { mergeRoots: envelope.write.roots }
		: {};
}

/** The run's envelope with the permit it wraps; preview and run both resolve it here and nowhere else (M7). */
interface DispatchEnvelopeStage {
	envelope: WorkerEnvelope;
	/** `envelopeToolNames(envelope)`: what the worker registers, attests and is told. */
	tools: ReadonlyArray<ToolName>;
	permit: WorkerPermit;
	/** `envelope.write.mode === "none"`. */
	readOnly: boolean;
	/** Why judge-routed asks are denied here, for the one-time scope notice; null when they are not. */
	judgeWithheld: string | null;
	/** The OS sandbox where the worker runs, which the prompt line and the receipt report (`placementSandboxAvailability`). */
	placedSandbox: SandboxAvailability;
}

/**
 * The facts a run's write mode is resolved from. The dispatch wrapper reads them to place an unconfined rooted
 * builder in its own worktree before any lease, and the envelope reads the same ones, so the two never disagree (M7).
 */
export function writeModeInput(input: {
	req: DispatchRequest;
	recipe: AgentRecipe;
	spec: Pick<ReturnType<typeof normalizeAgentSpec>, "capabilityClass">;
	pathScope: DispatchPathScope;
	target: ResolvedTarget;
	settings: EffectiveSettings;
	placement: FleetPlacementPreview;
}): Parameters<typeof resolveWriteMode>[0] {
	const { req } = input;
	const hoare = isHoareResultContract(dispatchResultContract(req, input.recipe));
	const writeNone = requestedWriteNone({
		readOnly: req.readOnly,
		capabilityClass: input.spec.capabilityClass,
		hoareContract: hoare,
	});
	const role = resolveRunRole({
		gateRole: req.gate?.role,
		capabilityClass: input.spec.capabilityClass,
		readOnly: writeNone,
	});
	const network = sandboxAllowsNetwork({
		req,
		role,
		capabilityClass: input.spec.capabilityClass,
		allowedTools: applyToolProfile(input.recipe.tools as ReadonlyArray<ToolName>, req.toolProfile),
		target: input.target,
		settings: input.settings,
		hoare,
	});
	return {
		writeNone,
		roots: writeNone ? [] : input.pathScope.writeBoundaries,
		worktree: req.taskWorktree !== undefined || req.worktree === true,
		confinesWrites: placementSandboxFacts(input.target.runtime.kind, input.settings, input.placement, hoare, network)
			.confinesWrites,
		gitCheckout: gitCheckoutRoot(resolvePath(req.cwd ?? process.cwd())) !== null,
		scopeEnforcement: runtimeEnforcement(input.target.runtime).scopeEnforcement,
	};
}

export function resolveDispatchEnvelopeStage(input: {
	req: DispatchRequest;
	recipe: AgentRecipe;
	spec: ReturnType<typeof normalizeAgentSpec>;
	admission: DispatchAdmissionStage;
	target: ResolvedTarget;
	settings: EffectiveSettings;
	/** `settings` with the main session's live autonomy, which the permit is resolved under. */
	liveSettings: EffectiveSettings;
	pathScope: DispatchPathScope;
	judgeSeated: boolean;
	placement: FleetPlacementPreview;
}): DispatchEnvelopeStage {
	const { req, recipe, spec, admission, target, pathScope } = input;
	const settings = input.liveSettings;
	const hoare = isHoareResultContract(dispatchResultContract(req, recipe));
	const writeNone = requestedWriteNone({
		readOnly: req.readOnly,
		capabilityClass: spec.capabilityClass,
		hoareContract: hoare,
	});
	// The one role rule over the facts the request was admitted with; `requestRunRole` resolves the same rule at
	// request time, so the journaled role and the route tuple are this role (DESIGN 4.2).
	const role = resolveRunRole({
		gateRole: req.gate?.role,
		capabilityClass: spec.capabilityClass,
		readOnly: writeNone,
	});
	const network = sandboxAllowsNetwork({
		req,
		role,
		capabilityClass: spec.capabilityClass,
		allowedTools: admission.allowedTools,
		target,
		settings: input.settings,
		hoare,
	});
	const {
		confinesWrites,
		availability: placedAvailability,
		...sandbox
	} = placementSandboxFacts(target.runtime.kind, input.settings, input.placement, hoare, network);
	const facts: Parameters<typeof resolveWriteMode>[0] = {
		writeNone,
		roots: writeNone ? [] : pathScope.writeBoundaries,
		worktree: req.taskWorktree !== undefined || req.worktree === true,
		confinesWrites,
		gitCheckout: gitCheckoutRoot(resolvePath(req.cwd ?? process.cwd())) !== null,
		scopeEnforcement: runtimeEnforcement(target.runtime).scopeEnforcement,
	};
	const mode = resolveWriteMode(facts);
	const cwd = req.cwd ?? process.cwd();
	const ownLoop = runtimeAttachesGateway(target.runtime);
	const envelopeInput: Omit<EnvelopeInput, "permitDigest" | "approval"> = {
		role,
		capabilityClass: spec.capabilityClass,
		recipeTools: (recipe.tools ?? []) as ReadonlyArray<ToolName>,
		profiledTools: admission.allowedTools,
		...(admission.toolProfile !== undefined ? { toolProfile: admission.toolProfile } : {}),
		denied: deniedToolNames(req),
		delegates: (tool) => turnDelegatesTool(req.turnConstraints, tool),
		ledger: req.ledger !== undefined,
		write: { mode, roots: facts.roots },
		runtime: {
			toolsSupported: targetToolCapability(target),
			ownLoop,
			offers: (tool) => target.runtime.id !== "claude-sdk" || isClaudeSdkTool(tool),
		},
		host: {
			// A hermetic process registers no network plane, and a host with no bash registers no shell (#421), so the
			// worker's registry drops them whatever the recipe declared.
			networkStripped: networkToolsDisabled(),
			shellStripped: bashShellPath() === null,
			confinesWrites,
			harnessTools:
				ownLoop && admission.allowedTools.some(isHarnessExtensionToolName)
					? enabledHarnessExtensionToolNames(cwd)
					: new Set<string>(),
		},
		...(admission.mcp !== undefined ? { mcp: admission.mcp } : {}),
		skills: {
			names: recipe.skills ?? [],
			paths: [...(req.skillPaths ?? []), ...(recipe.boundSkillPaths ?? [])],
			disabled: req.noSkills === true,
			contextAttached: (tools) => canonicalContextAttached(target.runtime, tools),
		},
		read: { roots: pathScope.workingContextPaths, outside: req.extraReadRoots ?? [] },
		sandbox,
	};
	// The draft settles the tool list the permit is resolved over; its approval block is replaced below.
	const draft = resolveWorkerEnvelope({
		...envelopeInput,
		approval: { autonomy: "default", asks: "deny" },
		permitDigest: "",
	});
	const tools = envelopeToolNames(draft);
	const readOnly = mode === "none";
	const { permit, narrowedToDeny } = resolveDispatchPermit(
		req,
		recipe,
		spec,
		tools,
		readOnly,
		facts.roots,
		settings,
		target,
		input.judgeSeated,
		admission.mcp,
	);
	const judgeWithheld = judgeWithheldCause(workerJudgeState(settings, target, input.judgeSeated));
	const approvalWithheld: WithheldCapability[] = [
		...(judgeWithheld !== null
			? [
					{
						capability: "asks:judge",
						reason: "judge-unseated" as const,
						remedy: `${judgeWithheld}; the safety judge answers worker asks in an interactive session at autonomy default with safety.judge.enabled on`,
					},
				]
			: []),
		...(narrowedToDeny
			? [
					{
						capability: "asks:main",
						reason: "main-route-unavailable" as const,
						remedy: "a run started outside the dispatch tool has no main agent waiting on its asks",
					},
				]
			: []),
	];
	const envelope = resolveWorkerEnvelope({
		...envelopeInput,
		approvalWithheld,
		approval: envelopeApproval(permit.allowance, judgeRoutedPermit(permit, settings)),
		permitDigest: permit.digest,
	});
	return {
		envelope,
		tools,
		permit,
		readOnly,
		judgeWithheld,
		placedSandbox: placedAvailability,
	};
}

/** The attempt's immutable permit from recipe, settings, task narrowing and any inherited cap. */
function resolveDispatchPermit(
	req: DispatchRequest,
	recipe: AgentRecipe,
	spec: ReturnType<typeof normalizeAgentSpec>,
	tools: ReadonlyArray<ToolName>,
	readOnly: boolean,
	writeRoots: ReadonlyArray<string>,
	settings: EffectiveSettings,
	target: ResolvedTarget,
	judgeSeated: boolean,
	mcp?: WorkerMcpAttestation,
): { permit: WorkerPermit; narrowedToDeny: boolean } {
	const permit = resolveDispatchPermitOnce(
		req,
		recipe,
		spec,
		tools,
		readOnly,
		writeRoots,
		settings,
		target,
		judgeSeated,
		mcp,
	);
	// A run started outside the dispatch tool (a slash command, a watchdog, a
	// host helper) has no main agent waiting on it. Its main-routed asks narrow
	// to deny, and the permit on the receipt says so. The safety judge needs no
	// main agent to wait, so a judge-routed permit keeps its route.
	if (
		mainGrantsUnavailable(permit.allowance) &&
		req.mainGrantRoute === undefined &&
		!judgeRoutedPermit(permit, settings)
	) {
		return {
			permit: resolveDispatchPermitOnce(
				{ ...req, permitNarrowing: { ...(req.permitNarrowing ?? {}), asks: "deny" } },
				recipe,
				spec,
				tools,
				readOnly,
				writeRoots,
				settings,
				target,
				judgeSeated,
				mcp,
			),
			narrowedToDeny: true,
		};
	}
	return { permit, narrowedToDeny: false };
}

/** What decides whether the safety judge can answer this dispatch's worker asks. */
function workerJudgeState(
	settings: EffectiveSettings,
	target: ResolvedTarget,
	judgeSeated: boolean,
): Parameters<typeof effectiveWorkerPermissionMode>[0] {
	return {
		mode: settings?.fleet.permissions.mode ?? "deny",
		autonomy: operatorAdmissionAutonomy(settings),
		judgeEnabled: settings?.safety.judge.enabled === true,
		judgeSeated,
		boundGrants: target.runtime.kind === "http" && runtimeEnforcement(target.runtime).grantPauseResume,
	};
}

/** True when the main session's safety judge, not the main agent, decides this permit's main-authority asks. */
export function judgeRoutedPermit(permit: WorkerPermit, settings: EffectiveSettings): boolean {
	return mainGrantsUnavailable(permit.allowance) && settings?.fleet.permissions.mode === "judge";
}

function resolveDispatchPermitOnce(
	req: DispatchRequest,
	recipe: AgentRecipe,
	spec: ReturnType<typeof normalizeAgentSpec>,
	tools: ReadonlyArray<ToolName>,
	readOnly: boolean,
	writeRoots: ReadonlyArray<string>,
	settings: EffectiveSettings,
	target: ResolvedTarget,
	judgeSeated: boolean,
	mcp?: WorkerMcpAttestation,
): WorkerPermit {
	const contract = dispatchResultContract(req, recipe);
	const hostHelper =
		(spec.audience === "shadow" || spec.audience === "internal") &&
		contract !== undefined &&
		contract !== null &&
		contract.kind !== "mutation-report" &&
		(INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(contract.kind);
	return resolveWorkerPermit({
		agentId: spec.id,
		capabilityClass: spec.capabilityClass,
		tools,
		...(req.turnConstraints !== undefined ? { turnConstraints: req.turnConstraints } : {}),
		readOnly,
		writeRoots,
		...(spec.permissions !== undefined ? { declared: spec.permissions } : {}),
		...(req.permitNarrowing !== undefined ? { narrowing: req.permitNarrowing } : {}),
		...(req.inheritedPermitAllowance !== undefined ? { inherited: req.inheritedPermitAllowance } : {}),
		// Contained yolo hands workers default's permit and routes (ob-yolo D1).
		operatorAutonomy: operatorAdmissionAutonomy(settings),
		mode: effectiveWorkerPermissionMode(workerJudgeState(settings, target, judgeSeated)),
		hostHelper,
		runtime: {
			id: target.runtime.id,
			targetId: target.target.id,
			enforcement: runtimeEnforcement(target.runtime),
			// Read from the effective settings, the operator's configuration, never
			// from anything the request or the model carries.
			trustedUnmediated: settings?.targets.find((entry) => entry.id === target.target.id)?.trustedUnmediated === true,
			...(target.runtime.readOnlySandbox === "os" ? { readOnlySandbox: true } : {}),
		},
		...(mcp !== undefined ? { mcp } : {}),
	});
}

/**
 * The request's denied tool names, case-normalized the way a declared skill
 * surface is. An MCP name keeps its case: the server's tool name is part of
 * it and may carry capitals, so lowercasing it would match nothing. A name
 * that matches no PanCode tool subtracts nothing, which is correct: this list
 * only ever removes, so an unmatched entry is inert rather than an error.
 */
function deniedToolNames(req: DispatchRequest): ReadonlySet<string> {
	if (!req.denyTools || req.denyTools.length === 0) return new Set();
	return new Set(
		req.denyTools.map((tool) => {
			const name = tool.trim();
			return isMcpToolName(name) ? name : name.toLowerCase();
		}),
	);
}

/** Whether a native worker's sandboxed commands keep network on (mirrors `resolveExecAndNetwork`). */
function sandboxAllowsNetwork(input: {
	req: DispatchRequest;
	role: ReturnType<typeof resolveRunRole>;
	capabilityClass: ReturnType<typeof normalizeAgentSpec>["capabilityClass"];
	allowedTools: ReadonlyArray<ToolName>;
	target: ResolvedTarget;
	settings: EffectiveSettings;
	hoare: boolean;
}): boolean {
	if (input.hoare) return false;
	if (input.settings?.safety.sandboxNetwork === true) return true;
	if (networkToolsDisabled() || !targetToolCapability(input.target)) return false;
	const denied = deniedToolNames(input.req);
	for (const tool of input.allowedTools) {
		if (tool !== ToolNames.WebFetch && tool !== ToolNames.WebRead) continue;
		if (denied.has(tool)) continue;
		if (roleExcludes(input.role, input.capabilityClass, tool, toolActionClass(tool)) !== null) continue;
		return true;
	}
	return false;
}

/**
 * The OS sandbox the placed worker starts: this host's probe for a local worker, the node's recorded
 * `pancode version --sandbox` answer for an SSH worker. Network-off runs also require network isolation,
 * matching `worker-process.ts:withNetworkIsolation`. The prompt line, the envelope and the receipt all read it.
 */
function placementSandboxAvailability(placement: FleetPlacementPreview, network: boolean): SandboxAvailability {
	if (placement.node.kind === "local") {
		const availability = sandboxAvailability();
		if (network || !availability.available) return availability;
		const failure = sandboxNetworkIsolation(availability);
		return failure === null ? availability : { available: false, backend: null, executable: null, reason: failure };
	}
	return fleetNodeSandboxAvailability(placement.sandbox ?? null, network);
}

/**
 * A native worker on an SSH node with no OS sandbox would run its commands unconfined, so admission refuses it unless
 * the node's entry opts in with `allowUnsandboxed`, which a required sandbox ignores.
 */
function assertNodeSandboxAdmitted(
	node: FleetPlacementPreview["node"],
	availability: SandboxAvailability,
	mode: "auto" | "required",
	hoare: boolean,
	settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined,
): void {
	if (availability.available) return;
	const optedIn = settings?.fleet.nodes.find((entry) => entry.id === node.id)?.allowUnsandboxed === true;
	if (mode === "auto" && optedIn) return;
	const lacking = `dispatch: admission denied: node '${node.id}' has no OS sandbox for worker commands (${availability.reason ?? "no sandbox backend"})`;
	const fix = `install bubblewrap with user namespaces on the node and run 'pancode fleet nodes test ${node.id} --record'`;
	if (mode === "required")
		throw new Error(
			`${lacking} and ${hoare ? "a verifier report with an assurance level needs one" : "safety.sandbox is required"}; ${fix}, or place the worker on another node.`,
		);
	throw new Error(
		`${lacking}; ${fix}, or set allowUnsandboxed: true on its fleet.nodes entry to run its commands unsandboxed.`,
	);
}

/**
 * The OS sandbox facts of the placement that runs the worker, sealed into the envelope (M6, M7); nothing else
 * decides them. Only the native HTTP runtime executes PanCode's command tools in the worker process. A local worker
 * reads this host's probe and an SSH worker its node's recorded one.
 * Bubblewrap bound to the roots confines every command, so a writer with file roots keeps its check tools.
 */
function placementSandboxFacts(
	runtimeKind: RuntimeDescriptor["kind"],
	settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined,
	placement: FleetPlacementPreview,
	hoare: boolean,
	network: boolean,
): EnvelopeInput["sandbox"] & { confinesWrites: boolean; availability: SandboxAvailability } {
	const mode = hoare ? "required" : (settings?.safety.sandbox ?? "auto");
	const applies = runtimeKind === "http" && mode !== "off";
	const availability = placementSandboxAvailability(placement, network);
	if (applies && placement.node.kind === "ssh")
		assertNodeSandboxAdmitted(placement.node, availability, mode, hoare, settings);
	const backend = applies && availability.available && availability.backend !== null ? availability.backend : "none";
	return {
		backend,
		applies: applies && (backend !== "none" || mode === "required"),
		networkSetting: !hoare && settings?.safety.sandboxNetwork === true,
		networkOff: hoare,
		confinesWrites: backend === "bwrap",
		availability,
	};
}

/** The static head the worker recomputes from its spec; the envelope seals it once the prompt is compiled. */
export function envelopeStaticHeadInput(target: ResolvedTarget, systemPrompt: string, envelope: WorkerEnvelope) {
	const names = envelopeToolNames(envelope);
	return {
		api: target.runtime.id,
		provider: target.target.id,
		model: target.wireModelId,
		thinking: target.thinkingLevel ?? null,
		systemPrompt,
		tools: { names, schemas: attestedToolSchemaSignature(names) },
	};
}
