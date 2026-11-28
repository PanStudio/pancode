// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { foldAgentRunFrames, hypothesisFromSummary } from "./agent.ts";
import { budgetStop, costFromPricing } from "./budget.ts";
import { describeGrade } from "./format.ts";
import { inScope } from "./glob.ts";
import { aaIsNoisy, aaLabel, grade } from "./grader.ts";
import { researchElapsedMs } from "./resume.ts";
import { parseJournal } from "./store.ts";

const base = { direction: "min" as const, minImprovement: 0.05, seed: 7, resamples: 2000 };

describe("research scope", () => {
	it("lets scope wildcards cross dot segments while literal names stay exact", () => {
		ok(inScope(".github/workflows/ci.yml", ["**"]));
		ok(inScope(".github/workflows/ci.yml", ["**/*.yml"]));
		ok(inScope("src/.cache/a.ts", ["src/**/*.ts"]));
		ok(inScope(".env", ["*"]));
		ok(inScope(".github/workflows/ci.yml", [".github/**"]));
		ok(inScope("src/a.ts", []));
		ok(!inScope(".github/workflows/ci.yml", ["src/**"]));
		ok(!inScope(".github/x.yml", [".gitlab/**"]));
		ok(!inScope("src/a.ts", ["src/*.js"]));
		ok(inScope(".github/.cache/ci.yml", ["{.github,src}/**/*.yml"]));
		ok(inScope(".github/.cache/ci.yml", ["[.]github/**/*.yml"]));
		ok(!inScope(".env", ["[!.]*"]));
		ok(inScope("env", ["[!.]*"]));
		ok(!inScope(".github/ci.yml", ["!(.github)/**"]));
		ok(!inScope("src/../x", ["src/**"]));
		ok(inScope("src-other/a.ts", ["!(src)/**"]));
		ok(!inScope("src/unrelated.ts", ["!important.ts"]));
		ok(inScope("!notes.txt", ["[[!]*"]));
		ok(!inScope("^notes.txt", ["[[!]*"]));
		ok(inScope("src/a.ts", ["src\\*.ts"]));
		ok(!inScope("foo*", ["foo\\*"]));
	});
});

describe("research grading", () => {
	it("calls a clear drop improved, the same samples unchanged, and repeats itself under one seed", () => {
		const before = [100, 101, 99, 100, 102];
		const after = [50, 51, 49, 50, 52];
		const improved = grade({ ...base, base: before, candidate: after });
		strictEqual(improved.verdict, "improved");
		ok(improved.ci !== null && improved.ci.high < 0);
		deepStrictEqual(grade({ ...base, base: before, candidate: after }), improved);
		const same = grade({ ...base, base: before, candidate: before });
		strictEqual(same.verdict, "unchanged");
		strictEqual(aaIsNoisy(same), false);
		strictEqual(grade({ ...base, direction: "max", base: before, candidate: after }).verdict, "regressed");
	});

	it("does not call a delta past the threshold improved when the interval straddles zero", () => {
		const verdict = grade({ ...base, base: [100, 100, 100, 100], candidate: [10, 200, 10, 200] }).verdict;
		ok(verdict === "inconclusive" || verdict === "regressed", verdict);
	});

	it("reads an A/A check whose delta passes the threshold with an interval spanning zero as inconclusive, not quiet", () => {
		const underpowered = grade({ ...base, base: [100, 90, 110, 95, 105], candidate: [100, 250, 90, 160, 141] });
		strictEqual(underpowered.verdict, "inconclusive");
		ok(underpowered.ci !== null && underpowered.ci.low < 0 && underpowered.ci.high > 0);
		strictEqual(aaIsNoisy(underpowered), false);
		ok(aaLabel(underpowered).startsWith("inconclusive (too few trials"), aaLabel(underpowered));
		const before = [100, 101, 99, 100, 102];
		strictEqual(aaLabel(grade({ ...base, base: before, candidate: before })), "quiet");
		strictEqual(aaLabel(grade({ ...base, base: before, candidate: [50, 51, 49, 50, 52] })), "noisy");
	});

	it("labels a sure move inside the threshold below threshold or a small regression, and still unchanged", () => {
		const before = [100, 100.2, 99.8, 100.1, 99.9];
		const lower = grade({ ...base, base: before, candidate: [96, 96.2, 95.8, 96.1, 95.9] });
		strictEqual(lower.verdict, "unchanged");
		ok(
			describeGrade(lower, base).startsWith("below threshold (-4.00% vs required -5.00%), "),
			describeGrade(lower, base),
		);
		const higher = grade({ ...base, base: before, candidate: [103, 103.2, 102.8, 103.1, 102.9] });
		strictEqual(higher.verdict, "unchanged");
		ok(
			describeGrade(higher, base).startsWith("small regression (+3.00%, inside the ±5.00% threshold), "),
			describeGrade(higher, base),
		);
	});
});

describe("research budget", () => {
	it("never counts unknown spend as zero against a cost cap", () => {
		const unknown = costFromPricing([]);
		strictEqual(unknown.kind, "unknown");
		const capped = { maxIterations: 9, maxCostUsd: 1, allowUnpriced: false };
		strictEqual(budgetStop(capped, { iterations: 1, elapsedMs: 0, costs: [unknown] })?.reason, "budget-unenforceable");
		strictEqual(budgetStop({ ...capped, allowUnpriced: true }, { iterations: 1, elapsedMs: 0, costs: [unknown] }), null);
		strictEqual(
			budgetStop(capped, { iterations: 1, elapsedMs: 0, costs: [{ kind: "measured", usd: 1.5 }] })?.reason,
			"max-cost-usd",
		);
		strictEqual(budgetStop(capped, { iterations: 9, elapsedMs: 0, costs: [] })?.reason, "max-iterations");
	});
});

describe("research journal", () => {
	it("keeps every whole event and counts a torn last line as unreadable", () => {
		const read = parseJournal(
			`${JSON.stringify({ type: "stopped", at: "x", reason: "max-iterations", detail: "d", best: "b" })}\n{"type":"agent-fin`,
		);
		strictEqual(read.events.length, 1);
		strictEqual(read.unreadable, 1);
	});

	it("counts wall time from each start to its stop, or to the last event of a run that died", () => {
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const at = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString();
		strictEqual(
			researchElapsedMs([
				{ type: "opened", at: at(0), base: "b", ref: "r" },
				{ type: "stopped", at: at(60), reason: "stopped", detail: "", best: "b" },
				{ type: "resumed", at: at(120), best: "b", iterations: 1, elapsedMs: 60_000, interrupted: [] },
				{ type: "iteration-started", at: at(150), iteration: 2, parent: "b", worktree: "w" },
				{ type: "resumed", at: at(300), best: "b", iterations: 2, elapsedMs: 90_000, interrupted: [2] },
				{ type: "stopped", at: at(310), reason: "max-iterations", detail: "", best: "b" },
			]),
			100_000,
		);
	});
});

describe("research agent runs", () => {
	it("folds a run's frames into its session, answer, outcome and summed spend", () => {
		const usage = (usd: number) => ({ cost: { usd: { measured: usd, estimated: 0, unknownCount: 0 }, free: false } });
		const result = foldAgentRunFrames(
			[
				{ type: "session", id: "s1" },
				{ type: "agent_end", usage: usage(0.25) },
				{ type: "agent_end", usage: usage(0.5) },
				{
					type: "run_end",
					schemaVersion: 3,
					sessionId: "s2",
					outcome: "completed",
					result: { text: "Hypothesis: fewer allocations\nPrediction: faster" },
				},
			],
			0,
			"",
		);
		strictEqual(result.sessionId, "s2");
		strictEqual(result.outcome, "completed");
		deepStrictEqual(result.cost, { kind: "measured", usd: 0.75 });
		deepStrictEqual(hypothesisFromSummary(result.summary), {
			statement: "fewer allocations",
			prediction: "faster",
		});
		const failed = foldAgentRunFrames([], 1, "line one\nboom\n");
		strictEqual(failed.cost.kind, "unknown");
		strictEqual(failed.summary, "line one boom");
	});
});
