// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The light per-run telemetry reader: one run's journal as the read model's `JournalSource`, for a caller that folds
 * run rows without the telemetry domain module. It reads what `loadRunCallsTelemetrySource`
 * (src/domains/session/telemetry-source.ts) reads for a run, through the same state boundary and the same unknown
 * coverage on an unreadable journal, but its static closure holds only the journal reader, the paths and the read
 * model, never `./index.ts` and the extension graph behind it, so `fleet status` over ledger rows stays a leaf path.
 */

import { assertSafeId } from "../../core/safe-id.js";
import { withinStateRoot } from "../../core/state-boundary.js";
import { readCallJournalSync } from "./call-journal.js";
import { telemetryJournalPath, telemetryRunDirectory, telemetrySessionDirectory } from "./paths.js";
import { type JournalSource, journalSourceFromRead, withSettledCalls } from "./read-model-sources.js";

/** A journal directory that is a symlink or leaves the state root reads as an absent journal (#434). */
function readRunJournalSource(stateDir: string, runId: string): JournalSource {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	try {
		const read = withinStateRoot(stateDir, directory)
			? readCallJournalSync(directory)
			: { records: [], skipped: 0, damaged: 0 };
		return journalSourceFromRead(read, withinStateRoot(stateDir, telemetryJournalPath(directory)), runId);
	} catch {
		// An unreadable run journal stays visible as unknown coverage (#434).
		return { present: false, records: [], modes: [], skipped: 1, damaged: 0 };
	}
}

/**
 * The run journal with the calls its session journal holds for it, as `loadRunCallsTelemetrySource` reads it: a main
 * run's calls carry its session's context, so without them its journal is one settled aggregate (fleet finding 2).
 */
export function readRunCallsJournalSource(stateDir: string, runId: string): JournalSource {
	const run = readRunJournalSource(stateDir, runId);
	const sessionId = run.records.find((record) => record.k === "run.settled")?.ctx.sessionId;
	if (!sessionId) return run;
	try {
		assertSafeId(sessionId, "session");
		const directory = telemetrySessionDirectory(stateDir, sessionId);
		if (!withinStateRoot(stateDir, directory)) return run;
		return withSettledCalls(
			run,
			journalSourceFromRead(readCallJournalSync(directory), withinStateRoot(stateDir, telemetryJournalPath(directory))),
		);
	} catch {
		// An unreadable session journal leaves the run its settled aggregate (#434).
		return run;
	}
}
