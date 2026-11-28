// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { CacheCallBaseline } from "../core/cache-telemetry.js";
import type { PancodeSettings } from "../core/config.js";
import { sha256Hex } from "../core/hash.js";
import type { LiveBudgetInput, LiveBudgetProducer, LiveBudgetView } from "../domains/context/budget/live-view.js";
import type { ClassifyCall } from "../domains/context/working-set/superseded.js";
import type { CompactResult } from "../domains/memory/compaction/compact.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../domains/prompts/compiler.js";
import type { AutoCompactionTrigger, ContextCompactionVerdict } from "../domains/session/compaction/auto.js";
import type { CaptureContextSnapshotInput, ContextSnapshot } from "../domains/session/context-accounting.js";
import type { EvictionAnchor, SessionEntry } from "../domains/session/entries.js";
import type { SessionPromptCompileRecord } from "../domains/session/prompt-manifest.js";
import type { AgentMessage } from "../engine/types.js";
import type { MessageListDigests } from "./message-list-digest.js";
import type { PostureGeneration } from "./posture-policy.js";
import type {
	CompactionRouteView,
	ExpectedColdReason,
	LiveContextEstimate,
	TurnContext,
	TurnContextDeps,
} from "./turn-context.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { AgentRuntime, TurnContextState } from "./turn-state.js";

export const sha256Json = (value: unknown): string => sha256Hex(JSON.stringify(value));

/** What the turn context's compaction, memory and prompt modules read and write of its closure. */
export interface TurnContextScope {
	readonly deps: TurnContextDeps;
	readonly state: TurnContextState;
	readonly middleware: TurnMiddleware;
	readonly activeEntries: () => readonly SessionEntry[];
	readonly compactionTrigger: AutoCompactionTrigger<CompactResult | null>;
	readonly observeHistory: (agentRuntime: AgentRuntime) => MessageListDigests;
	readonly sessionWorkingContextPaths: Set<string>;
	readonly memoryOrigin: (runtime: AgentRuntime) => string;
	readonly classifyCall: ClassifyCall;
	readonly budgetProducer: LiveBudgetProducer;
	readonly loadCacheCallBaseline: () => void;
	readonly resetCacheCallBaseline: () => void;
	readonly noteColdReason: (reason: ExpectedColdReason) => void;
	readonly persistContextSnapshot: (snapshot: ContextSnapshot) => void;
	readonly captureRuntimeContextSnapshot: (
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra?: Partial<CaptureContextSnapshotInput>,
	) => ContextSnapshot;
	readonly lastRecordedPromptHash: () => string | null;
	readonly reconciledHistoryTokens: (
		agentRuntime: AgentRuntime,
		history?: MessageListDigests,
		commit?: boolean,
	) => number | null;
	readonly summaryOnChatRoute: (
		agentRuntime: CompactionRouteView,
		compactionModel: string | null | undefined,
	) => boolean;
	readonly routeCompaction: (
		agentRuntime: CompactionRouteView,
		settings: Readonly<PancodeSettings>,
	) => {
		economic: {
			ceilingTokens: number;
			threshold: number;
			fractionScale: number;
			budgetWindow: number;
			triggerWindow: number;
		};
		triggerReserve: (tokens: number) => number;
		triggerFraction: (tokens: number) => number;
		shouldCompact: (tokens: number) => ContextCompactionVerdict;
		triggerTokens: (tokens: number) => number;
	};
	readonly liveContextEstimate: (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		replayMessages?: ReadonlyArray<AgentMessage>,
		history?: MessageListDigests,
	) => LiveContextEstimate;
	readonly overflowFitTokens: (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		floor?: number,
		history?: MessageListDigests,
	) => number;
	readonly pinOverflowFit: (agentRuntime: AgentRuntime, pendingUserText?: string) => boolean;
	readonly liveBudgetInput: (
		pendingUserText?: string,
		capturedHistory?: MessageListDigests,
		estimate?: LiveContextEstimate,
	) => LiveBudgetInput;
	readonly refreshLiveBudget: (
		pendingUserText?: string,
		history?: MessageListDigests,
		estimate?: LiveContextEstimate,
	) => LiveBudgetView;
	readonly evictionAnchor: (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	) => EvictionAnchor | undefined;
	readonly carryReconciledAnchorThroughProjection: (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	) => void;
	readonly bindProviderCompaction: (runtime: AgentRuntime) => void;
	readonly syncCodexConfiguration: (runtime: AgentRuntime) => void;
	compactionController: AbortController | null;
	disposed: boolean;
	currentContextSnapshot: ContextSnapshot | null;
	overflowInputPin: { sessionId: string | undefined } | null;
	reconciledAnchor: {
		tokens: number;
		anchoredMessages: ReadonlyArray<AgentMessage>;
		/**
		 * Content identity of `anchoredMessages` when the attestation was taken.
		 * Object identity alone cannot detect an in-place edit: rewriting a
		 * message's text with a different string of the same length leaves the
		 * reference, the length, and therefore every chars/4 figure unchanged,
		 * while the provider counted different tokens. Without this the anchor
		 * would keep lending its authority to a prefix the provider never saw.
		 */
		contentDigest: string;
		runtime: AgentRuntime;
		model: AgentRuntime["agent"]["state"]["model"];
		modelKey: string;
		targetId: string;
		runtimeId: string;
		wireModelId: string;
		systemPromptTokens: number;
		toolSchemaTokens: number;
		/** A provider count of this prefix, not a figure carried through an eviction or rehydrated from its record. */
		measured: boolean;
	} | null;
	lastCompactionNoGain: boolean;
	lastCompactionEvent: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null;
	lastSystemPromptReused: boolean;
	sessionPrompt: CompiledSessionPrompt | null;
	sessionPromptKey: string | null;
	sessionPromptInvalidated: boolean;
	postureGeneration: PostureGeneration | null;
	postureGenerationPersisted: boolean;
	pendingPosture: { inputs: SessionPromptInputs; effectiveAutonomy: string; rendered: Map<string, string> } | null;
	frozenMemorySection: string | null;
	frozenRouteSources: SessionPromptInputs["routeSources"];
	frozenRouteIdentity: string;
	frozenMemorySessionId: string;
	memoryRestoredSessionId: string | null;
	sessionPromptDelta: string;
	sessionPromptHash: string | null;
	memoryAuthorityEpoch: number;
	memoryTurn: {
		id: string;
		sessionId: string | null;
		sessionAuthority: string;
		origin: string;
		taskText: string;
		activePaths: readonly string[];
	} | null;
	pendingPromptLogEntry: SessionPromptCompileRecord | null;
	pendingPromptLogMemory: string | null;
	latestPromptCompile: SessionPromptCompileRecord | null;
	emptyAutoCompactContextKey: string | null;
	autoCompactFailures: number;
	summaryRearm: { tokensAfter: number; band: number } | null;
	summaryRearmSeededFor: string | null;
	noGainSummaryDigest: string | null;
	branchAnchorTurnId: string | null;
	navigationEpoch: number;
	noUsefulCutBasisKey: string | null;
	cacheCallBaseline: CacheCallBaseline | null;
	nextChangedSection: string | undefined;
	previousPromptSections: SessionPromptCompileRecord["sections"] | null;
	pendingUserImages: ReadonlyArray<unknown>;
	reductionPendingText: string | undefined;
	lastCompactionCardSettled: boolean;
	readonly notifyMemoryCommit: TurnContext["notifyMemoryCommit"];
	readonly resolveProviderReplay: (
		runtime: AgentRuntime,
		reason: string,
		pendingUserText?: string,
		pendingIsOperator?: boolean,
	) => Promise<void>;
	readonly controller: TurnContext;
}
