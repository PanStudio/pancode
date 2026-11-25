// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync } from "node:fs";
import { parseJsonObjectPayload } from "../core/json-payload.js";
import type { TelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import {
	COUNCIL_SEAT_NOT_RUN_ID,
	COUNCIL_SEAT_NOT_RUN_WORDS,
	type CouncilReport,
	type CouncilReportMember,
	councilVerdictKey,
	isCouncilSeatNotRun,
} from "../domains/agents/result-contract-council.js";
import { type BriefingNotice, type BriefingPart, type BuiltBriefing, buildBriefing } from "../domains/context/index.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { councilJudgeAgentId } from "../domains/dispatch/execution-role.js";
import {
	COUNCIL_JUDGE_PROMPT,
	COUNCIL_MIN_MEMBERS,
	councilBallotContract,
	councilSeatDownReason,
	councilTooFewLiveSeats,
	renderCouncilVoteMemberTask,
} from "../domains/dispatch/gate-role-prompts.js";
import {
	type DispatchIntent,
	declaredScopeIntent,
	narrowDispatchIntentToReadOnly,
} from "../domains/dispatch/intent.js";
import { resolveDispatchPathScope } from "../domains/dispatch/path-scope.js";
import type { RunResult } from "../domains/dispatch/types.js";
import { councilVoterPersona } from "./dispatch-arguments.js";
import { newGateGroupId, PARENT_CANCEL, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import {
	consumeGateSensitiveDispatchEvents,
	isPipelineStepFailure,
	normalizedAssistantText,
	pipelineFailureReason,
	subjectRef,
} from "./dispatch-gate-runs.js";
import { type CompletedRun, completeRun, dispatchDetails } from "./dispatch-output.js";
import { withResolvedPlanTaskPin } from "./dispatch-plan.js";
import type { DispatchCouncilSettings, DispatchToolDeps } from "./dispatch-types.js";
import type { ToolResult, ToolResultDetails } from "./tool-spec.js";
import { runResultPath } from "./worker-evidence.js";

const COUNCIL_BRIEFING_MAX_BYTES = 8 * 1024;

/** The notice for an excerpt whose whole answer the recipient cannot reach: it says what was omitted. */
const councilBriefingNotice = (omitted: number, total: number): string =>
	`\n[pancode: ${omitted} of ${total} bytes omitted from this excerpt]\n`;

const COUNCIL_FAILURE_CAUSE_MAX_CHARS = 300;

/**
 * A seat's excerpt notice. The council profile's `read` reaches run scopes (readScopeExemptRoots), so when the peer's
 * result object exists the notice names it; otherwise it states only what was omitted.
 */
function councilExcerptNotice(receipt: RunResult): BriefingNotice {
	let path: string | null = null;
	try {
		const candidate = runResultPath(receipt);
		if (existsSync(candidate)) path = candidate;
	} catch {
		// A receipt the settlement cannot read has no result object to name.
	}
	return path === null
		? councilBriefingNotice
		: (omitted, total) =>
				`\n[pancode: ${omitted} of ${total} bytes omitted from this excerpt; read output.text in ${path} for the whole answer]\n`;
}

/** Why a seat failed, on one bounded line: the receipt's detail (the provider's cause) after its outcome. */
function councilFailureCause(receipt: RunResult): string {
	const outcome = pipelineFailureReason(receipt);
	const detail = Array.from((receipt.outcomeDetail ?? "").replace(/\s+/gu, " ").trim());
	if (detail.length === 0) return outcome;
	const line =
		detail.length > COUNCIL_FAILURE_CAUSE_MAX_CHARS
			? `${detail.slice(0, COUNCIL_FAILURE_CAUSE_MAX_CHARS - 1).join("")}…`
			: detail.join("");
	return `${outcome}: ${line}`;
}

/**
 * The scope a later council round and the judge declare (bt-47 drv-m3b CF-a, CF-b). Their briefings carry host text
 * (peer answers, failure causes such as an endpoint path, the notice naming a result object) that prose inference
 * would refuse or read as the worker's scope. The convening intent, narrowed read-only, holds when the call declared
 * one; otherwise the paths inferred from the operator's own task and briefing, which round 1 ran with, are declared.
 * An inference over the intent path cap declares no paths: those paths only select project rules, never authority.
 */
function councilScopeIntent(base: DispatchRequest): DispatchIntent {
	if (base.intent !== undefined) return narrowDispatchIntentToReadOnly(base.intent);
	const declared = declaredScopeIntent({ relevantPaths: resolveDispatchPathScope(base).workingContextPaths });
	if (declared.ok) return declared.intent;
	const empty = declaredScopeIntent({});
	if (!empty.ok) throw new Error(`dispatch: council scope: ${empty.message}`);
	return empty.intent;
}

/**
 * The verdict a council answer casts, under its tally key.
 *
 * A tally groups by the exact string, so folding case and separators is the
 * difference between two members who gave one answer agreeing and splitting
 * into a `no_majority` the operator has to read past. Folding happens here, at
 * the one place a verdict is ever read, so the reported member verdict and the
 * tally key can never disagree.
 */
function councilVerdict(text: string): string | undefined {
	const parsed = parseJsonObjectPayload(text);
	return parsed.ok && typeof parsed.value.verdict === "string" && parsed.value.verdict.trim().length > 0
		? councilVerdictKey(parsed.value.verdict)
		: undefined;
}

function councilJudgeText(text: string): string {
	const parsed = parseJsonObjectPayload(text);
	return parsed.ok && typeof parsed.value.text === "string" && parsed.value.text.trim().length > 0
		? parsed.value.text.trim()
		: text;
}

function boundedCouncilBriefing(parts: ReadonlyArray<BriefingPart>): BuiltBriefing {
	return buildBriefing(parts, COUNCIL_BRIEFING_MAX_BYTES, councilBriefingNotice);
}

/** Every member's briefing opens with this, whatever recipe it runs as. */
const COUNCIL_MEMBER_FRAMING =
	"[council] You are advising a council read-only: read and search the code, then answer the question. Do not edit files, run builds or commit; no write tool is available in this seat.";

export async function runCouncil(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	council: DispatchCouncilSettings,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	clipTelemetry: TelemetryContext | undefined,
): Promise<{ report: CouncilReport; runs: CompletedRun[]; group: string }> {
	const group = newGateGroupId("council");
	const runs: CompletedRun[] = [];
	// Every seat of every round in roster order; a seat whose target is down has no run (FL-4).
	const seats: Array<{ label: string; round: number; run: CompletedRun | null }> = [];
	const down = new Map<string, string>((council.downSeats ?? []).map((seat) => [seat.label, seat.reason]));
	let prior = new Map<string, CompletedRun>();
	const timedOut = new Set<string>();
	let scopeIntent: DispatchIntent | undefined;
	const councilIntent = (): DispatchIntent => {
		scopeIntent ??= councilScopeIntent(base);
		return scopeIntent;
	};
	const runMember = async (request: DispatchRequest, briefing?: BuiltBriefing): Promise<CompletedRun> => {
		if (signal?.aborted) throw new Error("council dispatch aborted");
		const handle = await deps.dispatch.dispatch(request);
		if (briefing !== undefined && briefing.clips.length > 0 && request.council !== undefined) {
			(deps.bus ?? telemetryHub()).emit(
				"context.briefing_clipped",
				{
					runId: handle.runId,
					role: request.gate?.role === "synthesis" ? "synthesis" : "member",
					group,
					round: request.council.round ?? 1,
					capBytes: COUNCIL_BRIEFING_MAX_BYTES,
					bytes: briefing.bytes,
					parts: briefing.clips.map((clip) => ({ ...clip })),
				},
				clipTelemetry,
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		// A member deadline ends one slow voice, not the council: the others'
		// answers come back and the report names who was cut off.
		const deadline = request.gate?.role === "member" ? council.memberDeadlineMs : undefined;
		const limit = deadline !== undefined && (timeoutMs === undefined || deadline < timeoutMs) ? deadline : timeoutMs;
		if (limit !== undefined) {
			timer = setTimeout(() => {
				if (limit === deadline && request.council !== undefined) timedOut.add(request.council.label);
				deps.dispatch.abort(handle.runId, {
					cause: "timeout",
					detail: limit === deadline ? `member deadline of ${limit}ms passed` : `timed out after ${limit}ms`,
				});
			}, limit);
		}
		const abort = (): void => deps.dispatch.abort(handle.runId, PARENT_CANCEL);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const [summary, receipt] = await Promise.all([
				consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events),
				handle.finalPromise,
			]);
			const completed = completeRun(deps, receipt, summary);
			// A deadline that fires while a finished member winds down did not cut it off.
			if (request.council !== undefined && !isPipelineStepFailure(completed.receipt))
				timedOut.delete(request.council.label);
			return completed;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	};

	for (let round = 1; round <= council.rounds; round += 1) {
		const settled = await Promise.all(
			council.members.map(async (member, index) => {
				if (down.has(member.label)) return [member.label, null] as const;
				// A seated coder or architect argues from its perspective; it must not try to edit and fail.
				// The original briefing counts against the seat's cap; each peer keeps its label or failure status.
				const peerParts: BriefingPart[] = [{ kind: "framing", lead: COUNCIL_MEMBER_FRAMING }];
				// Round 1 has no peers to tell the original briefing from, so its text stays what it always was.
				if (base.briefing !== undefined)
					peerParts.push({ kind: "task", lead: round > 1 ? "[original briefing] " : "", body: base.briefing });
				if (round > 1) {
					for (const peer of council.members) {
						if (peer.label === member.label) continue;
						const previous = prior.get(peer.label);
						const downReason = down.get(peer.label);
						if (previous === undefined && downReason !== undefined) {
							peerParts.push({
								kind: "evidence",
								lead: `[${peer.label}] failed in prior round; no answer contributed. Reason: `,
								body: downReason,
							});
						} else if (previous === undefined) {
							peerParts.push({ kind: "evidence", lead: `[${peer.label}] failed in prior round; no answer contributed.` });
						} else if (isPipelineStepFailure(previous.receipt)) {
							peerParts.push({
								kind: "evidence",
								lead: `[${peer.label}] failed in prior round; no answer contributed. Reason: `,
								body: councilFailureCause(previous.receipt),
							});
						} else {
							peerParts.push({
								kind: "evidence",
								lead: `[${peer.label}] `,
								body: normalizedAssistantText(previous.summary),
								notice: councilExcerptNotice(previous.receipt),
							});
						}
					}
				}
				// Round 1 is bounded by the same builder and cap as later rounds; it simply has no peers yet.
				const peerBriefing = boundedCouncilBriefing(peerParts);
				const position = (round - 1) * council.members.length + index + 1;
				const pinned = council.resolvedTasks?.find((task) => task.role === "member" && task.position === position);
				let voteTask = base.task;
				if (council.synthesis === "vote") {
					if (pinned !== undefined) voteTask = pinned.task;
					else if (council.resolvedTasks !== undefined)
						throw new Error(`dispatch: resolved council plan has no member task at position ${position}`);
					else voteTask = renderCouncilVoteMemberTask(base.task);
				}
				const request: DispatchRequest = {
					...base,
					...(member.agent !== undefined ? { agentId: member.agent } : {}),
					executionRole: "seat",
					readOnly: true,
					toolProfile: "council-read-only",
					// Admission already demoted the caller's declared write roots to
					// read roots for every planned member, and the resolved-plan pin
					// below carries that narrowed intent in. Repeat it here so the
					// no-plan fallback path lands on the same request: a member spread
					// from `base` would otherwise inherit a write scope its read-only
					// autonomy cannot grant, and the two paths would disagree. A later
					// round declares its scope even for an undeclared call, so the host
					// text in its briefing is never inferred as scope (bt-47 CF-b).
					...(round > 1 || base.intent !== undefined ? { intent: councilIntent() } : {}),
					// A vote is a majority over the members' verdict fields, so a vote
					// council asks each member for one and seals the ballot it asked
					// for. The seated recipe is untouched: the ask is a task suffix and
					// the postcondition is an override, so the member is still the
					// agent the operator seated, and any recipe can be voted with.
					// Admission already composed the suffix into each resolved member
					// task, so reuse its exact bytes. The fallback supports dispatch
					// contracts that have no resolved admission artifact.
					...(council.synthesis === "vote"
						? {
								task: voteTask,
								resultContractOverride: councilBallotContract(base.task),
								...councilVoterPersona(deps.getAgentSpecs().find((spec) => spec.id === (member.agent ?? base.agentId))),
							}
						: {}),
					target: member.target,
					...(member.model ? { model: member.model } : {}),
					...(member.thinking ? { thinkingLevel: member.thinking as NonNullable<DispatchRequest["thinkingLevel"]> } : {}),
					gate: {
						role: "member",
						group,
						cycle: round,
						...(round > 1
							? {
									subjects: [...prior.entries()]
										.filter(([label]) => label !== member.label)
										.map(([, run]) => subjectRef(run.receipt)),
								}
							: {}),
					},
					council: { group, label: member.label, ...(member.color ? { color: member.color } : {}), round },
					briefing: peerBriefing.text,
				};
				try {
					return [
						member.label,
						await runMember(withResolvedPlanTaskPin(request, pinned, { pinTask: false, pinBriefing: false }), peerBriefing),
					] as const;
				} catch (error) {
					// Admission refused this seat's target as down: it sits as a failed seat, not a refused council.
					const reason = councilSeatDownReason(error);
					if (reason === null) throw error;
					down.set(member.label, reason);
					return [member.label, null] as const;
				}
			}),
		);
		if (round === 1 && council.members.length - down.size < COUNCIL_MIN_MEMBERS) {
			throw new Error(
				councilTooFewLiveSeats(
					council.members.length,
					[...down].map(([label, reason]) => ({ label, reason })),
				),
			);
		}
		const live = settled.flatMap(([label, run]) => (run === null ? [] : [[label, run] as const]));
		seats.push(...settled.map(([label, run]) => ({ label, round, run })));
		prior = new Map(live);
		runs.push(...live.map(([, run]) => run));
	}

	const members: CouncilReportMember[] = seats.map(({ label, round, run }) => {
		if (run === null)
			return {
				label,
				runId: COUNCIL_SEAT_NOT_RUN_ID,
				round,
				answer: "",
				failed: { reason: down.get(label) ?? "seat not run" },
			};
		const text = normalizedAssistantText(run.summary);
		const failed = isPipelineStepFailure(run.receipt);
		const verdict = councilVerdict(text);
		return {
			label: run.receipt.council?.label ?? "member",
			runId: run.receipt.runId,
			round: run.receipt.council?.round ?? 1,
			// A ballot's prose lives in its `text` field, so the report carries the
			// member's answer rather than its wire envelope, the same way the judge
			// line already does. A member answering any other shape has no `text`
			// key and keeps its whole answer.
			answer: councilJudgeText(text),
			...(verdict !== undefined ? { verdict } : {}),
			...(failed ? { failed: { reason: pipelineFailureReason(run.receipt) } } : {}),
		};
	});
	const finalMembers = members.filter((member) => member.round === council.rounds && member.failed === undefined);
	const finalReports = members.filter((member) => member.round === council.rounds);
	let synthesis: CouncilReport["synthesis"] = { kind: council.synthesis };
	if (council.synthesis === "vote") {
		const tally: Record<string, number> = {};
		for (const member of finalMembers)
			if (member.verdict !== undefined) tally[member.verdict] = (tally[member.verdict] ?? 0) + 1;
		const ranked = Object.entries(tally).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
		const winner = ranked[0];
		const verdict =
			winner === undefined ? "no_verdict_field" : winner[1] > finalMembers.length / 2 ? winner[0] : "no_majority";
		synthesis = { kind: "vote", verdict, tally };
	} else if (council.synthesis === "judge") {
		const finalRuns = [...prior.values()];
		// The task travels in the judge's own task field, so only the seats' answers count against the cap.
		const judgeBriefing = boundedCouncilBriefing(
			finalReports.map((member): BriefingPart => {
				const receipt = runs.find((run) => run.receipt.runId === member.runId)?.receipt;
				return member.failed === undefined
					? {
							kind: "evidence",
							lead: `[${member.label}] `,
							body: member.answer,
							...(receipt === undefined ? {} : { notice: councilExcerptNotice(receipt) }),
						}
					: {
							kind: "evidence",
							lead: `[${member.label}] failed; no final answer contributed. Reason: `,
							body: receipt === undefined ? member.failed.reason : councilFailureCause(receipt),
						};
			}),
		);
		const judgeRequest: DispatchRequest = {
			agentId: councilJudgeAgentId(council.judge?.agent, base.agentId),
			...(base.budget === undefined ? {} : { budget: base.budget }),
			...(base.record === undefined ? {} : { record: base.record }),
			executionRole: "judge",
			task: `Synthesize the council answers for this task:\n\n${base.task}`,
			briefing: judgeBriefing.text,
			// The seats' answers and failure causes are evidence, not scope (bt-47 CF-a).
			intent: councilIntent(),
			systemPrompt: COUNCIL_JUDGE_PROMPT,
			readOnly: true,
			toolProfile: "council-read-only",
			// The judge reads in the seats' tree: they carry base.cwd through the spread, the judge has no spread.
			...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
			gate: { role: "synthesis", group, cycle: council.rounds, subjects: finalRuns.map((run) => subjectRef(run.receipt)) },
			council: { group, label: "synthesis", round: council.rounds },
			...(council.judge?.target ? { target: council.judge.target } : {}),
			...(council.judge?.model ? { model: council.judge.model } : {}),
			...(council.judge?.node ? { node: council.judge.node } : {}),
			...(base.plan ? { plan: base.plan } : {}),
			...(base.parentToolCallId ? { parentToolCallId: base.parentToolCallId } : {}),
			...(base.rootRequestOrigin !== undefined ? { rootRequestOrigin: base.rootRequestOrigin } : {}),
			...(base.decisionRefs !== undefined ? { decisionRefs: base.decisionRefs } : {}),
		};
		const pinned = council.resolvedTasks?.find((task) => task.role === "synthesis");
		const judgeRun = await runMember(
			withResolvedPlanTaskPin(judgeRequest, pinned, { pinTask: false, pinBriefing: false }),
			judgeBriefing,
		);
		runs.push(judgeRun);
		const rawText = normalizedAssistantText(judgeRun.summary);
		const text = councilJudgeText(rawText);
		const verdict = councilVerdict(rawText);
		synthesis = {
			kind: "judge",
			text,
			...(verdict !== undefined ? { verdict } : {}),
			judgeRunId: judgeRun.receipt.runId,
		};
	}
	if (prior.size > 0 && deps.dispatch.sealCouncilSynthesis !== undefined) {
		const finalRuns = [...prior.values()];
		const template = finalRuns[0];
		if (template === undefined) throw new Error("council synthesis has no final member run result");
		// The sealed text is the whole council-report, not the synthesis alone:
		// /share <synthesis runId> reads this receipt to bring every final
		// member's labelled answer and the synthesis line into the main context.
		// A judge council seals it on the same terms: the judge run's own
		// receipt holds only its {"verdict","text"} payload, which carries no
		// member answers and no roster labels for the main agent to act on.
		const text = JSON.stringify({
			members,
			synthesis,
			...(timedOut.size > 0 ? { partial: { timedOut: [...timedOut].sort() } } : {}),
		} satisfies CouncilReport);
		const receipt = await deps.dispatch.sealCouncilSynthesis({
			group,
			round: council.rounds,
			kind: council.synthesis,
			text,
			subjects: finalRuns.map((run) => subjectRef(run.receipt)),
			template: template.receipt,
			...(base.rootRequestOrigin !== undefined ? { rootRequestOrigin: base.rootRequestOrigin } : {}),
		});
		runs.push(
			completeRun(deps, receipt, {
				count: 0,
				types: [],
				lastAssistantText: text,
				terminalAttemptRunId: receipt.runId,
			}),
		);
	}
	return {
		report: { members, synthesis, ...(timedOut.size > 0 ? { partial: { timedOut: [...timedOut].sort() } } : {}) },
		runs,
		group,
	};
}

export function councilResult(deps: DispatchToolDeps, outcome: Awaited<ReturnType<typeof runCouncil>>): ToolResult {
	const sections = outcome.report.members
		.filter((member) => member.round === Math.max(...outcome.report.members.map((entry) => entry.round)))
		.map((member) => {
			const run = outcome.runs.find((entry) => entry.receipt.runId === member.runId);
			// A skipped seat names itself in the words every council surface uses, with admission's reason after them.
			if (isCouncilSeatNotRun(member))
				return `[${member.label}] ${COUNCIL_SEAT_NOT_RUN_WORDS}: ${(member.failed?.reason ?? "").replace(/^seat not run:?\s*/u, "")}`;
			if (run === undefined && member.failed !== undefined) return `[${member.label}] ${member.failed.reason}`;
			return `[${member.label}] ${run?.receipt.targetId ?? "unknown"}/${run?.receipt.wireModelId ?? "unknown"}\n${member.answer}`;
		});
	sections.push(
		`[synthesis] ${outcome.report.synthesis.kind}\n${outcome.report.synthesis.text ?? outcome.report.synthesis.verdict ?? "none"}`,
	);
	const details: ToolResultDetails = {
		...dispatchDetails(deps, "council", outcome.runs),
		council: { group: outcome.group, ...outcome.report },
	};
	const finalRound = Math.max(...outcome.report.members.map((member) => member.round));
	const timedOut = new Set(outcome.report.partial?.timedOut ?? []);
	// A seat whose target was down never ran: it is named above but counts neither as an answer nor as a failure (FX-20).
	const finals = outcome.report.members.filter((member) => member.round === finalRound && !isCouncilSeatNotRun(member));
	if (timedOut.size > 0) {
		sections.unshift(
			`[partial] council returned without ${[...timedOut].join(", ")}: member deadline passed; ${finals.filter((member) => member.failed === undefined).length} of ${finals.length} members answered`,
		);
	}
	// A member the deadline ended is reported as partial, not as a failed
	// council, as long as another member answered.
	const answered = finals.some((member) => member.failed === undefined);
	const failed =
		finals.some((member) => member.failed !== undefined && !(answered && timedOut.has(member.label))) ||
		outcome.runs.some((run) => run.receipt.gate?.role === "synthesis" && isPipelineStepFailure(run.receipt));
	return failed
		? { kind: "error", message: sections.join("\n\n"), details }
		: { kind: "ok", output: sections.join("\n\n"), details };
}
