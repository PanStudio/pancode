// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static } from "typebox";
import type { Turn } from "../../contracts/sessions.js";
import type { CommandResult } from "../../contracts/steering.js";
import type { AcpJob, AcpReadoutsNotification } from "../../contracts/wire.js";
import type { ChildRow } from "./children-file.js";
import type { AcpClient } from "./client.js";
import type { Interviews } from "./interviews.js";
import type { Permissions } from "./permissions.js";
import type { SessionWorkers } from "./session-overview.js";

export type Entry = {
	id: string;
	cwd: string;
	client: AcpClient;
	row: ChildRow;
	turnId: string | null;
	replay: number | null;
	replayStopReason?: string;
	/** When the replayed turn's newest ledger entry was written, from its frames' `pancode/replay`. */
	replayFinishedAt?: string;
	/** The replayed turn's recorded model and route, from its frames' `pancode/turn`. */
	replayDetails?: Turn["details"];
	/** The replayed turn's recorded usage, which PanCode attaches to its last frame. */
	replayUsage?: Turn["usage"];
	closing: boolean;
	bound: boolean;
	permissions?: Permissions;
	interviews?: Interviews;
	eventSequence: number;
	/** The newest readouts frame applied. The sequence is per connection, and each child gets a new entry. */
	readoutsSequence?: number;
	/** A readouts frame that came before the session's id was bound, applied once it is. */
	readoutsEarly?: Static<typeof AcpReadoutsNotification>;
	prompt?: Promise<void>;
	retired?: Promise<void>;
	/**
	 * A branch change in flight. Its replay arrives before its response: a fork's
	 * or a handoff's under the new session's id, which moves this child to that
	 * id, and a switch's under the same id, after the old transcript is cleared.
	 */
	rebase?: { mode: "move"; moved: boolean } | { mode: "switch"; reset: boolean };
	/** A handoff document is being drawn up; a request now would make it describe a moving session. */
	drafting?: boolean;
	/** Context commands run outside the conversation; they still own its context while pending. */
	contextCommand?: Promise<Static<typeof CommandResult>>;
	/** The turn is recorded and waits for a slot: `admit` sends it to the agent, `drop` gives it up. */
	queued?: { admit(): void; drop(): void };
	/** When a request, a turn or a window last touched this child, on the monotonic clock. */
	activeAt: number;
	/** Unknown ownership is not safe to park; reads must not replace a newer queue push. */
	queueEmpty: boolean | null;
	queueVersion: number;
	/** A resume loads a transcript the kept snapshot already holds, so its replay is not projected again. */
	resuming?: boolean;
	/** Retired for idleness: the snapshot stays and reads `parked` once the child is gone. */
	parking?: boolean;
	/** The job whose scheduled turn is this entry's open turn. No `session/prompt` brackets it; `job.changed` does. */
	scheduled?: string;
	/** Job changes held back because they only moved a counter or a clock, newest per job, and when each job last published. */
	jobPending?: Map<string, AcpJob>;
	jobPublished?: Map<string, number>;
	jobTimer?: ReturnType<typeof setTimeout>;
	workers?: SessionWorkers;
	/** When a stop of the running turn went unconfirmed; a second stop of that turn forces it. */
	stopUnconfirmedAt?: number;
	/** Frames dropped in the running turn, and the fault classes already reported to the task. */
	droppedFrames?: number;
	frameFaults?: Set<string>;
	/** The newest child stderr, kept only in memory for the crash notice. */
	stderrTail?: string;
	/** The child's transport closed without this server asking. */
	crashed?: boolean;
};
