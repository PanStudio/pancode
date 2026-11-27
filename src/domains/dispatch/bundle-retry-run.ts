// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { writeHeadlessDiagnostic } from "../../core/diagnostics.js";
import { requestOriginFor } from "./admission-scope.js";
import { applyActiveRouteSelection, asAssignmentId } from "./assignment.js";
import type { AssignmentAttemptStartEvent } from "./assignment-events.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { RetryRoutesRefusedError, routeRefusalWords } from "./bundle-support.js";
import type { ActiveRun, NextRetryRoute } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { decideRetry, type RetryDecision } from "./failure-classification.js";
import { resolveJointRoute } from "./joint-route-resolver.js";
import * as recovery from "./recovery-candidates.js";
import { eligibleAlternateRoute } from "./retry-route-plan.js";
import { assertApprovedRecoveryCapability } from "./route-approval.js";
import { newRunId } from "./state.js";
import type { RunOutcome, RunResult } from "./types.js";
import type { DispatchFailoverCandidate } from "./validation.js";
import type { WriteRootContinuation } from "./write-root-requests.js";

export function createRetryRunner(rt: DispatchRuntime) {
	const { context } = rt;
	const { agents, assignments, getEffectiveSettings, providers, targetCooldownReason } = rt.core;

	function assertRouteWithinApprovedEnvelope(req: DispatchRequest, effective: DispatchFailoverCandidate): void {
		if (rt.retry.failoverModeFor(req) !== "approved") return;
		const allowed = req.allowedCandidates ?? [];
		if (!allowed.some((candidate) => recovery.sameFailoverCandidate(candidate, effective))) {
			throw new Error(
				`dispatch: admission denied: effective route agent=${effective.agentId} target=${effective.target} model=${effective.model} node=${effective.node} is outside the approved failover envelope`,
			);
		}
	}

	function approvedRetryCandidates(run: ActiveRun, decision: RetryDecision): DispatchFailoverCandidate[] {
		return recovery.selectApprovedRecoveryCandidates({
			current: { agentId: run.agentId, target: run.targetId, model: run.wireModelId, node: run.node?.id ?? "local" },
			allowed: run.req.allowedCandidates ?? [],
			approval: run.req.routeApproval ?? null,
			decision,
		});
	}

	async function executeRetry(
		run: ActiveRun,
		attempt: number,
		reason = "retry",
		decision: RetryDecision = decideRetry(
			"internal",
			rt.retry.memberRetryAttempt(run),
			rt.retry.assignmentPolicyFor(run.req).maxRetries,
		),
		/** Routes chosen at scheduling, by a context overflow or an unmet obligation, in the order to try them. */
		plannedRoutes: ReadonlyArray<DispatchFailoverCandidate> = [],
		moveReason = reason,
		continuation: WriteRootContinuation = {},
		/** An obligation retry: a refused route falls through to the next other-model route, never the failed model. */
		otherModelFallThrough = false,
	): Promise<void> {
		if (rt.drain.draining || !rt.retry.retryChainIsLive(run)) return;
		const excludesNode = decision.excludedRouteParts.includes("node");
		// Record the failed node so placement can choose an eligible survivor.
		const rerouteHops =
			excludesNode && run.node !== null
				? [...(run.req.reroutes ?? []), { attempt, fromNode: run.node.id, toNode: "", reason }]
				: run.req.reroutes;
		const retryReq: DispatchRequest = {
			...run.req,
			...continuation,
			...(rerouteHops !== undefined ? { reroutes: rerouteHops } : {}),
			// A retry that moves the target names one, which would otherwise read
			// as an operator pin and freeze every later retry in the chain.
			failover: rt.retry.failoverModeFor(run.req),
			requestOrigin: "internal",
			// Policy reads the stamp above; the board still names who asked for the work.
			rootRequestOrigin: run.req.rootRequestOrigin ?? requestOriginFor(run.req),
			routeMove: { fromTargetId: run.targetId, fromModelId: run.wireModelId, reason: moveReason },
			// A retry starts with no grants and runs no wider than this attempt.
			...(run.permit !== undefined ? { inheritedPermitAllowance: { ...run.permit.allowance } } : {}),
			lineage: {
				parentRunId: run.runId,
				rootRunId: run.lineage.rootRunId,
				attempt,
				depth: run.lineage.depth,
			},
		};
		// Every retry needs a fresh identity before preparation so its worker and
		// settlement share one run journal, independently of assignment lineage (#434).
		retryReq.runIdHint = newRunId();
		let terminal: Promise<RunResult> | undefined;
		/** Set when a refused admission can move the retry on to the next route. */
		let nextRoute: NextRetryRoute | null = null;
		const notRefused =
			(refused: ReadonlyArray<{ target: string; model: string }>) => (candidate: DispatchFailoverCandidate) =>
				!refused.some((entry) => entry.target === candidate.target && entry.model === candidate.model);
		const reasonKey = rt.retry.retryReasonKey(rt.control.controlRootFor(run.runId), attempt);
		rt.retry.retryReasons.set(reasonKey, reason);
		try {
			if (rt.retry.failoverModeFor(run.req) === "approved") {
				const candidates =
					plannedRoutes.length > 0
						? plannedRoutes.map((candidate) => ({ ...candidate }))
						: approvedRetryCandidates(run, decision);
				if (run.req.routeApproval === undefined) {
					const candidate = candidates[0] as DispatchFailoverCandidate;
					retryReq.agentId = candidate.agentId;
					retryReq.target = candidate.target;
					retryReq.model = candidate.model;
					retryReq.node = candidate.node;
					if (otherModelFallThrough) {
						// The envelope's later other-model candidates, in order, once each.
						let index = 0;
						nextRoute = () => {
							index += 1;
							return candidates[index] ?? null;
						};
					}
				} else {
					const approval = run.req.routeApproval;
					const settings = getEffectiveSettings();
					const approvedEnvelope = retryReq.allowedCandidates as DispatchFailoverCandidate[];
					/** The retry before any selection, so a later candidate starts from the same request. */
					const unselected: DispatchRequest = { ...retryReq };
					let lastError: unknown;
					/** Apply the first candidate from `start` the active resolver and the approval admit; its index, or null. */
					const selectFrom = (start: number): number | null => {
						for (let index = start; index < candidates.length; index += 1) {
							const candidate = candidates[index] as DispatchFailoverCandidate;
							const bounded = {
								...unselected,
								agentId: candidate.agentId,
								target: candidate.target,
								model: candidate.model,
								node: candidate.node,
								allowedCandidates: [candidate],
							};
							try {
								const active = resolveJointRoute(
									rt.route.jointRouteInput(bounded, undefined, settings, "active").input,
								).decision;
								assertApprovedRecoveryCapability(approval, active.selected);
								const selected = applyActiveRouteSelection(bounded, active);
								for (const key of Object.keys(retryReq)) {
									if (!Object.hasOwn(unselected, key)) Reflect.deleteProperty(retryReq, key);
								}
								Object.assign(retryReq, unselected);
								retryReq.routeAttemptDecision = active;
								Object.assign(retryReq, selected);
								retryReq.allowedCandidates = approvedEnvelope;
								return index;
							} catch (error) {
								lastError = error;
							}
						}
						return null;
					};
					let selectedIndex = selectFrom(0);
					if (selectedIndex === null) {
						const detail = lastError instanceof Error ? lastError.message : String(lastError);
						throw new Error(`dispatch: approved recovery has no active-eligible route (${detail})`);
					}
					if (otherModelFallThrough) {
						// Admission refused the selected candidate: the next other-model
						// one in the envelope, with its own active decision, once each.
						nextRoute = () => {
							selectedIndex = selectedIndex === null ? null : selectFrom(selectedIndex + 1);
							if (selectedIndex === null || retryReq.target === undefined || retryReq.model === undefined) return null;
							return {
								target: retryReq.target,
								model: retryReq.model,
								agentId: retryReq.agentId,
								...(retryReq.node !== undefined ? { node: retryReq.node } : {}),
							};
						};
					}
				}
				delete retryReq.plannedNode;
			} else {
				// Exact mode freezes the effective first-attempt tuple.
				if (rt.retry.failoverModeFor(run.req) === "none") {
					retryReq.agentId = run.agentId;
					retryReq.target = run.targetId;
					retryReq.model = run.wireModelId;
					retryReq.node = run.node?.id ?? "local";
				}
				const plannedRoute = plannedRoutes[0];
				if (plannedRoute !== undefined) {
					retryReq.target = plannedRoute.target;
					retryReq.model = plannedRoute.model;
					if (otherModelFallThrough) {
						nextRoute = (refused) => {
							const next = eligibleAlternateRoute(
								{ agents, getEffectiveSettings, providers, targetCooldownReason },
								run,
								retryReq,
								undefined,
								notRefused(refused),
								true,
							);
							return next === null ? null : { target: next.target, model: next.model };
						};
					}
				}
				// Automatic placement re-selects only the failed route component.
				if (excludesNode) {
					delete retryReq.node;
					delete retryReq.plannedNode;
				}
				if (decision.excludedRouteParts.includes("target")) {
					const alternate = eligibleAlternateRoute(
						{ agents, getEffectiveSettings, providers, targetCooldownReason },
						run,
						retryReq,
					);
					if (alternate !== null) {
						retryReq.target = alternate.target;
						retryReq.model = alternate.model;
						nextRoute = (refused) => {
							const next = eligibleAlternateRoute(
								{ agents, getEffectiveSettings, providers, targetCooldownReason },
								run,
								retryReq,
								undefined,
								notRefused(refused),
							);
							return next === null ? null : { target: next.target, model: next.model };
						};
					} else {
						// No other route can serve the request, so placement picks again.
						// That is usually the failed route itself, which the chain may
						// retry after backoff because the breaker guards new work only.
						delete retryReq.target;
					}
				}
				// A planned route already moved off the failed model; placement would be free to pick it again.
				if (plannedRoute === undefined && decision.excludedRouteParts.includes("model")) delete retryReq.model;
				if (decision.excludedRouteParts.includes("runtime")) delete retryReq.workerRuntime;
			}
			const handle = await dispatchRetryAcrossAlternates(run, retryReq, nextRoute, moveReason);
			// Cancellation can arrive while retry admission is awaiting a handle.
			if (rt.control.canceledControlRoots.has(rt.control.controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId)) {
				rt.contract.contract.abort(handle.runId);
			}
			// The assignment folds every attempt into one stream with a reset marker.
			const marker: AssignmentAttemptStartEvent = {
				type: "attempt_start",
				attempt,
				runId: handle.runId,
				previousRunId: run.runId,
				reason,
			};
			assignments.attachAttempt(asAssignmentId(run.lineage.rootRunId), handle.events, marker);
			context.bus.emit("run.progressed", {
				runId: run.lineage.rootRunId,
				agentId: run.agentId,
				task: run.task,
				...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
				...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
				targetId: run.targetId,
				wireModelId: run.wireModelId,
				runtimeId: run.runtimeId,
				runtimeKind: run.runtimeKind,
				event: marker,
			});
			terminal = handle.finalPromise;
			handle.finalPromise.catch((error) => {
				assignments.reject(asAssignmentId(run.lineage.rootRunId), error);
				reportDispatchDiagnostic(`finalize retry run ${handle.runId}`, error);
			});
		} catch (err) {
			rt.retry.retryReasons.delete(reasonKey);
			rt.retry.retryBackoff.delete(rt.control.controlRootFor(run.runId));
			const message = err instanceof Error ? err.message : String(err);
			const routesRefused = err instanceof RetryRoutesRefusedError;
			const denial = routesRefused ? message : `retry attempt ${attempt} rejected: ${message}`;
			// Keep the denial visible on headless surfaces and assignment state; a
			// terminal owner states it from the run.failed below in its own words.
			writeHeadlessDiagnostic(`[pancode:dispatch] run ${run.runId}: ${denial}\n`);
			// The last completed attempt remains the immutable terminal evidence.
			try {
				const previousReceipt = await run.finalPromise;
				rt.runs.settleAssignmentDurably(asAssignmentId(run.lineage.rootRunId), previousReceipt, "failed", denial);
			} catch (finalizationError) {
				assignments.reject(asAssignmentId(run.lineage.rootRunId), finalizationError);
			}
			context.bus.emit("run.failed", {
				runId: run.runId,
				agentId: run.agentId,
				task: run.task,
				...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
				targetId: run.targetId,
				wireModelId: run.wireModelId,
				runtimeId: run.runtimeId,
				runtimeKind: run.runtimeKind,
				reason: "retry_denied",
				outcome: (routesRefused ? "failed" : "denied_by_policy") satisfies RunOutcome,
				outcomeDetail: denial,
			});
		}
		await terminal;
	}

	/**
	 * Admit a retry, and when admission refuses its route and `nextRoute` names
	 * another, move on to it. Health is often unknown until admission probes a
	 * target, so the first alternate in configured order can be down while a
	 * later one is healthy. Each route is tried once and the retry stays one
	 * attempt. Every refusal is journaled on the assignment and named in the
	 * move's reason.
	 */
	async function dispatchRetryAcrossAlternates(
		run: ActiveRun,
		retryReq: DispatchRequest,
		nextRoute: NextRetryRoute | null,
		moveReason: string,
	): ReturnType<typeof rt.drain.dispatch> {
		const refused: Array<{ target: string; model: string; words: string }> = [];
		for (;;) {
			try {
				return await rt.drain.dispatch(
					retryReq,
					undefined,
					run.hostRun === undefined ? undefined : { hostRun: run.hostRun },
				);
			} catch (error) {
				const target = retryReq.target;
				const model = retryReq.model;
				if (
					nextRoute === null ||
					target === undefined ||
					model === undefined ||
					rt.drain.draining ||
					!rt.retry.retryChainIsLive(run)
				)
					throw error;
				// A route on the failed target is another model, so the words name the model too.
				const words = routeRefusalWords(target === run.targetId ? `${target}/${model}` : target, error);
				refused.push({ target, model, words });
				context.bus.emit("run.progressed", {
					runId: run.lineage.rootRunId,
					agentId: run.agentId,
					task: run.task,
					...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
					...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
					targetId: run.targetId,
					wireModelId: run.wireModelId,
					runtimeId: run.runtimeId,
					runtimeKind: run.runtimeKind,
					event: {
						type: "route_refused",
						targetId: target,
						modelId: model,
						reason: error instanceof Error ? error.message : String(error),
					},
				});
				const next = nextRoute(refused);
				const skipped = refused.map((entry) => entry.words).join("; ");
				if (next === null) throw new RetryRoutesRefusedError(`no other route would take the retry: ${skipped}`);
				retryReq.target = next.target;
				retryReq.model = next.model;
				if (next.agentId !== undefined) retryReq.agentId = next.agentId;
				if (next.node !== undefined) retryReq.node = next.node;
				retryReq.runIdHint = newRunId();
				retryReq.routeMove = {
					fromTargetId: run.targetId,
					fromModelId: run.wireModelId,
					reason: `${moveReason}; ${skipped}, so ${next.target === run.targetId ? `${next.target}/${next.model}` : next.target} took the retry`,
				};
			}
		}
	}

	return {
		approvedRetryCandidates,
		assertRouteWithinApprovedEnvelope,
		executeRetry,
	};
}
