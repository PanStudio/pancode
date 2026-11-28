// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * How a native worker run sends each model round: the request shape for the work, handback and
 * terminal handoff phases, the helper protocol and cached prefix it keeps across them, the context
 * guard's fit and eviction, the response format and thinking level a locked round carries, and the
 * one refresh and one overflow retry a round may earn.
 */

import {
	type AnthropicMessagesCompat,
	type Context,
	getToolStateChanges,
	type OpenAIResponsesCompat,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { trackCallFetch } from "../../core/call-failure.js";
import { createHostPolicyMessage } from "../../core/host-policy-message.js";
import { isProviderAuthRejection } from "../../core/provider-auth-error.js";
import { isResponseSchemaRejection } from "../../core/response-schema.js";
import { requestedThinking } from "../../core/telemetry/call-effort.js";
import { hasTokenUsageCounts } from "../../core/token-split.js";
import { resultContractShape } from "../../domains/agents/result-contract-repair.js";
import { WorkerContextExhaustedError } from "../../domains/context/worker/pressure.js";
import { compactionBudget } from "../../domains/providers/catalog.js";
import { estimateAgentMessageTokens } from "../../domains/session/context-accounting.js";
import type { EngineAgentOptions } from "../agent.js";
import { engineStreamSimple } from "../api-registry.js";
import { anchorContextAtInputTokens, requestOutputReserve } from "../apis/output-budget.js";
import { normalizeContext, resolvedRequestContext } from "../context.js";
import {
	lockedSynthesisDirective,
	withLockedSynthesisDirective,
	withRequestTailDirective,
} from "../loop-guard-synthesis.js";
import { retryStreamOnceOnAuthRejection } from "../oauth-retry-stream.js";
import { retryStreamOnceOnOverflow } from "../overflow-retry-stream.js";
import { applyToolRounds, deterministicSampling, streamToolRound } from "../provider-payload.js";
import type { AgentMessage } from "../types.js";
import { boundWorkerResponse } from "../worker-response-stream.js";
import { withResultContractReminder } from "../worker-result-contract.js";
import { exhaustedChangesDetail, THRASH_CONTEXT_FRACTION } from "../worker-thrash-note.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

/**
 * APIs whose request renders the reasoning effort ahead of the input, so a locked round there keeps the run's level.
 * On copilot-sdk a changed effort is a setModel on the live session, after which Copilot read none of its cached
 * prefix (M-20).
 */
const REASONING_PREFIX_APIS: ReadonlySet<string> = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"copilot-sdk",
]);

export function createWorkerStreamFn(scope: WorkerRunScope) {
	const {
		input,
		emit,
		phase,
		mutationResult,
		helperToolAvailable,
		helperForcedChoiceAvailable,
		contractReminder,
		inheritedMessages,
		workerSettings,
		contextGuard,
		runEffects,
		contractCwd,
		workShare,
		noteShare,
		enterHandback,
		workerResponseFormat,
		middlewareToolChoice,
		terminalHandoffActive,
		effectiveThinkingLevel,
		refreshWorkerOAuthKey,
	} = scope;
	let responseRound = 0;
	// Status of the current round's own attempt; a stale status from an earlier
	// round must not veto the message-based rejection check (#427).
	let roundProviderHttpStatus: number | null = null;

	// Resolved snapshots lose the tool-addition boundaries; retain them so the
	// terminal handoff can reuse the work phase's cached prefix (#423).
	let nativeHelperContext:
		| {
				initial: SystemMessage;
				tools: Tool[];
				protocol: string;
				updates: Array<{ at: number; message: SystemMessage }>;
		  }
		| undefined;
	// Whether the first round's system prompt carried the helper protocol. Off native routes every later round keeps that
	// prompt byte for byte, so the prefix cache survives the handoff; phase notes ride the request tail (FL-16).
	let helperProtocolInPrefix: boolean | undefined;

	const streamFn: NonNullable<EngineAgentOptions["streamFn"]> = (currentModel, transcript, streamOptions) => {
		if (scope.resultContractRepairsQueued > scope.resultContractRepairsStarted) {
			scope.resultContractRepairsStarted += 1;
			emit({ type: "pancode_repair_rounds_started", payload: { started: scope.resultContractRepairsStarted } });
		}
		const round = ++responseRound;
		const resolvedContext = resolvedRequestContext(transcript);
		const anthropicCompat =
			currentModel.api === "anthropic-messages" ? (currentModel.compat as AnthropicMessagesCompat | undefined) : undefined;
		const codexCompat =
			currentModel.api === "openai-codex-responses"
				? (currentModel.compat as OpenAIResponsesCompat | undefined)
				: undefined;
		const codexToolChanges =
			helperToolAvailable &&
			codexCompat?.supportsMidConvoSystemMessages === true &&
			codexCompat.supportsAdditionalTools === true;
		// Pi needs an active initial tool to anchor native additions (#423).
		const nativeToolChanges =
			(codexToolChanges && (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)) ||
			(anthropicCompat?.supportsMidConvoSystemMessages === true &&
				anthropicCompat.supportsMidConvoToolChanges === true &&
				(!mutationResult || (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)));
		const helperDeclaredFromStart =
			helperToolAvailable && currentModel.api === "anthropic-messages" && !nativeToolChanges;
		const helperProtocol = `Return the result by calling ${INTERNAL_HELPER_RESULT_TOOL} alone with the result object as arguments. Successful submission ends the run; no narrative report is needed.`;
		const withProtocol = (note: string) =>
			`${resolvedContext.systemPrompt ?? ""}\n\n# Internal helper protocol\n${helperProtocol}${note ? ` ${note}` : ""}`;
		// The lock decides the round's tool surface, prompt, tail and directive. A context handback flips the lock after
		// the guard, so the round is shaped again then and the crossing request carries the handoff helper or the
		// locked-synthesis directive like any locked round (M3).
		const shapeRound = () => {
			scope.helperTerminalRequest = phase.toolsLocked || phase.resultForced;
			scope.helperExposedThisRound =
				helperToolAvailable &&
				((!mutationResult && !codexToolChanges) || phase.toolsLocked || phase.resultForced) &&
				(!(phase.toolsLocked || phase.resultForced) || helperForcedChoiceAvailable);
			// Native additions hide the helper until handoff without rewriting the
			// initial schemas. Older Anthropic models declare it early; the host
			// still rejects premature submission during the work phase (#423).
			// A locked round that cannot name the helper keeps it declared when the work phase declared it: the
			// Copilot SDK keeps a locked round's tools, so dropping it alone changed the session's tool set and missed
			// the cached prefix (M-31). An API that can name it already exposes it here, so only such rounds change.
			const helperDeclaredInWork = helperToolAvailable && !mutationResult && !codexToolChanges;
			const currentContext = {
				...resolvedContext,
				tools: (resolvedContext.tools ?? []).filter(
					(tool) =>
						tool.name !== INTERNAL_HELPER_RESULT_TOOL ||
						scope.helperExposedThisRound ||
						helperDeclaredFromStart ||
						helperDeclaredInWork,
				),
			};
			const helperOnRequest = scope.helperExposedThisRound || helperDeclaredFromStart;
			const helperLockedNote =
				!helperDeclaredFromStart && (phase.toolsLocked || phase.resultForced)
					? "Work tools are disabled. Earlier tool-use instructions apply only to the completed work phase; only the terminal handoff remains available. Do not invent missing evidence."
					: "";
			helperProtocolInPrefix ??= helperOnRequest;
			// Native routes slice the protocol back out of this prompt into a mid-conversation section below; every other
			// route keeps the first round's prompt and carries a protocol or note that arrived later on the tail.
			const systemPrompt = nativeToolChanges
				? helperOnRequest
					? withProtocol(helperLockedNote)
					: currentContext.systemPrompt
				: helperProtocolInPrefix
					? withProtocol("")
					: currentContext.systemPrompt;
			const helperTail =
				nativeToolChanges || !helperOnRequest
					? ""
					: [helperProtocolInPrefix ? "" : `Internal helper protocol: ${helperProtocol}`, helperLockedNote]
							.filter((part) => part.length > 0)
							.join(" ");
			// A synthesis lock without the helper handoff carries its directive on the
			// request tail, so the system prompt keeps the work phase's bytes and a
			// prefix cache survives the lock.
			const synthesisDirective =
				phase.toolsLocked && !helperOnRequest
					? { requiredResult: input.resultContract ? resultContractShape(input.resultContract) : undefined }
					: undefined;
			// Priced with the tail directive the round will carry; only the estimate sees it here.
			const pricedSystemPrompt =
				synthesisDirective !== undefined
					? `${systemPrompt ?? ""}\n\n${lockedSynthesisDirective(synthesisDirective.requiredResult)}`
					: helperTail
						? `${systemPrompt ?? ""}\n\n${helperTail}`
						: (systemPrompt ?? "");
			return { currentContext, systemPrompt, helperTail, synthesisDirective, pricedSystemPrompt };
		};
		let shape = shapeRound();
		const window = input.runtimeResolution?.capabilities.contextWindow ?? currentModel.contextWindow;
		const { reminders } = withResultContractReminder(
			resolvedContext.messages,
			contractReminder,
			inheritedMessages.length,
		);
		const pressureFor = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) => ({
			messages: currentContext.messages,
			overheadTokens: reminders.reduce((sum, reminder) => sum + estimateAgentMessageTokens(reminder as AgentMessage), 0),
			systemPrompt: pricedSystemPrompt,
			tools: currentContext.tools ?? [],
			contextWindow: window,
			threshold: compactionBudget(
				window,
				workerSettings.context.compaction.threshold,
				workerSettings.context.compaction.maxTokens,
				currentModel,
			).threshold,
			target: workerSettings.context.workingSet.target,
			rearmFraction: workerSettings.context.workingSet.rearmFraction,
			autoEvict: workerSettings.context.compaction.auto && workerSettings.context.workingSet.enabled,
			outputReserve: (inputTokens: number) =>
				requestOutputReserve(currentModel, currentModel.maxTokens, window, inputTokens),
			unanchoredInputTokens: (history: ReadonlyArray<AgentMessage>) => {
				const context = normalizeContext({
					systemPrompt: pricedSystemPrompt,
					...(currentContext.tools !== undefined ? { tools: currentContext.tools } : {}),
					messages: withResultContractReminder([...history], contractReminder, inheritedMessages.length)
						.messages as Context["messages"],
				});
				// The same anchor rule `request` re-pins through: with one, Pi reads the guard's own count.
				return anchorContextAtInputTokens(context, 1) === context ? estimateContextTokens(context).tokens : 0;
			},
		});
		let pressure = pressureFor(shape);
		let messages: AgentMessage[];
		scope.contextPressureWindow = window;
		try {
			messages = contextGuard(pressure);
		} catch (error) {
			if (error instanceof WorkerContextExhaustedError) {
				phase.sealOver(error.message);
				// The parent seals this with the run's last narration, so a run that dies at the wall still hands back
				// what it changed (CLI-H3).
				emit({
					type: "pancode_run_outcome",
					payload: {
						outcomeCode: "worker_context_exhausted",
						detail: exhaustedChangesDetail(runEffects.snapshot().mutatedPaths, contractCwd),
					},
				});
			}
			throw error;
		}
		// A request admitted without a fold reports no decision, so the thrash share reads the admitted count too.
		if (window > 0 && contextGuard.inputTokens >= window * THRASH_CONTEXT_FRACTION) scope.contextPressureCrossed = true;
		let handbackSurfaceTokens = 0;
		if (window > 0) {
			scope.runObservationWindow = {
				usableTokens: window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens),
				workShare: input.role !== undefined ? workShare(input.role) : (input.limits?.context.workShare ?? 1),
				inputTokens: contextGuard.inputTokens,
			};
		}
		// M3: a run with a role hands back at its role's share of the usable window instead of dying at the wall.
		if (window > 0 && input.role !== undefined && !phase.toolsLocked) {
			const usable = window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens);
			if (contextGuard.inputTokens >= usable * noteShare) scope.contextPressureCrossed = true;
			if (contextGuard.inputTokens >= usable * workShare(input.role)) {
				enterHandback("context");
				const surfaceTokens = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) =>
					estimateContextTokens(
						normalizeContext({ systemPrompt: pricedSystemPrompt, tools: currentContext.tools ?? [], messages: [] }),
					).tokens;
				const unlocked = shape;
				shape = shapeRound();
				pressure = pressureFor(shape);
				// The guard admitted the history under the work phase's surface; the handoff's helper and directive add to it.
				handbackSurfaceTokens = Math.max(0, surfaceTokens(shape) - surfaceTokens(unlocked));
			}
		}
		const { currentContext, systemPrompt, helperTail, synthesisDirective } = shape;
		// Stable sampling applies to every context-generation round, terminal
		// repairs included. It merges over the caller's options so it beats quirk
		// profiles and run overrides, which the adapters apply underneath.
		const sampling =
			input.sampling === "deterministic" ? deterministicSampling(currentModel, input.runtime.id) : undefined;
		// A final-only round (synthesis lock or final-only repair) ships no tools,
		// so a contract's schema can bind it without meeting a tool grammar.
		const contractFormat =
			scope.contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable
				? scope.contractResponseFormat
				: undefined;
		const optionsWith = (responseFormat: Record<string, unknown> | undefined) =>
			sampling === undefined && responseFormat === undefined
				? streamOptions
				: {
						...streamOptions,
						...sampling,
						samplingParams: {
							...streamOptions?.samplingParams,
							...sampling?.samplingParams,
							...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
						},
					};
		let requestOptions = optionsWith(workerResponseFormat ?? contractFormat);
		// Routed per attempt: the lock and the middleware choice can flip between
		// the first call and the overflow retry. The terminal handoff comes first
		// because it names its tool and keeps the surface a lock would remove. A
		// locked round has no declarations left, so neither middleware round
		// applies to it.
		// A refreshed credential replaces the one Pi resolved for this round; the
		// next round resolves its own through getApiKey (#427).
		let roundApiKey: string | undefined;
		// `inputTokens` is the count the guard admitted `history` at; admission and the clamp size it from that.
		const request = (history: AgentMessage[], inputTokens: number) => {
			const projected = withResultContractReminder(history, contractReminder, inheritedMessages.length).messages;
			const middlewareChoice = middlewareToolChoice.current();
			// Codex retains the work phase's parallel setting for WS deltas;
			// beforeToolCall still rejects mixed or duplicate handoffs (#423).
			const controlled = applyToolRounds(
				currentModel,
				{
					...currentContext,
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
					messages: projected as typeof currentContext.messages,
				},
				roundApiKey === undefined ? requestOptions : { ...requestOptions, apiKey: roundApiKey },
				[
					terminalHandoffActive(currentModel.api)
						? { kind: "required", toolName: INTERNAL_HELPER_RESULT_TOOL, handoff: !codexToolChanges }
						: undefined,
					phase.toolsLocked ? { kind: "tools-removed" } : undefined,
					middlewareChoice.kind === "none" && !phase.toolsLocked ? { kind: "text-only" } : undefined,
					middlewareChoice.kind === "required" && !phase.toolsLocked
						? { kind: "required", toolName: middlewareChoice.toolName }
						: undefined,
				],
				input.target.id,
			);
			let requestContext: Context = controlled.context;
			if (helperToolAvailable && nativeToolChanges) {
				const basePrompt = currentContext.systemPrompt ?? "";
				// An evidence repair reopens the read tools by policy, never by erasing history (#423).
				const protocol =
					codexToolChanges && scope.evidenceRepairActive && !scope.helperTerminalRequest
						? "The host reopened the read-class tools for an evidence repair. Read the inputs the assignment names, then begin the terminal handoff again."
						: (systemPrompt ?? "").slice(basePrompt.length);
				// Codex can append declarations but cannot replay removals without
				// collapsing them into the leading item. Execution remains gated by
				// beforeToolCall even though the work declarations stay in history (#423).
				const requestTools = codexToolChanges
					? [
							...new Map(
								[...(nativeHelperContext?.tools ?? []), ...(currentContext.tools ?? [])].map((tool) => [tool.name, tool]),
							).values(),
						]
					: (resolvedRequestContext(controlled.context).tools ?? []);
				if (nativeHelperContext === undefined || nativeHelperContext.initial.content !== basePrompt) {
					nativeHelperContext = {
						initial: {
							role: "system",
							content: basePrompt,
							sections: { helper: protocol },
							toolsAdded: requestTools,
							timestamp: 0,
						},
						tools: requestTools,
						protocol,
						updates: [],
					};
				} else {
					const changes = getToolStateChanges(nativeHelperContext.tools, requestTools);
					if (
						changes.toolsAdded.length > 0 ||
						changes.toolsRemoved.length > 0 ||
						nativeHelperContext.protocol !== protocol
					) {
						const policy = codexToolChanges
							? (createHostPolicyMessage(`worker-handoff-${nativeHelperContext.updates.length}`, protocol, 0) as SystemMessage)
							: { role: "system" as const, content: "", sections: { helper: protocol }, timestamp: 0 };
						nativeHelperContext.updates.push({
							at: projected.length,
							message: { ...policy, ...changes },
						});
						nativeHelperContext.tools = requestTools;
						nativeHelperContext.protocol = protocol;
					}
				}
				const nativeMessages: Context["messages"] = [nativeHelperContext.initial];
				let start = 0;
				for (const update of nativeHelperContext.updates) {
					nativeMessages.push(...projected.slice(start, update.at), update.message);
					start = update.at;
				}
				nativeMessages.push(...projected.slice(start));
				requestContext = { messages: nativeMessages };
			}
			// Pi's SDK adapters report onResponse only for a 2xx answer, so the
			// status is read at the fetch boundary every adapter routes through.
			return streamToolRound(
				currentModel,
				{ ...controlled, context: requestContext },
				(attempt) => {
					const roundKind = attempt.toolRounds?.[0]?.kind ?? "normal";
					const choice = attempt.options?.toolChoice;
					const toolName = attempt.toolRounds?.[0]?.toolName;
					scope.workerTelemetry?.attempt({
						roundKind,
						toolChoice: choice === "auto" || choice === "none" ? choice : toolName ? { name: toolName } : "auto",
						...(attempt.options?.samplingParams?.response_format !== undefined
							? { responseFormat: "json-schema" as const }
							: {}),
						...requestedThinking(effectiveThinkingLevel),
					});
					// Every attempt of a locked round carries the same tail directive, as does the "auto" form of a
					// middleware text lock; the system prompt and earlier messages keep their bytes.
					// The guard projected this history without invalidating the usage Pi anchors on, so the
					// provider-bound copy is re-anchored at the guard's count (A2c).
					const attemptContext = anchorContextAtInputTokens(
						synthesisDirective !== undefined
							? withLockedSynthesisDirective(attempt.context, synthesisDirective.requiredResult)
							: helperTail
								? withRequestTailDirective(attempt.context, helperTail)
								: middlewareChoice.kind === "none" && attempt.options?.toolChoice === "auto"
									? withLockedSynthesisDirective(attempt.context)
									: attempt.context,
						inputTokens,
					);
					const fetchImpl = attempt.options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
					const tracking = trackCallFetch(fetchImpl);
					scope.callTracking = tracking;
					scope.callUsageReported = false;
					roundProviderHttpStatus = null;
					tracking.start(currentModel.api, attempt.options?.transport);
					const lockedRound = phase.toolsLocked || phase.resultForced;
					const attemptOptions = { ...attempt.options, pancodeInputTokens: inputTokens };
					const { reasoning: _reasoning, thinkingBudgets: _thinkingBudgets, ...thinkingOffOptions } = attemptOptions;
					// Responses APIs render the reasoning effort ahead of the whole input, and Pi sends the model's off effort
					// (and no encrypted reasoning) when the level is dropped, so a locked round there keeps the run's level:
					// dropping it made a Codex round miss every cached token and turned thinking off mid-run (FL-16). On copilot-sdk
					// the dropped level became a setModel on the live session, which read none of its cached prefix (M-20).
					const source = boundWorkerResponse(
						currentModel,
						attemptContext,
						lockedRound && !REASONING_PREFIX_APIS.has(currentModel.api) ? thinkingOffOptions : attemptOptions,
						{
							locked: lockedRound,
							responseSeconds:
								input.limits !== undefined
									? input.limits.time.responseMs / 1000
									: workerSettings.safety.limits.workerResponseSeconds,
							round,
							onLimit: (outcomeCode, detail) => {
								phase.seal(detail);
								emit({ type: "pancode_run_outcome", payload: { outcomeCode, detail } });
							},
						},
						(boundedOptions) =>
							engineStreamSimple(currentModel, attemptContext, {
								...boundedOptions,
								fetch: async (url, init) => {
									const response = await tracking.fetch(url, init);
									scope.lastProviderHttpStatus = response.status;
									roundProviderHttpStatus = response.status;
									// Pi retries a retryable status inside one attempt; the response that opens the stream is
									// the first byte (#434).
									if (response.ok) scope.workerTelemetry?.mark("firstByte");
									return response;
								},
								onProviderStreamEvent: async (data, eventModel) => {
									// Wire-field presence distinguishes reported zero from SDK placeholders (#434).
									if (data !== null && typeof data === "object") {
										const frame = data as Record<string, unknown>;
										for (const value of [frame, frame.message, frame.response]) {
											if (value === null || typeof value !== "object") continue;
											const usage = (value as Record<string, unknown>).usage;
											if (usage === null || typeof usage !== "object") continue;
											scope.callUsageReported ||= hasTokenUsageCounts(usage as Record<string, unknown>);
										}
									}
									await boundedOptions?.onProviderStreamEvent?.(data, eventModel);
								},
							}),
					);
					return (
						scope.workerTelemetry?.observe(source, (message) => {
							const aborted = input.signal?.aborted || (message as { stopReason?: unknown } | null)?.stopReason === "aborted";
							const failure = tracking.failure(message, aborted, scope.callUsageReported);
							const harness = aborted
								? (scope.workerStopCause ?? (input.signal?.aborted ? "parent_cancel" : undefined))
								: undefined;
							return harness ? { ...failure, stage: "harness", errorClass: harness } : failure;
						}) ?? source
					);
				},
				input.target.id,
			);
		};
		// A token the server rejects as expired earns one locked refresh and one
		// retry of the same request, as the main turn does; a failed refresh ends
		// the round with the login remedy (#427).
		const admitted = contextGuard.inputTokens + handbackSurfaceTokens;
		const authRetried = retryStreamOnceOnAuthRejection(
			request(messages, admitted),
			(error) => isProviderAuthRejection(error.errorMessage, roundProviderHttpStatus ?? undefined),
			async () => {
				const apiKey = await refreshWorkerOAuthKey();
				if (apiKey === null) return null;
				roundApiKey = apiKey;
				return request(messages, admitted);
			},
		);
		// A server that refuses the contract's schema before answering gets the
		// same round once without it; the prompt and validator still hold the
		// contract, and later rounds stop sending the field.
		const first =
			contractFormat === undefined
				? authRetried
				: retryStreamOnceOnAuthRejection(
						authRetried,
						(error) => isResponseSchemaRejection(error.errorMessage),
						async () => {
							scope.contractResponseFormat = undefined;
							requestOptions = optionsWith(workerResponseFormat);
							return request(messages, admitted);
						},
					);
		// The server is the authority on its own limit. An unreported window, a
		// window that changed since it was resolved, or a server tokenizer that
		// counts above PanCode's estimate all surface as a server overflow. It earns
		// one reversible eviction and one retry; a second overflow is final.
		return retryStreamOnceOnOverflow(first, () => {
			const projected = contextGuard.recover(pressure);
			return projected ? request(projected, contextGuard.inputTokens) : null;
		});
	};
	return streamFn;
}
