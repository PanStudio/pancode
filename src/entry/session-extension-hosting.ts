// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type OperatorReloadSummary, operatorReloadSummary } from "../domains/extensions/operator-extensions.js";
import type { ExtensionHost } from "./extension-host.js";
import type { ExtensionReloadOutcome } from "./extension-reload.js";

export interface SessionExtensionHostingDeps {
	/** Null when no installed extension has a runtime to host. */
	start(): Promise<ExtensionHost | null>;
	/** Publish the next hook generation; the runtimes restart on it. */
	commit(): ExtensionReloadOutcome;
	idle(): boolean;
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
	/** The extensions step of `/reload`, which waits for the runtimes and is refused while a turn runs. */
	reloadStep(): Promise<OperatorReloadSummary>;
	dispose(): Promise<void>;
}

const refused = (message: string): OperatorReloadSummary => ({
	status: "rejected",
	message,
	failures: [],
	nextSession: [],
});

export function createSessionExtensionHosting(deps: SessionExtensionHostingDeps): SessionExtensionHosting {
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
			if (!deps.idle()) return refused("a turn is running; /reload extensions applies between turns");
			const outcome = deps.commit();
			if (outcome.status !== "committed") return refused(`hook generation rejected: ${outcome.reason}`);
			const running = current;
			const host = running ?? (await ensure());
			if (!host)
				return { status: "committed", message: "no installed extension has a runtime", failures: [], nextSession: [] };
			return operatorReloadSummary(running ? await host.restart() : await host.ready, host.operator);
		},
		async dispose() {
			await starting?.catch(() => undefined);
			await current?.dispose();
		},
	};
}
