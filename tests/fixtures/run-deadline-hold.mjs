// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Preloaded into a `pancode run --timeout` child under test. The budget counts from process start, so on a loaded host
 * boot alone can spend it before the run reaches the state the test means to time out. This holds the one timer
 * armRunTimeout arms, and nothing else: once due, it fires when the file RUN_DEADLINE_SIGNAL names exists, never
 * earlier than its own time. `<signal>.held` records that the hold engaged, so a test that relies on it can say so.
 */
import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const signal = process.env.RUN_DEADLINE_SIGNAL;
if (signal) {
	const arm = globalThis.setTimeout;
	const disarm = globalThis.clearTimeout;
	const waits = new Map();
	globalThis.setTimeout = function setTimeout(callback, delay, ...args) {
		if (typeof callback !== "function" || !new Error().stack?.includes("at armRunTimeout ")) {
			return arm(callback, delay, ...args);
		}
		globalThis.setTimeout = arm;
		writeFileSync(`${signal}.held`, "");
		const handle = arm(() => {
			let fired = false;
			const fire = () => {
				if (fired || !existsSync(signal)) return;
				fired = true;
				watcher.close();
				waits.delete(handle);
				callback(...args);
			};
			const watcher = watch(dirname(signal), fire);
			watcher.unref();
			waits.set(handle, watcher);
			fire();
		}, delay);
		return handle;
	};
	globalThis.clearTimeout = function clearTimeout(handle) {
		waits.get(handle)?.close();
		waits.delete(handle);
		disarm(handle);
	};
}
