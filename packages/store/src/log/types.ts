// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The documents of the fenced change log the s3 and shared backends keep. Slot `n` of the log holds a proposal
 * (create-once, written by one claimant) and a decision (create-once, written by whoever finishes it first). A
 * proposal for slot `n + 1` is built against the decided root of slot `n` and nothing else, so two writers never
 * both change one root. A decision carries the whole root it leaves; pages it names are immutable.
 */
import type { StoreBlobPut, StorePutMode } from "../backend/types.js";
import type { StoreRecord, StoreRecordBody } from "../records.js";

/** The store's own clock around one moment after a proposal existed: the true time lies in [lo, hi]. */
export interface LogWitness {
	lo: number;
	hi: number;
}

export interface LogOwner {
	pid: number;
	host: string;
	/** Random per lease taken: two holders on one host and pid never share it. */
	token: string;
}

export interface LogLease {
	project: string;
	key: string;
	owner: LogOwner;
	/** The slot that granted the lease; a takeover grants a new one, so a stale holder's epoch no longer matches. */
	epoch: number;
	/** Store time after which another writer may take the lease over. */
	deadline: number;
	/** When it was granted, ISO. */
	at: string;
}

export interface LogProjectBinding {
	/** Random per binding: a project adopted or recreated under a key gets a new one, so old grants stop matching. */
	incarnation: string;
	/** The project's table page, or null before its first tag. */
	table: string | null;
	/** The checkout the project was first written from, or moved to by adopt. */
	root: string;
	projectId?: string;
	createdAt: string;
	adoptedFrom?: { key: string; root: string };
}

export interface LogRoot {
	projects: Record<string, LogProjectBinding>;
	/** Keyed by `<project key>:<lock id>`. */
	leases: Record<string, LogLease>;
}

export type LogOp =
	| { op: "acquire"; lease: string; project: string; key: string }
	| { op: "release"; lease: string; epoch: number }
	/** An operator's break, accepted only once the lease's deadline has passed by the store's clock. */
	| { op: "break"; lease: string; epoch: number }
	| { op: "project"; key: string; binding: LogProjectBinding | null };

export interface LogProposal {
	v: 1;
	slot: number;
	base: number;
	/** Random: tells this claimant's proposal from another's when a create's reply was lost. */
	id: string;
	owner: LogOwner;
	/** Leases the change is made under; the decision refuses it unless each is still this owner's at that epoch. */
	held: Array<{ lease: string; epoch: number }>;
	ops: LogOp[];
}

export type LogRejection = "lost" | "held" | "live" | "malformed";

export interface LogDecision {
	v: 1;
	slot: number;
	witness: LogWitness;
	accepted: boolean;
	reason?: LogRejection;
	/** The root after this slot: the proposal's result when accepted, the previous root unchanged when not. */
	root: LogRoot;
}

/** A project's tags. A removed tag keeps only blobs that have records, so its records outlive it. */
export interface LogTablePage {
	v: 1;
	tags: Record<string, LogTagEntry>;
}

export interface LogTagEntry {
	/** Random per creation: a tag deleted and made again is a different tag to a writer that admitted the first. */
	incarnation: string;
	xattrs: Record<string, string>;
	createdAt: string;
	manifest: string | null;
	removed?: true;
}

export interface LogManifestPage {
	v: 1;
	blobs: Record<string, LogBlobEntry>;
}

/** One blob name in a tag: its bytes (null once removed) and its records. */
export interface LogBlobEntry {
	payload: string | null;
	bytes: number;
	modifiedMs: number;
	sha256: string | null;
	history: string | null;
	/** How many records the blob has; its history page holds exactly these. */
	seq: number;
}

export interface LogHistoryPage {
	v: 1;
	records: StoreRecord[];
}

/** Bytes copied into the store under a private name, not yet any blob's. */
export interface LogStagedPayload {
	id: string;
	bytes: number;
	sha256: string;
	link: StoreBlobPut["link"];
}

/**
 * What a log backend adds to the contract: a recorded put or remove is one transition, so its bytes and its
 * record land together or not at all.
 */
export interface StoreLog {
	/**
	 * Stage `source`, build its record from what was staged, then publish both in one transition. Refused when
	 * the tag was deleted or recreated, the blob changed, or a held lease was lost since the change was admitted.
	 */
	recordedPut(options: {
		tag: string;
		blob: string;
		source: string;
		mode?: StorePutMode;
		ifAbsent?: boolean;
		signal?: AbortSignal;
		record: (stored: StoreBlobPut) => Promise<StoreRecordBody>;
	}): Promise<{ put: StoreBlobPut; replaced: boolean; record: StoreRecord }>;
	/**
	 * Remove the blob and append its remove record, built from the blob's last put record, in one transition; a
	 * missing blob refuses `not-found`.
	 */
	recordedRemove(options: {
		tag: string;
		blob: string;
		body: (lastPut: StoreRecord | null) => StoreRecordBody;
	}): Promise<StoreRecord>;
	/** The project's current incarnation, or null before anything was stored for it. */
	projectIncarnation(): Promise<string | null>;
	/** Every project bound in this log with the root it was written from. */
	projects(): Promise<Array<{ key: string; root: string; projectId: string | null }>>;
	/** Move the project bound under `fromKey` to this project's key in one transition, with a new incarnation. */
	adopt(fromKey: string): Promise<{ from: { key: string; root: string }; to: { key: string; root: string } }>;
	/** Pages and payloads no longer reachable from the tip, or with `apply`, deleted. Refused while any lease is held. */
	reclaim(apply: boolean): Promise<{ pages: number; payloads: number; bytes: number; deleted: boolean }>;
}
