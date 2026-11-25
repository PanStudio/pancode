// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { test } from "node:test";
import { taskOverview } from "../client/chat/overview-model.js";
import {
	chipFigures,
	contextFigure,
	quotaCards,
	quotaChip,
	sessionSpend,
	usageReadable,
	usageRows,
	usageSummary,
	usageTotals,
} from "../client/chat/session-usage-model.js";
import type { AgentCapabilities } from "../contracts/capabilities.js";
import type { SessionSnapshot } from "../contracts/sessions.js";
import type { SessionUsage } from "../contracts/usage.js";

test("the turn overview counts turns and wall time and sums no tokens or cost (#434)", () => {
	const turns = [
		{ status: "succeeded", startedAt: "2026-10-30T10:00:00.000Z", finishedAt: "2026-10-30T10:00:30.000Z", usage: null },
		{ status: "running", startedAt: "2026-10-30T10:01:00.000Z", finishedAt: null, usage: null },
	] as unknown as SessionSnapshot["turns"];
	assert.deepEqual(taskOverview(turns, Date.parse("2026-10-30T10:01:10.000Z")), {
		turns: 2,
		elapsedMs: 40_000,
		running: true,
	});
	// With neither a usage read nor telemetry, a session shows no spend: nothing outside the read model folds one.
	assert.deepEqual(sessionSpend({}), {
		known: { tokens: false, cost: false },
		tokens: null,
		cost: null,
		calls: null,
		source: "none",
		refs: { tokens: null, cost: null, calls: null },
	});
	assert.deepEqual(usageSummary(false, undefined, undefined).totals, []);
});

const partial = (measured: number) => ({
	display: `≥${measured.toLocaleString("en-US")} (1 call unknown)`,
	fact: { measured, estimated: 0, unknownCount: 1, absentCount: 0, coverage: { measured: 6, estimated: 0, unknown: 1 } },
});
const unreported = {
	display: "unknown (7 calls unknown)",
	fact: {
		measured: 0,
		estimated: 0,
		unknownCount: 7,
		absentCount: 0,
		coverage: { measured: 0, estimated: 0, unknown: 7 },
	},
};

const telemetry = {
	session: {
		totals: {
			tokens: {
				display: "≥5,120 (1 call unknown)",
				ref: "session:s1#total",
				fact: { measured: 5120, estimated: 0, coverage: { measured: 6, estimated: 0, unknown: 1 } },
			},
			usd: { display: "$0.42 +?", ref: "session:s1#usd", fact: { kind: "measured", value: 0.42 } },
		},
		own: {
			tokens: {
				input: partial(4000),
				output: partial(1120),
				cacheRead: unreported,
				cacheWrite: unreported,
				reasoning: unreported,
				total: partial(5120),
			},
			counts: {
				attempts: {
					fact: {
						measured: 7,
						estimated: 0,
						unknownCount: 0,
						absentCount: 0,
						coverage: { measured: 1, estimated: 0, unknown: 0 },
					},
				},
				calls: { display: "7" },
			},
		},
		overhead: {
			share: { display: "unknown", ref: "session:s1#overhead", fact: { kind: "unknown", reason: "not-observed" } },
		},
	},
	cost: {
		groups: [
			{
				key: "claude-sonnet-5",
				calls: { display: "7" },
				tokens: { display: "≥5,120 (1 call unknown)" },
				usd: { display: "$0.42 +?" },
			},
		],
	},
} as unknown as NonNullable<SessionUsage["telemetry"]>;

test("the usage view renders the read model displays (#434)", () => {
	const withTelemetry = { telemetry, telemetryQuota: { providers: [] } } as unknown as SessionUsage;
	assert.deepEqual(sessionSpend({ usage: withTelemetry }), {
		known: { tokens: true, cost: true },
		tokens: "≥5,120 (1 call unknown)",
		cost: "$0.42 +?",
		calls: "7",
		source: "telemetry",
		refs: { tokens: "session:s1#total", cost: "session:s1#usd", calls: null },
	});
	assert.deepEqual(usageTotals(withTelemetry), [
		{ label: "Cost", value: "$0.42 +?", factRef: "session:s1#usd" },
		{ label: "Tokens", value: "≥5,120", factRef: "session:s1#total" },
		{ label: "Model calls", value: "7", factRef: null },
	]);
	assert.deepEqual(usageRows(withTelemetry), [
		{
			key: "claude-sonnet-5",
			route: "claude-sonnet-5",
			tokens: "≥5,120 tokens",
			cost: "$0.42 +?",
			calls: "7",
			beside: null,
			refs: { tokens: null, cost: null },
		},
	]);
	// A closed task has no usage read; its cold session fold takes the same place.
	assert.equal(sessionSpend({ cold: telemetry.session }).source, "telemetry");
	const summary = usageSummary(true, withTelemetry, undefined);
	assert.equal(summary.source, "telemetry");
	assert.match(summary.note, /telemetry figures/);
	// Each figure keeps its lower-bound mark; the gaps are said once beside the totals, in /usage's words.
	assert.equal(summary.coverage, "No cache read, cache write or reasoning data · 1 call had no usage data.");
});

test("an overhead share nothing reported reads not measured, as every other figure in the pane", () => {
	// Live (gui-r4 #1): the pane said `PanCode overhead unknown` between two `not measured` figures.
	const withTelemetry = { telemetry, telemetryQuota: { providers: [] } } as unknown as SessionUsage;
	assert.deepEqual(usageSummary(true, withTelemetry, undefined).overhead, {
		label: "PanCode overhead",
		value: "not measured",
		factRef: "session:s1#overhead",
	});
	assert.equal(usageSummary(false, undefined, undefined).overhead, null);
});

test("the top bar leaves out a figure nobody measured and falls back to the ledger's context percent", () => {
	const unknown = { fact: { kind: "unknown", reason: "not reported" } as never };
	const cold = {
		...telemetry.session,
		totals: { tokens: { ...unknown, display: "unknown" }, usd: { ...unknown, display: "unknown" } },
	} as never;
	assert.deepEqual(chipFigures(sessionSpend({ cold })), { tokens: null, cost: null });
	const withTelemetry = { telemetry, telemetryQuota: { providers: [] } } as unknown as SessionUsage;
	assert.deepEqual(chipFigures(sessionSpend({ usage: withTelemetry })), {
		tokens: "≥5,120 tok",
		cost: "$0.42 +?",
	});
	assert.deepEqual(contextFigure({ ...unknown, display: "unknown" }, "12%"), { text: "12%", fromShare: false });
	assert.deepEqual(contextFigure({ fact: { kind: "measured", value: 0.3 } as never, display: "30%" }, "12%"), {
		text: "30%",
		fromShare: true,
	});
	assert.equal(contextFigure(undefined, null), null);
});

const quotaWindow = (key: string, used: number | null, resetsAt: string | null = null) => ({
	key,
	label: `${key} window`,
	usedPct:
		used === null
			? { fact: { kind: "unknown", reason: "not reported" }, display: "unknown" }
			: { fact: { kind: "measured", value: used, source: "provider" }, display: `${used}%` },
	resetsAt,
});
const withQuota = (...windows: ReturnType<typeof quotaWindow>[]) =>
	({
		telemetry,
		telemetryQuota: { providers: [{ provider: "anthropic", stale: false, windows }] },
	}) as unknown as SessionUsage;

test("a quota window with no reported share has no share to draw, and a reported one keeps its own", () => {
	const [card] = quotaCards(withQuota(quotaWindow("five-hour", null), quotaWindow("weekly", 42))).cards;
	assert.deepEqual(
		card?.windows.map((window) => [window.label, window.used, window.share]),
		[
			["five-hour window", "unknown", null],
			["weekly window", "42%", 42],
		],
	);
});

test("the quota chip names the fullest window from 80% and turns to failure at 100%", () => {
	assert.equal(quotaChip(undefined), null);
	assert.equal(quotaChip(withQuota(quotaWindow("a", 50), quotaWindow("b", null), quotaWindow("c", 79))), null);
	const chip = quotaChip(withQuota(quotaWindow("a", 50), quotaWindow("b", 86), quotaWindow("c", 91)));
	assert.deepEqual([chip?.text, chip?.tone, chip?.title], ["Quota 91%", "warn", "c window · reset time not reported"]);
	const full = quotaChip(withQuota(quotaWindow("a", 100, "2026-11-14T08:00:00.000Z")));
	assert.equal(full?.tone, "fail");
	assert.match(full?.title ?? "", /^a window · resets \d{4}-\d{2}-\d{2} /u);
});

test("the usage read is asked only of a build that names its session, cost and quota methods", () => {
	const telemetryOf = (methods: Record<string, string>) =>
		({ telemetry: { version: 1, methods, update: "_pancode/telemetry/update" } }) as unknown as AgentCapabilities;
	assert.equal(usageReadable(undefined), false);
	assert.equal(usageReadable(telemetryOf({ session: "s" })), false);
	assert.equal(usageReadable(telemetryOf({ session: "s", cost: "c", quota: "q" })), true);
});
