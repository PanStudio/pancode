// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	actionClassWords,
	DECISION_TIER_LABELS,
	SESSION_CODE_CONSENT_RULE_ID,
	SESSION_CODE_CONSENT_TEXT,
	SESSION_CODE_CONSENT_TIER_LABEL,
	SHELL_EGRESS_RULE_ID,
} from "../../core/views/approval-words.js";
import type { AutonomyExposure } from "../../lib/autonomy/autonomy.js";
import { ACTION_CLASSES, type ActionClass } from "./action-classifier.js";

/** Closed consequence categories used only to explain an already-made decision request. */
const DECISION_TIERS = ["conversation", "workspace", "outward", "safety-net", "system", "worker"] as const;

type DecisionTier = (typeof DECISION_TIERS)[number];
type DecisionSemanticToken = "accent" | "action" | "warning";
type DecisionRequestKind = "question" | "permission";
type DecisionAffectedScope = "conversation" | "workspace" | "outside-workspace" | "unknown" | "outward" | "system";

/** How far a call reaches when its class keeps it off this machine's system tier; `unknown` when no fact says. */
type DecisionCallReach = "workspace" | "outside-workspace" | "unknown";
type DecisionReversibility = "reversible" | "limited" | "unknown";
type DecisionAuthorityEffect = "records-answer" | "grants-once";
type DecisionActionId = "record-answer" | "cancel" | "approve-once" | "deny" | "stop";

type DecisionAxis = { kind: "answer" } | { kind: "autonomy"; level: string } | { kind: "safety-net"; ruleId: string };

type DecisionOrigin =
	| { kind: "main" }
	| {
			kind: "worker";
			agentId: string;
			runId: string;
			/** The main turn is waiting on this run, so ending the turn ends the worker too. */
			endsWithTurn?: boolean;
	  };

/**
 * Facts the host has already authenticated or derived from enforced policy.
 * No model-authored title, question, reason, summary, or option label belongs
 * here, so prose has no path to the tier selection.
 */
export interface TrustedDecisionFacts {
	requestKind: DecisionRequestKind;
	axis: DecisionAxis;
	exposure: AutonomyExposure;
	affectedScope: DecisionAffectedScope;
	reversibility: DecisionReversibility;
	origin: DecisionOrigin;
	authorityEffect: DecisionAuthorityEffect;
	tool?: string;
	actionClass?: ActionClass;
	/** The approved call still runs inside an OS sandbox, which the approval does not widen. */
	sandboxed?: true;
	/** How many workers one approval starts, for a dispatch plan of more than one. */
	workers?: number;
}

interface DecisionPresentationAction {
	id: DecisionActionId;
	label: string;
	consequence: string;
}

/**
 * This projection contains display data only. Registry admission and interview
 * settlement never consume it, and it contains no allow, deny, or autonomy
 * disposition that an execution layer could mistake for authority.
 */
export interface DecisionPresentation {
	tier: DecisionTier;
	tierLabel: string;
	title: string;
	/** What is being decided, as a short noun phrase for a title that already names who asks. */
	kind: string;
	semanticToken: DecisionSemanticToken;
	authorizationCopy: string;
	consequenceCopy: string;
	reversibilityCopy: string;
	/** The host fact `reversibilityCopy` words, for a surface that keys a row on it. */
	reversibility?: DecisionReversibility;
	requestedByCopy: string;
	requiredActions: ReadonlyArray<DecisionPresentationAction>;
}

const ACTION_CLASS_SET: ReadonlySet<string> = new Set(ACTION_CLASSES);

/** Unknown or malformed action classes classify conservatively as unknown. */
export function decisionActionClass(value: unknown): ActionClass {
	return typeof value === "string" && ACTION_CLASS_SET.has(value as ActionClass) ? (value as ActionClass) : "unknown";
}

function actionConsequence(
	actionClass: ActionClass,
	reach: DecisionCallReach,
): {
	affectedScope: DecisionAffectedScope;
	reversibility: DecisionReversibility;
} {
	switch (actionClass) {
		case "read":
			return { affectedScope: reach, reversibility: "reversible" };
		case "write":
			// No fact on the ask says a snapshot covers the file (an untracked one may have none), so no undo is promised.
			return { affectedScope: reach, reversibility: "limited" };
		case "execute":
		case "dispatch":
			return { affectedScope: reach, reversibility: "limited" };
		case "destructive":
		case "system_modify":
		case "git_destructive":
		case "unknown":
			return { affectedScope: "system", reversibility: "unknown" };
	}
}

export function decisionFactsForPermission(input: {
	tool: string;
	actionClass: ActionClass;
	axis: Exclude<DecisionAxis, { kind: "answer" }>;
	origin: DecisionOrigin;
	exposure?: AutonomyExposure;
	sandboxed?: true;
	workers?: number;
	/** How far the call reaches (`mainCallReach`); absent, as for a worker ask that carries no path facts, is unknown. */
	reach?: DecisionCallReach;
}): TrustedDecisionFacts {
	const exposure = input.exposure ?? "local";
	const consequence = actionConsequence(input.actionClass, input.reach ?? "unknown");
	return {
		requestKind: "permission",
		axis: input.axis,
		exposure,
		affectedScope: exposure === "outward" ? "outward" : consequence.affectedScope,
		reversibility: exposure === "outward" ? "limited" : consequence.reversibility,
		origin: input.origin,
		authorityEffect: "grants-once",
		tool: input.tool,
		actionClass: input.actionClass,
		...(input.sandboxed === true ? { sandboxed: true as const } : {}),
		...(input.workers !== undefined && input.workers > 1 ? { workers: input.workers } : {}),
	};
}

export function decisionFactsForAnswer(exposure: AutonomyExposure): TrustedDecisionFacts {
	return {
		requestKind: "question",
		axis: { kind: "answer" },
		exposure,
		affectedScope: exposure === "outward" ? "outward" : "conversation",
		reversibility: exposure === "outward" ? "limited" : "reversible",
		origin: { kind: "main" },
		authorityEffect: "records-answer",
	};
}

function classifyTier(facts: TrustedDecisionFacts): DecisionTier {
	if (facts.origin.kind === "worker") return "worker";
	if (facts.affectedScope === "system") return "system";
	if (facts.exposure === "outward" || facts.affectedScope === "outward") return "outward";
	if (facts.axis.kind === "safety-net") return "safety-net";
	if (facts.authorityEffect === "grants-once") return "workspace";
	return "conversation";
}

/** The once-per-session test-runner ask. Approving it covers later test runners, so its copy cannot say "once". */
function isSessionCodeConsent(facts: TrustedDecisionFacts): boolean {
	return (
		facts.origin.kind === "main" && facts.axis.kind === "safety-net" && facts.axis.ruleId === SESSION_CODE_CONSENT_RULE_ID
	);
}

/** The shell-egress ask: approving lets the session's sandboxed commands reach one origin, so its copy cannot say "once". */
function isShellEgress(facts: TrustedDecisionFacts): boolean {
	return facts.origin.kind === "main" && facts.axis.kind === "safety-net" && facts.axis.ruleId === SHELL_EGRESS_RULE_ID;
}

function tierIdentity(
	tier: DecisionTier,
	facts: TrustedDecisionFacts,
): {
	tierLabel: string;
	title: string;
	kind: string;
	semanticToken: DecisionSemanticToken;
} {
	switch (tier) {
		case "conversation":
			return {
				tierLabel: DECISION_TIER_LABELS.conversation,
				title: "Answer a question",
				kind: "question",
				semanticToken: "accent",
			};
		case "workspace":
			return {
				tierLabel: DECISION_TIER_LABELS.workspace,
				...(facts.affectedScope === "outside-workspace"
					? { title: "Approve action outside the workspace", kind: "action outside the workspace" }
					: facts.affectedScope === "workspace"
						? { title: "Approve workspace action", kind: "workspace action" }
						: { title: "Approve action", kind: "action" }),
				semanticToken: "action",
			};
		case "outward":
			return {
				tierLabel: DECISION_TIER_LABELS.outward,
				title: "Confirm outward consequence",
				kind: "outward consequence",
				semanticToken: "warning",
			};
		case "safety-net":
			if (isSessionCodeConsent(facts)) {
				return {
					tierLabel: SESSION_CODE_CONSENT_TIER_LABEL,
					title: "Allow test runners this session",
					kind: "test runner consent",
					semanticToken: "warning",
				};
			}
			return {
				tierLabel: DECISION_TIER_LABELS["safety-net"],
				title: "Safety-net confirmation",
				kind: "safety net check",
				semanticToken: "warning",
			};
		case "system":
			return {
				tierLabel: DECISION_TIER_LABELS.system,
				title: "Approve system change",
				kind: "system change",
				semanticToken: "warning",
			};
		case "worker":
			return {
				tierLabel: DECISION_TIER_LABELS.worker,
				title: "Worker needs approval",
				kind: "worker call",
				semanticToken: "action",
			};
	}
}

function requestedByCopy(facts: TrustedDecisionFacts): string {
	const requester =
		facts.origin.kind === "worker" ? `worker ${facts.origin.agentId} (run ${facts.origin.runId})` : "main agent";
	if (facts.axis.kind === "answer") return requester;
	if (isSessionCodeConsent(facts)) return `${requester} through ${SESSION_CODE_CONSENT_TEXT}`;
	if (facts.axis.kind === "safety-net") return `${requester} through safety-net rail ${facts.axis.ruleId}`;
	return `${requester} through autonomy level (${facts.axis.level})`;
}

/**
 * What an approval of a sandboxed call leaves in place: the OS sandbox it runs
 * in. Approving answers the ask; it does not widen the sandbox's writable roots.
 */
const SANDBOX_STILL_APPLIES = "The call still runs inside the OS sandbox, so a write outside its writable roots fails.";

function authorizationCopy(facts: TrustedDecisionFacts): string {
	if (facts.authorityEffect === "records-answer") {
		return facts.exposure === "outward"
			? "Your response records an answer about an outward step. It does not publish or send anything by itself."
			: "Your response records an answer for this interview. It grants no tool authority.";
	}
	const tool = facts.tool ?? "the presented tool";
	// The class reads as what it does (`runs a command`), the way the card's identity row says it.
	const effect = actionClassWords(facts.actionClass ?? "unknown", facts.workers);
	const contained = facts.sandboxed === true ? ` ${SANDBOX_STILL_APPLIES}` : "";
	if (facts.origin.kind === "worker") {
		return `Approval allows this one call to ${tool}, which ${effect}. An identical call in this worker run asks again. Each call still passes the safety net.${contained} The autonomy level does not change.`;
	}
	if (isSessionCodeConsent(facts)) {
		return `Approval runs this call to ${tool}, which ${effect}, and lets test runners run without asking for the rest of this session. It does not change the autonomy level.`;
	}
	if (isShellEgress(facts)) {
		return `Approval lets this session's sandboxed commands connect to this origin, through PanCode's egress proxy, until the session ends. It does not change the autonomy level.`;
	}
	if (tool === "ask_user" && facts.exposure === "outward") {
		return "Approval opens this one outward-decision interview. It does not publish or send anything by itself.";
	}
	return `Approval allows this one call to ${tool}, which ${effect}.${contained} It does not change the autonomy level.`;
}

function consequenceCopy(facts: TrustedDecisionFacts, tier: DecisionTier): string {
	switch (tier) {
		case "conversation":
			return "The answer stays in this session's decision record.";
		case "workspace":
			if (facts.affectedScope === "outside-workspace")
				return facts.actionClass === "read"
					? "The call reads outside the workspace without changing anything."
					: "The call can affect files or processes outside the workspace.";
			if (facts.affectedScope === "workspace")
				return facts.actionClass === "read"
					? "The call reads within the workspace without mutating it."
					: "The call can affect files or processes inside the workspace.";
			return facts.actionClass === "read"
				? "The call reads without changing anything. PanCode cannot tell whether it stays in the workspace."
				: "The call can affect files or processes. PanCode cannot tell whether they stay in the workspace.";
		case "outward":
			return "The resulting step can reach people or systems outside the workspace.";
		case "safety-net":
			if (isSessionCodeConsent(facts)) {
				return "A test runner executes repository code under your account without a sandbox, whoever wrote it: this session, an earlier one, a worker or a checkout.";
			}
			return "The safety net holds this kind of call for your decision at every autonomy level.";
		case "system":
			return "The call can change state outside the workspace or state the classifier cannot safely bound.";
		case "worker":
			return "A dispatched worker is parked until you answer or its window runs out. This run remembers a denial of exactly this call, and never an approval; other runs are unaffected.";
	}
}

function reversibilityCopy(facts: TrustedDecisionFacts): string {
	if (facts.requestKind === "question") {
		return facts.reversibility === "reversible"
			? "Reversible: yes. The recorded answer can be superseded later."
			: "Reversible: not guaranteed. An outward step that later uses this answer may have lasting effects.";
	}
	if (facts.actionClass === "read" && facts.reversibility === "reversible") {
		return "Reversible: yes. This call does not mutate the workspace.";
	}
	switch (facts.reversibility) {
		case "reversible":
			return "Reversible: yes. Workspace changes can be reviewed and reverted.";
		case "limited":
			return "Reversible: not guaranteed. Effects that already ran, or that reached anything outside this machine, may remain.";
		case "unknown":
			return "Reversible: unknown. Treat the effect as not safely reversible.";
	}
}

function requiredActions(facts: TrustedDecisionFacts, tier: DecisionTier): ReadonlyArray<DecisionPresentationAction> {
	if (facts.authorityEffect === "records-answer") {
		return [
			{
				id: "record-answer",
				label: facts.exposure === "outward" ? "Record outward answer" : "Record answer",
				consequence: "Records the selected or typed answer without granting tool authority.",
			},
			{ id: "cancel", label: "Cancel", consequence: "Closes the interview without recording an answer for this round." },
		];
	}
	const sessionConsent = isSessionCodeConsent(facts);
	const shellEgress = isShellEgress(facts);
	const approveLabel = sessionConsent
		? "Approve test runners for this session"
		: shellEgress
			? "Allow this origin for this session"
			: tier === "system"
				? "Approve system change once"
				: tier === "safety-net"
					? "Approve guarded action once"
					: tier === "worker"
						? "Approve this worker call once"
						: tier === "outward"
							? "Approve this outward call once"
							: facts.affectedScope === "workspace"
								? "Approve workspace action once"
								: "Approve action once";
	const stopConsequence =
		facts.origin.kind === "worker"
			? facts.origin.endsWithTurn === true
				? "Denies this worker request and ends the main-agent turn, which also stops this worker because the turn is waiting on it. Other worker requests still wait for you."
				: "Denies this worker request and ends any active main-agent turn. This worker keeps running without the call, and other worker requests still wait for you."
			: "Denies every request waiting in this turn and ends the turn.";
	return [
		{
			id: "approve-once",
			label: approveLabel,
			consequence:
				facts.origin.kind === "worker"
					? "Runs only this request. An identical call in this worker run asks again."
					: sessionConsent
						? "Runs the presented request and lets test runners run without asking until this session ends."
						: shellEgress
							? "Lets this session's sandboxed commands connect to this origin until the session ends."
							: "Runs only the presented request and does not change the autonomy level.",
		},
		{
			id: "deny",
			label: "Deny this request",
			consequence:
				facts.origin.kind === "worker"
					? "Denies this request and refuses identical calls under the same permission conditions in this worker run without asking."
					: sessionConsent
						? "Denies only the presented request; the next test runner asks again."
						: shellEgress
							? "Refuses this origin to this session's sandboxed commands without asking again."
							: "Denies only this call. PanCode continues the turn without it, and the next waiting request, if any, comes up.",
		},
		{ id: "stop", label: "Deny and stop", consequence: stopConsequence },
	];
}

/** Pure presentation classifier. It performs no I/O and has no execution authority. */
export function classifyDecisionPresentation(facts: TrustedDecisionFacts): DecisionPresentation {
	const tier = classifyTier(facts);
	return {
		tier,
		...tierIdentity(tier, facts),
		authorizationCopy: authorizationCopy(facts),
		consequenceCopy: consequenceCopy(facts, tier),
		reversibilityCopy: reversibilityCopy(facts),
		reversibility: facts.reversibility,
		requestedByCopy: requestedByCopy(facts),
		requiredActions: requiredActions(facts, tier),
	};
}
