// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { EgressOrigin } from "../core/sandbox/egress/policy.js";
import { egressGrants, originKey } from "../core/sandbox/egress/policy.js";
import type { MainSandboxPolicy } from "../core/sandbox/main-session.js";
import { ToolNames } from "../core/tool-names.js";
import { SHELL_EGRESS_RULE_ID } from "../core/views/approval-words.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { evaluateAdmission } from "../domains/safety/admission.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { PermissionRequiredMeta, RegistryDeps, RegistryVerdict, ToolInvokeOptions } from "./registry-contract.js";
import { withRegistryScope } from "./registry-nested-calls.js";
import { PARK_ABORT_REASON } from "./registry-verdicts.js";

const WITHDRAWN_REASON = "the command ended before anyone answered its network access ask";
const DENY_HINT = "Denying is remembered for this session.";

/** A call parked on the approval queue for an ask only the operator answers. */
export interface OperatorAskEntry {
	call: ClassifierCall;
	decision: SafetyDecision;
	meta: PermissionRequiredMeta;
	resolve(verdict: RegistryVerdict): void;
	closePark(): void;
	options?: ToolInvokeOptions;
	abortCleanup?: () => void;
	/** Settles the ask once the operator approves it, in place of the registry's own resume. */
	approve?(requestedBy: string | undefined): void;
}

/** The registry's approval queue, as the operator-only asks use it. */
export interface OperatorAskQueue {
	parked: OperatorAskEntry[];
	/** True while a surface listens for approval cards. */
	cardsRendered(): boolean;
	nextRequestId(): string;
	cancel(requestId: string, reason: string): void;
	record(
		call: ClassifierCall,
		decision: SafetyDecision,
		disposition: "allowed" | "blocked" | "permission_requested",
		overrides?: { reasonCode?: string; requestId?: string },
	): void;
	notify(call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta): void;
}

/** Parks an operator-only ask: a run abort cancels it, and it is recorded as requested and shown on the card. */
export function enqueueOperatorAsk(queue: OperatorAskQueue, entry: OperatorAskEntry, reasonCode: string): void {
	const signal = entry.options?.signal;
	if (signal !== undefined) {
		const abort = () => queue.cancel(entry.meta.requestId, PARK_ABORT_REASON);
		signal.addEventListener("abort", abort, { once: true });
		entry.abortCleanup = () => signal.removeEventListener("abort", abort);
	}
	queue.parked.push(entry);
	queue.record(entry.call, entry.decision, "permission_requested", { requestId: entry.meta.requestId, reasonCode });
	queue.notify(entry.call, entry.decision, entry.meta);
}

/**
 * `safety.egress.main` for the main session's contained shells, with the
 * attended live ask (D10). Origins the operator allowed or refused are kept
 * per session and end with it.
 */
export function createShellEgress(
	deps: Pick<
		RegistryDeps,
		"sandboxEgress" | "currentSessionId" | "principal" | "operatorAttends" | "unattendedAsks" | "safety"
	>,
	queue: OperatorAskQueue,
) {
	const sessions = new Map<string, { granted: Set<string>; denied: Set<string> }>();
	/** One live ask per origin per session, shared by every launch waiting on it. */
	const asks = new Map<string, { settled: Promise<boolean>; waiters: number; withdraw(): void }>();
	const sessionKey = (options: ToolInvokeOptions | undefined) => options?.sessionId ?? deps.currentSessionId?.() ?? "";
	const session = (options: ToolInvokeOptions | undefined) => {
		const key = sessionKey(options);
		let state = sessions.get(key);
		if (state === undefined) {
			state = { granted: new Set(), denied: new Set() };
			sessions.set(key, state);
		}
		return state;
	};

	/** Settles true on approval, false on a denial or an unanswered card, null once withdrawn. */
	const park = (
		origin: EgressOrigin,
		key: string,
		options: ToolInvokeOptions | undefined,
	): { answer: Promise<boolean | null>; withdraw(): void } => {
		const url =
			origin.port === 443
				? `https://${origin.host}/`
				: origin.port === 80
					? `http://${origin.host}/`
					: `tcp://${origin.host}:${origin.port}`;
		const call: ClassifierCall = Object.freeze({ tool: ToolNames.WebRead, args: Object.freeze({ url }) });
		const detail = `Allow your session's sandboxed commands to connect to ${key}? Approving lasts until this session ends; safety.egress.main.allow grants it for good.`;
		const admission = evaluateAdmission({
			principal: "main",
			effects: [call],
			safety: deps.safety,
			autonomy: "default",
			confirmationRuleId: SHELL_EGRESS_RULE_ID,
			confirmationText: { detail, hints: [DENY_HINT] },
		});
		if (admission.kind !== "ask") {
			if (admission.kind === "deny") queue.record(call, admission.decision, "blocked");
			return { answer: Promise.resolve(false), withdraw: () => {} };
		}
		const decision: SafetyDecision = {
			...admission.decision,
			kind: "ask",
			confirmationRuleId: SHELL_EGRESS_RULE_ID,
			rejection: { short: `Sandboxed command wants network access: ${key}`, detail, hints: [DENY_HINT] },
		};
		const meta: PermissionRequiredMeta = {
			requestId: queue.nextRequestId(),
			axis: `net:${SHELL_EGRESS_RULE_ID}`,
			approvalAuthority: "operator",
			...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
			...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
		};
		const reasonCode = `confirmation:${SHELL_EGRESS_RULE_ID}`;
		let withdrawn = false;
		const answer = new Promise<boolean | null>((resolve) => {
			const entry: OperatorAskEntry = {
				call,
				decision,
				meta,
				closePark: () => {},
				...(options !== undefined ? { options } : {}),
				resolve(verdict) {
					resolve(withdrawn ? null : verdict.kind === "ok" && verdict.result.kind === "ok");
				},
				approve(requestedBy) {
					queue.record(call, decision, "allowed", { requestId: meta.requestId, reasonCode });
					entry.resolve(egressApprovedVerdict(decision, meta.requestId, requestedBy));
				},
			};
			enqueueOperatorAsk(queue, entry, reasonCode);
		});
		return {
			answer,
			withdraw() {
				withdrawn = true;
				queue.cancel(meta.requestId, WITHDRAWN_REASON);
			},
		};
	};

	/**
	 * The live ask: a contained command's connection to an origin outside its
	 * grants waits while the operator decides on the approval card every
	 * surface already renders. Approving grants that exact origin to the
	 * session's contained commands until the session ends; a denial, the
	 * card's unattended window or a cancelled call is remembered as a denial
	 * for the session. Once every launch waiting on the ask has ended, the card
	 * is withdrawn and nothing is remembered, so the next command asks again.
	 * Workers, headless runs and contained yolo, which nobody answers, are
	 * refused at once.
	 */
	const requestApproval = async (
		origin: EgressOrigin,
		launchEnded: AbortSignal,
		options: ToolInvokeOptions | undefined,
	): Promise<boolean> => {
		const key = originKey(origin);
		const state = session(options);
		if (state.granted.has(key)) return true;
		if (state.denied.has(key)) return false;
		if (
			(deps.principal ?? "main") !== "main" ||
			options?.signal?.aborted === true ||
			launchEnded.aborted ||
			!queue.cardsRendered() ||
			deps.operatorAttends?.() !== true ||
			deps.unattendedAsks?.() === true
		)
			return false;
		const askKey = `${sessionKey(options)}\u0000${key}`;
		let pending = asks.get(askKey);
		if (pending === undefined) {
			const parkedAsk = withRegistryScope(options, () => park(origin, key, options));
			const settled = parkedAsk.answer.then((answer) => {
				asks.delete(askKey);
				if (answer !== null) (answer ? state.granted : state.denied).add(key);
				return answer === true;
			});
			pending = { settled, waiters: 0, withdraw: parkedAsk.withdraw };
			asks.set(askKey, pending);
		}
		const ask = pending;
		ask.waiters += 1;
		let ended = (): void => {};
		const launchGone = new Promise<false>((resolve) => {
			ended = () => {
				ask.waiters -= 1;
				if (ask.waiters === 0) ask.withdraw();
				resolve(false);
			};
			launchEnded.addEventListener("abort", ended, { once: true });
		});
		try {
			return await Promise.race([ask.settled, launchGone]);
		} finally {
			launchEnded.removeEventListener("abort", ended);
		}
	};

	return {
		/**
		 * `safety.egress.main` on a contained call's policy: off loses the
		 * network, open keeps the host's, proxied reaches only PanCode's proxy
		 * with the operator's grants and the origins approved this session, and
		 * asks the operator about any other while the call runs.
		 */
		apply(policy: MainSandboxPolicy, options: ToolInvokeOptions | undefined): MainSandboxPolicy {
			const settings = deps.sandboxEgress?.();
			if (settings === undefined || settings.main.mode === "open") return policy;
			if (settings.main.mode === "off") return { ...policy, network: false };
			return {
				...policy,
				egress: {
					grants: egressGrants(settings.main.allow, settings.main.presets, session(options).granted),
					ask: (origin, launchEnded) => requestApproval(origin, launchEnded, options),
					denyHint:
						"the operator can allow it when asked, or grant it for good in safety.egress.main.allow or safety.egress.main.presets",
					...(settings.upstreamProxy !== null ? { upstreamProxy: settings.upstreamProxy } : {}),
				},
			};
		},
	};
}

/** The verdict an operator's approval of a parked egress ask settles with. */
function egressApprovedVerdict(
	decision: SafetyDecision,
	requestId: string,
	requestedBy: string | undefined,
): RegistryVerdict {
	return {
		kind: "ok",
		decision,
		result: {
			kind: "ok",
			output: "Network access approved for this session's sandboxed commands.",
			details: { requestId, requestedBy },
		},
	};
}
