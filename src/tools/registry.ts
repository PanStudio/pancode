// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../core/headless-permission.js";
import { recordUncontainedShell } from "../core/sandbox/launch-record.js";
import { invalidateWorkspaceSecretScans } from "../core/sandbox/secret-files.js";
import type { SandboxLaunchWhy } from "../core/sandbox/types.js";
import type { ToolName } from "../core/tool-names.js";
import { isMcpToolName, ToolNames } from "../core/tool-names.js";
import { effectiveToolCall, toolSpecPlacement } from "../core/tool-surface.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { toolSurfaceSources, turnAllowsTool } from "../core/turn-constraints.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../core/views/approval-words.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookResult,
	ToolCallLanding,
} from "../domains/middleware/types.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import {
	type AdmissionAskSource,
	type AdmissionDisposition,
	type ApprovalAuthority,
	evaluateAdmission,
} from "../domains/safety/admission.js";
import { approvalAxisId } from "../domains/safety/approval-axis.js";
import type { OpenDecisionKind } from "../domains/safety/autonomy-window.js";
import { mainCallExposure } from "../domains/safety/call-consequence.js";
import { GIT_CONTROL_FILE_RULE_ID, STARTUP_PATH_RULE_ID } from "../domains/safety/containment.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { type DenialLayer, repeatedDenialReason, type ToolDenial } from "../domains/safety/denial.js";
import { escapeScopeOptionConsequence, escapeScopeOptionLabel } from "../domains/safety/escape-scope.js";
import type { GitHookDriftReport } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../domains/safety/information-flow.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import {
	OPERATOR_NAMED_RULE,
	SAFETY_JUDGE_ALLOW_REASON_CODE,
	type SafetyJudgeOutcome,
} from "../domains/safety/safety-judge.js";
import { asksToLeaveSandbox } from "../domains/safety/sandbox-escape.js";
import { UNATTENDED_ALLOWED_BY } from "../domains/safety/unattended.js";
import {
	missingUnsandboxedReason,
	UNSANDBOXED_REASON_ARG,
	UNSANDBOXED_REASON_REQUIRED_CODE,
} from "../domains/safety/unsandboxed-reason.js";
import { YOLO_FLOOR_REASON_PREFIX } from "../domains/safety/yolo-floor.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../lib/autonomy/autonomy.js";
import { approvalGiver, withApprovalNote } from "./approval-note.js";
import { type DispatchPlanView, describeDispatchPlan } from "./dispatch-plan.js";
import { settleObservationCharge } from "./observation.js";
import {
	createReadFanOutBudget,
	joinReadFanOut,
	malformedReadPathsCall,
	READ_PATHS_MIN_SLICE_BYTES,
	type ReadFanOutEntry,
	readFanOut,
	readFanOutCapBytes,
	readFanOutText,
} from "./read-fan-out.js";
import { createRegistryAttempts } from "./registry/attempts.js";
import { createFlowGates } from "./registry/flow.js";
import { createOperatorScopes } from "./registry/operator-scope.js";
import type { ContainedRoots, ParkedCall, RegistryScope } from "./registry/scope.js";
import { createSnapshotGate } from "./registry/snapshot.js";
import {
	applyRegisteredToolClassification,
	approvalConsequencesOf,
	disposeAdmissionArgs,
	hookLanding,
	outboundFilesOf,
	prepareAdmissionCall,
	prepareToolArgs,
	resolveToolResultDisposition,
} from "./registry-call-prep.js";
import type {
	AdmissionReviewEvent,
	ApprovalCarry,
	ExecutionProvenance,
	OneShotGrant,
	ParkCancelOptions,
	PermissionRequiredMeta,
	RegistryDeps,
	RegistryVerdict,
	ToolBoundaryReminder,
	ToolInvokeOptions,
	ToolRegistry,
} from "./registry-contract.js";
import {
	applyToolResultEffects,
	buildToolHookInput,
	firstBlockToolEffect,
	guardRuleIds,
	noteGuardRule,
} from "./registry-hook-effects.js";
import {
	nestedBlockedVerdict,
	nestedChainResults,
	nestedExecutions,
	recordedExecution,
	withRegistryScope,
} from "./registry-nested-calls.js";
import { createShellEgress, enqueueOperatorAsk, type OperatorAskQueue } from "./registry-operator-asks.js";
import {
	askUserAnswered,
	blockDecision,
	blockedVerdict,
	CONTAINED_YOLO_ALLOWED_BY,
	CONTAINED_YOLO_ESCAPE_REASON,
	CONTAINED_YOLO_REASON,
	CONTAINED_YOLO_REASON_CODE,
	containedOutwardReason,
	DENIED_CALL_MEMORY_LIMIT,
	DENIED_REPEAT_REASON_CODE,
	ESCAPE_SCOPE_ALLOW_REASON_CODE,
	ESCAPE_SCOPE_ALLOWED_BY,
	escapeNoScopeLine,
	escapeScopeAllowedDecision,
	escapeScopeAskHint,
	FLOW_BLOCK_REASON_CODE,
	FLOW_RESTRICTIONS_DETAIL,
	flowBlockedVerdict,
	HOOK_APPROVAL_RULE_ID,
	HOST_READ_ONLY_SOURCES,
	NO_PARK_LISTENER_REASON,
	NO_PARK_LISTENER_REASON_CODE,
	operatorAnswers,
	PARK_ABORT_REASON,
	parkAnsweredBlockedVerdict,
	readOnlyDeniedVerdict,
	SAFETY_JUDGE_REASON_PREFIX,
	SAFETY_JUDGE_SKIP,
	SNAPSHOT_REQUIRED_REASON_CODE,
	safetyJudgeAllowedDecision,
	sessionConsentParkDecision,
	skillSurfaceBlockedVerdict,
	toDispatchPlanAskDecision,
	withFlowRestrictions,
} from "./registry-verdicts.js";
import type { ToolResultDigest } from "./result-disposition.js";
import { shapeToolResult, toolResultDigestFor } from "./result-shaping.js";
import type { ToolResult, ToolSpec } from "./tool-spec.js";

/**
 * Tool registry. Admission point for every tool call. Delegates classification
 * and policy decisions to the safety domain, parks one-shot confirmation asks,
 * and runs admitted tool bodies. Never throws on safety rejections; the caller
 * surfaces the rejection message back to the model.
 */

/**
 * Per-tool execution mode override forwarded to pi-agent-core's
 * `AgentTool.executionMode`. Parallel tools may run concurrently with other
 * parallel tool calls; sequential tools run one at a time and prevent any
 * other tool in the batch from running in parallel with them. Leaving this
 * undefined defers to the agent loop's global `toolExecution` setting.
 */
/** Tools whose completion may have written in the workspace, so the cached secret-mask scan is renewed. */
const WORKSPACE_WRITING_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Write,
	ToolNames.Edit,
	ToolNames.Bash,
	ToolNames.RunScript,
	// A run script has Node; it may write files.
	ToolNames.Browser,
]);

/**
 * Approval rules after which a landed typed write refreshes the git hook drift baseline: git-control-file, which the
 * operator approves or the judge allows, and startup-path-confirm, which only the operator approves. A hooks
 * directory such as .husky is both, and the startup-path rule asks first.
 */
const HOOK_REFRESH_RAILS: ReadonlySet<string> = new Set([GIT_CONTROL_FILE_RULE_ID, STARTUP_PATH_RULE_ID]);

/**
 * An escape the operator would decide on must say why, so the card has something to weigh (D9): the refusal of
 * one whose tool declares `unsandboxed_reason` and that left it out, else null.
 */
function unstatedEscapeVerdict(
	call: ClassifierCall,
	spec: ToolSpec,
	admission: AdmissionDisposition,
): Extract<RegistryVerdict, { kind: "blocked" }> | null {
	if (admission.kind !== "ask" || !asksToLeaveSandbox(admission.decision)) return null;
	const properties = (spec.parameters as { properties?: Record<string, unknown> }).properties;
	if (properties === undefined || !Object.hasOwn(properties, UNSANDBOXED_REASON_ARG)) return null;
	const unstated = missingUnsandboxedReason(call.tool, call.args);
	if (unstated === null) return null;
	return blockedVerdict(admission.decision, `${call.tool} blocked: unsandboxed without a reason`, unstated, {
		kind: "block",
		reasonCode: UNSANDBOXED_REASON_REQUIRED_CODE,
	});
}

/**
 * A call reaching execution without the main-session sandbox. A job command admitted only contained is refused
 * (true). Otherwise a main-session bash or run_script call journals that the session's shell ran uncontained, once per
 * reason, so no record of the session reads as contained by omission.
 */
function refusesUncontainedLaunch(
	deps: RegistryDeps,
	spec: ToolSpec,
	options: ToolInvokeOptions,
	jobNeedsContainment: () => boolean,
): boolean {
	if (options.shellSandbox !== undefined) return false;
	if (jobNeedsContainment()) return true;
	if ((deps.principal ?? "main") !== "main") return false;
	if (spec.name !== ToolNames.Bash && spec.name !== ToolNames.RunScript) return false;
	if (deps.sandboxState === undefined || deps.containment === undefined) return false;
	const readOnly = deps.readOnly === true || options.turnConstraints?.readOnly === true;
	const hasBackend = readOnly ? deps.containment().readOnlySandbox === true : deps.containment().sandbox;
	const state = deps.sandboxState();
	const why: SandboxLaunchWhy =
		state.mode === "off"
			? "sandbox-off"
			: !hasBackend
				? "no-backend"
				: !readOnly && (deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) === "yolo"
					? "unconfined-opt-in"
					: "operator-authority";
	recordUncontainedShell({
		caller: readOnly ? "main-read-only" : "main",
		why,
		mode: state.mode,
		backend: state.backend,
	});
	return false;
}
export function createRegistry(deps: RegistryDeps): ToolRegistry {
	const tools = new Map<ToolName, ToolSpec>();
	/**
	 * The before_tool effects of a call a hook parked for approval, keyed by the
	 * options object the registry made for its park or its approved run, so the
	 * call runs on what its hooks decided without running them again. Private:
	 * no caller-built options object can be in it.
	 */
	const hookSettled = new WeakMap<ToolInvokeOptions, ReadonlyArray<MiddlewareEffect>>();
	const parked: ParkedCall[] = [];
	const permissionListeners = new Set<
		(call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void
	>();
	const askQueue: OperatorAskQueue = {
		parked,
		cardsRendered: () => permissionListeners.size > 0,
		nextRequestId: () => nextApprovalRequestId(),
		cancel: (requestId, reason) => cancelParkedCallById(requestId, reason),
		record: (call, decision, disposition, overrides) => recordRegistryDisposition(call, decision, disposition, overrides),
		notify: (call, decision, meta) => notifyPermissionRequired(call, decision, meta),
	};
	const shellEgress = createShellEgress(deps, askQueue);
	const admissionReviewListeners = new Set<(event: AdmissionReviewEvent) => void>();
	const bodyStartListeners = new Set<(toolCallId: string) => void>();
	const notifyBodyStart = (options: ToolInvokeOptions | undefined): void => {
		const toolCallId = options?.toolCallId;
		if (toolCallId === undefined || toolCallId.length === 0) return;
		for (const listener of bodyStartListeners) {
			try {
				listener(toolCallId);
			} catch {
				// A status listener's failure never stops the call.
			}
		}
	};
	const boundaryReminderListeners = new Set<
		(reminders: ReadonlyArray<ToolBoundaryReminder>, input: MiddlewareHookInput) => void
	>();
	let approvalRequestCounter = 0;
	const approvalRequestToken = randomBytes(4).toString("hex");
	const reg: RegistryScope = {
		deps,
		tools,
		hookSettled,
		parked,
		permissionListeners,
		askQueue,
		shellEgress,
		admissionReviewListeners,
		bodyStartListeners,
		boundaryReminderListeners,

		get operatorYoloScope() {
			return operatorYoloScope;
		},
		get withOperatorScope() {
			return withOperatorScope;
		},
		get hostEffectScope() {
			return hostEffectScope;
		},
		get admitHostEffect() {
			return admitHostEffect;
		},
		get containedEffectsSandbox() {
			return containedEffectsSandbox;
		},
		get jobNeedsContainment() {
			return jobNeedsContainment;
		},
		get shellSandboxPolicy() {
			return shellSandboxPolicy;
		},
		get trueYolo() {
			return trueYolo;
		},

		get outboundFlowViolation() {
			return outboundFlowViolation;
		},
		get fileTargetFlowViolation() {
			return fileTargetFlowViolation;
		},
		get sourceAdmissionRefusal() {
			return sourceAdmissionRefusal;
		},

		get snapshotBeforeBody() {
			return snapshotBeforeBody;
		},

		get recordRegistryDisposition() {
			return recordRegistryDisposition;
		},
		get observeBlockedAttempt() {
			return observeBlockedAttempt;
		},
		get observeRejectedAttempt() {
			return observeRejectedAttempt;
		},
		get guardOverrideForRejectedAttempt() {
			return guardOverrideForRejectedAttempt;
		},
		get guardBlocked() {
			return guardBlocked;
		},
		get runToolHook() {
			return runToolHook;
		},
	};
	const {
		operatorYoloScope,
		withOperatorScope,
		hostEffectScope,
		admitHostEffect,
		containedEffectsSandbox,
		jobNeedsContainment,
		shellSandboxPolicy,
		trueYolo,
	} = createOperatorScopes(reg);

	/** The rail that named the parked call, when the decision carried one. */
	const approvalRailOf = (decision: SafetyDecision): string | undefined => {
		if (decision.kind === "allow") return decision.policy?.ruleId;
		return decision.match?.ruleId ?? decision.policy?.ruleId;
	};

	const { outboundFlowViolation, fileTargetFlowViolation, sourceAdmissionRefusal } = createFlowGates(reg);

	const { snapshotBeforeBody } = createSnapshotGate(reg);

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		let resultDisposition = spec.metadata?.resultDisposition;
		// Admission prepared these arguments; a rewrite never takes over their cleanup.
		const admittedArgs = call.args ?? {};
		// An admitted rewrite carries its own prepared arguments, released alongside.
		let rewrittenArgs: Record<string, unknown> | undefined;
		/** When the body started, so an awaited after_tool hook learns how long it ran. */
		let bodyStartedAt: number | undefined;
		let execution: ExecutionProvenance = {};
		// Set when a hook's approval request handed the call to the ask route, which then owns its arguments.
		let handedOff = false;
		const bodyMs = (): number => (bodyStartedAt === undefined ? 0 : Math.round(performance.now() - bodyStartedAt));
		// Resolved once per admitted call, so the before_tool hook, the body and
		// the after_tool hook all mean the same landing (undefined: not yet resolved).
		let landing: ToolCallLanding | null | undefined;
		// A flow refusal records the decision it re-shapes, then settles as blocked.
		const flowBlocked = (reason: string): RegistryVerdict => {
			recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE });
			return { ...flowBlockedVerdict(decision, call.tool, reason), ...execution };
		};
		const withheld = (restrictions: FlowRestrictionSet | null, what: string): RegistryVerdict | null => {
			if (restrictions === null) return null;
			deps.flow?.absorb(restrictions, {
				tool: spec.name,
				...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
			});
			// A label that did not reach the ledger must not be outlived by the
			// content it labels: the transcript would then hold the bytes
			// without the restriction across a restart. The content is withheld
			// and the queued label is retried on the next ledger access.
			const unlabeled = deps.flow?.refusal() ?? null;
			return unlabeled === null ? null : flowBlocked(`${spec.name} ${what} withheld: ${unlabeled}`);
		};
		// Extension runtime after_tool hooks are awaited only when one matches this tool.
		const afterEffects = (
			result: ToolResult,
			digest: ToolResultDigest,
		): ReadonlyArray<MiddlewareEffect> | Promise<ReadonlyArray<MiddlewareEffect>> => {
			const syncAfter = runToolHook("after_tool", spec, call, decision, options, result, digest);
			if (!deps.middleware?.hasAwaitedHook?.("after_tool", spec.name)) return syncAfter;
			const awaited = runAwaitedToolHook(
				"after_tool",
				spec,
				call,
				decision,
				options,
				landing === undefined ? hookLanding(spec, call) : landing,
				syncAfter,
				result,
				digest,
				bodyMs(),
			);
			return awaited.then((effects) => [...syncAfter, ...effects]);
		};
		try {
			// Explicit information-flow violations are final at every autonomy
			// level, including yolo, and are decided before any hook can run the
			// body. Permitted here grants nothing: admission already ran. A policy
			// that cannot label sources refuses the source tools outright.
			// Yolo admits the transfer as well (#407); the source's label is still
			// absorbed below, so the session keeps the record of what it carried.
			const flowViolation = trueYolo() ? null : (sourceAdmissionRefusal(spec, call) ?? outboundFlowViolation(spec, call));
			if (flowViolation !== null) return flowBlocked(flowViolation);
			// A call a hook parked for approval already passed its hook stage; it runs on that stage's effects.
			const settled = options !== undefined ? hookSettled.get(options) : undefined;
			// The hook layer is the only control stage past safety admission. Guards
			// (loop, protected artifacts, dispatch dedup) are before_tool
			// registrations; the first block_tool effect decides the verdict. Keep
			// this gate inside the admission cleanup boundary: dispatch may already
			// own a provisional reservation by the time a guard blocks execution.
			let beforeEffects = settled ?? runToolHook("before_tool", spec, call, decision, options);
			let block = settled !== undefined ? null : firstBlockToolEffect(beforeEffects);
			// Extension runtime hooks are awaited only when one matches this tool,
			// so a call nothing gates takes no extra turn of the event loop.
			if (settled === undefined && !block && deps.middleware?.hasAwaitedHook?.("before_tool", spec.name)) {
				landing = hookLanding(spec, call);
				const awaited = await runAwaitedToolHook("before_tool", spec, call, decision, options, landing, beforeEffects);
				beforeEffects = [...beforeEffects, ...awaited];
				block = firstBlockToolEffect(awaited);
				const rewrite = block ? undefined : awaited.find((effect) => effect.kind === "rewrite_tool_input");
				if (rewrite?.kind === "rewrite_tool_input") {
					const rewritten = admitRewrite(spec, call, rewrite, options);
					const carried = "carriedApproval" in rewritten ? rewritten.carriedApproval : undefined;
					if ("refusal" in rewritten) block = { kind: "block_tool", reason: rewritten.refusal, severity: "hard-block" };
					else {
						rewrittenArgs = rewritten.admitted.args ?? {};
						const judged = await judgeRewrite(spec, call, rewritten, rewrite.source, options, beforeEffects);
						block = judged.block;
						if (block === null) {
							if (judged.landing !== undefined) landing = judged.landing;
							// The prepared rewrite runs, so the body and after_tool see what the
							// hooks judged and dispatch does not prepare it a second time.
							call = rewritten.admitted;
							decision = rewritten.decision;
							if (carried !== undefined && options?.approval !== undefined)
								options = { ...options, approval: { ...options.approval, carriedOver: carried } };
							beforeEffects = [
								...beforeEffects,
								{
									kind: "annotate_tool_result",
									message: `${spec.name} input rewritten by extension ${rewrite.source}: ${rewrite.reason}${carried !== undefined && options?.approval !== undefined ? `; ${approvalGiver(options.approval.requestedBy)} carried over because the rewrite only narrows the approved call` : ""}`,
									severity: "info",
								},
							];
						}
					}
				}
			}
			if (block) {
				const verdict = guardBlocked(call, decision, block.reason, guardRuleIds.get(block));
				return block.redundantRepeat === true ? { ...verdict, redundantRepeat: true } : verdict;
			}
			// A hook asked the operator. A call that carries an approval already has
			// one; any other takes the route every ask takes (judge, refusals, card)
			// and, once released, runs on these effects.
			const approvalAsk =
				settled === undefined && options?.approval === undefined
					? beforeEffects.find((effect) => effect.kind === "request_approval")
					: undefined;
			if (approvalAsk?.kind === "request_approval") {
				if (rewrittenArgs !== undefined)
					return guardBlocked(
						call,
						decision,
						`${spec.name} did not run: a hook asked for approval of a call an extension rewrote, and a rewritten call is not parked for approval (${approvalAsk.reason})`,
					);
				handedOff = true;
				const parkOptions: ToolInvokeOptions = { ...(options ?? {}) };
				hookSettled.set(parkOptions, beforeEffects);
				return await routeAsk(
					call,
					call,
					hookApprovalOutcome(call, decision, approvalAsk.reason),
					parkOptions,
					beforeEffects,
				);
			}
			// Recoverability point: admission allowed the call and no hook blocked it,
			// so a snapshot here precedes exactly the bodies that will run.
			const snapshot = await snapshotBeforeBody(spec, call, decision, options);
			if (snapshot.missing !== null && decision.policy?.recoverable === true) {
				const reason = `${spec.name} did not run: it was admitted without approval because a workspace snapshot would undo it, and no complete snapshot could be taken (${snapshot.missing}). Take a route that discards nothing, or record the open decision for the operator.`;
				const verdict = blockedVerdict(decision, `${call.tool} blocked: no workspace snapshot`, reason, {
					kind: "block",
					reasonCode: SNAPSHOT_REQUIRED_REASON_CODE,
				});
				recordRegistryDisposition(call, verdict.decision, "blocked", {
					reasonCode: SNAPSHOT_REQUIRED_REASON_CODE,
				});
				return verdict;
			}
			if (snapshot.note !== null) beforeEffects = [...beforeEffects, snapshot.note];
			try {
				const preparedArgs = prepareToolArgs(spec, call.args ?? {});
				resultDisposition = resolveToolResultDisposition(spec, preparedArgs);
				const {
					allowsObservationPath: _callerPathFilter,
					writeTargetViolation: _callerWriteCheck,
					gitContext: _callerGitContext,
					flowAdmitsUrl: _callerFlowAdmitsUrl,
					flowAdmitsFileTarget: _callerFlowAdmitsFileTarget,
					hookLanding: _callerHookLanding,
					operatorYolo: _callerOperatorYolo,
					shellSandbox: _callerShellSandbox,
					...callerOptions
				} = options ?? {};
				const allowsObservationPath = deps.safety.policy?.allowsObservationPath;
				const writeTargetViolation =
					spec.name === ToolNames.Artifact
						? (deps.safety.policy?.artifactTargetViolation ?? deps.safety.policy?.writeTargetViolation)
						: deps.safety.policy?.writeTargetViolation;
				// What this result will carry, decided from the path or tool name
				// before the body runs, so a link swapped in afterwards cannot
				// unlabel it and so the label exists before any screening.
				const ruleRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				if (landing === undefined && deps.middleware?.hasAwaitedHook?.("after_tool", spec.name))
					landing = hookLanding(spec, call);
				const executionOptions: ToolInvokeOptions = {
					...callerOptions,
					...(allowsObservationPath ? { allowsObservationPath } : {}),
					...(writeTargetViolation ? { writeTargetViolation } : {}),
					...(deps.principal === "worker" && deps.git !== undefined ? { gitContext: deps.git } : {}),
					...(operatorYoloScope(deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== undefined &&
					deps.readOnly !== true &&
					options?.turnConstraints?.readOnly !== true
						? { operatorYolo: true as const }
						: {}),
					...(decision.policy?.shellSandbox !== undefined
						? { shellSandbox: shellSandboxPolicy(decision.policy.shellSandbox, options) }
						: {}),
					...(landing !== undefined && landing !== null ? { hookLanding: landing } : {}),
					...(deps.flow !== undefined && !trueYolo()
						? {
								flowAdmitsUrl: (url: string) => outboundFlowViolation(spec, { tool: spec.name, args: { url } }),
								flowAdmitsFileTarget: (url: string) => fileTargetFlowViolation(spec, call, url),
							}
						: {}),
				};
				// Fail closed: a job command admitted only contained never runs without its sandbox (XR-12).
				if (refusesUncontainedLaunch(deps, spec, executionOptions, () => jobNeedsContainment(spec, call))) {
					const reason = `${spec.name} did not run: its command is admitted only in the sandbox, and the call reached execution without the sandbox policy.`;
					const verdict = blockedVerdict(decision, `${call.tool} blocked: contained command without its sandbox`, reason, {
						kind: "block",
						reasonCode: "host_effect_not_admitted",
					});
					recordRegistryDisposition(call, verdict.decision, "blocked", { reasonCode: "host_effect_not_admitted" });
					return verdict;
				}
				bodyStartedAt = performance.now();
				execution = { executionStarted: true };
				notifyBodyStart(options);
				const result = await spec.run(preparedArgs, executionOptions);
				if (WORKSPACE_WRITING_TOOLS.has(spec.name)) invalidateWorkspaceSecretScans();
				// A body that delegated to a nested invocation the registry refused
				// (the gateway calling a denied capability) hands the refusal back
				// whole, and this call settles as that same blocked verdict: the
				// model, telemetry, and the ledger then see exactly what a direct
				// call to the capability would have produced.
				const nestedBlocked = nestedBlockedVerdict(result);
				const nested = nestedExecutions.get(result);
				if (nestedBlocked !== null) execution = recordedExecution(nestedBlocked);
				else if (nested !== undefined) {
					decision = nested.decision;
					execution = nested.execution;
				} else execution = nestedChainResults.get(result) ?? execution;
				// A trusted body (dispatch, monitor) labels what it carried back from
				// a worker's context; that label joins the source rule's own.
				const reportedRestrictions = result.details?.[FLOW_RESTRICTIONS_DETAIL];
				const sourceRestrictions = mergeFlowRestrictions(
					ruleRestrictions,
					isFlowRestrictionSet(reportedRestrictions) ? reportedRestrictions : null,
				);
				// The restriction enters the ledger before the result goes anywhere:
				// not to the screening classifier, not to the hooks, not to the model.
				// An error can quote the source, so it is labeled and absorbed too.
				const resultWithheld = withheld(sourceRestrictions, "result");
				if (resultWithheld !== null) {
					// Nothing of the result reaches the model, so the turn pool pays for none of it (C-17).
					settleObservationCharge(result, 0);
					return resultWithheld;
				}
				// A refusal settles only after its label is absorbed: an MCP server's
				// refusal quotes the server's own text, which the source rule labels
				// exactly as it would label a result.
				if (nestedBlocked !== null) return nestedBlocked;
				const labeled = withFlowRestrictions(result, sourceRestrictions);
				const after = afterEffects(labeled, toolResultDigestFor(spec, labeled, resultDisposition, options));
				const finalResult = shapeToolResult(
					spec,
					applyToolResultEffects(
						labeled,
						[...beforeEffects, ...(after instanceof Promise ? await after : after)],
						labeled !== result,
						nestedExecutions.has(result) ? "call" : nestedChainResults.has(result) ? "chain" : null,
					),
					options,
					resultDisposition,
				);
				// The turn pool pays for what the model receives once shaping has cut the result (C-17).
				settleObservationCharge(finalResult);
				return { kind: "ok", result: finalResult, decision, ...execution };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A body that threw may have read the source before failing, so
				// its message carries the same label as a result would.
				const thrownRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				const errorWithheld = withheld(thrownRestrictions, "error");
				if (errorWithheld !== null) return errorWithheld;
				const result: ToolResult = withFlowRestrictions({ kind: "error", message }, thrownRestrictions);
				const after = afterEffects(result, toolResultDigestFor(spec, result, resultDisposition, options));
				return {
					kind: "ok",
					result: shapeToolResult(
						spec,
						applyToolResultEffects(result, [...beforeEffects, ...(after instanceof Promise ? await after : after)]),
						options,
						resultDisposition,
					),
					decision,
					...execution,
				};
			}
		} finally {
			// A call handed to the ask route keeps its prepared arguments: its refusal or its approved run releases them.
			if (!handedOff) {
				disposeAdmissionArgs(spec, admittedArgs);
				if (rewrittenArgs !== undefined && rewrittenArgs !== admittedArgs) disposeAdmissionArgs(spec, rewrittenArgs);
			}
		}
	};

	/** The ask a before_tool hook's `request_approval` parks: the call's own classification, the hook's reason. */
	const hookApprovalOutcome = (
		call: ClassifierCall,
		decision: SafetyDecision,
		reason: string,
	): Extract<AdmitOutcome, { kind: "park" }> => {
		const rejection = {
			short: `${call.tool} needs approval: a hook asked (${reason})`,
			detail: `A before_tool hook asked for the operator's approval before this ${call.tool} call runs: ${reason}`,
			hints: ["Approve to run the call once.", "Deny to refuse it back to the model."],
		};
		// The ask names its own rail, not the rule that admitted the call.
		const ask: SafetyDecision = {
			kind: "ask",
			classification: decision.classification,
			rejection,
			...(decision.policy !== undefined
				? {
						policy: {
							...decision.policy,
							kind: "ask" as const,
							ruleId: HOOK_APPROVAL_RULE_ID,
							reasonCode: HOOK_APPROVAL_RULE_ID,
							reasons: [rejection.short],
							rejection,
						},
					}
				: {}),
		};
		return {
			kind: "park",
			decision: ask,
			axis: approvalAxisId(ask, deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL),
			// A worker's ordinary ask carries main authority, as admission gives it.
			approvalAuthority: deps.principal === "worker" ? "main" : "operator",
			source: "hook",
		};
	};

	/** The hook input with what the session carries and the effective tool's declared metadata. */
	const hookInput = (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		result: ToolResult | undefined,
		resultDigest: ToolResultDigest | undefined,
	): MiddlewareHookInput =>
		buildToolHookInput(
			hook,
			spec,
			call,
			decision,
			options,
			result,
			resultDigest,
			deps.flow?.carried() ?? null,
			tools.get(effectiveToolCall(call.tool, call.args).toolName as ToolName)?.metadata,
		);

	const runToolHook = (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		result?: ToolResult,
		resultDigest?: ToolResultDigest,
	): ReadonlyArray<MiddlewareEffect> => {
		if (!deps.middleware) return [];
		const input = hookInput(hook, spec, call, decision, options, result, resultDigest);
		const startedAt = performance.now();
		const ran = deps.middleware.runHook(input);
		const effects = noteGuardRule(ran);
		options?.onHookTime?.(performance.now() - startedAt);
		try {
			deps.onMiddlewareEffects?.(effects, input);
		} catch {
			// A provider-routing sink is advisory to this call. It may narrow the
			// next request, but it must never throw through tool admission.
		}
		if (hook === "after_tool" && boundaryReminderListeners.size > 0) passBoundaryReminders(ran, input);
		return effects;
	};

	/**
	 * An `inject_reminder` a synchronous after_tool registration emits is no annotation, so this call's result does
	 * not carry it. It passes through to the session that owns the run, which delivers it at the tool-batch boundary
	 * (exploration design 3.3, X6). Each reminder names the rule that emitted it.
	 */
	const passBoundaryReminders = (ran: MiddlewareHookResult, input: MiddlewareHookInput): void => {
		const reminders: ToolBoundaryReminder[] = [];
		let offset = 0;
		for (const rule of ran.fired ?? []) {
			for (const effect of ran.effects.slice(offset, offset + rule.effects.length)) {
				if (effect.kind !== "inject_reminder") continue;
				reminders.push({
					message: effect.message,
					ruleId: rule.ruleId,
					...(effect.severity !== undefined ? { severity: effect.severity } : {}),
					...(effect.audience !== undefined ? { audience: effect.audience } : {}),
				});
			}
			offset += rule.effects.length;
		}
		if (reminders.length === 0) return;
		for (const listener of boundaryReminderListeners) {
			try {
				listener(reminders, input);
			} catch {
				// Delivery is the session's; its failure never changes this call.
			}
		}
	};

	/**
	 * An extension may rewrite a call's input only into one that passes the
	 * tool's schema and is admitted again without a new decision: a rewrite
	 * that would need approval, or that safety refuses, refuses the call. The
	 * original arguments keep their own admission cleanup; a refused rewrite's
	 * prepared arguments are released here, an admitted one's by runSpec.
	 */
	const admitRewrite = (
		spec: ToolSpec,
		call: ClassifierCall,
		rewrite: Extract<MiddlewareEffect, { kind: "rewrite_tool_input" }>,
		options: ToolInvokeOptions | undefined,
	): { admitted: ClassifierCall; decision: SafetyDecision; carriedApproval?: ApprovalCarry } | { refusal: string } => {
		if (!Value.Check(spec.parameters, rewrite.args))
			return { refusal: `extension ${rewrite.source} rewrote ${spec.name} input that does not match its schema` };
		const next: ClassifierCall = { ...call, args: rewrite.args };
		const admitted = prepareAdmissionCall(spec, next);
		// An operator-approved call keeps its approval only across a rewrite the
		// tool proves narrows it (WX2), such as a desk confining each dispatched
		// worker. The grant satisfies only the ask; every refusal still applies.
		const approval = options?.approval;
		const carried =
			approval !== undefined && spec.rewriteNarrows?.(call.args ?? {}, admitted.args ?? {}) === true
				? {
						actionClass: approval.actionClass,
						requestedBy: approval.requestedBy,
						...(approval.issuer !== undefined ? { issuer: approval.issuer } : {}),
					}
				: undefined;
		const outcome = admit(admitted, carried, options);
		if (outcome.kind === "execute")
			return carried === undefined
				? { admitted, decision: outcome.decision }
				: {
						admitted,
						decision: outcome.decision,
						carriedApproval: {
							extension: rewrite.source,
							...approvedPlanHash(spec, call),
						},
					};
		if (admitted.args !== next.args) disposeAdmissionArgs(spec, admitted.args ?? {});
		const why =
			outcome.kind === "park"
				? "would need operator approval"
				: outcome.verdict.kind === "blocked"
					? outcome.verdict.reason
					: "is not admitted";
		return { refusal: `extension ${rewrite.source} rewrote ${spec.name} input into a call that ${why}` };
	};

	/** The plan hash the approver was shown, read from the approved call's trusted plan view. */
	const approvedPlanHash = (spec: ToolSpec, call: ClassifierCall): { approvedPlanHash?: string } => {
		const hash = spec.describeDispatchPlan?.(call.args ?? {}).hash;
		return hash !== undefined ? { approvedPlanHash: hash } : {};
	};

	/**
	 * The guards and extension gates judged the arguments the model sent, and a
	 * rewrite changes what runs. The call that would run goes through the same
	 * chain, so a rewrite cannot reach what a guard would have refused (a
	 * protected path, a repeat). A rewrite that restates the arguments is not
	 * judged twice, which keeps one call from being counted twice. A rewrite
	 * returned by this second awaited pass is not applied, so rewrites do not chain.
	 */
	const judgeRewrite = async (
		spec: ToolSpec,
		original: ClassifierCall,
		rewritten: { admitted: ClassifierCall; decision: SafetyDecision },
		source: string,
		options: ToolInvokeOptions | undefined,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
	): Promise<{ block: Extract<MiddlewareEffect, { kind: "block_tool" }> | null; landing?: ToolCallLanding | null }> => {
		if (isDeepStrictEqual(original.args ?? {}, rewritten.admitted.args ?? {})) return { block: null };
		const sync = runToolHook("before_tool", spec, rewritten.admitted, rewritten.decision, options);
		let block = firstBlockToolEffect(sync);
		let landing: ToolCallLanding | null | undefined;
		if (!block && deps.middleware?.hasAwaitedHook?.("before_tool", spec.name)) {
			landing = hookLanding(spec, rewritten.admitted);
			const awaited = await runAwaitedToolHook(
				"before_tool",
				spec,
				rewritten.admitted,
				rewritten.decision,
				options,
				landing,
				[...priorEffects, ...sync],
			);
			block = firstBlockToolEffect(awaited);
		}
		if (block === null) return landing === undefined ? { block: null } : { block: null, landing };
		return {
			block: {
				kind: "block_tool",
				reason: `extension ${source} rewrote ${spec.name} input into a call that is blocked: ${block.reason}`,
				severity: "hard-block",
			},
		};
	};

	/**
	 * The awaited phase for extension runtime hooks. Its effects follow the
	 * synchronous ones and pass through the same sinks; a failure here is the
	 * hook's own policy, decided inside the registration, never a throw.
	 */
	const runAwaitedToolHook = async (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		landing: ToolCallLanding | null,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
		result?: ToolResult,
		resultDigest?: ToolResultDigest,
		durationMs?: number,
	): Promise<ReadonlyArray<MiddlewareEffect>> => {
		if (!deps.middleware?.runAwaitedHook) return [];
		const built = hookInput(hook, spec, call, decision, options, result, resultDigest);
		const input = {
			...built,
			...(durationMs === undefined ? {} : { metadata: { ...built.metadata, durationMs } }),
			...(landing === null ? {} : { toolLanding: landing }),
		};
		let effects: ReadonlyArray<MiddlewareEffect>;
		const startedAt = performance.now();
		try {
			effects = noteGuardRule(await deps.middleware.runAwaitedHook(input, priorEffects));
		} catch {
			// Registrations isolate their own failures; anything escaping is a runtime bug and changes no call.
			return [];
		} finally {
			options?.onHookTime?.(performance.now() - startedAt);
		}
		try {
			deps.onMiddlewareEffects?.(effects, input);
		} catch {
			// Advisory sink, as in the synchronous phase.
		}
		if (!deps.absorbAwaitedEffects) return effects;
		try {
			const refusal = deps.absorbAwaitedEffects(effects, input);
			return refusal === null ? effects : [...effects, { kind: "block_tool", reason: refusal, severity: "hard-block" }];
		} catch (err) {
			// A protection that cannot be recorded must not let the call through.
			return hook === "before_tool"
				? [
						...effects,
						{
							kind: "block_tool",
							reason: `protected artifact state could not be updated: ${err instanceof Error ? err.message : String(err)}`,
							severity: "hard-block",
						},
					]
				: effects;
		}
	};

	type AdmitOutcome =
		| { kind: "terminal"; verdict: RegistryVerdict }
		| { kind: "execute"; spec: ToolSpec; decision: SafetyDecision }
		| {
				kind: "park";
				decision: SafetyDecision;
				axis: string;
				approvalAuthority: ApprovalAuthority;
				dispatchPlan?: DispatchPlanView;
				/** Which admission step asked, for the safety judge's operator-only check. */
				source?: AdmissionAskSource;
				/** A plan-scale dispatch, whose body runs only under an operator approval or yolo. */
				planScale?: true;
				/** The hook drift a `git-hooks-changed` ask names; an operator's allow accepts it. */
				hookDrift?: GitHookDriftReport;
		  };

	/** The session's test-runner consent ask, the only obstacle among a call's host effects. */
	type SessionConsentObstacle = { kind: "session-consent"; label: string; decision: SafetyDecision };

	/**
	 * The shared evaluator's disposition of one registered call, with what admit needs beside it. Pure apart from the
	 * policy engine's own audit side effects: it records no disposition and runs nothing.
	 */
	const evaluateCallAdmission = (
		call: ClassifierCall,
		spec: ToolSpec,
		grant: OneShotGrant | undefined,
		options: ToolInvokeOptions | undefined,
	): {
		admission: AdmissionDisposition;
		level: AutonomyLevel;
		dispatchPlan: DispatchPlanView | null;
		planScale: boolean;
	} => {
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const projectedCall = spec.safetyCall?.(call.args ?? {});
		// Plan-scale dispatch calls (multi-task, compete, remote node) carry the
		// plan flag so default routes them through one plan approval.
		const dispatchPlan =
			call.tool === ToolNames.Dispatch
				? (spec.describeDispatchPlan?.(call.args ?? {}) ?? describeDispatchPlan(call.args))
				: null;
		const planScale = dispatchPlan?.planScale === true;
		const confirmation = spec.confirmationFor?.(
			call.args ?? {},
			options?.sessionId !== undefined ? { sessionId: options.sessionId } : {},
		);
		// The shared evaluator decides; this adapter only parks, audits and runs.
		// The SDK bridge and the ACP mediator call the same function.
		const admission = evaluateAdmission({
			principal: deps.principal ?? "main",
			// Both the public capability and its underlying effects must pass. A
			// trusted projection cannot bypass a rule targeting the capability's own name.
			...(projectedCall !== undefined ? { capability: call, effects: [projectedCall] } : { effects: [call] }),
			safety: deps.safety,
			autonomy: level,
			...withOperatorScope(level, deps.readOnly === true || options?.turnConstraints?.readOnly === true),
			...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
			...(deps.principal === "worker" && deps.readOnlyShellConfined?.() === true ? { readOnlyShellConfined: true } : {}),
			constraints: {
				...(deps.readOnly === true ? { readOnly: true } : {}),
				...(options?.turnConstraints !== undefined ? { turnConstraints: options.turnConstraints } : {}),
				...(options?.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
				...(options?.pendingSkillPolicy !== undefined ? { pendingSkillPolicy: options.pendingSkillPolicy } : {}),
			},
			...(confirmation !== undefined
				? {
						confirmationRuleId: confirmation.ruleId,
						confirmationText: { detail: confirmation.detail, hints: confirmation.hints },
					}
				: spec.confirmationRuleId !== undefined
					? { confirmationRuleId: spec.confirmationRuleId }
					: {}),
			...(grant !== undefined
				? { authorization: { actionClass: grant.actionClass, issuer: grant.issuer ?? "operator" } }
				: {}),
			normalize: (decision) =>
				applyRegisteredToolClassification(
					decision,
					spec,
					deps.readOnly === true || options?.turnConstraints?.readOnly === true,
					call.args ?? {},
				),
			...(deps.git !== undefined ? { git: deps.git } : {}),
			autonomyExtra: {
				// The plan stop only waits for the operator, so the operator's contained
				// yolo runs a plan as unconfined yolo does. Its workers still meet their
				// own permits, routes and sandbox.
				// A sealed plan whose every task is a read-only run on this machine does not stop either (maintainer
				// 2026-11-21 13:40Z, `isReadOnlyPlan`): there is nothing in it for an operator to refuse that the
				// workers' own permits do not already hold, and a headless default run could otherwise never fan out.
				...(planScale &&
				dispatchPlan?.readOnlyPlan !== true &&
				!(deps.principal !== "worker" && deps.unattendedAsks?.() === true)
					? { dispatchPlanScale: true }
					: {}),
			},
			...(deps.sessionCodeConsent?.pending() === true ? { sessionCodeConsentPending: true } : {}),
			...(deps.hookDrift !== undefined && (deps.principal ?? "main") === "main" ? { hookDrift: deps.hookDrift } : {}),
		});
		return { admission, level, dispatchPlan, planScale };
	};

	const admit = (call: ClassifierCall, grant?: OneShotGrant, options?: ToolInvokeOptions): AdmitOutcome => {
		const spec = tools.get(call.tool as ToolName);
		if (!spec) {
			return { kind: "terminal", verdict: { kind: "not_visible", reason: `tool not registered: ${call.tool}` } };
		}
		const { admission, level, dispatchPlan, planScale } = evaluateCallAdmission(call, spec, grant, options);
		if (admission.kind === "deny" && admission.code === "safety_net") {
			recordRegistryDisposition(call, admission.decision, "blocked");
			const policy = admission.decision.policy;
			const allowedBy =
				policy?.policySource === "project-policy"
					? `the project's safety policy${policy.ruleId !== undefined ? ` rule ${policy.ruleId}` : ""} must change, which only the operator can do.`
					: policy?.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX) === true
						? "nothing within this run; it is the yolo floor, which holds at every autonomy level."
						: "nothing within this run; it is a hard block of PanCode's safety net.";
			return {
				kind: "terminal",
				verdict: withDenial(
					{ kind: "blocked", reason: admission.reason, decision: admission.decision },
					"pancode_policy",
					allowedBy,
					policy?.ruleId ?? policy?.reasonCode,
					policy?.floorBasis,
				),
			};
		}
		const unstated = unstatedEscapeVerdict(call, spec, admission);
		if (unstated !== null) {
			recordRegistryDisposition(call, unstated.decision, "blocked", { reasonCode: UNSANDBOXED_REASON_REQUIRED_CODE });
			const allowedBy = `the same call with ${UNSANDBOXED_REASON_ARG} set; the operator then decides on an approval card.`;
			return {
				kind: "terminal",
				verdict: withDenial(unstated, "pancode_policy", allowedBy, UNSANDBOXED_REASON_REQUIRED_CODE),
			};
		}
		const hostEffects = admitHostEffects(call, spec, admission, level);
		const effectOutcome = hostEffects.obstacle;
		if (effectOutcome?.kind === "terminal") return effectOutcome;
		// Commands admitted only contained carry their sandbox on the decision of the call that runs them (XR-12).
		const contained = hostEffects.contained;
		const contain = (decision: SafetyDecision): SafetyDecision =>
			contained === null || decision.policy === undefined
				? decision
				: { ...decision, policy: { ...decision.policy, shellSandbox: contained } };
		if (admission.kind === "deny")
			return { kind: "terminal", verdict: deniedVerdict(call, admission, options?.turnConstraints) };
		if (admission.kind === "allow") {
			if (effectOutcome !== null) {
				const decision = contain(sessionConsentParkDecision(call, admission.decision, effectOutcome, dispatchPlan));
				return {
					kind: "park",
					decision,
					axis: approvalAxisId(decision, level),
					approvalAuthority: "operator",
					source: "session-consent",
				};
			}
			const allowed = contain(admission.decision);
			recordRegistryDisposition(call, allowed, "allowed");
			return { kind: "execute", spec, decision: allowed };
		}
		const askDecision = contain(
			admission.source === "autonomy" && planScale && dispatchPlan !== null
				? toDispatchPlanAskDecision(admission.netDecision, level, dispatchPlan)
				: admission.decision,
		);
		if (effectOutcome !== null) {
			// One combined ask: approving the call's own autonomy ask also gives the
			// consent its checks need, so the operator is never asked twice (#377
			// follow-up).
			const decision = contain(sessionConsentParkDecision(call, askDecision, effectOutcome, dispatchPlan));
			return {
				kind: "park",
				decision,
				axis: approvalAxisId(decision, level),
				approvalAuthority: "operator",
				...(dispatchPlan !== null ? { dispatchPlan } : {}),
				source: "session-consent",
				...(planScale ? { planScale: true as const } : {}),
			};
		}
		return {
			kind: "park",
			decision: askDecision,
			axis: approvalAxisId(askDecision, level),
			approvalAuthority: admission.approvalAuthority,
			...(admission.source === "autonomy" && dispatchPlan !== null ? { dispatchPlan } : {}),
			source: admission.source,
			...(planScale ? { planScale: true as const } : {}),
			...(admission.hookDrift !== undefined ? { hookDrift: admission.hookDrift } : {}),
		};
	};

	/**
	 * Attach the structured account of a refusal. Worker registries leave it
	 * off: a worker's refusals already end in the typed permission_required
	 * contract (`src/engine/worker-refusals.ts`), which counts every ask.
	 */
	const withDenial = (
		verdict: Extract<RegistryVerdict, { kind: "blocked" }>,
		layer: DenialLayer,
		allowedBy: string,
		code?: string,
		basis?: string,
	): Extract<RegistryVerdict, { kind: "blocked" }> =>
		deps.principal === "worker"
			? verdict
			: {
					...verdict,
					denial: {
						layer,
						actionClass: verdict.decision.classification.actionClass,
						retryable: false,
						allowedBy,
						...(code !== undefined ? { code } : {}),
						...(basis !== undefined ? { basis } : {}),
					},
				};

	/**
	 * The refusal account of an ask that was answered without an approval.
	 * Only a refusal carries one: an operator's or client's deny, or a headless
	 * run or a registry without a listener, which refuse every ask. A run
	 * cancelled or shut down, a stopped turn, an expired ask and the tool-call
	 * limit never answered the question, so the identical call stays askable.
	 */
	const parkDenial = (
		verdict: Extract<RegistryVerdict, { kind: "blocked" }>,
		reason: string,
		denied = false,
		unattended = false,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const headless = reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER) || reason === NO_PARK_LISTENER_REASON;
		const contained = reason === CONTAINED_YOLO_REASON;
		const timedOut = (denied && unattended) || contained;
		if (!denied && !headless && !contained) return verdict;
		const refused = withDenial(
			verdict,
			"operator_approval",
			headless
				? "an operator must approve it, which a headless run cannot do: rerun interactively, or let an approved policy or autonomy level admit it."
				: contained
					? CONTAINED_YOLO_ALLOWED_BY
					: timedOut
						? UNATTENDED_ALLOWED_BY
						: "the operator must approve it; ask what to do instead of repeating it.",
			verdict.decision.policy?.ruleId,
		);
		if ((headless || timedOut) && refused.denial !== undefined) unattendedDenials.add(refused.denial);
		return refused;
	};

	/**
	 * A sandbox escape contained yolo refused while its session option rides the next ask_user question (M-7):
	 * the account says its repeat is refused only until the operator answers, which is when the registry forgets
	 * refusals, and what the operator chooses to allow it. The denial object is amended in place, so the unattended
	 * refusal stays one the registry remembers.
	 */
	const escapeAnswerable = <V extends RegistryVerdict>(verdict: V): V => {
		if (verdict.kind !== "blocked" || verdict.denial === undefined) return verdict;
		verdict.denial.untilOperatorAnswers = true;
		verdict.denial.allowedBy = ESCAPE_SCOPE_ALLOWED_BY;
		return verdict;
	};

	/**
	 * Escape refusals already left out of the loop guard, by turn, mutation epoch and call identity (M-7). The first
	 * refusal of a sandbox escape whose session option ask_user carries is the operator's decision still to come, not a
	 * failed attempt: once they grant the scope, the reruns are the call's first runs. A later refusal of the same call
	 * (a repeat before any answer, or after an answer that granted nothing) counts as usual, so repeats stay bounded.
	 */
	const uncountedEscapes = new Set<string>();
	const firstEscapeRefusal = (call: ClassifierCall, options: ToolInvokeOptions | undefined): boolean => {
		const turnId = options?.turnId;
		if (turnId === undefined) return false;
		const key = `${turnId}\0${deps.mutationEpoch?.(turnId) ?? 0}\0${hashToolCall(call.tool, call.args)}`;
		if (uncountedEscapes.has(key)) return false;
		uncountedEscapes.add(key);
		if (uncountedEscapes.size > DENIED_CALL_MEMORY_LIMIT) {
			const oldest = uncountedEscapes.values().next().value;
			if (oldest !== undefined) uncountedEscapes.delete(oldest);
		}
		return true;
	};

	/** Registry verdict and audit row for a hard denial past the safety net. */
	const deniedVerdict = (
		call: ClassifierCall,
		admission: Extract<AdmissionDisposition, { kind: "deny" }>,
		constraints: TurnConstraints | undefined,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const decision = admission.decision;
		if (admission.code === "read_only") {
			// A read-only dispatch and a host's read-only task scope deny alike;
			// the reason code names which one the operator set.
			const hostSource = deps.readOnly === true ? null : HOST_READ_ONLY_SOURCES[deps.hostReadOnlySource ?? "run"];
			const reasonCode = hostSource !== null ? "task:read_only" : "dispatch:read_only";
			// A read-only worker runs a check only inside an OS sandbox that keeps
			// every write out of the workspace; without one the gate is unverified,
			// and the model must say so rather than read it as a policy refusal.
			const noSandbox =
				call.tool === ToolNames.Verify && deps.principal === "worker" && deps.readOnlyShellConfined?.() !== true;
			const verdict = readOnlyDeniedVerdict(decision, call.tool, hostSource, reasonCode, noSandbox);
			recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode });
			return withDenial(
				verdict,
				"pancode_policy",
				noSandbox
					? "run the check on a Linux host with bubblewrap, or dispatch it without read-only."
					: (hostSource?.remedy ?? "the dispatching agent must dispatch this work without read-only."),
				reasonCode,
			);
		}
		if (admission.code === "skill_surface" && admission.skillViolation !== undefined) {
			const verdict = skillSurfaceBlockedVerdict(decision, call.tool, admission.skillViolation);
			recordRegistryDisposition(call, verdict.decision, "blocked", {
				reasonCode: "skill_surface",
			});
			return verdict;
		}
		if (admission.code === "tool_scope" || admission.code === "skills_disabled") {
			const sources = toolSurfaceSources(constraints).filter(
				(source) => !turnAllowsTool({ allowedTools: source.tools }, call.tool),
			);
			const allowed = constraints?.allowedTools;
			const reason =
				admission.code === "tool_scope"
					? [
							admission.reason,
							...(sources.length > 0 ? [`Scope source: ${sources.map((source) => source.source).join("; ")}.`] : []),
							...(allowed !== undefined ? [`Allowed tools: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`] : []),
							"Do not retry this tool within the current scope.",
						].join(" ")
					: admission.reason;
			const blocked: SafetyDecision = {
				kind: "block",
				classification: decision.classification,
				rejection: {
					short: `${call.tool} blocked: turn constraint`,
					detail: reason,
					hints: ["Work within the operator's task scope; approval of an individual tool does not widen it."],
				},
			};
			recordRegistryDisposition(call, blocked, "blocked", { reasonCode: "turn_constraint" });
			return withDenial(
				{ kind: "blocked", reason, decision: blocked },
				"pancode_policy",
				admission.code === "skills_disabled"
					? "the host must allow skills for this task."
					: sources.length > 0
						? sources.map((source) => source.remedy).join(" ")
						: "Ask the submitting operator to widen the task scope, then resubmit. Do not retry in this turn.",
				"turn_constraint",
			);
		}
		if (admission.code === "git_destructive") {
			recordRegistryDisposition(call, decision, "blocked", { reasonCode: "classification:git_destructive" });
			return withDenial(
				{ kind: "blocked", reason: admission.reason, decision },
				"pancode_policy",
				"nothing within this run; destructive git is a hard block.",
				"classification:git_destructive",
			);
		}
		const reasonCode = `admission:${admission.code}`;
		const blocked = blockDecision(
			decision,
			{ short: admission.reason, detail: admission.reason, hints: [] },
			{ reasonCode },
		);
		recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return withDenial(
			{ kind: "blocked", reason: admission.reason, decision: blocked },
			"pancode_policy",
			"nothing within this run.",
			reasonCode,
		);
	};

	/**
	 * Admit the host commands a call runs on its caller's behalf (F6). Dispatch
	 * host verification executes declared checks as the dispatching agent, so a
	 * check must pass the same safety net and autonomy mapping as the direct
	 * verify call would. A check that would park is refused rather than parked:
	 * the operator is asked about the dispatch plan, not about each command it
	 * implies, and a headless run has nobody to ask. Every effect is evaluated
	 * so a hard block anywhere wins over an earlier ask.
	 *
	 * The session's test-runner consent is the exception when it is the only
	 * obstacle and the call itself is admitted or asks the operator only through
	 * autonomy: the effect returns the consent ask, and the caller parks once on
	 * a decision that approves both, so a fresh attended session can approve it
	 * there instead of first running a test runner directly.
	 */
	const admitHostEffects = (
		call: ClassifierCall,
		spec: ToolSpec,
		callAdmission: AdmissionDisposition,
		level: AutonomyLevel,
	): {
		obstacle: Extract<AdmitOutcome, { kind: "terminal" }> | SessionConsentObstacle | null;
		/** The sandbox the call's commands must run in, when they are admitted only contained. */
		contained: ContainedRoots | null;
	} => {
		const decision = callAdmission.decision;
		const effects = spec.hostEffectCalls?.(call.args ?? {}) ?? [];
		if (effects.length === 0) return { obstacle: null, contained: null };
		let hard: { label: string; cause: string } | null = null;
		let soft: { label: string; cause: string } | null = null;
		let consent: { label: string; cause: string; decision: SafetyDecision } | null = null;
		for (const effect of effects) {
			const admission = admitHostEffect(effect.call, level, hostEffectScope(effect.call, level));
			if (
				admission.kind === "deny" ||
				(admission.kind === "ask" && admission.decision.classification.actionClass === "git_destructive")
			) {
				hard = { label: effect.label, cause: admission.reason };
				break;
			}
			if (admission.kind !== "ask") continue;
			if (admission.source === "session-consent") {
				if (consent === null) consent = { label: effect.label, cause: admission.reason, decision: admission.decision };
			} else if (soft === null) soft = { label: effect.label, cause: admission.reason };
		}
		// A scheduled command whose uncontained call would ask runs contained when
		// bash would run that same command contained unasked: the job meets the
		// sandbox rule its equivalent bash call meets, so a refused job never
		// pushes the model into a shell wait loop (XR-12). The sandbox rides on
		// the decision, so a decision without a policy to carry it keeps the refusal.
		let contained: ContainedRoots | null = null;
		if (call.tool === ToolNames.Job && decision.policy !== undefined && hard === null && soft !== null) {
			contained = containedEffectsSandbox(effects, level);
			if (contained !== null) soft = null;
		}
		const consentParks =
			callAdmission.kind === "allow" ||
			(callAdmission.kind === "ask" &&
				callAdmission.source === "autonomy" &&
				callAdmission.approvalAuthority === "operator");
		if (hard === null && soft === null && consentParks && consent !== null && consent.decision.kind === "ask") {
			return { obstacle: { kind: "session-consent", label: consent.label, decision: consent.decision }, contained };
		}
		const refused = hard ?? soft ?? consent;
		if (refused === null) return { obstacle: null, contained };
		const reason = `${call.tool} refused: ${refused.label} would not be admitted as a direct call (${refused.cause})`;
		const scheduled = call.tool === ToolNames.Job;
		const reasonCode = hard !== null ? "host_effect_blocked" : "host_effect_not_admitted";
		const blocked = blockDecision(
			decision,
			{
				short: reason,
				detail: scheduled
					? `${reason}. A scheduled job runs its command as this session, outside any sandbox, so the command must pass the admission its direct uncontained call would.`
					: `${reason}. Host verification runs each declared check as the dispatching agent, so each check must pass the admission its direct call would.`,
				hints: scheduled
					? [
							"Schedule a command the policy recognizes, or run the command yourself with bash.",
							"Approving the job does not approve the command it runs.",
						]
					: [
							"Run the check yourself with verify after the run settles, or declare a check the policy recognizes.",
							"Approving the dispatch does not approve the commands its verification runs.",
						],
			},
			{ reasonCode },
		);
		recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return { obstacle: { kind: "terminal", verdict: { kind: "blocked", reason, decision: blocked } }, contained: null };
	};

	const {
		recordRegistryDisposition,
		observeBlockedAttempt,
		observeRejectedAttempt,
		guardOverrideForRejectedAttempt,
		guardBlocked,
	} = createRegistryAttempts(reg);

	const cleanupParkedEntry = (entry: ParkedCall): void => {
		entry.abortCleanup?.();
		delete entry.abortCleanup;
	};

	const resolveParkedAsBlocked = (entry: ParkedCall, reason: string, options?: ParkCancelOptions): void => {
		withRegistryScope(entry.options, () => {
			cleanupParkedEntry(entry);
			disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
			// A denied/cancelled park is still a model attempt: observe it so
			// identical retries trip the loop detector. When the detector fires, its
			// reason replaces the generic denial so the model gets recovery guidance.
			// A hook-raised park was observed by the hook stage that raised it.
			const loopReason =
				entry.settledHookEffects !== undefined ? null : observeRejectedAttempt(entry.call, entry.decision, entry.options);
			entry.resolve(
				guardOverrideForRejectedAttempt(entry.call, entry.decision, loopReason) ??
					parkDenial(
						parkAnsweredBlockedVerdict(entry.decision, entry.call.tool, loopReason ?? reason, entry.meta.gateReason),
						reason,
						options?.denied,
						options?.unattended,
					),
			);
		});
	};

	const reparkEntry = (entry: ParkedCall, index?: number): void => {
		if (index === undefined || index < 0 || index >= parked.length) {
			parked.push(entry);
			return;
		}
		parked.splice(index, 0, entry);
	};

	/** The status surfaces read a started call as running; until the judge admits it, nothing is running (B01). */
	/**
	 * An ask_user call while contained yolo holds an escape scope on offer (M-7): the host-owned option the tool adds
	 * to a question about running outside the sandbox, which grants the scope only when the operator picks it.
	 */
	const withEscapeScopeOffer = (call: ClassifierCall, options: ToolInvokeOptions | undefined) => {
		const ledger = deps.escapeScopes;
		if (call.tool !== ToolNames.AskUser || deps.principal === "worker" || ledger === undefined) return options;
		const scope = ledger.pendingOffer();
		if (scope === null) return options;
		return {
			...(options ?? {}),
			escapeScopeOffer: {
				label: escapeScopeOptionLabel(scope),
				description: escapeScopeOptionConsequence(scope),
				accept: () => ledger.grant(scope, "ask-user"),
			},
		};
	};
	const notifyAdmissionReview = (options: ToolInvokeOptions | undefined, state: AdmissionReviewEvent["state"]): void => {
		const toolCallId = options?.toolCallId;
		if (toolCallId === undefined || toolCallId.length === 0) return;
		for (const listener of admissionReviewListeners) {
			try {
				listener({ toolCallId, state });
			} catch {
				// A status listener's failure never changes the verdict.
			}
		}
	};

	const observeUnattendedRefusal = (
		call: ClassifierCall,
		decision: SafetyDecision,
		kind: OpenDecisionKind,
		rule?: string,
	): void => {
		try {
			deps.onUnattendedRefusal?.(call, decision, kind, rule);
		} catch {
			// An observer's failure never changes the denial or its bookkeeping.
		}
	};

	const nextApprovalRequestId = (): string => `apr-${approvalRequestToken}-${++approvalRequestCounter}`;

	const notifyPermissionRequired = (
		call: ClassifierCall,
		decision: SafetyDecision,
		meta: PermissionRequiredMeta,
	): void => {
		for (const listener of permissionListeners) {
			try {
				listener(call, decision, meta);
			} catch {
				// Listener errors never abort admission; they are surfaced via
				// whatever observability the caller wires up.
			}
		}
	};

	const cancelParkedCallById = (requestId: string, reason: string, options?: ParkCancelOptions): boolean => {
		const index = parked.findIndex((entry) => entry.meta.requestId === requestId);
		if (index === -1) return false;
		const [entry] = parked.splice(index, 1);
		if (!entry) return false;
		resolveParkedAsBlocked(entry, reason, options);
		const next = parked[0];
		if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		return true;
	};

	/**
	 * A typed write approved under a HOOK_REFRESH_RAILS rule landed; the hook
	 * files it wrote join the drift baseline, so the next git command does not
	 * ask about the change just approved.
	 */
	const refreshHooksAfterGitControlWrite = (
		call: ClassifierCall,
		decision: SafetyDecision,
		verdict: RegistryVerdict,
	): void => {
		if (deps.hookDrift === undefined || verdict.kind !== "ok" || verdict.result.kind === "error") return;
		if (!HOOK_REFRESH_RAILS.has(approvalRailOf(decision) ?? "")) return;
		const targets = [call.args?.path, call.args?.file_path]
			.filter((target): target is string => typeof target === "string" && target.length > 0)
			.map((target) => resolvePath(process.cwd(), target));
		try {
			deps.hookDrift.refresh(targets);
		} catch {
			// The baseline keeps its old entry, so the next git command asks: the safe direction.
		}
	};

	/**
	 * The safety judge's review of a main-session ask at autonomy default.
	 * `skip` everywhere else: workers, yolo, a registry without a judge, and a
	 * call already cancelled. The time spent judging is reported as park time,
	 * so the tool's own duration stays a measurement of the tool.
	 */
	const judgeParkedCall = (
		call: ClassifierCall,
		outcome: Extract<AdmitOutcome, { kind: "park" }>,
		options: ToolInvokeOptions | undefined,
	): SafetyJudgeOutcome | Promise<SafetyJudgeOutcome> => {
		const judge = deps.safetyJudge;
		if (judge === undefined || (deps.principal ?? "main") !== "main") return SAFETY_JUDGE_SKIP;
		// Leaving the sandbox is the operator's alone: no judge, whatever it would say, approves it (D9).
		if (asksToLeaveSandbox(outcome.decision)) return SAFETY_JUDGE_SKIP;
		if ((deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== "default" || options?.signal?.aborted === true) {
			return SAFETY_JUDGE_SKIP;
		}
		let pending: SafetyJudgeOutcome | Promise<SafetyJudgeOutcome>;
		try {
			const mcpSpec = isMcpToolName(call.tool) ? tools.get(call.tool as ToolName) : undefined;
			const sends = outboundFilesOf(mcpSpec, call.args).map((file) => file.consequence);
			pending = judge.review({
				tool: call.tool,
				args: call.args,
				decision: outcome.decision,
				...(mcpSpec !== undefined
					? {
							mcpTool: {
								actionClass: mcpSpec.baseActionClass,
								description: mcpSpec.description,
								...(sends.length > 0 ? { sends } : {}),
							},
						}
					: {}),
				...(outcome.source !== undefined ? { source: outcome.source } : {}),
				approvalAuthority: outcome.approvalAuthority,
				...(outcome.planScale === true ? { dispatchPlan: true } : {}),
				...(options?.origin === "harness" ? { harness: true } : {}),
				...(deps.operatorAttends?.() === true && deps.unattendedAsks?.() !== true && permissionListeners.size > 0
					? { operatorAttends: true }
					: {}),
				...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
				...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
				...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
			});
		} catch {
			// The judge's own failure is no verdict: the call takes today's path.
			return SAFETY_JUDGE_SKIP;
		}
		const report = (judged: SafetyJudgeOutcome): SafetyJudgeOutcome => {
			if (judged.kind !== "skip" && judged.latencyMs > 0) options?.onParked?.(judged.latencyMs);
			return judged;
		};
		// Only a review that asks a model is awaited, so every other ask parks in
		// the same tick it did before the judge existed.
		if (!(pending instanceof Promise)) return report(pending);
		notifyAdmissionReview(options, "judging");
		return pending.then(report, () => SAFETY_JUDGE_SKIP);
	};

	/** Admit, park or run one call; `invoke` adds the main agent's denial memory around it. */
	const invokeAdmitted = async (call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict> => {
		const factSpec = tools.get(call.tool as ToolName);
		const factCall = factSpec?.resolveAdmissionFacts
			? { ...call, args: await factSpec.resolveAdmissionFacts(call.args ?? {}) }
			: call;
		const admissionCall = prepareAdmissionCall(factSpec, factCall);
		const outcome = admit(admissionCall, undefined, options);
		if (outcome.kind === "terminal") {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			return observeBlockedAttempt(admissionCall, outcome.verdict, options) ?? outcome.verdict;
		}
		if (outcome.kind === "execute") {
			return runSpec(outcome.spec, admissionCall, outcome.decision, withEscapeScopeOffer(admissionCall, options));
		}
		return routeAsk(admissionCall, factCall, outcome, options);
	};

	/**
	 * Route one ask: the safety judge, the contained-yolo and no-listener
	 * refusals, then a park on the operator card. Admission asks and a before_tool
	 * hook's `request_approval` take the same route; `hookEffects` is that hook
	 * stage's result, which already observed the attempt and which the call
	 * reuses when it runs.
	 */
	const routeAsk = async (
		admissionCall: ClassifierCall,
		factCall: ClassifierCall,
		outcome: Extract<AdmitOutcome, { kind: "park" }>,
		options: ToolInvokeOptions | undefined,
		hookEffects?: ReadonlyArray<MiddlewareEffect>,
	): Promise<RegistryVerdict> => {
		// The hook stage already showed the loop guard this attempt; running it again would count it twice.
		const rejected = (): string | null =>
			hookEffects !== undefined ? null : observeRejectedAttempt(admissionCall, outcome.decision, options);
		// A sandbox escape inside a scope the operator approved for this session (M-7) runs as an approved card does.
		const mainAsk = deps.principal !== "worker";
		const scopeGrant = mainAsk ? (deps.escapeScopes?.covering(admissionCall, outcome.decision) ?? null) : null;
		const scopedSpec = scopeGrant === null ? undefined : tools.get(admissionCall.tool as ToolName);
		if (scopedSpec !== undefined) {
			const allowed = escapeScopeAllowedDecision(outcome.decision);
			recordRegistryDisposition(admissionCall, allowed, "allowed", { reasonCode: ESCAPE_SCOPE_ALLOW_REASON_CODE });
			return runSpec(scopedSpec, admissionCall, allowed, options);
		}
		// The scope a session option would offer for this escape: on the card, or to contained yolo's next ask_user.
		const offeredScope = mainAsk ? (deps.escapeScopes?.scopeFor(admissionCall, outcome.decision) ?? null) : null;
		// The safety judge reviews the ask before anyone is asked. An allow runs
		// the call, a block refuses it back to the model, and anything else parks
		// exactly as before, with the judge's reason on the card when it had one.
		// The judge reads the admission facts, so a store put's replace marker is admission's, never the model's.
		const pendingJudgement = judgeParkedCall(factCall, outcome, options);
		const judged = pendingJudgement instanceof Promise ? await pendingJudgement : pendingJudgement;
		const judgedSpec = tools.get(admissionCall.tool as ToolName);
		const unattended = deps.principal !== "worker" && deps.unattendedAsks?.() === true;
		// Contained yolo cannot raise the card, so the scope goes to the next ask_user question about the escape.
		if (unattended && offeredScope !== null) deps.escapeScopes?.offer(offeredScope);
		const scopeHint = unattended && offeredScope !== null ? escapeScopeAskHint(offeredScope) : null;
		// An escape with no session option says why none exists, so the agent does not look for one (row 328).
		const noScope =
			unattended && offeredScope === null
				? (deps.escapeScopes?.noScopeReason(admissionCall, outcome.decision) ?? null)
				: null;
		const noScopeLine = noScope === null ? null : escapeNoScopeLine(noScope);
		// Contained yolo publishes only what the operator's own words name: an
		// outward call the judge allowed under any other rule is refused.
		const outwardUnnamed =
			unattended &&
			judged.kind === "allow" &&
			judged.rule !== OPERATOR_NAMED_RULE &&
			mainCallExposure(admissionCall, outcome.decision) === "outward";
		if (judged.kind === "allow" && judgedSpec !== undefined && !outwardUnnamed) {
			// The code names the judge's rule, so a run's record says why an ask ran without anyone answering it.
			const reasonCode = `${SAFETY_JUDGE_ALLOW_REASON_CODE}:${judged.rule}`;
			const allowed = safetyJudgeAllowedDecision(outcome.decision, reasonCode);
			recordRegistryDisposition(admissionCall, allowed, "allowed", { reasonCode });
			notifyAdmissionReview(options, "admitted");
			const verdict = await runSpec(judgedSpec, admissionCall, allowed, options);
			refreshHooksAfterGitControlWrite(admissionCall, outcome.decision, verdict);
			return verdict;
		}
		if (judged.kind === "block") {
			disposeAdmissionArgs(judgedSpec, admissionCall.args ?? {});
			const reasonCode = `${SAFETY_JUDGE_REASON_PREFIX}${judged.rule}`;
			const judgeReason = judged.refusal;
			const blocked = blockDecision(
				outcome.decision,
				{
					short: `${admissionCall.tool} blocked by the safety judge (rule ${judged.rule})`,
					detail: judgeReason,
					hints: [],
				},
				{ kind: "block", reasonCode },
			);
			recordRegistryDisposition(admissionCall, blocked, "blocked", { reasonCode });
			if (unattended) observeUnattendedRefusal(admissionCall, outcome.decision, "judge-block", judged.rule);
			const verdict = withDenial(
				{
					kind: "blocked",
					reason: judgeReason,
					decision: blocked,
				},
				"pancode_policy",
				judged.allowedBy,
				reasonCode,
			);
			return (hookEffects !== undefined ? null : observeBlockedAttempt(admissionCall, verdict, options)) ?? verdict;
		}
		const judgeGate = judged.kind === "park" ? { gateReason: judged.gateReason, gateBuild: judged.build } : {};
		if (unattended) {
			disposeAdmissionArgs(judgedSpec, admissionCall.args ?? {});
			recordRegistryDisposition(admissionCall, outcome.decision, "denied", {
				reasonCode: CONTAINED_YOLO_REASON_CODE,
			});
			if (outwardUnnamed) observeUnattendedRefusal(admissionCall, outcome.decision, "outward-unnamed", judged.rule);
			else if (judged.kind === "park")
				observeUnattendedRefusal(admissionCall, outcome.decision, "no-verdict", judged.cause);
			else observeUnattendedRefusal(admissionCall, outcome.decision, "operator-only");
			const loopReason = scopeHint !== null && firstEscapeRefusal(admissionCall, options) ? null : rejected();
			const refused =
				guardOverrideForRejectedAttempt(admissionCall, outcome.decision, loopReason) ??
				parkDenial(
					parkAnsweredBlockedVerdict(
						outcome.decision,
						admissionCall.tool,
						loopReason ??
							(scopeHint !== null
								? `${CONTAINED_YOLO_ESCAPE_REASON}\n${scopeHint}`
								: noScopeLine !== null
									? `${CONTAINED_YOLO_REASON}\n${noScopeLine}`
									: CONTAINED_YOLO_REASON),
						judged.kind === "park" ? judged.gateReason : outwardUnnamed ? containedOutwardReason(judged.rule) : undefined,
					),
					CONTAINED_YOLO_REASON,
				);
			return scopeHint === null || loopReason !== null ? refused : escapeAnswerable(refused);
		}
		// A park settles only through a listener's answer, so with no listener
		// the promise would never resolve. Refuse the call instead, fail closed.
		if (permissionListeners.size === 0) {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			recordRegistryDisposition(admissionCall, outcome.decision, "denied", {
				reasonCode: NO_PARK_LISTENER_REASON_CODE,
			});
			const loopReason = rejected();
			return (
				guardOverrideForRejectedAttempt(admissionCall, outcome.decision, loopReason) ??
				parkDenial(
					parkAnsweredBlockedVerdict(outcome.decision, admissionCall.tool, loopReason ?? NO_PARK_LISTENER_REASON),
					NO_PARK_LISTENER_REASON,
				)
			);
		}
		const abortReason = PARK_ABORT_REASON;
		if (options?.signal?.aborted) {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			const loopReason = rejected();
			return { kind: "blocked", reason: loopReason ?? abortReason, decision: outcome.decision };
		}
		const consequence = approvalConsequencesOf(tools.get(admissionCall.tool as ToolName), admissionCall.args);
		return new Promise<RegistryVerdict>((resolve) => {
			const meta: PermissionRequiredMeta = {
				requestId: nextApprovalRequestId(),
				axis: outcome.axis,
				approvalAuthority: outcome.approvalAuthority,
				...(consequence.length > 0 ? { consequence } : {}),
				...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
				...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
				...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
				...(outcome.dispatchPlan !== undefined ? { dispatchPlan: outcome.dispatchPlan } : {}),
				...(offeredScope !== null ? { escapeScope: offeredScope } : {}),
				...judgeGate,
			};
			// A worker's host handoff decides whether an ask is delivered or refused locally (#434).
			if (deps.principal !== "worker")
				recordRegistryDisposition(admissionCall, outcome.decision, "permission_requested", {
					requestId: meta.requestId,
					...(outcome.decision.kind === "ask" && outcome.decision.confirmationRuleId !== undefined
						? { reasonCode: `confirmation:${outcome.decision.confirmationRuleId}` }
						: {}),
				});
			// The park ends when the operator decides, not when the verdict
			// resolves: an approved call runs its body inside the resume pass,
			// so measuring to the resolve would fold the tool's own execution
			// into the park and the caller would subtract it. A dispatch that
			// fanned out for 224.8s settled as a 15ms line that way (issue #82).
			// closePark seals it at the decision; settle covers every path that
			// ends a park without reaching a body, including one added later,
			// because they all resolve the entry through this function.
			const parkedAtClock = performance.now();
			let parkReported = false;
			const closePark = (): void => {
				if (parkReported) return;
				parkReported = true;
				options?.onParked?.(Math.round(performance.now() - parkedAtClock));
			};
			const settle = (verdict: RegistryVerdict): void => {
				closePark();
				resolve(verdict);
			};
			const parkedCall: ParkedCall = {
				call: admissionCall,
				decision: outcome.decision,
				meta,
				resolve: settle,
				closePark,
				...(outcome.hookDrift !== undefined ? { hookDrift: outcome.hookDrift } : {}),
				...(hookEffects !== undefined ? { settledHookEffects: hookEffects } : {}),
			};
			if (options !== undefined) parkedCall.options = options;
			if (options?.signal) {
				const onAbort = (): void => {
					cancelParkedCallById(meta.requestId, abortReason);
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				parkedCall.abortCleanup = () => {
					options.signal?.removeEventListener("abort", onAbort);
				};
			}
			parked.push(parkedCall);
			notifyPermissionRequired(admissionCall, outcome.decision, meta);
		});
	};

	/**
	 * Refused calls of the main agent by turn, mutation epoch and call
	 * identity, oldest first. Grants, a changed autonomy level and a reload
	 * clear it, because each can change the answer.
	 */
	const deniedCalls = new Map<string, Extract<RegistryVerdict, { kind: "blocked" }>>();
	let deniedCallsLevel: AutonomyLevel | null = null;
	/**
	 * Operator-approval refusals that no operator could have answered
	 * otherwise: a headless run, a registry with no listener, or an attended
	 * card nobody answered within the unattended window (#421). An attended
	 * operator who refused once may approve when asked again, so only these
	 * are remembered.
	 */
	const unattendedDenials = new WeakSet<ToolDenial>();
	const rememberedRefusal = (verdict: RegistryVerdict): verdict is Extract<RegistryVerdict, { kind: "blocked" }> =>
		verdict.kind === "blocked" &&
		verdict.denial !== undefined &&
		(verdict.denial.layer !== "operator_approval" || unattendedDenials.has(verdict.denial));

	/** Admit and run one call, with the main agent's denial memory around it. */
	const invokeSingle: ToolRegistry["invoke"] = async (call, options) => {
		return withRegistryScope(options, async () => {
			if (deps.principal === "worker") return invokeAdmitted(call, options);
			// A refusal is final for the identical call within the turn: the same
			// policy, the same operator and the same server would answer it the
			// same way. Refusing the repeat here, before admission, keeps it from
			// asking the operator again or reaching the server again, where the
			// loop guard would otherwise allow two more attempts first. A call with
			// no turn (/council, an ACP host dispatch) is the operator's own
			// command, so nothing is remembered for it.
			const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
			if (level !== deniedCallsLevel) {
				deniedCalls.clear();
				deniedCallsLevel = level;
			}
			const turnId = options?.turnId;
			const key =
				turnId === undefined
					? null
					: `${turnId}\0${deps.mutationEpoch?.(turnId) ?? 0}\0${hashToolCall(call.tool, call.args)}`;
			const prior = key === null ? undefined : deniedCalls.get(key);
			if (prior?.denial !== undefined) {
				const decision = blockDecision(
					prior.decision,
					prior.decision.kind === "allow"
						? { short: prior.reason, detail: prior.reason, hints: [] }
						: prior.decision.rejection,
					{ reasonCode: DENIED_REPEAT_REASON_CODE },
				);
				const repeat: Extract<RegistryVerdict, { kind: "blocked" }> = {
					kind: "blocked",
					reason: `${repeatedDenialReason(effectiveToolCall(call.tool, call.args).toolName, prior.denial)}\n${prior.reason}`,
					decision,
					// A repeat of an ask nobody could approve is still that unanswered
					// ask, so receipts keep counting it as a permission request.
					...(prior.deniedPark === true ? { deniedPark: true } : {}),
					denial: prior.denial,
				};
				recordRegistryDisposition(call, decision, "blocked", { reasonCode: DENIED_REPEAT_REASON_CODE });
				return observeBlockedAttempt(call, repeat, options) ?? repeat;
			}
			const verdict = await invokeAdmitted(call, options);
			// An operator's answer can grant what an earlier call was refused.
			if (effectiveToolCall(call.tool, call.args).toolName === ToolNames.AskUser && askUserAnswered(verdict)) {
				deniedCalls.clear();
				if ((deps.principal ?? "main") === "main") deps.onOperatorAnswered?.(operatorAnswers(verdict), options);
			}
			if (key !== null && rememberedRefusal(verdict) && verdict.denial !== undefined) {
				// Only a remembered refusal tells the model its repeat is refused
				// without running; an attended operator's refusal, a worker's and a
				// turnless call's are asked or run again.
				const remembered: Extract<RegistryVerdict, { kind: "blocked" }> = {
					...verdict,
					denial: { ...verdict.denial, repeatRefused: true },
				};
				deniedCalls.delete(key);
				deniedCalls.set(key, remembered);
				if (deniedCalls.size > DENIED_CALL_MEMORY_LIMIT) {
					const oldest = deniedCalls.keys().next().value;
					if (oldest !== undefined) deniedCalls.delete(oldest);
				}
				return remembered;
			}
			return verdict;
		});
	};

	return {
		register(spec) {
			tools.set(spec.name, spec);
		},
		unregister(name) {
			tools.delete(name);
		},
		listAll: () => Array.from(tools.values()),
		get: (name) => tools.get(name),
		listRegistered: () =>
			Array.from(tools.values())
				.filter((spec) => toolSpecPlacement(spec) === "direct")
				.map((spec) => spec.name),
		listVisible: () => Array.from(tools.values()).filter((spec) => toolSpecPlacement(spec) === "direct"),
		listGateway: () => Array.from(tools.values()).filter((spec) => toolSpecPlacement(spec) === "gateway"),
		readOnlyRefusal(call, options) {
			return withRegistryScope(options, () => {
				const spec = tools.get(call.tool as ToolName);
				if (spec === undefined) return null;
				const { admission } = evaluateCallAdmission(call, spec, undefined, options);
				if (admission.kind !== "deny" || admission.code !== "read_only") return null;
				return deniedVerdict(call, admission, options?.turnConstraints);
			});
		},
		async invoke(call, options) {
			// A multi-path read is N single-path reads: each takes the single-call entry, so admission, the safety
			// policy, denial memory, hooks and the observation pool all see one path per call, as they always have.
			if (call.tool !== ToolNames.Read) return invokeSingle(call, options);
			// A malformed `paths` never travels on: admission and the loop middleware see a read with no path.
			const malformed = malformedReadPathsCall(call.args);
			if (malformed !== null) return invokeSingle({ tool: ToolNames.Read, args: malformed }, options);
			const fanOut = readFanOut(call.args);
			if (fanOut === null) return invokeSingle(call, options);
			const cap = readFanOutCapBytes();
			const budget = createReadFanOutBudget(fanOut.paths, cap);
			const reads: ReadFanOutEntry[] = [];
			for (const path of fanOut.paths) {
				const room = budget.open(path);
				const verdict =
					(reads.length > 0 && room < READ_PATHS_MIN_SLICE_BYTES) || options?.signal?.aborted === true
						? null
						: await invokeSingle(
								{ tool: ToolNames.Read, args: { ...fanOut.shared, path } },
								{ ...options, readCapBytes: Math.max(room, READ_PATHS_MIN_SLICE_BYTES) },
							);
				reads.push({ path, verdict, text: budget.settle(readFanOutText(verdict)) });
			}
			return joinReadFanOut(reads, cap);
		},
		async requestReadRootApproval(root, options, task) {
			return withRegistryScope(options, async () => {
				// Contained yolo never waits for a person, so the Scout run reports the approval it needed instead.
				if (
					(deps.principal ?? "main") !== "main" ||
					options?.signal?.aborted ||
					permissionListeners.size === 0 ||
					deps.unattendedAsks?.() === true
				)
					return null;
				const call: ClassifierCall = Object.freeze({ tool: ToolNames.Read, args: Object.freeze({ path: root }) });
				const admission = evaluateAdmission({
					principal: "main",
					effects: [call],
					safety: deps.safety,
					autonomy: "default",
					confirmationRuleId: "dispatch-external-read",
					confirmationText: {
						detail: `Allow one read-only Scout run to inspect external root ${JSON.stringify(root)}? This grants no writes, commands, or access to other external roots.`,
						hints: ["This approval expires with this Scout run."],
					},
				});
				if (admission.kind !== "ask") {
					if (admission.kind === "deny") recordRegistryDisposition(call, admission.decision, "blocked");
					return null;
				}
				const decision: SafetyDecision = {
					...admission.decision,
					kind: "ask",
					confirmationRuleId: "dispatch-external-read",
					rejection: {
						short: `Scout external read root needs approval: ${root}`,
						detail: `Allow one read-only Scout run to inspect external root ${JSON.stringify(root)}? No writes or commands are granted.`,
						hints: ["One approval covers only this run and root."],
					},
				};
				const meta: PermissionRequiredMeta = {
					requestId: nextApprovalRequestId(),
					axis: "net:dispatch-external-read",
					approvalAuthority: "operator",
					...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
					...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
					...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
					...(task !== undefined ? { dispatchTask: { ...task } } : {}),
				};
				return await new Promise((resolve) => {
					const started = performance.now();
					let reported = false;
					const closePark = () => {
						if (!reported) {
							reported = true;
							options?.onParked?.(Math.round(performance.now() - started));
						}
					};
					const entry: ParkedCall = {
						call,
						decision,
						meta,
						readRootApproval: true,
						closePark,
						...(options !== undefined ? { options } : {}),
						resolve(verdict) {
							closePark();
							const details = verdict.kind === "ok" ? verdict.result.details : undefined;
							resolve(
								details && typeof details.requestId === "string" && typeof details.requestedBy === "string"
									? { requestId: details.requestId, requestedBy: details.requestedBy }
									: null,
							);
						},
					};
					enqueueOperatorAsk(askQueue, entry, "confirmation:dispatch-external-read");
				});
			});
		},
		hasParkedCalls: () => parked.length > 0,
		parkedCount: () => parked.length,
		renotifyHead() {
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		async resumeParkedCalls(grant?: OneShotGrant) {
			// A grant, session consent included, changes what admission answers.
			if (grant !== undefined) deniedCalls.clear();
			if (parked.length === 0) return;
			const pending: Array<{ entry: ParkedCall; reparkIndex?: number }> = [];
			if (grant === undefined) {
				pending.push(...parked.splice(0, parked.length).map((entry) => ({ entry })));
			} else if (grant.requestId !== undefined) {
				const index = parked.findIndex((entry) => entry.meta.requestId === grant.requestId);
				if (index === -1) {
					grant.onExecution?.({ phase: "not_executed", reason: "the parked call is no longer waiting" });
					const next = parked[0];
					if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
					return;
				}
				const [entry] = parked.splice(index, 1);
				if (entry) pending.push({ entry, reparkIndex: index });
			} else {
				const [entry] = parked.splice(0, 1);
				if (entry) pending.push({ entry });
			}
			for (const { entry, reparkIndex } of pending) {
				await withRegistryScope(entry.options, async () => {
					if (entry.readRootApproval === true || entry.approve !== undefined) {
						if (grant === undefined || grant.actionClass !== "read" || (grant.issuer ?? "operator") !== "operator") {
							reparkEntry(entry, reparkIndex);
							return;
						}
						cleanupParkedEntry(entry);
						if (entry.approve !== undefined) return entry.approve(grant.requestedBy);
						const disposition = evaluateAdmission({
							principal: "main",
							effects: [entry.call],
							safety: deps.safety,
							autonomy: "default",
							authorization: { actionClass: "read", issuer: "operator" },
						});
						entry.closePark();
						if (disposition.kind !== "allow") {
							recordRegistryDisposition(entry.call, disposition.decision, "blocked", {
								requestId: entry.meta.requestId,
							});
							entry.resolve({
								kind: "blocked",
								reason: "External read root no longer passes safety admission",
								decision: disposition.decision,
							});
							return;
						}
						recordRegistryDisposition(entry.call, disposition.decision, "allowed", {
							requestId: entry.meta.requestId,
							reasonCode: "confirmation:dispatch-external-read",
						});
						entry.resolve({
							kind: "ok",
							decision: disposition.decision,
							result: {
								kind: "ok",
								output: "External Scout read approved for one run.",
								details: { requestId: entry.meta.requestId, requestedBy: grant.requestedBy },
							},
						});
						return;
					}
					// A hook asked the operator, so only an operator's grant releases the call; a re-admission sweep leaves it waiting.
					if (entry.settledHookEffects !== undefined && grant === undefined) {
						reparkEntry(entry, reparkIndex);
						return;
					}
					// A one-shot grant covers only the parked call it selected. Calls
					// that parked while the overlay was already open remain queued and
					// need their own confirmation, so a concurrent privileged call
					// cannot ride along on a grant approved for another call.
					const observed = grant?.requestId !== undefined && grant.requestId === entry.meta.requestId;
					if (grant !== undefined && entry.decision.classification.actionClass !== grant.actionClass) {
						if (observed) grant?.onExecution?.({ phase: "not_executed", reason: "the grant names another action class" });
						reparkEntry(entry, reparkIndex);
						return;
					}
					// The operator approved the session's test-runner consent ask; the
					// consent covers every later test runner this session. It is given
					// before re-admission, because a dispatch or job that parked on it
					// re-admits its host checks afresh and must find it given.
					if (
						grant !== undefined &&
						(grant.issuer ?? "operator") === "operator" &&
						entry.decision.kind === "ask" &&
						entry.decision.confirmationRuleId === SESSION_CODE_CONSENT_RULE_ID
					) {
						deps.sessionCodeConsent?.grant();
					}
					// The operator picked the parked escape's session option: the scope it showed is granted before
					// re-admission, so this call and later ones inside it no longer ask (M-7).
					if (
						grant?.sessionScope === true &&
						(grant.issuer ?? "operator") === "operator" &&
						entry.meta.escapeScope !== undefined
					) {
						deps.escapeScopes?.grant(
							entry.meta.escapeScope,
							grant.requestedBy === "acp-client" ? "acp-client" : "approval-card",
						);
					}
					// The operator allowed a git-hooks-changed ask: the files the card
					// named join the baseline before re-admission, so a file changed
					// after the card was drawn still asks.
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator" && entry.hookDrift !== undefined) {
						deps.hookDrift?.accept(entry.hookDrift);
					}
					const outcome = admit(entry.call, grant, entry.options);
					if (outcome.kind === "park") {
						if (observed) {
							grant?.onExecution?.({ phase: "not_executed", reason: "admission still requires another approval" });
						}
						reparkEntry(entry, reparkIndex);
						return;
					}
					cleanupParkedEntry(entry);
					if (outcome.kind === "terminal") {
						disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
						if (observed) {
							grant?.onExecution?.({
								phase: "not_executed",
								reason: "reason" in outcome.verdict ? outcome.verdict.reason : "admission refused the call",
							});
						}
						entry.resolve(observeBlockedAttempt(entry.call, outcome.verdict, entry.options) ?? outcome.verdict);
						return;
					}
					const approvedOptions: ToolInvokeOptions | undefined =
						grant === undefined
							? entry.options
							: {
									...(entry.options ?? {}),
									approval: {
										requestId: entry.meta.requestId,
										requestedBy: grant.requestedBy,
										actionClass: grant.actionClass,
										...(grant.issuer !== undefined ? { issuer: grant.issuer } : {}),
									},
								};
					// The approved call runs on what its hook stage decided, without running the hooks again.
					if (entry.settledHookEffects !== undefined && approvedOptions !== undefined)
						hookSettled.set(approvedOptions, entry.settledHookEffects);
					// Seal the park before the body runs. Everything after this line is
					// the tool working, and the caller charges that to the tool.
					entry.closePark();
					// An operator's approval turns the safety judge's review back on after it
					// handed calls to the operator.
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator") deps.safetyJudge?.operatorApproved();
					if (observed) grant?.onExecution?.({ phase: "start" });
					const verdict = await runSpec(outcome.spec, entry.call, outcome.decision, approvedOptions);
					if (grant !== undefined && (grant.issuer ?? "operator") === "operator") {
						refreshHooksAfterGitControlWrite(entry.call, entry.decision, verdict);
					}
					if (observed) {
						grant?.onExecution?.({
							phase: "end",
							outcome: verdict.kind !== "ok" ? "blocked" : verdict.result.kind === "error" ? "error" : "ok",
						});
					}
					// A grant is invisible in the result otherwise, and the model reported
					// a confirmed call as one that never asked. The note names the
					// surface that released the call, because an ACP client or a
					// remembered escalation is not this session's operator. Only this path
					// runs a released call, so no ordinary call is annotated.
					entry.resolve(
						grant !== undefined && verdict.kind === "ok"
							? {
									...verdict,
									result: withApprovalNote(verdict.result, {
										actionClass: grant.actionClass,
										requestedBy: grant.requestedBy,
										ruleId: approvalRailOf(entry.decision),
										gateReason: entry.meta.gateReason,
									}),
								}
							: verdict,
					);
				});
			}
			const next = parked[0];
			if (next) notifyPermissionRequired(next.call, next.decision, next.meta);
		},
		forgetRefusals() {
			deniedCalls.clear();
		},
		cancelParkedCall(requestId, reason, cancelOptions) {
			return cancelParkedCallById(requestId, reason, cancelOptions);
		},
		cancelParkedCalls(reason, cancelOptions) {
			if (parked.length === 0) return;
			const pending = parked.splice(0, parked.length);
			for (const entry of pending) {
				resolveParkedAsBlocked(entry, reason, cancelOptions);
			}
		},
		isParked: (requestId) => parked.some((entry) => entry.meta.requestId === requestId),
		onPermissionRequired(listener) {
			permissionListeners.add(listener);
			return () => {
				permissionListeners.delete(listener);
			};
		},
		onAdmissionReview(listener) {
			admissionReviewListeners.add(listener);
			return () => {
				admissionReviewListeners.delete(listener);
			};
		},
		onToolBodyStart(listener) {
			bodyStartListeners.add(listener);
			return () => {
				bodyStartListeners.delete(listener);
			};
		},
		onToolBoundaryReminders(listener) {
			boundaryReminderListeners.add(listener);
			return () => {
				boundaryReminderListeners.delete(listener);
			};
		},
	};
}
