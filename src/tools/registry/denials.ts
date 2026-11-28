// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { HEADLESS_PERMISSION_DENIED_MARKER } from "../../core/headless-permission.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall } from "../../core/tool-surface.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { type DenialLayer, repeatedDenialReason, type ToolDenial } from "../../domains/safety/denial.js";
import { hashToolCall } from "../../domains/safety/loop-detector.js";
import { UNATTENDED_ALLOWED_BY } from "../../domains/safety/unattended.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import type { RegistryVerdict, ToolInvokeOptions, ToolRegistry } from "../registry-contract.js";
import { withRegistryScope } from "../registry-nested-calls.js";
import {
	askUserAnswered,
	blockDecision,
	CONTAINED_YOLO_ALLOWED_BY,
	CONTAINED_YOLO_REASON,
	DENIED_CALL_MEMORY_LIMIT,
	DENIED_REPEAT_REASON_CODE,
	ESCAPE_SCOPE_ALLOWED_BY,
	NO_PARK_LISTENER_REASON,
	operatorAnswers,
} from "../registry-verdicts.js";
import type { RegistryScope } from "./scope.js";

/**
 * A registry's refusals: the structured denial a verdict carries, the escape refusals left out of the loop guard,
 * and the main agent's memory of refused calls, which invokeSingle keeps around each call.
 */
export function createRegistryDenials(reg: RegistryScope) {
	const { deps } = reg;
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
			if (deps.principal === "worker") return reg.invokeAdmitted(call, options);
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
				reg.recordRegistryDisposition(call, decision, "blocked", { reasonCode: DENIED_REPEAT_REASON_CODE });
				return reg.observeBlockedAttempt(call, repeat, options) ?? repeat;
			}
			const verdict = await reg.invokeAdmitted(call, options);
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
	return { withDenial, parkDenial, escapeAnswerable, firstEscapeRefusal, deniedCalls, invokeSingle };
}
