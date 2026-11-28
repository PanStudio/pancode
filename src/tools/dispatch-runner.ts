// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { evaluateSkillToolSurface } from "../core/skill-activation.js";
import { telemetryContext, withToolTelemetryContext } from "../core/telemetry/context.js";
import { ToolNames } from "../core/tool-names.js";
import { turnAllowsTool } from "../core/turn-constraints.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { compileExecutionPlan, requireAgentSteps } from "../domains/dispatch/execution-plan.js";
import { newRunId } from "../domains/dispatch/state.js";
import type { RunPlanProvenance } from "../domains/dispatch/types.js";
import { activeDecisionRefs } from "../domains/session/decision-board.js";
import type { DispatchAdmissionState } from "./dispatch-admission.js";
import { fallbackProgressBus, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import {
	COMPETE_NO_REVIEW_MESSAGE,
	COMPETE_SINGLE_TASK_MESSAGE,
	competeErrorMessage,
	competeResult,
	runApplyWinner,
	runCompete,
} from "./dispatch-compete.js";
import { councilResult, runCouncil } from "./dispatch-council.js";
import {
	backgroundedDispatchResult,
	createBackgroundSwitch,
	DispatchBackgroundedError,
	registerBackgroundControl,
	runDetached,
} from "./dispatch-detach.js";
import { recoverPendingGateEvidence } from "./dispatch-gate-runs.js";
import { PipelineHaltError, runBatch, runPipeline, runSequential, runWriterLimitedBatch } from "./dispatch-modes.js";
import {
	type CompletedRun,
	completeRun,
	dispatchDetails,
	formatDispatchOutput,
	withNotRetried,
} from "./dispatch-output.js";
import { describeDispatchPlan, RESOLVED_DISPATCH_PLAN_ARGUMENT, withResolvedPlanTaskPin } from "./dispatch-plan.js";
import { REVIEW_SINGLE_TASK_MESSAGE, reviewGateResult, runReviewGated } from "./dispatch-review.js";
import { createDispatchRunEventRegistry } from "./dispatch-run-events.js";
import { dependencyPlanAuthorityGranted, runDependencyPlan } from "./dispatch-scout.js";
import type { DispatchToolDeps } from "./dispatch-types.js";
import type { ToolInvokeOptions } from "./registry-contract.js";
import type { ToolResult } from "./tool-spec.js";

export type {
	DispatchBackgroundControl,
	DispatchBackgroundOutcome,
	DispatchBackgroundRegistry,
} from "./dispatch-background.js";

/**
 * Prefix the tool name once. Errors raised inside the dispatch domain already
 * name themselves, and blind prefixing turned those into `dispatch: dispatch:
 * ...`, which spends the first eleven bytes of a short error saying the same
 * thing twice.
 */
function dispatchErrorMessage(err: unknown): string {
	const message = competeErrorMessage(err);
	return message.startsWith("dispatch: ") ? message : `dispatch: ${message}`;
}

export async function runDispatchTool(
	inputDeps: DispatchToolDeps,
	admissionState: DispatchAdmissionState,
	args: Record<string, unknown>,
	options?: ToolInvokeOptions,
): Promise<ToolResult> {
	// Gates retain the host owner without redirecting routing facts out of the active session (#434).
	const runId = options?.hostRun?.runId ?? options?.runId;
	const sessionId = options?.sessionId ?? telemetryContext()?.sessionId;
	const gateTelemetry = withToolTelemetryContext(
		{
			...options,
			...(runId === undefined ? {} : { runId }),
			...(sessionId == null ? {} : { sessionId }),
		},
		telemetryContext,
	);
	const deps: RegisteredDispatchToolDeps = {
		...inputDeps,
		runEvents: inputDeps.runEvents ?? createDispatchRunEventRegistry(),
	};
	const snapshot = admissionState.trustedExecutionSnapshots.get(args);
	if (
		options?.turnConstraints?.allowedTools !== undefined &&
		(snapshot?.kind === "apply-winner" ||
			snapshot?.kind === "land" ||
			(snapshot?.kind === "dispatch" && snapshot.mode === "compete"))
	) {
		return {
			kind: "error",
			message:
				"dispatch: compete/worktree application cannot run under a capability allowlist; use a native single-worker assignment",
		};
	}
	if (snapshot?.kind === "list") {
		const catalog = deps.getAgentCatalog?.().trim() ?? "";
		if (catalog.length === 0) {
			return { kind: "error", message: "dispatch: no agent catalog is available in this context" };
		}
		return { kind: "ok", output: catalog };
	}
	if (snapshot?.kind === "land") {
		// Boot recovery settles a dead run's claim; until then fleet land reads its branch as running.
		await deps.dispatch.awaitStartupRecovery?.();
		if (deps.dispatch.landKeptTask === undefined) {
			return {
				kind: "error",
				message: `dispatch: land is unavailable here; the operator can land it with \`pancode fleet land ${snapshot.ref}\``,
			};
		}
		const landing = await deps.dispatch.landKeptTask({
			ref: snapshot.ref,
			cwd: snapshot.cwd,
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
		});
		const details = {
			mode: "land",
			outcome: landing.outcome,
			...(landing.branch !== undefined ? { branch: landing.branch } : {}),
		};
		return landing.outcome === "refused"
			? { kind: "error", message: `dispatch: land ${snapshot.ref}: ${landing.detail}`, details }
			: { kind: "ok", output: `dispatch land ${landing.branch ?? snapshot.ref}: ${landing.detail}.`, details };
	}
	// Gate evidence and compete recovery below must not race the boot's own recovery of the same groups.
	await deps.dispatch.awaitStartupRecovery?.();
	try {
		await recoverPendingGateEvidence(deps);
	} catch (error) {
		return {
			kind: "error",
			message: `dispatch: pending gate evidence recovery failed closed: ${competeErrorMessage(error)}`,
		};
	}
	if (snapshot?.kind === "apply-winner") {
		const trustedWinnerPlan = admissionState.trustedResolvedPlans.get(args);
		if (trustedWinnerPlan === undefined) {
			return { kind: "error", message: "dispatch: trusted winner-application plan is unavailable" };
		}
		const confirmation = trustedWinnerPlan.confirmation;
		if (confirmation !== undefined) {
			if (
				snapshot.branch !== confirmation.branch ||
				(confirmation.cwd !== undefined && snapshot.cwd !== confirmation.cwd)
			) {
				return { kind: "error", message: "dispatch: winner destination differs from the approved plan" };
			}
		}
		const approval = options?.approval;
		const authority =
			approval?.actionClass === "dispatch"
				? {
						outcome: "operator-confirmed" as const,
						requestId: approval.requestId,
						requestedBy: approval.requestedBy,
					}
				: deps.getAutonomy?.() === "yolo"
					? { outcome: "yolo-applied" as const }
					: null;
		let protectedPaths: string[];
		try {
			protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
		} catch (error) {
			return {
				kind: "error",
				message: `dispatch: protected artifact state is unavailable: ${competeErrorMessage(error)}`,
			};
		}
		const planHash = describeDispatchPlan({
			apply_winner: { branch: snapshot.branch, cwd: snapshot.cwd },
			[RESOLVED_DISPATCH_PLAN_ARGUMENT]: trustedWinnerPlan,
		}).hash;
		return runApplyWinner(
			snapshot,
			planHash,
			authority,
			gateTelemetry,
			deps.competeWorktrees?.mergeWinner,
			protectedPaths,
		);
	}
	if (snapshot?.kind !== "dispatch") {
		return { kind: "error", message: "dispatch: trusted execution admission snapshot is unavailable" };
	}
	const mode = snapshot.mode;
	if (options?.signal?.aborted) return { kind: "error", message: "dispatch: aborted" };
	const maxOutputBytes = snapshot.maxOutputBytes;
	const resultForm = snapshot.resultForm ?? "compact";
	const timeoutMs = snapshot.timeoutMs;
	// All modes, including derived Scout/review runs, share the invocation's
	// admission bounds. Keep these off the serializable approved request.
	const dispatch = deps.dispatch;
	const preparation = {
		...(snapshot.detach ? { detached: true } : {}),
		...(options?.turnConstraints === undefined ? {} : { turnConstraints: structuredClone(options.turnConstraints) }),
		...(options?.hostRun === undefined ? {} : { hostRun: structuredClone(options.hostRun) }),
		// #425: detached admission and its retries belong to the batch, beyond the main turn's signal.
		...(snapshot.detach || options?.signal === undefined ? {} : { signal: options.signal }),
		...(timeoutMs === undefined ? {} : { deadlineAt: Date.now() + timeoutMs }),
	};
	deps.dispatch = {
		...dispatch,
		dispatch: (request, observer) => dispatch.dispatch(request, observer, preparation),
		dispatchBatch: (requests) => dispatch.dispatchBatch(requests, preparation),
	};
	let review = snapshot.review === undefined ? undefined : structuredClone(snapshot.review);
	let council = snapshot.council === undefined ? undefined : structuredClone(snapshot.council);

	// Plan-scale calls are either approved at supervised admission or run
	// unstopped in yolo; every run seals the same plan hash.
	const autonomy = deps.getAutonomy?.() ?? "default";
	const authenticatedApproval = options?.approval?.actionClass === "dispatch" ? options.approval : undefined;
	const trustedResolvedPlan = admissionState.trustedResolvedPlans.get(args) ?? null;
	const planView = snapshot.planView;
	// Production preparation always registers the authoritative snapshot.
	// The parser remains available in dispatch-plan.ts for direct utility
	// tests/tools, but a hidden model-supplied field is never execution trust.
	const resolvedPlan = trustedResolvedPlan;
	const reservationOwnerId = admissionState.trustedReservationOwners.get(args);
	// Stamp this call's own id on every request before the mode branches
	// split them. Derived sub-requests that spread a base request inherit
	// it; the ones built fresh (reviewer, judge) copy it explicitly. A
	// surface that cannot find the parent still renders the run, just not
	// nested, so an absent id is never an error.
	// An operator-typed call files its runs under the operator, for display only.
	const parentToolCallId = options?.toolCallId;
	const stamp: Pick<DispatchRequest, "parentToolCallId" | "rootRequestOrigin"> = {
		...(parentToolCallId !== undefined && parentToolCallId.length > 0 ? { parentToolCallId } : {}),
		...(options?.operatorStarted === true ? { rootRequestOrigin: "user" as const } : {}),
	};
	let requests: ReadonlyArray<DispatchRequest> = snapshot.requests.map((request) => ({
		...structuredClone(request),
		...stamp,
	}));
	// Seal the parent board's active decisions onto every request on the same
	// terms as the parent id: from the live board here, never from model
	// arguments (the validation projection strips the field). Derived reviewer,
	// judge, and synthesis requests copy it from their base explicitly.
	const decisionRefs = activeDecisionRefs(deps.getDecisionBoard?.() ?? []);
	if (decisionRefs.length > 0) requests = requests.map((request) => ({ ...request, decisionRefs }));
	// A plan admission sealed as all read-only on this machine ran without the plan stop (`isReadOnlyPlan`); the
	// judgement is the sealed snapshot's, never the call's arguments, and holds only with the sealed plan present.
	const readOnlyPlan = planView.readOnlyPlan === true && resolvedPlan !== null;
	// An operator-approved, dependency-plan-sealed or read-only-exempt plan fixes the route it shows (failover none), so the
	// parser's route freedom ends here.
	if (authenticatedApproval !== undefined || (resolvedPlan?.source ?? null) !== null || readOnlyPlan)
		requests = requests.map(({ routeFree: _free, ...request }) => request);
	if (planView.planScale && deps.dispatch.preview !== undefined && resolvedPlan === null) {
		return { kind: "error", message: "dispatch: resolved plan is missing after admission" };
	}
	if (planView.planScale && autonomy !== "yolo" && authenticatedApproval === undefined && !readOnlyPlan) {
		return {
			kind: "error",
			message: "dispatch: resolved plan requires a registry-authenticated operator approval",
		};
	}
	if (resolvedPlan !== null) {
		const primaryRole =
			review !== undefined ? "builder" : mode === "compete" ? "candidate" : mode === "council" ? "member" : "task";
		const primaryTasks = resolvedPlan.tasks.filter((task) => task.role === primaryRole);
		const executionTasks = primaryRole === "task" ? primaryTasks : primaryTasks.slice(0, 1);
		if (executionTasks.length !== requests.length) {
			return {
				kind: "error",
				message: `dispatch: resolved plan has ${executionTasks.length} primary task(s), expected ${requests.length}`,
			};
		}
		requests = requests.map((request, index) => {
			const task = executionTasks[index];
			const pinned = withResolvedPlanTaskPin(request, task);
			return reservationOwnerId !== undefined && task?.role !== undefined && task.position !== undefined
				? {
						...pinned,
						reservation: {
							ownerId: reservationOwnerId,
							memberId: task.stepId ?? `${task.role}-${task.position}`,
						},
					}
				: pinned;
		});
		if (review !== undefined) {
			const reviewer = resolvedPlan.tasks.find((task) => task.role === "reviewer");
			if (reviewer === undefined) {
				return { kind: "error", message: "dispatch: resolved review plan has no reviewer task" };
			}
			review = {
				...review,
				reviewer: reviewer.agent,
				target: reviewer.target,
				model: reviewer.model,
				node: reviewer.node,
				resolvedTasks: resolvedPlan.tasks,
			};
		}
		if (council !== undefined) council = { ...council, resolvedTasks: resolvedPlan.tasks };
	}
	if (planView.planScale) {
		const plan: RunPlanProvenance = {
			hash: planView.hash,
			topology: planView.topology,
			taskCount: planView.taskCount,
			approval: authenticatedApproval !== undefined ? "operator" : autonomy === "yolo" ? "yolo" : "read-only",
			source: resolvedPlan?.source == null ? null : { ...resolvedPlan.source },
			...(authenticatedApproval !== undefined
				? {
						approvalRequestId: authenticatedApproval.requestId,
						approvalRequestedBy: authenticatedApproval.requestedBy,
					}
				: {}),
			// The approval was given for another plan hash than the one sealed above (WX3).
			...(authenticatedApproval?.carriedOver !== undefined
				? {
						approvalCarry: {
							approvedPlanHash: authenticatedApproval.carriedOver.approvedPlanHash ?? null,
							rewrittenPlanHash: planView.hash,
							extension: authenticatedApproval.carriedOver.extension,
						},
					}
				: {}),
			...(planView.costCeilingUsd !== undefined ? { costCeilingUsd: planView.costCeilingUsd } : {}),
		};
		requests = requests.map((request) => ({ ...request, plan }));
	}
	const backgroundRefusal =
		resolvedPlan?.topology === "fleet"
			? "a dependency plan drives its stages from this turn"
			: mode === "compete"
				? "compete holds its judge gate in this turn"
				: mode === "council"
					? "council holds its rounds and synthesis in this turn"
					: review !== undefined
						? "a review gate holds its cycle state in this turn"
						: mode === "pipeline" && requests.length > 1
							? "a pipeline threads each step's output through this turn"
							: deps.dispatch.detached === undefined
								? "detached batch records are unavailable in this context"
								: null;
	// Phase D: a worker ask routed to the main agent needs a caller that can
	// yield. The same topologies that cannot move to the background cannot
	// yield, and dispatch refuses main routing for them at admission.
	const grantRouteRefusal =
		backgroundRefusal ??
		(snapshot.writers === 1 && mode === "parallel" && requests.length > 1 && !snapshot.detach
			? "a writer-limited batch admits its writers from this turn"
			: null);
	const mainCanSteer =
		turnAllowsTool(options?.turnConstraints, ToolNames.Steer) &&
		(options?.allowedTools === undefined || options.allowedTools.includes(ToolNames.Steer)) &&
		evaluateSkillToolSurface(options?.pendingSkillPolicy, ToolNames.Steer) === null;
	requests = requests.map(({ mainGrantRoute: _route, ...request }) => ({
		...request,
		// No route makes resolveDispatchPermit apply unavailable-responder deny
		// immediately, rather than parking an ask main has no authority to answer.
		...(mainCanSteer
			? {
					mainGrantRoute:
						grantRouteRefusal === null ? { kind: "yield" as const } : { kind: "refused" as const, reason: grantRouteRefusal },
				}
			: {}),
	}));
	// Refuse a detach the runner cannot honour before any outside-root approval is asked.
	if (snapshot.detach && resolvedPlan?.topology !== "fleet") {
		if (mode !== "parallel") {
			return { kind: "error", message: `dispatch: detach only supports parallel mode; got '${mode}'` };
		}
		if (review !== undefined) {
			return {
				kind: "error",
				message: "dispatch: detach cannot combine with a review gate; run gated dispatch attached",
			};
		}
	}
	const background = createBackgroundSwitch();
	const rejectedExternal: Array<{ position: number; reason: string; message: string }> = [];
	const permitted: DispatchRequest[] = [];
	for (const [index, request] of requests.entries()) {
		const root = request.externalReadRoot;
		if (root === undefined) {
			permitted.push(request);
			continue;
		}
		const approval = await deps.approveExternalRead?.(root, options);
		if (approval == null) {
			rejectedExternal.push({
				position: snapshot.positions?.[index] ?? index + 1,
				reason: "external_read_approval_required",
				message: `external_read_approval_required: Scout root ${root} was not approved for this run; approve it in the TUI or ACP permission request. Headless runs cannot approve external roots.`,
			});
			continue;
		}
		const runId = newRunId();
		permitted.push({ ...request, runIdHint: runId, externalReadApproval: { root, ...approval, runId } });
	}
	requests = permitted;
	const externalFailures = rejectedExternal.map((task) => `task ${task.position} rejected: ${task.message}`).join("\n");
	if (requests.length === 0)
		return { kind: "error", message: externalFailures, details: { rejectedTasks: rejectedExternal } };
	// Review and Scout both execute under mode=parallel, so the operator-facing
	// label names the topology they actually asked for.
	const backgroundLabel = resolvedPlan?.topology === "fleet" ? "fleet" : review !== undefined ? "review" : mode;
	const releaseBackground = registerBackgroundControl(deps, options?.toolCallId, {
		label: `dispatch (${backgroundLabel})`,
		refusal: backgroundRefusal,
		fire: () => background.fire(),
	});
	try {
		if (resolvedPlan?.topology === "fleet") {
			const executionPlan = admissionState.trustedExecutionPlans.get(args);
			if (executionPlan === undefined || resolvedPlan.source === null || reservationOwnerId === undefined) {
				return { kind: "error", message: "dispatch: trusted dependency plan is unavailable" };
			}
			if (executionPlan.hash !== resolvedPlan.source.executionPlanHash) {
				return { kind: "error", message: "dispatch: dependency plan hash drifted after admission" };
			}
			if (!dependencyPlanAuthorityGranted(resolvedPlan, authenticatedApproval !== undefined, autonomy === "yolo")) {
				return { kind: "error", message: "dispatch: dependency plan lacks authenticated authority grants" };
			}
			const executable = compileExecutionPlan({
				topology: executionPlan.topology,
				rootTask: executionPlan.rootTask,
				maxWorkers: executionPlan.maxWorkers,
				...(executionPlan.writers === 1 ? { writers: 1 as const } : {}),
				onFailure: executionPlan.onFailure,
				steps: requireAgentSteps(executionPlan.steps).map((step) => ({
					...step,
					approvedAuthority: step.requestedAuthority,
				})),
			});
			try {
				const outcome = await runDependencyPlan({
					dispatch: deps.dispatch,
					plan: executable,
					artifact: resolvedPlan,
					requests,
					reservationOwnerId,
					...(options?.signal === undefined ? {} : { signal: options.signal }),
					register: (handle, agentId) =>
						deps.runEvents.registerSingle(handle, agentId, fallbackProgressBus(deps)).completion,
					complete: (receipt, summary) => {
						const completed = completeRun(deps, receipt, summary);
						return { value: completed, integrityValid: true };
					},
				});
				const output = formatDispatchOutput(
					"fleet",
					outcome.runs,
					maxOutputBytes,
					null,
					resultForm,
					deps.dispatch.agentTraits?.bind(deps.dispatch),
				);
				const details = {
					...dispatchDetails(deps, "fleet", outcome.runs),
					executionPlanHash: executable.hash,
					skippedSteps: outcome.skipped,
				};
				const failed = outcome.runs.some((run) => run.receipt.exitCode !== 0) || outcome.skipped.length > 0;
				return failed ? { kind: "error", message: output, details } : { kind: "ok", output, details };
			} catch (error) {
				return {
					kind: "error",
					message: `dispatch: dependency plan failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		if (snapshot.detach) {
			try {
				const started = await runDetached(deps, requests, options?.sessionId ?? null);
				if (externalFailures.length === 0 || started.kind !== "ok") return started;
				// An unapproved outside root drops only its own task; the approved ones run detached.
				return {
					kind: "error",
					message: `${externalFailures}\n\n${started.output}`,
					details: { ...started.details, rejectedTasks: rejectedExternal },
				};
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		if (mode === "compete") {
			if (requests.length !== 1 || requests[0] === undefined) {
				return { kind: "error", message: COMPETE_SINGLE_TASK_MESSAGE };
			}
			if (review !== undefined) {
				return { kind: "error", message: COMPETE_NO_REVIEW_MESSAGE };
			}
			if (snapshot.compete === undefined) {
				return { kind: "error", message: "dispatch: trusted compete settings are unavailable" };
			}
			let compete = structuredClone(snapshot.compete);
			if (resolvedPlan !== null) {
				const judge = resolvedPlan.tasks.find((task) => task.role === "judge");
				if (judge === undefined) {
					return { kind: "error", message: "dispatch: resolved compete plan has no judge task" };
				}
				compete = {
					...compete,
					judge: { agent: judge.agent, target: judge.target, model: judge.model, node: judge.node },
					resolvedTasks: resolvedPlan.tasks,
				};
			}
			try {
				const outcome = await runCompete(deps, requests[0], compete, autonomy, timeoutMs, options?.signal, gateTelemetry);
				return competeResult(deps, outcome, autonomy, maxOutputBytes, resultForm);
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		if (mode === "council") {
			if (requests.length !== 1 || requests[0] === undefined || council === undefined) {
				return { kind: "error", message: "dispatch: trusted council settings are unavailable" };
			}
			try {
				// A clip belongs to the journal of the call that convened the council: the session's (or a worker's own
				// run), open now. The gate's host run journal opens only at its seal, so a clip there was dropped unowned.
				const clipTelemetry = withToolTelemetryContext(
					{ ...options, ...(sessionId == null ? {} : { sessionId }) },
					telemetryContext,
				);
				return councilResult(deps, await runCouncil(deps, requests[0], council, timeoutMs, options?.signal, clipTelemetry));
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		if (review !== undefined) {
			if (requests.length !== 1 || requests[0] === undefined) {
				return { kind: "error", message: REVIEW_SINGLE_TASK_MESSAGE };
			}
			if (mode !== "parallel") {
				return { kind: "error", message: `dispatch: review does not combine with mode=${mode}` };
			}
			try {
				const outcome = await runReviewGated(deps, requests[0], review, timeoutMs, options?.signal, gateTelemetry);
				return await reviewGateResult(deps, outcome, maxOutputBytes, resultForm);
			} catch (err) {
				return { kind: "error", message: dispatchErrorMessage(err) };
			}
		}

		try {
			let runs: CompletedRun[];
			// Only the concurrent fan-out has peers, so only it has a board.
			let board: string | null = null;
			if (mode === "pipeline" && requests.length > 1) {
				runs = await runPipeline(deps, requests, timeoutMs, options?.signal);
			} else if (mode === "sequential" || mode === "pipeline" || requests.length === 1) {
				// A single-task pipeline has nothing to thread, so it degrades to
				// plain sequential and no pipeline-input message is sent.
				runs = await runSequential(deps, requests, mode, timeoutMs, options?.signal, background);
			} else {
				const batch =
					snapshot.writers === 1
						? await runWriterLimitedBatch(deps, requests, timeoutMs, options?.signal)
						: await runBatch(deps, requests, timeoutMs, options?.signal, background);
				runs = batch.runs;
				board = batch.board;
			}
			runs = await withNotRetried(deps, runs);
			const output = [
				externalFailures,
				formatDispatchOutput(mode, runs, maxOutputBytes, board, resultForm, deps.dispatch.agentTraits?.bind(deps.dispatch)),
			]
				.filter(Boolean)
				.join("\n\n");
			const details = {
				...dispatchDetails(deps, mode, runs, board),
				...(rejectedExternal.length > 0 ? { rejectedTasks: rejectedExternal } : {}),
			};
			const failed = runs.filter((run) => run.receipt.exitCode !== 0);
			if (failed.length > 0 || rejectedExternal.length > 0) return { kind: "error", message: output, details };
			return { kind: "ok", output, details };
		} catch (err) {
			if (err instanceof DispatchBackgroundedError) {
				return await backgroundedDispatchResult(deps, err, mode, options?.sessionId ?? null);
			}
			if (err instanceof PipelineHaltError) {
				const haltMessage = `dispatch: ${err.message}`;
				const haltRuns = await withNotRetried(deps, err.runs);
				const output = formatDispatchOutput(
					"pipeline",
					haltRuns,
					maxOutputBytes,
					null,
					resultForm,
					deps.dispatch.agentTraits?.bind(deps.dispatch),
				);
				return {
					kind: "error",
					message: `${haltMessage}\n\n${output}`,
					details: dispatchDetails(deps, "pipeline", haltRuns),
				};
			}
			return { kind: "error", message: dispatchErrorMessage(err) };
		}
	} finally {
		releaseBackground();
	}
}
