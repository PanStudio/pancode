// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes } from "node:crypto";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { AbortReason } from "../domains/dispatch/contract.js";
import type { DispatchRunEventRegistry } from "./dispatch-run-events.js";
import type { DispatchToolDeps } from "./dispatch-types.js";

/** The canceled tool call owns the dispatch; no operator command reached the run itself (#425). */
export const PARENT_CANCEL: AbortReason = { cause: "parent", detail: "parent tool call cancelled" };

export type RegisteredDispatchToolDeps = DispatchToolDeps & { runEvents: DispatchRunEventRegistry };

export function fallbackProgressBus(deps: DispatchToolDeps): TelemetryHub | undefined {
	return deps.dispatch.ownsProgressBus?.(deps.bus) === true ? undefined : deps.bus;
}

export function newGateGroupId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
