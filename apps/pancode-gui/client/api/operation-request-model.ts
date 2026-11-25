// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Operation } from "../../contracts/operations.js";

export type RequestIntent = Readonly<{
	workspaceId: string;
	resourceId: string;
	action: string;
}>;
export type TrackedRequest = RequestIntent &
	Readonly<{
		key: string;
		epoch: string | null;
		operationId: string | null;
		settled: boolean;
	}>;
/**
 * The caches a finished operation makes stale. A connection check changes no setting, and its result already
 * carries the reading it took; a list read afterwards starts a new engine that has not checked anything, so
 * refetching the connections would replace "reachable" with "unknown".
 */
export function finishedOperationInvalidations(kind: string): readonly string[] {
	if (kind.startsWith("evidence.")) return ["evidence", "evidence-detail", "fleet-run-record"];
	if (kind === "targets.probe") return [];
	if (kind.startsWith("targets.")) return ["targets", "routing", "settings-report", "config-graph", "settings-controls"];
	return [];
}
export function terminalOperation(operation: Operation) {
	return operation.status !== "queued" && operation.status !== "running";
}
export function changedRequestEpoch(request: TrackedRequest | null, epoch: string | undefined) {
	return request?.epoch != null && epoch !== undefined && request.epoch !== epoch;
}
export function createRequestStore() {
	let state: { request: TrackedRequest | null; sending: boolean; error: string | null } = {
		request: null,
		sending: false,
		error: null,
	};
	const listeners = new Set<() => void>();
	const update = (next: typeof state) => {
		state = next;
		for (const listener of listeners) listener();
	};
	return {
		read: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		begin: (intent: RequestIntent, key: string) => {
			if (state.sending || (state.request && !state.request.settled)) return null;
			const request: TrackedRequest = { ...intent, key, epoch: null, operationId: null, settled: false };
			update({ request, sending: false, error: null });
			return request;
		},
		sending: (key: string) => {
			if (state.sending || state.request?.key !== key || state.request.operationId || state.request.settled) return false;
			update({ ...state, sending: true, error: null });
			return true;
		},
		patch: (key: string, patch: Partial<Pick<TrackedRequest, "epoch" | "operationId" | "settled">>) => {
			if (state.request?.key !== key) return;
			update({ ...state, request: { ...state.request, ...patch } });
		},
		finish: (key: string, error: string | null) => {
			if (state.request?.key !== key) return;
			update({ ...state, sending: false, error });
		},
		forget: () => {
			if (!state.sending) update({ request: null, sending: false, error: null });
		},
	};
}
