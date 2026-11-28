// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Browser-safe ACP declarations share the wire contract without evaluating the process transport.

export * from "../../../../src/acp/types.js";
export * from "../../../../src/acp/types-capabilities.js";
export * from "../../../../src/acp/types-fleet.js";
export * from "../../../../src/acp/types-readouts.js";
export * from "../../../../src/acp/types-session.js";
export * from "../../../../src/acp/types-settings.js";
export * from "../../../../src/acp/types-tools.js";
export * from "../../../../src/acp/types-views.js";
export type {
	ContextOperation,
	ContextOperationFact,
	ContextOperationStatus,
} from "../../../../src/core/context-operation.js";
// The read-model DTO schemas reach the browser contract and openapi.json through this seam. dto.ts has a
// typebox-only value-import closure (id-schemas, enums, fact, schemas), so the client bundle carries no Node module.
export type {
	CacheReportV1,
	CallFilter,
	CostReportV1,
	ExplanationV1,
	Quantity,
	RunEvidenceV1,
	RunTelemetryV1,
	RunTimelineEntry,
	SessionTelemetryV1,
	TelemetryUpdateV1,
	TimelineEntry,
} from "../../../../src/core/telemetry/dto.js";
export {
	CallFilterSchema,
	FactRefSchema,
	parseFactRef,
	TELEMETRY_DTO_SCHEMAS,
} from "../../../../src/core/telemetry/dto.js";
export type { ContextActivityPayload } from "../../../../src/core/telemetry/live-events.js";
