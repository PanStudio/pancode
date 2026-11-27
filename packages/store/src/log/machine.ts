// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The state machine over a log medium: resolve the tip, finish a decision its claimant left pending, and commit
 * one transition. Correctness rests on the slots alone: each proposal is built against the decided root of the
 * slot before it, a slot holds one proposal and one decision, and a decision is a pure function of that root,
 * the proposal and the store's clock witness, so any client finishes a pending slot the same way. Clocks only
 * decide when a lease has expired.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { type StorePutMode, StoreRefusal } from "../backend/types.js";
import type {
	LogDecision,
	LogOp,
	LogOwner,
	LogProposal,
	LogRejection,
	LogRoot,
	LogStagedPayload,
	LogWitness,
} from "./types.js";

/** A lease not renewed for this long, by the store's clock, may be taken over. */
export const STORE_LEASE_EXPIRY_MS = 60 * 1000;
/** How long a commit keeps trying against other writers before it refuses. */
const COMMIT_WAIT_MS = 30 * 1000;

/** Where a log keeps its slots, pages and payloads: an S3 prefix or a shared folder. */
export interface LogMedium {
	/** Refuse `unavailable` unless the storage creates exclusively and lists in order. Called before a first write. */
	qualify(): Promise<void>;
	/** The highest slot holding a proposal, 0 for an empty log. */
	newestProposal(): Promise<number>;
	/** The proposal text of `slot` and a witness taken after it was read, or null when the slot is empty. */
	readProposal(slot: number): Promise<{ text: string; witness: LogWitness } | null>;
	/** Create the proposal of `slot`; won is false when another claimant holds it. The witness follows the create. */
	claimProposal(slot: number, id: string, text: string): Promise<{ won: true; witness: LogWitness } | { won: false }>;
	readDecision(slot: number): Promise<string | null>;
	/** Create the decision of `slot` unless one exists; the caller reads back whichever is there. */
	claimDecision(slot: number, text: string): Promise<void>;
	/** A fresh witness of the store's clock. */
	witness(): Promise<LogWitness>;
	putPage(id: string, text: string): Promise<void>;
	getPage(id: string): Promise<string | null>;
	/** Copy `source` into the store under a new private payload name; `signal` aborts the copy. */
	stagePayload(source: string, options: { signal?: AbortSignal; mode?: StorePutMode }): Promise<LogStagedPayload>;
	/** Write the payload's bytes to `target`, a new file. */
	readPayload(id: string, target: string, signal?: AbortSignal): Promise<void>;
	/** The payload's name as a receipt shows it. */
	payloadKey(id: string): string;
	/** Every page and payload stored, with the store's time it was written. */
	listStored(): AsyncIterable<{ kind: "page" | "payload"; id: string; bytes: number; modifiedMs: number }>;
	deleteStored(kind: "page" | "payload", id: string): Promise<void>;
}

export function emptyRoot(): LogRoot {
	return { projects: {}, leases: {} };
}

export function randomId(): string {
	return randomBytes(16).toString("hex");
}

/**
 * The decision for `proposal` in `slot` over `base`, the root of `slot - 1`, at `witness`. Pure: every client
 * that finishes the slot computes the same answer from the same witness.
 */
export function decide(base: LogRoot, slot: number, proposal: LogProposal | null, witness: LogWitness): LogDecision {
	const reject = (reason: LogRejection): LogDecision => ({ v: 1, slot, witness, accepted: false, reason, root: base });
	if (proposal === null || proposal.v !== 1 || proposal.slot !== slot || proposal.base !== slot - 1)
		return reject("malformed");
	const root: LogRoot = structuredClone(base);
	const token = proposal.owner.token;
	for (const held of proposal.held) {
		const lease = root.leases[held.lease];
		if (lease === undefined || lease.epoch !== held.epoch || lease.owner.token !== token) return reject("lost");
		if (witness.hi >= lease.deadline) return reject("lost");
	}
	for (const op of proposal.ops) {
		if (op.op === "acquire") {
			const current = root.leases[op.lease];
			if (current !== undefined && current.owner.token !== token && witness.lo < current.deadline) return reject("held");
			root.leases[op.lease] = {
				project: op.project,
				key: op.key,
				owner: proposal.owner,
				epoch: slot,
				deadline: witness.lo + STORE_LEASE_EXPIRY_MS,
				at: new Date(witness.lo).toISOString(),
			};
		} else if (op.op === "release") {
			const current = root.leases[op.lease];
			if (current !== undefined && current.epoch === op.epoch && current.owner.token === token)
				delete root.leases[op.lease];
		} else if (op.op === "break") {
			const current = root.leases[op.lease];
			if (current === undefined || current.epoch !== op.epoch || witness.lo < current.deadline) return reject("live");
			delete root.leases[op.lease];
		} else if (op.op === "project") {
			if (op.binding === null) delete root.projects[op.key];
			else root.projects[op.key] = op.binding;
		} else return reject("malformed");
	}
	// An accepted change renews every lease it was made under.
	for (const held of proposal.held) {
		const lease = root.leases[held.lease];
		if (lease !== undefined) lease.deadline = witness.lo + STORE_LEASE_EXPIRY_MS;
	}
	return { v: 1, slot, witness, accepted: true, root };
}

function parseJson<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new StoreRefusal("io", `The store's ${what} is not valid JSON.`);
	}
}

function parseProposal(text: string): LogProposal | null {
	try {
		const parsed = JSON.parse(text) as LogProposal;
		return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.ops) && Array.isArray(parsed.held)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Commits in one process to one log go one at a time; other processes are ordered by the slots. */
const queues = new Map<string, Promise<unknown>>();

export function serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(name) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(fn);
	const tail = run.catch(() => undefined);
	queues.set(name, tail);
	void tail.then(() => {
		if (queues.get(name) === tail) queues.delete(name);
	});
	return run;
}

export interface LogTip {
	slot: number;
	root: LogRoot;
	/** The store's time at the tip's decision. */
	decidedAt: number;
}

export interface LogCommitPlan {
	ops: LogOp[];
	held: Array<{ lease: string; epoch: number }>;
}

export class LogMachine {
	/** Every lease this machine takes and every change it proposes carries this owner. */
	readonly owner: LogOwner;
	private readonly decisions = new Map<number, LogDecision>();
	private readonly pages = new Map<string, unknown>();
	private qualified: Promise<void> | null = null;

	constructor(
		readonly name: string,
		private readonly medium: LogMedium,
	) {
		this.owner = { pid: process.pid, host: hostname(), token: randomId() };
	}

	private async decisionAt(slot: number): Promise<LogDecision | null> {
		if (slot === 0) return { v: 1, slot: 0, witness: { lo: 0, hi: 0 }, accepted: true, root: emptyRoot() };
		const cached = this.decisions.get(slot);
		if (cached !== undefined) return cached;
		const text = await this.medium.readDecision(slot);
		if (text === null) return null;
		const decision = parseJson<LogDecision>(text, `decision of log slot ${slot}`);
		if (decision.v !== 1 || decision.slot !== slot || typeof decision.root !== "object")
			throw new StoreRefusal("io", `The store's decision of log slot ${slot} is not one this version reads.`);
		this.decisions.set(slot, decision);
		if (this.decisions.size > 64) this.decisions.delete(this.decisions.keys().next().value as number);
		return decision;
	}

	/** Decide `slot` when its claimant has not: anyone may, and the first decision written stands. */
	private async finish(slot: number): Promise<LogDecision> {
		const existing = await this.decisionAt(slot);
		if (existing !== null) return existing;
		const base = await this.decisionAt(slot - 1);
		if (base === null) throw new StoreRefusal("io", `The store's log has no decision for slot ${slot - 1}.`);
		const read = await this.medium.readProposal(slot);
		if (read === null) throw new StoreRefusal("io", `The store's log has no proposal for slot ${slot}.`);
		const decision = decide(base.root, slot, parseProposal(read.text), read.witness);
		await this.medium.claimDecision(slot, JSON.stringify(decision));
		const written = await this.decisionAt(slot);
		if (written === null) throw new StoreRefusal("io", `The decision of log slot ${slot} vanished after it was written.`);
		return written;
	}

	/** The newest decided slot and its root, finishing a pending decision on the way. */
	async tip(): Promise<LogTip> {
		const newest = await this.medium.newestProposal();
		if (newest === 0) return { slot: 0, root: emptyRoot(), decidedAt: 0 };
		const decision = await this.finish(newest);
		return { slot: newest, root: decision.root, decidedAt: decision.witness.lo };
	}

	async page<T>(id: string, what: string): Promise<T> {
		const cached = this.pages.get(id);
		if (cached !== undefined) return cached as T;
		const text = await this.medium.getPage(id);
		if (text === null) throw new StoreRefusal("io", `The store's ${what} page ${id} is missing.`);
		const parsed = parseJson<T>(text, `${what} page ${id}`);
		this.remember(id, parsed);
		return parsed;
	}

	async writePage(value: unknown): Promise<string> {
		const id = randomId();
		await this.medium.putPage(id, JSON.stringify(value));
		this.remember(id, value);
		return id;
	}

	private remember(id: string, value: unknown): void {
		this.pages.set(id, value);
		if (this.pages.size > 4096) this.pages.delete(this.pages.keys().next().value as string);
	}

	witness(): Promise<LogWitness> {
		return this.medium.witness();
	}

	/**
	 * Commit one transition: `build` plans it against the tip, or returns null when there is nothing to change.
	 * A slot another writer took first means the tip moved: the plan is built again against the new tip, never
	 * replayed. The decision comes back accepted or rejected; only a slot that cannot be won in 30 s refuses.
	 */
	commit(build: (tip: LogTip) => Promise<LogCommitPlan | null>): Promise<LogDecision | null> {
		return serialized(this.name, async () => {
			this.qualified ??= this.medium.qualify().catch((error: unknown) => {
				this.qualified = null;
				throw error;
			});
			await this.qualified;
			const started = Date.now();
			let late = false;
			for (let attempt = 0; ; attempt++) {
				const tip = await this.tip();
				const plan = await build(tip);
				if (plan === null) return null;
				const slot = tip.slot + 1;
				const proposal: LogProposal = {
					v: 1,
					slot,
					base: tip.slot,
					id: randomId(),
					owner: this.owner,
					held: plan.held,
					ops: plan.ops,
				};
				const claim = await this.medium.claimProposal(slot, proposal.id, JSON.stringify(proposal));
				if (!claim.won) {
					// Past the wait the plan is still rebuilt once, so a writer that stalled meets the new tip's own refusal.
					if (Date.now() - started > COMMIT_WAIT_MS) {
						if (late)
							throw new StoreRefusal(
								"unavailable",
								`Other writers kept taking the store's next log slot for ${COMMIT_WAIT_MS / 1000} s; try again.`,
							);
						late = true;
					}
					await delay(Math.min(500, 10 * 2 ** Math.min(attempt, 6)) * Math.random());
					continue;
				}
				const decision = decide(tip.root, slot, proposal, claim.witness);
				await this.medium.claimDecision(slot, JSON.stringify(decision));
				const written = await this.decisionAt(slot);
				if (written === null)
					throw new StoreRefusal("io", `The decision of log slot ${slot} vanished after it was written.`);
				return written;
			}
		});
	}
}
