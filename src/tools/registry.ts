// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ToolName } from "../core/tool-names.js";
import { ToolNames } from "../core/tool-names.js";
import { toolSpecPlacement } from "../core/tool-surface.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../domains/middleware/types.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
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
import type {
	AdmissionReviewEvent,
	PermissionRequiredMeta,
	RegistryDeps,
	ToolBoundaryReminder,
	ToolInvokeOptions,
	ToolRegistry,
} from "./registry/contract.js";
import { createRegistryDenials } from "./registry/denials.js";
import { createFlowGates } from "./registry/flow.js";
import { createRegistryHooks } from "./registry/hooks.js";
import { withRegistryScope } from "./registry/nested-calls.js";
import { createShellEgress, type OperatorAskQueue } from "./registry/operator-asks.js";
import { createOperatorScopes } from "./registry/operator-scope.js";
import { createRegistryPark } from "./registry/park.js";
import { createRegistryResume } from "./registry/resume.js";
import { createRegistryRun } from "./registry/run.js";
import type { ParkedCall, RegistryScope } from "./registry/scope.js";
import { createSnapshotGate } from "./registry/snapshot.js";
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

		get approvalRailOf() {
			return approvalRailOf;
		},
		get cleanupParkedEntry() {
			return cleanupParkedEntry;
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

	const { resumeParkedCalls } = createRegistryResume(reg);

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
		resumeParkedCalls,
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
