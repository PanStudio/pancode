// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ClockOrigin, SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";

/**
 * The telemetry read model (#434 §11). Pure: callers hand it journal records (read from disk, or the live writer's
 * persisted batches) and get DTOs back. Every quantity in every DTO comes from {@link measure}, the same function
 * `explain` answers with, so a number and its explanation cannot drift apart, and every display string comes from
 * the canonical renderer. Arithmetic is the telemetry folds'; this module only selects what they fold.
 */

type Mode = SegmentHeader["mode"];
export interface JournalSource {
	/** False when the owner has no journal file at all. */
	present: boolean;
	records: readonly TelemetryRecord[];
	modes: readonly Mode[];
	skipped: number;
	damaged: number;
	/** The live model has not merged this owner's cold read yet; whole-scope sums stay partial until it does (#434). */
	seeding?: boolean;
	/** The process that last owned the journal, from its last segment header (#434 §6.1). */
	writer?: ClockOrigin;
}
/** The process a ledger names; `birthToken` is null where the platform gives none. */
export interface ProcessIdentity {
	host: string;
	pid: number;
	birthToken: string | null;
}
export interface SessionSource {
	sessionId: string;
	/** Process sources contribute calls and spend without counting as sessions (#434). */
	processId?: string;
	journal: JournalSource;
	/** Run journals this session's own records reference, keyed by run id. */
	runs: ReadonlyMap<string, JournalSource>;
	/** The fork parent; `source` is null when it could not be read. */
	parent: { sessionId: string; turnId: string; at: string; source: SessionSource | null } | null;
	/**
	 * The parent turn a fork branched at, from the `session.forked` row its journal opens with. A window keeps it after
	 * it drops `parent`, so a fork still counts only the outcomes it recorded itself.
	 */
	forkTurnId?: string;
	/**
	 * The ledger's own lifecycle: `endedAt` is set by a clean close and cleared by a reopen. A session ends only here
	 * until the journal records its own close (#434 §6.1).
	 */
	ledger?: { endedAt: string | null; owner: ProcessIdentity | null };
	/**
	 * The quota readings this host's process journals recorded while the session ran. A quota window belongs to the
	 * account, so the process journal keeps it, and a session reads the account's state from there (#434).
	 */
	accountQuota?: readonly TelemetryRecord[];
}
/** The account window a cold or live session reads, bounded by its own journal lifecycle (#434). */
export function sessionAccountQuotaWindow(
	records: readonly TelemetryRecord[],
	scan: QuotaWindowScan = { scanned: 0, from: Number.POSITIVE_INFINITY, last: undefined },
): { from: number; to: number } | null {
	for (; scan.scanned < records.length; scan.scanned += 1) {
		const record = records[scan.scanned] as TelemetryRecord;
		const at = Date.parse(record.t);
		if (Number.isFinite(at) && at < scan.from) scan.from = at;
		if (!scan.last || record.t >= scan.last.t) scan.last = record;
	}
	if (!Number.isFinite(scan.from)) return null;
	return { from: scan.from, to: scan.last?.k === "session.closed" ? Date.parse(scan.last.t) : Number.POSITIVE_INFINITY };
}
/** How far a window read has scanned a journal that only grows by appending, so the next read resumes there. */
export interface QuotaWindowScan {
	scanned: number;
	from: number;
	last: TelemetryRecord | undefined;
}

/** Several sessions read as one scope: a repository's sessions over a window, already windowed by the loader (#434). */
export interface RepoSource {
	/** The ref owner, `<cwdHash>-<days>d` or `all-<days>d`; see {@link repoOwner}. */
	owner: string;
	sessions: readonly SessionSource[];
	/** Run journals no session in the scope references, such as a standalone `run --agent`. */
	runs: ReadonlyMap<string, JournalSource>;
}

export function repoOwner(cwdHash: string | null, days: number): string {
	return `${cwdHash ?? "all"}-${days}d`;
}

/** The repository bucket (null for every bucket) and window a `repo` scope owner names, or null when it names none. */
export function parseRepoOwner(owner: string): { cwdHash: string | null; days: number } | null {
	const match = /^([0-9a-f]{16}|all)-([1-9][0-9]{0,5})d$/.exec(owner);
	if (!match) return null;
	return { cwdHash: match[1] === "all" ? null : (match[1] as string), days: Number(match[2]) };
}

export interface ReadOptions {
	now?: Date;
	/** Whether a recorded process still runs; null when it cannot be probed. Defaults to {@link processIdentityAlive}. */
	alive?: (identity: ProcessIdentity) => boolean | null;
}

/** A journal read as the read model holds it; a run's journal keeps only records its run owns (#434). */
export function journalSourceFromRead(
	read: {
		records: ReadonlyArray<{ record: TelemetryRecord }>;
		modes?: readonly Mode[];
		skipped: number;
		damaged: number;
		writer?: ClockOrigin;
	},
	fileExists: boolean,
	runId?: string,
): JournalSource {
	const records = read.records.map(({ record }) => record);
	return {
		present: fileExists || records.length > 0,
		records: runId === undefined ? records : records.filter((record) => record.ctx.runId === runId),
		modes: read.modes ?? [],
		skipped: read.skipped,
		damaged: read.damaged,
		...(read.writer ? { writer: read.writer } : {}),
	};
}

/**
 * A main run's calls carry its session's context, not its run id, so its run journal holds only `run.settled`, whose
 * `callIds` name them. With every named call settled in the session journal, the run reads those calls' records too,
 * so a run report groups the calls its total sums; otherwise it keeps the settled aggregate (#434).
 */
export function withSettledCalls(run: JournalSource, session: JournalSource | null): JournalSource {
	if (!session?.present || run.records.some((r) => r.k === "call.started" || r.k === "run.usage_reported")) return run;
	let settled: TelemetryRecord<"run.settled"> | undefined;
	for (const record of run.records)
		if (record.k === "run.settled" && (!settled || record.t >= settled.t)) settled = record;
	const callIds = new Set(settled?.data.callIds ?? []);
	if (callIds.size === 0) return run;
	const calls = session.records.filter((record) => record.ctx.callId !== undefined && callIds.has(record.ctx.callId));
	const settledCalls = new Set(calls.flatMap((record) => (record.k === "call.settled" ? [record.ctx.callId] : [])));
	if ([...callIds].some((callId) => !settledCalls.has(callId))) return run;
	return { ...run, records: [...run.records, ...calls].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)) };
}
