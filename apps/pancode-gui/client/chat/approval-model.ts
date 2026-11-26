// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Everything the permission card decides, kept out of the component because this app has no DOM
// test environment: the taxonomy, the escalation clock, the action set and the preview of the
// concrete thing being approved all have to be exercisable by node:test.
//
// Three rules carry the weight here.
//
//  - Escalation is a state, not a timeout. The card derives it from the permission's own
//    timestamps rather than waiting for the `permission.escalated` delta, so the UI never lags the
//    clock. The server's declared windows are 45 s to escalation and a 600 s budget
//    (server/acp/permissions.ts PERMISSION_TIMERS); this module reads them off the wire and only
//    falls back to those constants when a stamp does not parse.
//  - The only two one-time answers on the wire are `allow-once` and `reject`, which is why the card
//    eyebrow says ONE USE. `reject-and-stop` is a third answer the agent may announce per request;
//    it is drawn only when `canStopTurn` is true, because sending it otherwise is a 409 rather than
//    a silent plain reject. `allow-session-scope` is drawn only on an ask that names its
//    `sessionScope`, and the card states that scope before anyone picks it.
//  - No model-authored prose reaches this card. Every sentence below is either fixed copy or a
//    value the agent already classified and bounded upstream.

import {
	actionClassWords,
	decisionTierLabel,
	reversibilityWords,
	safetyNetRailText,
	UNREAD_COMMAND_EFFECT,
	unansweredWords,
	workerAuthorityWords,
} from "../../../../src/core/views/approval-words.js";
import { countNoun } from "../../../../src/core/views/count-words.js";
import { USAGE_NOT_MEASURED } from "../../../../src/core/views/usage-words.js";
import type {
	DispatchPlanFacts,
	Permission,
	PermissionDecision,
	PermissionDecisionFacts,
} from "../../contracts/permissions.js";
import { formatClock, formatDuration } from "../api/clock.js";
import type { StatusTone } from "../design/status.js";
import { readGateway } from "./gateway-model.js";
import { dispatchTasks } from "./tool-presentation.js";

/** The server's declared escalation window, used only when `escalateAt` does not parse. */
export const ESCALATION_SECONDS = 45;
/** The server's declared approval budget, used only when `expiresAt` does not parse. */
export const BUDGET_SECONDS = 600;

/** The safety posture, verbatim. It is the product's whole promise in one line. */
export const SAFETY_POSTURE = "Nothing runs until you answer. PanCode never answers for you.";
/** The "one use" is load-bearing: there is deliberately no allow-always on the wire. */
export const CARD_EYEBROW = "Approval needed · one use";
export const KEYBOARD_HINT = "Alt + A allows once · Alt + R rejects";

export const bannerEyebrow = (escalated: boolean): string =>
	escalated ? "APPROVAL WAITING · ESCALATED" : "APPROVAL NEEDED";

export {
	approvalQueue,
	callDecisions,
	decisionRecord,
	RESOLUTION_SUMMARY,
	resolutionSummary,
} from "./approval-gate.js";
export { isAwaitingAnswer } from "./permission-state.js";

/** One sent answer as the mutation cache reports it; `problemCode` is the server's refusal code, if any. */
export interface SentAnswer {
	readonly id: string | undefined;
	readonly status: "idle" | "pending" | "success" | "error";
	readonly problemCode: string | undefined;
}

/**
 * The requests this page already answered. A conflict means the server holds no waiting request under that id:
 * an earlier decision settled it (a second click raced the snapshot), so offering the buttons again only repeats it.
 */
export const answeredPermissionIds = (answers: readonly SentAnswer[]): ReadonlySet<string> =>
	new Set(
		answers.flatMap((answer) =>
			answer.id !== undefined &&
			(answer.status === "success" || (answer.status === "error" && answer.problemCode === "conflict"))
				? [answer.id]
				: [],
		),
	);

export interface ApprovalTimings {
	/** True once the declared escalation window has passed, or once the server said so. */
	readonly escalated: boolean;
	readonly waitedMs: number;
	readonly waitedSeconds: number;
	readonly remainingMs: number;
	readonly remainingSeconds: number;
	/** True when the budget has run out on this clock, whatever the server has not yet told us. */
	readonly expired: boolean;
	/** False when `expiresAt` did not parse, which makes the countdown sentence degrade. */
	readonly budgetKnown: boolean;
	/** The window the product promised, not the observed wait. The announcer speaks this one. */
	readonly declaredEscalationSeconds: number;
}

const instant = (value: string): number | null => {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};
const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

export function deriveApprovalTimings(
	permission: Pick<Permission, "status" | "requestedAt" | "escalateAt" | "expiresAt">,
	nowMs: number,
): ApprovalTimings {
	const requested = instant(permission.requestedAt),
		escalateAt = instant(permission.escalateAt),
		expiresAt = instant(permission.expiresAt);
	const waitedMs = requested === null ? 0 : Math.max(0, nowMs - requested);
	const remainingMs = expiresAt === null ? 0 : Math.max(0, expiresAt - nowMs);
	const declared =
		requested !== null && escalateAt !== null && escalateAt > requested
			? seconds(escalateAt - requested)
			: ESCALATION_SECONDS;
	return {
		escalated: permission.status === "escalated" || (escalateAt !== null && nowMs >= escalateAt),
		waitedMs,
		waitedSeconds: seconds(waitedMs),
		remainingMs,
		remainingSeconds: seconds(remainingMs),
		expired: expiresAt !== null && nowMs >= expiresAt,
		budgetKnown: expiresAt !== null,
		declaredEscalationSeconds: declared,
	};
}

/**
 * The countdown is phrased as a consequence rather than as a timer, because that is the decision. This app's budget
 * stops the turn (server/acp/permissions.ts); a forwarded worker ask applies the worker's own fallback instead.
 */
function countdownSentence(timings: ApprovalTimings, permission: Pick<Permission, "expiresAt" | "worker">): string {
	const outcome =
		permission.worker === undefined ? "stop-turn" : permission.worker.fallback === "fail" ? "worker-fail" : "worker-deny";
	return timings.budgetKnown
		? unansweredWords(`${formatDuration(timings.remainingMs)} (at ${formatClock(permission.expiresAt)})`, outcome)
		: unansweredWords("PanCode's approval budget", outcome);
}

/** Under a second the wait is not a measurement worth printing, so it says the request just arrived. */
export const waitedSentence = (timings: ApprovalTimings): string =>
	timings.waitedMs < 1000 ? "Asked just now." : `Waiting ${formatDuration(timings.waitedMs)}.`;

export interface CallLocation {
	readonly path: string;
	readonly line?: number | null;
}

/** ACP line numbers are zero-based, so a reported line is shown one higher. */
export const formatLocation = (location: CallLocation): string =>
	typeof location.line === "number" && Number.isInteger(location.line)
		? `${location.path}:${location.line + 1}`
		: location.path;

/** At most three named inline; the rest are counted, never silently dropped. */
export function formatLocations(locations: readonly CallLocation[] | undefined): string[] {
	const all = (locations ?? []).map(formatLocation);
	return all.length > 3 ? [...all.slice(0, 3), `+${all.length - 3} more`] : all;
}

/** The ACP kind as a verb phrase; `think`, `switch_mode` and any kind this build does not know act on. */
const ACCESS_PHRASES: Readonly<Record<string, string>> = {
	edit: "Edits",
	delete: "Deletes",
	move: "Moves",
	execute: "Runs a command in",
	fetch: "Fetches",
	read: "Reads",
	search: "Searches",
};

/** The permission carries no locations of its own; they come from the gated tool call. */
export function accessSentence(
	permission: Pick<Permission, "kind">,
	locations: readonly CallLocation[] | undefined,
): string {
	const named = formatLocations(locations);
	return `${ACCESS_PHRASES[permission.kind] ?? "Acts on"} ${named.length === 0 ? "this turn" : named.join(", ")}.`;
}

/**
 * The safety facts in the order the card prints them, after the title heading. The countdown moves
 * on the shared one-second clock, so this is recomputed per tick rather than memoised.
 */
export function safetyFacts(
	permission: Pick<Permission, "kind" | "status" | "requestedAt" | "escalateAt" | "expiresAt" | "worker">,
	locations: readonly CallLocation[] | undefined,
	timings: ApprovalTimings,
): readonly string[] {
	return [
		accessSentence(permission, locations),
		countdownSentence(timings, permission),
		SAFETY_POSTURE,
		waitedSentence(timings),
	];
}

/** What a screen reader hears the moment a card appears. */
export const approvalAnnouncement = (
	permission: Pick<Permission, "title" | "kind">,
	locations?: readonly CallLocation[],
): string =>
	`Approval needed: ${permission.title}. ${accessSentence(permission, locations)} Nothing runs until you answer.`;

// ---- the agent's own classification -------------------------------------------------------

/**
 * The agent classified the call before it asked. Without these facts a client would re-derive a
 * tier and a consequence from a tool name, which is a second and worse classifier, so this module
 * only ever labels values it was given and never invents one from the tool.
 */
const AFFECTED_SCOPE_LABELS: Readonly<Record<string, string>> = {
	conversation: "reaches this conversation only",
	workspace: "reaches this workspace",
	"outside-workspace": "reaches outside this workspace",
	outward: "reaches outside this machine",
	system: "reaches this machine",
};

/**
 * The agent's three semantic tokens onto the six status tones. `accent` is the calm classification,
 * `action` is consequential, `warning` is the one that should stop an operator mid-scroll.
 */
const DECISION_TONES: Readonly<Record<string, StatusTone>> = {
	accent: "neutral",
	action: "warn",
	warning: "fail",
};

export const decisionTone = (decision: PermissionDecisionFacts | undefined): StatusTone =>
	decision === undefined ? "warn" : (DECISION_TONES[decision.semanticToken] ?? "warn");

const labelled = (table: Readonly<Record<string, string>>, value: string): string => table[value] ?? value;

/** How many workers approving starts: the admitted plan's task count, or 1 for a call that is not a dispatch plan. */
const approvedWorkers = (plan: DispatchPlanFacts | undefined): number => plan?.taskCount ?? 1;

/** The short chips above the facts: tier, what it does, how far it reaches. */
export function decisionChips(
	decision: PermissionDecisionFacts | undefined,
	plan?: DispatchPlanFacts,
): readonly string[] {
	if (decision === undefined) return [];
	const tier = decision.tierLabel.length > 0 ? decision.tierLabel : decisionTierLabel(decision.tier);
	const chips = [tier, actionClassWords(decision.actionClass, approvedWorkers(plan))];
	// An unknown reach has no chip: naming the workspace would claim a reach the agent could not see.
	return decision.affectedScope === "unknown"
		? chips
		: [...chips, labelled(AFFECTED_SCOPE_LABELS, decision.affectedScope)];
}

/** Why this call, of all calls, stopped for the operator; empty when the engine sent no rule. */
function askedBecause(decision: PermissionDecisionFacts, plan: DispatchPlanFacts | undefined): string {
	const axis = decision.axis;
	if (axis === undefined) return "";
	if (axis.kind === "safety-net") return axis.ruleId.length > 0 ? safetyNetRailText(axis.ruleId) : "";
	if (axis.kind === "autonomy" && axis.level.length > 0)
		return `${axis.level} autonomy asks before a call that ${actionClassWords(decision.actionClass, approvedWorkers(plan))}`;
	return "";
}

export interface DecisionRow {
	readonly term: string;
	readonly value: string;
	/** Set when the value is several sentences that a card draws one per line. */
	readonly lines?: readonly string[];
}

/**
 * The agent's own prose, already control-stripped and bounded to 512 bytes upstream. A copy field
 * the agent left empty falls back to this module's label for the matching enum rather than to a
 * blank row, and `reversibility` is the one axis where both a classification and a sentence exist.
 */
export function decisionRows(
	decision: PermissionDecisionFacts | undefined,
	plan?: DispatchPlanFacts,
): readonly DecisionRow[] {
	if (decision === undefined) return [];
	const rows: DecisionRow[] = [];
	const push = (term: string, value: string) => {
		if (value.length > 0) rows.push({ term, value });
	};
	push("Authorization", decision.authorizationCopy);
	push("Consequence", decision.consequenceCopy);
	// The sentences the agent wrote from the whole command sit directly under the generic
	// consequence, so an operator reads what this command does before the reversibility.
	const effects = decision.consequenceLines ?? [];
	if (effects.length > 0) rows.push({ term: "Effect", value: effects.join(" "), lines: effects });
	else if (decision.actionClass === "execute") push("Effect", UNREAD_COMMAND_EFFECT);
	push(
		"Reversibility",
		decision.reversibilityCopy.length > 0 ? decision.reversibilityCopy : reversibilityWords(decision.reversibility),
	);
	push("Asked because", askedBecause(decision, plan));
	const mutation = decision.mutation;
	if (mutation !== undefined) {
		const shape =
			mutation.kind === "write"
				? `write ${mutation.bytes} B`
				: `edit ${mutation.replacements} replacement${mutation.replacements === 1 ? "" : "s"} · ${mutation.bytes} B`;
		push("Mutation", `${shape} · sha256 ${mutation.digest}`);
	}
	const task = decision.task;
	if (task !== undefined && task.text.length > 0) {
		push("Task", `"${task.text}" · you${task.via !== undefined && task.via.length > 0 ? ` · via ${task.via}` : ""}`);
	}
	push("Requested by", decision.requestedByCopy);
	push("Target", decision.target ?? "");
	return rows;
}

/**
 * Whose request a forwarded worker ask is, who may discharge it, and what happens unanswered, in the terminal card's
 * words from the shared approval vocabulary. Identifiers and enums only upstream, so these are authority statements
 * and not a worker's own words. The wire carries no safety-judge reviewer, so the judge's own sentence never shows here.
 */
export function workerAskRows(worker: Permission["worker"]): readonly DecisionRow[] {
	if (worker === undefined) return [];
	const authority = workerAuthorityWords(worker.approvalAuthority, worker.forwardedByMain, false);
	const rows: DecisionRow[] = [
		{ term: "Worker", value: `${worker.agentId} (run ${worker.requestedBy})` },
		{ term: "Authority", value: `${authority.charAt(0).toUpperCase()}${authority.slice(1)}` },
	];
	if (worker.timeoutMs !== undefined) {
		rows.push({
			term: "If unanswered",
			value: unansweredWords(
				`${Math.ceil(worker.timeoutMs / 1000)} seconds`,
				worker.fallback === "fail" ? "worker-fail" : "worker-deny",
			),
		});
	}
	return rows;
}

/** Said in place of the classification when the agent announced none, so the gap is stated. */
export const NO_DECISION_FACTS = "PanCode sent no classification with this request.";

/** The session option's scope, stated as a row so the operator reads what the grant covers before choosing it. */
export function sessionScopeRows(sessionScope: Permission["sessionScope"]): readonly DecisionRow[] {
	if (sessionScope === undefined) return [];
	return [
		{
			term: "For this session",
			value: `Allow for this session also runs, without asking, every later unsandboxed rerun of ${sessionScope}. An edited script, another script, cwd or env asks again.`,
		},
	];
}

// ---- the answers ---------------------------------------------------------------------------

export interface ApprovalAction {
	readonly decision: PermissionDecision;
	readonly label: string;
	/** `primary` is the affirmative and is drawn last; the refusals are quiet and come first. */
	readonly variant: "quiet" | "primary";
	readonly description: string;
	/** The declared keybinding id, or null for an answer that has no chord. */
	readonly keybinding: "allowOnce" | "reject" | null;
}

const REJECT: ApprovalAction = {
	decision: "reject",
	label: "Reject",
	variant: "quiet",
	description: "Denies this one request. The turn continues.",
	keybinding: "reject",
};
const REJECT_AND_STOP: ApprovalAction = {
	decision: "reject-and-stop",
	label: "Reject and stop the turn",
	variant: "quiet",
	description: "Denies this request and every other parked request from this turn, and cancels the turn.",
	keybinding: null,
};
const ALLOW_SESSION: ApprovalAction = {
	decision: "allow-session-scope",
	label: "Allow for this session",
	variant: "quiet",
	description:
		"Allows this call and, for the rest of this session, unchanged reruns of the same scripts outside the sandbox.",
	keybinding: null,
};
const ALLOW_ONCE: ApprovalAction = {
	decision: "allow-once",
	label: "Allow once",
	variant: "primary",
	description: "Allows this one call. PanCode asks again next time.",
	keybinding: "allowOnce",
};

/**
 * Destructive-safe first, affirmative last. The turn-ending refusal is drawn only when the agent
 * announced it: an engine with no tool registry announces nothing, and the card must still work
 * with the two answers that have always been on the wire.
 */
export function approvalActions(
	permission: Pick<Permission, "canStopTurn" | "sessionScope">,
): readonly ApprovalAction[] {
	const allow = permission.sessionScope === undefined ? [ALLOW_ONCE] : [ALLOW_SESSION, ALLOW_ONCE];
	return permission.canStopTurn ? [REJECT, REJECT_AND_STOP, ...allow] : [REJECT, ...allow];
}

// ---- the concrete thing being approved -------------------------------------------------------

/**
 * The narrow slice of a timeline tool call this card reads. It is deliberately structural rather
 * than `TimelineItem`, so the integrator can hand it the item directly or hand it whatever the
 * tool-presentation module projects, without this module reaching into either.
 */
export interface GatedCall {
	readonly toolName?: string;
	readonly title?: string;
	readonly toolKind?: string;
	readonly rawInput?: Readonly<Record<string, unknown>>;
	readonly locations?: readonly CallLocation[];
}

export interface ProposedEdit {
	readonly oldText: string;
	readonly newText: string;
}

/**
 * What to draw in the card body. This is the answer to 'review the tool input in the conversation',
 * which is what the old card asked the operator to do by hand.
 */
export type GatedPreview =
	| { readonly kind: "command"; readonly label: string; readonly command: string; readonly truncated: boolean }
	| {
			readonly kind: "edits";
			readonly label: string;
			readonly path: string;
			readonly edits: readonly ProposedEdit[];
			readonly truncated: boolean;
	  }
	| {
			readonly kind: "contents";
			readonly label: string;
			readonly path: string;
			readonly contents: string;
			readonly truncated: boolean;
	  }
	| { readonly kind: "path"; readonly label: string; readonly path: string }
	| {
			readonly kind: "host";
			readonly label: string;
			readonly host: string;
			readonly url: string;
			readonly requestedUrl: string;
			readonly truncated: boolean;
	  }
	| { readonly kind: "summary"; readonly label: string; readonly summary: string }
	| PlanPreview
	| { readonly kind: "none"; readonly label: string; readonly note: string };

/** A dispatch plan as the agent admitted it: what one approval starts, run by run. */
export interface PlanPreview {
	readonly kind: "plan";
	readonly label: string;
	/** "2 runs · in parallel". */
	readonly heading: string;
	/** What one approval covers, in a sentence. */
	readonly scope: string;
	readonly rows: ReadonlyArray<{
		readonly key: string;
		readonly agent: string;
		readonly task: string;
		/** Target, model and node where the agent reported them; null when it reported none. */
		readonly placement: string | null;
		readonly notes: readonly string[];
	}>;
	/** Runs in the plan the agent did not send; counted, never silently dropped. */
	readonly more: number;
	/** The first twelve hex digits, and the whole hash for anyone auditing the receipt; null for a dispatch read from its arguments. */
	readonly hash: { readonly short: string; readonly full: string } | null;
	readonly ceiling: string | null;
}

const TOPOLOGY_WORDS: Readonly<Record<string, string>> = {
	parallel: "in parallel",
	sequential: "one after another",
	pipeline: "as a pipeline",
	review: "with a review gate",
	compete: "as competing candidates",
	council: "as a council",
	detached: "detached from this turn",
	fleet: "as a dependency plan",
};
const ROLE_WORDS: Readonly<Record<string, string>> = {
	builder: "Builder",
	reviewer: "Reviewer",
	candidate: "Candidate",
	judge: "Judge",
	member: "Council member",
	synthesis: "Synthesis",
};

function planPreview(plan: DispatchPlanFacts): PlanPreview {
	const runs = `${plan.taskCount} ${plan.taskCount === 1 ? "run" : "runs"}`;
	const rows = plan.tasks.map((task, index) => {
		const where = [task.target, task.model].filter((value): value is string => value !== undefined);
		if (task.node !== undefined && task.node !== "local")
			where.push(`on ${task.node}${task.nodeKind === "ssh" ? " over SSH" : ""}`);
		const notes: string[] = [];
		if (task.role !== undefined && ROLE_WORDS[task.role] !== undefined) notes.push(ROLE_WORDS[task.role] as string);
		if (task.worktree === true)
			notes.push(
				task.apply === "merge"
					? "In its own worktree, merged back when it passes"
					: task.apply === "preserve"
						? "In its own worktree, kept for review"
						: "In its own worktree",
			);
		if (task.dependencies.length > 0) notes.push(`After ${task.dependencies.join(", ")}`);
		return {
			key: task.stepId ?? `${index}`,
			agent: clampText(task.agent, 1, 256).text,
			task: clampText(task.task, 6, 600).text,
			placement: where.length === 0 ? null : clampText(where.join(" · "), 1, 512).text,
			notes,
		};
	});
	return {
		kind: "plan",
		label: plan.planScale ? "Dispatch plan" : "Dispatch",
		heading: `${runs} · ${TOPOLOGY_WORDS[plan.topology] ?? plan.topology}`,
		scope: plan.planScale
			? "One approval starts every run in this plan, including remote placements."
			: "This approval starts one run.",
		rows,
		more: Math.max(0, plan.taskCount - rows.length),
		hash: { short: plan.hash.slice(0, 12), full: plan.hash },
		// A ceiling of 0 means none is set, everywhere in PanCode; it is never a limit of nothing.
		ceiling:
			plan.costCeilingUsd === undefined
				? null
				: plan.costCeilingUsd > 0
					? `Scheduling stops at a cost of ${plan.costCeilingDisplay ?? USAGE_NOT_MEASURED}.`
					: "No cost ceiling is set, so scheduling does not stop on cost.",
	};
}

/** A synthesized block never renders more than this; the operator scrolls the real diff instead. */
export const PREVIEW_MAX_LINES = 400;
/** Runs a dispatch read from its arguments lists on the card; the rest are counted. */
const DISPATCH_PREVIEW_RUNS = 8;
const PREVIEW_MAX_CHARS = 16_000;
const COMMAND_MAX_CHARS = 4_000;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * `rawInput` is the harness's literal argument object and nothing upstream promised it is printable,
 * so control codes are stripped here rather than trusted. Newlines and tabs survive because a
 * command and a file body are both multi-line by nature.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control codes is the point.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function clampText(value: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
	const clean = value.replace(CONTROL, "");
	const lines = clean.split("\n");
	const byLines = lines.length > maxLines;
	const kept = byLines ? lines.slice(0, maxLines).join("\n") : clean;
	const byChars = kept.length > maxChars;
	return { text: byChars ? kept.slice(0, maxChars) : kept, truncated: byLines || byChars };
}

function editsFrom(input: Readonly<Record<string, unknown>>): ProposedEdit[] {
	const list = Array.isArray(input.edits) ? input.edits : [input];
	const edits: ProposedEdit[] = [];
	for (const entry of list) {
		const edit = record(entry);
		const oldText = typeof edit.oldText === "string" ? edit.oldText : null,
			newText = typeof edit.newText === "string" ? edit.newText : null;
		if (oldText === null && newText === null) continue;
		edits.push({ oldText: oldText ?? "", newText: newText ?? "" });
	}
	return edits;
}

const COMMAND_TOOLS = new Set(["bash", "run_script", "verify", "safe_exec", "git"]);
const EDIT_TOOLS = new Set(["edit", "artifact"]);
const PATH_TOOLS = new Set(["read", "ls", "grep", "find", "code_nav"]);
const PREVIEWED_TOOLS = new Set([...COMMAND_TOOLS, ...EDIT_TOOLS, ...PATH_TOOLS, "write", "web_fetch", "dispatch"]);
const TITLE_TOOL = /^([a-z][a-z0-9_]*): /;

/**
 * The PanCode tool behind a call. PanCode titles a call as the permission ask words it: `tool: target`,
 * and a shell call as its bare command, so the title names the tool only by its head. A bare name is
 * still accepted, and an `execute` call that carries a command is the shell.
 */
function gatedToolName(call: GatedCall, input: Readonly<Record<string, unknown>>): string | null {
	const title = call.title;
	if (title !== undefined) {
		if (PREVIEWED_TOOLS.has(title)) return title;
		const head = TITLE_TOOL.exec(title)?.[1];
		if (head !== undefined && PREVIEWED_TOOLS.has(head)) return head;
	}
	if (call.toolKind === "execute" && text(input.command) !== null) return "bash";
	return null;
}

function writeRoots(intent: unknown): readonly string[] | null {
	const roots = record(intent).write_roots;
	if (!Array.isArray(roots)) return null;
	return roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0);
}

/** What a dispatch's own arguments say each run does, when PanCode sent no admitted plan for it. */
function dispatchArgumentsPreview(input: Readonly<Record<string, unknown>>): GatedPreview {
	const entries = Array.isArray(input.tasks) && input.tasks.length > 0 ? input.tasks : [input];
	const shared = writeRoots(input.intent);
	const tasks = dispatchTasks(input as Record<string, unknown>);
	const writes = (index: number) => {
		const roots = writeRoots(record(entries[index]).intent) ?? shared;
		return roots === null
			? null
			: roots.length === 0
				? "Writes nothing"
				: `Writes ${clampText(roots.join(", "), 1, 256).text}`;
	};
	if (tasks.length <= 1) {
		const agent = text(input.agent) ?? text(input.recipe) ?? tasks[0]?.agent ?? "an unnamed agent";
		const task = tasks[0]?.task || null;
		const preview = task === null ? "no task preview" : clampText(task, 1, 160).text;
		const scope = writes(0);
		return {
			kind: "summary",
			label: "Dispatch",
			summary: [agent, preview, scope?.toLocaleLowerCase("en-US")].filter(Boolean).join(" · "),
		};
	}
	const rows = tasks.slice(0, DISPATCH_PREVIEW_RUNS).map((task, index) => {
		const scope = writes(index);
		return {
			key: `${index}`,
			agent: clampText(task.agent, 1, 256).text,
			task: task.task ? clampText(task.task, 6, 600).text : "No task text was sent.",
			placement: null,
			notes: scope === null ? [] : [scope],
		};
	});
	const mode = text(input.mode) ?? "parallel";
	return {
		kind: "plan",
		label: "Dispatch",
		heading: `${countNoun(tasks.length, "run")} · ${TOPOLOGY_WORDS[mode] ?? mode}`,
		scope: `This approval starts all ${countNoun(tasks.length, "run")}.`,
		rows,
		more: tasks.length - rows.length,
		hash: null,
		ceiling: null,
	};
}

/**
 * Keyed on the canonical PanCode tool name: a gateway call's capability, the call's `toolName`, then
 * {@link gatedToolName} for a call that carries only its title; `toolKind` is only the coarse ACP hint. A tool this build has never seen produces a readable `none` rather than an empty body,
 * because an approval card that shows nothing is the bug being fixed.
 */
export function gatedPreview(call: GatedCall | undefined, plan?: DispatchPlanFacts): GatedPreview {
	if (call === undefined)
		return {
			kind: "none",
			label: "What is being approved",
			note: "This request is not linked to a call in this conversation.",
		};
	const gateway = readGateway(call);
	const input = gateway.input;
	const name = gateway.name ?? call.toolName ?? gatedToolName(call, input) ?? call.title ?? call.toolKind ?? "tool";
	if (COMMAND_TOOLS.has(name)) {
		const raw = text(input.command) ?? text(input.script);
		if (raw === null) {
			const operation = text(input.op) ?? text(input.id);
			if (operation !== null)
				return {
					kind: "summary",
					label: name === "git" ? "Git operation" : "Operation",
					summary: clampText(operation, 1, 256).text,
				};
			return { kind: "none", label: "Command", note: "PanCode reported no command for this call." };
		}
		const clamped = clampText(raw, PREVIEW_MAX_LINES, COMMAND_MAX_CHARS);
		return { kind: "command", label: "Command", command: clamped.text, truncated: clamped.truncated };
	}
	if (EDIT_TOOLS.has(name)) {
		const path = text(input.path) ?? "a file PanCode did not name";
		const edits = editsFrom(input);
		if (edits.length === 0) return { kind: "path", label: "File", path };
		let truncated = false;
		const budget = Math.max(1, Math.floor(PREVIEW_MAX_LINES / edits.length));
		const clamped = edits.map((edit) => {
			const before = clampText(edit.oldText, budget, PREVIEW_MAX_CHARS),
				after = clampText(edit.newText, budget, PREVIEW_MAX_CHARS);
			truncated = truncated || before.truncated || after.truncated;
			return { oldText: before.text, newText: after.text };
		});
		return { kind: "edits", label: "Proposed · not yet applied", path, edits: clamped, truncated };
	}
	if (name === "write") {
		const path = text(input.path) ?? "a file PanCode did not name";
		const content = text(input.content);
		if (content === null) return { kind: "path", label: "File", path };
		const clamped = clampText(content, PREVIEW_MAX_LINES, PREVIEW_MAX_CHARS);
		return {
			kind: "contents",
			label: "Proposed new contents",
			path,
			contents: clamped.text,
			truncated: clamped.truncated,
		};
	}
	if (name === "web_fetch") {
		const url = text(input.url);
		if (url === null) return { kind: "none", label: "Address", note: "PanCode reported no address for this fetch." };
		const clamped = clampText(url, 1, 512);
		try {
			const parsed = new URL(url);
			return {
				kind: "host",
				label: "Requested URL",
				host: parsed.host,
				url: `${parsed.host}${parsed.pathname}`,
				requestedUrl: clamped.text,
				truncated: clamped.truncated,
			};
		} catch {
			return {
				kind: "host",
				label: "Requested URL",
				host: clamped.text,
				url: clamped.text,
				requestedUrl: clamped.text,
				truncated: clamped.truncated,
			};
		}
	}
	if (name === "dispatch") {
		// The admitted plan wins over the arguments: it is what the run seals, and it names every run.
		if (plan !== undefined) return planPreview(plan);
		return dispatchArgumentsPreview(input);
	}
	if (PATH_TOOLS.has(name)) {
		const path = text(input.path) ?? text(input.pattern) ?? text(input.glob);
		if (path !== null) return { kind: "path", label: "Path", path: clampText(path, 1, 512).text };
	}
	const locations = formatLocations(call.locations);
	if (locations.length > 0) return { kind: "path", label: "Path", path: locations.join(", ") };
	return {
		kind: "none",
		label: "What is being approved",
		note: `PanCode reported no reviewable input for ${name}.`,
	};
}
