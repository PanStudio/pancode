// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { TelemetryHub } from "../core/telemetry/hub.js";
import { type OperatorReloadSummary, operatorReloadSummary } from "../domains/extensions/operator-extensions.js";
import type { ExtensionHost } from "./extension-host.js";
import type { ExtensionReloadOutcome } from "./extension-reload.js";
import { createIdleDeferral } from "./idle-deferral.js";

export interface SessionExtensionHostingDeps {
	/** Null when no installed extension has a runtime to host. */
	start(): Promise<ExtensionHost | null>;
	/** Publish the next hook generation; the runtimes restart on it. */
	commit(): ExtensionReloadOutcome;
	idle(): boolean;
	/** A reload asked for during a turn waits for `turn.settled` and reports as a `reload.applied` notice. */
	bus: Pick<TelemetryHub, "subscribe" | "emit">;
	/** A background start that failed. */
	report(message: string): void;
}

/**
 * The api 2 runtime host of a headless run or an ACP session. The TUI hosts its own runtimes, whose reload commits
 * the hooks itself; here the hooks commit first and the runtimes restart on that generation.
 */
export interface SessionExtensionHosting {
	readonly current: ExtensionHost | null;
	/** The running host, or one started now; a session that booted with nothing to host gets one once there is. */
	ensure(): Promise<ExtensionHost | null>;
	/** `_pancode/extensions/reload`: the commit answers at once and the runtimes follow in the background. */
	reload(): ExtensionReloadOutcome;
	/** The extensions step of `/reload`, which waits for the runtimes; during a turn it defers until the turn settles. */
	reloadStep(): Promise<OperatorReloadSummary>;
	dispose(): Promise<void>;
}

const refused = (message: string): OperatorReloadSummary => ({
	status: "rejected",
	message,
	failures: [],
	nextSession: [],
});

/** The deferred step's notice is one line, because the ACP relay folds a multi-line notice. */
function appliedText(summary: OperatorReloadSummary): string {
	const issues =
		summary.failures.length === 0 ? "failed: none" : summary.failures.map((issue) => `issue: ${issue}`).join("; ");
	return `Extensions reloaded after the turn settled: ${summary.status}: ${summary.message.replace(/\.$/, "")}; ${issues}`;
}

export function createSessionExtensionHosting(deps: SessionExtensionHostingDeps): SessionExtensionHosting {
	const deferral = createIdleDeferral(deps.bus, deps.idle);
	let current: ExtensionHost | null = null;
	let starting: Promise<ExtensionHost | null> | undefined;
	const ensure = (): Promise<ExtensionHost | null> => {
		if (current) return Promise.resolve(current);
		starting ??= deps
			.start()
			.then((host) => {
				current = host;
				return host;
			})
			.finally(() => {
				starting = undefined;
			});
		return starting;
	};
	const apply = async (): Promise<OperatorReloadSummary> => {
		const outcome = deps.commit();
		if (outcome.status !== "committed") return refused(`hook generation rejected: ${outcome.reason}`);
		const running = current;
		const host = running ?? (await ensure());
		if (!host)
			return { status: "committed", message: "no installed extension has a runtime", failures: [], nextSession: [] };
		return operatorReloadSummary(running ? await host.restart() : await host.ready, host.operator);
	};
	return {
		get current() {
			return current;
		},
		ensure,
		reload() {
			const outcome = deps.commit();
			if (outcome.status !== "committed") return outcome;
			if (current) void current.restart();
			else
				ensure().catch((error: unknown) =>
					deps.report(`extension host failed to start: ${error instanceof Error ? error.message : String(error)}`),
				);
			return outcome;
		},
		async reloadStep() {
			if (!deps.idle()) {
				deferral.defer(async () => {
					const summary = await apply();
					deps.bus.emit("reload.applied", {
						target: "extensions",
						text: appliedText(summary),
						failed: summary.status === "rejected" || summary.failures.length > 0,
					});
					return true;
				});
				return {
					status: "deferred",
					message: "a turn is running; the reload runs once it settles and reports then",
					failures: [],
					nextSession: [],
				};
			}
			deferral.cancel();
			return apply();
		},
		async dispose() {
			deferral.cancel();
			await starting?.catch(() => undefined);
			await current?.dispose();
		},
	};
}
