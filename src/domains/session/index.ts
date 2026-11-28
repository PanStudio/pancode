// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export {
	parseSessionEntries,
	readSessionEntriesForId,
} from "./archive-readers.js";
// Durable continuity (CONTRACTS §§2-8). Only the consumer-facing half surfaces
// here: the record and fold contracts, the reader-side projection, the operator
// control carrier and the persistence binding. The pure fold, its validators
// and the group persister stay reachable through their own modules, because the
// packets that use them are inside this domain or hold an explicit grant.
export type {
	SessionContract,
	SessionEntryInput,
	SessionMeta,
} from "./contract.js";
export type {
	MessageEntry,
	SessionEntry,
	WorkerRunEntry,
	WorkerRunOrigin,
	WorkerRunRuntime,
	WorkerRunRuntimeKind,
} from "./entries.js";
export { isSessionEntry, isSessionHeader } from "./entries.js";
export { runHeadlessCompaction } from "./headless-compact.js";
export { liveSessionView } from "./heartbeat.js";
export { SessionLiveError, sessionLiveOwner } from "./live-owner.js";
export { projectMessage } from "./message-projection.js";
export type { RecallTelemetry } from "./recall-telemetry.js";
export { foldRecallTelemetry, formatRecallTelemetry, hasRecallTelemetry } from "./recall-telemetry.js";
export type { TaskBoardSnapshot } from "./task-board.js";
export { foldTaskBoard, taskBoardCounts } from "./task-board.js";
export type { RunListCursor } from "./telemetry-source.js";
export {
	listRunTelemetryIds,
	listRunTelemetrySources,
	loadRunCallsTelemetrySource,
	loadRunScopeFiles,
	loadRunTelemetrySource,
	loadSessionTelemetrySource,
	loadSessionTelemetrySourceAsync,
	runTelemetryDirectoryExists,
	runTelemetryWrittenMs,
} from "./telemetry-source.js";
export { renderTranscriptMarkdown } from "./transcript-export.js";
export { filterEntriesToActivePath } from "./tree/active-path.js";
export { readTreeBundle } from "./tree/manager.js";
// The tree/ module is a domain-internal building block. Only the
// overlay-facing types surface here; callers that need deeper helpers import
// from the concrete submodules directly (session domain only).
export type { SessionUsageDefaults } from "./usage.js";
