// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { TelemetryHub } from "../core/telemetry/hub.js";
import { type OperatorReloadSummary, operatorReloadSummary } from "../domains/extensions/operator-extensions.js";
import type { ExtensionHost } from "./extension-host.js";
import type { ExtensionReloadOutcome } from "./extension-reload.js";
import { createIdleDeferral } from "./idle-deferral.js";

interface SessionExtensionHostingDeps {
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
interface SessionExtensionHosting {
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
	let disposed = false;
	let deferralGen = 0;
	const cancelDeferral = (): void => {
		deferralGen += 1;
		deferral.cancel();
	};
	const ensure = (): Promise<ExtensionHost | null> => {
		if (disposed) return Promise.resolve(null);
		if (current) return Promise.resolve(current);
		starting ??= deps
			.start()
			.then(async (host) => {
				if (disposed) {
					await host?.dispose();
					return null;
				}
				current = host;
				return host;
			})
			.finally(() => {
				starting = undefined;
			});
		return starting;
	};
	const applyNow = async (): Promise<OperatorReloadSummary> => {
		if (disposed) return refused("session is closing");
		const outcome = deps.commit();
		if (outcome.status !== "committed") return refused(`hook generation rejected: ${outcome.reason}`);
		const running = current;
		const host = running ?? (await ensure());
		if (disposed) return refused("session is closing");
		if (!host)
			return { status: "committed", message: "no installed extension has a runtime", failures: [], nextSession: [] };
		return operatorReloadSummary(running ? await host.restart() : await host.ready, host.operator);
	};
	// A deferred reload still restarting the runtimes finishes before an immediate one commits.
	let applying: Promise<unknown> = Promise.resolve();
	const serialize = <T>(step: () => Promise<T>): Promise<T> => {
		const next = applying.then(step, step);
		applying = next.catch(() => undefined);
		return next;
	};
	const apply = (): Promise<OperatorReloadSummary> => serialize(applyNow);
	return {
		get current() {
			return current;
		},
		ensure,
		reload() {
			cancelDeferral();
			const outcome = deps.commit();
			if (outcome.status !== "committed" || disposed) return outcome;
			void serialize(async () => {
				if (disposed) return;
				if (current) await current.restart();
				else
					await ensure().catch((error: unknown) =>
						deps.report(`extension host failed to start: ${error instanceof Error ? error.message : String(error)}`),
					);
			});
			return outcome;
		},
		async reloadStep() {
			if (!deps.idle()) {
				const gen = ++deferralGen;
				deferral.defer(async () => {
					if (disposed || gen !== deferralGen) return true;
					try {
						const summary = await apply();
						if (disposed || gen !== deferralGen) return true;
						deps.bus.emit("reload.applied", {
							target: "extensions",
							text: appliedText(summary),
							failed: summary.status === "rejected" || summary.failures.length > 0,
						});
					} catch (error) {
						if (disposed || gen !== deferralGen) return true;
						deps.bus.emit("reload.applied", {
							target: "extensions",
							text: `Extensions reload failed after the turn settled: ${error instanceof Error ? error.message : String(error)}`,
							failed: true,
						});
					}
					return true;
				});
				return {
					status: "deferred",
					message: "a turn is running; the reload runs once it settles and reports then",
					failures: [],
					nextSession: [],
				};
			}
			cancelDeferral();
			return apply();
		},
		async dispose() {
			disposed = true;
			cancelDeferral();
			await applying;
			await starting?.catch(() => undefined);
			const host = current;
			current = null;
			await host?.dispose();
		},
	};
}
