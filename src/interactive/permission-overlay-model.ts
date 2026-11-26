// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What a permission card says about a parked call: the risk tone, the decision presentation and the answers it
 * offers with their consequences, the countdown words, and the rail title, tone and hint around the card. The card
 * rows draw these; the body in `permission-overlay.ts` owns the keyboard, the scroll and the frame.
 */

import { formatCountdown } from "../core/format-time.js";
import { SESSION_CODE_CONSENT_RULE_ID, workerAuthorityWords } from "../core/views/approval-words.js";
import type { ActionClass } from "../domains/safety/action-classifier.js";
import { credentialedCallKind } from "../domains/safety/call-consequence.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
} from "../domains/safety/decision-presentation.js";
import { visibleWidth } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import { approvedWorkers, readDispatchPlan } from "./dispatch-plan-summary.js";
import { fitHintEntries } from "./overlay-frame.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_SESSION_SCOPE_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	type PermissionChoicesHint,
	type PermissionInspectionHint,
	type PermissionTermsHint,
	permissionHintEntries,
	permissionKeyLabel,
} from "./permission-hint.js";
import type { HarnessFunction, PancodeToken, Tone } from "./theme/index.js";
import { type choiceRows, GLYPH } from "./theme/index.js";

/**
 * Milliseconds before an unanswered card denies itself (#421), `held` once the
 * operator is present, null when no window applies.
 */
export type PermissionCountdown = number | "held" | null;

/**
 * A worker ask whose window the dispatching process runs, so a key can hold it.
 * A bare number on a worker card is a window inside the worker, which no key
 * reaches. A held window still ends, at its ceiling, so it keeps its time left.
 */
export interface WorkerWindowCountdown {
	remainingMs: number;
	held: boolean;
}

/** What a card's timer row is drawn from. */
export type CardCountdown = PermissionCountdown | WorkerWindowCountdown;

export function isWorkerWindow(countdown: CardCountdown): countdown is WorkerWindowCountdown {
	return typeof countdown === "object" && countdown !== null;
}

/** A held window turns back into a warning this close to its ceiling. */
export const HELD_WINDOW_WARNING_MS = 60_000;

/**
 * The risk a call carries, as the tone its action chip and its command gutter
 * take. Red is reserved for what the classifier cannot bound or undo; amber
 * for execution and dispatch, whose effects may already have run; orange for a
 * workspace write, which can be reviewed and reverted; cyan for a read. An
 * outward exposure never reads below amber, whatever the class.
 */
export function permissionRiskTone(actionClass: ActionClass, exposure?: ApprovalRequestView["exposure"]): Tone {
	const base: Tone =
		actionClass === "read"
			? "info"
			: actionClass === "write"
				? "action"
				: actionClass === "execute" || actionClass === "dispatch"
					? "warning"
					: "error";
	if (exposure === "outward" && (base === "info" || base === "action")) return "warning";
	return base;
}

export const FUNCTION_GLYPH: Readonly<Record<HarnessFunction, string>> = {
	builtin: GLYPH.toolHeader,
	shell: GLYPH.classExecute,
	mutation: GLYPH.classMutate,
	network: GLYPH.classNetwork,
	dispatch: GLYPH.workerAgent,
	shadowDispatch: GLYPH.workerAgent,
	skill: GLYPH.classKnowledge,
	mcp: GLYPH.classExternal,
	extension: GLYPH.classExternal,
	context: GLYPH.classKnowledge,
	decision: GLYPH.classInteraction,
	artifact: GLYPH.classExternal,
};

/** The card line for a worker ask routed through the main agent, or null for every other card. */
export function workerGrantAuthority(view: ApprovalRequestView): string | null {
	const grant = view.workerGrant;
	if (grant === undefined && view.origin.kind !== "worker") return null;
	return workerAuthorityWords(grant?.authority, grant?.forwardedByMain === true, grant?.fromJudge === true);
}

export function permissionDecisionPresentation(view: ApprovalRequestView): DecisionPresentation {
	return classifyDecisionPresentation(
		decisionFactsForPermission({
			tool: view.tool,
			actionClass: view.actionClass,
			axis:
				view.axis.kind === "net"
					? { kind: "safety-net", ruleId: view.axis.ruleId }
					: { kind: "autonomy", level: view.axis.level },
			origin: view.origin,
			...(view.exposure !== undefined ? { exposure: view.exposure } : {}),
			...(view.sandboxed === true ? { sandboxed: true as const } : {}),
			...(view.reach !== undefined ? { reach: view.reach } : {}),
			workers: approvedWorkers(view),
		}),
	);
}

/**
 * The clock each card last drew, for the top rule: one deadline record drives the rule, the pinned timer row and the
 * position clause, so the rule never says a time the card does not. Keyed by the view the lifecycle hands both.
 */
export const railClocks = new WeakMap<ApprovalRequestView, string | null>();

export function railClock(countdown: CardCountdown): string | null {
	if (countdown === null) return null;
	if (countdown === "held") return "held";
	return formatCountdown(isWorkerWindow(countdown) ? countdown.remainingMs : countdown);
}

/**
 * The top rule's unit for one decision: `needs approval · 3:32 · <actor>`, with the kind of call and the queue
 * position while they fit. Narrower, the actor goes, then the words, so the clock is the last thing standing.
 */
export function permissionRailTitle(
	view: ApprovalRequestView,
	context: { actor: string; room: number; queueDepth?: number },
): string {
	const presentation = permissionDecisionPresentation(view);
	const who =
		view.origin.kind === "worker" ? `worker ${view.origin.agentId}` : context.actor.length > 0 ? context.actor : "Panos";
	const depth = context.queueDepth ?? view.queueDepth ?? 0;
	const count = depth > 1 ? ` ${GLYPH.sep} 1 of ${depth}` : "";
	const clock = railClocks.get(view) ?? null;
	const lead = clock === null ? "needs approval" : `needs approval ${GLYPH.sep} ${clock}`;
	// A worker's identity row already names the worker call; the kind is for the main agent's asks.
	const kind = view.origin.kind === "worker" ? null : (credentialedCallKind(view.consequence) ?? presentation.kind);
	const candidates = [
		...(kind === null ? [] : [`${lead} ${GLYPH.sep} ${kind} ${GLYPH.sep} ${who}${count}`]),
		`${lead} ${GLYPH.sep} ${who}${count}`,
		`${lead}${count}`,
		lead,
		...(clock === null ? [] : [clock]),
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= context.room) ?? clock ?? "needs approval";
}

export function permissionOverlayTone(_view: ApprovalRequestView): PancodeToken {
	return "pendingAnswer";
}

/**
 * The footer for a box `innerWidth` columns wide inside its borders. The
 * three columns the bottom border spends on `─ ` and the trailing space come
 * off the top, which is what `buildResponsiveHint` does for every other frame.
 */
export function permissionOverlayHint(
	innerWidth: number,
	composerHasDraft = false,
	inspection: PermissionInspectionHint = "none",
	terms: PermissionTermsHint = "closed",
	scrollable = false,
	choicesShown = true,
	stopVerb?: string,
	readingKeysShown = false,
): string {
	// The rail always carries the answer keys. Under the card view it also says where the choices are: on screen,
	// or scrolled out of view, when `[↓] read choices` takes Enter's place because Enter does nothing until they show.
	const layer = inspection === "open" || terms === "open";
	const choices: PermissionChoicesHint | undefined = layer ? undefined : choicesShown ? "on-card" : "below";
	const entries = permissionHintEntries(composerHasDraft, inspection, terms, scrollable, stopVerb, choices);
	// A narrow card names the terms and inspect keys in its own choice rows, so the rail does not repeat them.
	const onCard = new Set<string>(
		choicesShown && readingKeysShown && !layer
			? [permissionKeyLabel(PERMISSION_TERMS_KEY), permissionKeyLabel(MUTATION_PREVIEW_KEY)]
			: [],
	);
	return fitHintEntries(
		entries.filter((entry) => !onCard.has(entry.key)),
		innerWidth - 3,
	);
}

/** The tools whose parked call mutates a file, so a card without a preview owes the operator a reason. */
export function isFileMutationTool(tool: string): boolean {
	return tool === "write" || tool === "edit";
}

export function actionConsequence(presentation: DecisionPresentation, id: "deny" | "stop"): string {
	return presentation.requiredActions.find((action) => action.id === id)?.consequence ?? "";
}

/**
 * What each key does, in one clause each, for the folded card. These are the
 * facts `termsSummary` used to join into one sentence: allow runs this one
 * call (or, for a worker, holds for identical calls in its run; for the test
 * runner consent, covers later runners this session), deny skips it, stop ends
 * the turn. The full terms behind the terms key say the same at length.
 */
export function permissionChoices(
	view: ApprovalRequestView,
	presentation: DecisionPresentation,
	hasDraft: boolean,
	mainTurn?: boolean,
): Parameters<typeof choiceRows>[1] {
	const stopWords = "ends the turn";
	const draftNote = hasDraft ? ` ${GLYPH.sep} clear your draft with Backspace first` : "";
	// Approving answers the ask and leaves the sandbox as it is: a write outside its roots fails all the same.
	const runs =
		view.sandboxed === true ? "runs this one call in the sandbox; outside writes still fail" : "runs this one call";
	if (presentation.tier === "worker") {
		// An approval is never remembered, only a denial (`deniedEscalations` in the
		// worker runtime, F8). The stop key does not reach the worker's process
		// unless the turn it ends is the one waiting on this worker.
		const endsWithTurn = mainTurn !== false && view.origin.kind === "worker" && view.origin.endsWithTurn === true;
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `${runs}; an identical call asks again${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; an identical call in this run is refused without asking" },
			{
				key: permissionKeyLabel(PERMISSION_STOP_KEY),
				verb: "stop",
				// A worker asks while the main agent is often idle, and a key cannot end a turn that is not running.
				consequence: endsWithTurn
					? "denies it and ends the main turn, which also stops this worker"
					: mainTurn === undefined
						? "denies it and ends any main turn; this worker keeps running"
						: mainTurn
							? "denies it and ends the main turn; this worker keeps running"
							: "denies it; no main turn is running, and this worker keeps running",
				tone: "error",
			},
		];
	}
	if (view.axis.kind === "net" && view.axis.ruleId === SESSION_CODE_CONSENT_RULE_ID) {
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `runs it, and later test runners this session${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; the next test runner asks again" },
			{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
		];
	}
	if (view.artifact?.kind === "settings-change") {
		return [
			{ key: "Enter", verb: "allow", consequence: `saves this change to your settings${draftNote}` },
			{ key: "Esc", verb: "deny", consequence: "skips it; nothing is saved" },
			{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
		];
	}
	if (view.artifact !== undefined) {
		const plan = view.artifact.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
		const count = plan?.members.length ?? 0;
		const workers =
			count === 1
				? "the worker"
				: count === 2
					? "both workers"
					: count > 2
						? `all ${count} workers`
						: "every worker in the plan";
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: hasDraft ? `starts ${workers} after you clear the draft` : `starts ${workers} now`,
			},
			{ key: "Esc", verb: "deny", consequence: "PanCode continues without this dispatch" },
			{
				key: permissionKeyLabel(PERMISSION_STOP_KEY),
				verb: "stop",
				consequence: "denies this call and ends the turn",
				tone: "error",
			},
		];
	}
	return [
		{ key: "Enter", verb: "allow", consequence: `${runs}${draftNote}` },
		// A sandbox escape's session option names the scope it grants in full (M-7).
		...(view.escapeScope !== undefined
			? [
					{
						key: permissionKeyLabel(PERMISSION_SESSION_SCOPE_KEY),
						verb: "approve for this session",
						consequence: `${view.escapeScope.label.replace(/^Approve for this session:\s*/u, "")}; reruns of these unchanged files run without asking${draftNote}`,
					},
				]
			: []),
		{ key: "Esc", verb: "deny", consequence: "skips it" },
		{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
	];
}

/** The countdown as one clause for the row that also says where the window is, on a card too short for its sentence. */
export function compactCountdownClause(
	view: ApprovalRequestView,
	countdown: CardCountdown,
): { outcome: string; holds: string; tone: PancodeToken } | null {
	if (countdown === null) return null;
	if (countdown === "held") return { outcome: `${GLYPH.phaseBlocked} no time limit now`, holds: "", tone: "annotation" };
	if (isWorkerWindow(countdown)) {
		const left = formatCountdown(countdown.remainingMs);
		const ending = view.workerFallback === "fail" ? "fails the run" : "denies";
		if (!countdown.held) return { outcome: `${GLYPH.warn} ${left} ${ending}`, holds: "key holds", tone: "warning" };
		return {
			outcome: `${GLYPH.phaseBlocked} extended ${GLYPH.sep} no answer in ${left} ${ending}`,
			holds: "",
			tone: countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation",
		};
	}
	const remaining = formatCountdown(countdown);
	if (view.origin.kind !== "worker") {
		return { outcome: `${GLYPH.warn} ${remaining} denies`, holds: "key holds", tone: "warning" };
	}
	const outcome = view.workerFallback === "fail" ? "fails the run" : "denies";
	return { outcome: `${GLYPH.warn} ${remaining} ${outcome}`, holds: "", tone: "warning" };
}

function taskVia(task: NonNullable<ApprovalRequestView["task"]>): string {
	return task.via === undefined ? "" : ` ${GLYPH.sep} via ${task.via}`;
}

/** The task row's value: the operator's words are theirs; a dispatch read-root ask names the dispatched task (CLI-P35). */
export function taskRowValue(task: NonNullable<ApprovalRequestView["task"]>): string {
	if (task.dispatch !== undefined) {
		const { position, count } = task.dispatch;
		return `dispatch${count > 1 ? ` task ${position} of ${count}` : ""}: "${task.text}"`;
	}
	return `"${task.text}" ${GLYPH.sep} you${taskVia(task)}`;
}
