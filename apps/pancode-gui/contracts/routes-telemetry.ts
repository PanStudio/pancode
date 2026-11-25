// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { Id } from "./common.js";
import { defineRoute, get, operationParams } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";
import {
	TelemetryCache,
	TelemetryCalls,
	TelemetryCallsQuery,
	TelemetryCost,
	TelemetryCostQuery,
	TelemetryExplainQuery,
	TelemetryExplanation,
	TelemetryMetrics,
	TelemetryRangeQuery,
	TelemetryRun,
	TelemetryRuns,
	TelemetryRunsQuery,
	TelemetryRunTimeline,
	TelemetrySession,
	TelemetrySessionMetrics,
	TelemetryTimeline,
	TelemetryWhyStopped,
} from "./telemetry.js";
import { TraceParams, TraceRun, TraceRunRecord, TraceRunsPage, TraceRunsQuery } from "./traces.js";

/** Session and operator metrics. */
export const telemetryMetricRoutes = {
	telemetrySessionMetrics: defineRoute({
		...get,
		params: operationParams,
		response: TelemetrySessionMetrics,
		summary: "Recorded session and worker tool reliability, latency, cache share and compaction measurements.",
		...runtimeRoutes.telemetrySessionMetrics,
	}),
	telemetryMetrics: defineRoute({
		...get,
		query: Type.Object({ workspace: Type.Optional(Id) }, { additionalProperties: false }),
		response: TelemetryMetrics,
		summary: "Operator metrics over the retained 30-day journal window, optionally scoped to a workspace.",
		...runtimeRoutes.telemetryMetrics,
	}),
};

/** Trace runs and the telemetry readouts for sessions and runs. */
export const telemetryRoutes = {
	traceRuns: defineRoute({
		...get,
		query: TraceRunsQuery,
		response: TraceRunsPage,
		summary: "Run journals newest write first, joined to the dispatch ledger's identity",
		...runtimeRoutes.traceRuns,
	}),
	traceRun: defineRoute({
		...get,
		params: TraceParams,
		response: TraceRun,
		summary: "One run's journal row and ledger identity",
		...runtimeRoutes.traceRun,
	}),
	traceRunRecord: defineRoute({
		...get,
		params: TraceParams,
		query: Type.Object({ include: Type.Optional(Type.Literal("full")) }, { additionalProperties: false }),
		response: TraceRunRecord,
		summary: "Run record evidence checked against its seal; the saved document on request",
		...runtimeRoutes.traceRunRecord,
	}),
	telemetrySession: defineRoute({
		...get,
		params: operationParams,
		response: TelemetrySession,
		summary:
			"Session telemetry from the call journal: counts, tokens, cost, runs and lineage, each with its fact and reference",
		...runtimeRoutes.telemetrySession,
	}),
	telemetryCalls: defineRoute({
		...get,
		params: operationParams,
		query: TelemetryCallsQuery,
		response: TelemetryCalls,
		summary: "The session's provider calls, one row per attempt, filtered by label, disposition, turn, run or time",
		...runtimeRoutes.telemetryCalls,
	}),
	telemetryCost: defineRoute({
		...get,
		params: operationParams,
		query: TelemetryCostQuery,
		response: TelemetryCost,
		summary: "Session cost grouped by label, model or turn",
		...runtimeRoutes.telemetryCost,
	}),
	telemetryCache: defineRoute({
		...get,
		params: operationParams,
		response: TelemetryCache,
		summary: "Prompt-cache verdicts, breaks by cause, re-prefilled tokens and the cache-break bill",
		...runtimeRoutes.telemetryCache,
	}),
	telemetryTimeline: defineRoute({
		...get,
		params: operationParams,
		query: TelemetryRangeQuery,
		response: TelemetryTimeline,
		summary:
			"Every journaled kind in time order: calls with stage offsets, turns, runs, tools, settings, budget, quota, context and gaps",
		...runtimeRoutes.telemetryTimeline,
	}),
	telemetryWhyStopped: defineRoute({
		...get,
		params: operationParams,
		response: TelemetryWhyStopped,
		summary: "Why the session stopped, slowed or got expensive, from journal facts alone",
		...runtimeRoutes.telemetryWhyStopped,
	}),
	telemetryRuns: defineRoute({
		...get,
		query: TelemetryRunsQuery,
		response: TelemetryRuns,
		summary: "Worker run journals newest write first, each as its read-model row",
		...runtimeRoutes.telemetryRuns,
	}),
	telemetryRun: defineRoute({
		...get,
		params: Type.Object({ runId: Id }, { additionalProperties: false }),
		response: TelemetryRun,
		summary: "One run's telemetry: its row, journal coverage, counts, tokens and settlement",
		...runtimeRoutes.telemetryRun,
	}),
	telemetryRunTimeline: defineRoute({
		...get,
		params: Type.Object({ runId: Id }, { additionalProperties: false }),
		response: TelemetryRunTimeline,
		summary: "One run journal in time order: calls with stages, the run feed, the worker process and the settlement",
		...runtimeRoutes.telemetryRunTimeline,
	}),
	telemetryRunCost: defineRoute({
		...get,
		params: Type.Object({ runId: Id }, { additionalProperties: false }),
		response: TelemetryCost,
		summary: "One run journal's calls, tokens and cost by the model each call settled on, each with its reference",
		...runtimeRoutes.telemetryRunCost,
	}),
	telemetryExplain: defineRoute({
		...get,
		query: TelemetryExplainQuery,
		response: TelemetryExplanation,
		summary: "The fold rule, value and contributing calls behind one quantity's reference",
		...runtimeRoutes.telemetryExplain,
	}),
};
