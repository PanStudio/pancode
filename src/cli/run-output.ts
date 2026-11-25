// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { renderFactField } from "../core/telemetry/render.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import {
	completedRunCaveat,
	TOOL_GUARD_REASON_CODE,
	workerFailureHeadline,
} from "../domains/dispatch/failure-headline.js";
import { failedChecks, gateVerdict, sealedReport } from "../domains/dispatch/gate-verdict.js";
import type { RunResult, SafetyBlockedAttempt } from "../domains/dispatch/types.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { holdCutOffText, redactUrlCredentials } from "../domains/safety/redaction.js";
import {
	responseModelIdWords,
	runGatewayRoutingLabel,
	runResponseModelIdObservationLabel,
} from "../tools/dispatch-event-text.js";
import type { RunCompletionV2 } from "./modes/run-json-schema-v2.js";

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: [];
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

/**
 * A verifier's or reviewer's own verdict and the checks it found failing; the run settles succeeded and only the
 * process exit status says the gate failed.
 */
export function verifierVerdict(receipt: RunResult): { verdict: string; failedChecks: string[] } | null {
	return gateVerdict(receipt);
}

/**
 * Checks that ran and failed, which print under Failed checks rather than as unverified: a code step's checks that
 * ran, and a mutation report's failed validations, since its contract lists only executed checks there and names the
 * ones it did not run under declaredChecks (CLI-6).
 */
function executedCodeFailures(receipt: RunResult): string[] {
	const report = sealedReport(receipt);
	if (report?.kind === "code-report") return failedChecks(report.data.checks, true);
	return report?.kind === "mutation-report" ? failedChecks(report.data.validations) : [];
}

/** DF-6: project only contract fields from the sealed result, never infer limits from narration. */
function sealedResultLimitations(receipt: RunResult): string[] {
	const report = sealedReport(receipt);
	if (report === null) return [];
	const { kind, data } = report;
	switch (kind) {
		case "mutation-report": {
			const declared = strings(data.declaredChecks);
			const changed = strings(data.mutatedPaths);
			// A change no check followed is unverified even when the report names no check it skipped (dogfood F3).
			const unchecked =
				changed.length > 0 &&
				declared.length === 0 &&
				records(data.validations).length === 0 &&
				receipt.verification.state !== "verified";
			return unchecked ? [`No check ran after the change to ${changed.join(", ")}`] : declared;
		}
		case "code-report":
			// A check that ran and failed is a failure, not a gap; a report sealed before `ran` keeps every failure here.
			return failedChecks(data.checks, false);
		case "scout-report":
			return [
				...strings([data.degradedReason]),
				...strings(data.ungroundedClaims).map((claim) => `Ungrounded claim: ${claim}`),
				...records(data.findings).flatMap((finding) =>
					typeof finding.claim === "string" &&
					(typeof finding.path !== "string" ||
						typeof finding.line !== "number" ||
						!Number.isSafeInteger(finding.line) ||
						finding.line < 1)
						? [`Ungrounded claim: ${finding.claim}`]
						: [],
				),
				...(data.needsSplit === true
					? records(data.proposedSubtasks).flatMap((subtask) =>
							strings([subtask.task]).map((task) => `Scout requested further work: ${task}`),
						)
					: []),
			];
		case "world-knowledge-report":
			return [
				...(data.discovery === "unavailable" || data.discovery === "caller-supplied-only"
					? [`Discovery: ${data.discovery}`]
					: []),
				...strings(data.uncertainties),
				...strings(data.followUpVerification),
			];
		case "provenance-report":
			return [...strings(data.missingEvidence), ...strings(data.nextInspections)];
		case "debugger-report":
			return data.reproduction === "unknown" || data.reproduction === "not-reproduced"
				? [`Reproduction: ${data.reproduction}`]
				: [];
		default:
			return [];
	}
}

function limitationLine(item: string): string {
	const plain = sanitizeCallTargetText(item);
	const chars = Array.from(plain);
	return chars.length > 400 ? `${chars.slice(0, 399).join("")}…` : plain;
}

/** The `Not verified:` block a run prints after its answer, one line per item; empty without items. */
function notVerifiedBlock(items: ReadonlyArray<string>): string {
	return items.length > 0 ? `\nNot verified:\n${items.map((item) => `- ${limitationLine(item)}`).join("\n")}\n` : "";
}

/** The host-sealed completion facts that leave a main run's answer unverified, in the order they print. */
const SEALED_FACT_NOT_VERIFIED: ReadonlyArray<readonly [string, string]> = [
	["unvalidated_mutation", "No check ran after the last write, so the change is untested."],
	["failed_check", "A check failed after the last change."],
	["missing_output", "A file the task named as an output does not exist."],
	[
		"observation_budget",
		"Observation budget: the per-turn observation pool refused the run's last observation calls (read, grep, find, ls, code_nav, context), so what they would have returned was not read.",
	],
];

/**
 * The `Not verified:` block for a main run's host-sealed completion facts, the ones that lower a declared `done` to
 * `partly_done` because of what went unchecked: an unvalidated write (dogfood F3), a failed check, a missing output, or
 * last observation calls the per-turn pool refused (CLI-P42). Empty when no such fact was sealed.
 */
export function sealedFactsNotVerified(facts: ReadonlyArray<string>): string {
	return notVerifiedBlock(SEALED_FACT_NOT_VERIFIED.filter(([fact]) => facts.includes(fact)).map(([, line]) => line));
}

/**
 * The report a run's final text is the JSON of when the host sealed none: a run that failed after its worker replied
 * keeps no structured report, though its reply conformed to the contract the validator source id names, so its words
 * are read the same way a succeeded run's are (fleet finding 7). Undefined when the text is not that report.
 */
export function contractReportOf(
	text: string,
	contract: { sourceId: string; conformance: string } | null | undefined,
): { kind: string; data: Record<string, unknown> } | undefined {
	if (contract?.conformance !== "pass") return undefined;
	const kind = /^agent-result-contract:([^:]+):/u.exec(contract.sourceId)?.[1];
	if (kind === undefined) return undefined;
	try {
		const data: unknown = JSON.parse(text.trim());
		return data !== null && typeof data === "object" && !Array.isArray(data)
			? { kind, data: data as Record<string, unknown> }
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * A sealed report in the words it holds, or `text` as it is when nothing sealed it. `changed: false` leaves out the
 * report's changed paths for a surface that already lists the run's own.
 */
export function sealedReportAnswer(
	text: string,
	structured: { kind: string; data: Record<string, unknown> } | undefined,
	options: { changed?: boolean } = {},
): string {
	if (structured === undefined) return text.trim();
	const data = structured.data;
	const claims = (value: unknown): string[] =>
		records(value).flatMap((finding) => {
			if (typeof finding.claim !== "string") return [];
			const at =
				typeof finding.path === "string" && typeof finding.line === "number"
					? ` (${finding.path}:${finding.line})`
					: typeof finding.evidence === "string"
						? ` (${finding.evidence})`
						: "";
			return [`- ${finding.claim}${at}`];
		});
	const bullets = (value: unknown): string[] => strings(value).map((item) => `- ${item}`);
	let lines: string[];
	switch (structured.kind) {
		case "mutation-report": {
			// A coder's report names what it changed; a person reads that as a line, not as the JSON it sealed.
			const changed = strings(data.mutatedPaths);
			lines = [
				...strings([data.summary]),
				...bullets(data.observations),
				...(changed.length > 0 && options.changed !== false ? [`changed: ${changed.join(", ")}`] : []),
			];
			break;
		}
		case "scout-report":
		case "research-report":
			lines = claims(data.findings);
			break;
		case "world-knowledge-report":
			lines = [...strings(data.synthesis), ...claims(data.facts)];
			break;
		case "provenance-report":
			lines = bullets(data.confirmedFacts);
			break;
		case "oracle-report":
			lines = strings([data.verdict, data.challenge]);
			break;
		default:
			lines = [];
	}
	return lines.length > 0 ? lines.join("\n") : text.trim();
}

/** The human answer, settled evidence limits, and the run result line in that order. */
/**
 * A `run --agent` worker's answer in words, as text mode prints it and the v2 envelope's `result.text` holds it. A
 * worker whose last words were its sealed JSON report reads in the words the report holds, as the card does; the
 * report itself stays on the receipt's `output.structured`.
 */
export function dispatchAnswerText(streamedAnswer: string, receipt: RunResult): string {
	const output = receipt.output;
	const report =
		output?.structured ??
		(output?.state === "final" ? contractReportOf(output.text, receipt.quality?.resultContract) : undefined);
	const streamedReport = report !== undefined && /^\s*\{[\s\S]*\}\s*$/u.test(streamedAnswer);
	// A native worker that answered only through its result contract reads in the sealed result's prose (DF-6).
	const whole =
		streamedAnswer.length > 0 && !streamedReport
			? streamedAnswer
			: output?.state === "final"
				? sealedReportAnswer(output.text, report)
				: "";
	// A run that never settled a final message can have stopped inside a URL, so what it holds stays hidden (#446).
	const cutOff = receipt.output === undefined ? receipt.exitCode !== 0 : receipt.output.state === "partial";
	return redactUrlCredentials(cutOff ? holdCutOffText(whole) : whole);
}

export function formatDispatchHumanOutput(
	streamedAnswer: string,
	receipt: RunResult,
	notRetried?: string | null,
): string {
	const answer = dispatchAnswerText(streamedAnswer, receipt);
	const limitations = sealedResultLimitations(receipt);
	const verifier = verifierVerdict(receipt);
	const executed = [...(verifier?.failedChecks ?? []), ...executedCodeFailures(receipt)];
	const failedBlock =
		executed.length > 0 ? `\nFailed checks:\n${executed.map((item) => `- ${limitationLine(item)}`).join("\n")}\n` : "";
	const block = notVerifiedBlock(limitations);
	// The one exit for a headless answer, whichever of the streamed, last or sealed text it came from (#446).
	// A person reading the run learns what went wrong in words before the machine line repeats the record's own detail.
	const headline = receipt.exitCode !== 0 ? workerFailureHeadline(receipt.failureMessage) : null;
	const failed = headline === null ? "" : `\nFailed: ${headline}\n`;
	// Why the host ran no further attempt, which the sealed receipt cannot say: the decision follows its seal (row 371).
	const notRetriedLine = notRetried ? `Not retried: ${limitationLine(notRetried)}\n` : "";
	// A run that finished with a refused call or a wrong-format answer says so in the words its worker card and board
	// row use, so a script reading exit 0 and a person reading the card are told the same thing.
	// A run that called no tools is only a hint on the card, and an answer-only worker legitimately calls none, so the
	// print states the two caveats that change what the answer is worth.
	const found = receipt.exitCode === 0 ? receiptCaveat(receipt) : null;
	const caveat = found?.kind === "no-tools" ? null : found;
	const finishedWith = caveat === null ? "" : `\nFinished with a caveat: ${caveat.words}\n`;
	return redactUrlCredentials(
		`${answer.length > 0 ? `${answer}\n` : ""}${failedBlock}${block}${failed}${notRetriedLine}${finishedWith}${formatResultLine(receipt, limitations.length, verifier, executed.length)}\n`,
	);
}

/** The execute-class calls the run refused, a denied ask or a block; a guard's repetition stop is not a refusal. */
function refusedExecuteCalls(receipt: RunResult): SafetyBlockedAttempt[] {
	const safety = receipt.safety;
	return [...(safety?.permissionRequestedAttempts ?? []), ...(safety?.blockedAttempts ?? [])].filter(
		(attempt) => attempt.actionClass === "execute" && attempt.reasonCode !== TOOL_GUARD_REASON_CODE,
	);
}

/** The completion vocabulary's word for each `limitation` tool reason a worker recorded. */
const RECORDED_LIMITATION_WHY: Readonly<Record<string, string>> = {
	"no-runner": "tool_unavailable",
	blocked: "blocked_by_policy",
	"out-of-scope": "out_of_scope",
	environment: "tool_unavailable",
	"write-root": "missing_access",
	other: "other",
};

/**
 * `run --agent`'s completion in the shape a main run's takes (CLI-P58), read only from the sealed receipt, never from
 * its prose. A worker declares through its sealed final answer: exit 0 claims `done`, any other exit `not_done`. A
 * `done` is assessed `partly_done` when a check failed (a failed result-contract quality or a rejected host
 * verification) or when an execute call was refused and nothing verified the run, which is how a refused run of the
 * operator's named check reads. `unverified` holds the checks the sealed report names as not run. `limitations` also
 * holds each limitation the worker recorded through its tool, which its report can leave out (row 371).
 */
export function agentRunCompletion(receipt: RunResult): RunCompletionV2 {
	const refused = refusedExecuteCalls(receipt);
	const limitations = [
		...refused.map((attempt) => {
			const why =
				attempt.reason ?? (attempt.permissionRequired === true ? "needed an approval this run could not give" : undefined);
			const what = `${attempt.tool} call refused${why !== undefined ? `: ${why}` : ""}`;
			return { what: limitationLine(redactUrlCredentials(what)), why: "blocked_by_policy" };
		}),
		// A limitation the worker recorded is its declaration whether or not its report repeated it (row 371).
		...(receipt.recordedLimitations ?? []).map((item) => ({
			what: limitationLine(redactUrlCredentials(item.scope)),
			why: RECORDED_LIMITATION_WHY[item.reason] ?? "other",
		})),
	];
	const unverified = sealedResultLimitations(receipt).map((item) => limitationLine(redactUrlCredentials(item)));
	if (receipt.output?.state !== "final")
		return { declared: false, claimed: null, assessed: "unknown", state: "unknown", limitations, unverified };
	const facts: NonNullable<RunCompletionV2["facts"]> = [];
	if (receipt.quality?.resultContract?.quality === "fail" || receipt.hostVerification?.status === "rejected")
		facts.push("failed_check");
	if (refused.length > 0 && receipt.verification?.state !== "verified") facts.push("refused_check");
	const claimed = receipt.exitCode === 0 ? "done" : "not_done";
	const assessed = claimed === "done" && facts.length > 0 ? "partly_done" : claimed;
	return {
		declared: true,
		claimed,
		assessed,
		state: assessed,
		...(facts.length > 0 ? { facts } : {}),
		limitations,
		unverified,
	};
}

/** The completion caveat from the receipt's own counts, through the one rule every run surface uses. */
function receiptCaveat(receipt: RunResult): CompletedRunCaveat | null {
	// A synthetic receipt can lack the per-tool counts; a missing count says nothing either way.
	const refusedCalls = (receipt.toolStats ?? []).reduce((sum, stat) => sum + (stat.blocked ?? 0), 0);
	const guardedCalls = Math.min(refusedCalls, receipt.safety?.guardBlockedAttempts?.length ?? 0);
	const contract = receipt.quality?.resultContract?.conformance;
	return completedRunCaveat({
		toolCalls: receipt.toolCalls,
		...(refusedCalls > 0 ? { refusedCalls } : {}),
		...(guardedCalls > 0 ? { guardedCalls } : {}),
		...(contract !== undefined ? { contract } : {}),
	});
}

function formatResultLine(
	r: RunResult,
	notVerified: number,
	verifier: { verdict: string; failedChecks: string[] } | null,
	failedCount: number,
): string {
	const reasoningFact = r.spend.usage.reasoning;
	const reasoning =
		reasoningFact.kind === "measured" && reasoningFact.value > 0 ? ` reasoning=${renderFactField(reasoningFact)}` : "";
	const failure = r.failureMessage ? ` error=${r.failureMessage}` : "";
	const verification =
		(verifier !== null ? ` verdict=${verifier.verdict}` : "") +
		(failedCount > 0 ? ` failed_checks=${failedCount}` : "") +
		(notVerified > 0 ? ` verification=unverified not_verified=${notVerified}` : "");
	// An ACP delegation's route names the agent; its session ran the model it selected.
	const requested = r.delegation?.selectedModelId ?? r.wireModelId;
	const served = responseModelIdWords(runResponseModelIdObservationLabel(r), requested);
	const model =
		served === null
			? requested
			: `${requested} (${served.servedAsRequested ? `${served.calls} call${served.calls === 1 ? "" : "s"}` : served.text})`;
	const gatewayRouting = runGatewayRoutingLabel(r);
	return `result: ${r.runId} agent=${r.agentId} exit=${r.exitCode}${verification} target=${r.targetId} model=${model}${gatewayRouting ? ` ${gatewayRouting}` : ""} tokens=${renderFactField(r.spend.totalTokens)}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}
