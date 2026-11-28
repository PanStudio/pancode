// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import {
	sessionUsageNotes,
	stripUsageClause,
	USAGE_NOT_MEASURED,
	usageFigure,
	usageKnownAmount,
	usageSaysNothing,
} from "../../../../src/core/views/usage-words.js";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { SessionTelemetryV1 } from "../../contracts/wire.js";
import { formatTime } from "../api/clock.js";
import type { StatusTone } from "../design/status.js";
import type { Explainable } from "../telemetry/quantity-model.js";

const BARE_COUNT = /^≥?~?\d[\d,]*$/;

/**
 * A token figure with its unit, in the terminal's words: the read model's coverage clause is dropped, so
 * `≥5,120 (1 call unknown)` reads `≥5,120 tokens` and the gap is said once, in the usage pane's coverage line. A figure
 * that still carries a method clause takes the unit as a label instead, because a unit after the clause misreads.
 */
export function tokensText(display: string, unit: "tokens" | "tok" = "tokens"): string {
	const figure = stripUsageClause(display);
	return BARE_COUNT.test(figure) ? `${figure} ${unit}` : `Tokens: ${figure}`;
}

export interface Spend {
	/** Whether any of the token total and the cost was measured or estimated; an unknown figure says nothing in a chip. */
	readonly known: { readonly tokens: boolean; readonly cost: boolean };
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
	readonly source: "telemetry" | "none";
	readonly refs: SpendRefs;
}
export interface SpendRefs {
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
}
const NO_REFS: SpendRefs = { tokens: null, cost: null, calls: null };

export function sessionSpend(input: {
	usage?: SessionUsage | undefined;
	live?: LiveUsage | undefined;
	cold?: SessionTelemetryV1 | null | undefined;
}): Spend {
	const session = input.live?.session ?? input.usage?.telemetry.session ?? input.cold;
	return session
		? {
				known: {
					tokens: usageKnownAmount(session.totals.tokens) !== null,
					cost: usageKnownAmount(session.totals.usd) !== null,
				},
				tokens: session.totals.tokens.display,
				cost: session.totals.usd.display,
				calls: session.own.counts.calls.display,
				source: "telemetry",
				refs: {
					tokens: session.totals.tokens.ref ?? null,
					cost: session.totals.usd.ref ?? null,
					calls: session.own.counts.calls.ref ?? null,
				},
			}
		: { known: { tokens: false, cost: false }, tokens: null, cost: null, calls: null, source: "none", refs: NO_REFS };
}

/**
 * What the top bar's figures say. A chip is a glance, so a figure nobody measured stays out of it: the
 * pane still states it, with its reason, one click away.
 */
export function chipFigures(spend: Spend): { tokens: string | null; cost: string | null } {
	return {
		tokens: spend.known.tokens && spend.tokens !== null ? tokensText(spend.tokens, "tok") : null,
		cost: spend.known.cost ? spend.cost : null,
	};
}

/** The context chip's words: the journaled share when it was measured, else the live ledger's own percent. */
export function contextFigure(
	share: { fact: SessionTelemetryV1["context"]["share"]["fact"]; display: string } | undefined,
	ledgerPercent: string | null,
): { text: string; fromShare: boolean } | null {
	if (share && usageKnownAmount(share) !== null) return { text: share.display, fromShare: true };
	return ledgerPercent === null ? null : { text: ledgerPercent, fromShare: false };
}

export interface SpendTotal extends Explainable {
	label: string;
}

function spendTotals(spend: Spend): SpendTotal[] {
	return spend.source === "none"
		? []
		: [
				{ label: "Cost", value: stripUsageClause(spend.cost ?? USAGE_NOT_MEASURED), factRef: spend.refs.cost },
				{ label: "Tokens", value: stripUsageClause(spend.tokens ?? USAGE_NOT_MEASURED), factRef: spend.refs.tokens },
				{ label: "Model calls", value: spend.calls ?? "not recorded", factRef: spend.refs.calls },
			];
}
export function usageTotals(usage: SessionUsage): SpendTotal[] {
	return spendTotals(sessionSpend({ usage }));
}
export interface UsageRow {
	key: string;
	route: string;
	tokens: string;
	cost: string;
	calls: string | null;
	beside: string | null;
	refs: { tokens: string | null; cost: string | null };
}
export function usageRows(usage: SessionUsage, _detail: "summary" | "fields" = "summary"): UsageRow[] {
	return usage.telemetry.cost.groups.map((group) => ({
		key: group.key,
		route: group.key,
		tokens: tokensText(group.tokens.display),
		cost: stripUsageClause(group.usd.display),
		calls: group.calls.display,
		beside: null,
		refs: { tokens: group.tokens.ref ?? null, cost: group.usd.ref ?? null },
	}));
}
export function usageCoverageNotes(_usage: SessionUsage): string[] {
	return [
		"Cache reads and writes are separate model prompt-cache fields. Provider token fields can overlap, so they do not establish additive shares, a cache hit rate, or cost savings.",
	];
}

/**
 * The usage read asks the agent for the session fold, its cost groups and the provider quota at once; a build that
 * names fewer of those methods refuses the whole read, so the GUI asks only a build that names all three.
 */
export function usageReadable(capabilities: AgentCapabilities | undefined): boolean {
	const methods = capabilities?.telemetry?.methods;
	return !!(methods?.session && methods.cost && methods.quota);
}

export interface QuotaCard {
	key: string;
	name: string;
	word: string;
	tone: StatusTone;
	note: string | null;
	message: string | null;
	credits: string | null;
	/** `share` is the provider's used percent, or null when the provider did not report one: no bar is drawn for it. */
	windows: Array<{ label: string; used: string; share: number | null; resetsAt: string | null }>;
}

type QuotaWindow = SessionUsage["telemetryQuota"]["providers"][number]["windows"][number];
const knownShare = (window: QuotaWindow): number | null =>
	"value" in window.usedPct.fact ? window.usedPct.fact.value : null;

export function quotaCards(usage: SessionUsage): { status: "read"; cards: QuotaCard[] } {
	return {
		status: "read",
		cards: usage.telemetryQuota.providers.map((provider) => ({
			key: provider.provider,
			name: provider.provider,
			word: provider.stale ? "Last reading" : "Read",
			tone: provider.stale ? "neutral" : "success",
			note: provider.stale ? "last recorded reading, not refreshed" : null,
			message: null,
			credits: null,
			windows: provider.windows.map((window) => ({
				label: window.label ?? window.key,
				used: window.usedPct.display,
				share: knownShare(window),
				resetsAt: window.resetsAt,
			})),
		})),
	};
}

export function quotaTone(share: number): "ok" | "warn" | "full" {
	return share >= 85 ? "full" : share >= 65 ? "warn" : "ok";
}

/** The used share at which the task header starts warning about a provider window. */
const QUOTA_CHIP_AT = 80;

export interface QuotaChip {
	text: string;
	tone: "warn" | "fail";
	title: string;
}

/**
 * The header's quota warning: the provider window with the highest reported used share, once one reaches
 * {@link QUOTA_CHIP_AT}. The share is compared as reported; the chip words it with the engine's display.
 */
export function quotaChip(usage: SessionUsage | undefined): QuotaChip | null {
	let top: { window: QuotaWindow; share: number } | null = null;
	for (const provider of usage?.telemetryQuota.providers ?? [])
		for (const window of provider.windows) {
			const share = knownShare(window);
			if (share !== null && share >= QUOTA_CHIP_AT && (top === null || share > top.share)) top = { window, share };
		}
	if (top === null) return null;
	const label = top.window.label ?? top.window.key;
	return {
		text: `Quota ${top.window.usedPct.display}`,
		tone: top.share >= 100 ? "fail" : "warn",
		title: `${label} · ${top.window.resetsAt ? `resets ${formatTime(top.window.resetsAt)}` : "reset time not reported"}`,
	};
}

export function usageSummary(
	sessionOpen: boolean,
	usage: SessionUsage | undefined,
	recorded: LiveUsage | undefined,
	cold?: SessionTelemetryV1 | null,
) {
	const spend = sessionSpend({ usage, live: recorded, cold });
	const totals = spendTotals(spend);
	const session = usage?.telemetry.session ?? cold;
	const overhead = (recorded?.session ?? session)?.overhead.share;
	return {
		totals,
		overhead: overhead
			? { label: "PanCode overhead", value: usageFigure(overhead), factRef: overhead.ref ?? null }
			: null,
		coverage: session ? usageCoverageLine(session) : null,
		details: sessionOpen && !!usage,
		source: spend.source,
		note: !sessionOpen
			? totals.length > 0
				? "Last recorded totals. Open this session to refresh model details and provider quota."
				: "No usage totals were recorded. Open this session to read its usage."
			: spend.source === "telemetry"
				? "PanCode's telemetry figures for this conversation; a partial sum reads as a lower bound with its gap."
				: recorded?.session
					? "Live totals. Model details below update when the turn finishes."
					: "PanCode’s own accounting for this conversation.",
	};
}

/**
 * What the session's token figures leave out, said once beside the totals in `/usage`'s words: fields no call
 * reported, calls with no usage data and calls PanCode estimated. Null when the total says nothing to qualify.
 */
function usageCoverageLine(session: SessionTelemetryV1): string | null {
	if (usageSaysNothing(usageFigure(session.totals.tokens))) return null;
	const line = sessionUsageNotes(session.own.tokens).join(" · ");
	return line === "" ? null : `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}
