// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import { firstChangedSection } from "../core/cache-telemetry.js";
import { semanticUsable } from "../core/config.js";
import { operatorCalendar } from "../core/format-time.js";
import { isHostPolicyMessage } from "../core/host-policy-message.js";
import { providerFallbackDigests } from "../core/provider-checkpoint-handle.js";
import { hostFramedTexts, neutralizeFraming } from "../core/reminder-framing.js";
import { mainSessionShellSandboxed } from "../core/sandbox/main-session.js";
import { isBuiltinToolName, isHarnessExtensionToolName, ToolNames } from "../core/tool-names.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import { memoryCarried, memorySectionBlocks, memorySectionDelta } from "../domains/memory/prompt-section.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { ContextWindowSource } from "../domains/providers/index.js";
import type { LocalModelQuirks } from "../domains/providers/types/local-model-quirks.js";
import { PROMPT_MANIFEST_VERSION } from "../domains/session/prompt-manifest.js";
import { activePath, findLastEntry } from "../domains/session/tree/active-path.js";
import {
	appendEnginePolicyMessage,
	engineInitialSystemPrompt,
	replaceEngineMessages,
	setEngineSystemPrompt,
} from "../engine/agent.js";
import { providerCheckpointCompatibility } from "../engine/ai.js";
import { effectiveYoloConfinement } from "../lib/autonomy/autonomy.js";
import { capabilityArgumentShape, capabilityStarterArgs } from "../tools/gateway/guidance.js";
import { TOOL_PLANES } from "../tools/policy.js";
import { declaredCheckIds } from "../tools/verify/resolve.js";
import { HOST_STATUS_NOTICE_KEY, runtimeSupportsTools, toolNamesFromAgentState } from "./chat-loop-messages.js";
import { contextOperationAwareness } from "./context-operation-awareness.js";
import {
	effectivePosture,
	POSTURE_GENERATION,
	POSTURE_UPDATE,
	postureCheckpoint,
	readPostureGeneration,
} from "./posture-policy.js";
import { attachedToolSchemasFromState, mainPromptCacheIdentity } from "./prompt-cache-identity.js";
import type { TurnContext } from "./turn-context.js";
import { recordedMemorySection } from "./turn-context-memory.js";
import { sha256Json, type TurnContextScope } from "./turn-context-scope.js";
import type { AgentRuntime } from "./turn-state.js";

// #423: five idle minutes warrants a reminder, without claiming a provider cache lifetime.
const CACHE_REUSE_IDLE_NOTICE_MS = 5 * 60 * 1000;

/**
 * Session prompt assembly for one turn context: compiling and pinning the session prompt with its memory section,
 * committing the session posture, and logging the prompt compile.
 */
export function createTurnContextPrompt(
	shared: TurnContextScope,
): Required<
	Pick<
		TurnContext,
		"sessionPromptPending" | "ensureSessionPrompt" | "commitSessionPosture" | "logPromptCompileIfPending"
	>
> {
	const {
		activeEntries,
		bindProviderCompaction,
		deps,
		lastRecordedPromptHash,
		loadCacheCallBaseline,
		noteColdReason,
		resolveProviderReplay,
		sessionWorkingContextPaths,
		state,
	} = shared;

	// Read once per workspace root so the Project section stays byte-stable across turns.
	let declaredChecksFor: { cwd: string; ids: string[] } | undefined;
	let announcedProjectPreloadSession: string | null = null;
	let idleReuseNoticeStamp: string | null = null;
	let recompileReuseNoticeStamp: string | null = null;
	return {
		sessionPromptPending(agentRuntime: AgentRuntime): boolean {
			// The automatic pass's own guard: only history it could shrink makes the prompt it prices matter.
			if (!deps.readSessionEntries || (deps.session && !deps.session.current())) return false;
			return engineInitialSystemPrompt(agentRuntime.agent) !== shared.sessionPrompt?.systemPrompt;
		},
		/**
		 * Ensure the session system prompt is compiled and applied to the live
		 * agent. Compiles only when the canonical live-input identity changes
		 * or a config hot-reload invalidated compiler-owned inputs in the
		 * cache; every other submit reuses the cached prompt byte-for-byte. A
		 * compile whose text differs from the previous prompt queues a
		 * "promptRecompiled" ledger entry (written once the session exists).
		 */
		async ensureSessionPrompt(
			agentRuntime: AgentRuntime,
			beforeSend = false,
			pendingUserText?: string,
			skipProviderFallback = false,
		): Promise<CompiledSessionPrompt | null> {
			const signal = deps.turnSignal?.();
			const originNavigation = shared.navigationEpoch;
			const originSession = deps.session?.current()?.id;
			bindProviderCompaction(agentRuntime);
			const current = (): boolean =>
				!shared.disposed &&
				!signal?.aborted &&
				originNavigation === shared.navigationEpoch &&
				originSession === deps.session?.current()?.id;
			if (!current()) return null;
			// A route switch materializes portable context only when it is first needed (#423).
			const active = activeEntries();
			const checkpoint = findLastEntry(active, (entry) => entry.kind === "compactionSummary");
			if (
				!skipProviderFallback &&
				checkpoint?.kind === "compactionSummary" &&
				checkpoint.providerCheckpoint &&
				!providerFallbackDigests(active).has(checkpoint.providerCheckpoint.digest)
			) {
				const key =
					agentRuntime.runtimeId === "openai-codex"
						? await agentRuntime.agent.getApiKey?.(agentRuntime.agent.state.model.provider)
						: undefined;
				const reason =
					deps.getSettings().context.compaction.provider !== "native"
						? "setting-off"
						: providerCheckpointCompatibility(checkpoint.providerCheckpoint, agentRuntime.agent.state.model, key);
				if (!current()) return null;
				if (reason !== null) {
					await resolveProviderReplay(agentRuntime, reason, pendingUserText, beforeSend);
					if (!current()) return null;
				}
			}
			if (!deps.prompts) return null;
			const settings = deps.getSettings();
			const autonomy = deps.getAutonomy?.() ?? settings.safety.autonomy ?? "default";
			const sessionId = deps.session?.current()?.id ?? "";
			const entries = activeEntries();
			const checkpointId = postureCheckpoint(entries);
			// #423: a posture update is a later system message, which Pi folds into the leading instructions for a
			// model without this compat flag (collapseSystemMessages), so it would rewrite the prefix anyway; such a
			// route recompiles instead. gpt-5.3-codex-spark has no row in Pi's openai-codex catalog and so no flag;
			// measured 2026-10-30, the ChatGPT Codex backend refuses the model outright ("not supported when using
			// Codex with a ChatGPT account"), so nothing vouches for mid-conversation developer items there.
			// The Copilot SDK route delivers the update as a host turn on its live session (copilot/stream.ts), which
			// keeps the session instead of re-seeding the transcript under a recompiled system message.
			const supportsPolicyUpdates =
				deps.prompts.renderSessionPostureUpdate !== undefined &&
				(agentRuntime.agent.state.model?.api === "copilot-sdk" ||
					(agentRuntime.agent.state.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
						?.supportsMidConvoSystemMessages === true);
			const routeKey = sha256Json([
				agentRuntime.targetId,
				agentRuntime.runtimeId,
				agentRuntime.wireModelId,
				attachedToolSchemasFromState(agentRuntime.agent.state.tools),
			]);
			if (
				shared.postureGeneration &&
				(shared.postureGeneration.checkpointId !== checkpointId || shared.postureGeneration.routeKey !== routeKey)
			) {
				shared.postureGeneration = null;
				shared.postureGenerationPersisted = false;
				shared.sessionPromptKey = null;
			}
			if (!supportsPolicyUpdates) {
				shared.postureGeneration = null;
				shared.pendingPosture = null;
				if (agentRuntime.agent.state.messages.some(isHostPolicyMessage))
					replaceEngineMessages(
						agentRuntime.agent,
						agentRuntime.agent.state.messages.filter((message) => !isHostPolicyMessage(message)),
					);
			}
			const recordedGeneration = supportsPolicyUpdates ? readPostureGeneration(entries) : null;
			const restoringGeneration = !shared.postureGeneration && recordedGeneration?.routeKey === routeKey;
			if (restoringGeneration) {
				shared.postureGeneration = recordedGeneration;
				shared.postureGenerationPersisted = true;
				shared.frozenMemorySection = recordedGeneration.memorySection;
				shared.frozenMemorySessionId = sessionId;
			}
			const compiledAutonomy = supportsPolicyUpdates ? (shared.postureGeneration?.compiledAutonomy ?? autonomy) : autonomy;
			const cwd = process.cwd();
			const modelState = agentRuntime.agent.state.model as
				| (typeof agentRuntime.agent.state.model & { pancode?: { quirks?: LocalModelQuirks } })
				| undefined;
			// `Context window: N` is the window the backend will actually serve
			// this session, taken from the resolution the turn already ran rather
			// than from the model descriptor's copy of it (issue #249). The
			// ranking that puts a loaded figure ahead of a probed one lives in
			// `resolveContextWindowDetails`, which tests `loadedContextWindow`
			// first and only then `probedContextWindow`, so `effectiveContextWindow`
			// already is the loaded window whenever one is known and the source
			// already reads "loaded". A resumed process takes it from the live
			// route status, never from an earlier process's snapshot, since that
			// window may no longer be the one served. The source rides into the prompt
			// manifest, so a recompile after the loaded window is first observed
			// is explained by the record.
			const windowDetails = agentRuntime.runtimeResolution.contextWindowDetails;
			const resolvedWindow = windowDetails.effectiveContextWindow;
			const contextWindow = typeof resolvedWindow === "number" && resolvedWindow > 0 ? resolvedWindow : null;
			const contextWindowSource: ContextWindowSource | null =
				contextWindow === null ? null : windowDetails.contextWindowSource;
			const guidance = modelState?.pancode?.quirks?.thinking?.guidance;
			const toolNames = toolNamesFromAgentState(agentRuntime.agent.state.tools);
			// An attached schema in the extension namespace is there only because its manifest promotes it (B2).
			const promotedTools = toolNames.filter((name) => isHarnessExtensionToolName(name));
			const attachedToolSchemas = attachedToolSchemasFromState(agentRuntime.agent.state.tools);
			const builtinTools =
				deps.toolRegistry
					?.listAll()
					.filter((spec) => isBuiltinToolName(spec.name) && spec.metadata?.startupPrompt !== false) ?? [];
			const toolDiscoveryHints = builtinTools
				.flatMap((spec) => {
					const hint = spec.metadata?.discoveryHint;
					if (!hint) return [];
					const starterArgs = capabilityStarterArgs(spec);
					return [{ tool: spec.name, hint, ...(starterArgs ? { starterArgs } : {}) }];
				})
				.sort((a, b) => a.tool.localeCompare(b.tool));
			// Every builtin's registry objective, grouped by plane in the pinned map.
			// The compiler filters it to what this surface reaches.
			const capabilityMap = builtinTools.flatMap((spec) => {
				const plane = isBuiltinToolName(spec.name) ? TOOL_PLANES[spec.name]?.plane : undefined;
				return plane === undefined
					? []
					: [
							{
								tool: spec.name,
								objective: spec.metadata?.objective ?? "",
								plane,
								argumentShape: capabilityArgumentShape(spec, 1),
							},
						];
			});
			if (declaredChecksFor?.cwd !== cwd) declaredChecksFor = { cwd, ids: declaredCheckIds(cwd) };
			const declaredChecks = declaredChecksFor.ids;
			// Only the bound session ceiling shapes compiled guidance; prompt and
			// template scope arrives in the current turn reminder (#423).
			const standingConstraints = deps.standingTurnConstraints?.();
			const routeIdentity = JSON.stringify([agentRuntime.targetId, agentRuntime.runtimeId, agentRuntime.wireModelId]);
			if (
				shared.frozenRouteIdentity !== routeIdentity ||
				(shared.frozenMemorySessionId !== "" && shared.frozenMemorySessionId !== sessionId)
			) {
				shared.frozenRouteSources = undefined;
			}
			// A thinking-only override must not rewrite the cached Routes line (#423).
			shared.frozenRouteSources ??= deps.getRouteSources?.();
			shared.frozenRouteIdentity = routeIdentity;
			// A turn that crosses midnight recompiles here on its next submit (WTF-P 0.8.3 A4).
			const calendar = operatorCalendar();
			const sessionInputs: SessionPromptInputs = {
				...(standingConstraints ? { turnConstraints: standingConstraints } : {}),
				...(deps.getReadySkillCount ? { readySkillCount: deps.getReadySkillCount() } : {}),
				demo: deps.interactiveGuidance === true && settings.interface.demo,
				...(deps.interactiveGuidance === true ? { terminal: true } : {}),
				provider: agentRuntime.targetId,
				// Only the Copilot runtime is carried, so every other session keeps its prompt key.
				...(agentRuntime.runtimeId === "copilot-sdk" ? { runtime: agentRuntime.runtimeId } : {}),
				model: agentRuntime.wireModelId,
				...(shared.frozenRouteSources ? { routeSources: shared.frozenRouteSources } : {}),
				contextWindow,
				localDate: { date: calendar.date, weekday: calendar.weekday, zone: calendar.zone },
				providerSupportsTools: runtimeSupportsTools(agentRuntime),
				semanticSearchAvailable: semanticUsable(settings.context.semantic),
				toolNames,
				...(promotedTools.length > 0 ? { promotedTools } : {}),
				// Builtin presence gates prompt guidance. Learning an MCP schema
				// mid-turn changes discovery results, not the immutable prefix.
				coordinatorCapabilities: builtinTools.map((spec) => spec.name).sort(),
				...(toolDiscoveryHints.length > 0 ? { toolDiscoveryHints } : {}),
				...(capabilityMap.length > 0 ? { capabilityMap } : {}),
				...(declaredChecks.length > 0 ? { declaredChecks } : {}),
				...(deps.getSettings().prompts?.profile === "v2" ? { promptProfile: "v2" as const } : {}),
				...(guidance ? { thinkingGuidance: guidance } : {}),
				...(deps.toolRegistry?.get(ToolNames.ConfigurePancode) ? { canConfigurePancode: true } : {}),
				...(deps.headless === true ? { headless: true } : {}),
				// Only the opt-out is carried, so a contained session keeps its prompt key.
				...(effectiveYoloConfinement(settings.safety) === "unconfined" ? { yoloConfinement: "unconfined" as const } : {}),
				...(deps.liveSteering === false ? { liveSteering: false } : {}),
				...(deps.interactiveGuidance === true || deps.operatorInterviews === true ? { operatorInterviews: true } : {}),
				// Only the sandboxed case is carried, so a host without a backend keeps its prompt key.
				...(deps.sandboxAvailability &&
				mainSessionShellSandboxed(
					compiledAutonomy,
					effectiveYoloConfinement(settings.safety),
					settings.safety.sandbox,
					deps.sandboxAvailability(),
				)
					? { sandbox: true }
					: {}),
			};
			const memoryOn = deps.memoryEnabled?.() !== false;
			if (!memoryOn) shared.frozenMemorySection = null;
			if (deps.getMemorySection && memoryOn) {
				try {
					if (shared.memoryTurn !== null && shared.memoryTurn.sessionId !== (sessionId || null)) {
						shared.memoryAuthorityEpoch += 1;
						shared.memoryTurn = null;
					}
					const memoryRequest: MemoryPromptRequest = {
						turnId: shared.memoryTurn?.id ?? null,
						sessionAuthority: shared.memoryTurn?.sessionAuthority ?? JSON.stringify([shared.memoryAuthorityEpoch, sessionId]),
						cwd,
						targetId: agentRuntime.targetId,
						runtimeId: agentRuntime.runtimeId,
						modelId: agentRuntime.wireModelId,
						taskText: shared.memoryTurn?.taskText ?? "",
						activePaths: shared.memoryTurn?.activePaths ?? [],
					};
					const memorySection = deps.getMemorySection(memoryRequest);
					if (memorySection.length > 0) sessionInputs.memorySection = memorySection;
				} catch (err) {
					deps.emitNotice(
						`[PanCode] memory load failed; continuing without memory injection: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			// Operator context-operation facts are turn reminder text, not prompt input, so a failed recall keeps the cached prefix.
			const contextOperationUpdate = contextOperationAwareness(deps.readSessionEntries?.() ?? [], sessionId, cwd);
			// #423: the memory section this session's prompt was compiled with stays
			// put. A record approved later reaches the model as a reminder on the
			// next turn; recompiling for it re-billed the whole conversation.
			const liveMemorySection = sessionInputs.memorySection ?? "";
			// A first compile runs before its session exists; the session created
			// next inherits that freeze, any other session starts its own.
			if (shared.frozenMemorySessionId === "") shared.frozenMemorySessionId = sessionId;
			else if (shared.frozenMemorySessionId !== sessionId) shared.frozenMemorySection = null;
			// bt-10: a resumed process (run --session, ACP session/load, /resume) has no freeze of its own; it takes the
			// section the session's prompt was last compiled with, so the resumed prompt is byte-identical and a record
			// approved since rides the reminder as it would have in the original process.
			if (
				memoryOn &&
				shared.frozenMemorySection === null &&
				sessionId !== "" &&
				shared.memoryRestoredSessionId !== sessionId
			) {
				shared.memoryRestoredSessionId = sessionId;
				shared.frozenMemorySection = recordedMemorySection(entries);
			}
			const frozenMemory = shared.frozenMemorySection ?? liveMemorySection;
			const withMemory = (section: string): SessionPromptInputs => {
				const inputs = { ...sessionInputs };
				delete inputs.memorySection;
				return section.length > 0 ? { ...inputs, memorySection: section } : inputs;
			};
			const prompts = deps.prompts;
			const promptInputEpoch = prompts.inputEpoch();
			const promptKey = (inputs: SessionPromptInputs): string =>
				mainPromptCacheIdentity({
					targetId: agentRuntime.targetId,
					runtimeId: agentRuntime.runtimeId,
					wireModelId: agentRuntime.wireModelId,
					autonomy: compiledAutonomy,
					sessionId,
					cwd,
					workingContextPaths: [...sessionWorkingContextPaths],
					contextWindowSource,
					promptInputEpoch,
					sessionInputs: inputs,
					attachedToolSchemas,
				});
			// S-85: per-session facts ride in the first user message, not the system
			// prompt; they go again only once no message in context carries them,
			// as after a compaction that summarized the first turn away.
			const undelivered = (block: string): string => {
				if (block.length === 0) return "";
				const framedBlock = neutralizeFraming(block);
				return hostFramedTexts(agentRuntime.agent.state.messages).some((text) => text.includes(framedBlock)) ? "" : block;
			};
			// bt-10: a rule a referenced file activates rides the tail once, like the session facts above.
			const scopedRulesDelta = (compiled: CompiledSessionPrompt | null): string => {
				const bodies = (compiled?.scopedRules ?? []).filter((body) => undelivered(body).length > 0);
				return bodies.length === 0 ? "" : ["# Project rules for files in working context", ...bodies].join("\n\n");
			};
			const promptDelta = (compiled: CompiledSessionPrompt | null, memory: string): string =>
				[
					undelivered(compiled?.sessionContext ?? ""),
					scopedRulesDelta(compiled),
					undelivered(contextOperationUpdate),
					memoryDelta(memory),
				]
					.filter((part) => part.length > 0)
					.join("\n\n");
			const memoryDelta = (compiled: string): string => {
				if (!memoryOn) return "";
				const framed = hostFramedTexts(agentRuntime.agent.state.messages);
				const ids = [
					...new Set(
						[compiled, ...framed.filter((text) => text.includes("# Memory update"))].flatMap((section) =>
							memorySectionBlocks(section).map((block) => block.id),
						),
					),
				];
				// Live records are asked about too: one no operator stands behind waits for the next session (DESIGN 4.4).
				const liveIds = memorySectionBlocks(liveMemorySection)
					.map((block) => block.id)
					.filter((id) => !ids.includes(id));
				const asked = [...ids, ...liveIds];
				const statuses = asked.length > 0 ? deps.getMemoryRecordStatuses?.(asked) : undefined;
				const delta = memorySectionDelta(compiled, liveMemorySection, framed, statuses);
				// Only here is the frozen section known, so a record it already carries
				// is never repeated. A prewarm compile has no turn to answer.
				const lessons =
					beforeSend && shared.memoryTurn !== null
						? deps.memoryCommitBridge?.offerLessonsForTask(
								shared.memoryTurn.taskText,
								// The update this turn adds counts as carried: a reminder never repeats it on its first turn.
								memoryCarried(compiled, framed, delta),
							)
						: "";
				return [delta, lessons ?? ""].filter((part) => part.length > 0).join("\n");
			};
			const frozenInputs = withMemory(frozenMemory);
			const key = promptKey(frozenInputs);
			// #423: compare the already-resolved key before compiling; this query makes no provider call.
			// A new session's first compile keys on an empty session id, so its
			// second turn changes key with identical bytes; the recompile reason
			// waits for the compile to show whether the prompt moved.
			let noteCacheReuse: ((recompiled: boolean) => void) | undefined;
			if (beforeSend) {
				loadCacheCallBaseline();
				if (shared.cacheCallBaseline) {
					const { endedAt, inclusiveInputTokens } = shared.cacheCallBaseline;
					const elapsedMs = Math.max(0, Date.now() - endedAt);
					const idleStamp = JSON.stringify([shared.navigationEpoch, sessionId, endedAt]);
					const recompileStamp = JSON.stringify([shared.navigationEpoch, sessionId, endedAt, key]);
					const idle = elapsedMs >= CACHE_REUSE_IDLE_NOTICE_MS && idleReuseNoticeStamp !== idleStamp;
					// #423: a resumed process has no prior key to compare; unknown is not changed.
					const pendingRecompile =
						shared.sessionPromptKey !== null &&
						shared.sessionPromptKey !== key &&
						recompileReuseNoticeStamp !== recompileStamp;
					if (idle || pendingRecompile) {
						noteCacheReuse = (recompiled) => {
							const recompile = pendingRecompile && recompiled;
							if (!idle && !recompile) return;
							if (idle) idleReuseNoticeStamp = idleStamp;
							if (recompile) recompileReuseNoticeStamp = recompileStamp;
							const elapsed = elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s` : `${Math.floor(elapsedMs / 60_000)}m`;
							const reason = [idle ? `${elapsed} idle` : "", recompile ? "a prompt change" : ""].filter(Boolean).join(" and ");
							const text = `next reply may be slower: about ${inclusiveInputTokens.toLocaleString("en-US")} prompt tokens may be read again after ${reason}`;
							if (deps.emitCacheReuseNotice) deps.emitCacheReuseNotice(text);
							else deps.emitNotice(text);
						};
					}
				}
			}
			const preparePosture = (): void => {
				shared.pendingPosture =
					supportsPolicyUpdates && shared.postureGeneration
						? {
								inputs: sessionInputs,
								effectiveAutonomy: effectivePosture(entries, shared.postureGeneration),
								rendered: new Map(),
							}
						: null;
			};
			if (shared.sessionPrompt && !shared.sessionPromptInvalidated && shared.sessionPromptKey === key) {
				shared.lastSystemPromptReused = true;
				shared.sessionPromptDelta = promptDelta(shared.sessionPrompt, frozenMemory);
				preparePosture();
				noteCacheReuse?.(false);
				return shared.sessionPrompt;
			}
			try {
				const sessionStartedAt = deps.session?.current()?.createdAt;
				const compileWith = (inputs: SessionPromptInputs) =>
					prompts.compileSessionPrompt({
						sessionId,
						sessionInputs: inputs,
						autonomy: compiledAutonomy,
						cwd,
						workingContextPaths: [...sessionWorkingContextPaths],
						...(sessionStartedAt ? { sessionStartedAt } : {}),
					});
				let result = await compileWith(frozenInputs);
				let compiledKey = promptKey(frozenInputs);
				let compiledMemory = frozenMemory;
				// M-21: in a session a pending compile was never recorded nor sent, since a submit logs it before its request,
				// as when a resume prices its budget before the turn restores its thinking level and window; this one follows
				// the prompt that pending compile followed, the recorded one. A sessionless loop never logs, so it chains on.
				const previousHash =
					shared.pendingPromptLogEntry && deps.session?.current()
						? (shared.pendingPromptLogEntry.previousHash ?? lastRecordedPromptHash())
						: (shared.postureGeneration?.promptHash ?? shared.sessionPromptHash ?? lastRecordedPromptHash());
				// A prompt that changes for another reason is cold already, so it
				// takes the live memory instead of carrying a reminder for it.
				if (previousHash !== null && result.systemPromptHash !== previousHash && frozenMemory !== liveMemorySection) {
					if (!current()) return null;
					const liveInputs = withMemory(liveMemorySection);
					result = await compileWith(liveInputs);
					compiledKey = promptKey(liveInputs);
					compiledMemory = liveMemorySection;
				}
				if (!current()) return null;
				const compiledAt = new Date().toISOString();
				const changed = engineInitialSystemPrompt(agentRuntime.agent) !== result.systemPrompt;
				noteCacheReuse?.(changed);
				if (
					supportsPolicyUpdates &&
					(!shared.postureGeneration || result.systemPromptHash !== shared.postureGeneration.promptHash)
				) {
					shared.postureGeneration = {
						version: 1,
						origin: "host",
						id: randomUUID(),
						checkpointId,
						routeKey,
						compiledAutonomy,
						memorySection: compiledMemory,
						promptHash: result.systemPromptHash,
					};
					shared.postureGenerationPersisted = false;
					replaceEngineMessages(
						agentRuntime.agent,
						agentRuntime.agent.state.messages.filter((message) => !isHostPolicyMessage(message)),
					);
				}
				setEngineSystemPrompt(agentRuntime.agent, result.systemPrompt, result.pinnedPrefix);
				if (changed) {
					shared.pendingPromptLogMemory = memoryOn ? compiledMemory : null;
					shared.pendingPromptLogEntry = shared.latestPromptCompile = {
						version: PROMPT_MANIFEST_VERSION,
						at: compiledAt,
						previousHash,
						systemPromptHash: result.systemPromptHash,
						tokenEstimate: result.tokenEstimate,
						thinkingLevel: agentRuntime.agent.state.thinkingLevel ?? null,
						contextWindow,
						contextWindowSource,
						projectPreload: result.projectPreload ?? null,
						sections: result.sections.map((s) => ({
							id: s.id,
							tokenEstimate: s.tokenEstimate,
							...(s.contentHash === undefined ? {} : { contentHash: s.contentHash }),
						})),
						fragments: result.fragmentManifest.map((f) => ({
							id: f.id,
							relPath: f.relPath,
							contentHash: f.contentHash,
							dynamic: f.dynamic,
						})),
					};
				}
				shared.lastSystemPromptReused = !changed;
				const preload = result.projectPreload;
				if (preload?.mode === "partial" && !deps.headless && !deps.interactiveGuidance) {
					// A provisional first compile belongs to the id created after it.
					if (announcedProjectPreloadSession === "" && sessionId) announcedProjectPreloadSession = sessionId;
					if (announcedProjectPreloadSession !== sessionId) {
						announcedProjectPreloadSession = sessionId;
						deps.emitNotice(`Project instructions: ${preload.label}`, "info", HOST_STATUS_NOTICE_KEY);
					}
				}

				shared.sessionPrompt = result;
				shared.sessionPromptHash = result.systemPromptHash;
				shared.sessionPromptKey = compiledKey;
				shared.sessionPromptInvalidated = false;
				// Back on, the section selects afresh instead of holding the empty one compiled while off.
				shared.frozenMemorySection = memoryOn ? compiledMemory : null;
				shared.frozenMemorySessionId = sessionId;
				shared.sessionPromptDelta = promptDelta(result, compiledMemory);
				preparePosture();
				return result;
			} catch (err) {
				if (!current()) return null;
				// The engine keeps the prompt it already had.
				noteCacheReuse?.(false);
				deps.emitNotice(
					`[PanCode] prompt compile failed; using fallback identity: ${err instanceof Error ? err.message : String(err)}`,
				);
				return null;
			}
		},
		commitSessionPosture(agentRuntime, userTurnId): void {
			const pending = shared.pendingPosture;
			shared.pendingPosture = null;
			if (!pending || !shared.postureGeneration || !deps.session?.current() || !deps.prompts?.renderSessionPostureUpdate)
				return;
			const autonomy = deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy ?? "default";
			const entries = activePath(deps.readSessionEntries?.() ?? [], userTurnId);
			if (effectivePosture(entries, shared.postureGeneration) === autonomy) return;
			const text = deps.prompts.renderSessionPostureUpdate(autonomy, pending.inputs);
			const entry = deps.session.appendEntry({
				kind: "custom",
				customType: POSTURE_UPDATE,
				parentTurnId: userTurnId,
				data: { version: 1, origin: "host", generationId: shared.postureGeneration.id, userTurnId, autonomy, text },
			});
			deps.session.flushAppends?.();
			appendEnginePolicyMessage(agentRuntime.agent, entry.turnId, text, Date.parse(entry.timestamp));
		},
		/**
		 * Write the queued prompt-compile ledger entry and its full manifest
		 * record. The journal captures the structure when the request cites it (#434).
		 * Deferred until after the user turn is appended so the session exists.
		 */
		logPromptCompileIfPending(): void {
			const currentMeta = deps.session?.current();
			if (currentMeta && shared.postureGeneration && !shared.postureGenerationPersisted) {
				deps.session?.appendEntry({
					kind: "custom",
					customType: POSTURE_GENERATION,
					parentTurnId: state.lastTurnId,
					data: shared.postureGeneration,
				});
				deps.session?.flushAppends?.();
				shared.postureGenerationPersisted = true;
			}
			if (!shared.pendingPromptLogEntry || !currentMeta) return;
			const entry = shared.pendingPromptLogEntry;
			shared.pendingPromptLogEntry = null;
			try {
				deps.session?.appendEntry({
					kind: "custom",
					customType: "promptRecompiled",
					parentTurnId: state.lastTurnId,
					data: {
						previousHash: entry.previousHash,
						hash: entry.systemPromptHash,
						tokenEstimate: entry.tokenEstimate,
						...(shared.pendingPromptLogMemory === null ? {} : { memorySection: shared.pendingPromptLogMemory }),
					},
				});
				// A resumed process names the session's last recorded hash as previousHash (#249), so
				// the stamp requires the hash to have moved, not merely to have a predecessor.
				if (entry.previousHash !== null && entry.previousHash !== entry.systemPromptHash) {
					noteColdReason("prompt_recompiled");
					if (shared.previousPromptSections) {
						shared.nextChangedSection ??= firstChangedSection(shared.previousPromptSections, entry.sections);
					}
				}
			} catch {
				// Ledger logging is diagnostics, not control flow; never abort a turn.
			}
			shared.previousPromptSections = entry.sections;
		},
	};
}
