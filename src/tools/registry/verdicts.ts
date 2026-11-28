// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../../core/headless-permission.js";
import type { SkillToolSurfaceViolation } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../../core/views/approval-words.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { EscapeScope } from "../../domains/safety/escape-scope.js";
import { escapeScopeOptionLabel } from "../../domains/safety/escape-scope.js";
import type { FlowRestrictionSet } from "../../domains/safety/information-flow.js";
import type { SafetyJudgeOutcome } from "../../domains/safety/safety-judge.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import { gateReasonText } from "../approval-note.js";
import type { DispatchPlanView } from "../dispatch-plan.js";
import type { ToolResult } from "../tool-spec.js";
import type { HostReadOnlySource, RegistryVerdict } from "./contract.js";

/** Final reason code for a before_tool guard block, matching the audit convention (sd-01 §2.5). */
export const GUARD_BLOCK_REASON_CODE = "guard_block";

/** Reason code of a recoverable call refused because the snapshot that would undo it was not taken. */
export const SNAPSHOT_REQUIRED_REASON_CODE = "snapshot-required";

/** Reason code of a final information-flow block, for the audit row and the panel. */
export const FLOW_BLOCK_REASON_CODE = "information-flow";

/** The path-reading tools a source rule can name; kept in step with the evaluator's READ_PATH_TOOLS. */
export const FLOW_SOURCE_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Read,
	ToolNames.Ls,
	ToolNames.Count,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Data,
	ToolNames.Store,
]);

/** Result detail that carries a restricted read's label to the host; never model text. */
export const FLOW_RESTRICTIONS_DETAIL = "pancode_flow_restrictions";

/** An error message can quote the source too, so both result kinds carry the label. */
export function withFlowRestrictions(result: ToolResult, restrictions: FlowRestrictionSet | null): ToolResult {
	if (restrictions === null) return result;
	return { ...result, details: { ...(result.details ?? {}), [FLOW_RESTRICTIONS_DETAIL]: restrictions } };
}

export const SAFETY_JUDGE_SKIP: SafetyJudgeOutcome = { kind: "skip" };

/** Prefix of the audit and denial code of a safety judge block; the judge's rule category follows. */
export const SAFETY_JUDGE_REASON_PREFIX = "safety-judge:";

/** The parked ask turned into the allow the judge gave, keeping its classification and policy facts. */
export function safetyJudgeAllowedDecision(ask: SafetyDecision, reasonCode: string): SafetyDecision {
	return {
		kind: "allow",
		classification: ask.classification,
		...(ask.policy !== undefined ? { policy: { ...ask.policy, kind: "allow" as const, reasonCode } } : {}),
	};
}

export const NO_PARK_LISTENER_REASON_CODE = "no_park_listener";

/** The rail a before_tool hook's `request_approval` parks on. */
export const HOOK_APPROVAL_RULE_ID = "middleware-hook-ask";

export const NO_PARK_LISTENER_REASON =
	"refused: this call needs operator confirmation and no permission listener is registered to ask for it";

/** Audit code of a call contained yolo refused because it would have waited for the operator. */
export const CONTAINED_YOLO_REASON_CODE = "contained_yolo_unattended";

export const CONTAINED_YOLO_REASON =
	"refused: contained yolo runs without the operator, and this call needs their decision. Do not retry it; continue with work that does not need it and name it in your report as left for the operator.";

export const CONTAINED_YOLO_ALLOWED_BY =
	"only the operator can decide it, when they are back; contained yolo never waits for them.";

/** Audit code of a sandbox escape that ran inside a scope the operator approved for the session (M-7). */
export const ESCAPE_SCOPE_ALLOW_REASON_CODE = "escape_scope_session";

/** What allows a sandbox escape whose session option ask_user carries (M-7). */
export const ESCAPE_SCOPE_ALLOWED_BY =
	"the operator chooses the session option PanCode adds to an ask_user question that names running it outside the sandbox; then rerun the call.";

/** Why contained yolo refused a sandbox escape that a session option could approve. */
export const CONTAINED_YOLO_ESCAPE_REASON =
	"refused: contained yolo runs without waiting for the operator, and this call leaves the sandbox, which needs their decision.";

/** How the agent can still get an escape approved: the option ask_user adds to a question about it. */
export function escapeScopeAskHint(scope: EscapeScope): string {
	return `To run it, ask the operator with ask_user in one question that names running it outside the sandbox. PanCode adds the option "${escapeScopeOptionLabel(scope)}" to that question; choosing it lets unsandboxed reruns of those same unchanged script files, from the same cwd with the same env, run this session without asking, so rerun the call after they choose it. Do not write that option yourself. Otherwise continue with work that does not need it and name it in your report as left for the operator.`;
}

/** Why a refused sandbox escape gets no session option, and what can still let it run. */
export function escapeNoScopeLine(why: string): string {
	return `PanCode offers no session option for this call because ${why}; it runs only when the operator approves it on an approval card, which this run cannot show; continue with work that does not need it and name it in your report as left for the operator.`;
}

/** The ask a granted escape scope answered, as the allow that runs it. */
export function escapeScopeAllowedDecision(ask: SafetyDecision): SafetyDecision {
	return {
		kind: "allow",
		classification: ask.classification,
		...(ask.policy !== undefined
			? { policy: { ...ask.policy, kind: "allow" as const, reasonCode: ESCAPE_SCOPE_ALLOW_REASON_CODE } }
			: {}),
	};
}

/** Why contained yolo refused an outward call the judge allowed under a rule other than operator-named. */
export function containedOutwardReason(rule: string): string {
	return `PanCode's safety judge allowed this outward call under rule ${rule}, but contained yolo publishes only what an operator message explicitly names.`;
}

export const PARK_ABORT_REASON = "run aborted before the operator decided";

/** Audit and event code of an identical repeat refused from the turn's denial memory. */
export const DENIED_REPEAT_REASON_CODE = "denied_repeat";

/** Refused calls remembered per registry; identical repeats rarely span more than a handful. */
export const DENIED_CALL_MEMORY_LIMIT = 64;

/** An ask_user round the operator answered rather than cancelled. */
export function askUserAnswered(verdict: RegistryVerdict): boolean {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") return false;
	const details = verdict.result.details;
	// A round PanCode answered for an absent operator (#421) is no operator's answer.
	if (details?.unattended !== undefined) return false;
	return details?.cancelled !== true && Array.isArray(details?.answers) && details.answers.length > 0;
}

/** The answers an operator gave themselves in an answered ask_user round, PanCode's picks left out. */
export function operatorAnswers(verdict: RegistryVerdict): Array<{ question: string; answer: string }> {
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") return [];
	const answers = verdict.result.details?.answers;
	if (!Array.isArray(answers)) return [];
	return answers.flatMap((raw: unknown) => {
		if (raw === null || typeof raw !== "object") return [];
		const { question, answer, auto } = raw as { question?: unknown; answer?: unknown; auto?: unknown };
		if (auto === true || typeof question !== "string" || typeof answer !== "string") return [];
		return answer.trim().length > 0 ? [{ question, answer }] : [];
	});
}

type PolicyPatch = Partial<NonNullable<SafetyDecision["policy"]>>;

/**
 * The decision re-shaped as a block. A patch is spread last, so the carried
 * policy keeps its key order; without one the policy is reused as it is.
 */
export function blockDecision(
	decision: SafetyDecision,
	rejection: Extract<SafetyDecision, { kind: "block" }>["rejection"],
	patch?: PolicyPatch,
): SafetyDecision {
	return {
		kind: "block",
		classification: decision.classification,
		rejection,
		...(decision.policy !== undefined
			? { policy: patch === undefined ? decision.policy : { ...decision.policy, ...patch } }
			: {}),
	};
}

/** Terminal blocked verdict whose rejection detail is the reason itself. */
export function blockedVerdict(
	decision: SafetyDecision,
	short: string,
	reason: string,
	patch: PolicyPatch,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	return { kind: "blocked", reason, decision: blockDecision(decision, { short, detail: reason, hints: [] }, patch) };
}

/**
 * Terminal blocked verdict for an information-flow refusal past admission: a
 * source that cannot be labeled, an outbound transfer the carried
 * restrictions forbid, or content withheld because its label did not reach
 * the ledger. The admission's allow is re-shaped as a block with the flow
 * code, so receipts do not report the refusal as allowed.
 */
export function flowBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	return blockedVerdict(decision, `${tool} blocked: information flow`, reason, { reasonCode: FLOW_BLOCK_REASON_CODE });
}

/**
 * Longest guidance sentence carried into a headless denial. The model-facing
 * composer caps a line at 300 characters and interpolates policy text verbatim,
 * so bound it here too and leave room for the elision marker.
 */
const HEADLESS_GUIDANCE_MAX_CHARS = 240;

/**
 * The recovery guidance a headless denial should repeat, or null when the
 * parked decision has none.
 *
 * A headless run answers every ask with one sentence: nobody can confirm, rerun
 * interactively. That says nothing about what would have run, so a headless
 * model that hits an unrecognized-bash rail retries the same shape until the run
 * ends. An unrecognized execution decision carries the working form in its
 * reasons, and those reasons reach the audit record and the interactive approval
 * overlay but not the model. Preserve one bounded recovery hint separately
 * from the actual policy cause carried by the terminal denial below.
 */
function headlessDenialGuidance(decision: SafetyDecision, reason: string): string | null {
	// Interactive denials are left exactly as they were: the operator saw the
	// reasons in the approval overlay before answering.
	if (!reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER)) return null;
	const recovery = decision.kind === "ask" ? decision.recovery?.trim() : undefined;
	if (recovery) return boundedGuidance(recovery);
	const policy = decision.policy;
	if (policy?.execRecognition !== "unrecognized") return null;
	const guidance = policy.reasons.slice(1).find((entry) => entry.trim().length > 0);
	if (guidance === undefined) return null;
	return boundedGuidance(guidance.trim());
}

function boundedGuidance(text: string): string {
	return text.length > HEADLESS_GUIDANCE_MAX_CHARS ? `${text.slice(0, HEADLESS_GUIDANCE_MAX_CHARS)}…` : text;
}

/**
 * Rule ids whose bare name tells neither the model nor the operator reading its
 * report what the rule guards. The model relays the id verbatim ("the rule that
 * blocked it is system-modify-confirm"), so the meaning goes first and the id
 * stays as the parenthetical a maintainer can grep. Ids that carry their own
 * cause in the policy reasons need no entry.
 */
const HEADLESS_RULE_MEANINGS: Readonly<Record<string, string>> = {
	"system-modify-confirm": "writes outside the workspace and other system-level changes need operator confirmation",
};

function headlessRuleLabel(ruleId: string): string {
	const meaning = HEADLESS_RULE_MEANINGS[ruleId];
	return meaning === undefined ? ruleId : `${meaning} (${ruleId})`;
}

/**
 * Terminal blocked verdict for a parked call that has been answered: denied at
 * the confirmation prompt, cancelled with the turn, or settled by an abort.
 *
 * The ask decision's rejection explains that the call *is* parked and what
 * approving it would do. Once the answer is in, that text is stale, and
 * `formatModelRejection` printed it as a second paragraph restating a denial the
 * reason had already stated, followed by four approval hints for an approval
 * that is not coming. The answer is the whole message; the composer still closes
 * it with the standing pivot instruction.
 *
 * A headless answer is the exception: nobody will ever approve it, so the detail
 * carries the policy cause and rule, a terminal settlement statement, and any
 * recovery guidance. The denial sentence stays the detail's prefix, so the
 * stable marker still recognizes a headless denial.
 */
export function parkAnsweredBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	reason: string,
	gateReason?: string,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const guidance = headlessDenialGuidance(decision, reason);
	const detail = [reason];
	if (reason.startsWith(HEADLESS_PERMISSION_DENIED_MARKER)) {
		if (decision.policy?.ruleId) detail.push(`rule: ${headlessRuleLabel(decision.policy.ruleId)}`);
		const cause =
			decision.policy?.kind === "ask"
				? decision.policy.reasons[0]
				: decision.kind === "allow"
					? undefined
					: decision.rejection.short;
		if (cause) detail.push(cause);
		// A card would name what parked it, and headless has no card, so the denial says it.
		const gate = gateReasonText(gateReason);
		if (gate !== "") detail.push(`why it needed a decision: "${gate}"`);
		detail.push("This call was denied; no approval is pending.");
		if (guidance !== null) detail.push(guidance);
	} else if (reason === CONTAINED_YOLO_REASON) {
		const gate = gateReasonText(gateReason);
		if (gate !== "") detail.push(`why it needed the operator: "${gate}"`);
	}
	const blocked = blockDecision(decision, {
		short: `${tool} blocked: ${decision.classification.actionClass} was not approved`,
		detail: detail.join("\n"),
		hints: [],
	});
	return { kind: "blocked", reason, decision: blocked, deniedPark: true };
}

/**
 * Terminal blocked verdict for a call outside the merged tool surface the
 * loaded skills declared. The reason carries the remediation, since blocked
 * reasons are what the model reads; context and ask_user stay exempt at
 * the evaluator so the message can honestly point at ask_user.
 */
export function skillSurfaceBlockedVerdict(
	decision: SafetyDecision,
	tool: string,
	violation: SkillToolSurfaceViolation,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const lifetime = violation.carriedSurface
		? "The narrowing stays active for the rest of the session, across the operator's later turns, until a different skill replaces it or the operator clears it with /skill off."
		: "The narrowing ends when the skill policy's turn or worker run ends.";
	const reason =
		violation.disallowedBy.length > 0
			? `${tool} is disallowed by the active skill(s) ${violation.disallowedBy.join(", ")} (disallowed-tools). ${lifetime} Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`
			: `${tool} is outside the tool surface declared by the active skill(s) ${violation.skills.join(", ")}. Tools are narrowed to: ${(violation.mergedAllowedTools ?? []).join(", ")} (plus context and ask_user). The finish and limitation receipts stay available unless explicitly disallowed. ${lifetime} Work within the skill workflow; if it genuinely needs this step, use ask_user when available or state the blocker in your reply.`;
	const blocked = blockDecision(
		decision,
		{
			short: `${tool} blocked: outside active skill tool surface`,
			detail: reason,
			hints: ["Skill narrowing never grants tools; it only blocks calls outside the declared workflow surface."],
		},
		{ reasonCode: "skill_surface" },
	);
	return { kind: "blocked", reason, decision: blocked };
}

/**
 * What a host read-only denial says set the scope and who can lift it. The
 * run remedy says to drop the flag in plain words: a remedy that ended on the
 * flag itself was relayed to the user as the fix.
 */
export const HOST_READ_ONLY_SOURCES: Readonly<Record<HostReadOnlySource, { detail: string; remedy: string }>> = {
	run: {
		detail: "The host started this task read-only (pancode run --read-only)",
		remedy: "the operator must rerun this task without the --read-only flag.",
	},
	"acp-server": {
		detail: "The operator started this ACP server read-only (pancode acp --read-only)",
		remedy: "the operator must restart the ACP server without the --read-only flag; no client ceiling can lift it.",
	},
	"acp-ceiling": {
		detail: "The ACP client set readOnly in its pancode/ceiling for this session or prompt",
		remedy: "the ACP client must send this work without readOnly in its pancode/ceiling.",
	},
};

/**
 * Who made an ACP server's turns read-only. `acp --read-only` holds every
 * session and no client ceiling lifts it, so its denial names the flag even
 * when a client also sent readOnly; naming the client's ceiling there sent the
 * model to ask the client to drop a readOnly it never set (TC-1 Q4).
 */
export function acpHostReadOnlySource(serverReadOnly: boolean): HostReadOnlySource {
	return serverReadOnly ? "acp-server" : "acp-ceiling";
}

/** A read-only dispatch or task scope resolves every forbidden call as a terminal denial. */
export function readOnlyDeniedVerdict(
	decision: SafetyDecision,
	tool: string,
	hostSource: { detail: string } | null,
	reasonCode: string,
	noSandbox = false,
): Extract<RegistryVerdict, { kind: "blocked" }> {
	const rejection = noSandbox
		? {
				short: `${tool} unverified: no OS sandbox for checks in this read-only run`,
				detail:
					"This read-only run has no bubblewrap sandbox to keep a check's writes out of the workspace, so no check can run here and none was run.",
				hints: [
					"Report each requested gate as unverified, naming this reason; do not report it passed or failed.",
					"Inspection tools remain available for paths inside the workspace.",
				],
			}
		: hostSource !== null
			? {
					short: `${tool} denied: this task is read-only`,
					detail: `${hostSource.detail}, so this call cannot execute and no approval clears it.`,
					hints: [
						"Describe the proposed change as text in the answer.",
						"Inspection tools remain available for paths inside the workspace.",
					],
				}
			: {
					short: `${tool} denied: this run is read-only`,
					detail: `The dispatch that started this run is read-only, so this call cannot execute.`,
					hints: [
						"Describe the proposed change as text for the dispatching agent.",
						"Inspection tools remain available for paths inside the workspace.",
					],
				};
	// The net passed this call; the block is the read-only ceiling's, so the
	// carried policy must not keep reporting the net's "allowed" code.
	return { kind: "blocked", reason: rejection.short, decision: blockDecision(decision, rejection, { reasonCode }) };
}

/** One task reads as a task, not a plan: the overlay says what the approval launches. */
function dispatchPlanApprovalLead(plan: DispatchPlanView): string {
	const scope = plan.taskCount === 1 ? "this task" : "the whole plan";
	return `Approving this call approves ${scope}:\n${plan.text}`;
}

/**
 * The one parked decision for a call whose host checks need the session's
 * test-runner consent. It keeps the call's own classification and description,
 * so the card names the dispatch or job and not the test runner's execute
 * class, and it carries the consent rail, so approving it gives the consent
 * before the call re-admits. When the call asked on its own, its ask leads and
 * the consent is stated as part of the same approval.
 */
export function sessionConsentParkDecision(
	call: ClassifierCall,
	own: SafetyDecision,
	consent: { label: string; decision: SafetyDecision },
	plan: DispatchPlanView | null,
): SafetyDecision {
	const need = `${consent.label} runs a test runner on repository code this session has not confirmed`;
	const grants = "Approving also gives this session's test-runner consent, so later test runners run without asking.";
	const consentAsk = consent.decision.kind === "ask" ? consent.decision : undefined;
	const ownAsk = own.kind === "ask" ? own : undefined;
	const lead =
		ownAsk !== undefined
			? ownAsk.rejection.detail
			: plan !== null
				? dispatchPlanApprovalLead(plan)
				: `${call.tool} needs the session's test-runner consent.`;
	const detail = `${lead}\n${need}. ${grants}`;
	return {
		kind: "ask",
		classification: own.classification,
		confirmationRuleId: SESSION_CODE_CONSENT_RULE_ID,
		rejection: {
			short:
				ownAsk !== undefined
					? `${ownAsk.rejection.short}; approving also gives the session's test-runner consent (${need})`
					: `${call.tool} needs the session's test-runner consent: ${need}`,
			detail,
			hints: [...(ownAsk?.rejection.hints ?? []), ...(consentAsk?.rejection.hints ?? [])],
		},
		...(consentAsk?.policy !== undefined
			? { policy: { ...consentAsk.policy, reasons: [`${need}. ${grants}`, ...consentAsk.policy.reasons.slice(1)] } }
			: {}),
	};
}

/**
 * Plan-approval ask for a plan-scale dispatch call. The rejection detail IS
 * the plan artifact (topology, per-task agent/model/node), so the approval
 * overlay shows the operator exactly what one approval will launch.
 */
export function toDispatchPlanAskDecision(
	decision: SafetyDecision,
	level: AutonomyLevel,
	plan: DispatchPlanView,
): SafetyDecision {
	const playbook = plan.fleetRun;
	if (playbook !== undefined) {
		return {
			kind: "ask",
			classification: decision.classification,
			rejection: {
				short: `playbook ${playbook.name} needs approval (${playbook.stepCount} ${playbook.stepCount === 1 ? "step" : "steps"}) at autonomy ${level}`,
				detail: `Approving this call starts the playbook run:\n${plan.text}`,
				hints: [
					"One approval covers every step of the run, each on the route the card shows.",
					"Deny to keep the fleet idle; the model can revise the playbook and preview it again.",
				],
			},
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
			recovery: `A headless run cannot approve a playbook; start it outside the session: pancode fleet run ${playbook.name} "<task>"`,
		};
	}
	const single = plan.taskCount === 1;
	return {
		kind: "ask",
		classification: decision.classification,
		rejection: {
			short: `dispatch plan needs approval (${plan.topology}, ${plan.taskCount} ${single ? "task" : "tasks"}) at autonomy ${level}`,
			detail: dispatchPlanApprovalLead(plan),
			hints: single
				? [
						"One approval covers this task's run, including its remote placement or failover.",
						"Deny to keep the fleet idle and revise the task first.",
					]
				: [
						"One approval covers every run in the plan, including remote placements.",
						"Deny to keep the fleet idle and revise the plan first.",
					],
		},
		...(decision.policy !== undefined ? { policy: decision.policy } : {}),
	};
}
