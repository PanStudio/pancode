// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/runtime-routes.js";
import { type Client, emptyInput } from "./client.js";

export function useOperation(client: Client, id: string | null) {
	const queries = useQueryClient();
	return useQuery({
		queryKey: ["operation", id],
		enabled: id !== null,
		retry: false,
		queryFn: async () => {
			const result = await client.call(routes.operation, { params: { id: id ?? "" }, query: {}, body: {} });
			const current = queries.getQueryData<Operation>(["operation", id]);
			return current && current.revision > result.revision ? current : result;
		},
	});
}

/**
 * The saved-task list costs the server an agent process per read and changes only when a task is renamed, closed or
 * deleted, each of which invalidates it. An unsupported answer is final too, so a mount does not retry it.
 */
export const SESSION_HISTORY_FRESHNESS = {
	staleTime: 5 * 60_000,
	refetchOnWindowFocus: false,
	retry: false,
	retryOnMount: false,
} as const;

/** Reads a task switch would repeat; each is asked of the agent and changes only through events that invalidate it. */
export const SWITCH_FRESHNESS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

/*
 * One definition per shared read. Every observer of a key shares one query, and the options of the observer that
 * last rendered replace the others', so a copied key with a different function or freshness changed what the next
 * read did depending on which component mounted last. Callers add only what is theirs: `enabled`, `meta`, `retry`.
 * None consumes the abort signal: TanStack aborts a read that did once its last observer leaves, and a key that moves
 * with settled turns would fail the read in flight (see sessionUsageQuery).
 */
function sessionInput(id: string) {
	return { params: { id }, query: {}, body: {} };
}

export function workspacesQuery(client: Client) {
	return queryOptions({
		queryKey: ["workspaces"],
		queryFn: () => client.call(routes.workspaces, emptyInput),
	});
}

export function metaQuery(client: Client) {
	return queryOptions({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
	});
}

/**
 * The server's identity read for an explicit request. A restart loses the server's idempotency records, so a caller
 * compares this epoch with the one its request was first sent under; each caller decides what a missing one means.
 */
export async function freshMeta(client: Client, queries: QueryClient, signal?: AbortSignal) {
	const meta = await client.call(routes.meta, emptyInput, undefined, signal);
	queries.setQueryData(metaQuery(client).queryKey, meta);
	return meta;
}

export function systemQuery(client: Client) {
	return queryOptions({
		queryKey: ["system"],
		queryFn: () => client.call(routes.system, emptyInput),
	});
}

/** What the task's agent supports, read once per task. */
export function sessionCapabilitiesQuery(client: Client, id: string) {
	return queryOptions({
		queryKey: ["session-capabilities", id],
		queryFn: () => client.call(routes.sessionCapabilities, sessionInput(id)),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function sessionCommandsQuery(client: Client, id: string) {
	return queryOptions({
		queryKey: ["session-commands", id],
		queryFn: () => client.call(routes.sessionCommands, sessionInput(id)),
		staleTime: 30_000,
		retry: false,
	});
}

export function sessionHistoryQuery(client: Client, workspaceId: string) {
	return queryOptions({
		queryKey: ["session-history", workspaceId],
		queryFn: () => client.call(routes.sessionHistory, sessionInput(workspaceId)),
		...SESSION_HISTORY_FRESHNESS,
	});
}

/** Keyed by settled turns: the next settled turn is the next read, and the last answer stays until it lands. */
export function sessionBoardQuery(client: Client, id: string, settledTurns: number) {
	return queryOptions({
		queryKey: ["session-board", id, settledTurns],
		queryFn: () => client.call(routes.sessionBoard, sessionInput(id)),
		retry: false,
		placeholderData: (previous) => previous,
	});
}

export function sessionTreeQuery(client: Client, id: string, settledTurns: number) {
	return queryOptions({
		queryKey: ["session-tree", id, settledTurns],
		queryFn: () => client.call(routes.sessionTree, sessionInput(id)),
		retry: false,
		placeholderData: (previous) => previous,
	});
}

/** A project's connections layered on the user's; no project (null or "") is the user's own list. */
export function targetsQuery(client: Client, workspaceId: string | null) {
	return queryOptions({
		queryKey: ["targets", workspaceId ?? ""],
		queryFn: () =>
			workspaceId
				? client.call(routes.targetsList, sessionInput(workspaceId))
				: client.call(routes.userTargetsList, emptyInput),
	});
}
