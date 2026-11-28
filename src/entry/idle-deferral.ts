// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { TelemetryHub } from "../core/telemetry/hub.js";

const RETRY_MS = 250;

interface IdleDeferral {
	/**
	 * Run `attempt` once the session is idle, after each settled turn and on a short retry. It returns false to be
	 * tried again; a throw drops it. A later call replaces a waiting attempt.
	 */
	defer(attempt: () => Promise<boolean>): void;
	/** Drop a waiting attempt, because the work ran at once after all. */
	cancel(): void;
}

/** A reload class that cannot run during a turn waits here, and reports what it did when it runs. */
export function createIdleDeferral(bus: Pick<TelemetryHub, "subscribe">, idle: () => boolean): IdleDeferral {
	let waiting: (() => void) | null = null;
	return {
		defer(attempt) {
			waiting?.();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let trying = false;
			const stop = (): void => {
				clearTimeout(timer);
				unsubscribe();
				if (waiting === stop) waiting = null;
			};
			const run = async (): Promise<void> => {
				if (trying || waiting !== stop) return;
				trying = true;
				try {
					if (idle() && (await attempt())) stop();
				} catch {
					stop();
				} finally {
					trying = false;
					if (waiting === stop) schedule();
				}
			};
			const schedule = (): void => {
				clearTimeout(timer);
				timer = setTimeout(() => void run(), RETRY_MS);
				timer.unref?.();
			};
			const unsubscribe = bus.subscribe("turn.settled", () => void run());
			waiting = stop;
			schedule();
		},
		cancel() {
			waiting?.();
		},
	};
}
