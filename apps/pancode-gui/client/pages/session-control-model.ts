// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Problem } from "../../contracts/common.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";

export type SessionControlTarget = Readonly<{
	id: string;
	workspaceId: string;
	title: string;
	currentTurnId: string | null;
}>;

export type SessionControlRequest = Readonly<{
	sessionId: string;
	workspaceId: string;
	title: string;
	action: "stop" | "close";
	turnId: string | null;
	key: string;
	epoch: string | null;
	stage: "sending" | "unresolved" | "complete";
	message: string;
	restarted: boolean;
	/** The server refused the stop because the named turn was not running, so nothing was stopped. */
	nothingStopped?: true;
}>;

/**
 * A stop the server refuses as a conflict did nothing: the turn had ended, another turn runs now, or the
 * session is not open. The server's sentence says which. A refusal naming another window's control is
 * not one of these, because taking control and retrying can still stop the turn.
 */
export function stopRefusal(problem: Problem | undefined): string | null {
	return problem?.code === "conflict" && !problem.control ? problem.detail : null;
}

export function observedControlOutcome(request: SessionControlRequest, snapshot: SessionSnapshot): string | null {
	if (snapshot.id !== request.sessionId) return null;
	if (request.action === "close") return snapshot.state === "closed" ? "This session is closed." : null;
	const turn = snapshot.turns.find((row) => row.id === request.turnId);
	if (!turn || turn.status === "running") return null;
	return {
		succeeded: "The original turn finished before this refresh. It is no longer running.",
		failed: "The original turn failed. Open the session to review its result.",
		cancelled: "The original turn is canceled.",
	}[turn.status];
}

/** A route change or a card filter cannot discard an unresolved control request. */
export function createSessionControlStore() {
	let records: readonly SessionControlRequest[] = [];
	const listeners = new Set<() => void>();
	const publish = (next: readonly SessionControlRequest[]) => {
		records = next;
		for (const listener of listeners) listener();
	};
	return {
		read: () => records,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		begin: (request: SessionControlRequest): boolean => {
			if (records.some((row) => row.sessionId === request.sessionId && row.stage !== "complete")) return false;
			const held = records.filter((row) => row.sessionId !== request.sessionId);
			if (held.length >= 64) {
				const settled = held.findIndex((row) => row.stage === "complete");
				if (settled < 0) throw new Error("Resolve one of the 64 retained session controls before starting another.");
				held.splice(settled, 1);
			}
			publish([...held, request]);
			return true;
		},
		patch: (
			key: string,
			update: Partial<Pick<SessionControlRequest, "stage" | "message" | "epoch" | "restarted" | "nothingStopped">>,
		) => {
			publish(records.map((row) => (row.key === key ? { ...row, ...update } : row)));
		},
		remove: (key: string) => publish(records.filter((row) => row.key !== key || row.stage === "sending")),
	};
}

export type SessionControlNoticeView = Readonly<{
	/** Anything to show: a request on record or a notice. */
	shown: boolean;
	needsReview: boolean;
	sending: boolean;
	/** Every request has settled with nothing left to review, so the banner may clear itself. */
	settled: boolean;
	/** The settled requests' keys, joined; a change restarts the clearing wait. */
	completedKeys: string;
	state: "unresolved" | "sending" | "complete";
	tone: "warn" | "running" | "neutral" | "success";
	label: string;
	summary: string;
}>;

/** The task bar's control banner, from the retained requests and the controls' notice. */
export function sessionControlNotice(
	records: readonly SessionControlRequest[],
	notice: string | null,
): SessionControlNoticeView {
	const unresolved = records.filter((row) => row.stage === "unresolved");
	const pending = records.filter((row) => row.stage === "sending");
	const latest = pending.at(-1) ?? records.at(-1);
	const needsReview = unresolved.length > 0 || notice !== null;
	const sending = pending.length > 0;
	const idle = !needsReview && !sending && latest?.nothingStopped === true;
	// A settled request is titled by what happened, so a turn cancel reads "Canceled" rather than a generic check.
	const label = needsReview
		? "Check session"
		: sending
			? "Request in progress"
			: latest?.action === "close"
				? "Closed"
				: idle
					? "Nothing to cancel"
					: "Canceled";
	const summary = needsReview
		? `${unresolved.length || 1} session ${unresolved.length > 1 ? "requests need" : "request needs"} your review.`
		: pending.length > 1
			? `${pending.length} session requests in progress…`
			: latest?.action === "close"
				? `${sending ? "Close request" : "Closed"} · ${latest.title}`
				: `${sending ? "Cancel request" : idle ? "Nothing canceled" : "Cancel confirmed"} · ${latest?.title ?? "Session"}`;
	return {
		shown: latest !== undefined || notice !== null,
		needsReview,
		sending,
		settled: latest?.stage === "complete" && unresolved.length === 0 && pending.length === 0 && notice === null,
		completedKeys: records
			.filter((row) => row.stage === "complete")
			.map((row) => row.key)
			.join(" "),
		state: needsReview ? "unresolved" : sending ? "sending" : "complete",
		tone: needsReview ? "warn" : sending ? "running" : idle ? "neutral" : "success",
		label,
		summary,
	};
}
