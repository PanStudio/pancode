// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { actionClassWords, safetyNetRailText } from "../../core/views/approval-words.js";
import { stripTerminalSequences } from "../../engine/tui.js";
import type { ApprovalRequestView } from "../../session-control/approval-request-view.js";
/** The approval and judge cards a held tool call shows, and the approval receipt rows it keeps afterwards. */
import { cardRows } from "../card.js";
import { approvedWorkers } from "../dispatch-plan-summary.js";
import { mutationFactsLine, targetWithoutPayloadSize } from "../mutation-preview.js";
import { GLYPH } from "../theme/index.js";
import {
	presentedCall,
	SEP,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	toolMeta,
	yellow,
} from "./tool-call-model.js";
import { withoutLivePayload } from "./tool-live-payload.js";
import { singleActionLine, sublineParts } from "./tool-subline.js";

/**
 * Marker for a call parked at admission awaiting operator approval. Rendered
 * in place of the elapsed counter so a parked call never reads as executing
 * work; the ⏸ glyph matches the footer's blocked phase.
 */
const AWAITING_APPROVAL_TAIL = () => ` ${yellow(GLYPH.phaseBlocked)}${toolMeta(" awaiting approval")}`;

/** A started call the safety judge still holds: it has not been admitted, so it does not read as running (B01). */
const AWAITING_JUDGE_TAIL = () => ` ${toolMeta(GLYPH.phaseWaiting)}${toolMeta(" waiting for the safety judge")}`;

/** Subline for an in-flight call the safety judge is reviewing before admission. Nothing runs and nothing ticks. */
export function renderToolAwaitingJudge(wire: ToolExecutionStart, width: number): string[] {
	const call = withoutLivePayload(presentedCall(wire));
	const parts = sublineParts(
		{ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args, viaGateway: call.viaGateway },
		"ready",
		{},
		width,
	);
	return [singleActionLine(parts.lead, AWAITING_JUDGE_TAIL(), width)];
}

/**
 * Subline for an in-flight call whose body is parked at the permission gate.
 * No elapsed counter (nothing is running) and no status glyph (nothing has
 * finished): the awaiting-approval tail is the segment's whole state.
 */
export function renderToolAwaitingApproval(
	wire: ToolExecutionStart,
	width: number,
	view?: ApprovalRequestView,
): string[] {
	const call = withoutLivePayload(presentedCall(wire));
	const parts = sublineParts(
		{ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args, viaGateway: call.viaGateway },
		"ready",
		{},
		width,
	);
	const lines = [singleActionLine(parts.lead, AWAITING_APPROVAL_TAIL(), width)];
	if (view === undefined) return lines;
	// The lead row already names a target it can show whole, so `target` only adds what that row cut. A file
	// change's size placeholder is serialization; the mutation row names the size and digest.
	const target = targetWithoutPayloadSize(view.target, view.mutation);
	const leadShowsTarget = target !== undefined && stripTerminalSequences(lines[0] ?? "").includes(target);
	// The axis is a level or a rule, not a requester, so the row says why the call stopped as a sentence.
	// What the call does in words (`runs a command`), not its class name (`execute action`).
	const actionWords = actionClassWords(view.actionClass, approvedWorkers(view));
	const why =
		view.axis.kind === "autonomy"
			? `At ${approvalAxisText(view)}, PanCode asks you before a call that ${actionWords}`
			: `${approvalAxisText(view)} held this call for you; it ${actionWords}`;
	lines.push(...cardRows(toolMeta(why), width, false));
	const facts = [
		...(target !== undefined && target.length > 0 && !leadShowsTarget ? [["target", target]] : []),
		// Size and digest, never the mutation text: this row is the transcript,
		// which is written, replayed, and shared (issue #254).
		...(view.mutation !== undefined ? [["mutation", mutationFactsLine(view.mutation)]] : []),
	] as const;
	for (const [label, value] of facts) {
		lines.push(...cardRows(`${toolMeta(`${label} ${GLYPH.sep}`)} ${value}`, width, false));
	}
	return lines;
}

/**
 * The rule or level that asked, as the parked row and the grant row both state
 * it. The System One gate and the session's test-runner consent are named as
 * themselves: their rail ids only keep the audit row and the approval axis
 * distinct, and "safety-net rail" would send someone scrolling back to look
 * for a standing rule that does not exist.
 */
export function approvalAxisText(view: Pick<ApprovalRequestView, "axis">): string {
	// `default autonomy`, the setting's own words, rather than the field name `autonomy level default`.
	if (view.axis.kind === "autonomy") return `${view.axis.level} autonomy`;
	return safetyNetRailText(view.axis.ruleId);
}

/**
 * The operator's grant under the call it let run (BT-003). Enter closed the
 * card and the settled row read exactly like a call that never asked, so an
 * operator scrolling back could not tell which calls they had approved.
 */
export function approvalReceiptRows(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	failure: boolean,
): string[] {
	const axis = "result" in call ? call.operatorGrant : undefined;
	if (axis === undefined)
		return "result" in call && call.autoApproved === "yolo"
			? cardRows(`${yellow("YOLO")} ${toolMeta(`auto-approved ${GLYPH.dot} no prompt`)}`, width, failure)
			: [];
	// The operator's own mark: `?` is the class of a call that asks, and read as a question still open under a call
	// that had already been allowed.
	const by = "result" in call ? call.grantedBy : undefined;
	return cardRows(`${yellow(GLYPH.user)} ${toolMeta(`allowed by ${by ?? "you"}${SEP}${axis}`)}`, width, failure);
}
