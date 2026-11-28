// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The task page's decisions: which project is searched first for an unopened task, and the one status
// chip in the task header. Pure, so the ladder is testable without a browser.

import type { SessionSnapshot, Turn } from "../../contracts/sessions.js";
import { formatDuration } from "../api/clock.js";
import { workerCount } from "../chat/fleet-facts.js";

/** The last project used first, then the rest in the server's order. */
export function preferredFirst<T extends { id: string }>(projects: readonly T[], preferred: string | null): T[] {
	return [...projects.filter((row) => row.id === preferred), ...projects.filter((row) => row.id !== preferred)];
}

/** The sentence appended when some projects could not be read, with its leading space; empty when all were read. */
export const unreadProjectsNote = (unread: number): string =>
	unread > 0 ? ` ${unread} ${unread === 1 ? "project" : "projects"} could not be read.` : "";

export interface TaskChip {
	tone: "working" | "approval" | "failed" | "quiet";
	label: string;
}

export interface TaskChipInput {
	state: SessionSnapshot["state"];
	turn: Pick<Turn, "status" | "startedAt" | "queued"> | undefined;
	/** A permission is waiting on the operator. */
	approval: boolean;
	/** The running context operation's title, or null when none runs. */
	contextWork: string | null;
	running: boolean;
	liveWorkers: number;
	/** The shared second, or 0 while nothing is live. */
	now: number;
}

/** The task header's status chip, or null when the task is open and idle. */
export function taskChip(input: TaskChipInput): TaskChip | null {
	const { state, turn, running } = input;
	if (input.approval) return { tone: "approval", label: "Needs your approval" };
	if (input.contextWork !== null) return { tone: "working", label: input.contextWork };
	if (running && state === "open") {
		if (turn?.queued) return { tone: "quiet", label: "Waiting for a slot" };
		const elapsedMs = turn?.startedAt && input.now > 0 ? Math.max(0, input.now - Date.parse(turn.startedAt)) : 0;
		// Sub-second figures ("0ms") say nothing; the chip shows time once it is a whole second.
		const elapsed = elapsedMs >= 1000 ? formatDuration(elapsedMs) : null;
		const activity =
			input.liveWorkers > 0 ? `Waiting on ${workerCount(input.liveWorkers)}` : turn?.startedAt ? "Working" : "Starting";
		return { tone: "working", label: [activity, elapsed].filter(Boolean).join(" · ") };
	}
	if (state === "starting") return { tone: "working", label: "Starting" };
	if (state === "parked") return { tone: "quiet", label: "Paused" };
	if (state === "closed") return { tone: "quiet", label: "Closed" };
	if (state === "unknown" || state === "failed") return { tone: "failed", label: "Unavailable" };
	if (turn?.status === "failed") return { tone: "failed", label: "Last turn failed" };
	return null;
}
