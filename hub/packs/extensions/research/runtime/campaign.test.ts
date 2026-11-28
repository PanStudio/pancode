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

describe("research wall-deadline gate stop", () => {
	it("stops launching further gates once the wall deadline expires during an earlier gate", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { openResearchCampaign, runResearchCampaign } = await import("./loop.ts");
		const { readJournal } = await import("./store.ts");

		const dir = mkdtempSync(join(tmpdir(), "research-gate-deadline-"));
		const wt = join(dir, "wt");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(wt);
		try {
			const checks = new Map<string, Record<string, unknown>>([
				["bench", { id: "bench", kind: "command", command: ["echo", "1"], cwd: ".", timeoutMs: 1000 }],
				["g1", { id: "g1", kind: "command", command: ["echo", "ok"], cwd: ".", timeoutMs: 1000 }],
				["g2", { id: "g2", kind: "command", command: ["echo", "ok"], cwd: ".", timeoutMs: 1000 }],
			]);
			let clockMs = 0;
			let commits = 0;
			const gateCalls: string[] = [];
			const finishedOutcomes: unknown[] = [];
			let inIteration = false;
			const services = {
				worktrees: {
					create: async ({ base }: { base?: string } = {}) => ({
						id: `t-${++commits}`,
						path: wt,
						cwd: wt,
						head: base ?? "base-sha",
						kept: false,
					}),
					list: async () => [],
					remove: async () => undefined,
					git: async (_place: unknown, args: ReadonlyArray<string>) => {
						const [cmd] = args;
						if (cmd === "rev-parse" && args.includes("--show-toplevel"))
							return { exitCode: 0, stdout: `${dir}\n`, stderr: "" };
						if (cmd === "rev-parse" && args.some((a) => a.endsWith("^{commit}")))
							return { exitCode: 0, stdout: "base-sha\n", stderr: "" };
						if (cmd === "rev-parse" && args.some((a) => a.endsWith("^{tree}"))) {
							const rev = args[args.length - 1] ?? "";
							return { exitCode: 0, stdout: `${rev.replace("^{tree}", "")}-tree\n`, stderr: "" };
						}
						if (cmd === "diff") return { exitCode: 0, stdout: "src/app.ts\0", stderr: "" };
						return { exitCode: 0, stdout: "", stderr: "" };
					},
					checkout: async () => undefined,
					clean: async () => undefined,
					copy: async () => undefined,
					commit: async () => ({ head: "cand-sha", leftOut: [] }),
					refs: {
						get: async () => "base-sha",
						create: async () => undefined,
						swap: async () => true,
					},
				},
				verify: {
					list: async () =>
						[...checks.values()].map((c) => ({
							id: String(c.id),
							kind: String(c.kind),
							command: c.command as string[],
							cwd: ".",
							timeoutMs: 1000,
							inputs: [],
						})),
					resolve: async (id: string) => ({
						ok: true as const,
						kind: "catalog" as const,
						inputs: [],
						check: checks.get(id),
					}),
					check: async (id: string) => {
						if (inIteration) gateCalls.push(id);
						if (inIteration && id === "g1") clockMs += 120_000;
						return { ok: true, execution: "succeeded", validation: "passed", exitCode: 0, text: "ok", receipt: `r-${id}` };
					},
					measure: async (_id: string, _metric: string, place?: unknown) => ({
						ok: true as const,
						value:
							place && typeof place === "object" && "worktree" in place && (place as { worktree: string }).worktree === "t-2"
								? 100
								: 50,
						receipt: "r-bench",
					}),
				},
				claims: {
					hypotheses: async () => ({ H1: "h1" }),
					read: async () => [{ id: "h1", criterion: { kind: "research-objective" } }],
					begin: async () => ({ bench: ["h1"], g1: [], g2: [] }),
					finish: async (_run: string, outcomes: ReadonlyArray<unknown>) => {
						finishedOutcomes.push(...outcomes);
						return {};
					},
				},
			};
			writeFileSync(join(wt, "src.txt"), "ok");
			const campaign = await openResearchCampaign(services as never, {
				root: dir,
				objective: { check: "bench", metric: "ms", direction: "min", minImprovement: 0.05, trials: 3 },
				gates: ["g1", "g2"],
				scope: ["src/**"],
				budget: { maxIterations: 3, maxWallMinutes: 1, allowUnpriced: true },
				allowNoisy: true,
				keep: false,
				agent: { autonomy: "default" },
				pancodeVersion: "0.9.2",
			});
			const outcome = await runResearchCampaign(campaign, {
				root: dir,
				services: services as never,
				clock: () => clockMs,
				agent: async () => {
					inIteration = true;
					return {
						exitCode: 0,
						sessionId: "s1",
						outcome: "completed",
						summary: "Hypothesis: faster\nPrediction: lower ms",
						cost: { kind: "free" },
					};
				},
			});
			strictEqual(outcome.reason, "max-wall-minutes", outcome.detail);
			deepStrictEqual(gateCalls, ["g1"]);
			deepStrictEqual(finishedOutcomes, [
				{ check: "bench", receipt: "r-bench" },
				{ check: "g1", receipt: "r-g1" },
				{ check: "g2", execution: "aborted" },
			]);
			const graded = readJournal(dir, campaign.id).events.find((e) => e.type === "graded");
			ok(graded && graded.type === "graded");
			deepStrictEqual(
				graded.gates.map((g) => [g.check, g.passed, g.execution]),
				[
					["g1", true, "succeeded"],
					["g2", false, "aborted"],
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
