// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A headless run has no notice renderer, so runtime notices (model swaps,
 * double residency, VRAM stress) and session notices go to stderr. Silent model
 * swaps are exactly the failure mode the residency policy forbids. Middleware
 * diagnostics already write their own stderr line.
 */
import type { TelemetryHub } from "../core/telemetry/hub.js";
import { subscribeSessionNotices } from "../session-control/session-notices.js";

export function writeHeadlessNoticesToStderr(bus: Pick<TelemetryHub, "subscribe">): () => void {
	const unsubscribeRuntime = bus.subscribe("runtime.notice_raised", (payload: unknown) => {
		const notice = payload as { level?: string; message?: string } | undefined;
		if (typeof notice?.message !== "string") return;
		process.stderr.write(`[pancode:runtime] ${notice.level ?? "info"}: ${notice.message}\n`);
	});
	const unsubscribeSession = subscribeSessionNotices(
		bus,
		(notice) => process.stderr.write(`[pancode:notice] ${notice.level}: ${notice.text}\n`),
		{ skip: ["middleware.hook_failed"] },
	);
	return () => {
		unsubscribeRuntime();
		unsubscribeSession();
	};
}
