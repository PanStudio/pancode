// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { type RunCountBuckets, type RunFacts, type RunOutcome, runCountBuckets } from "../../core/run-row.js";
import { isSkillLoadRefusal, type SkillLoadRefusal } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import { formatSize } from "../../core/views/tool-words.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { isGatewayChain } from "../../tools/gateway-display.js";
import type { ResolvedToolRow } from "../../tools/presentation.js";
import { effectiveToolCall } from "../../tools/surface.js";
/** The fact ledger a settled tool row carries: class facts, sizes, offload, skill loads, and the output meta and footer. */
import { cardRows } from "../card.js";
import { holdFact, joinFacts } from "../theme/index.js";
import {
	countSummary,
	detailsOf,
	didNotRun,
	green,
	informational,
	numberField,
	observationOf,
	optionalCompactMs,
	red,
	SEP,
	stringField,
	type ToolExecutionFinished,
	theme,
	toolMeta,
	yellow,
} from "./tool-call-model.js";
import {
	changeStat,
	commandStatusLine,
	formatVerifyTimeoutSeconds,
	resultLineCount,
	stoppedIdle,
} from "./tool-result-text.js";

/**
 * Outcome facts for the collapsed ledger line, derived from the observation
 * envelope (OBSERVE plane), the exec record (git/verify), or the dispatch
 * receipt counts. Returns null when the result carries no recognizable facts.
 */
/**
 * A settled skill load, read from the details `context(scope=skills)` returns.
 * Null for every other context call and for a load that failed.
 */
interface SkillLoadFacts {
	name: string;
	description: string | null;
	activation: string | null;
	/** The tool surface the skill declares: an allow-list, or the tools it removes. */
	allowedTools: string[];
	disallowedTools: string[];
	allowListAdvisory: boolean;
	drifted: boolean;
}

export function skillLoadFacts(finished: ToolExecutionFinished): SkillLoadFacts | null {
	const details = detailsOf(finished.result);
	const call = effectiveToolCall(finished.toolName, finished.args, details);
	// A chain that loaded a skill carries the activation on its aggregate
	// details: a skill-load row, though the chain itself is no context call.
	const activationChain =
		isGatewayChain(finished.toolName, finished.args, details) && details?.capability === ToolNames.Context;
	if ((call.toolName !== ToolNames.Context && !activationChain) || finished.isError || finished.outcome !== undefined)
		return null;
	if (call.args?.scope !== "skills" && !activationChain) return null;
	const name = stringField(details, "name");
	if (name === null) return null;
	const declared = (key: string): string[] =>
		Array.isArray(details?.[key])
			? (details[key] as unknown[]).filter((tool): tool is string => typeof tool === "string")
			: [];
	return {
		name,
		description: stringField(details, "description"),
		activation: stringField(details, "activation"),
		allowedTools: declared("allowedTools"),
		disallowedTools: declared("disallowedTools"),
		allowListAdvisory: details?.allowListAdvisory === true,
		drifted: details?.drift === "mismatch",
	};
}

/** A skill the context tool refused to load, from the structured reason in its error details. */
export function skillRefusalOf(finished: ToolExecutionFinished | null): SkillLoadRefusal | null {
	if (finished === null || !finished.isError) return null;
	const refusal = detailsOf(finished.result)?.refusal;
	return isSkillLoadRefusal(refusal) ? refusal : null;
}

/** The nested row a load states its tool surface on: `narrows tools to read, edit, bash`. */
export function skillSurfaceLine(skill: SkillLoadFacts): string | null {
	if (skill.allowListAdvisory && skill.allowedTools.length > 0)
		return `recommends ${skill.allowedTools.join(", ")}${skill.disallowedTools.length > 0 ? `; blocks ${skill.disallowedTools.join(", ")}` : ""}`;
	if (skill.allowedTools.length > 0) return `narrows tools to ${skill.allowedTools.join(", ")}`;
	if (skill.disallowedTools.length > 0) return `narrows tools to all but ${skill.disallowedTools.join(", ")}`;
	return null;
}

/** Who a skill load answered: the operator's request, a bound recipe, or the model's own choice. */
const SKILL_ACTIVATION_WORDS: Readonly<Record<string, string>> = {
	operator: "by operator",
	recipe: "by recipe",
	model: "by model",
};

/**
 * The facts a settled row states after its object, by class. Every fact comes
 * from the call's structured result or its arguments; none is parsed out of
 * free text except a failed command's exit status, which the main agent's
 * error path delivers as text alone.
 */
function classFacts(finished: ToolExecutionFinished, row: ResolvedToolRow, provenance = true): string[] {
	const skill = skillLoadFacts(finished);
	if (skill !== null) {
		return [
			...(skill.activation !== null && SKILL_ACTIVATION_WORDS[skill.activation] !== undefined
				? [SKILL_ACTIVATION_WORDS[skill.activation] as string]
				: []),
		];
	}
	const details = detailsOf(finished.result);
	const observation = observationOf(finished);
	const parts: string[] = [];
	switch (row.spec.class) {
		case "observe":
		case "search":
		case "knowledge": {
			const range = observation === null ? null : lineRange(finished, observation);
			const count = observation === null ? null : countSummary(observation);
			if (range !== null) parts.push(range);
			else if (count !== null) parts.push(count);
			if (row.spec.class === "observe" && row.spec.statesSize !== false) parts.push(...sizeFacts(finished));
			break;
		}
		case "mutate": {
			const file = details?.file;
			if (isRecord(file) && "before" in file && file.before === null) parts.push("new file");
			break;
		}
		case "execute": {
			// Only a structured exit status is stated: a tool with no exit code
			// (panes, an unknown tool classified by admission) never shows one.
			const exitCode = structuredExitCode(finished);
			if (exitCode !== null) parts.push(`exit ${exitCode}`);
			const lines = finished.isError ? 0 : resultLineCount(finished.result);
			if (lines > 1) parts.push(`${lines} lines`);
			else parts.push(...sizeFacts(finished));
			break;
		}
		case "network": {
			const status = numberField(details, "status");
			if (status !== null) parts.push(String(status));
			const format = stringField(details, "format");
			if (format !== null) parts.push(format);
			const bytesRead = numberField(details, "bytesRead");
			if (bytesRead !== null) parts.push(formatSize(bytesRead));
			else parts.push(...sizeFacts(finished));
			if (details?.truncated === true) parts.push("truncated");
			break;
		}
		case "delegate": {
			// A detached batch runs on after the call returns; its id is provenance, which detailed states.
			if (row.toolName === ToolNames.Dispatch && details?.mode === "detached") {
				parts.push("running in the background");
				const batch = stringField(details, "batchId");
				if (batch !== null && provenance) parts.push(`batch ${batch}`);
				break;
			}
			const runCount = numberField(details, "runCount");
			if (runCount !== null) {
				// A card under the call is the run's row: a single dispatch states no
				// tally, a fan-out counts its runs by state. A dispatch with no card
				// carries the counts too. A recovery after a failed attempt is always
				// stated, since the card shows only the last.
				const recovered = numberField(details, "recoveredCount") ?? 0;
				if (finished.cardAttached === true && runCount <= 1 && recovered === 0) break;
				const pending = details?.complete === false ? (numberField(details, "pendingCount") ?? 0) : 0;
				if (pending > 0) parts.push(`${pending} of ${runCount} still running`);
				else parts.push(...runCountFacts(details, runCount));
				if (recovered > 0) parts.push(`${recovered} recovered after a failed attempt`);
				break;
			}
			const counts = isRecord(details?.counts) ? details.counts : null;
			const completed = numberField(counts, "completed");
			const total = numberField(counts, "total");
			if (completed !== null && total !== null) {
				const blocked = numberField(counts, "blocked") ?? 0;
				parts.push(`${completed}/${total} done${blocked > 0 ? `${SEP}${blocked} blocked` : ""}`);
			}
			break;
		}
		case "interaction":
			if (details?.cancelled === true) parts.push("cancelled");
			// The operator's own choice closed with nobody answering; the call ran, nothing was chosen.
			else if (details?.operatorChoiceUnanswered === true) parts.push("unanswered, nothing chosen");
			break;
		case "external": {
			const count = numberField(details, "count");
			const total = numberField(details, "total");
			if (count !== null) parts.push(total !== null && total !== count ? `${count} of ${total} found` : `${count} found`);
			else parts.push(...sizeFacts(finished));
			break;
		}
	}
	return parts;
}

/** The run-row count buckets in the order every count row states them, worst first. */
const RUN_BUCKET_ORDER: ReadonlyArray<keyof RunCountBuckets> = [
	"failed",
	"waiting",
	"unverified",
	"running",
	"queued",
	"cancelled",
	"ok",
];

const RUN_SUCCESS_STATES: ReadonlySet<string> = new Set(["succeeded", "completed", "done"]);

const RUN_VALIDATION: Readonly<Record<string, NonNullable<RunFacts["validation"]>>> = {
	validated: "passed",
	failed: "failed",
	ungrounded: "self-reported",
	absent: "none",
	not_applicable: "none",
};

/**
 * A run entry of a dispatch or collect result as run-row facts: its outcome from the exit and the stated outcome, its
 * validation and record integrity from the trust axes, so a successful exit with an adverse verdict counts adverse.
 */
function runFactsOf(run: unknown): RunFacts {
	const entry = isRecord(run) ? run : {};
	const said = stringField(entry, "outcome") ?? stringField(entry, "state");
	const exitCode = entry.exitCode;
	const outcome: RunOutcome =
		said === "cancelled" || said === "canceled"
			? "cancelled"
			: said === "blocked" || said === "guarded" || said === "running" || said === "queued"
				? said
				: (said !== null && !RUN_SUCCESS_STATES.has(said)) || (typeof exitCode === "number" && exitCode !== 0)
					? "failed"
					: "succeeded";
	const axes = isRecord(entry.trust) && isRecord(entry.trust.axes) ? entry.trust.axes : null;
	const status = isRecord(entry.trustStatus) ? entry.trustStatus : null;
	const axis = (name: string): string | null => {
		const nested = status?.[name];
		return stringField(axes, name) ?? (isRecord(nested) ? stringField(nested, "state") : null);
	};
	const seal = axis("artifactIntegrity");
	return {
		agent: stringField(entry, "agentId") ?? "run",
		origin: "model",
		outcome,
		integrity: seal === "verified" ? "verified" : seal === "failed" ? "compromised" : "unverified",
		// A review's failing verdict is what it found, not a failed validation of the run that gave it.
		validation:
			typeof entry.reviewFindings === "number" ? "none" : (RUN_VALIDATION[axis("validationGrounding") ?? ""] ?? "unknown"),
	};
}

/**
 * A dispatch's runs counted by state, worst first (`1 failed · 1 unverified · 1 ok`). A result that lists no runs
 * counts its exits alone.
 */
function runCountFacts(details: Record<string, unknown> | null, runCount: number): string[] {
	const runs = Array.isArray(details?.runs) ? details.runs.slice(0, runCount) : [];
	if (runs.length === 0) {
		const failed = numberField(details, "failedCount") ?? 0;
		return [...(failed > 0 ? [`${failed} failed`] : []), ...(runCount > failed ? [`${runCount - failed} ok`] : [])];
	}
	const buckets = runCountBuckets(runs.map(runFactsOf));
	return RUN_BUCKET_ORDER.filter((key) => buckets[key] > 0).map((key) => `${buckets[key]} ${key}`);
}

/** A read states the range it returned, which is truer than the window it asked for. */
export function lineRange(finished: ToolExecutionFinished, observation: Record<string, unknown>): string | null {
	if (stringField(observation, "unit") !== "lines") return null;
	const shown = numberField(observation, "shownCount");
	const total = numberField(observation, "totalCount");
	if (shown === null || total === null) return null;
	const offsetRaw = isRecord(finished.args) ? finished.args.offset : undefined;
	const start = typeof offsetRaw === "number" && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
	return shown > 0 ? `lines ${start}-${start + shown - 1} of ${total}` : `0 of ${total} lines`;
}

/** `1.4KB`, or `1.4KB of 4.3KB` when the result kept only part of what it read. */
/**
 * How a command the run ended under stopped, in the operator's words. The tool's own line is written for the model
 * (`aborted after 8s of its 5m time limit. The host ended the run: Cancelled at your request.`); the row already shows
 * the stop mark and the time, so it says who stopped it, and that it had to be killed when it ignored the stop.
 */
function abortedFact(cause: string | null, details: Record<string, unknown> | null): string {
	const killed = details?.signal === "SIGKILL";
	const byOperator = cause !== null && /^cancel+ed at your request\.?$/iu.test(cause.trim());
	if (byOperator) return killed ? "killed, it ignored your stop" : "stopped by you";
	const why = cause === null ? null : cause.trim().replace(/\.$/u, "");
	const reason = why === null || why.length === 0 ? "stopped when the run ended" : `stopped: ${why}`;
	return killed ? `${reason}, killed after it ignored the stop` : reason;
}

function sizeFacts(finished: ToolExecutionFinished): string[] {
	// An aborted or silent command's result text is the status the model reads; its size is the command's own output.
	const details = detailsOf(finished.result);
	if ((details?.aborted === true || details?.outputBytes === 0) && typeof details.outputBytes === "number") {
		return details.outputBytes > 0 ? [formatSize(details.outputBytes)] : [];
	}
	const bytes = shownBytesOf(finished);
	if (bytes === null || bytes <= 0) return [];
	const total = totalBytesOf(finished);
	return [total !== null && total > bytes ? `${formatSize(bytes)} of ${formatSize(total)}` : formatSize(bytes)];
}

export function offloadPathOf(finished: ToolExecutionFinished): string | null {
	const observation = observationOf(finished);
	const fromObservation = stringField(observation, "offloadPath");
	if (fromObservation !== null) return fromObservation;
	const summary = finished.resultSummary ?? null;
	const fromSummary = stringField(summary, "offloadPath");
	if (fromSummary !== null) return fromSummary;
	const resultSize = detailsOf(finished.result)?.resultSize;
	return isRecord(resultSize) ? stringField(resultSize, "offloadPath") : null;
}

function offloadFileMissing(finished: ToolExecutionFinished): boolean {
	return finished.resultSummary?.offloadFileMissing === true;
}

function shownBytesOf(finished: ToolExecutionFinished): number | null {
	const observation = observationOf(finished);
	const fromObservation = numberField(observation, "shownBytes");
	if (fromObservation !== null) return fromObservation;
	const resultSize = detailsOf(finished.result)?.resultSize;
	const fromResultSize = isRecord(resultSize) ? numberField(resultSize, "shownBytes") : null;
	if (fromResultSize !== null) return fromResultSize;
	return numberField(finished.resultSummary ?? null, "bytes");
}

function totalBytesOf(finished: ToolExecutionFinished): number | null {
	const observation = observationOf(finished);
	const fromObservation = numberField(observation, "totalBytes");
	if (fromObservation !== null) return fromObservation;
	const resultSize = detailsOf(finished.result)?.resultSize;
	if (isRecord(resultSize)) {
		const total = numberField(resultSize, "bytes");
		if (total !== null) return total;
	}
	return shownBytesOf(finished);
}

function resultSizeOf(finished: ToolExecutionFinished): Record<string, unknown> | null {
	const value = detailsOf(finished.result)?.resultSize;
	return isRecord(value) ? value : null;
}

export function isTruncatedResult(finished: ToolExecutionFinished): boolean {
	const observation = observationOf(finished);
	if (observation?.truncated === true) return true;
	if (resultSizeOf(finished)?.truncated === true) return true;
	const truncation = detailsOf(finished.result)?.truncation;
	if (isRecord(truncation) && truncation.truncated === true) return true;
	return finished.resultSummary?.truncated === true;
}

function structuredExitCode(finished: ToolExecutionFinished): string | null {
	if (didNotRun(finished)) return null;
	if (finished.exitCode !== undefined && finished.exitCode !== null) return String(finished.exitCode);
	const exitCode = detailsOf(finished.result)?.exitCode;
	if (typeof exitCode === "number" || typeof exitCode === "string") return String(exitCode);
	return finished.isError ? (commandStatusLine(finished.result)?.exit ?? null) : null;
}

/**
 * The toolMeta facts after a settled row's object: the class facts, then the
 * flags every class shares, and the offload path for a truncated call. The
 * change stat rides first in its own colors. One line of plain text carries
 * the call and its outcome when copied.
 */
export function ledgerTail(
	finished: ToolExecutionFinished,
	row: ResolvedToolRow,
	provenance = true,
): { facts: string; offload: string } {
	const executed = !didNotRun(finished);
	const parts = executed ? classFacts(finished, row, provenance) : [];
	if (executed) {
		if (isTruncatedResult(finished) && !parts.includes("truncated")) parts.push("truncated");
		const details = detailsOf(finished.result);
		const status = row.spec.class === "execute" && finished.isError ? commandStatusLine(finished.result) : null;
		if (stoppedIdle(details, status)) {
			// An idle stop is not the timeout budget running out; its figure is how long the command sat idle (FX-40).
			const idle = typeof details?.idleMs === "number" && details.idleMs > 0 ? optionalCompactMs(details.idleMs) : null;
			parts.push(idle === null ? "stopped idle" : `stopped idle after ${idle}`);
		} else if (details?.timedOut === true || status?.timedOut === true) {
			// The row does not state a timeout the command stayed under; one it hit is the fact.
			let limit: string | null;
			if (row.toolName === "verify") {
				if (status?.timeoutSeconds !== null && status?.timeoutSeconds !== undefined) {
					limit = status.timeoutSeconds;
				} else {
					const ms =
						typeof details?.timeoutMs === "number" && details.timeoutMs > 0
							? details.timeoutMs
							: typeof details?.declaredTimeoutMs === "number" && details.declaredTimeoutMs > 0
								? details.declaredTimeoutMs
								: typeof row.args.timeout_ms === "number" && row.args.timeout_ms > 0
									? row.args.timeout_ms
									: null;
					limit = ms === null ? null : formatVerifyTimeoutSeconds(ms);
				}
			} else {
				limit = typeof row.args.timeout_ms === "number" ? optionalCompactMs(row.args.timeout_ms) : null;
			}
			parts.push(limit === null ? "timed out" : `timed out after ${limit}`);
		}
		if (status?.aborted === true) parts.push(abortedFact(status.cause, details));
		if (details?.outputCapped === true) parts.push("output capped");
	}
	if (finished.excludeFromContext === true) parts.push("not sent to model");
	if (finished.evictedReason !== undefined) parts.push("evicted", finished.evictedReason);
	const stat = executed && !finished.isError ? changeStat(finished.result) : null;
	// Every fact is held together, so a narrow row wraps between facts
	// (`… · exit 0 ·` then `18 lines`), never inside one.
	const statText =
		stat === null ? "" : `${toolMeta(SEP)}${green(`+${stat.added}`)}${holdFact(" ")}${red(`-${stat.removed}`)}`;
	// A skill whose content no longer matches its recorded hash is the one
	// skill fact that is a warning rather than provenance.
	const driftText = skillLoadFacts(finished)?.drifted === true ? `${toolMeta(SEP)}${yellow("drifted")}` : "";
	// A request the browser session's host grant refused is a warning the folded row states with the grant that admits it.
	const blockedDetails = executed && row.toolName === ToolNames.Browser ? (detailsOf(finished.result) ?? null) : null;
	const blockedGrant = stringField(blockedDetails, "blockedGrant");
	const blockedHosts = Array.isArray(blockedDetails?.blockedHosts) ? blockedDetails.blockedHosts.join(", ") : "";
	const blockedText =
		blockedGrant === null
			? ""
			: `${toolMeta(SEP)}${yellow(sanitizeCallTargetText(`blocked ${blockedHosts}; to admit: ${blockedGrant}`))}`;
	// An offloaded result says where the rest is, not what its path is: the
	// path is a 64-hex name that wrapped a row across three, and /view and the
	// full body's footer state it.
	const offloadPath = executed ? offloadPathOf(finished) : null;
	return {
		facts: `${statText}${parts.length > 0 ? toolMeta(joinFacts(["", ...parts.map((part) => sanitizeCallTargetText(part))])) : ""}${driftText}${blockedText}`,
		offload:
			offloadPath === null
				? ""
				: offloadFileMissing(finished)
					? toolMeta(`${SEP}full output gone after the 14-day retention sweep`)
					: toolMeta(`${SEP}full output${SEP}/view`),
	};
}

function toolUsageFact(result: unknown): string | null {
	if (!isRecord(result) || !isRecord(result.usage)) return null;
	const total = numberField(result.usage, "totalTokens");
	if (total === null || total <= 0) return null;
	return `${total} tool token${total === 1 ? "" : "s"}`;
}

function outputFacts(finished: ToolExecutionFinished): string[] {
	const parts: string[] = [];
	if (didNotRun(finished)) {
		if (finished.excludeFromContext === true) parts.push("not sent to model");
		return parts;
	}
	const exitCode = structuredExitCode(finished) ?? (finished.toolName === "bash" && !finished.isError ? "0" : null);
	if (exitCode !== null) parts.push(`exit ${exitCode}`);
	const observation = observationOf(finished);
	const count = observation === null ? null : countSummary(observation);
	if (count !== null) parts.push(count);
	const lines = resultLineCount(finished.result);
	if (count === null && lines > 0) parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
	const shownBytes = shownBytesOf(finished);
	const totalBytes = totalBytesOf(finished);
	if (shownBytes !== null && shownBytes > 0) {
		parts.push(
			totalBytes !== null && totalBytes > shownBytes
				? `${formatSize(shownBytes)} shown / ${formatSize(totalBytes)} total`
				: formatSize(shownBytes),
		);
	}
	if (isTruncatedResult(finished)) parts.push("truncated");
	const details = detailsOf(finished.result);
	if (stoppedIdle(details, null)) parts.push("stopped idle");
	else if (details?.timedOut === true) parts.push("timed out");
	if (details?.outputCapped === true) parts.push("output capped");
	const usage = toolUsageFact(finished.result);
	if (usage !== null) parts.push(usage);
	if (isRecord(finished.result) && Array.isArray(finished.result.addedToolNames)) {
		const added = finished.result.addedToolNames.filter((name): name is string => typeof name === "string");
		if (added.length > 0) parts.push(`added ${added.join(", ")}`);
	}
	if (isRecord(finished.result) && finished.result.terminate === true) parts.push("terminal result");
	if (finished.excludeFromContext === true) parts.push("not sent to model");
	if (finished.evictedReason !== undefined) parts.push("evicted", finished.evictedReason);
	return parts;
}

export function renderOutputMeta(
	finished: ToolExecutionFinished,
	width: number,
	isError: boolean,
	label = "output",
): string[] {
	const facts = outputFacts(finished);
	const suffix = facts.length > 0 ? toolMeta(`${SEP}${facts.join(SEP)}`) : "";
	return cardRows(`${theme.fg("toolSummary", label)}${suffix}`, width, isError);
}

export function renderOutputFooter(finished: ToolExecutionFinished, width: number, isError: boolean): string[] {
	const out: string[] = [];
	const offloadPath = didNotRun(finished) ? null : offloadPathOf(finished);
	if (offloadPath !== null) {
		const pointer = offloadFileMissing(finished) ? "gone after the 14-day retention sweep" : offloadPath;
		out.push(...cardRows(`${informational("full output")}  ${pointer}`, width, isError));
	}
	const hint =
		stringField(resultSizeOf(finished), "followUpHint") ?? stringField(finished.resultSummary ?? null, "followUpHint");
	if (hint !== null) out.push(...cardRows(`${toolMeta("next")}  ${hint}`, width, isError));
	return out;
}
