// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { tierPolicy } from "../../core/presentation-tier.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString, redactStreamingSecretString, redactToolArgs } from "../../domains/safety/redaction.js";
import {
	chainStepToolCallId,
	type GatewayChainStep,
	gatewayChainPending,
	gatewayChainPlan,
	gatewayChainSteps,
	type PlannedChainStep,
} from "../../tools/gateway-display.js";
import { resolveToolRow } from "../../tools/presentation.js";
/** Gateway chain rendering: the planned and settled step rows, the chain output, preview and settled card. */
import { cardHead, cardRows } from "../card.js";
import { GLYPH } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { previewBudget, previewRows, tidyPreviewText } from "./preview.js";
import { approvalReceiptRows } from "./tool-approval-cards.js";
import {
	ARG_PREVIEW_LIMIT,
	BODY_INDENT_VISIBLE_WIDTH,
	CONTENT_INDENT_WIDTH,
	green,
	RAIL_ERROR,
	RAIL_NORMAL,
	red,
	SEP,
	STATUS_ERROR_GLYPH,
	STATUS_OK_GLYPH,
	type ToolBodyRenderOptions,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	toolMeta,
	truncate,
} from "./tool-call-model.js";
import { ledgerTail, renderOutputFooter, renderOutputMeta } from "./tool-facts.js";
import {
	asBashArgs,
	renderBashResultBlock,
	renderResultBlock,
	resultText,
	splitModelNotes,
	unwrapResultEnvelope,
	withoutCommandStatus,
} from "./tool-result-text.js";
import {
	headerLine,
	previewActionRows,
	resolveRow,
	rowObject,
	type StatusMeta,
	settledStatus,
	styledVerb,
} from "./tool-subline.js";

/** A settled chain step as the call a direct invocation of its capability would have recorded. */
function chainStepCall(parent: ToolExecutionFinished, step: GatewayChainStep): ToolExecutionFinished {
	return {
		toolCallId: chainStepToolCallId(parent.toolCallId, step.id),
		toolName: step.capability,
		args: step.args,
		result: step.result,
		isError: step.isError,
		...(step.outcome === "blocked" ? { outcome: "blocked" as const } : {}),
		...(step.blockReason !== undefined ? { blockReason: step.blockReason } : {}),
		...(step.actionClass !== undefined ? { actionClass: step.actionClass } : {}),
		// The chain's own cut, which the step's details cannot know about.
		...(step.truncated === true ? { resultSummary: { truncated: true } } : {}),
	};
}

function settledChainSteps(
	finished: ToolExecutionFinished,
): Array<{ id: string; call: ToolExecutionFinished; unresolved: boolean }> {
	return gatewayChainSteps(finished.toolName, finished.result).map((step) => ({
		id: step.id,
		call: chainStepCall(finished, step),
		unresolved: step.bindingError !== undefined,
	}));
}

/** The width a nested step row's object is budgeted against: the body column, not the gutter row. */
function stepObjectWidth(width: number): number {
	return Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH + CONTENT_INDENT_WIDTH);
}

/**
 * One settled step: its status glyph, the capability, the object a direct call
 * of it states (a path, a pattern, a command) and its outcome facts.
 */
function settledStepLine(step: ToolExecutionFinished, width: number, unresolved = false): string {
	const row = resolveRow(step);
	const glyph = step.isError ? red(STATUS_ERROR_GLYPH) : green(STATUS_OK_GLYPH);
	const name = styledVerb(sanitizeCallTargetText(row.externalLabel ?? step.toolName), row);
	const object = row.externalLabel === null ? rowObject(row, step, stepObjectWidth(width)) : "";
	const scopeText = row.spec.scope?.(row.args, row.context) ?? null;
	const scope = scopeText === null ? "" : ` in ${truncate(sanitizeCallTargetText(scopeText), ARG_PREVIEW_LIMIT)}`;
	// A step whose `$from` input could not be resolved never ran; its object
	// is the unresolved request, so say so instead of implying execution.
	const blocked = unresolved
		? toolMeta(`${SEP}input unresolved, not run`)
		: step.outcome === "blocked"
			? toolMeta(`${SEP}blocked`)
			: "";
	return `${glyph} ${name}${object.length > 0 ? ` ${object}` : ""}${scope}${blocked}${unresolved ? "" : ledgerTail(step, row).facts}`;
}

/** A step that has not run: queued while the chain runs, `not run` once it settled without it. */
function plannedStepLine(step: PlannedChainStep, note: string | null, width: number): string {
	const row = resolveToolRow(step.capability, redactToolArgs(step.args), undefined, undefined, { cwd: process.cwd() });
	const name = toolMeta(sanitizeCallTargetText(row.externalLabel ?? step.capability));
	const object = row.externalLabel === null ? rowObject(row, null, stepObjectWidth(width)) : "";
	return `${toolMeta(GLYPH.queued)} ${name}${object.length > 0 ? ` ${object}` : ""}${note === null ? "" : toolMeta(`${SEP}${note}`)}`;
}

/** One row per step under a chain, settled steps in the order they settled and then the ones it never ran. */
function chainStepRows(call: ToolExecutionStart | ToolExecutionFinished, width: number, failure: boolean): string[] {
	const plan = gatewayChainPlan(call.toolName, call.args);
	const finished = "result" in call ? call : null;
	const lines =
		finished === null
			? plan.map((step) => plannedStepLine(step, null, width))
			: [
					...settledChainSteps(finished).map((step) => settledStepLine(step.call, width, step.unresolved)),
					...gatewayChainPending(finished.result).map((id) => {
						const planned = plan.find((step) => step.id === id);
						return planned === undefined
							? `${toolMeta(GLYPH.queued)} ${toolMeta(sanitizeCallTargetText(id))}${toolMeta(`${SEP}not run`)}`
							: plannedStepLine(planned, "not run", width);
					}),
				];
	return lines.flatMap((line) => cardRows(line, width, failure));
}

/**
 * A chain's output, step by step, each under a label naming the step. The
 * aggregate result is the model's JSON digest of the same outputs, so the body
 * never prints it. A failed chain shows only the steps that failed.
 */
function chainOutputRows(finished: ToolExecutionFinished, width: number, failure: boolean): string[] {
	const rows: string[] = [];
	for (const { id, call } of settledChainSteps(finished)) {
		if (failure && !call.isError) continue;
		const command = resolveRow(call).spec.class === "execute";
		const shown = call.isError && command ? withoutCommandStatus(call.result) : call.result;
		const { body } = splitModelNotes(resultText(unwrapResultEnvelope(shown), Number.POSITIVE_INFINITY));
		const tidy = tidyPreviewText(body);
		if (tidy.trim().length === 0) continue;
		rows.push(
			...cardRows(toolMeta(sanitizeCallTargetText(`${call.toolName}${SEP}${id} ${GLYPH.crumb}`)), width, failure),
		);
		rows.push(...cardRows(redactSecretString(tidy), width, failure));
	}
	return rows;
}

/** A gateway chain in the transcript: its own row, one row per step, and the outputs the style allows. */
export function renderChainPreview(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	detail: TranscriptDetailPolicy,
	options: ToolBodyRenderOptions & { terminalRows?: number; partialResult?: unknown },
): string[] {
	const finished = "result" in call ? call : undefined;
	const failure = finished?.isError === true || finished?.outcome !== undefined;
	const rail = failure ? RAIL_ERROR() : RAIL_NORMAL();
	const rows = previewActionRows(call, width, undefined, tierPolicy(detail.style));
	if (!detail.evidence && (finished === undefined || (!failure && finished.operatorGrant === undefined)))
		return [
			...rows,
			...approvalReceiptRows(call, width, failure),
			...(finished?.autoApproved === "yolo" ? chainStepRows(call, width, failure) : []),
		];
	rows.push(...approvalReceiptRows(call, width, failure));
	rows.push(
		...previewRows(
			chainStepRows(call, width, failure),
			previewBudget(detail.invocationRows, options.terminalRows),
			width,
			false,
			rail,
			BODY_INDENT_VISIBLE_WIDTH,
		),
	);
	const limit = previewBudget(
		failure ? detail.errorRows : finished === undefined ? detail.liveResultRows : detail.resultRows,
		options.terminalRows,
	);
	if (limit <= 0) return rows;
	let body = finished === undefined ? [] : chainOutputRows(finished, width, failure);
	// A chain that never parsed, or one still running, has no settled steps;
	// its own text (the refusal, or the running step's partial output) is the body.
	if (body.length === 0 && (finished === undefined || settledChainSteps(finished).length === 0)) {
		const result = finished?.result ?? options.partialResult;
		const text = result === undefined ? "" : resultText(unwrapResultEnvelope(result), Number.POSITIVE_INFINITY);
		body =
			text.trim().length === 0
				? []
				: cardRows(redactStreamingSecretString(tidyPreviewText(text), finished !== undefined), width, failure);
	}
	rows.push(...previewRows(body, limit, width, finished === undefined, rail, BODY_INDENT_VISIBLE_WIDTH));
	return rows;
}

/** A gateway chain, unbounded: its row, one row per step, then each step's full output as its own block. */
export function renderChainExecution(
	finished: ToolExecutionFinished,
	width: number,
	opts: ToolBodyRenderOptions,
): string[] {
	const status = settledStatus(finished);
	const statusMeta: StatusMeta = {
		durationMs: finished.durationMs,
		outcome: finished.outcome,
		blockReason: finished.blockReason,
	};
	const out = [...cardHead(headerLine(finished, status, statusMeta, width), "", width)];
	out.push(...approvalReceiptRows(finished, width, finished.isError));
	out.push(...chainStepRows(finished, width, finished.isError));
	const steps = settledChainSteps(finished);
	if (steps.length === 0) {
		out.push(...renderOutputMeta(finished, width, finished.isError));
		out.push(...renderResultBlock(finished.result, finished.isError, width, opts));
		return out;
	}
	for (const { id, call } of steps) {
		out.push(...renderOutputMeta(call, width, call.isError, `${call.toolName}${SEP}${id}`));
		const bashArgs = resolveRow(call).spec.class === "execute" ? asBashArgs(redactToolArgs(call.args)) : null;
		out.push(
			...(bashArgs === null
				? renderResultBlock(call.result, call.isError, width, opts)
				: renderBashResultBlock(bashArgs, call.result, width, call.isError, opts)),
		);
		out.push(...renderOutputFooter(call, width, call.isError));
	}
	return out;
}
