// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `services.claims`: an extension's experiments in the project's claims ledger. It records the hypotheses of a slate
 * the extension keeps, binds them to a run of checks as the run starts, and when the run ends records the claims those
 * checks were judged into and tests the bound hypotheses. A claim comes only from a result `services.verify` holds
 * behind a receipt, so an extension can propose a hypothesis but can never write the evidence for one.
 */
import { sha256Hex } from "../../../core/hash.js";
import {
	appendCheckStarts,
	appendHypotheses,
	appendHypothesisTests,
	type CheckRun,
	type CheckRunIdentity,
	type ClaimRecord,
	type ClaimSource,
	claimFromVerifyResult,
	claimsCaptureCheckout,
	claimsProjectRoot,
	hypothesesFromSlate,
	readClaims,
	recordClaims,
} from "../../claims/index.js";
import type { ExtensionCheckReceipts } from "./verify.js";

export interface ExtensionClaimsServiceDeps {
	extensionId: string;
	workspace: string;
	sessionId: string | null;
	receipts: ExtensionCheckReceipts;
	readOnly?: () => boolean;
	now?: () => Date;
}

export interface ExtensionClaimsService {
	hypotheses(name: string, slate: string): Promise<Record<string, string | null>>;
	begin(run: string, checks: ReadonlyArray<string>): Promise<Record<string, string[]>>;
	finish(
		run: string,
		outcomes: ReadonlyArray<{ check: string; receipt: string }>,
		options?: { withoutClaim?: ReadonlyArray<string> },
	): Promise<Record<string, string>>;
	read(options?: {
		types?: ReadonlyArray<"claim" | "hypothesis" | "hypothesis-test">;
		limit?: number;
	}): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}

export class ExtensionClaimsError extends Error {
	constructor(
		readonly code: "invalid" | "refused" | "unknown_receipt",
		message: string,
	) {
		super(message);
		this.name = "ExtensionClaimsError";
	}
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/u;
const MAX_SLATE_BYTES = 256 * 1024;
const MAX_CHECKS = 64;
/** Runs begun and not yet finished whose bindings the host keeps; the oldest is forgotten. */
const MAX_OPEN_RUNS = 256;
const DEFAULT_READ = 100;
const MAX_READ = 1000;

function name(field: string, value: unknown): string {
	if (typeof value !== "string" || !NAME.test(value))
		throw new ExtensionClaimsError("invalid", `${field} must be slash-separated words`);
	return value;
}

function checks(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_CHECKS)
		throw new ExtensionClaimsError("invalid", `checks must be at most ${MAX_CHECKS} names`);
	return value.map((check) => {
		if (typeof check !== "string" || check.length === 0 || check.length > 256)
			throw new ExtensionClaimsError("invalid", "a check is a non-empty name");
		return check;
	});
}

export function createExtensionClaimsService(deps: ExtensionClaimsServiceDeps): ExtensionClaimsService {
	const now = deps.now ?? (() => new Date());
	const project = (): string => claimsProjectRoot(deps.workspace);
	const open = new Map<string, Map<string, string[]>>();
	const consumed = new Set<string>();
	const assertWritable = (): void => {
		if (deps.readOnly?.() === true)
			throw new ExtensionClaimsError("refused", "claims ledger writes are refused in a read-only session");
	};
	const identity = (run: string): CheckRunIdentity => ({
		channel: "verify",
		sessionId: deps.sessionId,
		toolCallId: `extension:${deps.extensionId}:${run}`,
	});

	return {
		async hypotheses(slateName, slate) {
			assertWritable();
			const key = name("slate name", slateName);
			if (typeof slate !== "string" || Buffer.byteLength(slate) > MAX_SLATE_BYTES)
				throw new ExtensionClaimsError("invalid", "a slate is text of at most 256 KiB");
			const root = project();
			const drafts = hypothesesFromSlate({
				text: slate,
				slateSha256: sha256Hex(slate),
				path: `extension:${deps.extensionId}/${key}`,
				project: root,
				at: now().toISOString(),
				source: { channel: "slate", sessionId: deps.sessionId, toolCallId: null },
			});
			if (drafts === null) throw new ExtensionClaimsError("invalid", "the slate is not a pancode.hypothesis-slate.v1");
			const written = (await appendHypotheses(root, drafts)) ?? [];
			const ids: Record<string, string | null> = {};
			for (const draft of drafts) ids[draft.hypothesis] = null;
			for (const record of written) ids[record.hypothesis] = record.id;
			return ids;
		},

		async begin(run, names) {
			assertWritable();
			const key = name("run", run);
			const bindings = await appendCheckStarts(project(), identity(key), checks(names), now().toISOString());
			open.set(key, bindings);
			while (open.size > MAX_OPEN_RUNS) open.delete(open.keys().next().value as string);
			return Object.fromEntries(bindings);
		},

		async finish(run, outcomes, options = {}) {
			assertWritable();
			const key = name("run", run);
			if (!Array.isArray(outcomes) || outcomes.length > MAX_CHECKS)
				throw new ExtensionClaimsError("invalid", `outcomes must be at most ${MAX_CHECKS}`);
			const root = project();
			const trustedWorkspace = claimsCaptureCheckout(deps.workspace) !== null;
			const at = now().toISOString();
			const source: Extract<ClaimSource, { channel: "verify" }> = {
				channel: "verify",
				sessionId: deps.sessionId,
				toolCallId: `extension:${deps.extensionId}:${key}`,
				requestedBy: "harness",
			};
			const seenReceipts = new Set<string>();
			const judged: Array<{ check: string; execution: string; claim: ClaimRecord | null }> = [];
			for (const outcome of outcomes) {
				const receiptId = String(outcome?.receipt);
				const receipt = deps.receipts.get(receiptId);
				if (receipt === undefined || receipt.check !== outcome.check)
					throw new ExtensionClaimsError(
						"unknown_receipt",
						`no result of check ${String(outcome?.check)} under that receipt`,
					);
				if (consumed.has(receiptId) || seenReceipts.has(receiptId))
					throw new ExtensionClaimsError("unknown_receipt", `receipt for check ${outcome.check} has already been used`);
				seenReceipts.add(receiptId);
				const checkout = claimsCaptureCheckout(receipt.checkout);
				const linked = checkout?.linked && checkout.project === root ? checkout.checkout : null;
				const claim =
					trustedWorkspace && checkout !== null && checkout.project === root
						? claimFromVerifyResult({
								details: receipt.result.details,
								project: root,
								...(linked !== null ? { checkout: linked } : {}),
								at,
								source,
							})
						: null;
				const judgement = (receipt.result.details as { judgement?: { execution?: unknown } } | undefined)?.judgement;
				judged.push({
					check: outcome.check,
					execution:
						typeof judgement?.execution === "string"
							? judgement.execution
							: receipt.result.kind === "ok"
								? "succeeded"
								: "failed",
					claim,
				});
			}
			for (const receiptId of seenReceipts) consumed.add(receiptId);
			const claims = judged.flatMap((entry) => (entry.claim !== null ? [entry.claim] : []));
			// A ledger keyed on a forged worktree pointer records no claims, as main-thread capture does not.
			if (claims.length > 0 && trustedWorkspace) await recordClaims(claims, new Date(at));
			const bindings = open.get(key) ?? new Map<string, string[]>();
			open.delete(key);
			const without = new Set(options.withoutClaim ?? []);
			const runs: CheckRun[] = judged.flatMap((entry) => {
				const bound = bindings.get(entry.check) ?? [];
				const base = { check: entry.check, execution: entry.execution, source, at };
				const bare = bound.filter((id) => without.has(id));
				const evidenced = bound.filter((id) => !without.has(id));
				return [
					...(bare.length > 0 ? [{ ...base, hypotheses: bare }] : []),
					...(evidenced.length > 0
						? [{ ...base, hypotheses: evidenced, ...(entry.claim !== null ? { claim: entry.claim } : {}) }]
						: []),
				];
			});
			await appendHypothesisTests(root, runs);
			return Object.fromEntries(
				judged.flatMap((entry) => (entry.claim !== null ? [[entry.check, entry.claim.id] as const] : [])),
			);
		},

		async read(options = {}) {
			const types = new Set(options.types ?? ["claim", "hypothesis", "hypothesis-test"]);
			const rawLimit = options.limit;
			const limit = Math.min(
				MAX_READ,
				Math.max(1, Math.trunc(typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : DEFAULT_READ)),
			);
			const log = readClaims(project());
			const records: Array<Readonly<Record<string, unknown>> & { at?: unknown }> = [
				...(types.has("claim") ? log.records : []),
				...(types.has("hypothesis") ? log.hypotheses : []),
				...(types.has("hypothesis-test") ? log.hypothesisTests : []),
			] as unknown as Array<Readonly<Record<string, unknown>> & { at?: unknown }>;
			records.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
			return records.slice(-limit);
		},
	};
}
