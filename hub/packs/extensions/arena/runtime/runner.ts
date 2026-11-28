import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { ExtensionContextV2, ExtensionRunEnd, ExtensionRuns } from "pancode/sdk/extension";
import { blindOrder, labelForContender, newArenaSeed } from "./blind.ts";
import { ArenaCommandError, type ArenaHost, type ArenaRunRequest, validateRunShape } from "./cli.ts";
import { contenderWrites, readArenaStream, readNumstat } from "./facts.ts";
import { contenderDiffPath, contenderStreamPath, matchDir, newArenaMatchId, writeMatch } from "./store.ts";
import {
	ARENA_SCHEMA_VERSION,
	type ArenaCheckFact,
	type ArenaContender,
	type ArenaDiffStat,
	type ArenaFacts,
	type ArenaMatch,
} from "./types.ts";

const CHECK_TAIL_CHARS = 2000;
const FRAME_PAGE = 1000;
const FRAME_WAIT_MS = 30_000;
/** Everything but the repository's `.pancode/`, from its top, wherever in it the workspace sits. */
const DIFF_PATHSPEC = ["--", ":/", ":(top,exclude).pancode"];

type Services = Required<Pick<ExtensionContextV2, "runs" | "worktrees" | "verify">>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function services(ctx: ExtensionContextV2): Services {
	const { runs, worktrees, verify } = ctx;
	if (runs === undefined || worktrees === undefined || verify === undefined)
		throw new ArenaCommandError(
			"arena needs the runs, worktrees and verify services; pancode extensions services arena approves them",
		);
	return { runs, worktrees, verify };
}

/** The repository's top and HEAD, or null outside Git (or before a first commit), where contenders run read-only. */
async function baselineOf(worktrees: Services["worktrees"]): Promise<{ root: string; sha: string } | null> {
	try {
		const top = await worktrees.git("workspace", ["rev-parse", "--show-toplevel"]);
		const head = await worktrees.git("workspace", ["rev-parse", "--verify", "HEAD"]);
		if (top.exitCode !== 0 || head.exitCode !== 0) return null;
		return { root: top.stdout.trim(), sha: head.stdout.trim() };
	} catch {
		return null;
	}
}

/** Page the run's stream into `path` as it comes, then its end. */
async function followRun(runs: ExtensionRuns, id: string, path: string): Promise<ExtensionRunEnd> {
	const fd = openSync(path, "w");
	try {
		let cursor = 0;
		for (;;) {
			const page = await runs.frames(id, { cursor, limit: FRAME_PAGE, waitMs: FRAME_WAIT_MS });
			for (const frame of page.frames) writeSync(fd, `${JSON.stringify(frame)}\n`);
			cursor = page.next;
			if (page.done) break;
		}
	} finally {
		closeSync(fd);
	}
	return runs.wait(id);
}

/** The contender's change since its inputs were committed, outside `.pancode/`, saved beside the match. */
async function captureDiff(
	worktrees: Services["worktrees"],
	worktree: string,
	from: string,
	path: string,
): Promise<ArenaDiffStat> {
	const head = (await worktrees.commit(worktree, "arena result")).head;
	const git = async (args: string[]): Promise<string> => {
		const result = await worktrees.git({ worktree }, [
			"diff",
			"--no-color",
			"--no-ext-diff",
			...args,
			from,
			head,
			...DIFF_PATHSPEC,
		]);
		if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git diff exited ${result.exitCode}`);
		return result.stdout;
	};
	const patch = await git([]);
	writeFileSync(path, patch);
	return readNumstat(await git(["--numstat"]));
}

interface Place {
	/** The contender's worktree id, null in a read-only match. */
	worktree: string | null;
	/** The commit holding the copied check inputs, which the diff starts from. */
	inputsHead: string | null;
}

/**
 * The host side of `pancode arena`: matches live in the extension's project directory, and each match runs its
 * contenders through the host's runs, worktrees and verify services.
 */
export function arenaHost(ctx: ExtensionContextV2): ArenaHost {
	const root = ctx.projectDir;
	if (root === undefined)
		throw new ArenaCommandError("arena keeps its matches in the project and has no project directory here");
	return {
		root,
		interrupted: () => ctx.signal.aborted,
		async yoloRefusal() {
			return services(ctx).runs.refusal({ autonomy: "yolo" });
		},
		run: (request) => runMatch(ctx, root, request),
	};
}

/**
 * Run one match: every contender gets the same prompt, the same baseline and the same limits, at the same time.
 * Inside Git each works in its own worktree, so their edits never meet and each leaves a diff; outside Git they run
 * read-only. `match.json` is written first and after every step, so a reader can list a match that is still running.
 */
async function runMatch(ctx: ExtensionContextV2, root: string, request: ArenaRunRequest): Promise<ArenaMatch> {
	validateRunShape(request.contenders, request.prompt);
	const { runs, worktrees, verify } = services(ctx);
	let inputs: ReadonlyArray<string> = [];
	if (request.check !== null) {
		const resolution = await verify.resolve(request.check);
		if (!resolution.ok) throw new ArenaCommandError(`arena --check ${request.check}: ${resolution.message}`);
		inputs = resolution.inputs;
	}
	const base = request.readOnly ? null : await baselineOf(worktrees);
	const refusal = await runs.refusal({ autonomy: request.autonomy, readOnly: base === null });
	if (refusal !== null) throw new ArenaCommandError(refusal);
	const id = newArenaMatchId();
	const seed = request.seed ?? newArenaSeed();
	const match: ArenaMatch = {
		schemaVersion: ARENA_SCHEMA_VERSION,
		id,
		createdAt: new Date().toISOString(),
		completedAt: null,
		status: "running",
		prompt: request.prompt,
		suite: request.suite,
		root: base?.root ?? ctx.snapshot.workspace,
		baselineSha: base?.sha ?? null,
		isolation: base === null ? "read-only" : "worktree",
		autonomy: request.autonomy,
		seed,
		order: blindOrder(request.contenders.length, seed),
		timeoutSeconds: request.timeoutSeconds,
		maxCostUsd: request.maxCostUsd,
		check: request.check,
		contenders: request.contenders.map((spec, index) => ({ ...spec, index, status: "pending", facts: null })),
		error: null,
	};
	const dir = matchDir(root, id);
	const save = (): void => writeMatch(root, match);
	save();
	ctx.progress?.(`match ${id} started`);

	const places: Place[] = match.contenders.map(() => ({ worktree: null, inputsHead: null }));
	try {
		if (base !== null) {
			// Worktrees are made in blind-slot order (A first), never by --contender position, so their order says
			// nothing the label does not.
			for (const index of match.order) {
				const created = await worktrees.create({ base: base.sha });
				const place = places[index] as Place;
				place.worktree = created.id;
				if (inputs.length > 0) {
					try {
						await worktrees.copy(created.id, inputs);
					} catch {
						// The copy before the check repeats this and reports a refusal as the check's result.
					}
				}
				place.inputsHead = (await worktrees.commit(created.id, "arena inputs")).head;
			}
		}
		ctx.progress?.(
			`match ${id}: ${match.contenders.length} contenders, ${match.isolation}, autonomy ${match.autonomy === "yolo" ? "yolo (contained)" : "default"}`,
		);
		// One contender failing outright (its stream or a save failing) stops the others, and cleanup waits until every
		// contender has settled, so no worktree is removed under a live run.
		const halt = new AbortController();
		const stop = AbortSignal.any([ctx.signal, halt.signal]);
		const settled = await Promise.allSettled(
			match.contenders.map(async (contender) => {
				try {
					await runContender(
						ctx,
						{ runs, worktrees, verify },
						match,
						contender,
						dir,
						places[contender.index] as Place,
						request,
						inputs,
						stop,
						save,
					);
				} catch (caught) {
					if (contender.status === "pending" || contender.status === "running") contender.status = "failed";
					halt.abort();
					throw caught;
				}
			}),
		);
		const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		if (failure !== undefined) throw failure.reason;
		if (ctx.signal.aborted) {
			match.status = "failed";
			match.error = "canceled before every contender finished";
		} else match.status = "complete";
	} catch (caught) {
		match.status = "failed";
		match.error = errorText(caught);
	} finally {
		for (const place of places) {
			if (place.worktree === null) continue;
			try {
				await worktrees.remove(place.worktree);
			} catch (caught) {
				match.error = match.error ?? `worktree cleanup: ${errorText(caught)}`;
			}
		}
		match.completedAt = new Date().toISOString();
		save();
	}
	return match;
}

async function runContender(
	ctx: ExtensionContextV2,
	{ runs, worktrees, verify }: Services,
	match: ArenaMatch,
	contender: ArenaContender,
	dir: string,
	place: Place,
	request: ArenaRunRequest,
	inputs: ReadonlyArray<string>,
	stop: AbortSignal,
	save: () => void,
): Promise<void> {
	if (stop.aborted) return;
	contender.status = "running";
	save();
	const startedAt = Date.now();
	let end: ExtensionRunEnd | null = null;
	let error: string | null = null;
	try {
		const { id } = await runs.start({
			prompt: request.prompt,
			target: contender.target,
			model: contender.model,
			...(place.worktree !== null ? { cwd: { worktree: place.worktree } } : {}),
			autonomy: request.autonomy,
			readOnly: match.isolation === "read-only",
			timeoutSeconds: request.timeoutSeconds,
			...(request.maxCostUsd !== null ? { maxCostUsd: request.maxCostUsd } : {}),
		});
		const cancel = (): void => void runs.cancel(id).catch(() => undefined);
		stop.addEventListener("abort", cancel, { once: true });
		// A stop that landed while `start` was in flight fired before the listener existed.
		if (stop.aborted) cancel();
		try {
			end = await followRun(runs, id, contenderStreamPath(dir, contender.index));
		} finally {
			stop.removeEventListener("abort", cancel);
		}
		if (end.error !== undefined) error = end.error;
	} catch (caught) {
		error = errorText(caught);
	}
	const durationMs = Date.now() - startedAt;
	let stream = readArenaStream("");
	try {
		stream = readArenaStream(readFileSync(contenderStreamPath(dir, contender.index), "utf8"));
	} catch {
		// No stream: the run never started.
	}
	let diff: ArenaDiffStat | null = null;
	let check: ArenaCheckFact | null = null;
	if (place.worktree !== null && place.inputsHead !== null) {
		try {
			diff = await captureDiff(worktrees, place.worktree, place.inputsHead, contenderDiffPath(dir, contender.index));
		} catch (caught) {
			error = error ?? `diff: ${errorText(caught)}`;
		}
	}
	if (request.check !== null) {
		try {
			if (stop.aborted) throw new Error("canceled before the check ran");
			if (place.worktree !== null && inputs.length > 0) await worktrees.copy(place.worktree, inputs);
			const result = await verify.check(
				request.check,
				place.worktree !== null ? { worktree: place.worktree } : "workspace",
			);
			check = { id: request.check, exitCode: result.exitCode, tail: result.text.trim().slice(-CHECK_TAIL_CHARS) };
		} catch (caught) {
			check = { id: request.check, exitCode: null, tail: errorText(caught) };
		}
	}
	// Exit 124 is `run --timeout`; the host's own backstop shows as timed_out.
	const exitCode = end?.exitCode ?? null;
	const timedOut = end?.outcome === "timed_out" || exitCode === 124;
	const stderrTail = (end?.stderrTail ?? "").trim().split("\n").slice(-3).join("\n");
	const facts: ArenaFacts = {
		exitCode,
		timedOut,
		durationMs,
		sessionId: stream.sessionId,
		turns: stream.turns,
		toolCalls: stream.toolCalls,
		toolErrors: stream.toolErrors,
		writes: contenderWrites(stream.writes, diff),
		blocks: stream.blocks,
		totalTokens: stream.totalTokens,
		cost: stream.cost,
		finalText: stream.finalText,
		diff,
		check,
		...(stream.autonomy !== null ? { autonomy: stream.autonomy } : {}),
		error: error ?? (exitCode !== null && exitCode !== 0 && stderrTail.length > 0 ? stderrTail : null),
	};
	contender.facts = facts;
	contender.status = timedOut ? "timed-out" : exitCode === 0 ? "done" : "failed";
	save();
	// The input position would map labels to the --contender order; only the blind label is safe before a vote.
	ctx.progress?.(`contender ${labelForContender(match, contender.index)} ${contender.status}`);
}
