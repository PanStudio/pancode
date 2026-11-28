// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { ToolName } from "../../core/tool-names.js";
import type { MiddlewareEffect } from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { mainCallExposure } from "../../domains/safety/call-consequence.js";
import { OPERATOR_NAMED_RULE, SAFETY_JUDGE_ALLOW_REASON_CODE } from "../../domains/safety/safety-judge.js";
import { approvalConsequencesOf, disposeAdmissionArgs } from "./call-prep.js";
import type { PermissionRequiredMeta, RegistryVerdict, ToolInvokeOptions } from "./contract.js";
import type { AdmitOutcome, ParkedCall, RegistryScope } from "./scope.js";
import {
	blockDecision,
	CONTAINED_YOLO_ESCAPE_REASON,
	CONTAINED_YOLO_REASON,
	CONTAINED_YOLO_REASON_CODE,
	containedOutwardReason,
	ESCAPE_SCOPE_ALLOW_REASON_CODE,
	escapeNoScopeLine,
	escapeScopeAllowedDecision,
	escapeScopeAskHint,
	NO_PARK_LISTENER_REASON,
	NO_PARK_LISTENER_REASON_CODE,
	PARK_ABORT_REASON,
	parkAnsweredBlockedVerdict,
	SAFETY_JUDGE_REASON_PREFIX,
	safetyJudgeAllowedDecision,
} from "./verdicts.js";

/**
 * One ask's route: the safety judge, the contained-yolo and no-listener refusals, then a park on the operator card.
 */
export function createRegistryAsk(reg: RegistryScope) {
	const { deps, tools, parked, permissionListeners } = reg;
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
			hookEffects !== undefined ? null : reg.observeRejectedAttempt(admissionCall, outcome.decision, options);
		// A sandbox escape inside a scope the operator approved for this session (M-7) runs as an approved card does.
		const mainAsk = deps.principal !== "worker";
		const scopeGrant = mainAsk ? (deps.escapeScopes?.covering(admissionCall, outcome.decision) ?? null) : null;
		const scopedSpec = scopeGrant === null ? undefined : tools.get(admissionCall.tool as ToolName);
		if (scopedSpec !== undefined) {
			const allowed = escapeScopeAllowedDecision(outcome.decision);
			reg.recordRegistryDisposition(admissionCall, allowed, "allowed", { reasonCode: ESCAPE_SCOPE_ALLOW_REASON_CODE });
			return reg.runSpec(scopedSpec, admissionCall, allowed, options);
		}
		// The scope a session option would offer for this escape: on the card, or to contained yolo's next ask_user.
		const offeredScope = mainAsk ? (deps.escapeScopes?.scopeFor(admissionCall, outcome.decision) ?? null) : null;
		// The safety judge reviews the ask before anyone is asked. An allow runs
		// the call, a block refuses it back to the model, and anything else parks
		// exactly as before, with the judge's reason on the card when it had one.
		// The judge reads the admission facts, so a store put's replace marker is admission's, never the model's.
		const pendingJudgement = reg.judgeParkedCall(factCall, outcome, options);
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
			reg.recordRegistryDisposition(admissionCall, allowed, "allowed", { reasonCode });
			reg.notifyAdmissionReview(options, "admitted");
			const verdict = await reg.runSpec(judgedSpec, admissionCall, allowed, options);
			reg.refreshHooksAfterGitControlWrite(admissionCall, outcome.decision, verdict);
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
			reg.recordRegistryDisposition(admissionCall, blocked, "blocked", { reasonCode });
			if (unattended) reg.observeUnattendedRefusal(admissionCall, outcome.decision, "judge-block", judged.rule);
			const verdict = reg.withDenial(
				{
					kind: "blocked",
					reason: judgeReason,
					decision: blocked,
				},
				"pancode_policy",
				judged.allowedBy,
				reasonCode,
			);
			return (hookEffects !== undefined ? null : reg.observeBlockedAttempt(admissionCall, verdict, options)) ?? verdict;
		}
		const judgeGate = judged.kind === "park" ? { gateReason: judged.gateReason, gateBuild: judged.build } : {};
		if (unattended) {
			disposeAdmissionArgs(judgedSpec, admissionCall.args ?? {});
			reg.recordRegistryDisposition(admissionCall, outcome.decision, "denied", {
				reasonCode: CONTAINED_YOLO_REASON_CODE,
			});
			if (outwardUnnamed) reg.observeUnattendedRefusal(admissionCall, outcome.decision, "outward-unnamed", judged.rule);
			else if (judged.kind === "park")
				reg.observeUnattendedRefusal(admissionCall, outcome.decision, "no-verdict", judged.cause);
			else reg.observeUnattendedRefusal(admissionCall, outcome.decision, "operator-only");
			const loopReason = scopeHint !== null && reg.firstEscapeRefusal(admissionCall, options) ? null : rejected();
			const refused =
				reg.guardOverrideForRejectedAttempt(admissionCall, outcome.decision, loopReason) ??
				reg.parkDenial(
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
			return scopeHint === null || loopReason !== null ? refused : reg.escapeAnswerable(refused);
		}
		// A park settles only through a listener's answer, so with no listener
		// the promise would never resolve. Refuse the call instead, fail closed.
		if (permissionListeners.size === 0) {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			reg.recordRegistryDisposition(admissionCall, outcome.decision, "denied", {
				reasonCode: NO_PARK_LISTENER_REASON_CODE,
			});
			const loopReason = rejected();
			return (
				reg.guardOverrideForRejectedAttempt(admissionCall, outcome.decision, loopReason) ??
				reg.parkDenial(
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
				requestId: reg.nextApprovalRequestId(),
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
				reg.recordRegistryDisposition(admissionCall, outcome.decision, "permission_requested", {
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
					reg.cancelParkedCallById(meta.requestId, abortReason);
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				parkedCall.abortCleanup = () => {
					options.signal?.removeEventListener("abort", onAbort);
				};
			}
			parked.push(parkedCall);
			reg.notifyPermissionRequired(admissionCall, outcome.decision, meta);
		});
	};
	return { routeAsk };
}
