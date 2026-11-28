// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { CacheCallBaseline } from "../../core/cache-telemetry.js";
import type { PancodeSettings } from "../../core/config.js";
import { sha256Hex } from "../../core/hash.js";
import type { LiveBudgetInput, LiveBudgetProducer, LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ClassifyCall } from "../../domains/context/working-set/superseded.js";
import type { CompactResult } from "../../domains/memory/compaction/compact.js";
import type { CompiledSessionPrompt, SessionPromptInputs } from "../../domains/prompts/compiler.js";
import type { ContextWindowDetails, ContextWindowSource } from "../../domains/providers/index.js";
import type { AutoCompactionTrigger, ContextCompactionVerdict } from "../../domains/session/compaction/auto.js";
import type { CaptureContextSnapshotInput, ContextSnapshot } from "../../domains/session/context-accounting.js";
import type { PrewarmStats, PromptCacheStats } from "../../domains/session/context-ledger.js";
import type { EvictionAnchor, SessionEntry } from "../../domains/session/entries.js";
import type { SessionPromptCompileRecord } from "../../domains/session/prompt-manifest.js";
import type { AgentMessage } from "../../engine/types.js";
import type { createContextFold } from "../context-fold.js";
import type { MessageListDigests } from "../message-list-digest.js";
import type { PostureGeneration } from "../posture-policy.js";
import type {
	CompactionRouteView,
	ExpectedColdReason,
	LiveContextEstimate,
	TurnContext,
	TurnContextDeps,
} from "../turn-context.js";
import type { TurnMiddleware } from "../turn-middleware.js";
import type { AgentRuntime, TurnContextState } from "../turn-state.js";
import type { BoundBatchOutcome } from "./fit.js";

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
	readonly contextFold: ReturnType<typeof createContextFold>;
	readonly bindMemoryScope: () => {
		sessionId: string;
		branchAnchorTurnId: TurnContextScope["branchAnchorTurnId"];
	} | null;
	readonly unsubscribeColdReasonSources: ReadonlyArray<(() => void) | null>;
	readonly refreshAgentMessagesFromSession: TurnContext["refreshAgentMessagesFromSession"];
	readonly runAutoCompact: TurnContext["runAutoCompact"];
	readonly anchoredInputTokens: (agentRuntime: AgentRuntime, history?: MessageListDigests) => number | null;
	readonly overflowStop: (agentRuntime: AgentRuntime) => string | null;
	readonly boundBatchToFit: (agentRuntime: AgentRuntime) => BoundBatchOutcome;
	readonly liveStreamingOutputTokens: () => number;
	readonly routeSuperseded: (targetId: string | null | undefined, modelId: string | null | undefined) => boolean;
	readonly previewCompactionRoute: (
		window: number,
		settings: Readonly<PancodeSettings>,
	) => ReturnType<TurnContextScope["routeCompaction"]> | null;
	readonly windowWithoutRuntime: () => {
		contextWindow: number;
		contextWindowSource: ContextWindowSource | null;
		contextWindowSlots: ContextWindowDetails["contextWindowSlots"];
	};
	readonly overflowPinArmed: () => boolean;
	readonly pendingUserInputTokens: () => number;
	readonly pendingPolicyText: () => string | null;
	readonly routeTokenRatio: (agentRuntime: AgentRuntime, observed?: MessageListDigests) => number;
	readonly measuredAnchor: (
		agentRuntime: AgentRuntime,
		observed: MessageListDigests,
	) => { tokens: number; covered: number; systemPromptTokens: number; toolSchemaTokens: number } | null;
	readonly pendingColdReasons: Set<ExpectedColdReason>;
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
	promptDigest: { prompt: string | null; digest: string } | null;
	// Armed by an overflow fold that fit; the next main request pins the A4 count.
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
	/**
	 * The route's measured tokens per chars/4 token (CTX-1): a provider count over the chars/4 figure of the same
	 * request, held per route so a compaction or an eviction that drops the anchor does not drop the calibration.
	 */
	routeCalibration: { key: string; ratio: number } | null;
	lastCompactionEvent: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null;
	// Last settled run's provider cache usage plus whether the compiled system
	// prompt was reused. Shown together in /context so "prompt reused" can
	// never imply provider cache reuse the backend did not report.
	lastPromptCache: PromptCacheStats | null;
	lastSystemPromptReused: boolean;
	// The last pre-warm, shown by /context until the next settled run answers the
	// question it was asked about: did the prefix the next turn needs get there
	// before the operator did.
	lastPrewarm: PrewarmStats | null;
	// The session system prompt, compiled once per session. Recompiles happen
	// only when the canonical identity of every live compile input changes, or
	// a config hot-reload invalidates compiler-owned inputs. A
	// recompile that changes the prompt text appends a "promptRecompiled"
	// ledger entry so a cold provider cache is always explainable.
	sessionPrompt: CompiledSessionPrompt | null;
	sessionPromptKey: string | null;
	sessionPromptInvalidated: boolean;
	postureGeneration: PostureGeneration | null;
	postureGenerationPersisted: boolean;
	pendingPosture: { inputs: SessionPromptInputs; effectiveAutonomy: string; rendered: Map<string, string> } | null;
	// #423: the memory section compiled into the live prompt (null until the
	// first compile, a session switch, or a completed compaction), and the
	// reminder text carrying what the live section added since.
	frozenMemorySection: string | null;
	frozenRouteSources: SessionPromptInputs["routeSources"];
	frozenRouteIdentity: string;
	thinkingUsesConfigurationUpdate: boolean;
	frozenMemorySessionId: string;
	// bt-10: the session whose recorded memory section this process already looked up, once per session.
	memoryRestoredSessionId: string | null;
	sessionPromptDelta: string;
	// The hash this process compiled *for the session that is current now*, and
	// the manifest's `previousHash` whenever it is set. It is not read off
	// `sessionPrompt`: an in-process `/resume` leaves that compile in place so
	// the ledger keeps its project-preload labels until the next compile, but
	// manifest provenance follows the session, so a switch drops the hash here
	// and the next compile falls through to the incoming session's own manifest
	// exactly as a cold-start resume does (#249).
	sessionPromptHash: string | null;
	// Whether this process has already looked up the resumed session's last
	// recorded prompt hash. The lookup reads the manifest file, so it happens
	// once, on the first compile, and never on the reuse path.
	resumedPromptHashRead: boolean;
	resumedPromptHash: string | null;
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
	// The memory section that compile froze, recorded beside it so a resumed process compiles the same bytes (bt-10).
	pendingPromptLogMemory: string | null;
	latestPromptCompile: SessionPromptCompileRecord | null;
	// Reuse an empty automatic attempt only for identical ledger and provider
	// context. Same-turn tool growth or same-length content replacement must
	// get a fresh cut; ordinary below-threshold checks never fingerprint it.
	emptyAutoCompactContextKey: string | null;
	// A summarizer that fails deterministically (a summary request too large for
	// the window, a broken route) would otherwise be called again after every
	// tool batch, because each batch changes the attempt key. Count consecutive
	// automatic failures and pause the automatic path at the limit until a
	// compaction succeeds or the session changes. /compact and overflow recovery
	// are forced and still run.
	autoCompactFailures: number;
	summaryRouteMemo: { key: string; onChatRoute: boolean } | null;
	// After a committed summary, automatic summaries wait until the context grows past what it left by a band, so a
	// floor near the threshold does not pay one summary per tool batch for a few hundred tokens. Forced runs ignore it.
	summaryRearm: { tokensAfter: number; band: number } | null;
	// A fresh process (each headless `run` turn) seeds the band once per session from the ledger's latest checkpoint,
	// or every turn re-paid a summary a few hundred tokens past the last one (bt-18).
	summaryRearmSeededFor: string | null;
	// The summarizer request of the last automatic attempt whose checkpoint
	// would not reduce context. The attempt key above changes with every tool
	// batch, while a cut held behind a protected turn sends the same request
	// each time, so without this every request above the threshold paid one
	// summary call that was discarded (#422). Forced runs neither read nor set it.
	noGainSummaryDigest: string | null;
	branchAnchorTurnId: string | null;
	navigationEpoch: number;
	// Reduction-basis key of the last automatic attempt that produced nothing.
	// It is the post-accounting identity, so a recalibrated anchor or a
	// different resolved output cap clears the refusal even when the
	// conversation, the route, and the configuration are byte-identical. The
	// pressure policy reuses a refusal only for this exact key.
	noUsefulCutBasisKey: string | null;
	/** Set by `resetForSession`: the re-entered session and its last persisted measurement, until the journal reads it. */
	resumedBudget: { sessionId: string; priorTokens: number | null } | null;
	runExpectedColdReasons: ExpectedColdReason[];
	nextAssistantColdReasons: ExpectedColdReason[];
	// The journal stamps each disturbance on the first request sent after it, hidden retries included, while the
	// ledger above stamps the first persisted reply; the two lists are consumed independently (#434).
	callColdReasons: ExpectedColdReason[];
	cacheGeneration: number;
	cacheCallBaseline: CacheCallBaseline | null;
	cacheCallBaselineLoaded: boolean;
	cacheRequestToolChoice: string;
	// The tool choice of the last request on its target and wire model, and of the one before it, which a #426 retry
	// compares with because the provider rejected the request between them (#434).
	sentToolChoice: { route: string; toolChoice: string } | undefined;
	priorSentToolChoice: { route: string; toolChoice: string } | undefined;
	// The same pair for the leading system prompt's hash; a resumed process starts from the ledger's last call (bt-10).
	cacheRequestSystemPromptHash: string | undefined;
	sentSystemPrompt: { route: string; hash: string } | undefined;
	priorSentSystemPrompt: { route: string; hash: string } | undefined;
	nextChangedSection: string | undefined;
	previousPromptSections: SessionPromptCompileRecord["sections"] | null;
	/**
	 * True when the in-memory snapshot has been reconciled against provider
	 * usage since it was last persisted. A tool-calling turn reconciles once
	 * per API call; only the final reconciled state is written to the JSONL
	 * ledger, when the run settles. Any persist (turn submit, compaction,
	 * flush) clears the flag because it writes the current snapshot state.
	 */
	snapshotPersistPending: boolean;
	/** A failed rehydration, held until the path, the history or the runtime changes so each read does not render again. */
	rehydrationMiss: { key: string; runtime: AgentRuntime } | null;
	pendingUserImages: ReadonlyArray<unknown>;
	/** `estimate`, when given, is `liveContextEstimate` of the same runtime and `history` with no pending text. */
	/** The pending text of the reduction in flight, if it was given one. */
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
