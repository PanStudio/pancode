// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import { formatDuration } from "../api/clock.js";
import type { ScrollPosition } from "../render/follow-latest.js";
import { isWorking, type LiveStatus } from "./live-status.js";
import { presentTool } from "./tool-presentation.js";
import type { ChatTurn } from "./turns.js";

export const TRANSCRIPT_PAGE_SIZE = 24;
/** Turns mounted per frame while a page opens, so no single task mounts a whole page. */
export const TRANSCRIPT_SLICE_SIZE = 8;
export type TranscriptView = ScrollPosition & { startTurnId: string | null };

/** Keep the displayed start anchored as later turns arrive; search still reads the complete projection. */
export function transcriptStart(turns: readonly ChatTurn[], startTurnId: string | null): number {
	const held = startTurnId === null ? -1 : turns.findIndex((turn) => turn.turnId === startTurnId);
	return held < 0 ? Math.max(0, turns.length - TRANSCRIPT_PAGE_SIZE) : held;
}

/** The first turn of the newest page, where a view with no saved place begins. */
export function newestPageTurn(turns: readonly ChatTurn[]): string | null {
	return turns[transcriptStart(turns, null)]?.turnId ?? null;
}

/** The first turn of the slice that ends before `end`, never earlier than `floor`. */
export function sliceStartTurn(turns: readonly ChatTurn[], floor: number, end: number): string | null {
	return turns[Math.max(floor, end - TRANSCRIPT_SLICE_SIZE)]?.turnId ?? null;
}

/**
 * The index of the first mounted turn. A view opening at the live edge mounts its newest slice; otherwise the turns
 * from the one a reveal has reached, or from `start` once no reveal is under way (`shownIndex` -1).
 */
export function mountedFrom(turns: readonly ChatTurn[], start: number, shownIndex: number, opening: boolean): number {
	return Math.max(start, opening ? turns.length - TRANSCRIPT_SLICE_SIZE : shownIndex);
}

/** Paging back: the earlier page's first turn becomes the anchor, and its reveal starts a slice above `mounted`. */
export function earlierPage(
	turns: readonly ChatTurn[],
	start: number,
	mounted: number,
): { readonly anchor: string | null; readonly shown: string | null } {
	const target = Math.max(0, start - TRANSCRIPT_PAGE_SIZE);
	return { anchor: turns[target]?.turnId ?? null, shown: sliceStartTurn(turns, target, mounted) };
}

/** Reading position is local to this window and cannot carry across a runtime or branch replacement. */
export function createTranscriptViewStore() {
	const views = new Map<string, { scope: number; view: TranscriptView }>();
	return {
		read: (id: string, scope: number) => {
			const saved = views.get(id);
			return saved?.scope === scope ? saved.view : undefined;
		},
		remember: (id: string, scope: number, view: TranscriptView) => {
			views.delete(id);
			if (views.size >= 32) views.delete(views.keys().next().value ?? "");
			views.set(id, { scope, view });
		},
	};
}

/** After this long a live turn names its running time beside what it is doing. */
const LONG_TURN_MS = 45_000;
/** After this long it also says that waiting is expected and how to end the turn. */
const VERY_LONG_TURN_MS = 5 * 60_000;

/**
 * A live turn's chip. A turn that has run a while shows how long, so a quiet stretch reads as work and not as a
 * hang. A turn row stuck at "running" in a session that is no longer open is a record, not activity.
 */
export function turnChip(input: {
	readonly status: LiveStatus;
	readonly live: boolean;
	readonly startedAt: string | null | undefined;
	readonly nowMs: number;
	readonly sessionState: SessionSnapshot["state"];
}): { readonly status: LiveStatus; readonly working: boolean; readonly longRun: boolean } {
	const { status, live, nowMs } = input;
	const startedMs = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
	const runningMs = live && nowMs > 0 && Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
	const shown =
		runningMs >= LONG_TURN_MS
			? { ...status, detail: [status.detail, formatDuration(runningMs)].filter(Boolean).join(" · ") }
			: status;
	const working = live && isWorking(shown.state) && (input.sessionState === "open" || input.sessionState === "starting");
	return { status: shown, working, longRun: runningMs >= VERY_LONG_TURN_MS && working };
}

/**
 * While a request is waiting, its card is the statement; the engine's "pending" notice beside it says the same
 * thing twice. Once answered, the notice is the record. Safety notices always stay.
 */
export function activityRows(items: readonly TimelineItem[], waiting: boolean): readonly TimelineItem[] {
	return waiting ? items.filter((item) => item.kind !== "notice" || item.toolKind === "safety") : items;
}

/**
 * One settled call needs no group around it: "1 tool completed" over a single row is two clicks to read one line.
 * A change is left grouped, because its row opens to a diff and the turn already lists its changes at the end.
 */
export function soloActivity(
	items: readonly TimelineItem[],
	rows: readonly TimelineItem[],
	settled: boolean,
	workspaceRoot: string | undefined,
): boolean {
	const only = rows.length === 1 && items.length === 1 ? rows[0] : undefined;
	return (
		settled &&
		only?.kind === "tool" &&
		presentTool(only, workspaceRoot === undefined ? {} : { workspaceRoot }).body !== "diff"
	);
}
