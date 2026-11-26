// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The approval card's words, one source for the terminal card, the ACP decision facts and the GUI card. Pure and
 * browser-safe: the GUI client imports this module directly, so it imports nothing.
 */

/** The rail id the session test-runner consent ask carries, so the card, the audit row and the approval note name it. */
export const SESSION_CODE_CONSENT_RULE_ID = "session-code-consent";

/** The rail as the card, the parked row and the grant row name it. */
export const SESSION_CODE_CONSENT_TEXT = "session test-runner consent";

/** A safety-net rail as the parked row, the grant row, the notice and the GUI card name it. */
export function safetyNetRailText(ruleId: string): string {
	if (ruleId === SESSION_CODE_CONSENT_RULE_ID) return SESSION_CODE_CONSENT_TEXT;
	return `safety net: ${ruleId.replaceAll("-", " ")}`;
}

/** What an action class means, in words for an operator; the class itself stays in /view and the audit rows. */
const ACTION_CLASS_WORDS: Readonly<Record<string, string>> = {
	read: "reads files",
	write: "writes files",
	execute: "runs a command",
	dispatch: "starts a worker",
	system_modify: "changes the system",
	git_destructive: "discards git work",
	destructive: "deletes data",
	unknown: "has no known effect",
};

/** `workers` is how many runs one approval starts, so a dispatch plan of several reads `starts 2 workers`. */
export function actionClassWords(actionClass: string, workers = 1): string {
	if (actionClass === "dispatch" && workers > 1) return `starts ${workers} workers`;
	return ACTION_CLASS_WORDS[actionClass] ?? actionClass.replaceAll("_", " ");
}

/** A dispatch plan as its headline reads it: the shape, who runs, and the one task they share, if any. */
export interface DispatchPlanHeadlineFacts {
	topology: string;
	/** `label` is the council label or role the plan gives a worker, when it has one. */
	members: ReadonlyArray<{ label: string | null; agent: string }>;
	sharedTask: string | null;
}

/**
 * One sentence for what a dispatch plan does, where a card names the call: the terminal card's target, and the ACP
 * ask's title the GUI shows as its heading, target and announcement. A shared task is named in it, because the card
 * pins this sentence beside the answer keys and a council card must say what the council would be asked.
 */
export function dispatchPlanHeadline(plan: DispatchPlanHeadlineFacts): string {
	const count = plan.members.length;
	const workers = `${count} ${count === 1 ? "worker" : "workers"}`;
	const labels = plan.members.map((member) => member.label ?? member.agent).join(", ");
	const task = plan.sharedTask;
	switch (plan.topology) {
		case "council":
			return task !== null
				? `Council of ${count} (${labels}) answers: ${task}`
				: `Council of ${count} (${labels}) answers the same task`;
		case "compete":
			return task !== null
				? `${workers} compete on: ${task}; you pick the result to keep`
				: `${workers} compete on the same task; you pick the result to keep`;
		case "sequential":
			return `${workers} run one after another`;
		case "pipeline":
			return `${workers} run as a pipeline, each taking the last one's result`;
		case "review":
			return "A worker runs and a reviewer checks its result";
		case "detached":
			return `${workers} start in the background`;
		default:
			return `${workers} run in parallel`;
	}
}

/** The effect row of a command PanCode cannot read, on the terminal and the GUI card alike. */
export const UNREAD_COMMAND_EFFECT =
	"PanCode cannot tell what this command changes. Read the command before you allow it.";

/** Each decision tier's label, as the card's identity and the ACP `tierLabel` carry it. */
export const DECISION_TIER_LABELS = {
	conversation: "Conversational answer",
	workspace: "Workspace authority",
	outward: "Outward consequence",
	"safety-net": "Safety-net confirmation",
	system: "System change",
	worker: "Worker escalation",
} as const;

/** The session test-runner consent's tier label: approving it covers later runs, so it is not a plain safety net. */
export const SESSION_CODE_CONSENT_TIER_LABEL = "Test runner consent";

export function decisionTierLabel(tier: string): string {
	return (DECISION_TIER_LABELS as Readonly<Record<string, string>>)[tier] ?? tier;
}

const REVERSIBILITY_WORDS: Readonly<Record<string, string>> = {
	reversible: "reversible",
	limited: "not guaranteed",
	unknown: "unknown, treat as permanent",
};

/** Whether a call can be undone, in the words of the card's undo row. */
export function reversibilityWords(reversibility: string): string {
	return REVERSIBILITY_WORDS[reversibility] ?? reversibility;
}

/**
 * Who may discharge a worker's ask, lower case to follow a row label. `authority` is the grant the ask carries; none
 * means worker approvals are set to Ask me. `fromJudge` marks an ask the safety judge passed on because git hooks
 * changed.
 */
export function workerAuthorityWords(
	authority: "main" | "operator" | undefined,
	forwardedByMain: boolean,
	fromJudge: boolean,
): string {
	if (authority === undefined) {
		return "yours alone. Worker approvals are set to Ask me, so the main agent cannot answer this for you.";
	}
	if (authority === "operator")
		return "operator only. This rail is not the main agent's to grant; your answer decides it.";
	if (fromJudge) return "yours alone. Git hooks changed, so the safety judge does not decide this call.";
	return forwardedByMain
		? "the main agent approved this worker request and, below yolo, asks you to decide."
		: "the main agent may decide this ordinary worker request.";
}

/**
 * What an unanswered ask does when its window ends. The terminal denies a main call and the turn continues
 * (`safety.unattendedAfterSeconds`); the GUI's own budget stops the turn (`PERMISSION_TIMERS` in its ACP server); a
 * worker ask applies the worker's fallback on either surface.
 */
export type UnansweredOutcome = "deny-continue" | "stop-turn" | "worker-deny" | "worker-fail";

const UNANSWERED_WORDS: Readonly<Record<UnansweredOutcome, string>> = {
	"deny-continue": "denies this call and PanCode continues without it",
	"stop-turn": "stops this turn; the call does not run",
	"worker-deny": "denies this call; the worker carries on without it",
	"worker-fail": "denies this call and fails the worker run",
};

/** The countdown sentence every approval card prints; `left` is the time remaining in the surface's own clock. */
export function unansweredWords(left: string, outcome: UnansweredOutcome): string {
	return `No answer in ${left} ${UNANSWERED_WORDS[outcome]}.`;
}
