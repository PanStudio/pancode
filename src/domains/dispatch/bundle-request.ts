// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { relative, resolve as resolvePath } from "node:path";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { asDirectoryPathBoundary } from "../../core/path-boundary.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { snapshotTurnConstraints } from "../../core/turn-constraints.js";
import { cleanupAccountedTaskWorktree, createTaskWorktree, gitCheckoutRoot } from "../../tools/task-worktree.js";
import { keptTaskWorktreeDetail } from "../../tools/task-worktree-preview.js";
import { diskWorktreeParent, prepareWorktreeParent, resolveWorktreeRoot } from "../../tools/worktree-root.js";
import { normalizeAgentSpec } from "../agents/spec.js";
import { withStoreGrantBoundaries } from "./admission-scope.js";
import { registerAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ProbeClaim } from "./bundle-types.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { placedInWorktree } from "./envelope.js";
import { writeModeInput } from "./envelope-stage.js";
import { agentRoleFactsResolver, requestRunRole } from "./execution-role.js";
import type { BatchVerificationGate } from "./host-verification.js";
import { requestedWriteNone } from "./obligation.js";
import { resolveDispatchPathScope } from "./path-scope.js";
import { releaseDispatchReservationMemberAsync, rollbackDispatchReservation } from "./reservation-store.js";
import { resolveRunWall, runWallCapMs } from "./run-limits.js";
import { newRunId } from "./state.js";
import { readWorkerTargets, resolveDispatchTarget } from "./target-resolution.js";
import type { RunResult } from "./types.js";
import { canonicalWriteRoots, joinWriterSet, type WriterSetLease } from "./writer-set.js";

export function createDispatchRequests(rt: DispatchRuntime) {
	const { options } = rt;
	const { agents, assignments, getEffectiveSettings, now, previewNode, providers, targetBreaker } = rt.core;

	/**
	 * Ruling 3 (M7): a builder whose write roots its placement cannot confine runs in its own task worktree, keeps
	 * bash and verify, and merges back only its roots. Decided from the facts the envelope reads; a request that
	 * cannot be resolved here is left as it is for admission to refuse with its own reason.
	 */
	function placedInOwnWorktree(req: DispatchRequest): boolean {
		if (req.worktree === true || req.taskWorktree !== undefined || req.gate !== undefined) return false;
		try {
			const recipe = agents.get(req.agentId);
			if (!recipe) return false;
			const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => previewNode(req).node);
			if (pathScope.writeBoundaries.length === 0) return false;
			const settings = getEffectiveSettings();
			const targets = readWorkerTargets(settings);
			const target = resolveDispatchTarget(
				req,
				recipe,
				targets.workerDefault,
				targets.workerProfiles,
				targets.agentBindings,
				targets.targetOrder,
				providers,
			);
			return placedInWorktree(
				writeModeInput({
					req,
					recipe,
					spec: normalizeAgentSpec(recipe),
					pathScope,
					target,
					settings,
					placement: previewNode(req),
				}),
			);
		} catch {
			return false;
		}
	}

	async function dispatchAttempt(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): ReturnType<typeof rt.attempt.admitDispatchAttempt> {
		const probeClaims: ProbeClaim[] = [];
		try {
			return await rt.attempt.admitDispatchAttempt(req, probeClaims, observer, preparation, settlement);
		} catch (error) {
			// A half-open route admitted this dispatch as its probe, but the run never
			// started. Without the release the route would wait on a probe outcome
			// that cannot arrive.
			for (const claim of probeClaims) targetBreaker.release(claim.key, claim.owner);
			throw error;
		}
	}

	async function dispatchRequest(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}> {
		// Restart recovery settles before any run is admitted, so no stale
		// worktree or abandoned lease is reused (boot-recovery.ts).
		await rt.recovery.awaitStartupRecovery();
		// A retry re-enters here with the request it was first admitted under, so
		// only a request that has never been stamped takes the current session.
		const sessionOrigin = options?.getSessionOrigin?.();
		if (req.ownerSessionId === undefined)
			req = { ...req, ownerSessionId: sessionOrigin?.id ?? options?.getSessionId?.() ?? null };
		if (req.ownerSessionCwdHash === undefined && sessionOrigin && sessionOrigin.id === req.ownerSessionId)
			req = { ...req, ownerSessionCwdHash: sessionOrigin.cwdHash };
		const constraints = snapshotTurnConstraints(preparation?.turnConstraints ?? req.turnConstraints);
		if (constraints) {
			req = {
				...req,
				turnConstraints: constraints,
				...(constraints.skills === "disabled" ? { noSkills: true } : {}),
				// A worker of a read-only run is read-only too, whatever its recipe.
				...(constraints.readOnly === true ? { readOnly: true } : {}),
			};
			// A task worktree is a checkout and a .git/worktrees entry in the
			// repository, and a host verification check runs a project command
			// unconfined; neither leaves the user's files alone.
			if (constraints.readOnly === true && req.worktree === true && req.taskWorktree === undefined)
				throw new Error(
					"dispatch: this run is read-only, so it cannot create a task worktree; dispatch without worktree: true",
				);
			if (constraints.readOnly === true && (req.resolvedVerification?.length ?? 0) > 0)
				throw new Error(
					"dispatch: this run is read-only, so it cannot run host verification checks; dispatch without intent.verification",
				);
			// Validate before creating worktrees or acquiring writer/capacity leases.
			rt.preview.previewFixed(req);
		}
		// The role is resolved from the request as admitted, a turn's read-only narrowing included, by the rule the
		// envelope applies, so the journal, the route tuple and the receipt carry the envelope's role (DESIGN 4.2). A
		// request that already names the recovery population (a fleet repair step) keeps it.
		if (req.executionRole !== "recovery")
			req = {
				...req,
				executionRole: requestRunRole(
					req,
					agentRoleFactsResolver((id) => agents.getSpec(id)),
				),
			};
		// Every attempt takes its own run identity before the writer lease; retries
		// join the original writer group through lineage.rootRunId (#434).
		if (placedInOwnWorktree(req)) req = { ...req, worktree: true };
		if (req.runIdHint === undefined && req.worktree !== true) req = { ...req, runIdHint: newRunId() };
		// DESIGN 4.5: every run has a wall clock from this call, so time queued for a slot counts; a retry keeps its root's.
		const wallRecipe = agents.get(req.agentId);
		const recipeWallMs = wallRecipe === null ? undefined : normalizeAgentSpec(wallRecipe).budget?.timeoutMs;
		const wallClock = resolveRunWall({
			capMs: runWallCapMs((getEffectiveSettings() ?? DEFAULT_SETTINGS).fleet.limits, req.requestOrigin),
			...(recipeWallMs !== undefined ? { recipeMs: recipeWallMs } : {}),
			startedAt: now(),
			deadlineAt: Math.min(
				req.assignmentDeadlineAt ?? Number.POSITIVE_INFINITY,
				preparation?.deadlineAt ?? Number.POSITIVE_INFINITY,
			),
		});
		let prepared: DispatchRequest = {
			...req,
			assignmentDeadlineAt: wallClock.deadlineAt,
			runWallMs: req.runWallMs ?? wallClock.wallMs,
		};
		let createdWorktree: DispatchRequest["taskWorktree"];
		let writerLease: WriterSetLease | undefined;
		const writerRecipe = agents.get(req.agentId);
		if (writerRecipe !== null && normalizeAgentSpec(writerRecipe).capabilityClass === "workspace-edit") {
			const checkout = req.taskWorktree?.root ?? gitCheckoutRoot(req.cwd ?? process.cwd());
			if (checkout !== null) {
				const roots = canonicalWriteRoots(req);
				const runId = req.runIdHint ?? req.lineage?.rootRunId;
				try {
					// A writer that would overlap a live set queues behind it until its run's deadline (DESIGN 4.5).
					writerLease = await joinWriterSet({
						checkout,
						deadlineAt: wallClock.deadlineAt,
						...(preparation?.signal !== undefined ? { signal: preparation.signal } : {}),
						onQueued: (waitingOn) =>
							reportDispatchDiagnostic(
								`writer set for ${req.agentId}`,
								new Error(`queued behind ${waitingOn}; it starts when that settles`),
							),
						// A read-only run writes nothing, so it carries no holder: the envelope's one definition of read-only.
						...(requestedWriteNone({
							readOnly: req.readOnly,
							capabilityClass: agents.listSpecs().find((spec) => spec.id === req.agentId)?.capabilityClass ?? null,
							hoareContract: false,
						})
							? {}
							: {
									member: {
										// One dispatch call's requests, and their retries, share a group.
										group: req.parentToolCallId ?? req.lineage?.rootRunId ?? req.runIdHint ?? newRunId(),
										roots: roots.length > 0 ? roots : null,
										isolated: req.worktree === true || req.taskWorktree !== undefined,
										agentId: req.agentId,
										...(runId !== undefined ? { runId } : {}),
									},
								}),
					});
				} catch (error) {
					// A refused writer never reaches the attempt below, whose failure
					// path returns the plan's reservation, so return it here.
					if (req.reservation !== undefined && req.lineage === undefined) {
						rollbackDispatchReservation(req.reservation.ownerId, now());
					}
					throw error;
				}
			}
		}
		if (req.worktree === true && req.taskWorktree === undefined) {
			const requestedCwd = resolvePath(req.cwd ?? process.cwd());
			const root = gitCheckoutRoot(requestedCwd);
			if (root === null) throw new Error("worktree_non_git_checkout");
			if (req.taskWorktreeDestination !== undefined && root !== req.taskWorktreeDestination) {
				writerLease?.release();
				throw new Error("dispatch: worktree merge destination differs from the approved execution snapshot");
			}
			// Admission sealed each check's cwd in the source checkout, before any
			// worktree existed. Verifying there judges the operator's tree, not the
			// candidate the worker produced (F6), so each check moves with the
			// worker. Sealed reference and baseline files stay where admission read them.
			const verificationRelatives = (req.resolvedVerification ?? []).map((check) => {
				const rel = relative(root, resolvePath(root, check.cwd));
				if (relativePathEscapes(rel)) {
					writerLease?.release();
					throw new Error(`dispatch: host verification check '${check.check}' runs outside the task worktree's checkout`);
				}
				return rel;
			});
			const runId = newRunId();
			let taskWorktree: NonNullable<DispatchRequest["taskWorktree"]>;
			try {
				// fleet.worktrees.root moves the working tree for local placement
				// only: with fleet nodes the run may land on another host, which
				// reaches the worktree by the project-root path alone.
				const fleetSettings = getEffectiveSettings()?.fleet;
				let worktreeRoot = resolveWorktreeRoot({
					setting: fleetSettings?.worktrees?.root ?? "disk",
					projectRoot: root,
					remoteEligible: (fleetSettings?.nodes?.length ?? 0) > 0,
				});
				const untrusted = prepareWorktreeParent(worktreeRoot);
				if (untrusted !== null) {
					worktreeRoot = {
						parent: diskWorktreeParent(root),
						kind: "disk",
						notice: `${untrusted}; using the project root`,
					};
				}
				if (worktreeRoot.notice !== undefined) {
					reportDispatchDiagnostic(`task worktree root for ${runId}`, new Error(worktreeRoot.notice));
				}
				taskWorktree = createTaskWorktree(root, runId, undefined, req.apply ?? "merge", worktreeRoot.parent);
			} catch (error) {
				writerLease?.release();
				throw error;
			}
			createdWorktree = taskWorktree;
			const cwdRelative = relative(root, requestedCwd);
			const workerCwd = resolvePath(taskWorktree.path, cwdRelative);
			const writeRoots = req.writeRoots?.map((entry) => {
				const rel = relative(root, entry);
				if (relativePathEscapes(rel)) return entry;
				// resolvePath drops the trailing slash that marks a directory root (D2).
				const remapped = resolvePath(taskWorktree.path, rel);
				return entry.endsWith("/") ? asDirectoryPathBoundary(remapped) : remapped;
			});
			const resolvedVerification = req.resolvedVerification?.map((check, index) => ({
				...check,
				argv: [...check.argv],
				cwd: resolvePath(taskWorktree.path, verificationRelatives[index] ?? "."),
			}));
			prepared = {
				...prepared,
				runIdHint: runId,
				taskWorktree,
				cwd: workerCwd,
				protectedArtifactRemap: { sourceRoot: root, workerRoot: taskWorktree.path },
				...(writeRoots === undefined ? {} : { writeRoots }),
				...(resolvedVerification === undefined ? {} : { resolvedVerification }),
			};
		}
		let handle: Awaited<ReturnType<typeof dispatchAttempt>>;
		try {
			preparation?.signal?.throwIfAborted();
			handle = await dispatchAttempt(prepared, observer, preparation, settlement);
			writerLease?.bindRun(handle.runId);
		} catch (error) {
			writerLease?.release();
			if (createdWorktree !== undefined) {
				try {
					// No commit accounted for anything: a fresh worktree holds its base and no untracked file.
					const kept = cleanupAccountedTaskWorktree(createdWorktree, { commit: createdWorktree.base, untracked: new Map() });
					if (kept !== null) {
						reportDispatchDiagnostic(
							`keep task worktree ${createdWorktree.runId} after admission failure`,
							new Error(keptTaskWorktreeDetail(createdWorktree, createdWorktree.base, kept)),
						);
					}
				} catch (cleanupError) {
					reportDispatchDiagnostic(`clean task worktree ${createdWorktree.runId} after admission failure`, cleanupError);
				}
			}
			if (req.reservation !== undefined && req.lineage === undefined) {
				rollbackDispatchReservation(req.reservation.ownerId, now());
			}
			throw error;
		}
		// A finalization that throws before the barrier, and an ACP handle that
		// never reaches it at all, must not park their siblings forever. A member
		// that already arrived is parked and abandon() is a no-op for it, so this
		// fires harmlessly on the normal path.
		if (settlement !== undefined) {
			const release = (): void => settlement.abandon(handle.runId);
			handle.finalPromise.then(release, release);
		}
		// Requests carrying lineage are internal attempts (retry or nested
		// orchestration) and retain the per-attempt handle contract.
		if (req.lineage) {
			const finalPromise = handle.finalPromise.finally(() => writerLease?.release());
			rt.control.trackMemberWork(handle.runId, finalPromise);
			return { ...handle, finalPromise };
		}

		const assignment = assignments.open(handle.runId, rt.retry.assignmentPolicyFor(handle.effectiveRequest));
		rt.runs.persistAssignment(registerAssignment(assignment.id), `${assignment.id}:open`);
		// Attach before any await so a fast-finishing attempt cannot settle the
		// assignment (and close its stream) before attempt 1's frames are folded.
		assignments.attachAttempt(assignment.id, handle.events);
		// A finalization failure has no immutable receipt to settle with; preserve
		// the attempt error rather than leaving the assignment pending forever.
		handle.finalPromise.catch((error) => assignments.reject(assignment.id, error));
		const reservation = req.reservation;
		const terminal =
			reservation === undefined
				? assignment.terminal.finally(() => writerLease?.release())
				: assignment.terminal.finally(async () => {
						try {
							// Tracked so drain and stop wait for the shared capacity record. A
							// failed release is reported, never turned into a failed run whose
							// receipt already sealed its outcome (#428).
							await rt.runs.trackDurableWrite(
								releaseDispatchReservationMemberAsync(reservation.ownerId, reservation.memberId, now()),
							);
						} catch (error) {
							reportDispatchDiagnostic(`release reservation member ${reservation.memberId}`, error);
						} finally {
							writerLease?.release();
						}
					});
		return { runId: handle.runId, events: assignment.events, finalPromise: terminal };
	}

	return {
		dispatchRequest,
	};
}
