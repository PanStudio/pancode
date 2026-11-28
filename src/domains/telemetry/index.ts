// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The read boundary every telemetry reader opens its paths through, for surfaces that report a store present (#434). */
export { withinStateRoot } from "../../core/state-boundary.js";
export type { AccountabilitySummary } from "./accountability.js";
export { summarizeRunAccountability } from "./accountability.js";
export type {
	TelemetryContract,
	TelemetryRunReaderBinder,
	TelemetrySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
export { foldDecisions } from "./fact-folds.js";
export { publishGateDecision } from "./gate-publication.js";
export { readTaskMemorySpendSummary } from "./memory-spend.js";
export {
	isTelemetryJournalFile,
	telemetryBundlePath,
	telemetryInstallPath,
	telemetryJournalFiles,
	telemetryJournalPath,
	telemetryProcessDirectory,
	telemetryProcessesDirectory,
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "./paths.js";
export { explain, READ_MODEL_FOLD } from "./read-model.js";
export { cacheReport } from "./read-model-cache.js";
export { costReport, runCostReport } from "./read-model-cost.js";
export { callsReport, sessionTelemetry } from "./read-model-reports.js";
export { type EnqueuedRun, runRowTelemetry, runTelemetry } from "./read-model-runs.js";
export {
	emptyTaskMemorySpendSummary,
	type TaskMemorySpendSummary,
} from "./read-model-side-surfaces.js";
export { runTimeline, timeline } from "./read-model-timeline.js";
export { sessionOperatorMetrics, usageReport } from "./read-model-usage.js";
export { whyStopped } from "./read-model-why-stopped.js";
export type { JournaledContent } from "./research-content.js";
export { readJournaledContent } from "./research-content.js";
export type { RetentionPruners } from "./retention.js";
export type {
	RouteHistoryEntry,
	RouteHistoryFold,
	SettledRunFacts,
} from "./route-history.js";
export { createRouteHistoryFold, routeSettledLabel } from "./route-history.js";
export type { SettledRunRecord } from "./run-record.js";
export {
	readRunJournalRecords,
	readRunRecord,
	readRunRecordAsync,
	readSettledRun,
	readVerifiedRun,
} from "./run-record.js";
export { readSessionContextSnapshots, readSessionPromptCompiles } from "./session-artifacts.js";
export {
	freshShareSource,
	packShare,
	planShare,
	resolveShareScopes,
	verifyShareArchive,
} from "./share.js";
export { packTelemetryArchive, type ShareArchiveEntry, unpackTelemetryArchive } from "./share-archive.js";
export { carriesPath, isBuiltinRuntimeId, RUNTIME_VOCABULARY } from "./share-projection.js";
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
export { emptyUsageDiagnostics, explainRepoRef, isRepoRef, usageReportWindow, usageWindow } from "./usage-window.js";
