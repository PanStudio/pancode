// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { AppProblem } from "../services/problem.js";

/** A busy agent can take a while to confirm a stop; past this the stop is reported as unconfirmed, not failed. */
export const CANCEL_TIMEOUT_MS = 10_000;
/** A turn that drops more frames than this is failed rather than left drawing a partial picture. */
export const DROPPED_FRAMES_PER_TURN = 64;
export const STDERR_TAIL_BYTES = 4096;
export const STOP_UNCONFIRMED =
	"PanCode has not confirmed the stop yet. The turn may still end on its own; ask again to force it.";
export const STOP_FORCED = "The turn was stopped by force because PanCode did not confirm the stop.";
export const ENGINE_ENDED = "The PanCode engine process for this session ended unexpectedly.";
/** A frame that failed validation, named by the class of fault the task's notice reports. */
export class FrameFault extends AppProblem {
	constructor(
		readonly faultClass: "non-text chunk" | "no active turn" | "foreign session" | "attribution",
		detail: string,
	) {
		super("upstream_acp", detail);
	}
}
/** The crash notice, with the child's last stderr lines when it wrote any. Never logged. */
export function crashNotice(stderr: string | undefined) {
	const lines = (stderr ?? "")
		.split(/\r?\n/u)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")
		.slice(-20)
		.map((line) => (line.length > 240 ? line.slice(0, 240) : line));
	const head = "The engine process ended unexpectedly. Resume the session to continue from the saved session.";
	return lines.length === 0 ? head : `${head}\n\nLast output from the engine:\n${lines.join("\n")}`;
}
/** Parked snapshots kept in memory. An older one is closed and forgotten, and reloads from its ledger like any saved task. */
export const PARKED_KEPT = 32;
