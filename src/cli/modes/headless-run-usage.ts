// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CallFilter } from "../../core/telemetry/dto.js";
import { promptTokenSum } from "../../core/telemetry/pricing.js";
import { renderCompactCount, renderUsdSum } from "../../core/telemetry/render.js";
import type { RunCallUsage } from "../../domains/dispatch/run-call-usage.js";
import type { RunOutcome } from "../../domains/dispatch/types.js";

import { noteMainRunV2 } from "../run-failure.js";
import type { HeadlessMainAgentOptions } from "./headless-run-types.js";
import type { RunScopeUsageV2 } from "./run-json-schema-v2.js";

/** The run's own turn calls and the compactions it ran: what `runUsage` folds with no roles. */
const MAIN_CALL_ROLES: CallFilter["roles"] = ["main", "compaction"];

/** Dispatched workers' calls, which the main run's own fold leaves out. */
const CHILD_CALL_ROLES: CallFilter["roles"] = ["worker"];

/** Side agents' calls the session makes beside its turns, such as the safety judge's; the main fold leaves them out. */
const SIDE_CALL_ROLES: CallFilter["roles"] = [
	"memory",
	"system-one",
	"safety-judge",
	"prewarm",
	"btw",
	"handoff",
	"helper",
];

/** Every role a run's calls are folded under: its own, its side agents' and its dispatched workers'. */
const ALL_CALL_ROLES: CallFilter["roles"] = [
	...(MAIN_CALL_ROLES ?? []),
	...(SIDE_CALL_ROLES ?? []),
	...(CHILD_CALL_ROLES ?? []),
];

/**
 * The text run's closing stderr line: session, outcome, requests, prompt and output tokens, and spend, over every call
 * the run made, its workers' included and named, so it reconciles with `telemetry cost` and `fleet status`.
 */
export function runTextSummaryLine(
	sessionId: string | null,
	outcome: RunOutcome,
	usage: Pick<RunCallUsage, "sums" | "facts" | "freeRuleMixed">,
	workers: Pick<RunCallUsage, "sums"> | null,
): string {
	const { apiCalls, usd, usage: tokens } = usage.sums;
	const pricing = usage.facts.pricing;
	const free = pricing.pricedBy === "free";
	const cost =
		usd.coverage.measured === 0 && usd.coverage.estimated === 0
			? "unpriced"
			: renderUsdSum(usd, free, free ? pricing.freeRule : undefined, free && usage.freeRuleMixed === true);
	const requests = `${renderCompactCount(apiCalls)} requests${workers !== null ? ` (${renderCompactCount(workers.sums.apiCalls)} by workers)` : ""}`;
	return `pancode run: session ${sessionId ?? "none"} · ${outcome} · ${requests} · ${renderCompactCount(promptTokenSum(tokens))} in/${renderCompactCount(tokens.output)} out tokens · ${cost}\n`;
}

/** The text summary's folds: every call the run made, and its workers' alone; null where the read model cannot say. */
export async function runTextSummaryUsage(
	options: HeadlessMainAgentOptions,
	from: string,
): Promise<{ total: RunCallUsage | null; workers: RunCallUsage | null }> {
	const total = (await options.runUsage?.(from, ALL_CALL_ROLES).catch(() => null)) ?? null;
	const workers = (await options.runUsage?.(from, CHILD_CALL_ROLES).catch(() => null)) ?? null;
	return { total, workers: workers !== null && workers.callIds.length > 0 ? workers : null };
}

/**
 * The schema v2 envelope's usage: `main` is the fold the run ledger records; `side` and `children` are the same fold
 * over the side agents' and the dispatched workers' calls, each absent when none was recorded; `total` folds all three
 * and is left out when `main` is the whole run.
 */
export async function noteRunUsageV2(
	options: HeadlessMainAgentOptions,
	from: string,
	main: RunCallUsage,
): Promise<void> {
	// Each scope's economics folds the very calls its usage folds, by the same role filter.
	const scoped = async (usage: RunCallUsage, roles: CallFilter["roles"]): Promise<RunScopeUsageV2> => {
		const economics = (await options.runEconomy?.(from, roles).catch(() => null)) ?? null;
		return economics !== null ? { ...usage, economics } : usage;
	};
	const recorded = async (roles: CallFilter["roles"]): Promise<RunScopeUsageV2 | null> => {
		const usage = (await options.runUsage?.(from, roles).catch(() => null)) ?? null;
		return usage !== null && usage.callIds.length > 0 ? scoped(usage, roles) : null;
	};
	const mainScope = await scoped(main, MAIN_CALL_ROLES);
	const side = await recorded(SIDE_CALL_ROLES);
	const children = await recorded(CHILD_CALL_ROLES);
	if (side === null && children === null) {
		noteMainRunV2({ usage: { main: mainScope } });
		return;
	}
	const allRoles = ALL_CALL_ROLES;
	const total = await options.runUsage?.(from, allRoles).catch(() => null);
	noteMainRunV2({
		usage: {
			main: mainScope,
			...(side ? { side } : {}),
			...(children ? { children } : {}),
			...(total ? { total: await scoped(total, allRoles) } : {}),
		},
	});
}
