// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { QuotaStateV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { renderFact } from "../../core/telemetry/render.js";

type QuotaReading = Extract<TelemetryRecord, { k: "quota.read" }>["data"];
/** Match observed account keys: streamed Codex readings are per target, polls read the credential adapter (#434). */
export const quotaAccount = (reading: QuotaReading): string =>
	reading.provider === "codex" && reading.source !== "poll" ? `codex:${reading.targetId}` : reading.provider;

/** Account identity and outcomes survive projection, including failed reads with no windows (#434). */
export function quotaAccountDetails(reading: QuotaReading) {
	const creditPct = reading.credits?.usedPct;
	const retry: Fact<number> | null =
		reading.retryAfterSeconds === undefined
			? null
			: {
					kind: "measured",
					value: reading.retryAfterSeconds * 1000,
					source: "provider",
				};
	return {
		credentials: [quotaAccount(reading)],
		displayName: reading.displayName,
		status: reading.status,
		plan: reading.plan ?? null,
		message: reading.message ?? null,
		credits:
			reading.credits && creditPct
				? {
						display: reading.credits.display,
						usedPct: { fact: creditPct, display: renderFact(creditPct, "percent") },
						unit: reading.credits.unit ?? null,
					}
				: null,
		retryAfter: retry ? { fact: retry, display: renderFact(retry, "duration") } : null,
		pool: reading.accountPseudonym ?? null,
		access: reading.access,
		overage: reading.overage,
		resetsAt: reading.resetsAt ?? null,
		validUntil: reading.validUntil ?? null,
	};
}

/**
 * Anthropic credentials of one verified organization (the same pool pseudonym) with matching windows share one
 * allowance; their route associations survive the fold (#434, #423). Rows without a pool never merge.
 */
export function reconcileQuotaAccounts(rows: QuotaStateV1["providers"]): QuotaStateV1["providers"] {
	const kept: QuotaStateV1["providers"] = [];
	const anthropic = new Set(["anthropic-max", "claude-code"]);
	for (const row of rows) {
		const twin = kept.findIndex(
			(other) =>
				row.status === "ok" &&
				other.status === "ok" &&
				row.provider !== other.provider &&
				row.pool !== null &&
				row.pool === other.pool &&
				anthropic.has(row.provider) &&
				anthropic.has(other.provider) &&
				row.windows.length > 0 &&
				row.windows.length === other.windows.length &&
				row.windows.every((window) => {
					const match = other.windows.find((candidate) => candidate.key === window.key && candidate.scope === window.scope);
					return (
						match !== undefined &&
						window.usedPct.fact.kind === "measured" &&
						match.usedPct.fact.kind === "measured" &&
						Math.abs(window.usedPct.fact.value - match.usedPct.fact.value) < 0.5 &&
						(window.resetsAt === match.resetsAt ||
							(window.resetsAt !== null &&
								match.resetsAt !== null &&
								Math.abs(Date.parse(window.resetsAt) - Date.parse(match.resetsAt)) < 1000))
					);
				}),
		);
		const prior = kept[twin];
		if (!prior) {
			kept.push(row);
			continue;
		}
		const chosen =
			row.source === "response-headers" || (prior.source !== "response-headers" && !prior.plan && row.plan) ? row : prior;
		kept[twin] = {
			...chosen,
			credentials: [...new Set([...prior.credentials, ...row.credentials])].sort(),
			plan: chosen.plan ?? prior.plan ?? row.plan,
			credits: chosen.credits ?? prior.credits ?? row.credits,
		};
	}
	return kept;
}

/**
 * Two readings come from one verified account: matching pool pseudonyms (and no conflicting account digest), or, where
 * neither carries a pool, matching account digests. A reading with neither identity matches nothing.
 */
function sameQuotaIdentity(a: QuotaReading, b: QuotaReading): boolean {
	if (a.accountPseudonym !== undefined || b.accountPseudonym !== undefined)
		return (
			a.accountPseudonym === b.accountPseudonym &&
			(a.account === undefined || b.account === undefined || a.account === b.account)
		);
	return a.account !== undefined && a.account === b.account;
}

/** A provider reports a window's reset with drift between readings; a reset that moved further began a new window. */
const QUOTA_RESET_DRIFT_MS = 5 * 60_000;
function sameQuotaWindow(a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return Math.abs(Date.parse(a) - Date.parse(b)) <= QUOTA_RESET_DRIFT_MS;
}

export interface AccountQuota {
	reading: QuotaReading;
	/** Per window key, what the window gained since the account's previous reading of the same window. */
	consumed: ReadonlyMap<string, Fact<number>>;
}

/**
 * Each account's newest journaled reading and the window consumption between it and the reading before it (#434
 * §12.5, C2). Consumption is estimated, never measured: other devices draw from the same shared window, so the delta
 * is the account's, not this host's. A window whose reset moved, or whose share fell, restarted between the two
 * readings and has no delta. Readings from two different provider accounts on one target are never compared; the
 * delta is taken against the newest earlier reading of the same pool whose account is the same or unstated, so a
 * login switch under one provider never joins the two pools.
 */
export function foldAccountQuota(records: readonly TelemetryRecord[]): Map<string, AccountQuota> {
	const byAccount = new Map<string, QuotaReading[]>();
	for (const record of records) {
		if (record.k !== "quota.read") continue;
		const account = quotaAccount(record.data);
		byAccount.set(account, [...(byAccount.get(account) ?? []), record.data]);
	}
	const folded = new Map<string, AccountQuota>();
	for (const [account, readings] of byAccount) {
		readings.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
		const reading = readings.at(-1) as QuotaReading;
		const previous = readings
			.slice(0, -1)
			.reverse()
			.find((candidate) => sameQuotaIdentity(candidate, reading));
		const consumed = new Map<string, Fact<number>>();
		for (const window of reading.windows) {
			const prior = previous?.windows.find((candidate) => candidate.key === window.key);
			if (prior?.usedPct.kind !== "measured" || window.usedPct.kind !== "measured") continue;
			if (!sameQuotaWindow(prior.resetsAt, window.resetsAt)) continue;
			const delta = window.usedPct.value - prior.usedPct.value;
			if (delta < 0) continue;
			consumed.set(window.key, {
				kind: "estimated",
				value: Math.round(delta * 1000) / 1000,
				method: "shared-account-window-delta",
			});
		}
		folded.set(account, { reading, consumed });
	}
	return folded;
}
