// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { type ToolName, ToolNames } from "../../core/tool-names.js";
import { type TurnConstraints, toolSurfaceSources, turnAllowsTool } from "../../core/turn-constraints.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { type AdmissionDisposition, evaluateAdmission } from "../../domains/safety/admission.js";
import { approvalAxisId } from "../../domains/safety/approval-axis.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { asksToLeaveSandbox } from "../../domains/safety/sandbox-escape.js";
import {
	missingUnsandboxedReason,
	UNSANDBOXED_REASON_ARG,
	UNSANDBOXED_REASON_REQUIRED_CODE,
} from "../../domains/safety/unsandboxed-reason.js";
import { YOLO_FLOOR_REASON_PREFIX } from "../../domains/safety/yolo-floor.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import { type DispatchPlanView, describeDispatchPlan } from "../dispatch-plan.js";
import { applyRegisteredToolClassification } from "../registry-call-prep.js";
import type { OneShotGrant, RegistryVerdict, ToolInvokeOptions } from "../registry-contract.js";
import {
	blockDecision,
	blockedVerdict,
	HOST_READ_ONLY_SOURCES,
	readOnlyDeniedVerdict,
	sessionConsentParkDecision,
	skillSurfaceBlockedVerdict,
	toDispatchPlanAskDecision,
} from "../registry-verdicts.js";
import type { ToolSpec } from "../tool-spec.js";
import type { AdmitOutcome, ContainedRoots, RegistryScope, SessionConsentObstacle } from "./scope.js";

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
 * A registry call's admission: the shared evaluator's disposition, the verdict admit returns, the hard
 * denial past the safety net, and the host commands a call runs on its caller's behalf.
 */
export function createRegistryAdmission(reg: RegistryScope) {
	const { deps, tools } = reg;
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
			...reg.withOperatorScope(level, deps.readOnly === true || options?.turnConstraints?.readOnly === true),
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
			reg.recordRegistryDisposition(call, admission.decision, "blocked");
			const policy = admission.decision.policy;
			const allowedBy =
				policy?.policySource === "project-policy"
					? `the project's safety policy${policy.ruleId !== undefined ? ` rule ${policy.ruleId}` : ""} must change, which only the operator can do.`
					: policy?.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX) === true
						? "nothing within this run; it is the yolo floor, which holds at every autonomy level."
						: "nothing within this run; it is a hard block of PanCode's safety net.";
			return {
				kind: "terminal",
				verdict: reg.withDenial(
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
			reg.recordRegistryDisposition(call, unstated.decision, "blocked", { reasonCode: UNSANDBOXED_REASON_REQUIRED_CODE });
			const allowedBy = `the same call with ${UNSANDBOXED_REASON_ARG} set; the operator then decides on an approval card.`;
			return {
				kind: "terminal",
				verdict: reg.withDenial(unstated, "pancode_policy", allowedBy, UNSANDBOXED_REASON_REQUIRED_CODE),
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
			reg.recordRegistryDisposition(call, allowed, "allowed");
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
			reg.recordRegistryDisposition(call, verdict.decision, "denied", { reasonCode });
			return reg.withDenial(
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
			reg.recordRegistryDisposition(call, verdict.decision, "blocked", {
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
			reg.recordRegistryDisposition(call, blocked, "blocked", { reasonCode: "turn_constraint" });
			return reg.withDenial(
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
			reg.recordRegistryDisposition(call, decision, "blocked", { reasonCode: "classification:git_destructive" });
			return reg.withDenial(
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
		reg.recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return reg.withDenial(
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
			const admission = reg.admitHostEffect(effect.call, level, reg.hostEffectScope(effect.call, level));
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
			contained = reg.containedEffectsSandbox(effects, level);
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
		reg.recordRegistryDisposition(call, blocked, "blocked", { reasonCode });
		return { obstacle: { kind: "terminal", verdict: { kind: "blocked", reason, decision: blocked } }, contained: null };
	};
	return { evaluateCallAdmission, admit, deniedVerdict };
}
