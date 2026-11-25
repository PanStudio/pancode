// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Workspace snapshots over ACP: the store a bound session reads, and the
 * bounded rows its list, preview and restore methods return.
 */

import { pancodeStateDir } from "../../core/xdg.js";
import type { RewindKept, RewindRef } from "../../domains/workspace-snapshots/index.js";
import { createWorkspaceSnapshots } from "../../domains/workspace-snapshots/index.js";
import { AcpRequestError } from "./errors.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import { ACP_SNAPSHOT_PATH_LIST_MAX } from "./types-session.js";

// Workspace snapshots: the files the engine saved before it changed them, listed, previewed and restored as the
// terminal's /rewind does. The store is keyed by the session id and the bound workspace, as the orchestrator keys it.
export const snapshotStore = (options: PancodeAcpServerOptions, bound: AcpServerSession) => {
	if (options.session === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return createWorkspaceSnapshots({ stateDir: pancodeStateDir(), sessionId: bound.id, cwd: bound.cwd });
};

export const snapshotN = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new AcpRequestError(-32602, "n must be a positive integer", { code: "invalid_params" });
	return value;
};

export const clipSnapshotText = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const snapshotPaths = (paths: ReadonlyArray<string>) => ({
	rows: paths.slice(0, ACP_SNAPSHOT_PATH_LIST_MAX).map((path) => clipSnapshotText(path, 4096)),
	cut: paths.length > ACP_SNAPSHOT_PATH_LIST_MAX,
});

export const snapshotKept = (rows: ReadonlyArray<RewindKept>) => ({
	rows: rows
		.slice(0, ACP_SNAPSHOT_PATH_LIST_MAX)
		.map((row) => ({ path: clipSnapshotText(row.path, 4096), why: clipSnapshotText(row.why, 512) })),
	cut: rows.length > ACP_SNAPSHOT_PATH_LIST_MAX,
});

export const snapshotRefs = (refs: ReadonlyArray<RewindRef>) =>
	refs.slice(0, 64).map((ref) => ({
		kind: ref.pin.kind,
		label: clipSnapshotText(
			ref.pin.kind === "head"
				? (ref.pin.branch ?? "HEAD")
				: ref.pin.kind === "stash"
					? `stash@{${ref.pin.index}}: ${ref.pin.message}`
					: ref.pin.name,
			512,
		),
		state: ref.state,
		recover: ref.recover === null ? null : clipSnapshotText(ref.recover, 1024),
	}));

export const snapshotFailure = (error: unknown): never => {
	if (error instanceof AcpRequestError) throw error;
	throw new AcpRequestError(-32603, "workspace snapshots could not be read", { code: "internal_error" });
};
