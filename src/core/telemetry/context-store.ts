// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { AsyncLocalStorage } from "node:async_hooks";
import type { TelemetryContext } from "./context.js";

/**
 * The async telemetry context on its own, without the context schemas, so a launch seam on a pre-boot path can
 * capture its call's context without loading typebox.
 */
export const telemetryContexts = new AsyncLocalStorage<TelemetryContext>();

export function telemetryContext(): TelemetryContext | undefined {
	return telemetryContexts.getStore();
}
