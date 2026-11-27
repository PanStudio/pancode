// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { requirePricedRefusal } from "../../core/run-overrides.js";
import { workerAgent } from "../../core/telemetry/context.js";
import { pancodeStateDir } from "../../core/xdg.js";
import type { AcpPeerQuestion } from "../../engine/acp/adapter.js";
import type { AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { persistWorkerContextSeed } from "../context/worker/store.js";
import { telemetryRunDirectory } from "../telemetry/index.js";
import type { TelemetrySessionLease } from "../telemetry/session-journals.js";
import type { AcpDelegationState } from "./acp-attempt-state.js";
import { resolveAcpContinuation } from "./acp-continuation.js";
import { resolveAcpDelegationLifecycle } from "./acp-delegation-lifecycle.js";
import { resolveToolBudgetEnvelope } from "./budget-envelope.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import {
	operatorContainedYolo,
	PEER_QUESTION_SCREEN_RETRY_MS,
	withoutDelegationStandInModel,
} from "./bundle-support.js";
import type { ProbeClaim } from "./bundle-types.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import { createRunCallUsage } from "./run-call-usage.js";
import { openRunTelemetry, type RunTelemetryJournal } from "./run-telemetry.js";
import type { RunPhaseMarks } from "./types.js";
import { workerToolCallHardCap } from "./worker-spec.js";

export async function admitAcpDelegation(
	rt: DispatchRuntime,
	delegation: AcpDelegationState,
	req: DispatchRequest,
	settings: EffectiveSettings,
	timing: RunPhaseMarks,
	routeDecision: RouteDecisionV1,
	probeClaims: ProbeClaim[],
	observer?: DispatchAdmissionObserver,
	hostRun?: DispatchPreparationOptions["hostRun"],
	signal?: AbortSignal,
) {
	const { assertTargetNotCoolingDown, getEffectiveSettings, maybeAgents, projectContext, safety, withLiveAutonomy } =
		rt.core;
	const { context, options } = rt;

	const lifecycle = resolveAcpDelegationLifecycle(
		{ ledgerAssignmentsFor: rt.runs.ledgerAssignmentsFor, maybeAgents, projectContext, safety },
		req,
		settings,
	);
	const estimate = workerToolCallHardCap(settings);
	const budgetEnvelope = resolveToolBudgetEnvelope({
		recipeId: req.agentId,
		policy: { toolCalls: estimate, synthesis: true },
		...(req.budget === undefined ? {} : { request: req.budget }),
		hardCap: estimate,
		retry: (req.lineage?.attempt ?? 0) > 0,
		revision: false,
		enforcement: "external-one-shot",
	});
	rt.lifecycle.publishDispatchPathScope(req, lifecycle.pathScope);
	req = withoutDelegationStandInModel(req, lifecycle.agentConfig.id);
	// continue_run (Phase 3.2): judged before the run takes a slot, so a refusal costs nothing.
	const continuation =
		req.continueRunId === undefined
			? null
			: resolveAcpContinuation({
					runId: req.continueRunId,
					row: rt.runs.requireLedger().get(req.continueRunId),
					agentId: req.agentId,
					ownerSessionId: req.ownerSessionId ?? null,
				});
	const targetId = `delegation:${lifecycle.agentConfig.id}`;
	const runtimeId = "acp";
	const wireModelId = req.model ?? lifecycle.agentConfig.id;
	assertTargetNotCoolingDown(req, targetId, runtimeId, wireModelId, probeClaims);

	if (req.contextSeed) persistWorkerContextSeed(req.contextSeed);
	// ACP delegation has no pricing, so `run --require-priced` refuses it here and the model hears why.
	const delegationUnpriced = requirePricedRefusal("none", `${targetId}/${wireModelId}`);
	if (delegationUnpriced !== undefined) throw new Error(`dispatch: admission denied: ${delegationUnpriced}`);
	await rt.budget.assertBudgetAdmitsRoute(req, { rates: null, pricedBy: "none" }, settings, lifecycle);

	const queuedIdentity =
		req.lineage === undefined && req.runIdHint !== undefined
			? {
					runId: req.runIdHint,
					sessionId: req.ownerSessionId ?? null,
					agentId: req.agentId,
					task: req.task,
					requestOrigin: lifecycle.requestOrigin,
					targetId,
					wireModelId,
					runtimeId,
					runtimeKind: "acp-delegation" as const,
				}
			: null;
	// The tool's abort signal reaches the queue, so a delegation waiting for
	// a slot can be canceled like a native one. The ledger resolves before
	// the ACP process starts: an external agent must never outlive a failure
	// to create its tracking row.
	const launch = await rt.capacity.acquireDispatchLaunch(req, queuedIdentity, null, timing, null, signal);
	const ledgerRef = launch.ledger;
	const telemetryContext = req.runIdHint
		? {
				sessionId: req.ownerSessionId ?? null,
				runId: req.runIdHint,
				agent: workerAgent(req.runIdHint),
				...(req.lineage?.parentRunId ? { parentRunId: req.lineage.parentRunId } : {}),
			}
		: undefined;
	const callUsage = telemetryContext ? createRunCallUsage(telemetryContext) : undefined;
	let runJournal: RunTelemetryJournal | undefined;
	let parentJournal: TelemetrySessionLease | undefined;
	// How the worker loop ended, once known; a failed finalization still settles the run journal with it.

	const closeRunJournal = async () => {
		try {
			await runJournal?.close();
		} finally {
			await parentJournal?.release();
		}
	};
	if (telemetryContext) {
		try {
			runJournal = await openRunTelemetry(
				telemetryContext,
				telemetryRunDirectory(pancodeStateDir(), telemetryContext.runId),
			);
			if (req.ownerSessionId && req.ownerSessionCwdHash) {
				parentJournal = await context
					.getContract("telemetry")
					?.acquireTelemetrySession?.({ id: req.ownerSessionId, cwdHash: req.ownerSessionCwdHash }, telemetryContext.agent);
				if (parentJournal) runJournal.linkSession(parentJournal.context);
			}
		} catch (error) {
			reportDispatchDiagnostic("open ACP run telemetry journal", error);
		}
	}

	// A peer's fixed-choice question (agy interaction_*) goes to a person through the operator's ask surface, the TUI
	// card or an ACP client's interview, under the same gate as worker asks: nobody attached, contained yolo, or
	// fleet.permissions.mode deny or fail answers it cancelled. Only the operator's own pick goes back.
	delegation.peerQuestionsOpen = 0;
	const askPeerQuestion = async (question: AcpPeerQuestion, questionSignal: AbortSignal): Promise<string | null> => {
		const operator = options?.operatorAsk;
		if (operator === undefined || !operator.available()) return null;
		const live = withLiveAutonomy(getEffectiveSettings());
		if (operatorContainedYolo(live)) return null;
		const mode = live?.fleet.permissions.mode;
		if (mode === "deny" || mode === "fail") return null;
		// Labels are what the card returns, so a repeated one is told apart by its optionId, and by a counter when that
		// suffix is itself another option's label; no option is dropped.
		const byLabel = new Map<string, string>();
		for (const option of question.options) {
			let label = option.label;
			for (let n = 1; byLabel.has(label); n++)
				label = n === 1 ? `${option.label} (${option.optionId})` : `${option.label} (${option.optionId} ${n})`;
			byLabel.set(label, option.optionId);
		}
		const warning = question.securityWarning !== undefined ? `\n\nSecurity warning: ${question.securityWarning}` : "";
		const asked: AskUserQuestion = {
			question: `${req.agentId} asks: ${question.question}${warning}`,
			header: "Delegated agent",
			options: [...byLabel.keys()].map((label) => ({ label })),
			fixedChoices: true,
			operator_only: true,
		};
		delegation.peerQuestionsOpen += 1;
		try {
			// A harness card, as the merge card asks: the run's end dismisses it, Esc answers only it, and nothing enters
			// the main transcript. A screen another card holds is retried until it frees or the run ends.
			let result: AskUserResult;
			for (;;) {
				if (questionSignal.aborted || !operator.available()) return null;
				result = await operator.ask([asked], { origin: "harness", signal: questionSignal });
				if (questionSignal.aborted) return null;
				if (result.unavailable !== true) break;
				await new Promise<void>((resolve) => {
					const settle = (): void => {
						clearTimeout(wake);
						questionSignal.removeEventListener("abort", settle);
						resolve();
					};
					const wake = setTimeout(settle, PEER_QUESTION_SCREEN_RETRY_MS);
					wake.unref?.();
					questionSignal.addEventListener("abort", settle, { once: true });
					if (questionSignal.aborted) settle();
				});
			}
			const answer = result.answers[0];
			if (result.cancelled === true || answer === undefined || answer.auto === true) return null;
			return byLabel.get(answer.options?.[0] ?? answer.answer) ?? null;
		} finally {
			delegation.peerQuestionsOpen -= 1;
		}
	};
	delegation.req = req;
	delegation.timing = timing;
	delegation.routeDecision = routeDecision;
	delegation.observer = observer;
	delegation.hostRun = hostRun;
	delegation.runJournal = runJournal;
	return {
		lifecycle,
		budgetEnvelope,
		continuation,
		targetId,
		runtimeId,
		wireModelId,
		launch,
		ledgerRef,
		telemetryContext,
		callUsage,
		closeRunJournal,
		askPeerQuestion,
	};
}
