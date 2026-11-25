// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawn } from "node:child_process";

/**
 * The index's SQLite runs in a child `node` process, never in this one, as the harness's `data` tool does
 * (`src/tools/data/sqlite.ts`): node:sqlite is synchronous with no interrupt, so a slow statement here would
 * stall the host, and `--disable-warning` keeps its ExperimentalWarning off every stream the host owns. The
 * child is killed on timeout. Any failure answers null and the caller scans the store instead.
 */

const INDEX_TIMEOUT_MS = 30_000;
const INDEX_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Bumped when the tables change; a database of another version is emptied and rebuilt. */
export const STORE_INDEX_SCHEMA_VERSION = 1;

export type IndexValue = string | number | null;
export type IndexRow = Record<string, IndexValue>;

/** One statement; `rows` runs it once per parameter list, `all` returns its rows. */
export interface IndexStatement {
	sql: string;
	params?: IndexValue[];
	rows?: IndexValue[][];
	all?: boolean;
}

/**
 * Plain JavaScript run verbatim under `node -e`. It reads one JSON request on stdin, runs the statements in one
 * transaction and writes one JSON line. A database it cannot open or read is deleted and made again once: the
 * index is a cache of the store and holds nothing the store does not.
 */
const CHILD_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const { mkdirSync, rmSync } = require("node:fs");
const { dirname } = require("node:path");
const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, trusted INTEGER NOT NULL, blobs_refusal TEXT, records_refusal TEXT)",
	"CREATE TABLE IF NOT EXISTS tags (ord INTEGER NOT NULL, tag TEXT PRIMARY KEY, xattrs TEXT)",
	"CREATE TABLE IF NOT EXISTS blobs (tag TEXT NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL, bytes INTEGER, mtime REAL, PRIMARY KEY (tag, ord))",
	"CREATE TABLE IF NOT EXISTS records (tag TEXT NOT NULL, name TEXT NOT NULL, blob TEXT, seq INTEGER, bytes INTEGER, mtime REAL, body TEXT, refusal TEXT, PRIMARY KEY (tag, name))",
	"CREATE INDEX IF NOT EXISTS records_by_blob ON records (tag, blob, seq)",
];
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
	const out = (v) => process.stdout.write(JSON.stringify(v));
	let req;
	try {
		req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (e) {
		out({ error: "bad request: " + e.message });
		return;
	}
	process.umask(0o077);
	const open = () => {
		mkdirSync(dirname(req.path), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(req.path);
		try {
			db.exec("PRAGMA busy_timeout = 10000");
			const version = db.prepare("PRAGMA user_version").get().user_version;
			if (version !== req.version) {
				db.exec("BEGIN IMMEDIATE");
				for (const t of ["scopes", "tags", "blobs", "records"]) db.exec("DROP TABLE IF EXISTS " + t);
				for (const s of SCHEMA) db.exec(s);
				db.exec("PRAGMA user_version = " + Number(req.version));
				db.exec("COMMIT");
			}
			return db;
		} catch (e) {
			// The open error is the one to report; a failed close of a database already in trouble adds nothing.
			try { db.close(); } catch {}
			throw e;
		}
	};
	const remove = () => {
		for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(req.path + suffix, { force: true });
	};
	let db;
	try {
		db = open();
	} catch {
		try {
			remove();
			db = open();
		} catch (e) {
			out({ error: e.message });
			return;
		}
	}
	try {
		db.exec(req.write ? "BEGIN IMMEDIATE" : "BEGIN");
		const results = [];
		for (const s of req.statements) {
			const st = db.prepare(s.sql);
			if (s.rows) {
				for (const r of s.rows) st.run(...r);
				results.push(null);
			} else if (s.all) {
				results.push(st.all(...(s.params || [])));
			} else {
				st.run(...(s.params || []));
				results.push(null);
			}
		}
		db.exec("COMMIT");
		out({ results });
	} catch (e) {
		// A failed statement may already have ended the transaction; nothing it wrote is kept either way.
		try { db.exec("ROLLBACK"); } catch {}
		out({ error: e.message });
	} finally {
		db.close();
	}
});
`;

/**
 * Run statements against the index database at `dbPath` in one transaction. The rows of each `all` statement come
 * back in order (null for the others); null overall when the child could not answer for any reason.
 */
export function runIndexStatements(
	dbPath: string,
	statements: ReadonlyArray<IndexStatement>,
	options: { write: boolean },
): Promise<Array<IndexRow[] | null> | null> {
	const request = JSON.stringify({
		path: dbPath,
		version: STORE_INDEX_SCHEMA_VERSION,
		write: options.write,
		statements,
	});
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (value: Array<IndexRow[] | null> | null) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", CHILD_SCRIPT], {
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			// No child process here: the caller scans the store.
			finish(null);
			return;
		}
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, INDEX_TIMEOUT_MS);
		const out: Buffer[] = [];
		let size = 0;
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > INDEX_MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				finish(null);
				return;
			}
			out.push(chunk);
		});
		child.on("error", () => finish(null));
		child.on("close", () => {
			try {
				const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as {
					results?: Array<IndexRow[] | null>;
					error?: string;
				};
				finish(parsed.error === undefined && Array.isArray(parsed.results) ? parsed.results : null);
			} catch {
				finish(null);
			}
		});
		// A child that died before reading its request answers null through close; this write error adds nothing.
		child.stdin?.on("error", () => {});
		child.stdin?.end(request);
	});
}
