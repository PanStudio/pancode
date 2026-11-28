// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type {
	AgentLedgerBody,
	WorkerGrantRequestFrame,
	WorkerHookEffect,
	WorkerHookRequest,
	WorkerModelLoad,
} from "../../lib/worker-wire/protocol.js";
import { restoreTaskWorktreeOverlay } from "../../tools/task-worktree-overlay.js";
import { recordAgentLedgerDispute } from "../claims/index.js";
import { resolveClaudeLaunchCredential } from "../providers/auth/index.js";
import { type FlowRestrictionSet, mergeFlowRestrictions } from "../safety/information-flow.js";
import { publishAgentLedgerEntry } from "./agent-ledger-hub.js";
import {
	type AgentLedgerAttribution,
	appendAgentLedgerEntry,
	MAX_AGENT_LEDGER_POSTS_PER_RUN,
	readAgentLedger,
} from "./agent-ledger-store.js";
import type { AdmittedAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { GRANT_DEADLINE_MARGIN_MS, operatorContainedYolo } from "./bundle-support.js";
import { type CheckoutSnapshot, takeCheckoutBaseline } from "./checkout-changes.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { envelopeForPermit } from "./envelope.js";
import { operatorAdmissionAutonomy } from "./envelope-stage.js";
import { decideJudgedGrant } from "./grant-decision.js";
import { createRunCallUsage } from "./run-call-usage.js";
import { assertMainGrantRoutable } from "./runtime-enforceability.js";
import { workerApprovalCeilingMs } from "./worker-approval-window.js";
import { adoptWorkerModelLoad } from "./worker-model-loads.js";
import type { WorkerSpec } from "./worker-spawn.js";
import { buildDispatchWorkerSpec, hookExtensionIds } from "./worker-spec.js";

export async function prepareAttemptWorker(rt: DispatchRuntime, attempt: AdmittedAttempt) {
	const { config, firstNotice, middleware, now, safety } = rt.core;
	const { options } = rt;
	let buildSpec: () => WorkerSpec;
	const {
		grantAttempt,
		judgeReachable,
		judgeRouted,
		launch,
		lifecycle,
		placed,
		placement,
		preparation,
		protectedArtifactState,
		req,
		sharedStoreGrant,
	} = attempt;

	try {
		if (!judgeRouted) assertMainGrantRoutable(req, lifecycle.target.runtime, lifecycle.permit, placement?.node ?? null);
		if (grantAttempt !== undefined && placement?.spawn !== undefined && !judgeRouted) {
			throw new Error(
				"dispatch: fleet.permissions.mode=main routes worker asks to the main agent, but this placement launches through a remote transport, which cannot carry a bound grant yet; use fleet.permissions.mode escalate or deny for this work",
			);
		}
		const unhooked = rt.preview.assertWorkerHooksCarried(lifecycle.target.runtime, lifecycle.admission.allowedTools);
		if (unhooked.length > 0) {
			const notice = `extension tool hooks of ${hookExtensionIds(unhooked)} do not run for ${lifecycle.target.runtime.id} workers; their tool calls are unhooked`;
			if (firstNotice(`unhooked\0${notice}`)) options?.workerHooks?.notify?.(notice);
		}
		// Capacity admission may have waited. Resolve the subscription again at
		// launch so a CLI peer never starts with the queued snapshot's old token.
		const claudeLaunch = lifecycle.target.runtime.auth === "claude-cli";
		const launchCredential = claudeLaunch
			? await resolveClaudeLaunchCredential(
					lifecycle.target.target.auth,
					process.env,
					preparation?.signal ? { signal: preparation.signal } : {},
				)
			: null;
		if (claudeLaunch && lifecycle.authProfile && !launchCredential) {
			throw new Error(
				"PanCode's Claude credential changed while this assignment was queued. Submit a new assignment with the intended account.",
			);
		}
		const launchAuthProfile = claudeLaunch
			? launchCredential && !launchCredential.profile.startsWith("env:")
				? launchCredential.profile
				: undefined
			: lifecycle.authProfile;
		buildSpec = () =>
			buildDispatchWorkerSpec(
				{
					req,
					...(sharedStoreGrant !== null ? { sharedStoreGrant } : {}),
					role: lifecycle.runRole,
					pathScope: lifecycle.pathScope,
					target: lifecycle.target,
					admission: lifecycle.admission,
					recipe: lifecycle.recipe,
					systemPrompt: lifecycle.systemPrompt,
					dynamicPromptMessages: lifecycle.dynamicPromptMessages,
					promptSignature: lifecycle.promptSignature,
					toolSignature: lifecycle.toolSignature,
					dynamicHash: lifecycle.dynamicHash,
					middlewareSnapshot: middleware.snapshot(),
					protectedArtifactState,
					flowRestrictions: options?.getFlowRestrictions?.() ?? null,
					...(options?.getFlowPolicy !== undefined ? { flowPolicy: options.getFlowPolicy() } : {}),
					apiKey: claudeLaunch ? launchCredential?.apiKey : lifecycle.apiKey,
					localPlacement: placement === null || placement.node.kind === "local",
					...((placement === null || placement.node.kind === "local") && launchAuthProfile
						? { authProfile: launchAuthProfile }
						: {}),
					...(launchCredential?.expiresAt !== undefined ? { credentialExpiresAt: launchCredential.expiresAt } : {}),
					envelope: envelopeForPermit(lifecycle.envelope, lifecycle.permit),
					...(lifecycle.projectContext?.peerInstructions?.delivery === "single-source"
						? { skipRepositoryInstructions: true }
						: {}),
					budget: lifecycle.budget,
					...(lifecycle.settings ? { settings: lifecycle.settings } : {}),
					workerPermissionResponder:
						options?.workerPermissionResponder === true && !operatorContainedYolo(attempt.specAutonomySettings),
					permit: lifecycle.permit,
					...(grantAttempt !== undefined ? { grantAttempt } : {}),
					...(judgeRouted ? { judgeResponder: judgeReachable } : {}),
					mainAutonomy: operatorAdmissionAutonomy(attempt.specAutonomySettings),
					...(options?.workerHooks ? { extensionHooks: options.workerHooks.declarations() } : {}),
				},
				config ?? undefined,
			);
		attempt.spec = buildSpec();
	} catch (error) {
		await launch.fail(error);
		throw error;
	}
	// The agent ledger is orchestrator-owned. The worker sends a body and
	// nothing else; every attribution field below is stamped from this
	// process's own admission record, so no worker-supplied value can reach
	// one. Attribution exists only once the run has an envelope, and the
	// worker is already live before that, so a post that lands in the gap is
	// held in order and appended the moment attribution exists. The hold is
	// bounded by the per-run cap, which is what the append would refuse past
	// anyway.
	const agentLedgerId = attempt.spec.ledger?.id ?? null;
	attempt.agentLedgerAttribution = null;
	attempt.unsubscribeAgentLedger = null;
	const heldLedgerPosts: Array<{ body: AgentLedgerBody; flowRestrictions?: FlowRestrictionSet }> = [];
	const appendLedgerPost = (
		attribution: AgentLedgerAttribution,
		body: AgentLedgerBody,
		flowRestrictions?: FlowRestrictionSet,
	): void => {
		if (agentLedgerId === null) return;
		const carried = mergeFlowRestrictions(attempt.spec.flowRestrictions, flowRestrictions);
		attempt.trustedFlow = mergeFlowRestrictions(attempt.trustedFlow, carried);
		void appendAgentLedgerEntry(
			agentLedgerId,
			{ ...attribution, ...(carried ? { flowRestrictions: carried } : {}) },
			body,
		)
			.then(async (result) => {
				if (!result.ok) return;
				publishAgentLedgerEntry(agentLedgerId, result.entry);
				// A failing review outlives this dispatch as a dispute in the project's claims log (#406); the ledger
				// itself is a ring of recent dispatches no later session reads.
				if (result.entry.body.kind === "review" && !result.entry.body.passed)
					await recordAgentLedgerDispute({
						ledgerId: agentLedgerId,
						review: result.entry,
						entries: readAgentLedger(agentLedgerId)?.entries ?? [],
						projectCwd: lifecycle.cwd,
					});
			})
			.catch((error) => reportDispatchDiagnostic(`append agent ledger entry for ${attribution.runId}`, error));
	};
	const onLedgerPost = (body: AgentLedgerBody, flowRestrictions?: FlowRestrictionSet): void => {
		if (agentLedgerId === null) return;
		const attribution = attempt.agentLedgerAttribution;
		if (attribution === null) {
			if (heldLedgerPosts.length < MAX_AGENT_LEDGER_POSTS_PER_RUN)
				heldLedgerPosts.push({ body, ...(flowRestrictions ? { flowRestrictions } : {}) });
			return;
		}
		appendLedgerPost(attribution, body, flowRestrictions);
	};
	// A model this worker loaded is this process's to release at exit, and
	// stays out of mid-session eviction until then (#379). The report is
	// checked against the admitted route, and the endpoint comes from this
	// process's own target, so a worker can neither redirect the release nor
	// claim a model it was not dispatched to.
	const onModelLoaded = (load: WorkerModelLoad): void => {
		adoptWorkerModelLoad(load, {
			target: lifecycle.target.target,
			runtime: lifecycle.target.runtime,
			wireModelId: lifecycle.target.wireModelId,
			node: placed,
		});
	};
	// A worker ask routed to the main agent enters the broker here, from the
	// control lane, bound to this attempt. A request the broker refuses is
	// denied at once rather than left to wait out its timeout.
	const onGrantRequest = (request: WorkerGrantRequestFrame): void => {
		if (grantAttempt === undefined) return;
		if (request.attemptToken !== grantAttempt.attemptToken || request.attempt !== grantAttempt.attempt) {
			reportDispatchDiagnostic(
				`run ${attempt.runIdForPermissionAudit ?? "pending"}`,
				new Error("dropped a grant request that names another attempt"),
			);
			return;
		}
		const denyAtOnce = (reason: string): void => {
			attempt.sendToWorker?.({
				type: "permission_decision",
				requestId: request.requestId,
				decision: "deny",
				binding: { ...grantAttempt, argDigest: request.argDigest, issuer: "operator", reason },
			});
		};
		const runId = attempt.runIdForPermissionAudit;
		if (runId === null) {
			denyAtOnce("the run was not registered yet");
			return;
		}
		const opened = rt.grants.grantBroker.open({
			workerRequestId: request.requestId,
			runId,
			rootRunId: attempt.lineage.rootRunId,
			attempt: request.attempt,
			attemptToken: grantAttempt.attemptToken,
			ownerSessionId: req.ownerSessionId ?? null,
			agentId: req.agentId,
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
			tool: request.tool,
			actionClass: request.actionClass,
			approvalAuthority: request.authority,
			argDigest: request.argDigest,
			effect: request.effect,
			cwd: lifecycle.cwd,
			permitTools: lifecycle.permit.ceiling.tools,
			summary: request.summary,
			...(request.target !== undefined ? { target: request.target } : {}),
			...(request.consequence !== undefined ? { consequence: [...request.consequence] } : {}),
			reasons: request.reasons,
			// A window this process runs ends the request and a hold can reach the
			// ceiling. Otherwise the broker expires a little before the worker's own
			// timer, so the denial it sends is the one that settles the request.
			...(attempt.spec.escalation?.backstopMs !== undefined
				? { deadlineAt: now() + workerApprovalCeilingMs(request.timeoutMs), windowMs: request.timeoutMs }
				: { deadlineAt: now() + Math.max(1_000, request.timeoutMs - GRANT_DEADLINE_MARGIN_MS) }),
			...(judgeReachable && request.authority === "main" ? { reviewer: "safety-judge" as const } : {}),
			...(request.mcpTool !== undefined ? { mcpTool: request.mcpTool } : {}),
		});
		if (!opened.ok) {
			denyAtOnce(opened.reason);
			return;
		}
		if (opened.record.reviewer === "safety-judge")
			void decideJudgedGrant(
				{ grantAttended: rt.grants.grantAttended, grantBroker: rt.grants.grantBroker, options, safety },
				opened.record,
				req.turnConstraints,
			);
	};
	// A worker's call waits on its answer, so every request is answered, with
	// the hook's own failure policy when it cannot run.

	const workerHooks = options?.workerHooks;
	const onHookRequest = (request: WorkerHookRequest): void => {
		if (workerHooks === undefined) return;
		void workerHooks
			.evaluate(request, {
				runId: attempt.runIdForPermissionAudit,
				sessionId: req.ownerSessionId ?? null,
				// A task worktree stands for the checkout it was cut from; any other worker for its dispatch cwd.
				sourceRoot: req.taskWorktree?.root ?? lifecycle.cwd,
			})
			// evaluate never rejects by contract; if it does, the call still gets an
			// answer by the stricter of the dispatched hook's policies, as the
			// worker would decide a lost one, only without waiting out its deadline.
			.catch((error: unknown): ReadonlyArray<WorkerHookEffect> => {
				const hook = attempt.spec.extensionHooks?.find((entry) => entry.id === request.hookId);
				if (hook !== undefined && hook.onError !== "block" && hook.onTimeout !== "block") return [];
				const reason = `${request.hookId} could not be evaluated (${error instanceof Error ? error.message : String(error)})`;
				return request.point === "before_tool"
					? [{ kind: "block_tool", reason: `${reason}; the gate fails closed` }]
					: [
							{
								kind: "annotate_tool_result",
								message: `${reason}; the tool already ran, so its result carries this warning`,
								severity: "warn",
							},
						];
			})
			.then((effects) => attempt.answerHook?.({ type: "hook_result", requestId: request.requestId, effects }))
			.catch(() => {
				// send reports its own failures as a channel failure; the worker then decides the call by its policy.
			});
	};
	// Every run in the current checkout keeps its measured delta on the receipt, so a tool runtime's worker whose
	// write record is incomplete still counts its edits there and in the exit summary (bt-11). The test-removal
	// check and slate acceptance below keep reading it for a subprocess runtime only.
	// Taken off the event loop and awaited before the worker spawns; runs spawned against this cwd meanwhile share it.
	const checkoutBaselineTaken = req.taskWorktree === undefined ? takeCheckoutBaseline(lifecycle.cwd) : null;
	const checkoutBaseline: CheckoutSnapshot | null = null;

	// A held follower's worker starts after its run row exists; this moves the row onto the real process.
	const heldFollower = false;
	attempt.onFollowerStarted = null;
	// Kept so a follower released before its run row exists still gets that row's start bookkeeping.
	attempt.followerWorker = null;
	// A held follower joins its batch's board once its worker can take deliveries.
	const subscribeHeldBoard: (() => void) | null = null;
	attempt.peerOverlay = null;
	const restorePeerOverlay = (): void => {
		if (attempt.peerOverlay === null) return;
		try {
			const discarded = restoreTaskWorktreeOverlay(attempt.peerOverlay);
			const context = lifecycle.projectContext;
			if (discarded.length > 0 && context?.peerInstructions !== undefined) {
				lifecycle.projectContext = { ...context, peerInstructions: { ...context.peerInstructions, discarded } };
			}
		} catch (error) {
			// The skip-worktree mark stays on what was not put back, so the landing still leaves it out.
			reportDispatchDiagnostic(`restore peer instructions in task worktree ${req.taskWorktree?.runId}`, error);
		}
		attempt.peerOverlay = null;
	};
	const callUsage = attempt.spec.telemetryContext ? createRunCallUsage(attempt.spec.telemetryContext) : undefined;

	// How the worker loop ended, once known; a failed finalization still settles the run journal with it.

	const closeRunJournal = async () => {
		try {
			await attempt.runJournal?.close();
		} finally {
			await attempt.parentJournal?.release();
		}
	};
	attempt.buildSpec = buildSpec;
	attempt.checkoutBaseline = checkoutBaseline;
	attempt.heldFollower = heldFollower;
	attempt.subscribeHeldBoard = subscribeHeldBoard;
	return {
		agentLedgerId,
		heldLedgerPosts,
		appendLedgerPost,
		onLedgerPost,
		onModelLoaded,
		onGrantRequest,
		onHookRequest,
		checkoutBaselineTaken,
		restorePeerOverlay,
		callUsage,
		closeRunJournal,
	};
}
