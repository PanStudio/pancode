// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The board's items: council member folding, earlier-session grouping, and the selectable rows. */
import { parseCouncilReport } from "../domains/agents/index.js";
import { NEVER_STARTED_WORDS, workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
import { redactStreamingSecretString } from "../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../session-control/council.js";
import type { CouncilGroupView, CouncilMemberView } from "./council-grid.js";
import {
	completedRunFailure,
	type DispatchBoardRow,
	type DispatchBoardStatus,
	dispatchStatusPresentation,
	dispatchUsageText,
	isTerminalStatus,
	SEP,
	STATUS_ORDER,
	terminalDetail,
} from "./dispatch-row-model.js";
import {
	councilAnswerGist,
	councilCollectedWords,
	councilSynthesisLines,
	exactWorkerAnswerObject,
	presentWorkerContractAnswer,
} from "./renderers/worker-answer.js";
import type { PancodeTheme } from "./theme/index.js";
import { animationStep, formatElapsed, formatTargetLabel, GLYPH } from "./theme/index.js";
import { completedRunMark } from "./worker-activity.js";

/** The route as the run's detail card words it, so the dock and the board never name one route two ways. */
export function formatRowRoute(row: Pick<DispatchBoardRow, "targetId" | "wireModelId">): string {
	return sanitizeCallTargetText(formatTargetLabel(row.targetId, row.wireModelId, { abbreviate: false }));
}

/** A settled member's typed answer in the words its own card shows; a live one streams its raw tail. */
function councilMemberTail(row: DispatchBoardRow): string {
	const progress = row.progress;
	if (progress === undefined) return "";
	// A synthesis tail the report reader could not take whole is a cut piece of JSON; the record holds it readably.
	if (row.council?.label === COUNCIL_SYNTHESIS_LABEL && /^\s*[{[]/u.test(progress.tailText)) return "";
	const presented = presentWorkerContractAnswer(
		progress.tailText,
		row.resultContract,
		progress.droppedLines === 0 && progress.droppedBytes === 0,
		progress.settled,
	);
	if (presented !== null) return presented.lines.join("\n");
	// A settled member whose typed answer the full presenter could not take still reads as words, never as raw JSON.
	if (progress.settled === true && exactWorkerAnswerObject(progress.tailText) !== null)
		return councilAnswerGist(progress.tailText);
	return redactStreamingSecretString(progress.tailText, progress.completed === true);
}

/**
 * One member column's facts, drawn from the row the board already keeps. The
 * route, status, and answer tail are the same values the run's own card shows,
 * so a council column and a council card can never disagree.
 */
function councilMemberView(
	row: DispatchBoardRow,
	council: NonNullable<DispatchBoardRow["council"]>,
): CouncilMemberView {
	const full = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	// A member column words its outcome the way its own run row does, caveat included.
	const caveat = completedRunFailure(row);
	const mark = completedRunMark(caveat);
	const presentation =
		caveat !== null
			? { glyph: mark.glyph, label: caveat.words, token: mark.token }
			: row.status === "completed"
				? { ...full, label: "done" }
				: full;
	const progress = councilMemberProgress(row);
	return {
		runId: row.runId,
		label: council.label,
		...(council.color !== undefined ? { color: council.color } : {}),
		round: council.round,
		route: formatRowRoute(row),
		status: { ...presentation, ...(progress !== null ? { label: `${presentation.label}${SEP}${progress}` } : {}) },
		// Each line of the answer stays its own line: one flattened paragraph ran a claim into its citation.
		tailText: sanitizeMultilineDisplayText(councilMemberTail(row)).text,
		droppedLines: row.progress?.droppedLines ?? 0,
		...(isTerminalStatus(row.status) ? { settled: true } : {}),
		...memberWhy(row),
	};
}

/**
 * How long a member has run and how much it has produced, so a slow member reads as working rather than stuck. A
 * running member shows the output it has streamed (an estimate, marked `~`) because its calls report usage only
 * once they finish; a settled member shows the measured output when the read model has it.
 */
function councilMemberProgress(row: DispatchBoardRow): string | null {
	if (row.status === "enqueued") return null;
	const facts: string[] = [formatElapsed(row.elapsedMs)];
	const measured = dispatchUsageText(row.usage).measuredOutput;
	if (isTerminalStatus(row.status)) {
		if (measured !== null && measured > 0) facts.push(`${dispatchUsageText(row.usage).output} out`);
	} else {
		const streamed = row.progress?.streamedOutputTokens;
		if (streamed !== undefined && streamed > 0) facts.push(`~${streamed} tok out`);
	}
	return facts.join(SEP);
}

function memberWhy(row: DispatchBoardRow): { why?: string } {
	if (!isTerminalStatus(row.status) || row.status === "completed") return {};
	const why = workerFailureHeadline(terminalDetail(row));
	if (why === null) return {};
	// Inside a council the work that stopped is the council, whose own notice names the cause.
	return {
		why:
			why === NEVER_STARTED_WORDS ? "it never started, because its council stopped first" : sanitizeCallTargetText(why),
	};
}

/**
 * Fold one council group's rows into the view the grid renders.
 *
 * A council of N members over R rounds seals N x R member runs, and the
 * operator is looking at a council, not at its history: each label keeps its
 * newest round, so the group shows one column per member however many rounds
 * it ran. Columns are ordered by label so a repaint cannot reshuffle them under
 * the cursor while runs settle in whatever order they finish.
 */
function foldCouncilGroup(
	group: string,
	rows: ReadonlyArray<DispatchBoardRow>,
	selectedRunId?: string | null,
): CouncilGroupView {
	const newest = new Map<string, DispatchBoardRow>();
	let synthesisRow: DispatchBoardRow | null = null;
	let rank = Number.POSITIVE_INFINITY;
	let elapsedMs = 0;
	let round = 1;
	for (const row of rows) {
		const council = row.council;
		if (council === undefined) continue;
		rank = Math.min(rank, STATUS_ORDER[row.status]);
		elapsedMs = Math.max(elapsedMs, row.elapsedMs);
		if (council.label === COUNCIL_SYNTHESIS_LABEL) {
			synthesisRow = row;
			continue;
		}
		round = Math.max(round, council.round);
		const previous = newest.get(council.label);
		if (previous === undefined || (previous.council?.round ?? 0) <= council.round) newest.set(council.label, row);
	}
	const aggregate = (Object.entries(STATUS_ORDER) as Array<[DispatchBoardStatus, number]>).find(
		([, value]) => value === rank,
	);
	const aggregateStatus = aggregate?.[0] ?? "running";
	const aggregatePresentation = dispatchStatusPresentation(aggregateStatus, {
		...(aggregateStatus === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	const presentation =
		aggregateStatus === "completed" ? { ...aggregatePresentation, label: "done" } : aggregatePresentation;
	const task = rows.find(
		(row) => row.taskSummary !== undefined && row.council?.label !== COUNCIL_SYNTHESIS_LABEL,
	)?.taskSummary;
	const members = [...newest.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		// biome-ignore lint/style/noNonNullAssertion: every entry was inserted with its own council badge.
		.map(([, row]) => councilMemberView(row, row.council!));
	// The synthesis run seals the whole council as one report. Its members' answers are already the columns above it,
	// so the board reads only the council's own answer out of it, and a council that only collected has none to show.
	const report =
		synthesisRow !== null && isTerminalStatus(synthesisRow.status)
			? parseCouncilReport(synthesisRow.progress?.tailText ?? null)
			: null;
	const collected = report?.synthesis.kind === "none";
	const synthesis =
		synthesisRow === null || collected
			? null
			: {
					// biome-ignore lint/style/noNonNullAssertion: the synthesis row was matched on its own council badge.
					...councilMemberView(synthesisRow, synthesisRow.council!),
					...(report !== null
						? { tailText: sanitizeMultilineDisplayText(councilSynthesisLines(report).join("\n")).text, droppedLines: 0 }
						: {}),
				};
	const selectedInGroup =
		selectedRunId != null && rows.some((row) => row.runId === selectedRunId) ? selectedRunId : undefined;
	return {
		group,
		members,
		synthesis,
		...(collected && report !== null ? { collectedNote: councilCollectedWords(report) } : {}),
		status: { ...presentation },
		...(task !== undefined ? { task: sanitizeCallTargetText(task) } : {}),
		round,
		elapsed: formatElapsed(elapsedMs),
		...(selectedInGroup !== undefined ? { selectedRunId: selectedInGroup } : {}),
		...(rows.length > 0 && rows.every((row) => row.earlier === true) ? { earlier: true as const } : {}),
	};
}

/**
 * Live rows plus the settled members of any council still running. A council is one card, so the member that already
 * answered stays in it: without it a council of two with one member left read `council of 1 · running`.
 */
export function withCouncilSiblings(
	active: ReadonlyArray<DispatchBoardRow>,
	all: ReadonlyArray<DispatchBoardRow>,
): DispatchBoardRow[] {
	const groups = new Set(active.flatMap((row) => (row.council === undefined ? [] : [row.council.group])));
	if (groups.size === 0) return [...active];
	const shown = new Set(active.map((row) => row.runId));
	return [
		...active,
		...all.filter((row) => row.council !== undefined && groups.has(row.council.group) && !shown.has(row.runId)),
	];
}

/** A board entry: either one ordinary run, or one whole council in the position of its first row. */
export type DispatchBoardItem = { kind: "run"; row: DispatchBoardRow } | { kind: "council"; group: CouncilGroupView };

/**
 * Board order with councils folded in place. A council occupies the position of
 * its first row and its remaining rows are consumed, so the board never shows a
 * member both inside its group and beside it.
 */
export function dispatchBoardItems(
	rows: ReadonlyArray<DispatchBoardRow>,
	selectedRunId?: string | null,
): DispatchBoardItem[] {
	const byGroup = new Map<string, DispatchBoardRow[]>();
	for (const row of rows) {
		const group = row.council?.group;
		if (group === undefined) continue;
		const bucket = byGroup.get(group);
		if (bucket === undefined) byGroup.set(group, [row]);
		else bucket.push(row);
	}
	const emitted = new Set<string>();
	const items: DispatchBoardItem[] = [];
	for (const row of rows) {
		const group = row.council?.group;
		if (group === undefined) {
			items.push({ kind: "run", row });
			continue;
		}
		if (emitted.has(group)) continue;
		emitted.add(group);
		items.push({ kind: "council", group: foldCouncilGroup(group, byGroup.get(group) ?? [row], selectedRunId) });
	}
	return items;
}

export function itemFromEarlierSession(item: DispatchBoardItem): boolean {
	return item.kind === "run" ? item.row.earlier === true : item.group.earlier === true;
}

/** The rule over the runs an earlier PanCode recorded: dim, named and counted, so it reads without colour too. */
export function earlierSessionsRule(theme: PancodeTheme, count: number, width: number): string {
	const rule = GLYPH.innerDivider;
	const text = truncateToWidth(
		`${rule}${rule} earlier sessions${SEP}${count} run${count === 1 ? "" : "s"} `,
		width,
		GLYPH.ellipsis,
		false,
	);
	return theme.fg("annotation", `${text}${rule.repeat(Math.max(0, width - visibleWidth(text)))}`);
}

/** Use the same folded, sorted council projection for focus as for visible cards. */
export function selectableBoardRows(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const byRunId = new Map(rows.map((row) => [row.runId, row]));
	return dispatchBoardItems(rows).flatMap((item) => {
		if (item.kind === "run") return [item.row];
		const members = item.group.synthesis === null ? item.group.members : [...item.group.members, item.group.synthesis];
		return members.flatMap((member) => {
			const row = byRunId.get(member.runId);
			return row ? [row] : [];
		});
	});
}
