// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Structured renderer for tool-execution chat segments (Slice A of the
 * pi-coding-agent parity work). pi-coding-agent renders every tool call as
 * a header line plus an optional args body and a result/error block. PanCode
 * previously emitted a single inline string per call, which collapsed
 * structure (multi-line outputs vanished) and prevented the live and replay
 * paths from sharing one renderer.
 *
 * Pure functions: no I/O, no console writes, no module-level mutable state.
 * The chat-panel tool segment renderer (live path) and the chat-renderer
 * orphan tool-result fallback (replay path) both consume this module so the
 * two surfaces stay byte-identical.
 */

import { UNICODE_GLYPH } from "../../core/glyphs.js";
import { tierPolicy } from "../../core/presentation-tier.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import { withoutModelRejectionAdvice } from "../../domains/safety/rejection-feedback.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import {
	holdUnresolvedUserinfo,
	redactSecretString,
	redactStreamingSecretString,
	redactToolArgs,
} from "../../lib/secrets/redaction.js";
import { classifyResourceRead, workspaceRelative } from "../../tools/presentation.js";
import { cardHead, cardRows } from "../card.js";
import { collapseHomePath, formatElapsed, formatWaitClock, GLYPH } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import { toolOutputInk } from "./code-ink.js";
import { LiveToolView } from "./live-tool-view.js";
import { previewBudget, previewLines, previewRows, tidyPreviewText } from "./preview.js";
import { jsonFactRows } from "./structured.js";
import { approvalReceiptRows } from "./tool-approval-cards.js";
import { argumentFactRows, previewArguments, renderToolArguments } from "./tool-arguments.js";
import {
	BODY_INDENT_VISIBLE_WIDTH,
	CONTENT_INDENT,
	CONTENT_INDENT_WIDTH,
	isChainCall,
	presentedCall,
	RAIL_ERROR,
	RAIL_NORMAL,
	SEP,
	type ToolBodyRenderOptions,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	theme,
	toolMeta,
} from "./tool-call-model.js";
import { renderChainExecution, renderChainPreview } from "./tool-chain.js";
import {
	renderOutputFooter,
	renderOutputMeta,
	skillLoadFacts,
	skillRefusalOf,
	skillSurfaceLine,
} from "./tool-facts.js";
import { renderToolResultImages } from "./tool-images.js";
import {
	liveCommandOutput,
	livePayloadFact,
	livePayloadOf,
	livePayloadRows,
	withoutLivePayload,
} from "./tool-live-payload.js";
import {
	asBashArgs,
	diffLines,
	exitMeansKilled,
	fromFirstChange,
	renderBashResultBlock,
	renderMutationDiffBlock,
	renderResultBlock,
	resultDiff,
	resultText,
	splitModelNotes,
	unwrapResultEnvelope,
	withoutCommandStatus,
} from "./tool-result-text.js";
import {
	blockReasonClause,
	DENIED_AT_PROMPT,
	headerLine,
	inlinePair,
	previewActionRows,
	renderToolSubline,
	resolvedPairs,
	resolveRow,
	type StatusMeta,
	settledStatus,
	UNATTENDED_REFUSAL,
} from "./tool-subline.js";

// The argument projection lives in the safety domain so the worker tool seam
// scrubs by the same rules; re-exported here because this renderer is where
// callers and tests have always reached for it.
export { classifyResourceRead, redactToolArgs };

/**
 * A test runner's pass or fail tally line: node's `ℹ pass 7` / `# fail 0`, jest's and vitest's `Tests: 1 failed, 6
 * passed`, mocha's `7 passing`, pytest's `=== 2 failed, 5 passed in 0.1s ===`.
 */
const TEST_TALLY_LINE =
	/^[^A-Za-z0-9]*(?:(?:pass|fail)\s+\d+\s*$|tests?:?\s+\d+\s+(?:passed|failed)\b|\d+\s+(?:passing|failing)\b)|^=+\s*\d+\s+(?:passed|failed)\b/iu;

/**
 * A call the output limit cut off settles with the engine's refusal as an error result, but it never ran, so its
 * body reads as that note rather than as a failure's output. Its status still comes from `notRunCause`.
 */
function asNotFailed<T extends ToolExecutionFinished>(finished: T): T {
	return finished.notRunCause === undefined || !finished.isError ? finished : { ...finished, isError: false };
}

/**
 * Full render: header + args body (if non-empty) + result block. Used by
 * the live chat panel on `tool_execution_end` and by the replay path when a
 * tool result can be paired with its prior call's args. Header carries a
 * green check on success and a red cross on error so the user can scan tool
 * outcomes without reading the body.
 */
export function renderToolExecution(
	wire: ToolExecutionFinished,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const finished = presentedCall(asNotFailed(wire));
	if (isChainCall(finished)) return renderChainExecution(finished, width, opts);
	const status = settledStatus(finished);
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const row = resolveRow(finished);
	const out: string[] = [];
	out.push(...cardHead(headerLine(finished, status, statusMeta, width), "", width));
	out.push(...approvalReceiptRows(finished, width, finished.isError));

	// A mutation produces one bounded numbered diff on result.details. It is the
	// authority because canonical edit args can contain multiple replacements
	// and fuzzy matching can change the actual base text. Live rows receive
	// Pi's word-level styling; replay and export request plain rows.
	if (row.spec.class === "mutate" && finished.isError === false) {
		const diff = resultDiff(finished.result);
		if (diff !== null) {
			out.push(...renderToolArguments(finished.args, width, false));
			out.push(...renderOutputMeta(finished, width, false, "change"));
			out.push(...renderMutationDiffBlock(diff, width, opts.diffStyle !== "plain"));
			out.push(...renderOutputFooter(finished, width, false));
			return out;
		}
	}

	// A command echoes as `$ <cmd>` above its output, so the display command
	// reads whole even where the row had to shorten it.
	if (row.spec.class === "execute") {
		const bashArgs = asBashArgs(redactToolArgs(finished.args));
		if (bashArgs !== null) {
			out.push(...renderToolArguments(finished.args, width, finished.isError, Number.POSITIVE_INFINITY, false, "shell"));
			out.push(
				...renderOutputMeta(finished, width, finished.isError, finished.outcome === "blocked" ? "decision" : "output"),
			);
			out.push(...renderBashResultBlock(bashArgs, finished.result, width, finished.isError, opts));
			out.push(...renderOutputFooter(finished, width, finished.isError));
			return out;
		}
	}

	// The heading is a preview; inspection retains every redacted argument.
	out.push(...renderToolArguments(finished.args, width, finished.isError));
	out.push(
		...renderOutputMeta(finished, width, finished.isError, finished.outcome === "blocked" ? "decision" : "output"),
	);
	out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
	out.push(...renderToolResultImages(finished.result, width, opts));
	out.push(...renderOutputFooter(finished, width, finished.isError));
	return out;
}

/**
 * Result-only render for replayed tool results that arrived without a
 * matching prior tool-call entry (orphan results in the session log).
 * Identical to `renderToolExecution` minus the args body.
 */
export function renderToolResultOnly(
	wire: Omit<ToolExecutionFinished, "args">,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	if (!opts.unbounded && opts.detail) return renderToolPreview(wire, width, opts.detail, opts);
	const finished = presentedCall(asNotFailed({ ...wire, args: undefined }));
	if (isChainCall(finished)) return renderChainExecution(finished, width, opts);
	const status = settledStatus(finished);
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const out: string[] = [];
	out.push(...cardHead(headerLine({ ...finished, args: undefined }, status, statusMeta, width), "", width));
	out.push(...approvalReceiptRows(finished, width, finished.isError));
	out.push(...renderOutputMeta(finished, width, finished.isError));
	out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
	out.push(...renderToolResultImages(finished.result, width, opts));
	out.push(...renderOutputFooter(finished, width, finished.isError));
	return out;
}

/** Display-only lifecycle for operator-issued `!` and `!!` bash commands. */
export interface BashTranscriptExecution {
	command: string;
	output: string;
	running: boolean;
	elapsedMs?: number | undefined;
	totalBytes?: number | undefined;
	exitCode?: number | null | undefined;
	cancelled?: boolean | undefined;
	/** False when the source's trailing whitespace finished the last line, for a caller that trims the output (#446). */
	outputEndsOpen?: boolean | undefined;
	truncated?: boolean | undefined;
	fullOutputPath?: string | undefined;
	excludeFromContext?: boolean | undefined;
	error?: string | undefined;
	/** Since the operator asked it to stop: live while it runs on, then how long it took to exit (HS18). */
	stopWaitMs?: number | undefined;
}

/**
 * The row a running command's card carries once a stop went out: that it went out, how long ago, and that the process
 * has not exited yet. The model's own command card read `running` beside a rail reading `stopping` (HS18).
 */
export function stopSentRow(waitMs: number, width: number): string {
	const age = waitMs >= 1000 ? ` ${formatWaitClock(waitMs)} ago` : "";
	const words = [`stop sent${age}, waiting for the command to exit`, `stop sent${age}, waiting to exit`, "stopping"];
	const room = Math.max(1, width - CONTENT_INDENT_WIDTH - 2);
	const fitted = words.find((text) => visibleWidth(text) <= room) ?? truncateToWidth("stopping", room, "", false);
	return `${CONTENT_INDENT}${theme.fg("warning", GLYPH.cancelled)} ${toolMeta(fitted)}`;
}

/**
 * The row a stop request owes the card: while the process runs on, that the stop went out and how long ago; once it
 * exits, how long the stop took when that was long enough to notice. A card reading `you are running` beside a rail
 * reading `stopping` left the operator to guess which was true.
 */
function bashStopRow(execution: BashTranscriptExecution, width: number, killed = false): string | null {
	const wait = execution.stopWaitMs;
	const room = Math.max(1, width - CONTENT_INDENT_WIDTH - 2);
	const settledRow = (candidates: ReadonlyArray<string>): string | null => {
		const words = candidates.find((text) => visibleWidth(text) <= room);
		return words === undefined
			? null
			: `${CONTENT_INDENT}${theme.fg("toolMetadata", GLYPH.cancelled)} ${toolMeta(words)}`;
	};
	// A process that ignored the stop and had to be killed is the one fact the card owes beyond `stopped`.
	if (wait === undefined) {
		return !execution.running && killed ? settledRow(["killed after it ignored the stop", "killed"]) : null;
	}
	if (execution.running) return stopSentRow(wait, width);
	const took = formatElapsed(Math.floor(wait / 100) * 100);
	if (killed) {
		return settledRow([
			`killed ${took} after you asked, because it ignored the stop`,
			`killed ${took} after you asked`,
			`killed after ${took}`,
			"killed",
		]);
	}
	if (wait < 1000) return null;
	return settledRow([`stopped ${took} after you asked`, `stopped after ${took}`, took]);
}

/** The note the shell runner appends after a non-zero exit, which the card's `exit N` fact already states. */
const EXIT_NOTE = /^\[command exited with code -?\d+\]$/mu;

/** The notes the shell runner appends to a stopped command's output, which the card states in its own words instead. */
const STOP_NOTES = /^\[command (?:aborted|terminated by (?<signal>[A-Z0-9]+))\]$/gmu;

/**
 * A stopped command's output without the runner's notes, and whether the process had to be killed. The card said
 * `aborted` three times over (`✗ aborted`, `[command aborted]`, `[command terminated by SIGKILL]`) and counted the notes as
 * `49B` of output (N6). The session entry keeps the notes, which is what the model reads.
 */
function withoutStopNotes(output: string): { output: string; killed: boolean } {
	let killed = false;
	const cleaned = output.replace(STOP_NOTES, (_line, signal: string | undefined) => {
		if (signal === "SIGKILL") killed = true;
		return "";
	});
	return { output: cleaned.replace(/\s+$/u, ""), killed };
}

/**
 * Render local bash with the same call, argument, output, and settlement grammar
 * as model-initiated bash. This is a view projection only; callers keep PanCode's
 * existing immutable `bashExecution` ledger entry.
 */
export function renderBashTranscriptExecution(
	execution: BashTranscriptExecution,
	width: number,
	_expandKey?: string,
	bodyOptions: ToolBodyRenderOptions = {},
): string[] {
	const stopped = execution.cancelled === true ? withoutStopNotes(execution.output) : null;
	if (stopped !== null) execution = { ...execution, output: stopped.output };
	// The header already says `exit 1`; the runner's `[command exited with code 1]` repeated it as the body and its size.
	const exitNote = !execution.running && EXIT_NOTE.test(execution.output);
	if (exitNote) execution = { ...execution, output: execution.output.replace(EXIT_NOTE, "").replace(/\s+$/u, "") };
	const shownBytes = Buffer.byteLength(execution.output, "utf8");
	const totalBytes = stopped !== null || exitNote ? shownBytes : (execution.totalBytes ?? shownBytes);
	const args: Record<string, unknown> = { command: execution.command };
	const details = {
		resultSize: {
			bytes: totalBytes,
			shownBytes,
			truncated: execution.truncated === true,
			policy: "tail",
			...(execution.fullOutputPath !== undefined ? { offloadPath: execution.fullOutputPath } : {}),
		},
		...(stopped !== null ? { outcome: "canceled" } : {}),
	};
	const result = {
		content: [{ type: "text", text: execution.output }],
		details,
	};
	const stopRow = bashStopRow(execution, width, stopped?.killed === true);
	const withStop = (rows: string[]): string[] => (stopRow === null ? rows : [...rows, stopRow]);
	if (execution.running) {
		return withStop(
			renderToolPreview(
				{
					toolCallId: "local-bash",
					toolName: "bash",
					args,
					phase: "running",
					elapsedMs: execution.elapsedMs,
					excludeFromContext: execution.excludeFromContext,
					actor: "operator",
					...(execution.stopWaitMs !== undefined ? { stopping: true } : {}),
				},
				width,
				bodyOptions.detail ?? transcriptDetail(),
				{ ...bodyOptions, operator: true, partialResult: result },
			),
		);
	}
	const message = execution.error?.trim();
	// Only a process that exited on its own ended its output on purpose. A trailing newline still finishes a line (#446).
	const exited =
		execution.cancelled !== true &&
		execution.error === undefined &&
		typeof execution.exitCode === "number" &&
		!exitMeansKilled(execution.exitCode);
	const shownOutput =
		exited || execution.outputEndsOpen === false ? execution.output : holdUnresolvedUserinfo(execution.output);
	const output = message ? `${shownOutput}${shownOutput.length > 0 ? "\n\n" : ""}${message}` : shownOutput;
	const finished: ToolExecutionFinished = {
		toolCallId: "local-bash",
		toolName: "bash",
		args,
		result: { ...result, content: [{ type: "text", text: output }] },
		// A stop the operator asked for is a cancel, not a failure: the card wears ⊘ like every other cancelled call.
		isError: execution.cancelled === true || execution.error !== undefined || (execution.exitCode ?? 0) !== 0,
		exitCode: execution.exitCode,
		excludeFromContext: execution.excludeFromContext,
		actor: "operator",
		resultSummary: {
			bytes: shownBytes,
			truncated: execution.truncated === true,
			...(execution.fullOutputPath !== undefined ? { offloadPath: execution.fullOutputPath } : {}),
		},
	};
	return withStop(
		bodyOptions.unbounded
			? renderToolExecution(finished, width, bodyOptions)
			: renderToolPreview(finished, width, bodyOptions.detail ?? transcriptDetail(), { ...bodyOptions, operator: true }),
	);
}

/** `text` without its first non-blank line when that line is `line`. */
function withoutLeadingLine(text: string, line: string): string {
	const lines = text.split("\n");
	const first = lines.findIndex((entry) => entry.trim().length > 0);
	return first >= 0 && lines[first]?.trim() === line ? lines.slice(first + 1).join("\n") : text;
}

/** An absolute POSIX path inside prose: it ends at whitespace, a quote or closing punctuation. */
const EMBEDDED_ABSOLUTE_PATH = /(?<![\w./~-])\/[^\s'"`<>|:;,()[\]{}]+/gu;

/**
 * Display only. A tool's own failure text names the absolute path it resolved
 * (`read: ENOENT: no such file or directory, stat '/home/me/proj/test'`) while
 * every other row abbreviates: a path in the workspace reads relative to it,
 * one under the home directory reads `~/…`, and any other stays as written.
 * The result the model and the audit hold keeps the canonical path.
 */
function displayEmbeddedPaths(text: string, cwd: string): string {
	return text.replace(EMBEDDED_ABSOLUTE_PATH, (match) => {
		const stem = match.replace(/\.+$/u, "");
		const relative = workspaceRelative(stem, cwd);
		const shown = relative !== null && relative.length > 0 ? relative : collapseHomePath(stem);
		return `${shown}${match.slice(stem.length)}`;
	});
}

/** Invocation intent stays visible in every style; /view retains the complete arguments and output. */
export function renderToolPreview(
	wire: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	detail: TranscriptDetailPolicy,
	options: ToolBodyRenderOptions & {
		terminalRows?: number;
		partialResult?: unknown;
		operator?: boolean;
		/** The segment's live state; without one the rows are the same, only dearer per frame. */
		live?: LiveToolView;
		/** An edit's diff, computed from the file once its arguments closed and before its result. */
		previewDiff?: string;
	} = {},
): string[] {
	const presented = presentedCall(wire);
	if (isChainCall(presented)) return renderChainPreview(presented, width, detail, options);
	const payload = livePayloadOf(presented);
	const view = options.live ?? new LiveToolView();
	const liveFact = payload === null ? undefined : livePayloadFact(payload, view);
	const call = payload === null ? presented : withoutLivePayload(presented);
	const finished = "result" in call ? call : undefined;
	const failure = (finished?.isError === true && finished.notRunCause === undefined) || finished?.outcome !== undefined;
	const row = resolveRow(call);
	const command = row.spec.class === "execute";
	const policy = tierPolicy(detail.style);
	// A batch collect folds into the dispatch header above it and the worker rows under that; its own row and the
	// batch id it names are provenance, which only a tier with run telemetry shows. A collect that failed or ran out
	// its wait keeps its row, since a state is never tier-gated.
	if (
		row.toolName === ToolNames.Monitor &&
		row.args.mode === "collect" &&
		policy.runSubRows === 0 &&
		(finished === undefined || settledStatus(finished) === "ok")
	)
		return [];
	const limit = previewBudget(
		failure
			? detail.errorRows
			: finished === undefined && !options.operator
				? detail.liveResultRows
				: options.operator
					? detail.operatorBashRows
					: command
						? detail.bashRows
						: detail.resultRows,
		options.terminalRows,
	);
	const rows = options.operator
		? renderToolSubline(call, width, policy)
		: previewActionRows(call, width, liveFact, policy);
	if (
		!detail.evidence &&
		!options.operator &&
		(finished === undefined || (!failure && row.spec.class !== "interaction" && finished.operatorGrant === undefined))
	)
		return [...rows, ...approvalReceiptRows(call, width, failure)];
	rows.push(...approvalReceiptRows(call, width, failure));
	if (policy.toolArgRow) rows.push(...argumentFactRows(row, finished ?? null, width, failure));
	const args = previewArguments(call, width, detail.provenance && finished === undefined, policy.toolArgRow);
	const expanded = isRecord(args.edits) ? { ...args, ...args.edits, edits: undefined } : args;
	rows.push(
		...renderToolArguments(
			Object.fromEntries(Object.entries(expanded).filter(([, value]) => value !== undefined)),
			width,
			failure,
			previewBudget(detail.invocationRows, options.terminalRows),
			true,
			command ? "shell" : undefined,
		),
	);
	if (payload !== null) {
		if (payload.tool === "edit" && options.previewDiff !== undefined && detail.diffRows > 0) {
			rows.push(
				...previewLines(
					diffLines(renderMutationDiffBlock(redactSecretString(options.previewDiff), width, true)),
					previewBudget(detail.diffRows, options.terminalRows),
					width,
					false,
					RAIL_NORMAL(),
					BODY_INDENT_VISIBLE_WIDTH,
				),
			);
		} else {
			rows.push(...livePayloadRows(payload, view, limit, width));
		}
		return rows;
	}
	if (finished === undefined && command && options.partialResult !== undefined && limit > 0) {
		const output = liveCommandOutput(options.partialResult);
		if (output !== null) {
			rows.push(
				...view.outputRows(output.text, limit, width, {
					rail: RAIL_NORMAL(),
					railWidth: BODY_INDENT_VISIBLE_WIDTH,
					...(output.truncatedTotal !== undefined ? { truncatedTotal: output.truncatedTotal } : {}),
				}),
			);
		}
		return rows;
	}
	// A refused skill load states its reason on the row; its message is the
	// model's instruction and stays in /view.
	if (finished !== undefined && skillRefusalOf(finished) !== null) return rows;
	// A call PanCode denied because nobody answered states that on its row and in the notice under it; the body is the
	// model's instruction (`name it as an open decision in your final reply`), which stays in /view.
	if (finished?.outcome === "blocked" && UNATTENDED_REFUSAL.test(finished.blockReason ?? "")) return rows;
	const skill = finished ? skillLoadFacts(finished) : null;
	// The tool surface a loaded skill declares and the one line that says what
	// it is for; Compact keeps the row alone.
	if (skill !== null && detail.evidence) {
		const surface = skillSurfaceLine(skill);
		for (const line of [surface, skill.description]) {
			if (line === null || line.length === 0) continue;
			rows.push(
				`${RAIL_NORMAL()}${theme.fg("body", truncateToWidth(sanitizeCallTargetText(line), Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH), GLYPH.ellipsis))}`,
			);
		}
	}
	// Pairs the row could not carry inline: each question and its answer, or
	// each decision, on its own row.
	const pairs = resolvedPairs(row, finished ?? null);
	if (pairs.length > 0 && inlinePair(row, pairs) === null) {
		const pairRows: string[] = [];
		for (const { question, answer } of pairs) {
			pairRows.push(
				...cardRows(
					`${toolMeta(sanitizeCallTargetText(question))} ${toolMeta(GLYPH.right)} ${theme.fg("body", sanitizeCallTargetText(answer))}`,
					width,
					false,
				),
			);
		}
		rows.push(
			...previewRows(
				pairRows,
				previewBudget(detail.invocationRows, options.terminalRows),
				width,
				false,
				RAIL_NORMAL(),
				BODY_INDENT_VISIBLE_WIDTH,
			),
		);
	}
	const result = finished?.result ?? options.partialResult;
	const diff = finished && !failure ? resultDiff(result) : null;
	if (diff !== null && detail.diffRows > 0) {
		const diffRows = renderMutationDiffBlock(redactSecretString(diff), width, options.diffStyle !== "plain");
		const budget = previewBudget(detail.diffRows, options.terminalRows);
		rows.push(
			...previewLines(
				diffLines(diffRows.length > budget ? fromFirstChange(diffRows) : diffRows),
				budget,
				width,
				false,
				RAIL_NORMAL(),
				BODY_INDENT_VISIBLE_WIDTH,
			),
		);
	} else if (
		limit > 0 &&
		result !== undefined &&
		!(row.spec.class === "interaction" && !failure) &&
		row.context.cardAttached !== true
	) {
		// A settled question to the operator states what was asked and answered;
		// its output is the model's copy of the same interview. A call whose
		// worker card sits under it leaves the outcome to the card.
		// A failed command's status line is on its row as `exit N`; the body keeps the output.
		const shown = failure && command ? withoutCommandStatus(result) : result;
		const metadataOnly =
			!failure &&
			detail.evidence &&
			!detail.provenance &&
			isRecord(shown) &&
			Object.keys(shown).every((key) => key === "details");
		const { body: told, notes } = splitModelNotes(
			metadataOnly ? "" : resultText(unwrapResultEnvelope(shown), Number.POSITIVE_INFINITY),
		);
		// A refusal's tail names it (`✗ · bash blocked: system_modify`), so its
		// body keeps the rest of what the call was told, not that line again. A
		// reason the tail only began keeps its full line in the body.
		const refusal = finished?.outcome !== undefined ? finished.blockReason?.trim() : undefined;
		const tailStatesRefusal = refusal !== undefined && blockReasonClause(refusal) === refusal.replace(/\.$/u, "");
		let text = refusal && tailStatesRefusal ? withoutLeadingLine(told, refusal) : told;
		if (finished?.outcome !== undefined) {
			// A person's own denial needs no account back; the tail says it, and /view keeps what the model read.
			text = refusal !== undefined && DENIED_AT_PROMPT.test(refusal) ? "" : withoutModelRejectionAdvice(text);
		}
		// The action row already names this run. A short monitor summary can
		// start with the same id; keep the remainder here and the raw result in
		// inspection, where it is useful as an exact model-facing record.
		const runId = row.toolName === "monitor" ? row.args.run_id : undefined;
		if (typeof runId === "string" && text.startsWith(`${runId} ${UNICODE_GLYPH.sep} `))
			text = text.slice(runId.length + 3);
		if (text.trim().length > 0) {
			// A failed command's body is the command's own output, shown as it ran; a
			// failed tool's body is the harness's error text, so its paths abbreviate.
			const shownText = failure && !command ? displayEmbeddedPaths(text, row.context.cwd ?? process.cwd()) : text;
			const safeText = tidyPreviewText(redactStreamingSecretString(shownText, finished !== undefined)).trimEnd();
			const rail = failure ? RAIL_ERROR() : RAIL_NORMAL();
			// A JSON result reads as fact rows of its first level, never as raw JSON cut mid-token; a command's output
			// is shown as it printed.
			const facts = command ? null : jsonFactRows(safeText, Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH));
			if (facts !== null) {
				rows.push(
					...previewRows(
						facts.map((fact) => `${rail}${fact}`),
						limit,
						width,
						false,
						rail,
						BODY_INDENT_VISIBLE_WIDTH,
						(hidden) => `${hidden.length} more ${hidden.length === 1 ? "field" : "fields"}`,
					),
				);
			} else {
				const ink = toolOutputInk(safeText);
				const body = ink.map((line) => cardRows(line, width, failure));
				// A test runner prints its pass and fail counts above lines like `todo 0` and `duration_ms`, so a plain
				// tail showed those and hid the result; a command's preview keeps its tally lines (F21).
				const tally = command
					? (index: number) => TEST_TALLY_LINE.test(stripTerminalSequences(ink[index] ?? ""))
					: undefined;
				rows.push(...previewLines(body, limit, width, command || !finished, rail, BODY_INDENT_VISIBLE_WIDTH, tally));
			}
		}
		// Guidance middleware attached for the model is not the tool's output and asks
		// nothing of the operator: Detailed states it as one toolMeta row, Standard leaves
		// it out, and /view keeps the result as the model read it.
		if (notes.length > 0 && detail.provenance) {
			const more = notes.length > 1 ? `${SEP}+${notes.length - 1} more` : "";
			rows.push(
				`${failure ? RAIL_ERROR() : RAIL_NORMAL()}${toolMeta(truncateToWidth(sanitizeCallTargetText(`note to model${SEP}${operatorNoteText(notes[0] ?? "")}`), Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH - more.length), GLYPH.ellipsis))}${toolMeta(more)}`,
			);
		}
	}
	// A settled call's screenshots draw under its body where the terminal draws images (S5).
	if (finished !== undefined && !failure) rows.push(...renderToolResultImages(finished.result, width, options));
	return rows;
}

/**
 * The operator's view of a model-only note: no ledger entry ids and nothing
 * from the first diagnostic marker on, so a truncated digest never reaches the
 * transcript (flywheel F-Q3). /view keeps the note as the model read it.
 */
function operatorNoteText(note: string): string {
	const bare = note.replace(/\[[a-z]{1,4}-[\w-]+\]\s*/gu, "");
	const cut = bare.search(/\s*(?:with\s+)?\[(?:diagnostic\b|…|\.\.\.)/u);
	return cut < 0 ? bare : bare.slice(0, cut);
}
