// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved TargetDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. HTTP/native
 * runtimes stay pi-agent-backed; sanctioned external runtimes branch to their
 * own worker runners before pi-agent model synthesis.
 */

import { randomUUID } from "node:crypto";
import { isWorkerToolCallCapExceededReason, isWorkerToolCallCapSynthesisReason } from "../core/guardrails.js";
import { snapshotModelInfo } from "../core/model-tier.js";
import { modelRouteGuarded } from "../core/response-model-id.js";
import { observedToolCallOrigin, withTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { ToolNames } from "../core/tool-names.js";
import { createWorkerObservationStore } from "../domains/context/worker/recall.js";
import { workerEconomicsView } from "../domains/dispatch/economics-view.js";
import { WALL_HANDBACK_SHARE } from "../domains/dispatch/handback.js";
import { createReadStreakRegistration } from "../domains/middleware/read-streak.js";
import { createMiddlewareToolChoiceControl } from "../domains/middleware/tool-choice-control.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { AuthResolution } from "../domains/providers/auth/storage.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import { mergeFlowRestrictions } from "../domains/safety/information-flow.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import { sessionChangesTree } from "../domains/safety/run-effects.js";
import { seedRecallLineage } from "../lib/worker-wire/context-seed.js";
import { permissionHoldBackstopAt } from "../lib/worker-wire/protocol.js";
import type { WorkerBudget } from "../lib/worker-wire/spec-contract.js";
import { resolveAgentTools, type ToolTelemetry } from "../tools/agent-tools.js";
import { createWorkerGitContext } from "../tools/git-exec.js";
import { runObservationPool } from "../tools/observation.js";
import type { RegistryDeps } from "../tools/registry-contract.js";
import { clearTaskGates, configureWorkerTaskGates, contractDeclaresTaskGates } from "../tools/verify/task-gates.js";
import type { WorkerDecisionBinding } from "../worker/stdin-demux.js";
import { createEngineAgent, type EngineAgentOptions } from "./agent.js";
import { workerCacheFamilyId } from "./apis/cache-family.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { disableCopilotConversationResume } from "./copilot/session-fs.js";
import { observeExternalWorkerRun } from "./external-call-telemetry.js";
import { startExternalCliWorkerRun } from "./external-cli/connectors.js";
import {
	callRepeatsAsRead,
	createLoopGuardRegistration,
	resolveDeliveryTools,
	workerLoopBlockBudget,
} from "./loop-guard.js";
import { isLoopGuardSynthesisBackstopReason } from "./loop-guard-reasons.js";
import { registerPancodeOAuthProviders } from "./oauth.js";
import { supportsNamedToolChoice } from "./provider-payload.js";
import { createRunPhase, type HandbackTrigger } from "./run-phase.js";
import { createWorkerCallTelemetry } from "./worker-call-telemetry.js";
import type { PancodeWorkerEvent } from "./worker-events.js";
import { createWorkerExtensionHookRegistrations } from "./worker-extension-hooks.js";
import { subscribeWorkerEvents } from "./worker-run/events.js";
import { createWorkerEvidence } from "./worker-run/evidence.js";
import { finishWorkerRun, taskMessage } from "./worker-run/finish.js";
import { createWorkerPermissions } from "./worker-run/permissions.js";
import { createWorkerResult } from "./worker-run/result.js";
import { createWorkerRound } from "./worker-run/round.js";
import type { WorkerRunScope } from "./worker-run/scope.js";
import { decodeWorkerSpec, prepareNativeWorker, workerProviderSupportsTools } from "./worker-run/spec.js";
import { createWorkerStreamFn } from "./worker-run/stream.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput } from "./worker-run-types.js";
import { createWorkerToolRegistry } from "./worker-tools.js";

export { workerProviderSupportsTools };

/** Return the admitted worker specification budget unchanged. */
function resolveWorkerRuntimeBudget(input: Pick<WorkerRunInput, "budget">): WorkerBudget {
	return input.budget;
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const { mutationResult, helperSchema } = decodeWorkerSpec(input);
	if (input.runtime.id === "claude-sdk") {
		return observeExternalWorkerRun(input, emit, (observedEmit) => startClaudeSdkWorkerRun(input, observedEmit));
	}
	if (input.runtime.kind === "subprocess") return startExternalCliWorkerRun(input, emit);

	const { workerSettings, agentSkillPolicy, activeWorkerTools, model, safety } = prepareNativeWorker(input);
	// The run's phase (DESIGN 4.5): work, then handback, then sealed. Its tool
	// lock, flipped by the loop guard's lockout callback, a handback trigger or
	// the wall clock, is read by streamFn below to force the remaining model
	// rounds text-only by removing the tool declarations (Anthropic, Google and
	// Vertex keep them and send tool choice none instead; see toolsRemovedRound).
	const phase = createRunPhase();
	const scope: WorkerRunScope = {
		input,
		emit,
		phase,
		callTracking: null,
		callUsageReported: false,
		contextPressureWindow: 0,
		contextPressureCrossed: false,
		readStreakEscalated: 0,
		streakNoteOpen: false,
		lastProviderHttpStatus: null,
		workerBoundAborted: false,
		abortWorkerForBound: null,
		workerStopCause: undefined,
		workerModelRound: 0,
		runFlow: null,
		flowBlockReported: false,
		workerMcp: undefined,
		resultContractRepairsQueued: 0,
		resultContractRepairsStarted: 0,
		toolExecutionsStarted: 0,
		evidenceRepairActive: false,
		acceptedHelperResult: null,
		helperExposedThisRound: false,
		helperTerminalRequest: false,
		helperTurnFailure: null,
		observedReadRanges: new Map(),
		observedGrepLines: new Map(),
		runObservationWindow: undefined,
		contractResponseFormat: undefined,
		permissionFailure: false,
		activeEscalation: null,
		get registry() {
			return registry;
		},
		get agent() {
			return agent;
		},
		get safety() {
			return safety;
		},
		get contractCwd() {
			return contractCwd;
		},
		get helperForcedChoiceAvailable() {
			return helperForcedChoiceAvailable;
		},
		get helperSchema() {
			return helperSchema;
		},
		get unsubscribe() {
			return unsubscribe;
		},
		get inheritedCount() {
			return inheritedCount;
		},
		get synthesisTimer() {
			return synthesisTimer;
		},
		get wallTimer() {
			return wallTimer;
		},
		get clearActiveEscalation() {
			return clearActiveEscalation;
		},
		get unsubscribePermission() {
			return unsubscribePermission;
		},
		get thrashOutcome() {
			return thrashOutcome;
		},
		get workerTelemetry() {
			return workerTelemetry;
		},
		get workerSettings() {
			return workerSettings;
		},
		get workerCanWrite() {
			return workerCanWrite;
		},
		get workerCanPlan() {
			return workerCanPlan;
		},
		get helperToolAvailable() {
			return helperToolAvailable;
		},
		get observeBoundReason() {
			return observeBoundReason;
		},
		get mutationResult() {
			return mutationResult;
		},
		get activeWorkerTools() {
			return activeWorkerTools;
		},
		get model() {
			return model;
		},
		get runEffects() {
			return runEffects;
		},
		get middlewareToolChoice() {
			return middlewareToolChoice;
		},
		get terminalHandoffActive() {
			return terminalHandoffActive;
		},
		get workerResponseFormat() {
			return workerResponseFormat;
		},
		get effectiveThinkingLevel() {
			return effectiveThinkingLevel;
		},
		get onAssistantBatch() {
			return onAssistantBatch;
		},
		get onToolEvent() {
			return onToolEvent;
		},
		get onMessageEnd() {
			return onMessageEnd;
		},
		get contractReminder() {
			return contractReminder;
		},
		get inheritedMessages() {
			return inheritedMessages;
		},
		get contextGuard() {
			return contextGuard;
		},
		get workShare() {
			return workShare;
		},
		get noteShare() {
			return noteShare;
		},
		get enterHandback() {
			return enterHandback;
		},
		get refreshWorkerOAuthKey() {
			return refreshWorkerOAuthKey;
		},
		get tools() {
			return tools;
		},
		get observations() {
			return observations;
		},
		get seedLineage() {
			return seedLineage;
		},
		get loopGuardRegistration() {
			return loopGuardRegistration;
		},
	};

	// The credential the current request carries, so a server rejection refreshes
	// exactly that token under the shared storage lock (#427).
	let lastAuthResolution: AuthResolution | null = null;
	const refreshWorkerOAuthKey = async (): Promise<string | null> => {
		const rejected = lastAuthResolution;
		if (!input.authProfile || rejected?.source !== "stored-oauth" || rejected.apiKey === undefined) return null;
		process.stderr.write(`[worker] refreshing the OAuth credential for target '${input.target.id}' and retrying once\n`);
		const refreshed = await openAuthStorage().forceRefreshApiKey(input.authProfile, rejected.apiKey, input.signal);
		if (!refreshed.available || refreshed.apiKey === undefined) {
			// Reuse the CLI login syntax, and keep refresh-provider diagnostics out of the remedy (#427).
			throw new Error(
				`OAuth credential for target '${input.target.id}' could not be refreshed. Run pancode auth login ${rejected.providerId} again.`,
			);
		}
		lastAuthResolution = refreshed;
		return refreshed.apiKey;
	};
	const workerBudget = resolveWorkerRuntimeBudget(input);
	// The reserve window ends discovery, not the run's own product. An agent that was
	// granted mutation tools delivers by writing, so those stay admitted inside it;
	// a read-only agent has none and ends in synthesis.
	const deliveryTools = resolveDeliveryTools(input.allowedTools, input.product);
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The model round that may only report: the one after the refusal limit tripped.

	const loopGuardRegistration = createLoopGuardRegistration({
		safety,
		readResultMaxBytes: workerSettings.context.toolResultMaxBytes,
		toolCallCap: workerBudget.hardCap,
		...(workerBudget.ceiling !== undefined ? { toolCallCeiling: workerBudget.ceiling } : {}),
		toolCallSoftLimit: workerBudget.toolCalls,
		// A worker's blocks all land in one run-long bucket, so the bound on
		// them is a statement about this run's length, not about a turn.
		turnBlockBudget: workerLoopBlockBudget(workerBudget.toolCalls),
		...(deliveryTools.length > 0 ? { deliveryTools } : {}),
		turnSynthesisLockout: workerBudget.synthesis,
		// Once locked, the next model round is forced text-only at the
		// request level. The lockout directive alone relies on model compliance.
		onSynthesisLockout: () => {
			if (workerBudget.synthesis) phase.lockTools("tools");
		},
	});
	const seedLineage = seedRecallLineage(input.contextSeed);
	// X3: a writer worker gets the main agent's read-streak rule. Its first note rides the tool result; the second
	// step is this run's thrash host note, with the streak as its cause. Writing means holding edit or write, not
	// merely a delivery tool: an orientation run delivers through code_nav.
	const workerCanWrite =
		input.readOnly !== true && activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write);
	const workerCanPlan = activeWorkerTools.includes(ToolNames.Tasks);
	const readStreakRegistration =
		deliveryTools.length > 0 && workerCanWrite
			? createReadStreakRegistration({
					// The worker's configured scratch roots count as scratch, as its run-effects recorder reads them.
					classifiers: { repeatsAsRead: callRepeatsAsRead, changesTree: sessionChangesTree(() => workerSettings) },
					workspaceRoot: () => input.cwd ?? process.cwd(),
					surface: {
						canWrite: true,
						canPlan: workerCanPlan,
						canAsk: activeWorkerTools.includes(ToolNames.AskUser),
					},
					secondStep: (count) => {
						scope.readStreakEscalated = count;
					},
					// A later step of the same call (a chain's edit) that resets the streak withdraws the second step.
					onReset: () => {
						scope.readStreakEscalated = 0;
						scope.streakNoteOpen = false;
					},
					// X7: a worker is never continued by an operator, so a streak past every note meets the decision gate,
					// and its second refused round ends the run as a bound does, with its own outcome code.
					unattended: true,
					stall: (detail) => {
						emit({ type: "pancode_run_outcome", payload: { outcomeCode: "exploration_stalled" } });
						if (scope.workerBoundAborted) return;
						scope.workerBoundAborted = true;
						phase.seal(`exploration_stalled: ${detail}`);
						process.stderr.write(`[worker] read-streak gate: ${detail}; stopped the run\n`);
						scope.abortWorkerForBound?.();
					},
				})
			: null;
	const observations = createWorkerObservationStore(input.telemetryContext?.runId, seedLineage);
	// Run-scoped ledger: the inherited set plus what this run's reads add. It
	// lives in memory only; every growth is reported to the parent at once and
	// sealed in the receipt, so the parent's session ledger absorbs it before
	// any output of this run reaches its context.
	scope.runFlow = input.flowRestrictions ?? null;
	const workerFlow: NonNullable<RegistryDeps["flow"]> = {
		mcpTransport: (tool) => scope.workerMcp?.transportOf(tool) ?? null,
		carried: () => scope.runFlow,
		refusal: () => null,
		absorb: (set) => {
			const before = scope.runFlow?.restrictions.length ?? 0;
			scope.runFlow = mergeFlowRestrictions(scope.runFlow, set);
			// Every growth reaches the parent on the receipt-bearing lane, so the
			// label precedes any output derived from the read.
			if (scope.runFlow !== null && scope.runFlow.restrictions.length > before) {
				emit({ type: "pancode_flow_restrictions", payload: { set: scope.runFlow } } as PancodeWorkerEvent);
			}
		},
	};
	// The protected-artifacts guard starts from the parent-session snapshot
	// and has no persistence sink. It can still absorb worker-local
	// protect_path effects from snapshot rules and the dispatching session's
	// extension hooks for the rest of this run.
	const protectedArtifacts = createProtectedArtifactsRegistration({
		...(input.protectedArtifactState !== undefined
			? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// A checker (verifier, debugger) has no shell; the gate commands its task
	// names are what it may run through verify (task-gates.ts). Every other role sees none.
	if (contractDeclaresTaskGates(input.resultContract?.kind)) {
		configureWorkerTaskGates(input.task);
	} else {
		clearTaskGates();
	}
	const registry = createWorkerToolRegistry(
		input.middlewareSnapshot,
		safety,
		{
			...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
			...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
			...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
			...(input.mcp?.attestation.skills !== undefined ? { mcpSkills: input.mcp.attestation.skills } : {}),
		},
		// Workers run unattended, so the loop guard carries the hard tool-call
		// cap in addition to repetition blocking, plus the synthesis lockout:
		// after the loop-block budget the worker is told to report from what it
		// gathered instead of burning the lifetime cap on a retry spiral, and
		// the bounded backstop reason is watched in telemetry.onFinish below to
		// abort a worker that keeps calling tools anyway.
		[
			loopGuardRegistration,
			...(readStreakRegistration !== null ? [readStreakRegistration] : []),
			protectedArtifacts,
			// The dispatching session's extension gates, run there for each call they match.
			...(input.extensionHookHost !== undefined
				? createWorkerExtensionHookRegistrations(input.extensionHookHost.hooks, input.extensionHookHost.request)
				: []),
		],
		input.readOnly,
		(effects) => middlewareToolChoice.apply(effects),
		input.agentLedger === undefined
			? undefined
			: {
					read: () => input.agentLedger?.read() ?? null,
					post: (body) => input.agentLedger?.post(body, scope.runFlow ?? undefined) ?? { ok: false, reason: "no-ledger" },
				},
		observations.recall,
		input.taskGit !== undefined
			? createWorkerGitContext({
					allowance: input.taskGit.allowance,
					executePermitted: input.taskGit.executePermitted,
					cwd: input.cwd ?? process.cwd(),
					...(input.taskGit.taskWorktree !== undefined ? { taskWorktree: input.taskGit.taskWorktree } : {}),
				})
			: undefined,
		input.permitAllowance?.executeAutonomy,
		workerFlow,
		input.mcp !== undefined
			? (registry) => {
					const { attestation: admitted, createSource } = input.mcp as NonNullable<WorkerRunInput["mcp"]>;
					// Declarations and trust are read from the project root admission
					// used, never from a task worktree that holds neither, and nothing
					// this run observes is written back to the operator's catalog. The
					// servers themselves start in this run's tree, under its sandbox:
					// the task worktree's root, never the subdirectory a dispatch from
					// one gives as cwd. Without a task worktree the cwd is already the
					// tree root admission resolved, including a compete candidate's own
					// worktree, whose source checkout lies outside its write roots.
					scope.workerMcp = createSource({
						cwd: admitted.projectRoot,
						launchRoot: input.taskGit?.taskWorktree?.path ?? input.cwd ?? process.cwd(),
						registry,
						persistCatalog: false,
						admitted,
						// A worker reads the store and writes only the tags its dispatch granted.
						store: { writable: false, ...(input.storeGrant !== undefined ? { grant: input.storeGrant } : {}) },
					});
					return scope.workerMcp;
				}
			: undefined,
		(effects, hookInput) => protectedArtifacts.absorbAwaited(hookInput, effects),
		input.storeGrant,
		async () => workerEconomicsView(input.limits),
	);
	const contractCwd = input.cwd ?? process.cwd();

	const { thrashOutcome, runEffects, onToolEvent } = createWorkerEvidence(scope);
	const { terminalHandoffActive, pushHelperTool, beforeToolCall, finishTurn, onAssistantBatch, onMessageEnd } =
		createWorkerResult(scope);

	/** The run's next round is its handback round; the bound that triggered it is journaled as its kind (M3). */
	const enterHandback = (bound: HandbackTrigger): void => {
		phase.lockTools(bound);
		process.stderr.write(
			`[worker] handback: ${bound} reached the ${input.role ?? "run"}'s share; the next round reports\n`,
		);
		if (input.telemetryContext)
			telemetryHub().emit(
				"middleware.fired",
				{
					hook: "turn_start",
					phase: "sync",
					ruleId: "worker.handback",
					effects: ["lock_tools"],
					severity: "info",
					evidence: `bound:${bound}@worker`,
				},
				input.telemetryContext,
			);
	};
	/**
	 * A refusal whose reason is a run bound. Direct calls reach this through
	 * their blocked finish; a chain child the bound refused reaches it through
	 * the chain's receipt, because the aggregate settles as an ordinary error
	 * and its own finish cannot carry the child's verdict.
	 */
	const observeBoundReason = (reason: string): void => {
		// Lifetime-cap lockout ends tool use before the final report. Writers
		// retain the exhausted outcome; reporting workers can seal their synthesis.
		if (isWorkerToolCallCapSynthesisReason(reason)) {
			if (workerBudget.synthesis && deliveryTools.length === 0) {
				// DF-10: a reporting recipe's cap ends tool use; its sealed synthesis is the product.
				phase.lockTools("tools");
				process.stderr.write(`[worker] ${reason}\n`);
				return;
			}
			emit({ type: "pancode_run_outcome", payload: { outcomeCode: "worker_tool_call_cap_exhausted" } });
			if (phase.sealedBy === null) {
				phase.seal(reason);
				process.stderr.write(`[worker] ${reason}\n`);
			}
			return;
		}
		// Hard bounds: the immediate cap abort (lockout not wired) and
		// the synthesis backstop for a model that keeps emitting tool calls
		// after the lock. Both end the run; the first recorded bound wins the
		// receipt diagnostic.
		if (isWorkerToolCallCapExceededReason(reason) || isLoopGuardSynthesisBackstopReason(reason)) {
			emit({
				type: "pancode_run_outcome",
				payload: {
					outcomeCode: isLoopGuardSynthesisBackstopReason(reason)
						? "loop_guard_tools_disabled_exhausted"
						: "worker_tool_call_cap_exhausted",
				},
			});
			if (scope.workerBoundAborted) return;
			scope.workerBoundAborted = true;
			phase.seal(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			scope.abortWorkerForBound?.();
		}
	};
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "pancode_tool_start", payload: event });
		},
		onFinish(event) {
			if (event.toolCallId !== undefined) runEffects.checkOutcome(event.toolCallId, event.outcome, event.unresolved);
			emit({ type: "pancode_tool_finish", payload: event });
			if (event.outcome !== "blocked" || typeof event.reason !== "string") return;
			observeBoundReason(event.reason);
		},
	};
	const tools = resolveAgentTools({
		registry,
		...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
		telemetry,
		envelopeTools: activeWorkerTools,
		agentId: input.agentId,
		includeInteractiveTools: false,
		invokeOptions: (toolCallId) => ({
			...observedToolCallOrigin(agent.state.messages, toolCallId),
			...(input.telemetryContext === undefined
				? {}
				: {
						runId: input.telemetryContext.runId,
						...(input.telemetryContext.sessionId === null ? {} : { sessionId: input.telemetryContext.sessionId }),
						...(input.telemetryContext.turnId === undefined ? {} : { turnId: input.telemetryContext.turnId }),
					}),
			...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
			correlationId: `worker-model-round-${scope.workerModelRound}`,
			toolResultMaxBytes: workerSettings.context.toolResultMaxBytes,
			// DESIGN 4.5: the run's own observation pool, sized from the usable window the last round measured.
			...(scope.runObservationWindow !== undefined && input.telemetryContext !== undefined
				? { observationRunPool: runObservationPool(scope.runObservationWindow) }
				: {}),
			// The worker's own model, resolved by the orchestrator, so hooks judge the worker by it.
			...(input.runtimeResolution !== undefined ? { model: snapshotModelInfo(input.runtimeResolution) } : {}),
			supportsImages: acceptsImageInput({
				runtimeId: input.runtime.id,
				vision: input.modelCapabilities?.vision,
				modelInput: model.input,
			}),
			// The admitted capability list, so the gateway calls only what the
			// recipe declared: the same bound the attached schemas already honor.
			allowedTools: input.allowedTools,
			...(agentSkillPolicy ? { pendingSkillPolicy: agentSkillPolicy } : {}),
		}),
	});
	const helperToolAvailable = helperSchema !== null && workerProviderSupportsTools(input);
	const helperForcedChoiceAvailable = helperToolAvailable && supportsNamedToolChoice(model.api);
	pushHelperTool(tools);
	if (tools.length === 0 && activeWorkerTools.length > 0) {
		process.stderr.write(`[worker] warning: no tools resolved for allowed=[${activeWorkerTools.join(",")}]\n`);
	}
	const {
		workShare,
		noteShare,
		effectiveThinkingLevel,
		inheritedMessages,
		contextGuard,
		workerResponseFormat,
		contractReminder,
		beforeStreamRequest,
		initialState,
	} = createWorkerRound(scope);
	const streamFn = createWorkerStreamFn(scope);
	const options: EngineAgentOptions = {
		// Row 384 backstop: a provider that accepts the id and serves another model is refused at its first response.
		refuseServedModelMismatch: () => modelRouteGuarded(input.runtime),
		beforeStreamRequest,
		beforeToolCall,
		finishTurn,
		// Each round sends through engineStreamSimple, whose guard sees the evicted request.
		delegateGuardsToolArguments: true,
		streamFn,
		initialState,
		getApiKey: async () => {
			workerTelemetry?.stage("transform", "end");
			// A key the parent handed over needs no resolution, so the call has no auth stage (#434).
			if (!input.authProfile) return input.apiKey;
			workerTelemetry?.stage("auth", "start");
			let refreshed: boolean | undefined;
			try {
				registerPancodeOAuthProviders();
				const resolved = await openAuthStorage().resolveApiKey(input.authProfile, {
					includeFallback: false,
					...(input.signal ? { signal: input.signal } : {}),
				});
				refreshed = resolved.refreshed;
				if (!resolved.available || !resolved.apiKey) {
					throw new Error(resolved.detail ?? `Credential '${input.authProfile}' is unavailable. Log in again.`);
				}
				lastAuthResolution = resolved;
				return resolved.apiKey;
			} finally {
				workerTelemetry?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
			}
		},
	};
	// Providers derive prompt-cache affinity (openai-codex prompt_cache_key,
	// session headers) from the session ID. Without one every worker call
	// landed cold: captured Luna workers read 48% of input from cache against
	// the main agent's 89%. One opaque ID per invocation keeps it out of the
	// prompt, so prompt and tool attestation hashes are unchanged. Where the
	// backend routes to its cache by that ID, workers with one stable head and
	// cache lane take the same one, so a later worker reads the head an earlier
	// one wrote (FL-17).
	options.sessionId =
		input.sessionId ||
		workerCacheFamilyId({
			api: model.api,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: effectiveThinkingLevel,
			systemPrompt: input.systemPrompt,
			tools,
			lane: input.cacheLane ?? 0,
		}) ||
		randomUUID();
	// That id may be the parent's: a worker leaves the parent's resumable Copilot conversation alone (bt-10).
	disableCopilotConversationResume();

	const { agent } = createEngineAgent(options);
	// Pi adds a leading prompt/tool declaration; exclude the entire inherited baseline.
	const inheritedCount = agent.state.messages.length;
	// The result-contract repair queues a call/result pair that must land in
	// one drain, or the provider sees a lone assistant tool call. Operator
	// steers batch the same way the main agent's do: all at the next slot.
	agent.followUpMode = "all";
	agent.steeringMode = "all";
	scope.abortWorkerForBound = () => {
		scope.workerStopCause ??= "loop_guard";
		agent.abort();
	};
	// Qwopus 3.8 explored context init's whole 240 s ceiling one read at a time and was
	// aborted before submitting. A host deadline ends exploration while the terminal round fits.
	const synthesisTimer =
		input.synthesisAt === undefined
			? undefined
			: setTimeout(
					() => {
						phase.lockTools("synthesis");
					},
					Math.max(0, input.synthesisAt - Date.now()),
				);
	synthesisTimer?.unref();
	// DESIGN 4.5: at 85% of the wall clock the next round is the handback round, and the host stops the run at the
	// wall. A run the wall clock moved to handback seals timed_out with what it reports (fleet M8).
	const wallLimits = input.limits?.time;
	const wallTimer =
		wallLimits === undefined
			? undefined
			: setTimeout(
					() => {
						if (phase.sealedBy !== null) return;
						enterHandback("time");
						emit({
							type: "pancode_run_outcome",
							payload: {
								outcomeCode: "worker_run_timeout",
								detail: `worker_run_timeout: the run reached ${Math.round(WALL_HANDBACK_SHARE * 100)}% of its ${Math.round(wallLimits.wallMs / 1000)} s wall clock; its tools are withdrawn and its next round is its report`,
							},
						});
					},
					Math.max(0, wallLimits.handbackAt - Date.now()),
				);
	wallTimer?.unref();
	const unsubscribe = subscribeWorkerEvents(scope);

	const {
		escalationConfig,
		clearActiveEscalation,
		resolveEscalation,
		resolveDecision,
		denyActiveEscalationOnAbort,
		unsubscribePermission,
	} = createWorkerPermissions(scope);

	const workerTelemetry = input.telemetryContext
		? createWorkerCallTelemetry(
				input.telemetryContext,
				{
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					api: model.api,
					requestedModel: model.id,
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
				resolveEffectivePricing(input.target, input.runtime, input.wireModelId),
				emit,
			)
		: undefined;
	// The run's identity scopes its tool and middleware records, so the host accepts them as this run's (#434).
	const runScoped = <T>(work: () => T): T =>
		input.telemetryContext ? withTelemetryContext(input.telemetryContext, work) : work();
	const promise = runScoped(() => finishWorkerRun(scope));

	return {
		promise,
		abort: (cause) => {
			// Under escalate a parked call would otherwise keep waitForIdle from
			// returning, so cancel it before aborting. cancelParkedCalls is a
			// no-op when nothing is parked, so deny/fail abort stays unchanged.
			if (escalationConfig) {
				const reason =
					cause === "owner_channel_closed"
						? "permission request expired: the session that owns this worker exited or disconnected; re-run the work from a live session"
						: "run aborted while a permission escalation was pending";
				denyActiveEscalationOnAbort(reason);
				registry.cancelParkedCalls(reason);
			}
			scope.workerStopCause ??= cause === "internal" ? "internal" : "parent_cancel";
			agent.abort();
		},
		steer: (text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return false;
			// A worker reports no turn_start, so its operator's steer is where the read streak starts over.
			readStreakRegistration?.resetStreak();
			agent.steer(taskMessage(trimmed));
			return true;
		},
		resolvePermission: (
			requestId: string,
			decision: "approve" | "deny",
			binding?: WorkerDecisionBinding,
			cause?: "timeout",
		) => resolveDecision(requestId, decision, binding, cause),
		holdPermission: (requestId: string, holdMs: number) => {
			const active = scope.activeEscalation;
			// Without a backstop the worker's own timer is the window, and no parent may stretch it.
			if (active === null || active.requestId !== requestId || escalationConfig?.backstopMs === undefined) return false;
			const at = performance.now();
			const timerAt = permissionHoldBackstopAt({ openedAt: active.openedAt, now: at, holdMs, currentAt: active.timerAt });
			if (timerAt === active.timerAt) return true;
			clearTimeout(active.timer);
			active.timerAt = timerAt;
			active.timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), timerAt - at);
			return true;
		},
	};
}
