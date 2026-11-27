// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What one runtime request owns in the host services. When the request ends its signal aborts and its cleanups run
 * newest first, so a run started in a worktree has settled before that worktree is removed.
 */
export interface ExtensionRequestScope {
	readonly signal: AbortSignal;
	defer(cleanup: () => unknown): void;
}

export interface OwnedExtensionRequestScope extends ExtensionRequestScope {
	/** Abort, then run every cleanup newest first; a failing cleanup does not stop the rest. */
	end(): Promise<void>;
}

export function createExtensionRequestScope(): OwnedExtensionRequestScope {
	const controller = new AbortController();
	const cleanups: Array<() => unknown> = [];
	let ending: Promise<void> | null = null;
	return {
		signal: controller.signal,
		defer(cleanup) {
			if (ending !== null) {
				void Promise.resolve()
					.then(cleanup)
					.catch(() => undefined);
				return;
			}
			cleanups.push(cleanup);
		},
		end() {
			ending ??= (async () => {
				controller.abort();
				while (cleanups.length > 0) {
					const cleanup = cleanups.pop() as () => unknown;
					try {
						await cleanup();
					} catch {
						// One owned resource failing to go does not keep the others alive.
					}
				}
			})();
			return ending;
		},
	};
}
