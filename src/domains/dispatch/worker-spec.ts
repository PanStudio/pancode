// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Builds the WorkerSpec a dispatched worker is launched with: its effective budget, protected-artifact state, OS
 * sandbox, session hooks it runs with or without, and the spec itself.
 */

import { relative, resolve as resolvePath } from "node:path";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { devRootOwnerForWorkers } from "../../core/dev-roots.js";
import { GUARDRAIL_DEFAULTS } from "../../core/guardrails.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { protectedResidencyModels } from "../../core/residency-protection.js";
import { probedSandboxBackend } from "../../core/sandbox/availability.js";
import { egressGrants } from "../../core/sandbox/egress/policy.js";
import { sandboxEnvPolicy } from "../../core/sandbox/env-scrub.js";
import { withWorkerGitHookPaths } from "../../core/sandbox/git-hooks-fingerprint.js";
import { homeReadList } from "../../core/sandbox/home-read-roots.js";
import type { SandboxAvailability, WorkerSandboxSpec } from "../../core/sandbox/types.js";
import { resolveWorkerSandboxSpec, workerSandboxLine } from "../../core/sandbox/worker-policy.js";
import type { SharedStoreGrant } from "../../core/store-shared-grant.js";
import { workerAgent } from "../../core/telemetry/context.js";
import type { ToolName } from "../../core/tool-names.js";
import { toolSurfaceSources, workerTurnConstraints } from "../../core/turn-constraints.js";
import { attestedToolSchemaSignature } from "../../engine/worker-tools.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import { shareTaskWorktreeDependencies } from "../../tools/task-worktree-dependencies.js";
import { parseWorkerContextSeed } from "../../worker/context-seed.js";
import { WORKER_STDIN_FRAME_MAX_BYTES, workerStaticHead } from "../../worker/protocol.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	serializeWorkerRuntimeDescriptor,
	WORKER_PROTECTED_ARTIFACT_STATE_VERSION,
	WORKER_REFUSAL_LIMIT,
	WORKER_SPEC_HOOKLESS_VERSION,
	type WorkerBudget,
	type WorkerGrantBinding,
	type WorkerPromptMessage,
	workerSpecToolNames,
	workerSpecVersionFor,
} from "../../worker/spec-contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { INTERNAL_HELPER_RESULT_KINDS } from "../agents/result-contract.js";
import { isHoareResultContract, type ResultContract } from "../agents/result-contract-types.js";
import type { normalizeAgentSpec } from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import type { MiddlewareContract } from "../middleware/contract.js";
import { type RuntimeDescriptor, runtimeTargetSnapshot } from "../providers/index.js";
import {
	compileWorkerFlowPolicy,
	type FlowRestrictionSet,
	flowHandoffRefusal,
	flowTransferRefusal,
	flowUnmediatedAgentRefusal,
	resolveModelDestination,
	type WorkerFlowPolicyInput,
} from "../safety/information-flow.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import { mainGrantsUnavailable, type WorkerPermit, workerPermissionModeForPermit } from "../safety/worker-permit.js";
import type { DispatchAdmissionStage } from "./admission-scope.js";
import { type RunToolBudgetEnvelope, resolveToolBudgetEnvelope } from "./budget-envelope.js";
import type { DispatchRequest } from "./contract.js";
import type { WorkerEnvelope } from "./envelope.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { dispatchResultContract } from "./execution-role.js";
import type { RunRole } from "./obligation.js";
import type { DispatchPathScope } from "./path-scope.js";
import { resolveRunLimits, resolveRunWall, runWallCapMs } from "./run-limits.js";
import {
	assertProtectedArtifactsEnforceable,
	assertResponseSchemaEnforceable,
	assertRuntimeCanHonorWorkerPermissionMode,
	assertWriteRootsEnforceable,
} from "./runtime-enforceability.js";
import { type ResolvedTarget, targetToolCapability } from "./target-resolution.js";
import { workerApprovalBackstopMs } from "./worker-approval-window.js";
import { computeSettingsFingerprint, type WorkerExtensionHook } from "./worker-protocol.js";
import type { WorkerSpec } from "./worker-spawn.js";

interface DispatchWorkerSpecInput {
	req: DispatchRequest;
	/** The shared names of an SSH run's granted tags, which the receiving worker verifies. */
	sharedStoreGrant?: SharedStoreGrant;
	role: RunRole;
	flowRestrictions?: FlowRestrictionSet | null;
	flowPolicy?: WorkerFlowPolicyInput;
	pathScope: DispatchPathScope;
	target: ResolvedTarget;
	admission: DispatchAdmissionStage;
	recipe?: AgentRecipe | null;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	promptSignature: string | null;
	toolSignature: string;
	dynamicHash: string | null;
	apiKey: string | undefined;
	authProfile?: string;
	credentialExpiresAt?: number;
	middlewareSnapshot: ReturnType<MiddlewareContract["snapshot"]>;
	protectedArtifactState?: ProtectedArtifactState;
	/** The run's envelope, sealed over `permit`; the worker reads its tools, write mode and roots from it (M7). */
	envelope: WorkerEnvelope;
	/** The harness starts without its repository instruction files; their rules ride compiled in the prompt. */
	skipRepositoryInstructions?: boolean;
	budget: WorkerBudget;
	/** The worker runs on this host, not a fleet node: only then does its spec carry the operator's upstream proxy. */
	localPlacement?: boolean;
	/** Effective settings snapshot for this run; falls back to config.get(). */
	settings?: Readonly<ReturnType<ConfigContract["get"]>>;
	/** True when this process routes worker escalations to an operator; see DispatchBundleOptions. */
	workerPermissionResponder: boolean;
	/** The immutable permit this attempt was admitted under. */
	permit: WorkerPermit;
	/** Attempt binding for a main-authority permit's live grants (Phase D). */
	grantAttempt?: WorkerGrantBinding;
	/**
	 * Present only for a judge-routed permit: true when this process's safety
	 * judge answers the attempt's main-authority asks, false when the placement
	 * cannot carry a bound grant and they are denied at once.
	 */
	judgeResponder?: boolean;
	/** The main agent's effective autonomy when the attempt spawns. */
	mainAutonomy?: AutonomyLevel;
	/** The session's extension tool hooks at spawn; only a native worker's own tool loop can hold a call for them. */
	extensionHooks?: ReadonlyArray<WorkerExtensionHook>;
}

export function workerToolCallHardCap(settings: EffectiveSettings): number {
	return settings?.fleet.limits.toolCallsPerRun ?? GUARDRAIL_DEFAULTS.workerToolCallCap;
}

/** Per-tool budget enforcement is real only where PanCode observes each tool call. */
export function budgetEnforcementForRuntime(
	runtime: Pick<RuntimeDescriptor, "kind">,
): "native-per-tool" | "external-one-shot" {
	return runtime.kind === "subprocess" ? "external-one-shot" : "native-per-tool";
}

export function resolveEffectiveWorkerBudget(input: {
	req: DispatchRequest;
	recipeId: string;
	declared: ReturnType<typeof normalizeAgentSpec>["budget"];
	allowedTools: ReadonlyArray<ToolName>;
	settings: EffectiveSettings;
	runtime: RuntimeDescriptor;
	readOnly: boolean;
}): RunToolBudgetEnvelope {
	const hardCap = workerToolCallHardCap(input.settings);
	const declared = input.declared ?? {
		toolCalls: hardCap,
		synthesis: true,
	};
	return resolveToolBudgetEnvelope({
		recipeId: input.recipeId,
		policy: declared,
		...(input.req.budget === undefined ? {} : { request: input.req.budget }),
		hardCap,
		retry: (input.req.lineage?.attempt ?? 0) > 0,
		revision: input.req.gate?.role === "builder" && input.req.gate.cycle > 1 && input.req.gate.verdict === "revise",
		enforcement: budgetEnforcementForRuntime(input.runtime),
	});
}

export function frozenProtectedArtifactState(state: ProtectedArtifactState | undefined): ProtectedArtifactState {
	return {
		artifacts: (state?.artifacts ?? []).map((artifact) => ({
			...structuredClone(artifact),
			path: canonicalizeExistingPath(resolvePath(process.cwd(), artifact.path)),
		})),
	};
}

export function protectedArtifactStateForRequest(
	state: ProtectedArtifactState,
	req: DispatchRequest,
): ProtectedArtifactState {
	const frozen = frozenProtectedArtifactState(state);
	const remap = req.protectedArtifactRemap;
	if (remap === undefined) return frozen;
	const sourceRoot = canonicalizeExistingPath(resolvePath(remap.sourceRoot));
	const workerRoot = canonicalizeExistingPath(resolvePath(remap.workerRoot));
	const artifacts = [...frozen.artifacts];
	for (const artifact of frozen.artifacts) {
		const rel = relative(sourceRoot, artifact.path);
		if (relativePathEscapes(rel)) continue;
		const mappedPath = canonicalizeExistingPath(resolvePath(workerRoot, rel));
		if (artifacts.some((candidate) => candidate.path === mappedPath)) continue;
		artifacts.push({ ...artifact, path: mappedPath, reason: `${artifact.reason} (compete worktree mirror)` });
	}
	return { artifacts };
}

/**
 * OS sandbox policy for a native worker's own commands (decision Q8). Only
 * the native HTTP runtime executes PanCode's bash, run_script and verify tools in
 * the worker process; SDK and subprocess runtimes run their own tools, so a
 * policy there would claim an enforcement that does not happen. The prompt
 * line, the WorkerSpec and the receipt all derive from this one function.
 */
export function workerSandboxFor(input: {
	resultContract?: ResultContract | null;
	runtimeKind: RuntimeDescriptor["kind"];
	req: DispatchRequest;
	pathScope: DispatchPathScope;
	envelope: Pick<WorkerEnvelope, "write" | "network" | "read" | "sandbox">;
	settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined;
}): { applies: boolean; spec: WorkerSandboxSpec | undefined } {
	const hoare = isHoareResultContract(input.resultContract);
	if (hoare && input.runtimeKind !== "http")
		throw new Error(
			"dispatch: a verifier report with an assurance level needs a native runtime that can run its commands read-only with the network off",
		);
	if (input.runtimeKind !== "http") return { applies: false, spec: undefined };
	const mode = hoare ? "required" : (input.settings?.safety.sandbox ?? "auto");
	const dependencyRoots =
		input.req.taskWorktree !== undefined && mode !== "off" && input.envelope.sandbox.backend !== "none"
			? shareTaskWorktreeDependencies(input.req.taskWorktree)
			: [];
	const homeReads = input.settings !== undefined ? homeReadList(input.settings.safety.homeReads, "workers") : undefined;
	const egressSettings = input.settings?.safety.egress.workers;
	const egress = hoare ? "off" : (egressSettings?.mode ?? "off");
	const egressOrigins =
		egressSettings === undefined ? [] : [...egressGrants(egressSettings.allow, egressSettings.presets).origins].sort();
	const policy = resolveWorkerSandboxSpec({
		mode,
		readOnly: hoare || input.envelope.write.mode === "none",
		cwd: input.req.cwd ?? process.cwd(),
		writeBoundaries: input.pathScope.writeBoundaries,
		...(input.req.taskWorktree !== undefined
			? { taskWorktree: { path: input.req.taskWorktree.path, branch: input.req.taskWorktree.branch } }
			: {}),
		// An auto fallback has host egress. If the worker recovers its backend, keep the original network restriction.
		network: input.envelope.network.shell && (input.envelope.sandbox.backend !== "none" || egress !== "off"),
		...(egress === "proxied" ? { egress: { origins: egressOrigins } } : {}),
		// The envelope's approved outside read roots ride with the dependency roots: readable, never writable.
		dependencyRoots: [...dependencyRoots, ...input.envelope.read.outside],
		...(input.settings !== undefined && !hoare
			? { env: sandboxEnvPolicy(input.settings), unixSockets: input.settings.safety.sandboxUnixSockets }
			: {}),
		...(homeReads !== undefined ? { homeReads } : {}),
	});
	const spec = withWorkerGitHookPaths(policy, input.req.taskWorktree?.path ?? input.req.cwd ?? process.cwd());
	// The envelope names a backend only where the placed host, this one or a fleet node, reported one.
	return {
		applies: true,
		spec:
			spec === undefined
				? undefined
				: {
						...spec,
						...(hoare ? { network: false } : {}),
						...(input.envelope.sandbox.backend !== "none" ? { backendExpected: true } : {}),
						...(input.envelope.sandbox.unconfined === true ? { unconfined: true as const } : {}),
					},
	};
}

/** The sandbox sentence for the worker's safety line, from the sandbox where the worker runs. */
export function workerSandboxPromptLine(
	input: Parameters<typeof workerSandboxFor>[0],
	placedSandbox: SandboxAvailability,
): { sandboxLine?: string } {
	const sandbox = workerSandboxFor(input);
	return sandbox.applies ? { sandboxLine: workerSandboxLine(sandbox.spec, placedSandbox) } : {};
}

/**
 * The session's tool hooks a worker on `runtime` would run without. Only a
 * native worker's own tool loop can hold a call for them; a claude-sdk or
 * other non-http worker runs its tools where no hook reaches. A CLI runtime
 * runs its own tools under its own names, so its allowedTools say nothing
 * about what it will run and every hook applies to it.
 */
export function unhookedWorkerHooks(
	runtime: RuntimeDescriptor,
	hooks: ReadonlyArray<WorkerExtensionHook>,
	allowedTools: ReadonlyArray<ToolName>,
): WorkerExtensionHook[] {
	if (runtime.kind === "http") return [];
	if (runtime.kind === "subprocess") return [...hooks];
	return hooksMatchingTools(hooks, allowedTools);
}

export function hooksMatchingTools(
	hooks: ReadonlyArray<WorkerExtensionHook>,
	allowedTools: ReadonlyArray<ToolName>,
): WorkerExtensionHook[] {
	const matches = (pattern: string, tool: string): boolean =>
		pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool;
	return hooks.filter(
		(hook) =>
			hook.tools === undefined || allowedTools.some((tool) => hook.tools?.some((pattern) => matches(pattern, tool))),
	);
}

export function isBlockingHook(hook: WorkerExtensionHook): boolean {
	return hook.onError === "block" || hook.onTimeout === "block";
}

/** Worker hook ids read `extension:<id>:<point>:<index>` (buildWorkerExtensionHooks). */
export function hookExtensionIds(hooks: ReadonlyArray<WorkerExtensionHook>): string {
	return [...new Set(hooks.map((hook) => hook.id.split(":")[1] ?? hook.id))].join(", ");
}

export function buildDispatchWorkerSpec(input: DispatchWorkerSpecInput, config?: ConfigContract): WorkerSpec {
	assertResponseSchemaEnforceable(
		input.target.runtime,
		input.target.modelCapabilities,
		input.req.responseSchema,
		input.admission.allowedTools.length,
	);
	const settings = input.settings ?? config?.get();
	const readOnly = input.envelope.write.mode === "none";
	// DESIGN 4.5: what stops this run, sealed once. Dispatch stamped the wall clock; a direct builder resolves it here.
	const limitSettings = settings ?? DEFAULT_SETTINGS;
	const wall =
		input.req.runWallMs !== undefined && input.req.assignmentDeadlineAt !== undefined
			? { wallMs: input.req.runWallMs, deadlineAt: input.req.assignmentDeadlineAt }
			: resolveRunWall({
					capMs: runWallCapMs(limitSettings.fleet.limits, input.req.requestOrigin),
					...(input.recipe?.budget?.timeoutMs !== undefined ? { recipeMs: input.recipe.budget.timeoutMs } : {}),
					startedAt: Date.now(),
					...(input.req.assignmentDeadlineAt !== undefined ? { deadlineAt: input.req.assignmentDeadlineAt } : {}),
				});
	const limits = resolveRunLimits({
		role: input.role,
		wallMs: wall.wallMs,
		deadlineAt: wall.deadlineAt,
		responseSeconds: limitSettings.safety.limits.workerResponseSeconds,
		toolCeiling: input.budget.ceiling ?? input.budget.hardCap,
		maxRetries: limitSettings.fleet.retry.maxRetries,
		refusals: WORKER_REFUSAL_LIMIT,
	});
	const spec: WorkerSpec = {
		...(input.req.runIdHint
			? {
					telemetryContext: {
						sessionId: input.req.ownerSessionId ?? null,
						runId: input.req.runIdHint,
						agent: workerAgent(input.req.runIdHint),
						...(input.req.lineage?.parentRunId ? { parentRunId: input.req.lineage.parentRunId } : {}),
					},
				}
			: {}),
		specVersion: WORKER_SPEC_HOOKLESS_VERSION,
		settingsFingerprint: computeSettingsFingerprint(settings ?? null),
		systemPrompt: input.systemPrompt,
		dynamicPromptMessages: input.dynamicPromptMessages,
		...(input.promptSignature !== null ? { promptSignature: input.promptSignature } : {}),
		toolSignature: input.toolSignature,
		...(input.dynamicHash !== null ? { dynamicHash: input.dynamicHash } : {}),
		agentId: input.req.agentId,
		task: input.req.task,
		// The configured target may name its runtime by a plugin alias. The attested
		// document records the resolved runtime instead, so what the worker reads
		// and what the orchestrator routed on are the same id.
		target: { ...input.target.target, runtime: input.target.runtime.id },
		runtime: serializeWorkerRuntimeDescriptor(input.target.runtime),
		runtimeId: input.target.runtime.id,
		wireModelId: input.target.wireModelId,
		thinkingLevel: input.target.thinkingLevel,
		envelope: input.envelope,
		...(input.req.ledger !== undefined ? { ledger: input.req.ledger } : {}),
		budget: input.budget,
		limits,
		middlewareSnapshot: input.middlewareSnapshot,
		permit: input.permit,
		...(input.flowPolicy !== undefined ? { flowPolicy: structuredClone(input.flowPolicy) } : {}),
	};
	const protectedArtifactState = frozenProtectedArtifactState(input.protectedArtifactState);
	assertProtectedArtifactsEnforceable(
		input.target.runtime.id,
		input.target.runtime.kind !== "subprocess",
		protectedArtifactState,
	);
	if (protectedArtifactState.artifacts.length > 0) {
		spec.protectedArtifactState = {
			version: WORKER_PROTECTED_ARTIFACT_STATE_VERSION,
			artifacts: protectedArtifactState.artifacts,
		};
	}
	if (input.target.runtime.kind !== "http") {
		const policy = input.flowPolicy === undefined ? null : compileWorkerFlowPolicy(input.flowPolicy);
		const destination = resolveModelDestination({
			targetId: input.target.target.id,
			runtimeId: input.target.runtime.id,
			url: input.target.target.url,
			model: input.target.wireModelId,
		});
		const refusal =
			policy === null
				? flowHandoffRefusal(input.target.runtime.id, input.flowRestrictions ?? null)
				: (flowUnmediatedAgentRefusal(policy, destination) ??
					flowTransferRefusal(policy, input.flowRestrictions ?? null, destination));
		if (refusal !== null) throw new Error(refusal);
	}
	if (input.flowRestrictions !== undefined && input.flowRestrictions !== null) {
		spec.flowRestrictions = structuredClone(input.flowRestrictions) as FlowRestrictionSet;
	}
	if (input.req.responseSchema !== undefined) spec.responseSchema = input.req.responseSchema;
	// Identical local context runs otherwise inherit changing server sampling defaults.
	if (input.req.sampling !== undefined) spec.sampling = input.req.sampling;
	if (input.req.synthesisAt !== undefined) spec.synthesisAt = input.req.synthesisAt;
	// The worker repairs against exactly the contract the orchestrator will seal.
	// A gate role that overrides the recipe contract gets no worker-side repair,
	// for the same reason it gets no recipe validation.
	//
	// The request's own override is the contract whether or not the seated
	// recipe declares one, because that is the resolution the seal already uses.
	// Requiring a recipe contract here meant a caller-supplied override against a
	// recipe with none was sealed but never sent, so the worker spent no repair
	// round on a contract it was never told about and the run failed on a shape
	// nothing had asked it for. A caller's summary allowance is folded in by
	// the same resolver the seal uses, so the two never disagree.
	const workerResultContract = dispatchResultContract(input.req, input.recipe);
	if (workerResultContract) spec.resultContract = workerResultContract;
	if (
		(workerResultContract?.kind === "mutation-report" ||
			input.recipe?.audience === "shadow" ||
			input.recipe?.audience === "internal") &&
		input.target.runtime.kind === "http" &&
		targetToolCapability(input.target) === true &&
		workerResultContract &&
		(INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(workerResultContract.kind)
	)
		spec.helperResult = true;
	const product = input.req.product ?? input.recipe?.product;
	if (product) spec.product = product;
	spec.role = input.role;
	// The orchestrator's tool decision is the one the run was admitted under and
	// the one the approved tool signature was computed from, so it travels on the
	// snapshot rather than being re-derived worker-side. The worker's
	// workerProviderSupportsTools reads this field first; letting it recompute
	// from the merged capability decision made an unanswered tool question
	// resolve differently in the two processes, and the announcement was then
	// refused for tool surface drift.
	const resolutionSnapshot = runtimeTargetSnapshot(input.target.runtimeResolution);
	spec.runtimeResolution = {
		...resolutionSnapshot,
		capabilities: { ...resolutionSnapshot.capabilities, tools: targetToolCapability(input.target) },
	};
	if (input.target.modelCapabilities) spec.modelCapabilities = input.target.modelCapabilities;
	// Configured model ids with the role each serves, so the worker's empty
	// residency registry evicts nothing and names what it must touch.
	if (settings) {
		const protectedModels = protectedResidencyModels(settings);
		if (protectedModels.length > 0) spec.protectedModels = protectedModels;
	}
	if (input.apiKey) spec.apiKey = input.apiKey;
	if (input.authProfile) spec.authProfile = input.authProfile;
	if (input.credentialExpiresAt !== undefined) spec.credentialExpiresAt = input.credentialExpiresAt;
	const inherited = input.req.turnConstraints === undefined ? {} : workerTurnConstraints(input.req.turnConstraints);
	spec.turnConstraints = {
		...inherited,
		toolSurfaceSources: [
			...toolSurfaceSources(inherited),
			...(input.recipe
				? [
						{
							tools: input.recipe.tools,
							source: `agent recipe "${input.req.agentId}"`,
							remedy: `Ask the operator to widen tools in agent recipe "${input.req.agentId}", then redispatch.`,
						},
					]
				: []),
		],
	};
	if (input.extensionHooks !== undefined && input.extensionHooks.length > 0 && input.target.runtime.kind === "http")
		spec.extensionHooks = input.extensionHooks.map((hook) => ({
			...hook,
			...(hook.tools ? { tools: [...hook.tools] } : {}),
		}));
	// Only a hooked spec needs version 9, so a node one release behind still serves the rest.
	spec.specVersion = workerSpecVersionFor(spec);
	if (input.req.trustProjectCompatRoots !== undefined) {
		spec.trustProjectCompatRoots = input.req.trustProjectCompatRoots;
	} else if (settings) {
		spec.trustProjectCompatRoots = settings.integrations.projectResources.trustProjectImports === true;
	}
	spec.gitCommitAttribution = settings?.integrations.git.commitAttribution ?? true;
	spec.gitCommitAuthor = settings?.integrations.git.commitAuthor ?? "auto";
	// This session's workers count as the owner of its dev extension folders; another session's do not.
	spec.devRootOwner = devRootOwnerForWorkers();
	// Non-stall posture (Symphony §10.5): a dispatched worker has no operator
	// to answer a permission prompt by default, so the resolution policy ships
	// with the spec and the worker enforces it within bounded time. Under the
	// escalate posture the configured timeout/fallback bounds ride along so the
	// worker still cannot hang when no operator resolves the ask.
	// The permit decides the routing. fleet.permissions.mode is its default
	// when the recipe declares no asks route and its ceiling when it does: a
	// recipe can narrow asks to deny or fail but cannot route them to main
	// under a deny or fail mode.
	// The worker reads its route from the envelope's approval block, which the permit's allowance sealed.
	const onPermission = workerPermissionModeForPermit(input.permit.allowance);
	if (onPermission === "escalate") {
		const escalation = settings?.fleet.permissions.escalation;
		// A main-authority permit parks asks for the main agent's grant broker
		// (Phase D). The main agent can grant at yolo; below yolo only an
		// attended operator can, so a headless default run has no responder.
		const mainRouted = mainGrantsUnavailable(input.permit.allowance);
		if (mainRouted && input.grantAttempt === undefined) {
			throw new Error("dispatch: a main-authority permit needs a grant binding for its attempt");
		}
		const attended = input.workerPermissionResponder;
		// With nobody to answer, an escalation could only ever time out, so the
		// worker applies the fallback at once and says why (F9). A judge-routed
		// ask is answered by the safety judge whether or not an operator is
		// attended; its operator rails still need one.
		const unattended =
			input.judgeResponder !== undefined
				? !input.judgeResponder
				: mainRouted
					? !attended && input.mainAutonomy !== "yolo"
					: !attended;
		const operatorUnattended = mainRouted && !attended && !unattended;
		if (escalation || unattended || mainRouted) {
			spec.escalation = {
				timeoutMs: escalation?.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
				fallback: escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK,
				...(unattended ? { responder: "none" as const } : {}),
				...(operatorUnattended ? { operatorResponder: "none" as const } : {}),
				...(mainRouted && input.grantAttempt !== undefined ? { grant: { ...input.grantAttempt } } : {}),
			};
			// This process runs the window of an ask a person can answer, brokered or not,
			// so the person can hold it. With no person to answer, the worker's timer stays
			// the only one and keeps its short bound.
			if (attended && !unattended) {
				spec.escalation.backstopMs = workerApprovalBackstopMs(spec.escalation.timeoutMs);
			}
		}
	}
	assertRuntimeCanHonorWorkerPermissionMode(input.target.runtime, onPermission);
	if (input.envelope.permitDigest !== input.permit.digest) {
		throw new Error("dispatch: the worker envelope wraps another permit than the one the spec carries");
	}
	if (
		input.envelope.staticHead !==
		workerStaticHead({
			api: spec.runtimeId,
			provider: spec.target.id,
			model: spec.wireModelId,
			thinking: spec.thinkingLevel ?? null,
			systemPrompt: spec.systemPrompt,
			tools: { names: workerSpecToolNames(spec), schemas: attestedToolSchemaSignature(workerSpecToolNames(spec)) },
		})
	) {
		throw new Error("dispatch: the worker envelope's static head does not describe the spec it is sealed into");
	}
	if (input.req.storeTags !== undefined && input.req.storeTags.length > 0 && !readOnly) {
		spec.storeGrant = {
			tags: [...input.req.storeTags],
			...(input.req.runIdHint ? { dispatchRunId: input.req.runIdHint } : {}),
			...(input.sharedStoreGrant !== undefined ? { shared: input.sharedStoreGrant } : {}),
		};
	}
	assertWriteRootsEnforceable(input.target.runtime, input.envelope.write.roots);
	const sandbox = workerSandboxFor({
		resultContract: workerResultContract ?? null,
		runtimeKind: input.target.runtime.kind,
		req: input.req,
		pathScope: input.pathScope,
		envelope: input.envelope,
		settings,
	}).spec;
	const upstreamProxy = settings?.safety.egress.upstreamProxy ?? null;
	// A local worker runs on the host this process probed, so it takes that answer rather than probing again.
	const probedBackend =
		sandbox?.backendExpected === true && input.localPlacement === true ? probedSandboxBackend() : null;
	if (sandbox !== undefined)
		spec.sandbox = {
			// The operator's upstream proxy, credentials and all, stays on this host: a fleet node's proxied worker dials directly.
			...(sandbox.egress !== undefined && upstreamProxy !== null && input.localPlacement === true
				? { ...sandbox, egress: { ...sandbox.egress, upstreamProxy } }
				: sandbox),
			...(probedBackend === null ? {} : { probedBackend }),
		};
	// The worker re-attests this identity before every Git mutation; only in it
	// does a git: worktree permit admit add and commit (Phase C).
	const taskWorktree = input.req.taskWorktree;
	if (taskWorktree !== undefined) {
		spec.taskWorktree = {
			root: taskWorktree.root,
			runId: taskWorktree.runId,
			path: taskWorktree.path,
			...(taskWorktree.parent !== undefined ? { parent: taskWorktree.parent } : {}),
			branch: taskWorktree.branch,
			base: taskWorktree.base,
			ownerToken: taskWorktree.ownerToken,
		};
	}
	// Carry the tool profile so external CLI runtimes that cannot mediate
	// per-tool calls can refuse a narrowing profile they would otherwise ignore.
	if (input.admission.toolProfile !== undefined) spec.toolProfile = input.admission.toolProfile;
	if (input.skipRepositoryInstructions === true) spec.skipRepositoryInstructions = true;
	if (input.req.contextSeed && input.target.runtime.kind === "http")
		spec.contextSeed = parseWorkerContextSeed(input.req.contextSeed);
	if (Buffer.byteLength(JSON.stringify(spec), "utf8") + 1 > WORKER_STDIN_FRAME_MAX_BYTES)
		throw new Error("worker context: complete WorkerSpec exceeds the stdin frame budget; use a smaller splice");
	return spec;
}
