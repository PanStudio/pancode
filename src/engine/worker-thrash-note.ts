// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { HANDBACK_NOTE_SHARE } from "../domains/dispatch/handback.js";

/** Recalls of this run's own evicted observations past which the host steps in once (CLI-H3). */
export const THRASH_RECALL_LIMIT = 4;

/** Share of the window a request may reach without any workspace change before the host steps in once (CLI-H3). */
export const THRASH_CONTEXT_FRACTION = 0.8;

const THRASH_CHANGED_PATHS_SHOWN = 10;

/** The one host turn a thrashing worker gets: what the host saw, then write now or report what it has. */
export function thrashHostNote(
	cause: "recall" | "context" | "streak",
	count: number,
	canWrite: boolean,
	roleShare: boolean,
	canPlan: boolean,
): string {
	const seen =
		cause === "recall"
			? `this run has recalled its own evicted observations ${count} times`
			: cause === "streak"
				? `this run has made ${count} read-only calls in a row without an edit${canPlan ? " or a plan update" : ""}`
				: roleShare
					? `this run's context passed ${Math.round(HANDBACK_NOTE_SHARE * 100)}% of its usable context without a workspace change`
					: `this run's context passed ${Math.round(THRASH_CONTEXT_FRACTION * 100)}% of the model window without a workspace change`;
	const why =
		cause === "streak"
			? "Another read will not make the decision for you."
			: "Recalling or re-reading more will not make room; the run fails when the window is full.";
	const ask = canWrite
		? "Write the change now from what you already hold, or stop and return a partial report that names what is done, what is left and the files involved."
		: "Stop gathering and return your report now, marking what is unfinished.";
	return `Host note: ${seen}. ${why} ${ask}`;
}

/** The paths an exhausted run changed, for its outcome detail, so the parent knows what the partial work touched. */
export function exhaustedChangesDetail(mutatedPaths: ReadonlySet<string>, cwd: string): string {
	if (mutatedPaths.size === 0) return "changed nothing before stopping";
	const shown = [...mutatedPaths].sort().slice(0, THRASH_CHANGED_PATHS_SHOWN);
	const names = shown.map((file) => path.relative(cwd, file) || file).join(", ");
	const more = mutatedPaths.size - shown.length;
	return `changed before stopping: ${names}${more > 0 ? ` (+${more} more)` : ""}`;
}
