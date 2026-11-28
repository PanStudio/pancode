// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The campaign state machine, on the host's worktrees, verify, claims and runs services. `openResearchCampaign`
 * validates the objective against the project's verifier catalog, freezes the checks, creates the research branch at
 * HEAD and writes `campaign.json`. `runResearchCampaign` then runs the A/A check and the iterations: PLAN+EDIT (one
 * agent run in a fresh worktree at the current best commit), VERIFY (no-op, duplicate, protected and scope rules),
 * MEASURE (interleaved pairs), GRADE, RATCHET (compare-and-swap of the research branch) and RECORD (hypothesis, check
 * start, claims and test in the claims ledger). Every step lands in the journal before the next begins. Budget stops
 * are checked before each iteration, and an abort writes `stopped`.
 *
 * Every worktree starts from a commit with the check inputs copied in as the workspace holds them (the verifier
 * catalog, and the untracked files a check names). The host re-reads the catalog wherever a check runs, so each new
 * worktree must still declare the checks the campaign froze; one that does not stops the campaign.
 */
import { createHash } from "node:crypto";
import type {
	ExtensionCheckResult,
	ExtensionClaims,
	ExtensionMeasureResult,
	ExtensionVerify,
	ExtensionWorkPlace,
	ExtensionWorktree,
	ExtensionWorktrees,
} from "pancode/sdk/extension";
import { type AgentRunner, hypothesisFromSummary, iterationPrompt } from "./agent.ts";
import { budgetStop, nextRunLimits } from "./budget.ts";
import { describeGrade } from "./format.ts";
import { inScope } from "./glob.ts";
import { aaIsNoisy, aaLabel, grade } from "./grader.ts";
import {
	changeReachesProtected,
	filesNamedByCheck,
	fingerprintChanges,
	fingerprintEntries,
	measurePairs,
	withinEntries,
} from "./protect.ts";
import {
	beginIterationRecord,
	finishIterationRecord,
	type ResearchCheckOutcome,
	researchHypothesisVerdict,
} from "./record.ts";
import { planResearchResume, type ResearchResumeState } from "./resume.ts";
import {
	appendJournal,
	CampaignBusyError,
	newResearchCampaignId,
	readJournal,
	samplesName,
	withCampaignLock,
	writeCampaign,
	writeSamples,
} from "./store.ts";
import {
	type DeclaredCheck,
	RESEARCH_BOOTSTRAP_RESAMPLES,
	RESEARCH_CAMPAIGN_VERSION,
	RESEARCH_REF_PREFIX,
	type ResearchArchiveReason,
	type ResearchAutonomy,
	type ResearchBudget,
	type ResearchCampaign,
	type ResearchCost,
	type ResearchGateResult,
	type ResearchJournalEvent,
	type ResearchObjective,
	type ResearchStopReason,
} from "./types.ts";

export const PROJECT_VERIFIER_CATALOG_RELATIVE_PATH = ".pancode/verifiers.yaml";
/** A command runs at most a day; a run stops itself this long before, so it writes `stopped` and can be resumed. */
export const RESEARCH_REQUEST_LIMIT_MS = 24 * 60 * 60_000 - 5 * 60_000;
/** The runs service's ceiling on one agent run, the manifest's `runs.maxTimeoutSeconds`. */
const MAX_AGENT_TIMEOUT_SECONDS = 86_400;

/** The host services a campaign needs. */
export interface ResearchServices {
	worktrees: ExtensionWorktrees;
	verify: ExtensionVerify;
	claims: ExtensionClaims;
}

export interface OpenCampaignInput {
	/** The extension's project directory, where `<id>/campaign.json` and the journal live. */
	root: string;
	objective: ResearchObjective;
	gates: ReadonlyArray<string>;
	scope: ReadonlyArray<string>;
	budget: ResearchBudget;
	allowNoisy: boolean;
	keep: boolean;
	/** Absent is `default`; `yolo` runs every iteration's agent at contained yolo. */
	agent: { target?: string; model?: string; goal?: string; autonomy?: ResearchAutonomy };
	pancodeVersion: string;
	seed?: number;
	now?: Date;
}

export class ResearchOpenError extends Error {}

/** The campaign is running in another process, or its journal says it cannot go on. */
export class ResearchResumeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResearchResumeError";
	}
}

class CatalogDriftError extends Error {}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function checksDigest(checks: ReadonlyArray<DeclaredCheck>): string {
	return sha256Hex(JSON.stringify(checks));
}

/** A check's definition without where it was read from, which differs between the workspace and a worktree. */
function definition(check: Readonly<Record<string, unknown>>, id: string): string {
	const { runs: _runs, source: _source, ...rest } = check;
	return JSON.stringify({ ...rest, id });
}

/** A check whose run is judged into a claim: its result is a pass or fail against a reference, not just an exit code. */
function judgedKind(check: DeclaredCheck): boolean {
	return check.kind === "numeric-compare" || check.kind === "reproduce";
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim().slice(0, 300);
}

/** Read-only git through the worktrees service; a non-zero exit throws its stderr. */
async function git(
	worktrees: ExtensionWorktrees,
	place: ExtensionWorkPlace,
	args: ReadonlyArray<string>,
): Promise<string> {
	const result = await worktrees.git(place, args);
	if (result.exitCode !== 0)
		throw new Error(result.stderr.trim() || `git ${args[0] ?? ""} exited with code ${result.exitCode}`);
	return result.stdout;
}

const nulList = (out: string): string[] => out.split("\0").filter((entry) => entry.length > 0);

async function resolveCommit(worktrees: ExtensionWorktrees, rev: string): Promise<string | null> {
	const result = await worktrees.git("workspace", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function treeOf(worktrees: ExtensionWorktrees, commit: string): Promise<string> {
	return (await git(worktrees, "workspace", ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`])).trim();
}

async function changedPaths(worktrees: ExtensionWorktrees, from: string, to: string): Promise<string[]> {
	return nulList(await git(worktrees, "workspace", ["diff", "--name-only", "--no-renames", "-z", from, to]));
}

/**
 * Untracked, unignored entries of a worktree, repository-relative. A directory that holds only untracked files is one
 * `dir/` entry, so a cache directory a check creates is named once whatever files land in it later.
 */
async function untrackedEntries(worktrees: ExtensionWorktrees, id: string): Promise<string[]> {
	return nulList(
		await git(worktrees, { worktree: id }, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=normal",
			"--no-renames",
		]),
	)
		.filter((entry) => entry.startsWith("?? "))
		.map((entry) => entry.slice(3));
}

/**
 * Untracked and ignored entries of a worktree; a wholly untracked or ignored directory is one `dir/` entry. Taken
 * before the agent runs, it is the environment a candidate keeps (the copied check inputs, an installed dependency).
 */
async function environmentEntries(
	worktrees: ExtensionWorktrees,
	id: string,
): Promise<{ all: string[]; untracked: string[] }> {
	const entries = nulList(
		await git(worktrees, { worktree: id }, [
			"status",
			"--porcelain=v1",
			"-z",
			"--ignored",
			"--untracked-files=normal",
			"--no-renames",
		]),
	).filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "));
	return {
		all: entries.map((entry) => entry.slice(3)),
		untracked: entries.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)),
	};
}

/**
 * How HEAD holds a workspace path: `missing` when HEAD has no file there, `changed` when the workspace adds, edits or
 * removes a file under it (ignored files aside), `same` otherwise.
 */
async function committedState(
	worktrees: ExtensionWorktrees,
	base: string,
	path: string,
): Promise<"missing" | "changed" | "same"> {
	const spec = `:(literal)${path}`;
	if ((await git(worktrees, "workspace", ["ls-tree", "-r", "--name-only", "-z", base, "--", spec])).length === 0)
		return "missing";
	const changed = await git(worktrees, "workspace", [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--no-renames",
		"--",
		spec,
	]);
	return changed.length > 0 ? "changed" : "same";
}

/**
 * The workspace files every campaign worktree needs copied in: the verifier catalog and the untracked files the
 * checks name. A tracked file with uncommitted changes is refused: the copy would land in every candidate's commit,
 * and every research worktree starts from HEAD.
 */
async function campaignInputs(services: ResearchServices, checks: ReadonlyArray<DeclaredCheck>): Promise<string[]> {
	const inputs = new Set<string>();
	for (const check of checks) {
		const resolved = await services.verify.resolve(check.id);
		if (!resolved.ok) throw new ResearchOpenError(`check '${check.id}': ${resolved.message}`);
		for (const input of resolved.inputs) {
			if (inputs.has(input)) continue;
			const status = await git(services.worktrees, "workspace", [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--no-renames",
				"--",
				`:(literal)${input}`,
			]);
			if (nulList(status).some((entry) => !entry.startsWith("?? ")))
				throw new ResearchOpenError(
					`check '${check.id}': ${input} has uncommitted changes; commit it, every research worktree starts from HEAD`,
				);
			inputs.add(input);
		}
	}
	return [...inputs].sort();
}

/** Refuse a worktree whose catalog no longer declares a frozen check as the campaign froze it. */
async function assertCatalogUnchanged(
	verify: ExtensionVerify,
	worktree: ExtensionWorktree,
	checks: ReadonlyArray<DeclaredCheck>,
): Promise<void> {
	for (const check of checks) {
		const resolved = await verify.resolve(check.id, { worktree: worktree.id });
		if (
			!resolved.ok ||
			resolved.check === undefined ||
			definition(resolved.check, check.id) !== definition(check, check.id)
		)
			throw new CatalogDriftError("the verifier catalog changed since the campaign opened");
	}
}

/** Validate the objective, freeze its checks, create the research branch at HEAD and write `campaign.json`. */
export async function openResearchCampaign(
	services: ResearchServices,
	input: OpenCampaignInput,
): Promise<ResearchCampaign> {
	const { worktrees, verify } = services;
	let project: string;
	try {
		const top = await worktrees.git("workspace", ["rev-parse", "--show-toplevel"]);
		if (top.exitCode !== 0) throw new Error(top.stderr);
		project = top.stdout.trim();
	} catch {
		throw new ResearchOpenError("research needs a git repository; this directory is not in one");
	}
	const base = await resolveCommit(worktrees, "HEAD");
	if (base === null)
		throw new ResearchOpenError("the repository has no commits; commit the code the campaign starts from");
	let declared: Awaited<ReturnType<ExtensionVerify["list"]>>;
	try {
		declared = await verify.list();
	} catch (error) {
		throw new ResearchOpenError(`the verifier catalog cannot be read: ${errorText(error).replace(/^verify: /u, "")}`);
	}
	const undeclared = (id: string): ResearchOpenError =>
		new ResearchOpenError(
			`check '${id}' is not declared in ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}${declared.length > 0 ? ` (declared: ${declared.map((entry) => entry.id).join(", ")})` : ""}`,
		);
	const resolveDeclared = async (id: string): Promise<{ check: Readonly<Record<string, unknown>>; run?: string }> => {
		const resolved = await verify.resolve(id);
		if (!resolved.ok) throw new ResearchOpenError(`check '${id}': ${resolved.message}`);
		if (resolved.check === undefined) throw undeclared(id);
		return { check: resolved.check, ...(resolved.run !== undefined ? { run: resolved.run } : {}) };
	};
	const freeze = (check: Readonly<Record<string, unknown>>, id: string): DeclaredCheck => {
		const { runs: _runs, ...rest } = check;
		return { ...rest, id, kind: String(check.kind) } as DeclaredCheck;
	};
	// One run of a sweep is frozen as its own check, `<id>/<run>`, with the run directory on its argv as verify runs
	// it. Each worktree starts from the base commit, so the run directory must be committed exactly as checked out.
	const sweepRun = async (owner: string, run: string): Promise<DeclaredCheck> => {
		const id = `${owner}/${run}`;
		const resolved = await resolveDeclared(id);
		const directory = resolved.run ?? run;
		const state = await committedState(worktrees, base, directory);
		if (state !== "same")
			throw new ResearchOpenError(
				`check '${id}': run directory ${directory} ${state === "missing" ? "is not committed" : "has uncommitted changes"}; commit it, every research worktree starts from HEAD`,
			);
		return freeze(resolved.check, id);
	};
	const find = async (id: string): Promise<DeclaredCheck> => {
		const entry = declared.find((check) => check.id === id);
		if (entry === undefined) {
			const separator = id.indexOf("/");
			const owner = separator > 0 ? declared.find((check) => check.id === id.slice(0, separator)) : undefined;
			if (owner?.runs === undefined) throw undeclared(id);
			return sweepRun(owner.id, id.slice(separator + 1));
		}
		const { check } = await resolveDeclared(id);
		if (entry.runs !== undefined)
			throw new ResearchOpenError(
				`check '${id}' is a sweep over ${String(check.runs ?? "its runs")}; name one run as ${id}/<run> (runs: ${entry.runs.join(", ") || "none"})`,
			);
		return freeze(check, id);
	};
	// A gate naming a whole sweep gates on every run of it.
	const gateIdsOf = async (id: string): Promise<string[]> => {
		const sweep = declared.find((entry) => entry.id === id && entry.runs !== undefined);
		if (sweep?.runs === undefined) return [id];
		if (sweep.runs.length === 0) {
			const { check } = await resolveDeclared(id);
			throw new ResearchOpenError(`gate '${id}' is a sweep with no runs under ${String(check.runs)}`);
		}
		return sweep.runs.map((run) => `${id}/${run}`);
	};
	const objectiveCheck = await find(input.objective.check);
	if (objectiveCheck.kind === "reproduce")
		throw new ResearchOpenError(
			`check '${objectiveCheck.id}' is a reproduce check; an objective must print a numeric payload (command, numeric-compare or perf-budget); use it as a --gate`,
		);
	// A --gate naming the objective stays a gate, and a judged objective is always one: its reference comparison must
	// pass before a candidate can ratchet. The check itself is frozen once.
	const named: string[] = [];
	for (const id of input.gates) named.push(...(await gateIdsOf(id)));
	const gateIds = [...new Set([...(judgedKind(objectiveCheck) ? [objectiveCheck.id] : []), ...named])];
	const gates: DeclaredCheck[] = [];
	for (const id of gateIds) if (id !== objectiveCheck.id) gates.push(await find(id));
	const checks = [objectiveCheck, ...gates];
	const inputs = await campaignInputs(services, checks);
	// What the checks name is read where a candidate runs: a worktree at the base with the inputs copied in.
	const probe = await worktrees.create({ base, copy: inputs });
	let protectedPaths: string[];
	try {
		protectedPaths = [
			PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
			...checks.flatMap((check) => filesNamedByCheck(check, probe.path)),
		];
	} finally {
		await worktrees.remove(probe.id).catch(() => undefined);
	}
	const now = input.now ?? new Date();
	const id = newResearchCampaignId(now);
	const ref = `${RESEARCH_REF_PREFIX}${id}`;
	const campaign: ResearchCampaign = {
		version: RESEARCH_CAMPAIGN_VERSION,
		id,
		createdAt: now.toISOString(),
		project,
		objective: { ...input.objective },
		gates: gateIds,
		scope: [...input.scope],
		protected: [...new Set(protectedPaths)].sort(),
		budget: { ...input.budget },
		allowNoisy: input.allowNoisy,
		keep: input.keep,
		agent: {
			autonomy: input.agent.autonomy ?? "default",
			...(input.agent.target !== undefined ? { target: input.agent.target } : {}),
			...(input.agent.model !== undefined ? { model: input.agent.model } : {}),
			...(input.agent.goal !== undefined ? { goal: input.agent.goal } : {}),
		},
		base,
		ref,
		checks,
		checkDigest: checksDigest(checks),
		seed: input.seed ?? Number.parseInt(sha256Hex(id).slice(0, 8), 16),
		resamples: RESEARCH_BOOTSTRAP_RESAMPLES,
		pancodeVersion: input.pancodeVersion,
	};
	try {
		await worktrees.refs.create(id, base);
	} catch (error) {
		throw new ResearchOpenError(`cannot create ${ref}: ${errorText(error)}`);
	}
	writeCampaign(input.root, campaign);
	appendJournal(input.root, id, { type: "opened", at: now.toISOString(), base, ref });
	return campaign;
}

export interface ResearchLoopDeps {
	/** The extension's project directory holding the campaign. */
	root: string;
	services: ResearchServices;
	agent: AgentRunner;
	/** Monotonic milliseconds for the wall budget. */
	clock?: () => number;
	now?: () => Date;
	log?: (line: string) => void;
	/** The operator's stop: the request's own signal. */
	signal?: AbortSignal;
	/** How long this run may go before it stops to be resumed; {@link RESEARCH_REQUEST_LIMIT_MS} by default. */
	requestLimitMs?: number;
}

export interface ResearchRunOutcome {
	reason: ResearchStopReason;
	detail: string;
	best: string;
	iterations: number;
}

async function withCampaignRun<T>(root: string, campaign: ResearchCampaign, fn: () => Promise<T>): Promise<T> {
	try {
		return await withCampaignLock(root, campaign.id, fn);
	} catch (error) {
		if (error instanceof CampaignBusyError) throw new ResearchResumeError(error.message);
		throw error;
	}
}

/** Run the A/A check and the iterations until a budget stop, an abort or an error. */
export async function runResearchCampaign(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
): Promise<ResearchRunOutcome> {
	return withCampaignRun(deps.root, campaign, () => runCampaignLoop(campaign, deps, null));
}

/**
 * Pick a stopped or abandoned campaign up again where its journal ends. Refused while another process runs it, when
 * its A/A check called a change, when its budget is already spent, or when something else moved its branch.
 * Iterations no run finished are archived as interrupted, a `resumed` event records what carried over, and the loop
 * continues at the next iteration from the best commit with the same budget. The host removes the worktrees a dead
 * run did not keep.
 */
export async function resumeResearchCampaign(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
): Promise<ResearchRunOutcome> {
	return withCampaignRun(deps.root, campaign, async () => {
		const root = deps.root;
		const refHead = await deps.services.worktrees.refs.get(campaign.id);
		const plan = planResearchResume(campaign, readJournal(root, campaign.id).events, refHead);
		if (!plan.ok) throw new ResearchResumeError(`cannot resume ${campaign.id}: ${plan.reason}`);
		const at = (deps.now ?? (() => new Date()))().toISOString();
		for (const iteration of plan.interrupted)
			appendJournal(root, campaign.id, {
				type: "archived",
				at,
				iteration,
				reason: "interrupted",
				detail: "the campaign process ended before this iteration finished",
			});
		const { best, iterations, elapsedMs } = plan.state;
		appendJournal(root, campaign.id, { type: "resumed", at, best, iterations, elapsedMs, interrupted: plan.interrupted });
		deps.log?.(
			`resumed at ${best.slice(0, 12)} after ${iterations} iteration(s) and ${(elapsedMs / 60_000).toFixed(1)} minute(s)${plan.interrupted.length > 0 ? `; archived unfinished iteration(s) ${plan.interrupted.join(", ")}` : ""}`,
		);
		return runCampaignLoop(campaign, deps, plan.state);
	});
}

type HaltReason = "stopped" | "max-wall-minutes" | "request-limit";

async function runCampaignLoop(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
	resume: ResearchResumeState | null,
): Promise<ResearchRunOutcome> {
	const { worktrees, verify, claims } = deps.services;
	const root = deps.root;
	const clock = deps.clock ?? (() => performance.now());
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (() => {});
	const operator = deps.signal;
	const at = (): string => now().toISOString();
	const journal = (event: ResearchJournalEvent): void => appendJournal(root, campaign.id, event);
	const objectiveCheck = campaign.checks[0] as DeclaredCheck;
	const gateIds = new Set(campaign.gates);
	if (judgedKind(objectiveCheck)) gateIds.add(objectiveCheck.id);
	const gateChecks = [...gateIds].flatMap((id) => campaign.checks.filter((check) => check.id === id));
	const metric = campaign.objective.metric;
	const measure = (place: ExtensionWorktree): Promise<ExtensionMeasureResult> =>
		verify.measure(objectiveCheck.id, metric, { worktree: place.id });
	const gate = (place: ExtensionWorktree, check: DeclaredCheck): Promise<ExtensionCheckResult> =>
		verify.check(check.id, { worktree: place.id });
	const started = clock();
	const requestLimitMs = deps.requestLimitMs ?? RESEARCH_REQUEST_LIMIT_MS;
	// Wall time earlier runs of a resumed campaign already used.
	const priorMs = resume?.elapsedMs ?? 0;
	const elapsed = (): number => priorMs + clock() - started;
	// The operator's stop, the campaign's wall deadline or this run's own limit cancels the agent run in flight. A
	// check in flight runs out (the operator's stop ends it through the host); nothing graded after a halt ratchets.
	const wallMs = campaign.budget.maxWallMinutes === undefined ? undefined : campaign.budget.maxWallMinutes * 60_000;
	const control = new AbortController();
	const signal = control.signal;
	let deadlineHit = false;
	let requestLimitHit = false;
	const onOperatorAbort = (): void => control.abort(operator?.reason);
	if (operator?.aborted) control.abort(operator.reason);
	else operator?.addEventListener("abort", onOperatorAbort, { once: true });
	const timers: ReturnType<typeof setTimeout>[] = [];
	const schedule = (ms: number, fire: () => void): void => {
		const timer = setTimeout(fire, Math.max(1, Math.min(ms, 2_147_483_647)));
		timer.unref?.();
		timers.push(timer);
	};
	if (wallMs !== undefined)
		schedule(wallMs - priorMs, () => {
			deadlineHit = true;
			control.abort(new Error("research wall deadline"));
		});
	schedule(requestLimitMs, () => {
		requestLimitHit = true;
		control.abort(new Error("research run limit"));
	});
	const costs: ResearchCost[] = [...(resume?.costs ?? [])];
	let best = resume?.best ?? campaign.base;
	let iterations = resume?.iterations ?? 0;
	// Untracked files the declared checks create when they run (interpreter caches, build output). An agent that runs
	// the checks itself leaves them beside its edit; committing them archived a good change as out of scope.
	const checkArtifacts = new Set<string>();
	const learnArtifacts = async (place: ExtensionWorktree, before: ReadonlyArray<string>): Promise<void> => {
		const known = new Set(before);
		for (const entry of await untrackedEntries(worktrees, place.id)) if (!known.has(entry)) checkArtifacts.add(entry);
	};

	const finish = (reason: ResearchStopReason, detail: string): ResearchRunOutcome => {
		journal({ type: "stopped", at: at(), reason, detail, best });
		log(`stopped: ${reason}: ${detail}`);
		return { reason, detail, best, iterations };
	};
	const stoppedByOperator = (): boolean => operator?.aborted === true;
	const pastDeadline = (): boolean => deadlineHit || (wallMs !== undefined && elapsed() >= wallMs);
	const pastRequestLimit = (): boolean => requestLimitHit || clock() - started >= requestLimitMs;
	/** Why the campaign must stop now, if it must: the operator first, then the wall deadline, then this run's limit. */
	const halt = (): { why: HaltReason; reason: ResearchStopReason; archive: ResearchArchiveReason } | null => {
		if (stoppedByOperator()) return { why: "stopped", reason: "stopped", archive: "interrupted" };
		if (pastDeadline()) return { why: "max-wall-minutes", reason: "max-wall-minutes", archive: "deadline" };
		if (pastRequestLimit()) return { why: "request-limit", reason: "stopped", archive: "interrupted" };
		return null;
	};
	const aborted = (): boolean => signal.aborted || halt() !== null;
	const haltDetail = (phase: string): string => {
		const why = halt()?.why ?? "stopped";
		if (why === "max-wall-minutes") return `the ${campaign.budget.maxWallMinutes} minute wall budget ran out ${phase}`;
		if (why === "request-limit")
			return `this run reached its ${Math.round(requestLimitMs / 60_000)} minute limit ${phase}; continue with pancode research resume ${campaign.id}`;
		return `interrupted ${phase}`;
	};
	/** Seconds the next agent run may take: what the wall budget and this run's limit leave, at most a day. */
	const agentTimeoutSeconds = (limit: number | undefined): number => {
		const left = Math.floor((requestLimitMs - (clock() - started)) / 1000);
		return Math.max(1, Math.min(MAX_AGENT_TIMEOUT_SECONDS, left, limit ?? MAX_AGENT_TIMEOUT_SECONDS));
	};

	try {
		const inputs = await campaignInputs(deps.services, campaign.checks);
		const open = async (commit: string, keep: boolean): Promise<ExtensionWorktree> => {
			const created = await worktrees.create({ base: commit, copy: inputs, keep });
			await assertCatalogUnchanged(verify, created, campaign.checks);
			return created;
		};
		const baseWorktree = await open(best, false);
		const baseUntracked = await untrackedEntries(worktrees, baseWorktree.id);

		if (resume?.aaDone) {
			// The journal keeps the A/A grade. One objective run on the best commit re-learns the output it creates,
			// which a dead process held only in memory.
			log(`learning check output: one run of '${objectiveCheck.id}' and the gates on ${best.slice(0, 12)}`);
			const once = await measure(baseWorktree);
			const onceHalt = halt();
			if (onceHalt !== null) return finish(onceHalt.reason, haltDetail("while running the objective on the best commit"));
			if (!once.ok) return finish("error", `the objective check failed on the best commit: ${once.reason}`);
		} else {
			// A/A: base against base, the same number of pairs an iteration takes.
			log(`A/A check: ${campaign.objective.trials} interleaved pairs of '${objectiveCheck.id}' on the base`);
			const aa = await measurePairs(campaign.objective.trials, () => measure(baseWorktree), aborted);
			const aaHalt = halt();
			if (aaHalt !== null) return finish(aaHalt.reason, haltDetail("during the A/A check"));
			if (!aa.ok) return finish("error", `the objective check failed on the base: ${aa.reason}`);
			const aaSamples = writeSamples(root, campaign.id, {
				iteration: "aa",
				metric,
				baseCommit: best,
				candidateCommit: best,
				pairs: aa.pairs,
			});
			const aaGrade = grade({
				direction: campaign.objective.direction,
				minImprovement: campaign.objective.minImprovement,
				base: aa.pairs.map((pair) => pair.base),
				candidate: aa.pairs.map((pair) => pair.candidate),
				seed: campaign.seed,
				resamples: campaign.resamples,
			});
			const noisy = aaIsNoisy(aaGrade);
			journal({ type: "aa", at: at(), samples: aaSamples, grade: aaGrade, noisy, allowed: !noisy || campaign.allowNoisy });
			log(`A/A: ${aaLabel(aaGrade)} (${describeGrade(aaGrade, campaign.objective)})`);
			if (noisy && !campaign.allowNoisy)
				return finish(
					"noisy",
					`the A/A check already calls a change (${describeGrade(aaGrade, campaign.objective)}); raise --trials, quiet the machine, or pass --allow-noisy`,
				);
		}
		// Each gate runs once on the base too, so what it creates is known before the first iteration commits.
		for (const check of gateChecks) {
			if (aborted()) break;
			if (check.id !== objectiveCheck.id) await gate(baseWorktree, check);
		}
		const learnHalt = halt();
		if (learnHalt !== null) return finish(learnHalt.reason, haltDetail("while running the gates on the base"));
		await learnArtifacts(baseWorktree, baseUntracked);

		const seenTrees = new Set([
			await treeOf(worktrees, campaign.base),
			await treeOf(worktrees, best),
			...(resume?.seenTrees ?? []),
		]);
		for (;;) {
			const state = { iterations, elapsedMs: elapsed(), costs };
			const stop = budgetStop(campaign.budget, state);
			const loopHalt = halt();
			if (loopHalt?.why === "stopped") return finish("stopped", "interrupted");
			if (stop !== null) return finish(stop.reason, stop.detail);
			if (loopHalt !== null) return finish(loopHalt.reason, haltDetail("before the next iteration"));
			iterations += 1;
			const iteration = iterations;
			const name = samplesName(iteration);
			const worktree = await open(best, campaign.keep);
			const environment = await environmentEntries(worktrees, worktree.id);
			const environmentPrint = fingerprintEntries(worktree.path, environment.all);
			journal({ type: "iteration-started", at: at(), iteration, parent: best, worktree: worktree.path });
			log(`iteration ${iteration}: agent run in ${worktree.path}`);
			const archive = (reason: ResearchArchiveReason, detail: string): void => {
				journal({ type: "archived", at: at(), iteration, reason, detail });
				log(`iteration ${iteration}: archived (${reason}): ${detail}`);
			};
			const cleanup = async (): Promise<void> => {
				if (campaign.keep) return;
				await worktrees.remove(worktree.id).catch(() => undefined);
			};
			const limits = nextRunLimits(campaign.budget, state);
			const run = await deps.agent({
				worktree: worktree.id,
				prompt: iterationPrompt(campaign, iteration, readJournal(root, campaign.id).events),
				// Campaigns written before yolo existed carry no other level.
				autonomy: campaign.agent.autonomy === "yolo" ? "yolo" : "default",
				...(campaign.agent.target !== undefined ? { target: campaign.agent.target } : {}),
				...(campaign.agent.model !== undefined ? { model: campaign.agent.model } : {}),
				timeoutSeconds: agentTimeoutSeconds(limits.timeoutSeconds),
				...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}),
				signal,
			});
			costs.push(run.cost);
			journal({
				type: "agent-finished",
				at: at(),
				iteration,
				exitCode: run.exitCode,
				sessionId: run.sessionId,
				outcome: run.outcome,
				summary: run.summary,
				cost: run.cost,
				...(run.autonomy !== undefined ? { autonomy: run.autonomy } : {}),
			});
			if (run.autonomy !== undefined && (run.autonomy.halted !== null || run.autonomy.openDecisions.length > 0))
				log(
					`iteration ${iteration}: yolo ${run.autonomy.halted !== null ? `paused (${run.autonomy.halted.kind}), ` : ""}${run.autonomy.openDecisions.length + run.autonomy.openDecisionsOmitted} open decision(s)`,
				);
			const agentHalt = halt();
			if (agentHalt !== null) {
				const detail = haltDetail("during the agent run");
				archive(agentHalt.archive, detail);
				await cleanup();
				return finish(agentHalt.reason, detail);
			}
			if (run.exitCode !== 0) {
				archive("agent-failed", `the agent run exited ${run.exitCode ?? "by signal"}: ${firstLine(run.summary)}`);
				await cleanup();
				continue;
			}

			// VERIFY. The environment the worktree had before the agent ran (the copied inputs, installed dependencies,
			// build output) is kept for measurement, so the agent may not change it; a change rejects the candidate.
			const environmentChanged = fingerprintChanges(environmentPrint, fingerprintEntries(worktree.path, environment.all));
			if (environmentChanged.length > 0) {
				const shown = environmentChanged.slice(0, 5).join(", ");
				const more = environmentChanged.length > 5 ? ` and ${environmentChanged.length - 5} more` : "";
				archive("protected", `changed the pre-agent environment: ${shown}${more}`);
				await cleanup();
				continue;
			}
			let commit: string;
			try {
				const committed = await worktrees.commit(
					worktree.id,
					`research ${campaign.id} ${name}\n\n${run.summary.slice(0, 2000)}`,
					{ leaveOut: [...checkArtifacts, ...environment.untracked] },
				);
				commit = committed.head;
				const leftOutput = committed.leftOut.filter((path) => withinEntries(path, checkArtifacts));
				if (leftOutput.length > 0) log(`iteration ${iteration}: left out check output ${leftOutput.join(", ")}`);
				// Measure the commit in the environment the worktree had before the agent ran: whatever the agent
				// left untracked or ignored, check output and installs included, goes, so a file it planted cannot
				// steer the score. The checks recreate their own output.
				await worktrees.clean(worktree.id, { keep: environment.all });
			} catch (error) {
				archive("agent-failed", `the change could not be committed: ${errorText(error)}`);
				await cleanup();
				continue;
			}
			const tree = await treeOf(worktrees, commit);
			const changed = commit === best ? [] : await changedPaths(worktrees, best, commit);
			journal({ type: "committed", at: at(), iteration, commit, tree, changed });
			if (changed.length === 0 || tree === (await treeOf(worktrees, best))) {
				archive("no-op", "the agent left no change");
				await cleanup();
				continue;
			}
			if (seenTrees.has(tree)) {
				archive("duplicate", "the change reproduces a tree an earlier iteration already measured");
				await cleanup();
				continue;
			}
			seenTrees.add(tree);
			const touched = changed.filter((path) => changeReachesProtected(worktree.path, path, campaign.protected));
			if (touched.length > 0) {
				archive("protected", `changed protected path(s): ${touched.join(", ")}`);
				await cleanup();
				continue;
			}
			const outside = changed.filter((path) => !inScope(path, campaign.scope));
			if (outside.length > 0) {
				archive("out-of-scope", `changed path(s) outside --scope: ${outside.join(", ")}`);
				await cleanup();
				continue;
			}

			// RECORD, first half: the plan as a hypothesis, bound to this run's checks before they execute.
			const stated = hypothesisFromSummary(run.summary) ?? {
				statement: `Iteration ${iteration} changes ${changed.join(", ")} to move ${metric} ${campaign.objective.direction === "min" ? "down" : "up"}.`,
				prediction: "",
			};
			const begun = await beginIterationRecord(claims, root, {
				campaign,
				iteration,
				hypothesis: stated,
				checks: campaign.checks.map((check) => check.id),
			});

			// MEASURE
			const candidateUntracked = await untrackedEntries(worktrees, worktree.id);
			log(`iteration ${iteration}: measuring ${campaign.objective.trials} interleaved pairs`);
			// The objective's hypothesis test cites the measurement's own runs: the last candidate run when it measured,
			// the failing run when one failed, and none when the campaign stopped first.
			let candidateReceipt: string | undefined;
			let failedReceipt: string | undefined;
			const pairs = await measurePairs(
				campaign.objective.trials,
				async (side) => {
					const value = await measure(side === "base" ? baseWorktree : worktree);
					if (!value.ok) failedReceipt = value.receipt;
					else if (side === "candidate") candidateReceipt = value.receipt;
					return value;
				},
				aborted,
			);
			const measureHalt = halt();
			if (!pairs.ok || measureHalt !== null) {
				const outcome: ResearchCheckOutcome =
					aborted() || failedReceipt === undefined
						? { check: objectiveCheck.id, execution: "aborted" }
						: { check: objectiveCheck.id, receipt: failedReceipt };
				await finishIterationRecord(claims, { campaign, iteration, bindings: begun.bindings, outcomes: [outcome] });
				journal({
					type: "recorded",
					at: at(),
					iteration,
					hypothesis: begun.hypothesis,
					verdict: researchHypothesisVerdict(null),
					claims: [],
				});
				if (measureHalt !== null) {
					const detail = haltDetail("while measuring");
					archive(measureHalt.archive, detail);
					await cleanup();
					return finish(measureHalt.reason, detail);
				}
				archive("measure-failed", pairs.ok ? "measurement incomplete" : pairs.reason);
				await cleanup();
				continue;
			}
			const samples = writeSamples(root, campaign.id, {
				iteration,
				metric,
				baseCommit: best,
				candidateCommit: commit,
				pairs: pairs.pairs,
			});
			journal({ type: "measured", at: at(), iteration, samples });

			// GRADE: the objective, then every gate on the candidate. A judged objective runs once more as its gate, as
			// `verify` would run it; a plain one is tested on the last candidate measurement.
			const result = grade({
				direction: campaign.objective.direction,
				minImprovement: campaign.objective.minImprovement,
				base: pairs.pairs.map((pair) => pair.base),
				candidate: pairs.pairs.map((pair) => pair.candidate),
				seed: campaign.seed + iteration,
				resamples: campaign.resamples,
			});
			const outcomes: ResearchCheckOutcome[] = [];
			const objectiveJudged = gateIds.has(objectiveCheck.id) ? await gate(worktree, objectiveCheck) : undefined;
			const objectiveReceipt = objectiveJudged?.receipt ?? candidateReceipt;
			outcomes.push(
				objectiveReceipt !== undefined
					? { check: objectiveCheck.id, receipt: objectiveReceipt }
					: { check: objectiveCheck.id, execution: "aborted" },
			);
			const gates: ResearchGateResult[] = [];
			for (const check of gateChecks) {
				const isObjective = check.id === objectiveCheck.id && objectiveJudged !== undefined;
				if (!isObjective && aborted()) {
					outcomes.push({ check: check.id, execution: "aborted" });
					gates.push({ check: check.id, passed: false, execution: "aborted", summary: "aborted" });
					continue;
				}
				const judged = isObjective ? (objectiveJudged as ExtensionCheckResult) : await gate(worktree, check);
				if (!isObjective) outcomes.push({ check: check.id, receipt: judged.receipt });
				gates.push({
					check: check.id,
					passed: judged.ok,
					execution: judged.execution,
					summary: firstLine(judged.text),
				});
			}

			await learnArtifacts(worktree, candidateUntracked);

			// RECORD, second half: claims from the judged runs and the hypothesis test.
			const recorded = await finishIterationRecord(claims, {
				campaign,
				iteration,
				bindings: begun.bindings,
				outcomes,
			});
			for (const entry of gates) {
				const claim = recorded[entry.check];
				if (claim !== undefined) entry.claim = claim;
			}
			journal({ type: "graded", at: at(), iteration, grade: result, gates });
			journal({
				type: "recorded",
				at: at(),
				iteration,
				hypothesis: begun.hypothesis,
				verdict: researchHypothesisVerdict(result),
				claims: outcomes.flatMap((outcome) => {
					const claim = recorded[outcome.check];
					return claim !== undefined ? [claim] : [];
				}),
			});
			log(`iteration ${iteration}: ${describeGrade(result, campaign.objective)}`);

			// RATCHET, only before the deadline and only with every gate, the judged objective included, passing.
			const gradeHalt = halt();
			if (gradeHalt !== null) {
				const detail = haltDetail("before the ratchet");
				archive(gradeHalt.archive, detail);
				await cleanup();
				return finish(gradeHalt.reason, detail);
			}
			const failedGates = gates.filter((entry) => !entry.passed);
			if (failedGates.length > 0) {
				archive(
					"gate-failed",
					failedGates.map((entry) => `${entry.check}: ${entry.summary || entry.execution}`).join("; "),
				);
			} else if (result.verdict !== "improved") {
				archive("not-improved", describeGrade(result, campaign.objective));
			} else if (
				await worktrees.refs.swap(
					campaign.id,
					commit,
					best,
					`pancode research: ${name} ${describeGrade(result, campaign.objective)}`,
				)
			) {
				journal({ type: "ratcheted", at: at(), iteration, from: best, to: commit });
				log(`iteration ${iteration}: ratcheted ${campaign.ref} ${best.slice(0, 12)} -> ${commit.slice(0, 12)}`);
				best = commit;
				await worktrees.checkout(baseWorktree.id, best);
			} else {
				archive("ratchet-lost", `${campaign.ref} no longer points at ${best}; something else moved it`);
			}
			await cleanup();
		}
	} catch (error) {
		return finish("error", errorText(error));
	} finally {
		for (const timer of timers) clearTimeout(timer);
		operator?.removeEventListener("abort", onOperatorAbort);
	}
}
