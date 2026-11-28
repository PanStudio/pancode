// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { existsSync } from "node:fs";
import { THINKING_LEVELS, type ThinkingLevel } from "../../core/defaults.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { parseCouncilReport, parseOracleResult } from "../../domains/agents/index.js";
import { AdmissionCanceledError } from "../../domains/dispatch/admission-error.js";
import type { DispatchRequest } from "../../domains/dispatch/contract.js";
import { requestRunRole } from "../../domains/dispatch/execution-role.js";
import {
	plainOutcomeLabel,
	STALLED_RUN_HEADLINE,
	workerFailureHeadline,
} from "../../domains/dispatch/failure-headline.js";
import type { RunResult } from "../../domains/dispatch/types.js";
import { classifyVerifiability, verifiabilityRoute } from "../../domains/evidence/verifiability.js";
import { forcedAcpAgentId, isInteropHeadlessRuntime } from "../../domains/interop/peer-modes.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import {
	chooseSecondOpinionRoute,
	type SecondOpinionCandidate,
	secondOpinionIndependence,
} from "../../domains/providers/model-lineage.js";
import { activeDecisionRefs } from "../../domains/session/decision-board.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import {
	buildCouncilDispatchArgs,
	COUNCIL_SYNTHESIS_LABEL,
	type CouncilCommandOptions,
	resolveCouncilRoster,
} from "../council.js";
import { formatOracleAnswer, ORACLE_AGENT_ID, ORACLE_TASK, packOracleDigest } from "../oracle.js";
import { buildPollDispatchArgs, councilSkippedWords, formatPollTally, type PollCommandOptions } from "../poll.js";
import type {
	DispatchAdmission,
	HandleRunDeps,
	RunCommandOptions,
	SlashCommand,
	SlashCommandContext,
} from "../slash-command-types.js";
import {
	formatCouncilMemberShareNote,
	formatCouncilShareNote,
	formatWorkerShareNote,
	selectWorkerRunToShare,
	type WorkerShareFacts,
	workerShareFactsFromEntry,
} from "../worker-share.js";
import type { WorkerEntryState } from "../worker-stream.js";

/**
 * Hand a finished run's sealed answer to the main agent. The receipt is the
 * terminal truth here rather than the transcript block: the block is a view of
 * this same text, and the caller already holds the receipt.
 */
function shareReceipt(agentId: string, receipt: RunResult, deps: HandleRunDeps): void {
	if (!deps.submitOperatorNote) {
		deps.notice("error", "--share is not wired in this session; the result stayed local");
		return;
	}
	const note = formatWorkerShareNote({
		agentId,
		runId: receipt.runId,
		outcome: receipt.outcome,
		text: receipt.output?.text ?? "",
		...(receipt.runtimeKind === "subprocess" || receipt.delegation
			? receipt.worktree
				? {
						placement: {
							mode: "worktree" as const,
							cwd: receipt.worktree.path,
							branch: receipt.worktree.branch,
							...(receipt.worktree.changedPaths ? { changedPaths: receipt.worktree.changedPaths } : {}),
						},
					}
				: receipt.reproducibility?.cwd
					? {
							placement: {
								mode: "current" as const,
								cwd: receipt.reproducibility.cwd,
								...(receipt.checkoutChanges ? { changedPaths: receipt.checkoutChanges.changedPaths } : {}),
							},
						}
					: {}
			: {}),
	});
	if (note === null) {
		deps.notice("warn", `--share: run ${receipt.runId} produced no text to share`);
		return;
	}
	deps.submitOperatorNote(note);
}

export function standingLimits(ctx: SlashCommandContext): { turnConstraints?: TurnConstraints } {
	const turnConstraints = ctx.standingTurnConstraints?.();
	return turnConstraints !== undefined ? { turnConstraints } : {};
}

/** The first admission a run reports; later reports, including the fallback "refused" once it ends, are ignored. */
export function admissionSignal(): {
	promise: Promise<DispatchAdmission>;
	resolve: (admission: DispatchAdmission) => void;
} {
	let resolve: (admission: DispatchAdmission) => void = () => {};
	const promise = new Promise<DispatchAdmission>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Longer than an admission that finds a free slot takes, so a run that was never held up says nothing. */
const QUEUED_RUN_NOTICE_MS = 600;

/**
 * The attributed half every operator-started run shares, whether `/run` or
 * `/delegate` built the request. Dispatch it, forward its events for surfaces
 * that do not share the domain's bus, wait for the receipt, keep the notice bar
 * quiet on success because the transcript block is the success signal, and
 * share the sealed answer only when the operator asked. A failed run is still
 * worth sharing when they did: the failure text is what they would want the
 * main agent to work from.
 */
async function runAttributed(
	command: "run" | "delegate",
	request: DispatchRequest,
	deps: HandleRunDeps,
	share: boolean,
): Promise<void> {
	const { dispatch, notice, bus } = deps;
	// Admission is told exactly once, so a caller that answers on it never says "started" for a run that never did.
	let admission: DispatchAdmission | null = null;
	const admit = (next: DispatchAdmission): void => {
		if (admission !== null) return;
		admission = next;
		deps.onAdmission?.(next);
	};
	let runId: string | null = null;
	let stopQueueWatch = (): void => {};
	try {
		const progressBus = dispatch.ownsProgressBus?.(bus) === true ? undefined : bus;
		if (deps.turnConstraints !== undefined) request = { ...request, turnConstraints: deps.turnConstraints };
		// Nothing else in the transcript says a run is waiting for a slot, since its card opens when it starts.
		let queuedRunId: string | null = null;
		const stopWatchingQueue = bus?.subscribe("run.enqueued", (payload) => {
			if (payload.agentId === request.agentId && payload.requestOrigin === "user") queuedRunId = payload.runId;
		});
		const stopWatchingStart = bus?.subscribe("run.started", (payload) => {
			if (payload.runId === queuedRunId) queuedRunId = null;
		});
		const queuedNotice = setTimeout(() => {
			if (queuedRunId === null) return;
			notice("info", `${request.agentId} is queued for a worker slot and starts when one frees · /fleet shows the queue`);
			// Every run is enqueued first; one still waiting here was admitted, so its caller need not wait for the slot.
			admit("queued");
		}, QUEUED_RUN_NOTICE_MS);
		queuedNotice.unref?.();
		stopQueueWatch = (): void => {
			clearTimeout(queuedNotice);
			stopWatchingQueue?.();
			stopWatchingStart?.();
		};
		const handle = await dispatch.dispatch(request);
		runId = handle.runId;
		admit("started");
		stopQueueWatch();
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (!e.type || e.type === "heartbeat") continue;
			progressBus?.emit("run.progressed", { runId: handle.runId, agentId: request.agentId, event });
		}
		const receipt = await handle.finalPromise;
		const view = `/view dispatch:${handle.runId}`;
		if (receipt.outcome === "canceled") {
			const why = workerFailureHeadline(receipt.outcomeDetail) ?? "cancelled at your request";
			// A cancel removes an idle worktree but keeps one holding work, which nothing else on screen says.
			const changed = receipt.worktree?.changedPaths?.length ?? 0;
			const kept =
				receipt.worktree === undefined
					? ""
					: changed > 0
						? ` · ${changed} changed ${changed === 1 ? "file stays" : "files stay"} in its worktree on branch ${receipt.worktree.branch}`
						: existsSync(receipt.worktree.path)
							? ` · its worktree stays on branch ${receipt.worktree.branch}`
							: " · its worktree held no changes and was removed";
			notice("info", `${request.agentId} ${why.startsWith("cancelled") ? why : `cancelled: ${why}`}${kept} · ${view}`);
		} else if (receipt.outcome === "stalled") {
			notice("error", `${request.agentId} ${STALLED_RUN_HEADLINE} · ${view}`);
		} else if (receipt.exitCode !== 0 || receipt.failureMessage) {
			const why = workerFailureHeadline(receipt.failureMessage) ?? `exit code ${receipt.exitCode}`;
			// A run that hit its reply limit timed out, as its card header says; `failed` named a second state for it.
			const ended = receipt.outcome === "timed_out" ? "timed out" : "failed";
			notice("error", `${request.agentId} ${ended}: ${why} · ${view}`);
		}
		if (share) shareReceipt(request.agentId, receipt, deps);
	} catch (err) {
		stopQueueWatch();
		const msg = err instanceof Error ? err.message : String(err);
		if (admission === "started" && runId !== null) {
			// The run began, so it has a record to inspect; this is its failure, not a refusal to start.
			notice("error", `${request.agentId} failed: ${msg} · /view dispatch:${runId}`);
		} else if (err instanceof AdmissionCanceledError) {
			notice("info", `${request.agentId} cancelled before it started, so nothing ran`);
		} else {
			// Nothing started, so this is a refusal to start and has no run to inspect.
			notice("error", `${command} refused: ${msg.replace(/^dispatch:\s*/u, "")}`);
		}
	} finally {
		// Whatever ended the attempt before admission, it did not start.
		admit("refused");
	}
}

/**
 * Dispatches /run through the dispatch contract and streams events to stdout.
 * Target + model are resolved by the dispatch domain from request overrides,
 * worker profiles, recipe hints, and `settings.fleet.default`.
 */
export async function handleRun(
	agentId: string,
	task: string,
	deps: HandleRunDeps,
	options: RunCommandOptions = {},
): Promise<void> {
	const decisionRefs = activeDecisionRefs(deps.getDecisionBoard?.() ?? []);
	const selectedRuntime = options.target ? deps.runtimeForTarget?.(options.target) : options.workerRuntime;
	if (selectedRuntime && isInteropHeadlessRuntime(selectedRuntime)) {
		deps.notice(
			"warn",
			options.worktree
				? `External CLI ${selectedRuntime} will run in a PanCode-created Git worktree. The worktree separates Git changes but does not confine the peer's filesystem, shell, or network tools.`
				: `External CLI ${selectedRuntime} will run in the current checkout; edits may appear immediately. The peer's own tools may access paths outside this checkout.`,
		);
	}
	if (options.target && options.workerProfile) {
		deps.notice(
			"warn",
			`--connection ${options.target} takes precedence; --agent-profile ${options.workerProfile} will be ignored`,
		);
	}
	if (options.target && options.workerRuntime) {
		deps.notice(
			"warn",
			`--connection ${options.target} takes precedence; --runtime ${options.workerRuntime} will be ignored`,
		);
	}
	await runAttributed(
		"run",
		{
			agentId,
			task,
			executionRole: requestRunRole({ agentId, ...(options.readOnly ? { readOnly: true } : {}) }, deps.getAgentRoleFacts),
			requestOrigin: "user",
			...(decisionRefs.length > 0 ? { decisionRefs } : {}),
			...(options.workerProfile ? { workerProfile: options.workerProfile } : {}),
			...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
			...(options.target ? { target: options.target } : {}),
			...(options.worktree ? { worktree: true as const, apply: "preserve" as const } : {}),
			...(options.readOnly ? { readOnly: true } : {}),
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options.toolProfile ? { toolProfile: options.toolProfile } : {}),
			...(options.requiredCapabilities && options.requiredCapabilities.length > 0
				? { requiredCapabilities: options.requiredCapabilities }
				: {}),
		},
		deps,
		options.share === true,
	);
}

/**
 * The external agent a `/run` names, or null for a fleet agent. A fleet agent
 * wins a name collision; `acp:<id>` forces the external one.
 */
export function externalRunAgent(agentId: string, ctx: SlashCommandContext): string | null {
	const forced = forcedAcpAgentId(agentId);
	if (forced !== null) return forced || null;
	if (ctx.listAgents?.().some((agent) => agent.id === agentId)) return null;
	return ctx.isExternalAgent?.(agentId) === true ? agentId : null;
}

/** `/run` flags an external agent cannot honour; refusing them beats dropping them silently. */
export function externalIgnoredFlags(options: RunCommandOptions): string[] {
	const used: Array<[boolean, string]> = [
		[options.workerProfile !== undefined, "--agent-profile"],
		[options.workerRuntime !== undefined, "--runtime"],
		[options.target !== undefined, "--connection"],
		[options.model !== undefined, "--model"],
		[options.thinkingLevel !== undefined, "--thinking"],
		[options.toolProfile !== undefined, "--tool-profile"],
		[(options.requiredCapabilities?.length ?? 0) > 0, "--require"],
		[options.worktree === true, "--worktree"],
	];
	return used.filter(([on]) => on).map(([, flag]) => flag);
}

/** Start an external agent run: what `/run <external-id>` does. */
export function startDelegate(command: Extract<SlashCommand, { kind: "delegate" }>, ctx: SlashCommandContext): void {
	ctx.echoOperatorCommand?.(command.source);
	const start = admissionSignal();
	void (async () => {
		try {
			await handleDelegate(
				command.agentId,
				command.task,
				{
					onAdmission: start.resolve,
					dispatch: ctx.dispatch,
					io: ctx.io,
					notice: ctx.notice,
					bus: ctx.bus,
					...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
					...standingLimits(ctx),
				},
				{ share: command.share === true, readOnly: command.readOnly === true },
			);
		} catch (error) {
			// A throw before admission is a delegation that never started; say so instead of losing it.
			ctx.notice("error", `run did not start: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			start.resolve("refused");
		}
		ctx.render?.();
	})();
	ctx.awaitDispatchStart?.(start.promise);
}

async function handleDelegate(
	agentId: string,
	task: string,
	deps: HandleRunDeps,
	options: { share?: boolean; readOnly?: boolean } = {},
): Promise<void> {
	await runAttributed(
		"delegate",
		{
			agentId,
			delegationAgentId: agentId,
			executionRole: requestRunRole({ agentId, ...(options.readOnly ? { readOnly: true } : {}) }),
			requestOrigin: "user",
			task,
			...(options.readOnly ? { readOnly: true } : {}),
		},
		deps,
		options.share === true,
	);
}

/**
 * `/oracle <question>`: one advisory run, dispatched like any other.
 *
 * Nothing here is a side channel. The run goes through the ordinary dispatch
 * path, so admission, the receipt, and the Fleet Runs island treat it exactly
 * as they treat a `/run`; `requestOrigin: "internal"` is what lets a shadow
 * recipe be reached at all, and `readOnly: true` narrows the worker
 * below whatever the session holds. The answer reaches the main agent the way
 * `/share` puts one there: an operator-authored note on the ordinary user-turn
 * path, never a fabricated tool result.
 */
/** Commands that refuse rather than queue while a turn streams; the composer's list says so before Enter does. */
export const COMMANDS_REFUSED_DURING_TURN: ReadonlySet<string> = new Set(["council", "oracle", "poll"]);
/** The same, for a command that only refuses by subcommand, as `<command> <subcommand>`. */
export const SUBCOMMANDS_REFUSED_DURING_TURN: ReadonlySet<string> = new Set(["fleet run"]);

export async function handleOracle(question: string, ctx: SlashCommandContext): Promise<void> {
	if (!ctx.submitOperatorNote) {
		ctx.notice("error", "/oracle is not wired in this session; there is nowhere to put the answer");
		return;
	}
	// Refused, never queued. The digest describes the record as it stands and a
	// turn still in flight is about to change it, so an answer written against
	// the old record would be advice about a session that no longer exists.
	if (ctx.isTurnInFlight?.() === true) {
		ctx.notice("warn", "a turn is in flight; /oracle is refused rather than queued");
		return;
	}
	const sources = ctx.oracleBriefing?.();
	if (!sources) {
		ctx.notice("error", "/oracle needs the session record, which is not wired in this session");
		return;
	}
	const digest = packOracleDigest({ ...sources, question });
	const turnConstraints = ctx.standingTurnConstraints?.();
	const mainModel = oracleMainModel(ctx);
	const crossLineage = oracleCrossLineageRoute(ctx, mainModel);
	const request: DispatchRequest = {
		agentId: ORACLE_AGENT_ID,
		task: ORACLE_TASK,
		briefing: digest.text,
		executionRole: requestRunRole({ agentId: ORACLE_AGENT_ID, readOnly: true }, ctx.getAgentRoleFacts),
		requestOrigin: "internal",
		readOnly: true,
		...(crossLineage ? { target: crossLineage.target, model: crossLineage.model } : {}),
		...(turnConstraints !== undefined ? { turnConstraints } : {}),
	};
	const progressBus = ctx.dispatch.ownsProgressBus?.(ctx.bus) === true ? undefined : ctx.bus;
	try {
		let handle: Awaited<ReturnType<typeof ctx.dispatch.dispatch>>;
		try {
			handle = await ctx.dispatch.dispatch(request);
		} catch (err) {
			if (!crossLineage) throw err;
			// The pin is a preference: a route admission refuses must not cost the answer.
			ctx.notice(
				"warn",
				`/oracle could not use ${crossLineage.target}/${crossLineage.model} for an independent opinion (${err instanceof Error ? err.message : String(err)}); asking the default route`,
			);
			const { target: _target, model: _model, ...unpinned } = request;
			handle = await ctx.dispatch.dispatch(unpinned);
		}
		for await (const event of handle.events) {
			const typed = event as { type?: string };
			if (!typed.type || typed.type === "heartbeat") continue;
			progressBus?.emit("run.progressed", { runId: handle.runId, agentId: ORACLE_AGENT_ID, event });
		}
		const receipt = await handle.finalPromise;
		const parsed = parseOracleResult(receipt.output?.text ?? null);
		if (parsed === null) {
			ctx.notice(
				"error",
				`/oracle run ${receipt.runId} returned no usable answer (${plainOutcomeLabel(receipt.outcome)})`,
			);
			return;
		}
		const note = formatWorkerShareNote({
			agentId: ORACLE_AGENT_ID,
			runId: receipt.runId,
			outcome: receipt.outcome,
			text: [
				formatOracleAnswer(parsed),
				oracleIndependenceLine(mainModel.model, receipt.targetId, receipt.wireModelId),
				oracleVerifiabilityLine(question, ctx.getAutonomy?.() ?? "default"),
			].join("\n\n"),
		});
		if (note === null) {
			ctx.notice("error", `/oracle run ${receipt.runId} produced no text to share`);
			return;
		}
		ctx.submitOperatorNote(note);
	} catch (err) {
		ctx.notice("error", `/oracle failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** The main chat route, live: a session-scoped `/model` switch is what the host reports. */
function oracleMainModel(ctx: SlashCommandContext): { target: string | null; model: string | null } {
	const target = ctx.getChatTarget?.() ?? null;
	const model = ctx.getChatModel?.() ?? (target ? (ctx.providers.getTarget(target)?.defaultModel ?? null) : null);
	return { target, model };
}

/**
 * A second opinion from the main model's own family mostly repeats it, so
 * `/oracle` pins a reachable model of another family when one is configured.
 * An operator who bound the oracle to a worker profile keeps that binding; the
 * answer then says whether it was independent.
 */
function oracleCrossLineageRoute(
	ctx: SlashCommandContext,
	main: { target: string | null; model: string | null },
): { target: string; model: string } | null {
	if (ctx.getFleetAgentProfiles?.()[ORACLE_AGENT_ID] !== undefined) return null;
	let statuses: ReturnType<ProvidersContract["list"]>;
	try {
		statuses = ctx.providers.list();
	} catch {
		return null;
	}
	const candidates: SecondOpinionCandidate[] = statuses.flatMap((status) =>
		[...new Set([status.target.defaultModel, ...(status.target.wireModels ?? [])])]
			.filter((model): model is string => typeof model === "string" && model.length > 0)
			.map((model) => ({ target: status.target.id, model, health: status.health.status, available: status.available })),
	);
	return chooseSecondOpinionRoute(main, candidates);
}

/** The line the oracle note closes with, so the main agent weighs agreement by how independent the advisor was. */
function oracleIndependenceLine(mainModel: string | null, advisorTarget: string, advisorModel: string): string {
	const advisor = `${advisorTarget}/${advisorModel}`;
	switch (secondOpinionIndependence(mainModel, advisorModel)) {
		case "independent":
			return `Advisor: ${advisor}, a different model family from the main model; its agreement is independent corroboration.`;
		case "same-lineage":
			return `Advisor: ${advisor}, the same model family as the main model; its agreement is weak corroboration, not independent review.`;
		default:
			return `Advisor: ${advisor}; whether it shares the main model's family is unknown, so do not count its agreement as independent.`;
	}
}

/**
 * What the main agent does with the answer. A question a check settles runs
 * closed-loop: the opinion is a hypothesis until the check runs. A judgment
 * call goes to the operator, or under yolo the advisor's view stands in.
 */
function oracleVerifiabilityLine(question: string, autonomy: AutonomyLevel): string {
	const verifiability = classifyVerifiability(question);
	switch (verifiabilityRoute(verifiability.kind, autonomy)) {
		case "closed-loop":
			return `Verifiability: ${verifiability.kind}, ${verifiability.reason}. Run that check and act on its result; until it runs, this answer is a hypothesis.`;
		case "second-opinion":
			return `Verifiability: judgment, ${verifiability.reason}. Autonomy is yolo, so this advice stands in for the operator; weigh it by the advisor line above.`;
		default:
			return `Verifiability: judgment, ${verifiability.reason}. Confirm the decision with the operator before acting on it.`;
	}
}

/**
 * `/council <task>`: one council, dispatched exactly as the model dispatches one.
 *
 * The command builds dispatch-tool arguments and hands them to the tool
 * registry. That is the whole of it, and it is deliberate: a council is a
 * plan-scale dispatch, so supervised autonomy parks the call and the approval
 * overlay shows the same artifact it shows for a model-asked council, naming
 * every member's label, target, model, node, round count, and synthesis mode.
 * A private path would have had to reproduce that, and would eventually have
 * reproduced it wrongly.
 */
/**
 * A council's failure in the words a person acts on. The dispatch tool's result opens with the note its approval
 * leaves for the model (`[operator approval] The operator approved this dispatch call once …`), which the operator,
 * who gave that approval, has no use for; what follows is the failure itself, read through the shared headline.
 */
function councilFailureWords(message: string): string {
	const lines = message.split("\n");
	const body = (/^\[(?:operator )?approval\]/u.test(lines[0] ?? "") ? lines.slice(1) : lines).join(" ").trim();
	const headline = workerFailureHeadline(body);
	// Admission takes a council whole, so one unreachable member target keeps every member from starting.
	const unreachable = /^its connection (\S+) is not reachable/u.exec(headline ?? "");
	if (unreachable !== null) return `a member's connection ${unreachable[1]} is not reachable, so no member ran`;
	return headline ?? (body.length > 0 ? body : "the council stopped before any member answered");
}

/**
 * A council the operator refused at its approval card, said to the operator. The reason is written for the model
 * (`User denied this call at the permission prompt…`), and the person reading it is that user.
 */
function councilRefusalWords(reason: string): string {
	if (/^User denied\b/u.test(reason)) return "/council did not run: you denied it at its approval card";
	if (/^User stopped\b/u.test(reason)) return "/council did not run: you stopped it at its approval card";
	return `/council did not run: ${reason}`;
}

export async function handleCouncil(
	task: string,
	options: CouncilCommandOptions,
	ctx: SlashCommandContext,
): Promise<void> {
	// Refused, never queued, exactly as `/oracle` and `/fleet run` are. An
	// approved council describes the workspace as it stands, and a turn in
	// flight is about to change it.
	if (ctx.isTurnInFlight?.() === true) {
		ctx.notice("warn", "a turn is in flight; /council is refused rather than queued");
		return;
	}
	if (!ctx.runCouncilDispatch) {
		ctx.notice("error", "/council is not wired in this session");
		return;
	}
	const rosters = ctx.getWorkerRosters?.();
	if (rosters === undefined) {
		ctx.notice("error", "/council needs fleet.rosters, which is not wired in this session");
		return;
	}
	const resolved = resolveCouncilRoster(options.roster, rosters);
	if (!resolved.ok) {
		ctx.notice("error", resolved.reason);
		return;
	}
	try {
		const outcome = await ctx.runCouncilDispatch(
			buildCouncilDispatchArgs(task, resolved.roster, options),
			ctx.standingTurnConstraints?.(),
		);
		if (outcome.status === "blocked") ctx.notice("warn", councilRefusalWords(outcome.reason));
		else if (outcome.status === "error" && outcome.partial !== undefined) {
			// The card already reads partial; one answer stands, so this is not a failed council.
			// Counts are of the seats that ran; a seat whose target was down is named, not counted (FX-20).
			const { answered, total, failed } = outcome.partial;
			const skipped = outcome.skipped !== undefined ? `; ${councilSkippedWords(outcome.skipped.labels)}` : "";
			ctx.notice(
				"warn",
				`/council partial: ${answered} of ${total} members answered; ${failed.join(", ")} failed${skipped}`,
			);
		} else if (outcome.status === "error")
			ctx.notice("error", `/council failed: ${councilFailureWords(outcome.message)}`);
		else if (outcome.status === "ok" && outcome.skipped !== undefined) {
			// Every seat that ran answered, so the council is whole as admitted; the skipped seat is still named.
			const { answered, ran, labels } = outcome.skipped;
			ctx.notice("info", `/council: ${answered} of ${ran} members answered; ${councilSkippedWords(labels)}`);
		}
	} catch (err) {
		ctx.notice("error", `/council failed: ${councilFailureWords(err instanceof Error ? err.message : String(err))}`);
	}
}

export async function handlePoll(options: PollCommandOptions, ctx: SlashCommandContext): Promise<void> {
	if (ctx.isTurnInFlight?.() === true) {
		ctx.notice("warn", "a turn is in flight; /poll is refused rather than queued");
		return;
	}
	if (!ctx.runCouncilDispatch) {
		ctx.notice("error", "/poll is not wired in this session");
		return;
	}
	const chatTarget = ctx.getChatTarget?.() ?? undefined;
	const chatModel = ctx.getChatModel?.() ?? undefined;
	const built = buildPollDispatchArgs(options, {
		...(chatTarget !== undefined && chatTarget !== null ? { target: chatTarget } : {}),
		...(chatModel !== undefined && chatModel !== null ? { model: chatModel } : {}),
	});
	if (!built.ok) {
		ctx.notice("error", `/poll: ${built.reason}`);
		return;
	}
	try {
		const outcome = await ctx.runCouncilDispatch(built.args, ctx.standingTurnConstraints?.());
		if (outcome.status === "blocked") {
			ctx.notice("warn", councilRefusalWords(outcome.reason).replace("/council", "/poll"));
			return;
		}
		if (outcome.tally !== undefined) ctx.notice("info", formatPollTally(outcome.tally, options.participants));
		if (outcome.status === "error") ctx.notice("warn", `/poll: ${councilFailureWords(outcome.message)}`);
	} catch (err) {
		ctx.notice("error", `/poll failed: ${councilFailureWords(err instanceof Error ? err.message : String(err))}`);
	}
}

/**
 * The note a run becomes, with a council run treated as what it is.
 *
 * A council synthesis run seals the whole `council-report`, so sharing its id
 * shares the council: every final member's labelled answer and the synthesis,
 * as one bounded block. A member run seals one voice, so it travels under the
 * roster label the operator watched it under. Every other run keeps the note it
 * has always had. A synthesis whose sealed text does not parse as a report is
 * shared verbatim rather than dropped: the operator asked for that run.
 */
function councilAwareShareNote(facts: WorkerShareFacts, entry: WorkerEntryState): string | null {
	const council = entry.council;
	if (council === undefined) return formatWorkerShareNote(facts);
	if (council.label !== COUNCIL_SYNTHESIS_LABEL) return formatCouncilMemberShareNote(facts, council.label);
	const report = parseCouncilReport(facts.text);
	return report === null ? formatWorkerShareNote(facts) : formatCouncilShareNote(facts, report);
}

/**
 * `/share [runId]`: hand a finished worker run's answer to the main agent.
 *
 * Nothing here is implicit. The operator either typed the command or passed
 * `--share`, and the note travels the ordinary user-turn path, so the model
 * receives it exactly as it receives anything else the operator writes.
 */
export function shareWorkerRun(runId: string | undefined, ctx: SlashCommandContext): void {
	if (!ctx.submitOperatorNote) {
		ctx.notice("error", "share is not wired; the worker transcript is unavailable in this session");
		return;
	}
	const entry = selectWorkerRunToShare(ctx.listWorkerRuns?.() ?? [], runId);
	if (!entry) {
		ctx.notice(
			"error",
			runId === undefined ? "no finished /run result for /fleet share yet" : `no finished run ${runId} in this session`,
		);
		return;
	}
	const facts = workerShareFactsFromEntry(entry);
	const note = facts === null ? null : councilAwareShareNote(facts, entry);
	if (note === null) {
		ctx.notice("error", `run ${entry.runId} produced no text to share`);
		return;
	}
	ctx.submitOperatorNote(note);
}

export const RUN_THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = THINKING_LEVELS;

export function isRunThinkingLevel(value: string): value is ThinkingLevel {
	return RUN_THINKING_LEVELS.some((level) => level === value);
}
