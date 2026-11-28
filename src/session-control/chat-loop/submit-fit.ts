// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { formatCount } from "../../core/format-time.js";
import type { PendingSkillToolPolicy } from "../../core/skill-activation.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import { requestFits } from "../../domains/context/budget/request-fit.js";
import type { CompiledSessionPrompt } from "../../domains/prompts/compiler.js";
import type { ContextSnapshot } from "../../domains/session/context-accounting.js";
import type { ImageContent } from "../../engine/types.js";
import type { TurnControlRecord } from "../../lib/turn-control/index.js";
import type { ChatSubmitOptions } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import { withSettledHistory } from "../message-list-digest.js";
import { resolveFitOutputReserve, turnAdmissionRemedy } from "../output-reserve.js";
import { compactCommandHint, routeCommandHint } from "../surface-hints.js";
import type { AgentRuntime } from "../turn-state.js";

/**
 * Why a forced compaction failed, in words: `compaction stream failed: 401: {"message":"invalid api key"}` reads
 * `the provider answered 401: invalid api key`.
 */
export function compactionFailureReason(err: unknown): string {
	const raw = (err instanceof Error ? err.message : String(err)).replace(/^compaction stream failed:\s*/u, "");
	const status = /^(\d{3}):\s*/u.exec(raw);
	const rest = status ? raw.slice(status[0].length) : raw;
	let detail = rest.trim();
	try {
		const parsed: unknown = JSON.parse(detail);
		const message =
			parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
				? parsed.message
				: null;
		if (message !== null) detail = message;
	} catch {
		// Not JSON: the provider's text is already the reason.
	}
	detail = detail.replace(/[.\s]+$/u, "");
	return status ? `The provider answered ${status[1]}: ${detail}` : `The summary call failed: ${detail}`;
}

/** What `submit` hands its fit: the prepared request and what its admission is checked against. */
export interface SubmitFitInput {
	options: ChatSubmitOptions;
	owner: AbortController | null;
	generation: number;
	admissionCurrent: () => boolean;
	submittedAt: number;
	agentRuntime: AgentRuntime;
	reservedUserTurnId: string;
	images: ImageContent[] | undefined;
	turnControlRecord: TurnControlRecord | null;
	pendingSkillPolicy: PendingSkillToolPolicy | undefined;
	toolSignature: string;
	composeSubmittedText: () => string;
	submittedText: string;
}

/** The fitted request: its text as compaction left it, the session prompt it runs under and its snapshot. */
export interface SubmitFit {
	submittedText: string;
	compiledPrompt: CompiledSessionPrompt | null;
	turnSnapshot: ContextSnapshot;
}

/**
 * Fits one prepared request to its window before the user turn is committed: the pre-submit auto-compaction, the
 * session prompt compile and the preflight overflow check with its one forced compaction. Resolves null when the
 * request was refused, canceled or lost its admission; `submit` then returns.
 */
export async function fitSubmittedTurn(loop: ChatLoopScope, input: SubmitFitInput): Promise<SubmitFit | null> {
	const {
		context,
		deps,
		emitAdmissionNotice,
		emitNotice,
		endPreparationCompaction,
		markPreparationStep,
		prepareCompactionPaint,
		recordCanceledBeforeAdmission,
		setTurnPreparation,
	} = loop;
	const {
		options,
		owner,
		generation,
		admissionCurrent,
		submittedAt,
		agentRuntime,
		reservedUserTurnId,
		images,
		turnControlRecord,
		pendingSkillPolicy,
		toolSignature,
		composeSubmittedText,
	} = input;
	let { submittedText } = input;
	// 2. Pre-submit auto-compaction trigger. Its stage figures price the request this turn sends, so a runtime
	// a resume just built gets the session prompt first instead of the seeded fallback (bt-47 D1). Only such a
	// runtime compiles here, so a submit whose prompt is applied reads memory once; step 3 owns the fallback replay.
	if (context.sessionPromptPending?.(agentRuntime)) {
		await context.ensureSessionPrompt(agentRuntime, false, undefined, true);
		if (!admissionCurrent()) return null;
	}
	const forceNow = process.env.PANCODE_FORCE_COMPACT === "1";
	const paintCompaction = prepareCompactionPaint();
	try {
		setTurnPreparation("compacting");
		await paintCompaction();
		if (!admissionCurrent()) return null;
		await context.runAutoCompact(
			agentRuntime,
			forceNow,
			undefined,
			undefined,
			submittedText,
			pendingSkillPolicy,
			undefined,
			undefined,
			options.requestContinuation !== true,
			undefined,
			reservedUserTurnId,
		);
	} catch (err) {
		// A new session or a dispose since submit owns the transcript now; this turn's notice and outcome
		// row belong to the session it left, as on the turn-control and overflow paths.
		if (generation !== loop.submitGeneration || loop.disposed) return null;
		const tokens = context.contextUsage().tokens;
		// The cheaper stages run before the summary and may have applied, so the size is stated, not "unchanged".
		const size = tokens !== null ? `; context at ${formatCount(tokens)} tokens` : "";
		const aborted = err instanceof Error && err.name === "AbortError";
		// Worded as the operator's /context compact failure is: the size, why in words, and the way on (HS14).
		// A failure here does not stop the turn, which goes out without a summary. A settled card already states a cancel.
		if (!aborted) {
			emitNotice(
				`[PanCode] auto-compaction failed${size}. ${compactionFailureReason(err)}. This turn goes on without it; ${compactCommandHint(deps.headless === true, deps.session?.current()?.id)} tries again; ${routeCommandHint(deps.headless === true)} picks another route to summarize on.`,
				"warning",
			);
		} else if (!context.lastCompactionCardSettled()) {
			emitNotice(`[PanCode] auto-compaction cancelled${size}`);
		}
		if (aborted) {
			await recordCanceledBeforeAdmission({
				userTurnId: reservedUserTurnId,
				continuation: options.requestContinuation === true,
				control: turnControlRecord,
				submittedAt,
			});
			return null;
		}
	} finally {
		endPreparationCompaction();
	}

	if (!admissionCurrent()) return null;

	// 3. Session prompt: recompiled only on an explicit event, otherwise the last compile
	markPreparationStep("compile");
	const compiledPrompt = await context.ensureSessionPrompt(agentRuntime, true, submittedText);
	if (!admissionCurrent()) return null;
	submittedText = composeSubmittedText();

	// 4. Preflight overflow check, before the user turn is committed.
	// A blocked request must not leave a dangling user entry that the
	// next replay would treat as an unanswered turn.
	const compactionThreshold = deps.getSettings().context.compaction?.threshold ?? null;
	const captureTurnSnapshot = (turnId: string): ContextSnapshot =>
		context.captureRuntimeContextSnapshot(agentRuntime, turnId, compactionThreshold, {
			promptSegments: compiledPrompt
				? compiledPrompt.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate }))
				: undefined,
			pendingUserInput: submittedText,
			images,
			promptHash: compiledPrompt?.systemPromptHash,
			toolSignature,
		});

	let turnSnapshot = captureTurnSnapshot("pending");
	// The window-fit gate reads the A4 count, so a request Pi's clamp would refuse compacts first.
	const fitInput = (view: LiveBudgetView): number | null =>
		view.inputTokens === null
			? null
			: (context.overflowFitTokens?.(agentRuntime, submittedText, view.inputTokens) ?? view.inputTokens);
	// The publication and the fit count read one history, so the second matches the first's check by identity (SC-6).
	const admit = (): { view: LiveBudgetView; input: number | null } =>
		withSettledHistory(() => {
			const view = context.refreshLiveBudget(submittedText);
			return { view, input: fitInput(view) };
		});
	const first = admit();
	let admission = first.view;
	// A window too small for the request's fixed part is refused before any call; compaction cannot help it.
	const floorRefusal = context.contextFloorRefusal?.(agentRuntime, submittedText) ?? null;
	if (floorRefusal !== null) {
		emitAdmissionNotice(floorRefusal, "context-window-exceeded", "error");
		return null;
	}
	// The output reserve shrinks as input grows, so it is resolved at the count the gate chose.
	const fitReserve = (input: number | null): number | null =>
		input === null ? null : resolveFitOutputReserve(agentRuntime, input);
	const firstInput = first.input;
	if (
		admission.effectiveWindow !== null &&
		!requestFits(firstInput, fitReserve(firstInput), admission.effectiveWindow)
	) {
		const paintOverflow = prepareCompactionPaint();
		setTurnPreparation("compacting");
		let failure: string | undefined;
		let canceled = false;
		await paintOverflow()
			.then(() => {
				if (!admissionCurrent()) return false;
				return context.runAutoCompact(
					agentRuntime,
					true,
					undefined,
					"overflow",
					submittedText,
					pendingSkillPolicy,
					undefined,
					undefined,
					options.requestContinuation !== true,
					undefined,
					reservedUserTurnId,
				);
			})
			.catch((error: unknown) => {
				canceled = error instanceof Error && error.name === "AbortError";
				failure = error instanceof Error ? error.message : String(error);
			})
			.finally(endPreparationCompaction);
		if (generation !== loop.submitGeneration || loop.disposed) return null;
		// An operator cancel is not an admission failure: record it like the
		// pre-admission cancels above and leave no window-exceeded notice.
		// Stop aborts the submit owner too, so the owner check alone must
		// not skip the reserved turn's outcome.
		if (canceled || owner?.signal.aborted) {
			await recordCanceledBeforeAdmission({
				userTurnId: reservedUserTurnId,
				continuation: options.requestContinuation === true,
				control: turnControlRecord,
				submittedAt,
			});
			return null;
		}
		if (!admissionCurrent()) return null;
		submittedText = composeSubmittedText();
		const admitted = admit();
		admission = admitted.view;
		const admittedInput = admitted.input;
		const admittedReserve = fitReserve(admittedInput);
		if (admission.effectiveWindow !== null && !requestFits(admittedInput, admittedReserve, admission.effectiveWindow)) {
			const oversize = context.oversizedResult?.(agentRuntime, submittedText);
			emitAdmissionNotice(
				`[PanCode] Request exceeds the available context window (input ${admittedInput ?? "unknown"} + output ${admittedReserve ?? "unknown"}, window ${admission.effectiveWindow ?? "unknown"}).${failure ? ` ${failure}` : ""}${oversize ? ` ${oversize}` : ""} ${turnAdmissionRemedy(agentRuntime, admittedInput ?? 0)}`,
				"context-window-exceeded",
				"error",
			);
			return null;
		}
		turnSnapshot = captureTurnSnapshot("pending");
	}
	return { submittedText, compiledPrompt, turnSnapshot };
}
