// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { openAgentLedger } from "../domains/dispatch/agent-ledger-store.js";
import type { DetachedBatchRun } from "../domains/dispatch/batch-store.js";
import type { DispatchContract, DispatchRequest, WorkerGrantView } from "../domains/dispatch/contract.js";
import { dispatchOwnerOf } from "../domains/dispatch/ownership.js";
import { fallbackProgressBus, newGateGroupId, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import type { CompletedRun } from "./dispatch-output.js";
import type { DispatchToolDeps } from "./dispatch-types.js";
import { grantRequestLines } from "./grant-request-text.js";
import type { ToolResult } from "./tool-spec.js";

/**
 * One-shot latch an attached executor races against its runs. Firing it never
 * aborts anything: the registry drain that meters the runs was never owned by
 * the awaiting code path, so unwinding the await leaves token metering, run
 * tails, and bus progress flowing.
 */
export interface BackgroundSwitch {
	/** Resolves when the operator fires the control; never rejects. */
	readonly requested: Promise<void>;
	fire(): void;
}

export function createBackgroundSwitch(): BackgroundSwitch {
	let fired = false;
	let signal = (): void => {};
	const requested = new Promise<void>((resolve) => {
		signal = resolve;
	});
	return {
		requested,
		fire: () => {
			if (fired) return;
			fired = true;
			signal();
		},
	};
}

/**
 * Resolves when a worker in this call parks an ask for the main agent (Phase
 * D). The attached call then yields: the main agent cannot decide while it is
 * still inside this call, so waiting would only run the request out.
 */
interface GrantYieldWatch {
	requested: Promise<{ kind: "yield"; views: WorkerGrantView[] }>;
	dispose(): void;
}

export function watchGrantYield(dispatch: DispatchContract, runIds: () => ReadonlyArray<string>): GrantYieldWatch {
	const grants = dispatch.grants;
	if (grants === undefined) return { requested: new Promise(() => {}), dispose: () => {} };
	const matches = (view: WorkerGrantView): boolean => {
		// A judge-reviewed ask settles on the safety judge's verdict; the call need not yield for it.
		if (view.approvalAuthority !== "main" || view.state !== "pending" || view.reviewer !== undefined) return false;
		const ids = runIds();
		return ids.includes(view.rootRunId) || ids.includes(view.runId);
	};
	let resolveYield: (value: { kind: "yield"; views: WorkerGrantView[] }) => void = () => {};
	const requested = new Promise<{ kind: "yield"; views: WorkerGrantView[] }>((resolve) => {
		resolveYield = resolve;
	});
	const settle = (): void => {
		const views = grants.list({ pendingOnly: true }).filter(matches);
		if (views.length > 0) resolveYield({ kind: "yield", views: [...views] });
	};
	const unsubscribe = grants.onPending((view) => {
		if (matches(view)) settle();
	});
	// A request parked before the watch started is found by this first check.
	settle();
	return { requested, dispose: unsubscribe };
}

/**
 * Fan out without waiting: admit and spawn every task, persist the durable
 * batch record, then hand the merged event stream to a background drain so
 * token metering, run tails (monitor peek), and bus progress keep flowing
 * while the orchestrator's turn continues. The tool result carries only the
 * batch id and run ids; results are gathered later through monitor
 * mode="wait"/"collect", in this session or after a resume.
 */
export async function runDetached(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	sessionId: string | null,
): Promise<ToolResult> {
	const detached = deps.dispatch.detached;
	if (!detached) {
		return { kind: "error", message: "dispatch: detach is not supported in this context" };
	}
	// Detached runs are concurrent peers too, so they get a board whenever there
	// is more than one of them. Collection closes it, which can happen in a later
	// process, so the batch record carries the id.
	const ledgerId = requests.length >= 2 ? newGateGroupId("ledger") : null;
	if (ledgerId !== null) await openAgentLedger(ledgerId);
	const ledgered =
		ledgerId === null ? requests : requests.map((request) => ({ ...request, ledger: { id: ledgerId, sequence: 0 } }));
	const handle = await deps.dispatch.dispatchBatch(ledgered);
	const registered = deps.runEvents.registerBatch(
		handle,
		ledgered.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
	const assignmentIds = handle.assignmentIds;
	const runs = handle.assignmentIds.map((runId, index) => ({
		runId,
		assignmentId: assignmentIds[index] ?? runId,
		agentId: requests[index]?.agentId ?? "unknown",
	}));
	registered.completion.catch(() => {});
	// The runs are live; make their assignment records durable before returning
	// so an immediate collect resolves the logical assignment (and any queued
	// retry) instead of falling back to a bare, possibly-failed first attempt.
	await deps.dispatch.assignments?.flushWrites?.();
	try {
		await detached.register({
			batchId: handle.batchId,
			runs,
			sessionId,
			cwd: dispatchOwnerOf(deps.dispatch, sessionId).cwd,
			...(ledgerId !== null ? { ledgerId } : {}),
		});
	} catch (err) {
		// The runs are already live; report the durability gap instead of
		// pretending the batch does not exist.
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "error",
			message: `dispatch: detached assignments started (batch=${handle.batchId}, assignments=${handle.assignmentIds.join(", ")}) but the durable batch record failed: ${message}`,
			details: { mode: "detached", batchId: handle.batchId, assignmentIds: [...handle.assignmentIds] },
		};
	}
	const lines = [
		`dispatch (detached) batch=${handle.batchId} started ${runs.length} run(s)`,
		...runs.map((run) => {
			const withheld = deps.dispatch.getRun(run.runId)?.projection?.withheld ?? [];
			return `- ${run.assignmentId} agent=${run.agentId}${withheld.length > 0 ? ` [withheld: ${withheld.map((entry) => entry.capability).join(", ")}]` : ""}`;
		}),
		...(runs.some((run) =>
			(deps.dispatch.getRun(run.runId)?.projection?.withheld ?? []).some(
				(entry) => entry.reason === "write-roots-unconfined",
			),
		)
			? [CHECKS_WITHHELD_DETACHED]
			: []),
		"",
		`Runs continue in the background. Collect results with monitor(mode="collect", batch_id="${handle.batchId}"); block on one run with monitor(mode="wait", run_id=<id>).`,
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "detached",
			batchId: handle.batchId,
			assignmentIds: [...handle.assignmentIds],
			runs: runs.map((run) => ({ runId: run.runId, assignmentId: run.assignmentId, agentId: run.agentId })),
		},
	};
}

/**
 * Runs started with write roots no OS sandbox enforces have no bash or verify.
 * The parent learned that only after collect and briefed checks the workers
 * could not run (CLI-H2), so the start result says it per run.
 */
const CHECKS_WITHHELD_DETACHED =
	"Runs whose [withheld] list names bash or verify have write roots with neither an OS sandbox nor a task worktree binding commands to them, so they cannot run checks: they report edits, and you run the checks after collect. worktree: true, or no write roots, keeps bash and verify.";

/**
 * Publish this call's conversion control for as long as its topology branch
 * runs. A refusing control still registers: the operator who pressed the key
 * needs the topology's reason, and an unregistered call would answer with the
 * "nothing running" no-op instead.
 */
export function registerBackgroundControl(
	deps: DispatchToolDeps,
	toolCallId: string | undefined,
	plan: { label: string; refusal: string | null; fire: () => void },
): () => void {
	const registry = deps.background;
	if (registry === undefined || toolCallId === undefined || toolCallId.length === 0) return () => {};
	let release = (): void => {};
	release = registry.register({
		toolCallId,
		label: plan.label,
		convert: () => {
			if (plan.refusal !== null) {
				return { ok: false, message: `${plan.label} cannot be backgrounded: ${plan.refusal}` };
			}
			// Drop the control before firing so a second keypress reaches the next
			// attached dispatch instead of re-firing a converted one.
			release();
			plan.fire();
			return { ok: true, message: `${plan.label} is moving to the background as a detached batch` };
		},
	});
	return () => release();
}

/**
 * Thrown out of an attached executor when the operator converts the call to a
 * detached batch. The runs keep going; only the await unwinds. `settled` names
 * sequential steps that already finished, and `undispatched` names later steps
 * that were never started, because a mid-sequence conversion really does leave
 * them unstarted and reporting a completed sequence would be a lie.
 */
export class DispatchBackgroundedError extends Error {
	constructor(
		readonly batchId: string,
		readonly live: ReadonlyArray<DetachedBatchRun>,
		readonly settled: ReadonlyArray<CompletedRun>,
		readonly undispatched: ReadonlyArray<string>,
		/**
		 * The agent ledger the live runs still share. It stays open across the
		 * conversion and rides on the detached record so collect closes it, the
		 * same as a batch that was detached from the start.
		 */
		readonly ledgerId: string | null = null,
		/** Set when the call yielded to the main agent for a worker's permission request (Phase D). */
		readonly yielded: ReadonlyArray<WorkerGrantView> = [],
	) {
		super(
			yielded.length > 0 ? "dispatch: yielded for a worker permission request" : "dispatch: backgrounded by operator",
		);
		this.name = "DispatchBackgroundedError";
	}
}

/**
 * Finish an operator-initiated conversion: persist the same durable batch
 * record a `detach: true` call would have written, so monitor collect, the
 * completion nudge, and resume all attach to it exactly as they do for a
 * model-initiated detach, then answer the model in the detached shape.
 */
export async function backgroundedDispatchResult(
	deps: RegisteredDispatchToolDeps,
	converted: DispatchBackgroundedError,
	mode: string,
	sessionId: string | null,
): Promise<ToolResult> {
	const liveIds = converted.live.map((run) => run.assignmentId);
	const detached = deps.dispatch.detached;
	if (!detached) {
		return {
			kind: "error",
			message: `dispatch: the operator moved this call to the background, but detached batch records are unavailable in this context; ${liveIds.join(", ")} keep running and can only be reached with monitor(mode="wait", run_id=<id>)`,
			details: { mode: "detached", assignmentIds: liveIds },
		};
	}
	// Same ordering as runDetached: the runs are already live, so their
	// assignment records must land before the batch record an immediate collect
	// would resolve through.
	await deps.dispatch.assignments?.flushWrites?.();
	try {
		await detached.register({
			batchId: converted.batchId,
			runs: converted.live,
			sessionId,
			cwd: dispatchOwnerOf(deps.dispatch, sessionId).cwd,
			...(converted.ledgerId !== null ? { ledgerId: converted.ledgerId } : {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "error",
			message: `dispatch: the operator moved this call to the background (batch=${converted.batchId}, assignments=${liveIds.join(", ")}) but the durable batch record failed: ${message}`,
			details: { mode: "detached", batchId: converted.batchId, assignmentIds: liveIds },
		};
	}
	const yielded = converted.yielded;
	const lines =
		yielded.length > 0
			? [
					`dispatch (${mode}) yielded to you: a worker is waiting for your permission decision. batch=${converted.batchId} holds ${converted.live.length} still-running assignment(s)`,
					...converted.live.map((run) => `- ${run.assignmentId} agent=${run.agentId}`),
					"",
					...yielded.flatMap((view) => grantRequestLines(view)),
				]
			: [
					`dispatch (${mode}) was moved to the background by the operator: batch=${converted.batchId} holds ${converted.live.length} still-running assignment(s)`,
					...converted.live.map((run) => `- ${run.assignmentId} agent=${run.agentId}`),
				];
	if (converted.settled.length > 0) {
		lines.push(
			`${converted.settled.length} earlier ${mode} step(s) had already finished and are not in this batch: ${converted.settled.map((run) => run.receipt.runId).join(", ")}. Read them with monitor(mode="record", run_id=<id>).`,
		);
	}
	if (converted.undispatched.length > 0) {
		lines.push(
			`${converted.undispatched.length} later ${mode} step(s) were never dispatched (agents: ${converted.undispatched.join(", ")}); re-issue them if they are still wanted.`,
		);
	}
	lines.push(
		"",
		`Runs continue in the background. Collect results with monitor(mode="collect", batch_id="${converted.batchId}"); block on one run with monitor(mode="wait", run_id=<id>).`,
	);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "detached",
			conversion: yielded.length > 0 ? "permission-yield" : "operator-backgrounded",
			...(yielded.length > 0 ? { pendingPermissions: yielded.map((view) => ({ ...view })) } : {}),
			batchId: converted.batchId,
			assignmentIds: liveIds,
			runs: converted.live.map((run) => ({ runId: run.runId, assignmentId: run.assignmentId, agentId: run.agentId })),
			settledRunIds: converted.settled.map((run) => run.receipt.runId),
			undispatchedAgentIds: [...converted.undispatched],
		},
	};
}
