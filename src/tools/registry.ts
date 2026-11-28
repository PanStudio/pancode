// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ToolName } from "../core/tool-names.js";
import { ToolNames } from "../core/tool-names.js";
import { toolSpecPlacement } from "../core/tool-surface.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../core/views/approval-words.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../domains/middleware/types.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { evaluateAdmission } from "../domains/safety/admission.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { withApprovalNote } from "./approval-note.js";
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
import { createRegistryAdmission } from "./registry/admission.js";
import { createRegistryAsk } from "./registry/ask.js";
import { createRegistryAttempts } from "./registry/attempts.js";
import { createRegistryDenials } from "./registry/denials.js";
import { createFlowGates } from "./registry/flow.js";
import { createRegistryHooks } from "./registry/hooks.js";
import { createOperatorScopes } from "./registry/operator-scope.js";
import { createRegistryPark } from "./registry/park.js";
import { createRegistryRun } from "./registry/run.js";
import type { ParkedCall, RegistryScope } from "./registry/scope.js";
import { createSnapshotGate } from "./registry/snapshot.js";
import { disposeAdmissionArgs } from "./registry-call-prep.js";
import type {
	AdmissionReviewEvent,
	OneShotGrant,
	PermissionRequiredMeta,
	RegistryDeps,
	ToolBoundaryReminder,
	ToolInvokeOptions,
	ToolRegistry,
} from "./registry-contract.js";
import { withRegistryScope } from "./registry-nested-calls.js";
import { createShellEgress, type OperatorAskQueue } from "./registry-operator-asks.js";
import type { ToolSpec } from "./tool-spec.js";

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
	const boundaryReminderListeners = new Set<
		(reminders: ReadonlyArray<ToolBoundaryReminder>, input: MiddlewareHookInput) => void
	>();
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

		get withDenial() {
			return withDenial;
		},
		get parkDenial() {
			return parkDenial;
		},
		get escapeAnswerable() {
			return escapeAnswerable;
		},
		get firstEscapeRefusal() {
			return firstEscapeRefusal;
		},
		get deniedCalls() {
			return deniedCalls;
		},
		get invokeSingle() {
			return invokeSingle;
		},
		get invokeAdmitted() {
			return invokeAdmitted;
		},

		get hookApprovalOutcome() {
			return hookApprovalOutcome;
		},
		get admitRewrite() {
			return admitRewrite;
		},
		get judgeRewrite() {
			return judgeRewrite;
		},
		get runAwaitedToolHook() {
			return runAwaitedToolHook;
		},
		get admit() {
			return admit;
		},

		get evaluateCallAdmission() {
			return evaluateCallAdmission;
		},
		get deniedVerdict() {
			return deniedVerdict;
		},

		get approvalRailOf() {
			return approvalRailOf;
		},
		get cleanupParkedEntry() {
			return cleanupParkedEntry;
		},
		get resolveParkedAsBlocked() {
			return resolveParkedAsBlocked;
		},
		get reparkEntry() {
			return reparkEntry;
		},
		get notifyAdmissionReview() {
			return notifyAdmissionReview;
		},
		get observeUnattendedRefusal() {
			return observeUnattendedRefusal;
		},
		get nextApprovalRequestId() {
			return nextApprovalRequestId;
		},
		get notifyPermissionRequired() {
			return notifyPermissionRequired;
		},
		get cancelParkedCallById() {
			return cancelParkedCallById;
		},
		get refreshHooksAfterGitControlWrite() {
			return refreshHooksAfterGitControlWrite;
		},
		get judgeParkedCall() {
			return judgeParkedCall;
		},
		get requestReadRootApproval() {
			return requestReadRootApproval;
		},

		get routeAsk() {
			return routeAsk;
		},
		get runSpec() {
			return runSpec;
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

	const {
		approvalRailOf,
		cleanupParkedEntry,
		resolveParkedAsBlocked,
		reparkEntry,
		notifyAdmissionReview,
		observeUnattendedRefusal,
		nextApprovalRequestId,
		notifyPermissionRequired,
		cancelParkedCallById,
		refreshHooksAfterGitControlWrite,
		judgeParkedCall,
		requestReadRootApproval,
	} = createRegistryPark(reg);

	const { outboundFlowViolation, fileTargetFlowViolation, sourceAdmissionRefusal } = createFlowGates(reg);

	const { snapshotBeforeBody } = createSnapshotGate(reg);

	const { runSpec, invokeAdmitted } = createRegistryRun(reg);

	const { hookApprovalOutcome, runToolHook, admitRewrite, judgeRewrite, runAwaitedToolHook } = createRegistryHooks(reg);

	const { evaluateCallAdmission, admit, deniedVerdict } = createRegistryAdmission(reg);

	const { withDenial, parkDenial, escapeAnswerable, firstEscapeRefusal, deniedCalls, invokeSingle } =
		createRegistryDenials(reg);

	const {
		recordRegistryDisposition,
		observeBlockedAttempt,
		observeRejectedAttempt,
		guardOverrideForRejectedAttempt,
		guardBlocked,
	} = createRegistryAttempts(reg);

	const { routeAsk } = createRegistryAsk(reg);

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
		requestReadRootApproval,
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
