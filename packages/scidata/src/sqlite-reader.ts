// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DataRefusal, DataViewFlags } from "./shared.js";

/**
 * The SQLite result shapes and the reader contract. The package carries no
 * SQLite reader of its own: a safe one runs each statement in a child process
 * the host can kill, and how a host spawns processes is the host's policy. A
 * host passes its reader as `sqlite`; without one a SQLite request is refused
 * as `reader-unavailable`.
 */

type Cell = unknown;

export interface SqliteColumn {
	name: string;
	type: string | null;
	notNull: boolean;
	default: string | null;
	primaryKey: number;
	/** 0 ordinary, 1 hidden virtual-table column, 2 or 3 generated column. */
	hidden: number;
}

export interface SqliteObject {
	type: string;
	name: string;
	table: string;
	sql: string | null;
}

export interface SqliteInspectResult {
	ok: true;
	format: "sqlite";
	path: string;
	bytes: number;
	view: DataViewFlags;
	/** Opened with immutable=1 because a plain read-only open failed; an uncheckpointed WAL is not seen. */
	immutable: boolean;
	objects: SqliteObject[];
	objectsTruncated: boolean;
	tables: Array<{ name: string; type: string; columns: SqliteColumn[] }>;
	/** Present when `table` was named: bounded row count and a sample. */
	table?: {
		name: string;
		/** Exact row count, or null when it exceeds rowsCounted. */
		rowCount: number | null;
		rowsCounted: number;
		columns: Array<{ name: string; type: string | null }>;
		sample: Cell[][];
	};
	notes: string[];
}

export interface SqliteSelectResult {
	ok: true;
	format: "sqlite";
	path: string;
	bytes: number;
	view: DataViewFlags;
	immutable: boolean;
	sql: string;
	columns: Array<{ name: string; type: string | null }>;
	offset: number;
	limit: number;
	returned: number;
	hasMore: boolean;
	/** Rows as arrays aligned with `columns`; placeholders mark cut text, blobs, and unsafe integers. */
	rows: Cell[][];
	notes: string[];
}

export interface SqliteInspectOptions {
	table?: string;
	sampleRows?: number;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export interface SqliteSelectOptions {
	sql?: string;
	table?: string;
	columns?: ReadonlyArray<string | number>;
	offset?: number;
	limit?: number;
	signal?: AbortSignal | undefined;
}

/** A read-only SQLite reader; `bytes` is the database file's size, already stat'ed by the caller. */
export interface SqliteReader {
	inspect(path: string, bytes: number, options: SqliteInspectOptions): Promise<SqliteInspectResult | DataRefusal>;
	select(path: string, bytes: number, options: SqliteSelectOptions): Promise<SqliteSelectResult | DataRefusal>;
}
