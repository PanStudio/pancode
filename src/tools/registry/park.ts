// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { isMcpToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { evaluateAdmission } from "../../domains/safety/admission.js";
import type { OpenDecisionKind } from "../../domains/safety/autonomy-window.js";
import { GIT_CONTROL_FILE_RULE_ID, STARTUP_PATH_RULE_ID } from "../../domains/safety/containment.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { SafetyJudgeOutcome } from "../../domains/safety/safety-judge.js";
import { asksToLeaveSandbox } from "../../domains/safety/sandbox-escape.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import { disposeAdmissionArgs, outboundFilesOf } from "../registry-call-prep.js";
import type {
	AdmissionReviewEvent,
	ParkCancelOptions,
	PermissionRequiredMeta,
	RegistryVerdict,
	ToolInvokeOptions,
	ToolRegistry,
} from "../registry-contract.js";
import { withRegistryScope } from "../registry-nested-calls.js";
import { enqueueOperatorAsk } from "../registry-operator-asks.js";
import { parkAnsweredBlockedVerdict, SAFETY_JUDGE_SKIP } from "../registry-verdicts.js";
import type { AdmitOutcome, ParkedCall, RegistryScope } from "./scope.js";

/**
 * Approval rules after which a landed typed write refreshes the git hook drift baseline: git-control-file, which the
 * operator approves or the judge allows, and startup-path-confirm, which only the operator approves. A hooks
 * directory such as .husky is both, and the startup-path rule asks first.
 */
const HOOK_REFRESH_RAILS: ReadonlySet<string> = new Set([GIT_CONTROL_FILE_RULE_ID, STARTUP_PATH_RULE_ID]);

/**
 * A registry call parked for the operator or the judge: the parked queue's entries, the permission and admission
 * review notices, the approval request ids, and the external read root approval a Scout run asks for.
 */
export function createRegistryPark(reg: RegistryScope) {
	const { deps, tools, parked, permissionListeners, askQueue, admissionReviewListeners } = reg;
	let approvalRequestCounter = 0;
	const approvalRequestToken = randomBytes(4).toString("hex");

	/** The rail that named the parked call, when the decision carried one. */
	const approvalRailOf = (decision: SafetyDecision): string | undefined => {
		if (decision.kind === "allow") return decision.policy?.ruleId;
		return decision.match?.ruleId ?? decision.policy?.ruleId;
	};
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
				entry.settledHookEffects !== undefined
					? null
					: reg.observeRejectedAttempt(entry.call, entry.decision, entry.options);
			entry.resolve(
				reg.guardOverrideForRejectedAttempt(entry.call, entry.decision, loopReason) ??
					reg.parkDenial(
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

	const requestReadRootApproval: ToolRegistry["requestReadRootApproval"] = async (root, options, task) => {
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
				if (admission.kind === "deny") reg.recordRegistryDisposition(call, admission.decision, "blocked");
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
	};
	return {
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
	};
}
