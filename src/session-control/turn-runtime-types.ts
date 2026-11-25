// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../core/config.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { HostInsertSource } from "../domains/session/entries.js";
import type { RetrySettings } from "../domains/session/retry.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import type { TelemetrySessionLease, TelemetrySessionOrigin } from "../domains/telemetry/session-journals.js";
import type { createEngineAgent } from "../engine/agent.js";
import type { CacheKeepaliveReply, CacheKeepaliveRequest } from "../engine/cache-keepalive.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../engine/types.js";
import type { ToolTelemetry } from "../tools/agent-tools.js";
import type { RequestCursor } from "./attempt-receipt.js";
import type { ChatNoticeEvent } from "./chat-loop.js";
import type { ContinuityController } from "./continuity-controller.js";
import type { HostInserts } from "./host-inserts.js";
import type { TurnContext } from "./turn-context.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { TurnPersistence } from "./turn-persistence.js";
import type { AgentRuntime, ChatLoopTarget, TurnRuntimeState } from "./turn-state.js";

export type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			/**
			 * One whole frame from a diffusion model: the entire text so far, with
			 * positions the model has not resolved yet still noise. Replaces the
			 * streamed text rather than extending it.
			 */
			type: "text_frame";
			contentIndex: number;
			text: string;
			/** 0 to 1 as reported by the provider. */
			progress: number;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export interface TurnRuntimeDeps {
	onMemoryRequestSubmitted?: ((messages: readonly AgentMessage[], systemPrompt?: string) => void) | undefined;
	turnIdentity?: () => unknown;
	interactiveGuidance?: boolean;
	state: TurnRuntimeState;
	/** Host tails (required-tool, continuation) are written durably before they join the live history. */
	hostInserts?: HostInserts | undefined;
	/** Capabilities behind the attached gateway, for the streaming tool-prose cutoff. */
	gatewayCapabilityNames?: (() => ReadonlyArray<string>) | undefined;
	getSettings: () => Readonly<PancodeSettings>;
	providers: ProvidersContract;
	knownTargets: () => ReadonlySet<string>;
	telemetry?: TelemetryContract | undefined;
	scheduling?: SchedulingContract | undefined;
	headless?: boolean | undefined;
	/** The outputs the session's operator prompts named that do not exist now (M-4); finish(done) is refused once over them. */
	missingOutputs?: (() => string[]) | undefined;
	createAgent: typeof createEngineAgent;
	/** Every main-turn request as sent, for the hosted cache keepalive (#423). */
	noteMainRequest?: (
		runtime: AgentRuntime,
		request: CacheKeepaliveRequest,
		stream: { result(): Promise<CacheKeepaliveReply> },
	) => void;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	persistence: TurnPersistence;
	context: TurnContext;
	continuity?: ContinuityController;
	hasQueuedSteering?: () => boolean;
	/**
	 * PanCode's steering queue hands operator messages to the engine only at a
	 * slot: the top of `finishTurn`, before Pi's poll, and the end of
	 * `prepareNextTurn`, before Pi's second poll. Host messages (X6) never take
	 * that path: `takeHostMessages` hands them to `prepareNextTurn`, which appends
	 * them as host inserts in its context update.
	 */
	queueHandOver?: {
		atFinishTurn(final: boolean): void;
		afterPrepareNextTurn(): void;
		takeHostMessages?(): ReadonlyArray<{ text: string; source: HostInsertSource; rule?: string }>;
	};
	/**
	 * A stop deferred to the tool boundary lands here, after the round's tool
	 * batch settled and before the next model request: true ends the run (F-C16).
	 */
	stopAtToolBoundary?: () => boolean;
	/**
	 * Per-run main-loop caps (`run --max-requests`, `--max-tool-calls`): a refusal
	 * reason ends the request or refuses the batch, undefined admits it.
	 */
	runCaps?: {
		admitRequest(): string | undefined;
		admitToolCalls(count: number): string | undefined;
	};
	middleware: TurnMiddleware;
	retrySettings: () => RetrySettings;
	/** Stable PanCode session id forwarded only to gateway runtimes that understand it. */
	sessionId?: () => string | undefined;
	sessionOrigin?: () => TelemetrySessionOrigin | null;
	/**
	 * A main-agent request is leaving now, on this attempt: what the run's messages hold, this request carries. Every
	 * main request reports, journaled or not; `call` is null when no journal lease records it.
	 */
	onModelRequestSent?: (
		call: {
			callId: string;
			attemptId: string;
			attempt: number;
			context: TelemetrySessionLease["context"];
		} | null,
	) => void;
	onModelCallSettled?: (facts: CallSettled) => void;
	/** The ledger as admission prepares a request: the attempt's cursor, owner and the fold records it renders. */
	requestCursor?: () => RequestCursor;
	/**
	 * Information-flow admission of one model request: the block reason when
	 * the session's restricted context may not reach this target, or null.
	 * Asked on every request, after ownership and before budget, so a target
	 * whose endpoint changed is judged on what it is now.
	 */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	emit: (event: AgentEvent | AssistantDeltaEvent) => void;
	emitNotice: (text: string, level?: ChatNoticeEvent["level"], key?: string) => void;
	/** Transport advisories belong in the footer, separate from conversation. */
	emitFooterNotice: (level: "info" | "warning", text: string, key: string) => void;
	/** Tool-call id to its `performance.now()` start mark; spans only, never an instant. */
	toolStartTimes: Map<string, number>;
	/**
	 * Turn-control work a middleware continuation runs before its request (the
	 * detached-batch collection), returned as a block for model context. The
	 * submit path did this for a resubmitted continuation.
	 */
	prepareInRunContinuation?: (signal?: AbortSignal) => Promise<string | null>;
}

/**
 * `first-output`: a request is out and has produced nothing. `output`: it has. `tool`: a tool is running.
 * `elsewhere`: no request is the thing being waited on, such as admission, compaction or a settled run.
 */
export type RunningCallWait = "first-output" | "output" | "tool" | "elsewhere";

export interface TurnRuntime {
	ensureRuntime(options?: { silent?: boolean }): AgentRuntime | null;
	ensureLiveCapabilitiesForSelectedModel(options?: { silent?: boolean }): Promise<void>;
	dispose(): void;
	cancelRunWatchdog(): void;
	cleanupSessionResources(sessionId: string | undefined): void;
	/** Where the run's current model call stands: what decides whether a route pick can still move it. */
	callWait(): RunningCallWait;
	/** Resolve a route without touching the live agent. Throws as `ensureRuntime` does on a route that cannot run. */
	previewRoute(route?: { target: string; model: string }): { target: ChatLoopTarget; model: EngineModel } | null;
	/** Put a settled agent on another route for its next call, keeping its conversation, subscribers and run. */
	rebindRoute(target: ChatLoopTarget): void;
	/**
	 * Install on the session tool surface so admission verdicts reach the panel.
	 * The engine's `tool_execution_end` carries only `isError` and result text,
	 * which cannot tell a permission block from a command that ran and exited
	 * nonzero; this stream carries the registry's actual verdict.
	 */
	toolTelemetry: ToolTelemetry;
	/** The journaled main calls whose lease was taken for this user turn, in settle order (#434). */
	takeSettledCalls(userTurnId: string): CallSettled[];
	/** How many bare attended finishes this user turn refused (FX-40), cleared as it is read (CLI-P50). */
	takeBareFinishRefusals(userTurnId: string): number;
}
