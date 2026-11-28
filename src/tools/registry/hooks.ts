// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { ToolName } from "../../core/tool-names.js";
import { effectiveToolCall } from "../../core/tool-surface.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookResult,
	ToolCallLanding,
} from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { approvalAxisId } from "../../domains/safety/approval-axis.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import type { ToolResultDigest } from "../result-disposition.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import { disposeAdmissionArgs, hookLanding, prepareAdmissionCall } from "./call-prep.js";
import type { ApprovalCarry, ToolBoundaryReminder, ToolInvokeOptions } from "./contract.js";
import { buildToolHookInput, firstBlockToolEffect, noteGuardRule } from "./hook-effects.js";
import type { AdmitOutcome, RegistryScope } from "./scope.js";
import { HOOK_APPROVAL_RULE_ID } from "./verdicts.js";

/**
 * A registry call's before_tool and after_tool hooks: the input they read, the effects and rewrites they return,
 * the approval a hook asks for, and the boundary reminders they pass on.
 */
export function createRegistryHooks(reg: RegistryScope) {
	const { deps, tools, boundaryReminderListeners } = reg;
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
		const outcome = reg.admit(admitted, carried, options);
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
	return { hookApprovalOutcome, runToolHook, admitRewrite, judgeRewrite, runAwaitedToolHook };
}
