// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { ToolName } from "../../core/tool-names.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../../core/views/approval-words.js";
import { evaluateAdmission } from "../../domains/safety/admission.js";
import { withApprovalNote } from "../approval-note.js";
import { disposeAdmissionArgs } from "./call-prep.js";
import type { OneShotGrant, ToolInvokeOptions, ToolRegistry } from "./contract.js";
import { withRegistryScope } from "./nested-calls.js";
import type { ParkedCall, RegistryScope } from "./scope.js";

/**
 * Resuming parked calls once the operator answers: the grant's call or the whole queue re-admitted, run, refused or
 * parked again.
 */
export function createRegistryResume(reg: RegistryScope) {
	const { deps, tools, hookSettled, parked } = reg;
	const resumeParkedCalls: ToolRegistry["resumeParkedCalls"] = async (grant?: OneShotGrant) => {
		// A grant, session consent included, changes what admission answers.
		if (grant !== undefined) reg.deniedCalls.clear();
		if (parked.length === 0) return;
		const pending: Array<{ entry: ParkedCall; reparkIndex?: number }> = [];
		if (grant === undefined) {
			pending.push(...parked.splice(0, parked.length).map((entry) => ({ entry })));
		} else if (grant.requestId !== undefined) {
			const index = parked.findIndex((entry) => entry.meta.requestId === grant.requestId);
			if (index === -1) {
				grant.onExecution?.({ phase: "not_executed", reason: "the parked call is no longer waiting" });
				const next = parked[0];
				if (next) reg.notifyPermissionRequired(next.call, next.decision, next.meta);
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
						reg.reparkEntry(entry, reparkIndex);
						return;
					}
					reg.cleanupParkedEntry(entry);
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
						reg.recordRegistryDisposition(entry.call, disposition.decision, "blocked", {
							requestId: entry.meta.requestId,
						});
						entry.resolve({
							kind: "blocked",
							reason: "External read root no longer passes safety admission",
							decision: disposition.decision,
						});
						return;
					}
					reg.recordRegistryDisposition(entry.call, disposition.decision, "allowed", {
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
					reg.reparkEntry(entry, reparkIndex);
					return;
				}
				// A one-shot grant covers only the parked call it selected. Calls
				// that parked while the overlay was already open remain queued and
				// need their own confirmation, so a concurrent privileged call
				// cannot ride along on a grant approved for another call.
				const observed = grant?.requestId !== undefined && grant.requestId === entry.meta.requestId;
				if (grant !== undefined && entry.decision.classification.actionClass !== grant.actionClass) {
					if (observed) grant?.onExecution?.({ phase: "not_executed", reason: "the grant names another action class" });
					reg.reparkEntry(entry, reparkIndex);
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
				const outcome = reg.admit(entry.call, grant, entry.options);
				if (outcome.kind === "park") {
					if (observed) {
						grant?.onExecution?.({ phase: "not_executed", reason: "admission still requires another approval" });
					}
					reg.reparkEntry(entry, reparkIndex);
					return;
				}
				reg.cleanupParkedEntry(entry);
				if (outcome.kind === "terminal") {
					disposeAdmissionArgs(tools.get(entry.call.tool as ToolName), entry.call.args ?? {});
					if (observed) {
						grant?.onExecution?.({
							phase: "not_executed",
							reason: "reason" in outcome.verdict ? outcome.verdict.reason : "admission refused the call",
						});
					}
					entry.resolve(reg.observeBlockedAttempt(entry.call, outcome.verdict, entry.options) ?? outcome.verdict);
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
				const verdict = await reg.runSpec(outcome.spec, entry.call, outcome.decision, approvedOptions);
				if (grant !== undefined && (grant.issuer ?? "operator") === "operator") {
					reg.refreshHooksAfterGitControlWrite(entry.call, entry.decision, verdict);
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
									ruleId: reg.approvalRailOf(entry.decision),
									gateReason: entry.meta.gateReason,
								}),
							}
						: verdict,
				);
			});
		}
		const next = parked[0];
		if (next) reg.notifyPermissionRequired(next.call, next.decision, next.meta);
	};
	return { resumeParkedCalls };
}
