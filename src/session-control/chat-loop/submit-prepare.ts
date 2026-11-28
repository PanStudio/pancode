// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { isPlanOnlyRequest } from "../../core/plan-request.js";
import { hostFramedTexts } from "../../core/reminder-framing.js";
import type { PendingSkillToolPolicy } from "../../core/skill-activation.js";
import { withModelSkillActivation } from "../../core/skill-activation.js";
import { mainAgent } from "../../core/telemetry/context.js";
import {
	narrowTurnConstraints,
	routeScopedTurnConstraints,
	snapshotTurnConstraints,
	turnScopeGuidance,
} from "../../core/turn-constraints.js";
import { stepCheckpointApplies } from "../../domains/context/fold/contract.js";
import { acceptsImageInput } from "../../domains/providers/index.js";
import { readPromptCompileRecords } from "../../domains/session/prompt-manifest.js";
import { activePath, findLastEntry } from "../../domains/session/tree/active-path.js";
import { countImageBlocks } from "../../engine/image-context.js";
import type { ImageContent } from "../../engine/types.js";
import { modelMayActivateSkills } from "../../lib/autonomy/autonomy.js";
import type { TurnControlRecord } from "../../lib/turn-control/index.js";
import { resolveSessionTools } from "../../tools/agent-tools.js";
import { scopedCapabilityShapes, scopeShapesDelta } from "../../tools/gateway/scope-shapes.js";
import type { AskUserToolPolicy } from "../../tools/registry-contract.js";
import { visionObservationText } from "../../tools/vision-sidecar.js";
import type { ChatSubmitOptions } from "../chat-loop.js";
import {
	createAskUserToolPolicy,
	createPendingSkillToolPolicy,
	HOST_STATUS_NOTICE_KEY,
	notConfiguredNotice,
	pendingSkillRequestPreamble,
	rebaseToolMarkupReprompt,
	toolSignatureFromState,
} from "../chat-loop-messages.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { AwaitedTurnStart } from "../turn-middleware.js";
import { TurnAdmissionError } from "../turn-runtime.js";
import type { AgentRuntime, ChatLoopRunSnapshot, ChatLoopSubmitState } from "../turn-state.js";
import { isWorkerShareNote } from "../worker-share.js";
import type { SubmitTurn } from "./submit-turn.js";

/** What `submit` hands its preparation: the submitted text and the submit's admission. */
export interface SubmitPrepareInput {
	options: ChatSubmitOptions;
	text: string;
	owner: AbortController;
	generation: number;
	admissionCurrent: () => boolean;
	submittedAt: number;
}

/** The prepared request: its runtime, its text and tool surface, and what the previous call used. */
export interface SubmitPrepared {
	previousRunSnapshot: ChatLoopRunSnapshot | null;
	previousThinkingLevel: string | undefined;
	previousModel: { targetId: string; modelId: string } | undefined;
	agentRuntime: AgentRuntime;
	reservedUserTurnId: string;
	operatorText: string;
	images: ImageContent[] | undefined;
	referencedPaths: readonly string[];
	turnControlRecord: TurnControlRecord | null;
	pendingSkillPolicy: PendingSkillToolPolicy | undefined;
	skillsLoadedBeforeTurn: Set<string>;
	toolSignature: string;
	askUserPolicy: AskUserToolPolicy | undefined;
	composeSubmittedText: () => string;
	submittedText: string;
}

/**
 * Prepares one submitted turn up to its first composed request: the session writer, what the previous call used,
 * the runtime, the prompt and turn_start gates, images, turn control, the skill and ask-user policies, the frozen
 * tool surface and the step checkpoint. Resolves null when the turn was refused, canceled or lost its admission;
 * `submit` then returns.
 */
export async function prepareSubmittedTurn(
	loop: ChatLoopScope,
	state: ChatLoopSubmitState,
	turn: SubmitTurn,
	input: SubmitPrepareInput,
): Promise<SubmitPrepared | null> {
	const {
		context,
		currentToolInvokeOptions,
		deps,
		emit,
		emitAdmissionNotice,
		emitNotice,
		headlessObservation,
		markPreparationStep,
		middleware,
		middlewareToolChoice,
		noteTurnControlCollection,
		nullRuntimeAdmissionReason,
		recordCanceledBeforeAdmission,
		refuseSkillRequests,
		setTurnPreparation,
		stepStarts,
		submittedTurnOrigin,
		turnRuntime,
		visionModelOptions,
	} = loop;
	const { options, owner, generation, admissionCurrent, submittedAt } = input;
	let { text } = input;
	await loop.sessionResetSettlement;
	if (!admissionCurrent()) return null;
	// The turn holds its session's writer open from submit to settle, so the records it makes outside a model
	// call (middleware at turn start, tools, snapshots) reach the journal after an idle close (#434).
	const turnOrigin = deps.session?.current();
	if (turnOrigin && deps.telemetry?.acquireTelemetrySession) {
		try {
			turn.turnLease = await deps.telemetry.acquireTelemetrySession(turnOrigin, mainAgent(turnOrigin.id));
		} catch {
			// The writer reports its own failures; a turn never waits on telemetry.
		}
		if (!admissionCurrent()) return null;
	}
	state.currentTurnConstraints =
		options.requestContinuation === true
			? state.currentTurnConstraints
			: snapshotTurnConstraints(narrowTurnConstraints(loop.promptToolLimits, options.constraints));
	const previousRunSnapshot = state.lastRunSnapshot;
	let previousThinkingLevel: string | undefined = previousRunSnapshot?.runtimeResolution?.effectiveThinkingLevel;
	let previousModel: { targetId: string; modelId: string } | undefined = previousRunSnapshot
		? { targetId: previousRunSnapshot.targetId, modelId: previousRunSnapshot.wireModelId }
		: undefined;
	if (previousThinkingLevel === undefined || previousModel === undefined) {
		// #423: resume can append the newly requested dial before this loop boots.
		// Recover what the last call used, ignoring changes after that call.
		const entries = activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
		const entry = findLastEntry(entries, (row) => row.kind === "message" && row.role === "assistant");
		const lastCall = entry ? entries.lastIndexOf(entry) : -1;
		if (entry?.kind === "message") {
			const payload = entry.payload as {
				promptCache?: {
					observation?: { requestFingerprint?: { thinkingLevel?: string; targetId?: string; modelId?: string } };
				};
			} | null;
			const fingerprint = payload?.promptCache?.observation?.requestFingerprint;
			if (previousModel === undefined && fingerprint?.targetId !== undefined && fingerprint.modelId !== undefined)
				previousModel = { targetId: fingerprint.targetId, modelId: fingerprint.modelId };
			previousThinkingLevel ??= fingerprint?.thinkingLevel;
			if (previousThinkingLevel === undefined) {
				const meta = deps.session?.current();
				const compile = meta
					? readPromptCompileRecords(meta)
							.reverse()
							.find((record) => record.at <= entry.timestamp)
					: undefined;
				previousThinkingLevel = compile?.thinkingLevel ?? undefined;
				const change = entries
					.slice(0, lastCall)
					.reverse()
					.find((row) => row.kind === "thinkingLevelChange");
				if (change?.kind === "thinkingLevelChange" && (!compile || change.timestamp > compile.at)) {
					previousThinkingLevel = change.thinkingLevel;
				}
			}
		}
	}
	let agentRuntime: AgentRuntime | null;
	try {
		markPreparationStep("capabilities");
		await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
		if (!admissionCurrent()) return null;
		agentRuntime = turnRuntime.ensureRuntime();
	} catch (err) {
		emitAdmissionNotice(
			err instanceof Error ? err.message : String(err),
			err instanceof TurnAdmissionError ? err.reason : "admission-failed",
			"error",
		);
		return null;
	}
	if (!agentRuntime) {
		emitAdmissionNotice(notConfiguredNotice(deps.getSettings().chat), nullRuntimeAdmissionReason(), "error");
		return null;
	}
	// A template step policy scoped by `when` applies only on a matching route, read at each turn's start (C5).
	state.currentTurnConstraints = routeScopedTurnConstraints(
		state.currentTurnConstraints,
		agentRuntime.runtimeResolution,
	);
	if (options.machineTurn?.preparationToken === loop.machinePreparation?.token && loop.machinePreparation !== null)
		loop.machinePreparation.runtime = agentRuntime;
	if (refuseSkillRequests(options.pendingSkillRequests ?? [], options.workingContextPaths ?? [])) return null;
	// A request continuation resumes the turn in progress, so it keeps that turn's origin.
	if (options.requestContinuation !== true) {
		// CLI-P46: a yolo continuation belongs to the prompt its chain started from, an operator message handed in included.
		const prior = state.currentTurnOrigin?.origin ?? null;
		state.currentTurnOrigin = submittedTurnOrigin(options);
		if (options.yoloContinuation !== true) state.promptOrigin = state.currentTurnOrigin.origin;
		else if (prior !== "continuation") state.promptOrigin = prior;
	}
	if (deps.promptSubmit && options.requestContinuation !== true) {
		markPreparationStep("prompt-hook");
		const origin = state.currentTurnOrigin ?? { origin: "operator" as const };
		const verdict = await deps.promptSubmit({
			typed: options.display?.text ?? text,
			text,
			// Only a continuation's hooks hear what the turn it continues last called.
			origin:
				options.yoloContinuation === true && options.continuationToolCall !== undefined
					? { ...origin, lastToolCall: options.continuationToolCall }
					: origin,
		});
		if (!admissionCurrent()) return null;
		if (verdict.kind === "block") {
			emit({
				type: "notice",
				level: "warning",
				surface: "transcript",
				text: verdict.reason,
				admission: { reason: "prompt-blocked" },
			});
			return null;
		}
		text = verdict.text;
	}
	const pendingSkillRequests =
		state.currentTurnConstraints?.skills === "disabled" ? [] : (options.pendingSkillRequests ?? []);
	// The user turn id is fixed before the turn_start gate and turn control run, so
	// their records and the ledger row carry the id the user turn will be filed under.
	// A run that returns before admission leaves the id unused, which costs nothing.
	const reservedUserTurnId = randomUUID();
	// The awaited turn_start phase is the turn's gate. Like the prompt gate it
	// decides before the turn spends anything (an image sidecar call, turn
	// control) or buffers a reminder, so a refused turn leaves nothing for the
	// next prompt. Its effects apply after the synchronous turn_start phase.
	let awaitedTurnStart: AwaitedTurnStart | undefined;
	if (options.requestContinuation !== true) {
		markPreparationStep("turn-start");
		const gate = await middleware.awaitTurnStart(agentRuntime, text, pendingSkillRequests.length, reservedUserTurnId);
		if (!admissionCurrent()) return null;
		// A blocking turn_start hook that failed refuses the turn before its first model request.
		if (gate.refusal !== null) {
			emitAdmissionNotice(gate.refusal, "turn-blocked", "warning");
			return null;
		}
		awaitedTurnStart = gate;
	}
	const operatorText = text;
	let sidecarObservation: string | null = null;
	const routeAcceptsImages = acceptsImageInput({
		runtimeId: agentRuntime.runtimeResolution.runtime.id,
		vision: agentRuntime.runtimeResolution.capabilityDecisions.vision,
	});
	if (options.images?.length && !routeAcceptsImages) {
		if (deps.visionSidecar?.configured()) {
			const sidecar = deps.visionSidecar;
			const controller = owner;
			loop.pendingVisionSidecar = controller;
			emitNotice(
				`[PanCode] Processing image with ${sidecar.label() ?? "vision sidecar"}...`,
				"info",
				HOST_STATUS_NOTICE_KEY,
			);
			try {
				const question = operatorText.trim() || "Describe the attached image and any visible text.";
				markPreparationStep("images");
				const analysis = await sidecar.analyze(options.images, question, controller.signal);
				if (controller.signal.aborted || !admissionCurrent()) return null;
				sidecarObservation = visionObservationText(analysis);
				text = [operatorText, sidecarObservation].filter(Boolean).join("\n\n");
				emitNotice(`[PanCode] Image processed with ${analysis.model}.`, "info", HOST_STATUS_NOTICE_KEY);
			} catch (err) {
				if (controller.signal.aborted) {
					emitAdmissionNotice("[PanCode] Image processing cancelled.", "vision-sidecar-cancelled", "info");
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					emitAdmissionNotice(`[PanCode] Image processing failed: ${reason}`, "vision-sidecar-failed", "error");
				}
				return null;
			} finally {
				if (loop.pendingVisionSidecar === controller) loop.pendingVisionSidecar = null;
			}
		} else {
			const route = agentRuntime.runtimeResolution;
			const choices = visionModelOptions();
			const alternatives = choices.length
				? ` Known vision-capable models: ${choices.join(", ")}. Open /model to switch.`
				: " No vision-capable models are known in the configured catalog.";
			emit({
				type: "notice",
				level: "warning",
				surface: "transcript",
				text: `IMAGE_INPUT_UNSUPPORTED: ${route.targetId}/${route.wireModelId} cannot accept image input.${alternatives}`,
				admission: { reason: "image-input-unsupported" },
				source: "images",
			});
			return null;
		}
	}
	const historicalImages = countImageBlocks(agentRuntime.agent.state.messages);
	if (!routeAcceptsImages && historicalImages > 0) {
		const route = agentRuntime.runtimeResolution;
		const key = `${route.targetId}/${route.wireModelId}:${historicalImages}`;
		if (key !== loop.lastHistoricalImageNoticeKey) {
			loop.lastHistoricalImageNoticeKey = key;
			emitNotice(
				`[PanCode] ${historicalImages} earlier image${historicalImages === 1 ? "" : "s"} omitted from requests to text-only ${route.targetId}/${route.wireModelId}. The original images remain in session history for a vision-capable model.`,
				"warning",
				undefined,
				undefined,
				"images",
			);
		}
	} else {
		loop.lastHistoricalImageNoticeKey = null;
	}

	// 1. Accept the prompt: reset per-turn accounting, freeze the tool
	// surface, fire turn_start, and assemble the submitted text.
	state.turnToolCalls = 0;
	state.toolMarkupReprompt = rebaseToolMarkupReprompt(state.toolMarkupReprompt);
	state.turnToolNames = [];
	state.turnCallsDone = [];
	state.turnSharedWorkerNote = isWorkerShareNote(text);
	state.turnCollectedDetachedBatch = false;
	state.turnCompletion = null;
	state.turnSealedCompletion = null;
	// The finish round and the bare-finish refusal are once per operator prompt (fleet M5, FX-40, FX-41): a yolo
	// continuation of the prompt keeps them; a handed-over operator message resets the refusal (turn-persistence).
	if (options.requestContinuation !== true && options.yoloContinuation !== true) {
		state.turnCalledWork = false;
		state.finishRoundSpent = false;
		state.finishReplyRefused = false;
		state.finishOutputRefused = false;
		state.turnReplied = false;
		// Per operator prompt: a later submit of the same host run (an --output-schema repair) keeps the pool's fact.
		if (options.machineTurn === undefined) headlessObservation?.reset(options.hostRun?.runId);
	}
	state.continuation.beginPrompt({
		requestContinuation: options.requestContinuation === true,
		yoloContinuation: options.yoloContinuation === true,
	});
	middlewareToolChoice.reset();
	const images = sidecarObservation === null && options.images?.length ? [...options.images] : undefined;
	// Inlined @file content is part of this text, and the pre-turn decision or
	// a preparation compaction can send it before the user turn is filed.
	// A first turn has no session to hold the label yet, so it is recorded
	// again once the turn below has created one.
	const referencedPaths = options.workingContextPaths ?? [];
	if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
	context.addWorkingContextPaths(referencedPaths);
	context.prepareMemoryTurn(agentRuntime, {
		taskText: text,
		continuation: options.requestContinuation === true,
		images,
	});
	if (options.requestContinuation !== true) {
		loop.operatorSpokeAt = Date.now();
		try {
			deps.onOperatorTurn?.({ task: text });
		} catch {
			// The host's own bookkeeping never costs the submit.
		}
	}

	let turnControlBlock: string | null = null;
	let turnControlRecord: TurnControlRecord | null = null;
	if (deps.turnControl) {
		const controllerAbort = owner;
		loop.pendingPreTurnRead = controllerAbort;
		setTurnPreparation("preparing");
		markPreparationStep("turn-control");
		try {
			const result = await deps.turnControl.run({
				userTurnId: reservedUserTurnId,
				signal: controllerAbort.signal,
			});
			if (generation !== loop.submitGeneration || loop.disposed) return null;
			if (!controllerAbort.signal.aborted) noteTurnControlCollection(result);
			turnControlBlock = result.block;
			turnControlRecord = result.record;
		} finally {
			if (loop.pendingPreTurnRead === controllerAbort) loop.pendingPreTurnRead = null;
		}
		if (generation !== loop.submitGeneration || loop.disposed) return null;
		if (controllerAbort.signal.aborted) {
			await recordCanceledBeforeAdmission({
				userTurnId: reservedUserTurnId,
				continuation: options.requestContinuation === true,
				control: turnControlRecord,
				submittedAt,
			});
			return null;
		}
	}
	// A skill the operator activated narrows the tools for the workflow
	// it started, and that workflow outlives the turn it began in. A
	// fresh /skill this turn replaces the armed surface; otherwise the
	// armed surface is what this turn runs under.
	const pendingSkillPolicy = withModelSkillActivation(
		createPendingSkillToolPolicy(pendingSkillRequests) ?? state.activeSkillSurface,
		state.currentTurnConstraints?.skills !== "disabled" && modelMayActivateSkills(),
	);
	if (pendingSkillPolicy) {
		pendingSkillPolicy.allowListAdvisory = (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo";
	}
	// What was already loaded when this turn started, so the settle-time
	// notice names the skills this turn activated and not the ones a
	// carried surface has been holding since an earlier message.
	const skillsLoadedBeforeTurn = new Set(pendingSkillPolicy?.loadedSkillNames ?? []);
	// Resolve the frozen session tool surface before turn_start so intent
	// middleware sees the exact tools this request can actually call.
	agentRuntime.agent.state.tools = resolveSessionTools(
		agentRuntime,
		deps.toolRegistry,
		currentToolInvokeOptions,
		turnRuntime.toolTelemetry,
		loop.sessionToolLimits,
	);
	const toolSignature = toolSignatureFromState(agentRuntime.agent.state.tools);
	const askUserPolicy = createAskUserToolPolicy(
		agentRuntime.agent.state.tools,
		deps.toolRegistry,
		state.currentTurnConstraints,
	);
	if (askUserPolicy) askUserPolicy.planOnly = isPlanOnlyRequest(text);
	if (options.yoloContinuation !== true && options.requestContinuation !== true) loop.promptInterview = undefined;
	else if (askUserPolicy && loop.promptInterview) askUserPolicy.closedEarlier = loop.promptInterview;
	// turn_start: the prompt is accepted; registrations may inject
	// context for this request. Accumulated reminders (turn_end
	// advisories from the previous turn plus anything turn_start just
	// emitted) flush into the request as one system-reminder block.
	// Like the skill preamble below, the block is plain visible text in
	// the user message: persisted in the ledger, no hidden prompt
	// machinery.
	middleware.fireTurnStart(
		agentRuntime,
		text,
		pendingSkillRequests.length,
		options.requestContinuation === true,
		reservedUserTurnId,
		awaitedTurnStart,
	);
	// The turn's scope is host-framed text in its own user message, kept
	// verbatim in history, never a recompile of the system prompt (#422).
	// Continuations repeat it so a mid-turn compaction cannot drop it.
	const turnScope = turnScopeGuidance(state.currentTurnConstraints);
	const scopeShapes = scopedCapabilityShapes(deps.toolRegistry, state.currentTurnConstraints?.allowedTools);
	// The prompt delta is read when the text is composed, after
	// ensureSessionPrompt below has compared the live inputs (#423).
	// Pinned extension blocks and the scope's argument shapes are read
	// then too, after any compaction, and go only when the context lacks them.
	const reminderProjection = middleware.takePendingReminderProjection(() =>
		[
			turnScope,
			scopeShapesDelta(scopeShapes, hostFramedTexts(agentRuntime.agent.state.messages)),
			context.sessionPromptDelta(),
			...context.pinnedContextDelta(agentRuntime),
		].filter((part) => part.length > 0),
	);
	// Pending skill requests are plain visible text in the user message
	// itself: persisted in the ledger, no hidden prompt machinery.
	const skillPreamble = pendingSkillRequestPreamble(pendingSkillRequests, agentRuntime.agent.state.tools);
	let taskMemoryHandoffSource = "";
	if (pendingSkillRequests.some((request) => request.name.trim() === "context-handoff")) {
		try {
			taskMemoryHandoffSource = deps.getTaskMemoryHandoffSource?.() ?? "";
		} catch {
			// Handoff export is supplemental; a snapshot failure must not block
			// the explicitly requested skill turn.
		}
	}
	const composeSubmittedText = () =>
		[reminderProjection(), turnControlBlock ?? "", skillPreamble, taskMemoryHandoffSource, text]
			.filter((part) => part.length > 0)
			.join("\n\n");
	const stepLead = stepStarts.begin(
		state.currentTurnConstraints,
		text,
		options.yoloContinuation === true || options.requestContinuation === true,
		{ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId },
	);
	if (stepLead !== null && stepCheckpointApplies(agentRuntime.runtimeResolution)) {
		try {
			await context.runStepCheckpoint(agentRuntime, stepLead, pendingSkillPolicy);
		} catch (err) {
			emitNotice(
				`[PanCode] step checkpoint failed: ${err instanceof Error ? err.message : String(err)}. This step turn keeps the full history.`,
				"warning",
			);
		}
	}
	const submittedText = composeSubmittedText();
	return {
		previousRunSnapshot,
		previousThinkingLevel,
		previousModel,
		agentRuntime,
		reservedUserTurnId,
		operatorText,
		images,
		referencedPaths,
		turnControlRecord,
		pendingSkillPolicy,
		skillsLoadedBeforeTurn,
		toolSignature,
		askUserPolicy,
		composeSubmittedText,
		submittedText,
	};
}
