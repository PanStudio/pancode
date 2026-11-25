// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { GLYPH } from "../core/glyphs.js";
import { pancodeStateDir } from "../core/xdg.js";
import { routeSettledLabel } from "../domains/telemetry/index.js";
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui-primitives.js";
import {
	DEFAULT_WIDTH,
	DETAIL_MAX_WIDTH,
	MIN_WIDTH,
	modelObservationText,
	PROSE_MAX_WIDTH,
	type RunViewModel,
	sanitizeBounded,
	TASK_MAX_WIDTH,
	truncatePlain,
} from "./fleet-view-model.js";

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function clockOf(iso: string): string {
	// The transcript is a within-run timeline, so the date carries no
	// information the header does not already give.
	const time = iso.slice(11, 19);
	return time.length === 8 ? time : iso.slice(0, 8);
}

/** Wrap a viewer value inside the columns left by its one-time field label. */
export function wrapViewerValue(prefix: string, value: string, columns: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, columns - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
}

/**
 * The whole viewer surface as lines. Pure: given the same model and width it
 * returns the same strings, which is what lets the data-source test assert the
 * header and outcome without a PTY.
 */
export function renderRunView(model: RunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = GLYPH.rule.repeat(columns);
	const lines: string[] = [];
	lines.push(truncatePlain(`run ${model.runId}  ${model.agentId}`, columns));
	lines.push(
		truncatePlain(
			`model ${model.model}  target ${model.target}  node ${model.node}  phase ${model.phase}  elapsed ${model.telemetry?.activity.elapsed.display ?? "not available"}`,
			columns,
		),
	);
	if (model.task !== undefined) {
		lines.push(...wrapViewerValue("task ", model.task, columns));
	}
	lines.push(rule);
	if (!model.journalPresent && model.agentId === "main-agent" && model.journalUnavailableReason !== undefined) {
		lines.push(...wrapViewerValue("", model.journalUnavailableReason, columns));
	} else if (!model.journalPresent) {
		lines.push("no display feed was recorded or retained for this run.");
		lines.push(...wrapViewerValue("", model.journalUnavailableReason ?? "the feed file is missing.", columns));
		lines.push(...wrapViewerValue("expected ", model.journalPath, columns));
	} else if (model.transcript.length === 0) {
		lines.push("feed is empty; no events recorded yet.");
	} else {
		if (model.transcriptTruncated) lines.push(`${GLYPH.ellipsis} earlier events dropped (feed truncated)`);
		for (const entry of model.transcript) {
			const head = `${clockOf(entry.at)} ${entry.label}`;
			if (entry.detail === undefined) lines.push(truncatePlain(head, columns));
			else lines.push(...wrapViewerValue(`${head}: `, entry.detail, columns));
		}
	}
	lines.push(rule);
	lines.push(...wrapViewerValue("evidence  ", model.evidence, columns));
	if (model.agentLedgerBoard) {
		lines.push("", "shared ledger (what peer workers posted; PanCode has not verified it):");
		for (const line of model.agentLedgerBoard.split("\n")) {
			lines.push(...wrapTextWithAnsi(sanitizeBounded(line, TASK_MAX_WIDTH), columns));
		}
	}
	if (model.record !== undefined) {
		const settled = model.record.settled;
		lines.push(
			...wrapViewerValue(
				"model     ",
				modelObservationText(settled, model.callModels ?? null, model.sessionModel ?? null),
				columns,
			),
		);
		lines.push(truncatePlain(`cost      ${model.telemetry?.row.usd.display ?? "not available"}`, columns));
		lines.push(truncatePlain(`settled   ${sanitizeBounded(routeSettledLabel(settled), 64)}`, columns));
	}
	const outcome =
		model.outcome === null
			? model.terminal
				? "terminal, outcome not recorded"
				: "running"
			: model.outcomeDetail === null || model.outcomeDetail.length === 0
				? model.outcome
				: `${model.outcome} (${sanitizeBounded(model.outcomeDetail, PROSE_MAX_WIDTH)})`;
	lines.push(...wrapViewerValue("outcome   ", outcome, columns));
	const gate = model.gate;
	if (gate !== undefined)
		lines.push(
			...wrapViewerValue(
				"gate      ",
				`run --agent exits 1 (verdict_failed): ${sanitizeBounded(gate.message, DETAIL_MAX_WIDTH)}`,
				columns,
			),
		);
	return lines;
}

/**
 * The watch surface as lines. Pure for the same reason {@link renderRunView}
 * is. A missing selection and a selection the ledger does not know yet are the
 * two states the run renderer cannot say anything about, and both are normal:
 * the first is the pane before any worker was entered, the second is a queued
 * run the operator selected before its ledger row landed.
 */
export function renderWatchView(
	runId: string | null,
	model: RunViewModel | null,
	width: number = DEFAULT_WIDTH,
	ledgerRoot: string = pancodeStateDir(),
): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	if (runId === null) {
		return [
			"no worker selected.",
			"",
			"In PanCode, Alt+W opens the workers dock: a board of this session's",
			"workers, where Enter takes the dock over for one of them.",
		];
	}
	if (model === null) {
		const missing = `run ${sanitizeBounded(runId, 64)} is not in the run ledger under ${ledgerRoot}.`;
		const wrappedMissing: string[] = [];
		for (let offset = 0; offset < missing.length; offset += columns) {
			wrappedMissing.push(missing.slice(offset, offset + columns));
		}
		return [
			...wrappedMissing,
			"",
			"If this run is queued, it has not started yet; this view will update when its ledger entry appears.",
			"If it already started or finished, it was not found in this ledger.",
		];
	}
	return renderRunView(model, columns);
}
