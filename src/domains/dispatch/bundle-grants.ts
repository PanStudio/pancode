// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { emitApproval } from "../../core/telemetry/approvals.js";
import {
	executeTaskLand,
	hostLandRefusal,
	landCardPin,
	landCardPinDrift,
	planTaskLand,
	type TaskLandPlan,
} from "../../tools/task-land.js";
import { allowedWorktreeParents } from "../../tools/worktree-root.js";
import { listDetachedBatches } from "./batch-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { operatorContainedYolo } from "./bundle-support.js";
import type { ActiveRun } from "./bundle-types.js";
import type { DispatchLandOutcome, WorkerGrantView } from "./contract.js";
import { createCrossProcessFleet, type ForeignAnswerOrigin } from "./cross-process-fleet.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { createGrantBroker, type GrantRecord, type GrantState } from "./grant-broker.js";
import {
	askLandCard,
	askMergeCard,
	createMergeCardQueue,
	type MergeCardInput,
	type MergeCardOutcome,
	mergeCardCauseNote,
} from "./merge-card.js";
import { dispatchOwnership } from "./ownership.js";
import { createWorkerApprovalWindows } from "./worker-approval-window.js";

export function createGrantDesk(rt: DispatchRuntime) {
	const { context, options } = rt;
	const { getEffectiveSettings, getProtectedArtifactState, monotonicNow, now, withLiveAutonomy } = rt.core;
	// Phase D: the trusted broker for worker asks routed to the main agent. It
	// is process-local, like the workers it answers.
	// Contained yolo never waits for the operator, so its worker asks and
	// operator rails are answered as unattended even where a person could be.
	const grantAttended = (): boolean =>
		options?.workerPermissionResponder === true && !operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()));
	// One merge card is on screen at a time. A batch can withhold several
	// members, each waits its turn here while the members that merge cleanly
	// have already landed.
	const mergeCardQueue = createMergeCardQueue();
	const askWithheldMerge = async (run: ActiveRun, input: MergeCardInput): Promise<MergeCardOutcome | null> => {
		const operator = options?.operatorAsk;
		if (operator === undefined || !operator.available()) return null;
		// Contained yolo never waits on a card: the merge stays withheld, its branch preserved, as headless.
		if (operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()))) return null;
		// A run canceled before its turn never shows a card; the watch below polls
		// once a second and would let one flash up first.
		if (run.aborted) return null;
		// The worker has exited and nothing runs on its lease, but the assignment
		// holds a global, node, and endpoint slot until the receipt settles, and an
		// attended card has no deadline. Release it so a lone dispatch is not
		// queued behind a slot nothing uses. Not when a sibling is queued or still
		// active: releasing is what would admit it into this checkout while the
		// operator's Merge lands (the writer lease refuses only an overlapping
		// writer from another dispatch call, never one beside a worktree run, so it
		// would not stop it), and a batch's members share one checkout. They keep
		// today's order, with the slot held until the card settles. The later settle
		// releases by the same assignment id and finds nothing left when released.
		const siblingsShareCheckout =
			rt.capacity.pendingCapacity.size > 0 || [...rt.runs.active.values()].some((other) => other.runId !== run.runId);
		if (!siblingsShareCheckout) rt.capacity.capacityAdmission.releaseAssignment(run.lineage.rootRunId);
		const canceled = new AbortController();
		const watch = setInterval(() => {
			if (run.aborted) canceled.abort();
		}, 1000);
		watch.unref?.();
		// The worker has exited, so its heartbeat and pid say nothing about this run.
		// Mark the run as waiting on the operator and let the orchestrator vouch for
		// it: the watchdog stops classifying it stale or dead, and a second PanCode on
		// this state directory sees a live pid instead of an abandoned row.
		const workerPid = rt.runs.ledger?.get(run.runId)?.pid ?? null;
		run.awaitingOperator = true;
		const vouch = (): void => {
			rt.runs.ledger?.update(run.runId, {
				status: "running",
				pid: process.pid,
				heartbeatAt: new Date(now()).toISOString(),
				outcomeDetail: "awaiting operator: merge card",
			});
		};
		vouch();
		try {
			return await mergeCardQueue(async () => {
				// A card queued behind others can outlive its run.
				if (run.aborted) return null;
				// An attended operator decides in their own time, like a permission
				// prompt: a card that settled itself after two minutes vanished with
				// no word on screen. Esc and a run cancel still settle on Keep branch.
				return askMergeCard({ ask: operator.ask, signal: canceled.signal }, input);
			});
		} catch (error) {
			// A card that cannot be shown leaves the merge withheld, the same as no operator.
			reportDispatchDiagnostic(`merge card for ${run.runId}`, error);
			return null;
		} finally {
			clearInterval(watch);
			run.awaitingOperator = false;
			rt.runs.ledger?.update(run.runId, { pid: workerPid, outcomeDetail: null });
		}
	};
	// `dispatch land`: the agent asks, the operator answers a Land card, and the
	// host lands the branch with fleet land's checks, so a sandboxed agent never
	// needs a sandbox escape to land a branch the operator approves.
	const landKeptTask = async (input: {
		ref: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<DispatchLandOutcome> => {
		const refused = (why: string): DispatchLandOutcome => ({
			outcome: "refused",
			detail: `${why}; nothing landed, and the operator can land it with \`pancode fleet land ${input.ref}\``,
		});
		const operator = options?.operatorAsk;
		if (operator === undefined || !operator.available()) return refused("no operator is attached to answer a Land card");
		if (operatorContainedYolo(withLiveAutonomy(getEffectiveSettings())))
			return refused("contained yolo never waits on a Land card");
		const protectedNow = (): string[] => getProtectedArtifactState().artifacts.map((artifact) => artifact.path);
		const planNow = (): TaskLandPlan =>
			planTaskLand({
				root: input.cwd,
				ref: input.ref,
				mode: "merge",
				allowedParents: allowedWorktreeParents(getEffectiveSettings()?.fleet?.worktrees?.root ?? "disk", input.cwd),
			});
		let plan: TaskLandPlan;
		try {
			plan = planNow();
			const refusal = hostLandRefusal(plan, protectedNow());
			if (refusal !== null) return { ...refused(`cannot land: ${refusal}`), branch: plan.branch };
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
		const shown = landCardPin(plan);
		let card: MergeCardOutcome;
		try {
			card = await mergeCardQueue(() =>
				askLandCard(
					{ ask: operator.ask, ...(input.signal !== undefined ? { signal: input.signal } : {}) },
					{
						branch: plan.branch,
						destination: plan.destination,
						commits: plan.commits,
						changed: plan.changed,
						uncommitted: plan.uncommitted,
					},
				),
			);
		} catch (error) {
			reportDispatchDiagnostic(`land card for ${plan.runId}`, error);
			return { ...refused("the Land card could not be shown"), branch: plan.branch };
		}
		if (card.choice !== "land")
			return {
				outcome: "kept",
				branch: plan.branch,
				detail: `the operator kept ${plan.branch} (${mergeCardCauseNote(card.cause)}); nothing landed`,
			};
		try {
			// The card waits as long as the operator takes, so the branch, its worktree, the destination and
			// protection are all read again here, and Land holds only for what the card showed.
			const landing = planNow();
			const moved = landCardPinDrift(landing, shown);
			if (moved !== null) return { ...refused(`the operator chose Land, but ${moved}`), branch: plan.branch };
			const refusal = hostLandRefusal(landing, protectedNow());
			if (refusal !== null) return { ...refused(`the operator chose Land, but ${refusal}`), branch: plan.branch };
			const result = executeTaskLand(landing);
			return {
				outcome: "landed",
				branch: landing.branch,
				detail: `${result.landed !== null ? `landed ${result.landed.slice(0, 9)} on ${landing.destination}` : `nothing new to land on ${landing.destination}`} on the operator's Land; ${result.detail}`,
			};
		} catch (error) {
			return {
				...refused(`the operator chose Land, but ${error instanceof Error ? error.message : String(error)}`),
				branch: plan.branch,
			};
		}
	};
	const grantRunFallbacks = new Map<string, "deny" | "fail">();
	const grantPendingListeners = new Set<(view: WorkerGrantView) => void>();
	const grantView = (record: GrantRecord): WorkerGrantView => ({
		requestId: record.requestId,
		runId: record.runId,
		rootRunId: record.rootRunId,
		attempt: record.attempt,
		agentId: record.agentId,
		tool: record.tool,
		actionClass: record.actionClass,
		approvalAuthority: record.approvalAuthority,
		state: record.state,
		execution: record.execution,
		...(record.issuer !== undefined ? { issuer: record.issuer } : {}),
		summary: record.summary,
		...(record.target !== undefined ? { target: record.target } : {}),
		reasons: [...record.reasons],
		createdAt: new Date(record.createdAt).toISOString(),
		// A window this process runs ends the request well before its record's ceiling.
		deadlineAt: new Date(
			record.state === "pending"
				? now() + (workerApprovalWindows.read(record.requestId)?.remainingMs ?? record.deadlineAt - now())
				: record.deadlineAt,
		).toISOString(),
		...(record.reason !== undefined ? { reason: record.reason } : {}),
		...(record.forwardedByMain === true ? { forwardedByMain: true as const } : {}),
		...(record.reviewer !== undefined ? { reviewer: record.reviewer } : {}),
	});
	/**
	 * Answers another PanCode process gave through a run's grant records, by request id, until their resolution is
	 * published: the resolution then names that process instead of reading like this process's own card.
	 */
	const answeredElsewhere = new Map<string, ForeignAnswerOrigin>();
	const answeredElsewhereReason = (decision: "approve" | "deny", origin: ForeignAnswerOrigin): string =>
		`${decision === "approve" ? "approved" : "denied"} by the operator in another PanCode process (pid ${origin.pid}${origin.host !== null ? ` on ${origin.host}` : ""})`;
	const publishGrantChange = (record: GrantRecord, previous: GrantState | null): void => {
		const origin = `worker:${record.runId}`;
		const fallback = grantRunFallbacks.get(record.runId) ?? "deny";
		if (record.state !== "pending") workerApprovalWindows.settle(record.requestId);
		const requested = (escalation: boolean): void => {
			emitApproval(context.bus, "approval.requested", {
				tool: record.tool,
				actionClass: record.actionClass,
				...(record.ownerSessionId !== null ? { sessionId: record.ownerSessionId } : {}),
				requestedBy: record.runId,
				requestId: record.requestId,
				origin,
				agentId: record.agentId,
				summary: record.summary,
				...(record.target !== undefined ? { target: record.target } : {}),
				...(record.consequence !== undefined ? { consequence: [...record.consequence] } : {}),
				reasons: [...record.reasons],
				timeoutMs: workerApprovalWindows.read(record.requestId)?.remainingMs ?? Math.max(0, record.deadlineAt - now()),
				fallback,
				escalation,
				// Why a forwarded request reached the operator, such as changed git hooks, leads its reasons.
				...(record.forwardedByMain === true && record.reason !== undefined
					? { reasons: [record.reason, ...record.reasons] }
					: {}),
				approvalAuthority: record.approvalAuthority,
				...(record.forwardedByMain === true ? { forwardedByMain: true } : {}),
				...(record.reviewer !== undefined ? { reviewer: record.reviewer } : {}),
			});
		};
		if (previous === null) {
			// Opened before the card is told, so its first frame already reads this window.
			if (record.windowMs !== undefined) {
				workerApprovalWindows.open({
					runId: record.runId,
					agentId: record.agentId,
					requestId: record.requestId,
					windowMs: record.windowMs,
					fallback,
					decider:
						record.approvalAuthority === "operator" ? "operator" : record.reviewer === "safety-judge" ? "judge" : "main",
					deny: () => {
						grantBroker.expire(record.requestId);
						return true;
					},
					extend: (holdMs) => rt.runs.active.get(record.runId)?.holdPermission?.(record.workerRequestId, holdMs) ?? false,
				});
			}
			// An operator rail goes straight to the operator's card when this
			// process has one; an ordinary ask waits for the main agent, whose
			// dispatch call yields on it.
			requested(record.approvalAuthority === "operator" && grantAttended());
			// The safety judge decides a judge-routed ask, so the main agent is not woken for it.
			if (record.approvalAuthority === "main" && record.reviewer === undefined) {
				const view = grantView(record);
				for (const listener of grantPendingListeners) {
					try {
						listener(view);
					} catch {
						// A listener failure never changes the record; the model still reaches it through monitor.
					}
				}
			}
			return;
		}
		if (previous === "pending" && record.state === "pending") {
			// The main agent approved below yolo: the operator decides, with the
			// main agent's request as provenance.
			if (record.forwardedByMain === true && record.approvalAuthority === "main") {
				// The time so far went to the judge or the main agent, so the person gets the whole window.
				workerApprovalWindows.handToOperator(record.requestId);
				requested(true);
			}
			return;
		}
		if (record.state === previous || record.state === "executing") return;
		const status =
			record.state === "denied" || record.state === "canceled"
				? "denied"
				: record.state === "expired"
					? "expired"
					: record.issuer !== undefined
						? "granted"
						: "denied";
		const decidedBy =
			record.state === "expired"
				? "timeout"
				: record.state === "canceled"
					? "revoked"
					: record.issuer !== undefined
						? record.issuer === "operator" && answeredElsewhere.has(record.requestId)
							? "operator:another-process"
							: record.forwardedByMain === true && record.issuer === "operator"
								? "operator:forwarded-by-main"
								: record.reviewer === "safety-judge" && record.issuer === "main"
									? "safety-judge"
									: record.issuer
						: "worker";
		answeredElsewhere.delete(record.requestId);
		emitApproval(context.bus, "approval.resolved", {
			status,
			tool: record.tool,
			requestId: record.requestId,
			...(record.ownerSessionId !== null ? { sessionId: record.ownerSessionId } : {}),
			origin,
			decidedBy,
			actionClass: record.actionClass,
			...(record.reason !== undefined ? { reason: record.reason } : {}),
			requestedBy: record.runId,
			...(record.state === "expired" ? { fallback } : {}),
			grant: {
				attempt: record.attempt,
				authority: record.approvalAuthority,
				...(record.issuer !== undefined ? { issuer: record.issuer } : {}),
				execution: record.execution,
				state: record.state,
			},
		});
	};
	const grantBroker = createGrantBroker({
		now,
		deliver: (record, decision, reason, cause) => {
			const parked = rt.retry.writeRootPark.deliver(record, decision, reason);
			if (parked !== null) return parked;
			const run = rt.runs.active.get(record.runId);
			if (run?.resolvePermission === undefined) return false;
			return run.resolvePermission(
				record.workerRequestId,
				decision,
				{
					attemptToken: record.attemptToken,
					attempt: record.attempt,
					argDigest: record.argDigest,
					issuer: record.issuer ?? "operator",
					runId: record.runId,
					grantId: record.requestId,
					reason: reason.slice(0, 300),
				},
				cause,
			);
		},
		onChange: (record, previous) => publishGrantChange(record, previous),
	});
	// Cross-process fleet state (M11): run-directory records for this process's runs and asks, and, where a person can
	// answer, the live runs and held asks of other PanCode processes on this state directory.
	const crossProcessFleet = createCrossProcessFleet({
		bus: context.bus,
		isLocalRun: (runId) => rt.runs.active.has(runId) || rt.control.currentAssignmentRun(runId) !== null,
		grantBinding: (requestId) => {
			const record = grantBroker.get(requestId);
			return record === null ? null : { attempt: record.attempt, argDigest: record.argDigest };
		},
		resolve: (runId, requestId, decision, answeredBy) => {
			answeredElsewhere.set(requestId, answeredBy);
			try {
				rt.contract.contract.resolveWorkerPermission?.(runId, requestId, decision);
			} catch (error) {
				answeredElsewhere.delete(requestId);
				throw error;
			}
		},
		follow: options?.workerPermissionResponder === true,
	});
	/** Asks a fork adopted from the parked session that held them, by request id; a brokered ask's record holds its own. */
	const adoptedAsks = new Map<string, { runId: string; sessionId: string }>();
	/**
	 * The session an ask belongs to when that is not the current one, which alone may answer it, else null. An ask
	 * whose holder is an ancestor of the current session is orphaned: one process runs one session, so the holder is
	 * parked and the ask lives only here. The fork adopts it the way it inherits a collect (bt-11), and from then on
	 * the parent no longer holds it. Steering and cancelling the run stay with the session that dispatched it.
	 */
	function foreignAskOwner(runId: string, requestId: string): string | null {
		const brokered = grantBroker.get(requestId);
		const ownerSessionId =
			brokered?.ownerSessionId ??
			adoptedAsks.get(requestId)?.sessionId ??
			rt.control.currentAssignmentRun(runId)?.req.ownerSessionId ??
			null;
		const current = rt.contract.contract.owner?.();
		if (ownerSessionId === null || current === undefined || ownerSessionId === current.sessionId) return null;
		if (current.sessionId === null || !dispatchOwnership(current).inherits({ sessionId: ownerSessionId })) {
			return ownerSessionId;
		}
		if (brokered === null) adoptedAsks.set(requestId, { runId, sessionId: current.sessionId });
		else if (grantBroker.adopt(requestId, current.sessionId) === null) return ownerSessionId;
		return null;
	}
	const dropAdoptedAsks = (runId: string): void => {
		for (const [requestId, adopted] of adoptedAsks) if (adopted.runId === runId) adoptedAsks.delete(requestId);
	};
	const heldAskRefusal = (holder: string, runId: string): string =>
		`the ask is held by session ${holder} (run '${runId}'); only that session can answer it. /resume ${holder} to answer it`;
	/** Sessions a fork parked, whose brokered asks wait for the fork's open to adopt or revoke them. */
	const forkParkedSessionIds: Array<string | null> = [];
	/** The current session adopts every brokered ask an ancestor left pending, so its main agent and card see them. */
	const adoptOrphanedGrants = (): void => {
		for (const record of grantBroker.list({ state: "pending" })) foreignAskOwner(record.runId, record.requestId);
	};
	const workerApprovalWindows = createWorkerApprovalWindows({
		now: monotonicNow,
		onChange: ({ runId, agentId, requestId }, view) => {
			const owner = foreignAskOwner(runId, requestId);
			context.bus.emit("run.progressed", {
				runId,
				agentId,
				event: {
					type: "pancode_permission_window",
					payload: {
						requestId,
						held: view.held,
						expiresAt: now() + view.remainingMs,
						fallback: view.fallback,
						decider: view.decider,
						...(owner !== null ? { owner } : {}),
					},
				},
			});
		},
	});
	const grantUnsubscribes: Array<() => void> = [];

	/** Phase D revocation subscriptions, held until stop(). */
	function subscribeGrantRevocation(): void {
		grantUnsubscribes.push(
			context.bus.subscribe("session.parked", (payload) => {
				// A fork adopts what its parent held (bt-11); the fork's own open, next, revokes only what it did not adopt.
				if (payload.reason === "fork") {
					forkParkedSessionIds.push(payload.sessionId);
					return;
				}
				grantBroker.revokeSession(
					payload.sessionId,
					`the owning session was ${payload.reason === "close" ? "closed" : "parked"}`,
				);
			}),
			// A fork, or a /resume back to the dispatching session, changes who may answer an open ask.
			context.bus.subscribe("session.created", () => {
				adoptOrphanedGrants();
				for (const sessionId of forkParkedSessionIds.splice(0)) {
					grantBroker.revokeSession(sessionId, "the owning session was parked");
				}
				workerApprovalWindows.republish();
			}),
			context.bus.subscribe("session.reattached", () => {
				adoptOrphanedGrants();
				workerApprovalWindows.republish();
			}),
			context.bus.subscribe("session.ended", () => {
				const sessions = new Set(grantBroker.list({ state: "pending" }).map((record) => record.ownerSessionId));
				for (const sessionId of sessions) grantBroker.revokeSession(sessionId, "the owning session ended");
			}),
			context.bus.subscribe("turn.aborted", () => {
				const sessionId = options?.getSessionId?.() ?? null;
				const batches = listDetachedBatches().filter(
					(batch) => batch.sessionId === sessionId && (sessionId !== null || batch.cwd === process.cwd()),
				);
				const detachedAssignments = new Set(batches.flatMap((batch) => batch.runs.map((run) => run.assignmentId)));
				// #425: detached permission requests belong to their assignments, beyond a foreground cancel.
				for (const grant of grantBroker.list({ sessionId, state: "pending" })) {
					if (!detachedAssignments.has(grant.rootRunId) && rt.runs.active.get(grant.runId)?.detached !== true) {
						grantBroker.revokeRun(grant.runId, "the owning main turn was cancelled");
					}
				}
			}),
		);
	}

	function disposeGrants(): void {
		for (const unsubscribe of grantUnsubscribes.splice(0)) unsubscribe();
		grantBroker.dispose();
		crossProcessFleet.dispose();
		workerApprovalWindows.dispose();
	}

	return {
		adoptedAsks,
		answeredElsewhere,
		answeredElsewhereReason,
		askWithheldMerge,
		crossProcessFleet,
		disposeGrants,
		dropAdoptedAsks,
		foreignAskOwner,
		grantAttended,
		grantBroker,
		grantPendingListeners,
		grantRunFallbacks,
		grantView,
		heldAskRefusal,
		landKeptTask,
		subscribeGrantRevocation,
		workerApprovalWindows,
	};
}
