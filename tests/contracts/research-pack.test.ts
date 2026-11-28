// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The research pack's campaign loop on the host's own worktrees, verify and claims services, with a scripted agent in
 * place of `pancode run`. The pack's pure parts are tested in the pack itself.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { PancodeSettings } from "../../src/core/config.js";
import { claimsProjectRoot, readClaims } from "../../src/domains/claims/index.js";
import { extensionInvocation } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { createExtensionClaimsService } from "../../src/domains/extensions/services/claims.js";
import {
	createExtensionCheckReceipts,
	createExtensionVerifyService,
} from "../../src/domains/extensions/services/verify.js";
import { createExtensionWorktreeService } from "../../src/domains/extensions/services/worktrees.js";
import { installExtension } from "../../src/domains/extensions/state.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

interface Campaign {
	id: string;
	base: string;
	ref: string;
	protected: string[];
	objective: { trials: number };
}
interface Outcome {
	reason: string;
	detail: string;
}
interface AgentRequest {
	worktree: string;
	signal?: AbortSignal;
}
interface AgentResult {
	exitCode: number | null;
	sessionId: string | null;
	outcome: string | null;
	summary: string;
	cost: { kind: "free" };
}
interface View {
	best: string;
	state: string;
	stop: { reason: string } | null;
	ratchets: number;
	aa: { noisy: boolean } | null;
	iterations: Array<{ outcome: string; grade: { verdict: string } | null; hypothesisVerdict?: string | null }>;
}
interface LoopDeps {
	root: string;
	services: Services;
	agent: (request: AgentRequest) => Promise<AgentResult>;
	signal?: AbortSignal;
}
type Services = ReturnType<typeof hostServices>["services"];
interface Pack {
	openResearchCampaign(services: Services, input: Record<string, unknown>): Promise<Campaign>;
	runResearchCampaign(campaign: Campaign, deps: LoopDeps): Promise<Outcome>;
	resumeResearchCampaign(campaign: Campaign, deps: LoopDeps): Promise<Outcome>;
	summarizeCampaign(root: string, id: string): View;
	recomputeCampaign(root: string, id: string): { agrees: boolean; grades: unknown[] };
	readJournal(root: string, id: string): { events: Array<{ type: string }> };
}

const RUNTIME = join(process.cwd(), "hub", "packs", "extensions", "research", "runtime");

/** The pack's modules, loaded by path: the pack imports with `.ts` specifiers the root build does not check. */
async function pack(): Promise<Pack> {
	const load = (name: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(RUNTIME, name)).href);
	const [loop, report, store] = await Promise.all([load("loop.ts"), load("report.ts"), load("store.ts")]);
	return { ...loop, ...report, ...store } as unknown as Pack;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
		{ encoding: "utf8" },
	).trim();
}

const check = (id: string, command: string[], extra: Record<string, unknown> = {}) => ({
	id,
	description: id,
	kind: "command",
	command,
	cwd: ".",
	timeoutMs: 30_000,
	tags: [],
	...extra,
});

const scoreJs =
	"process.stdout.write(JSON.stringify({score:Number(require('fs').readFileSync('value.txt','utf8'))}))\n";

function scratchRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pancode-research-pack-")));
	roots.push(root);
	const repo = join(root, "repo");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	return repo;
}

function scoreRepo(extra: Record<string, string> = {}, gates: Array<Record<string, unknown>> = []): string {
	return scratchRepo({
		"value.txt": "100\n",
		"score.js": scoreJs,
		".pancode/verifiers.yaml": JSON.stringify({ version: 2, checks: [check("score", ["node", "score.js"]), ...gates] }),
		...extra,
	});
}

function hostServices(repo: string) {
	const worktrees = createExtensionWorktreeService({ extensionId: "research", workspace: repo });
	const receipts = createExtensionCheckReceipts();
	const verify = createExtensionVerifyService({
		settings: () => ({ safety: { sandbox: "off" } }) as unknown as Pick<PancodeSettings, "safety" | "targets">,
		resolvePlace: (place) => worktrees.resolvePlace(place),
		receipts,
		launch: { file: process.execPath, args: ["-e", "process.exit(9)"], env: {} },
		sourceEnv: {},
		envPolicy: { targets: [], passEnv: [] },
	});
	const claims = createExtensionClaimsService({ extensionId: "research", workspace: repo, sessionId: null, receipts });
	return { services: { worktrees, verify, claims }, root: join(repo, ".pancode", "data", "research") };
}

const done: AgentResult = {
	exitCode: 0,
	sessionId: null,
	outcome: "completed",
	summary: "Hypothesis: a smaller value lowers the score\nPrediction: score halves",
	cost: { kind: "free" },
};

function worktreeCount(repo: string): number {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
}

async function setup(repo: string, gates: string[] = [], maxIterations = 3) {
	const research = await pack();
	const { services, root } = hostServices(repo);
	const campaign = await research.openResearchCampaign(services, {
		root,
		objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
		gates,
		scope: [],
		budget: { maxIterations, allowUnpriced: false },
		allowNoisy: false,
		keep: false,
		agent: {},
		pancodeVersion: "test",
	});
	/** The worktree directory the service gave an iteration. */
	const dir = async (worktree: string): Promise<string> => (await services.worktrees.resolvePlace({ worktree })).cwd;
	return { research, services, root, campaign, dir };
}

describe("research pack campaign", () => {
	it("ratchets a measured improvement, archives protected and no-op changes, and regrades to the same verdicts", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo({ "sane.js": "process.stdout.write(JSON.stringify({ok:1}))\n", "ref.json": '{"ok":1}\n' }, [
			check("sane", ["node", "sane.js"], { kind: "numeric-compare", reference: "ref.json", tolerance: { absolute: 0 } }),
		]);
		const userHead = git(repo, "rev-parse", "HEAD");
		const { research, services, root, campaign, dir } = await setup(repo, ["sane"]);
		ok(campaign.protected.includes("score.js"));
		ok(!campaign.protected.includes("value.txt"));
		strictEqual(campaign.ref, `refs/heads/pancode/research/${campaign.id}`);
		const edits: Array<(worktree: string) => void> = [
			(worktree) => writeFileSync(join(worktree, "value.txt"), "50\n"),
			(worktree) => writeFileSync(join(worktree, "score.js"), "process.stdout.write('{\"score\":0}')\n"),
			() => {},
		];
		let calls = 0;
		const outcome = await research.runResearchCampaign(campaign, {
			root,
			services,
			agent: async (request) => {
				edits[calls++]?.(await dir(request.worktree));
				return done;
			},
		});
		strictEqual(outcome.reason, "max-iterations", outcome.detail);
		strictEqual(calls, 3);
		// The request ends: the host removes the base worktree the campaign did not keep.
		await services.worktrees.dispose();

		const view = research.summarizeCampaign(root, campaign.id);
		strictEqual(view.aa?.noisy, false);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted", "protected", "no-op"],
		);
		strictEqual(view.iterations[0]?.grade?.verdict, "improved");
		strictEqual(view.ratchets, 1);
		strictEqual(git(repo, "rev-parse", campaign.ref), view.best);
		strictEqual(git(repo, "show", `${view.best}:value.txt`), "50");
		strictEqual(git(repo, "rev-parse", "HEAD"), userHead);
		strictEqual(readFileSync(join(repo, "value.txt"), "utf8"), "100\n");
		strictEqual(worktreeCount(repo), 1);

		const report = research.recomputeCampaign(root, campaign.id);
		strictEqual(report.agrees, true);
		strictEqual(report.grades.length, 2);

		const claims = readClaims(claimsProjectRoot(repo));
		ok(claims.records.some((claim) => claim.keys.check === "sane"));
		strictEqual(claims.hypotheses.length, 1);
		strictEqual(claims.hypothesisTests.length, 1);
		strictEqual(claims.hypothesisTests[0]?.outcome, "tested");
		strictEqual(claims.hypothesisTests[0]?.execution, "succeeded");
		strictEqual(view.iterations[0]?.hypothesisVerdict, "supported");
	});

	it("tests the hypothesis on the measurement's own runs: failed when one fails, aborted when stopped mid-measure", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const { research, services, root, campaign, dir } = await setup(repo);
		const controller = new AbortController();
		let calls = 0;
		let stopOnCandidate = false;
		const checked: string[] = [];
		const verify = {
			...services.verify,
			check: (...args: Parameters<typeof services.verify.check>) => {
				checked.push(args[0]);
				return services.verify.check(...args);
			},
			measure: async (...args: Parameters<typeof services.verify.measure>) => {
				const value = await services.verify.measure(...args);
				if (stopOnCandidate && value.ok && value.value === 50) controller.abort();
				return value;
			},
		};
		const outcome = await research.runResearchCampaign(campaign, {
			root,
			services: { ...services, verify },
			signal: controller.signal,
			agent: async (request) => {
				calls++;
				const worktree = await dir(request.worktree);
				if (calls === 1) writeFileSync(join(worktree, "value.txt"), "oops\n");
				else {
					writeFileSync(join(worktree, "value.txt"), "50\n");
					stopOnCandidate = true;
				}
				return done;
			},
		});
		strictEqual(outcome.reason, "stopped", outcome.detail);
		strictEqual(calls, 2);
		await services.worktrees.dispose();
		const view = research.summarizeCampaign(root, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["measure-failed", "interrupted"],
		);
		const claims = readClaims(claimsProjectRoot(repo));
		strictEqual(claims.records.length, 0);
		ok(claims.hypothesisTests.every((test) => test.outcome === "tested" && test.claim === undefined));
		// Each run tests every proposed hypothesis naming the objective: the second iteration's stop tests both.
		const [first, second] = claims.hypotheses.map((hypothesis) => hypothesis.id);
		const executions = (id: string | undefined) =>
			claims.hypothesisTests.filter((test) => test.hypothesis === id).map((test) => test.execution);
		deepStrictEqual(executions(first), ["failed", "aborted"]);
		deepStrictEqual(executions(second), ["aborted"]);
		// The plain objective is never run again on the candidate for its receipt.
		deepStrictEqual(checked, []);
	});

	it("refuses a tracked check input with uncommitted changes, which every iteration commit would carry", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		writeFileSync(join(repo, "score.js"), `${scoreJs}// local edit\n`);
		await rejects(
			setup(repo),
			/check 'score': score\.js has uncommitted changes; commit it, every research worktree starts from HEAD/u,
		);
		git(repo, "checkout", "--", "score.js");
		writeFileSync(join(repo, "extra.txt"), "untracked input is fine\n");
		const { campaign } = await setup(repo);
		ok(campaign.id.startsWith("r"));
	});

	it("continues a stopped campaign at its next iteration from the kept commit, without a second A/A check", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const { research, services, root, campaign, dir } = await setup(repo);
		const controller = new AbortController();
		let calls = 0;
		const outcome = await research.runResearchCampaign(campaign, {
			root,
			services,
			signal: controller.signal,
			agent: async (request) => {
				calls += 1;
				if (calls === 1) {
					writeFileSync(join(await dir(request.worktree), "value.txt"), "50\n");
					return done;
				}
				controller.abort();
				return { ...done, exitCode: 130, outcome: "interrupted" };
			},
		});
		strictEqual(outcome.reason, "stopped", outcome.detail);
		const kept = research.summarizeCampaign(root, campaign.id).best;
		strictEqual(git(repo, "show", `${kept}:value.txt`), "50");
		await services.worktrees.dispose();
		strictEqual(worktreeCount(repo), 1);

		const parents: string[] = [];
		const resumed = await research.resumeResearchCampaign(campaign, {
			root,
			services,
			agent: async (request) => {
				const worktree = await dir(request.worktree);
				parents.push(git(worktree, "rev-parse", "HEAD"));
				writeFileSync(join(worktree, "value.txt"), "20\n");
				return done;
			},
		});
		strictEqual(resumed.reason, "max-iterations", resumed.detail);
		strictEqual(parents.length, 1);
		strictEqual(git(repo, "rev-parse", `${parents[0]}^{tree}`), git(repo, "rev-parse", `${kept}^{tree}`));
		const view = research.summarizeCampaign(root, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted", "interrupted", "ratcheted"],
		);
		strictEqual(git(repo, "show", `${view.best}:value.txt`), "20");
		const events = research.readJournal(root, campaign.id).events;
		strictEqual(events.filter((event) => event.type === "aa").length, 1);
		strictEqual(events.filter((event) => event.type === "resumed").length, 1);
		await services.worktrees.dispose();
		strictEqual(worktreeCount(repo), 1);

		await rejects(
			research.resumeResearchCampaign(campaign, { root, services, agent: async () => done }),
			(error: Error) => error.name === "ResearchResumeError" && /budget is spent \(max-iterations/u.test(error.message),
		);
	});

	it("refuses a campaign another run holds, and one whose branch something else moved", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const { research, services, root, campaign } = await setup(repo, [], 2);
		const controller = new AbortController();
		const first = await research.runResearchCampaign(campaign, {
			root,
			services,
			signal: controller.signal,
			agent: async () => {
				controller.abort();
				return { ...done, exitCode: 130, outcome: "interrupted" };
			},
		});
		strictEqual(first.reason, "stopped", first.detail);

		const best = git(repo, "rev-parse", campaign.ref);
		writeFileSync(join(repo, "value.txt"), "1\n");
		git(repo, "commit", "-qam", "elsewhere");
		git(repo, "update-ref", campaign.ref, "HEAD");
		await rejects(
			research.resumeResearchCampaign(campaign, { root, services, agent: async () => done }),
			(error: Error) => error.name === "ResearchResumeError" && /something else moved it/u.test(error.message),
		);
		git(repo, "update-ref", campaign.ref, best);

		let held: () => void = () => {};
		const holding = new Promise<void>((resolve) => {
			held = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = research.resumeResearchCampaign(campaign, {
			root,
			services,
			agent: async () => {
				held();
				await gate;
				return done;
			},
		});
		await holding;
		await rejects(
			research.resumeResearchCampaign(campaign, { root, services, agent: async () => done }),
			(error: Error) =>
				error.name === "ResearchResumeError" && /is already running \(since .+\); stop it first/u.test(error.message),
		);
		release();
		strictEqual((await running).reason, "max-iterations");
	});
});

describe("research pack panel", () => {
	it("opens from /research alone and refreshes the campaign it shows, through the host's declared state", async (t) => {
		const env = await isolatePancodeEnv("pancode-research-pack-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const { campaign } = await setup(repo, [], 1);
		const packDir = join(process.cwd(), "hub", "packs", "extensions", "research");
		ok(installExtension(packDir, { cwd: repo, scope: "user" }).extension?.loadable);
		const host = new OperatorExtensions({
			context: () => ({ workspace: repo, sessionId: "s1", mode: "interactive" }),
			isIdle: () => true,
			onlyId: "research",
		});
		t.after(() => host.dispose());
		strictEqual((await host.reload("startup")).status, "committed");
		const list = await host.invoke(extensionInvocation("research", "research"), "");
		strictEqual(list.panel?.meta, "1 campaign(s)", list.text);
		await host.action("research", { id: "open", key: campaign.id, source: "panel" });
		const refreshed = await host.action("research", { id: "refresh", source: "panel" });
		strictEqual(refreshed.panel?.title, `Research · ${campaign.id}`, refreshed.text);
	});
});
