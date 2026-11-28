// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's inspection artifacts: every act the transcript states, newest first, each
 * loadable in full and redacted for the inspector.
 */

import { sanitizeAssistantProse } from "../../core/assistant-prose.js";
import { stripTerminalSequences, truncateToWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../../lib/call-target/call-target.js";
import { holdUnresolvedStrings, holdUnresolvedUserinfo, redactSecretString } from "../../lib/secrets/redaction.js";
import type { ViewArtifact } from "../../session-control/view-artifacts.js";
import { finishedCall, shownArgs } from "../chat-tool-rows.js";
import { providerErrorEvidence } from "../renderers/provider-error.js";
import { renderRetryStatus } from "../renderers/retry-status.js";
import type { ToolExecutionFinished } from "../renderers/tool-call-model.js";
import { renderToolExecution } from "../renderers/tool-execution.js";
import { isChangeOrCheckCall } from "../renderers/tool-fold.js";
import { toolRowTitle } from "../renderers/tool-subline.js";
import { renderWorkerEntryLines } from "../renderers/worker-entry.js";
import { GLYPH } from "../theme/index.js";
import { transcriptDetail } from "../transcript-detail.js";
import type { ChatPanelScope } from "./scope.js";

export function collectInspectionArtifacts(scope: ChatPanelScope): ViewArtifact[] {
	const { options, transcript } = scope;
	const artifacts: ViewArtifact[] = [];
	// Secret patterns can consume the start of an ANSI SGR sequence when
	// applied to an already styled row, leaving its `;2;...m` tail visible.
	// Redact the plain row when it contains a secret; keep styling otherwise.
	const redactInspectionRow = (row: string): string => {
		const plain = stripTerminalSequences(row);
		const redacted = redactSecretString(plain);
		return redacted === plain ? row : redacted;
	};
	// A fitted row's marker can outgrow what it replaced, and the TUI throws on a row past the terminal's width.
	const redactFittedRow = (row: string, width: number): string => {
		const redacted = redactInspectionRow(row);
		return redacted === row ? row : truncateToWidth(redacted, width, GLYPH.ellipsis, false);
	};
	// Newest first by the time each act happened; acts stamped in the same
	// millisecond keep their transcript order.
	let previousAt = Number.NEGATIVE_INFINITY;
	const add = (
		title: string,
		at: number,
		lines: () => string[],
		render?: (width: number) => string[],
		extra: Partial<Pick<ViewArtifact, "toolName" | "searchText" | "category">> = {},
	) => {
		const index = artifacts.length;
		const timestamp = Math.max(at, previousAt + 1);
		previousAt = timestamp;
		const clean = redactSecretString(sanitizeCallTargetText(title));
		artifacts.push({
			id: `transcript:${index + 1}`,
			category: extra.category ?? "transcript",
			title: clean,
			timestamp,
			searchText: [clean, ...(extra.searchText ?? []).map((value) => redactSecretString(sanitizeCallTargetText(value)))],
			...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
			load: async () => ({
				format: "text",
				lines: lines().map(redactInspectionRow),
				...(render === undefined
					? {}
					: { render: (width: number) => render(width).map((row) => redactFittedRow(row, width)) }),
			}),
		});
	};
	/** A block's first row, plain: how the transcript states it. */
	const firstRow = (rows: readonly string[]): string =>
		rows.map((row) => stripTerminalSequences(row).trim()).find((row) => row.length > 0) ?? "";
	const standard = transcriptDetail("standard");
	for (const entry of transcript) {
		if (entry.role === "assistant") {
			for (const seg of entry.segments) {
				if (seg.kind === "error")
					add("Provider or terminal error", seg.at, () => providerErrorEvidence(seg.text).split("\n"));
				if (seg.kind === "thinking" && seg.text.trim().length > 0) {
					// Whole, because these rows redact one at a time and `--token` can end the line before its value.
					const prose = redactSecretString(
						sanitizeAssistantProse(seg.finalized ? seg.text : holdUnresolvedUserinfo(seg.text)),
					);
					const opening = prose.trim().split("\n", 1)[0] ?? "";
					add(`Thinking ${GLYPH.sep} ${opening}`, seg.at, () => sanitizeMultilineDisplayText(prose).text.split("\n"));
				}
				if (seg.kind === "tool") {
					// Titled by its row as the transcript states it; inspected in full,
					// every argument included, whatever card sits under it.
					const call: ToolExecutionFinished = {
						...finishedCall(seg),
						result: seg.result ?? holdUnresolvedStrings(seg.partialResult),
						cardAttached: undefined,
					};
					const row = seg.finished
						? finishedCall(seg)
						: { toolCallId: seg.id, toolName: seg.name, args: shownArgs(seg), cardAttached: seg.cardAttached };
					add(
						toolRowTitle(row),
						seg.at,
						() => renderToolExecution(call, 120, { unbounded: true, diffStyle: "plain" }),
						(width) => renderToolExecution(call, width, { unbounded: true, diffStyle: "plain" }),
						{
							toolName: seg.name,
							searchText: [seg.name, seg.id],
							...(isChangeOrCheckCall(row) ? { category: "changes" as const } : {}),
						},
					);
				}
			}
		} else if (entry.role === "retryStatus" && entry.status.errorMessage) {
			const status = entry.status;
			add(firstRow(renderRetryStatus(status, 120, standard)), entry.at, () =>
				providerErrorEvidence(status.errorMessage ?? "").split("\n"),
			);
		} else if (entry.role === "worker") {
			const state = entry.state;
			// A council member is titled by its own row, not the round's header.
			const header = firstRow(
				renderWorkerEntryLines(state, 120, {
					detail: standard,
					group: "continues",
					telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
				}),
			);
			add(
				header,
				entry.at,
				() =>
					renderWorkerEntryLines(state, 120, {
						unbounded: true,
						telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
					}),
				(width) =>
					renderWorkerEntryLines(state, width, {
						unbounded: true,
						telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
					}),
				{ searchText: [state.agentId, state.runId] },
			);
		} else if (entry.role === "replayBlock") {
			const detailed = transcriptDetail("detailed");
			const title = firstRow(entry.renderBlock(120, standard, false));
			if (title.length === 0) continue;
			add(
				title,
				entry.at,
				() => entry.renderBlock(120, detailed, true),
				(width) => entry.renderBlock(width, detailed, true),
			);
		}
	}
	return artifacts;
}
