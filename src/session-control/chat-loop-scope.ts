// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AsyncLocalStorage } from "node:async_hooks";
import type { PendingSkillRequest, PendingSkillToolPolicy, SkillSurfaceChange } from "../core/skill-activation.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { RetrySettings } from "../domains/session/retry.js";
import type { EngineAgentHandle, EngineAgentOptions } from "../engine/agent.js";
import type { TurnFailureRecord } from "../lib/turn-control/outcome.js";
import type { HeadlessObservationPool } from "../tools/observation.js";
import type { AskUserToolPolicy, ToolInvokeOptions } from "../tools/registry-contract.js";
import type {
	ChatCancelOptions,
	ChatLoop,
	ChatLoopEvent,
	ChatNoticeEvent,
	CreateChatLoopDeps,
	StepPipelineEnd,
} from "./chat-loop.js";
import type { createChatLoopBus } from "./chat-loop-bus.js";
import type { createChatLoopComposition } from "./chat-loop-composition.js";
import type { createChatLoopStateMachine } from "./chat-loop-state-machine.js";
import type { createChatLoopSteering } from "./chat-loop-steering.js";
import type { NoticeSource } from "./notice-source.js";
import type { SubmitEvidence } from "./run-evidence.js";
import type { TurnControlRunner } from "./turn-control-runner.js";
import type { AgentRuntime, TurnPreparationPhase, TurnPreparationStep } from "./turn-state.js";

type ChatLoopComposition = ReturnType<typeof createChatLoopComposition>;
type ChatLoopBus = ReturnType<typeof createChatLoopBus>;
type ChatLoopStateMachine = ReturnType<typeof createChatLoopStateMachine>;
type ChatLoopSteering = ReturnType<typeof createChatLoopSteering>;

/**
 * What createChatLoop shares with its stage modules: the deps, the loop's mutable bindings as fields, and getters
 * for the values a stage builds, read when used so a stage may reach one built after it.
 */
export interface ChatLoopScope {
	readonly deps: CreateChatLoopDeps;
	readonly createAgent: (options?: EngineAgentOptions) => EngineAgentHandle;
	readonly middlewareToolChoice: MiddlewareToolChoiceControl;
	readonly noteTurnControlCollection: ({ block, record }: Awaited<ReturnType<TurnControlRunner["run"]>>) => void;
	readonly toolStartTimes: Map<string, number>;
	readonly setTurnPreparation: (phase: TurnPreparationPhase) => void;
	readonly markPreparationStep: (step: TurnPreparationStep) => void;
	readonly endPreparationCompaction: () => void;
	readonly emit: (event: ChatLoopEvent) => void;
	readonly refuseSkillRequests: (
		requests: ReadonlyArray<PendingSkillRequest>,
		inlinedPaths: ReadonlyArray<string>,
	) => boolean;
	readonly emitFooterNotice: (level: ChatNoticeEvent["level"], text: string, key: string) => void;
	readonly emitNotice: (
		text: string,
		level?: ChatNoticeEvent["level"],
		key?: string,
		skillSurface?: SkillSurfaceChange,
		source?: NoticeSource,
	) => void;
	readonly armSkillSurface: (
		policy: PendingSkillToolPolicy | undefined,
		loadedBefore?: ReadonlySet<string>,
		explicitOff?: boolean,
	) => void;
	readonly emitAdmissionNotice: (text: string, reason: string, level?: ChatNoticeEvent["level"]) => void;
	readonly visionModelOptions: () => string[];
	readonly nullRuntimeAdmissionReason: () => string;
	readonly retrySettings: () => RetrySettings;
	readonly headlessObservation: HeadlessObservationPool | null;
	readonly missingOutputs: () => string[];
	readonly hostRunContext: AsyncLocalStorage<ToolInvokeOptions["hostRun"]>;
	readonly leavePreparation: () => void;
	readonly enterPreparation: () => void;
	readonly sideQuestionRound: NonNullable<CreateChatLoopDeps["runSideQuestion"]>;
	readonly currentToolInvokeOptions: (toolCallId?: string) => Partial<ToolInvokeOptions>;
	sessionToolLimits: TurnConstraints | undefined;
	promptToolLimits: TurnConstraints | undefined;
	lastHistoricalImageNoticeKey: string | null;
	operatorSpokeAt: number;
	queueSessionId: string | null;
	submitOwner: AbortController | null;
	guardStoppedOwner: AbortController | null;
	submitGeneration: number;
	disposed: boolean;
	terminalTurnFailure: TurnFailureRecord | undefined;
	turnRetryAttempts: number;
	providerRetryAttempts: number;
	moveForeground: ((runtime: AgentRuntime) => void) | null;
	boundaryStop: ChatCancelOptions | null;
	budgetRoll: "calls" | "observation" | null;
	promptInterview: AskUserToolPolicy | undefined;
	loopGuardFailure: { tool: string; failure: string } | null;
	stepPolicyStop: { template?: string } | null;
	lastStepPipeline: StepPipelineEnd | null;
	stepTurnScope: { evidence: SubmitEvidence; continuation: boolean } | null;
	activeSubmit: Promise<void>;
	priorSubmit: Promise<void>;
	sessionResetSettlement: Promise<void>;
	machinePreparation: { token: object; runtime: AgentRuntime | null } | null;
	machineTurnRunning: object | null;
	pendingMachineCancellation: object | null;
	machineHostDisposed: boolean;
	nextRequestPrepared: Promise<void>;
	nextRequestNavigation: number;
	turnActive: boolean;
	pendingPreTurnRead: AbortController | null;
	pendingVisionSidecar: AbortController | null;
	pendingCompactionPaint: AbortController | null;
	operatorTurnsBefore: number | null;
	readonly messagePath: ChatLoopComposition["messagePath"];
	readonly queues: ChatLoopComposition["queues"];
	readonly middleware: ChatLoopComposition["middleware"];
	readonly operatorMemory: ChatLoopComposition["operatorMemory"];
	readonly context: ChatLoopComposition["context"];
	readonly persistence: ChatLoopComposition["persistence"];
	readonly outcomeCollector: ChatLoopComposition["outcomeCollector"];
	readonly recordRecovery: ChatLoopComposition["recordRecovery"];
	readonly currentTurnFailure: ChatLoopComposition["currentTurnFailure"];
	readonly recovery: ChatLoopComposition["recovery"];
	readonly requestBudgetRoll: ChatLoopComposition["requestBudgetRoll"];
	readonly turnRuntime: ChatLoopComposition["turnRuntime"];
	readonly steerInterrupter: ChatLoopComposition["steerInterrupter"];
	readonly withEndpointSlot: ChatLoopStateMachine["withEndpointSlot"];
	readonly prepareOutOfTurnRound: ChatLoopStateMachine["prepareOutOfTurnRound"];
	readonly routeMoveWait: ChatLoopComposition["routeMoveWait"];
	readonly routeFit: ChatLoopComposition["routeFit"];
	readonly continuity: ChatLoopComposition["continuity"];
	readonly stepStarts: ChatLoopBus["stepStarts"];
	readonly stepPipeline: ChatLoopBus["stepPipeline"];
	readonly yoloContinuationDue: ChatLoopStateMachine["yoloContinuationDue"];
	readonly stepTurnEnd: ChatLoopStateMachine["stepTurnEnd"];
	readonly submittedTurnOrigin: ChatLoopStateMachine["submittedTurnOrigin"];
	readonly continueStoppedTurn: ChatLoopStateMachine["continueStoppedTurn"];
	readonly interruptRefusalReason: ChatLoopStateMachine["interruptRefusalReason"];
	readonly sideCallAdmission: ChatLoopStateMachine["sideCallAdmission"];
	readonly withEndpointKeySlot: ChatLoopStateMachine["withEndpointKeySlot"];
	readonly sideCallJournal: ChatLoopStateMachine["sideCallJournal"];
	readonly prepareCompactionPaint: ChatLoopStateMachine["prepareCompactionPaint"];
	readonly operatorTurnIndex: ChatLoopStateMachine["operatorTurnIndex"];
	readonly workerReceipts: ChatLoopStateMachine["workerReceipts"];
	readonly recordStepPipelineSettled: ChatLoopStateMachine["recordStepPipelineSettled"];
	readonly writeTurnOutcome: ChatLoopStateMachine["writeTurnOutcome"];
	readonly recordCanceledBeforeAdmission: ChatLoopStateMachine["recordCanceledBeforeAdmission"];
	readonly keepalive: ChatLoopStateMachine["keepalive"];
	readonly queuedForTriage: ChatLoopSteering["queuedForTriage"];
	readonly api: ChatLoop;
	readonly submitTracked: ChatLoop["submit"];
}
