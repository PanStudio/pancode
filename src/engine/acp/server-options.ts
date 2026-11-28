// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The ACP server's host contract: the options a host passes to
 * `servePancodeAcpAgent`, the controls each wired feature hands in, the
 * handshake the host negotiated, and the predicates that decide whether a
 * feature is wired at all.
 */

import type { SandboxMode } from "../../core/sandbox/types.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { ThinkingLevel } from "../../core/views/thinking-levels.js";
import type { StartupHint } from "../../domains/context/contract.js";
import type { McpElicitationHost } from "../../domains/gateway/mcp/index.js";
import type { ProvidersContract } from "../../domains/providers/contract.js";
import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import type { TelemetryReadModel } from "../../domains/telemetry/contract.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { MachineTurnProjectionHost } from "../../session-control/job-turn-types.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { McpCapabilitySource } from "../../tools/gateway/mcp-capability-types.js";
import type { ToolRegistry } from "../../tools/registry-contract.js";
import type { AgentMessage, ImageContent } from "../types.js";
import type { AcpArtifactsSource } from "./artifacts.js";
import type { AcpAsideControl } from "./aside.js";
import type { AcpBoardSource } from "./board.js";
import type { AcpCommandControl } from "./commands.js";
import type { AcpExtensionsControl, AcpHubReload } from "./extensions.js";
import type { AcpFleetControl } from "./fleet-run.js";
import type { AcpAutonomyPosture } from "./readouts.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import type { AcpInitializeResponse } from "./types.js";
import type { AcpCommandsCapability } from "./types-capabilities.js";
import type { AcpSafeSettingsPatch } from "./types-settings.js";

export type AcpServerEvent = unknown;
export type AcpEventRecord = Record<string, unknown> & { type?: unknown };

/** What the host's prompt expander hands back; the same fields the terminal submits with. */
export interface AcpPromptExpansion {
	text: string;
	images: ReadonlyArray<ImageContent>;
	workingContextPaths: ReadonlyArray<string>;
	pendingSkillRequests: ReadonlyArray<unknown>;
	display?: { text: string; note?: string };
	/** A prompt template's `allowed-tools`, submitted as the turn's constraint. */
	constraints?: TurnConstraints;
}

/** A handoff document awaiting review; nothing has been written while a client holds one. */
export interface AcpHandoffDraft {
	goal: string;
	fromSessionId: string;
	/** Host-only snapshot identity, never projected into the review response. */
	sourceIdentity: string;
	document: string;
}
interface AcpHandoffRefusal {
	ok: false;
	level: "warn" | "error";
	code: string;
	reason: string;
}
/**
 * `src/domains/session/handoff-service.ts`, bound by the composition root. The
 * server takes it by structure so the domain service stays out of the Stage 0
 * chunk this module is measured in.
 */
export interface AcpHandoffControl {
	prepare(goal: string): Promise<{ ok: true; draft: AcpHandoffDraft } | AcpHandoffRefusal>;
	commit(
		draft: AcpHandoffDraft,
		document: string,
	): { ok: true; toSessionId: string; warnings: ReadonlyArray<string> } | AcpHandoffRefusal;
}

interface AcpInterviewTransport {
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
}

export interface AcpInterviewBinding {
	transport: AcpInterviewTransport;
	/** The session a round is asked on, or null when none is bound. */
	sessionId: () => string | null;
	/** True once the client advertised the capability at initialize. */
	enabled: () => boolean;
	/** The round's request window; a function when the client negotiates it after the binding attaches. */
	timeoutMs?: number | (() => number);
	diagnostics?: (line: string) => void;
}

/** MCP elicitations for a client that advertised `pancode/elicitation`, bound like the interview channel. */
export interface AcpElicitationChannel {
	/** The host the MCP capability source puts every server's elicitation to. */
	elicit: McpElicitationHost;
	cancel(): void;
	attach(binding: AcpInterviewBinding): () => void;
}

export interface AcpInterviewChannel {
	/** The handler the orchestrator installs as its ask_user handler. */
	ask: AskUserHandler;
	cancel(): void;
	/** Returns the detach function; a later attach replaces an earlier one. */
	attach(binding: AcpInterviewBinding): () => void;
}

/** The board's writes, bound by the composition root. */
export interface AcpBoardActions {
	/** Throws when the decision is not on the board. */
	supersedeDecision(
		interviewId: string,
		key: string,
		correction?: string,
	): { status: "superseded" | "already_superseded"; correctionTurn?: string };
	/** Throws when the entry is not in the task bank or the scope cannot be resolved. */
	proposeMemory(entryId: string, scope: "repo" | "global"): Promise<{ created: boolean; recordId: string }>;
}

export interface AcpServerChat {
	discoverOperatorEgg?(text: string): Promise<boolean>;
	submit(text: string, options?: unknown): Promise<void>;
	/** Wait for a command's host-injected turn while the ACP prompt owns its subscription. */
	whenSettled?(): Promise<void>;
	/**
	 * A scheduled main turn has no `session/prompt` to own its frames. The chat loop asks the bound
	 * host for a projection before it prepares such a turn, so the server must be bound before any
	 * job can run. The returned function unbinds; once unbound the loop refuses scheduled turns
	 * instead of running them where no client can see them (#411).
	 */
	bindMachineTurnProjection?(host: MachineTurnProjectionHost): () => void;
	cancel(): void;
	onEvent(handler: (event: AcpServerEvent) => void): () => void;
	isStreaming(): boolean;
	getSessionId(): string | null;
	/**
	 * Bind a session's schema ceiling or a prompt's admission ceiling and
	 * return the effective limits (#423). Absent means the chat cannot enforce
	 * a client ceiling, so one is refused.
	 */
	setToolCeiling?(
		ceilings: ReadonlyArray<TurnConstraints | undefined>,
		lifetime?: "session" | "prompt",
	): TurnConstraints | undefined;
	/** Replace provider context and the next persisted parent for a new or loaded session. */
	resetForSession?(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
	/** Resolves once the reset's next request is built and the context view republished from it (SPEC §0). */
	nextRequestReady?(): Promise<void>;
	/**
	 * Mid-run guidance: queue `text` on the engine's steering queue, where the
	 * inner loop drains it between tool batches. False means nothing was
	 * streaming to steer, which the wire reports as a refusal rather than as a
	 * silent success.
	 */
	steer?(text: string): boolean;
	/** Queue `text` on the follow-up queue, drained when the whole run settles. */
	queueFollowUp?(text: string): boolean;
	queuedMessages?(): { steer: ReadonlyArray<string>; followUp: ReadonlyArray<string> };
	/** Drain both queues and hand back the texts so a client can restore them. */
	clearQueuedFollowUps?(): string[];
	/** What {@link clearQueuedFollowUps} would hand back now, in-flight entries included, read without draining. */
	restorableQueuedTexts?(): string[];
	/** The queued entries still in PanCode's hands, in delivery order. */
	queueEntries?(): ReadonlyArray<AcpQueuedEntry>;
	/** Takes one entry out of the queue; null when it already left. `reason` is recorded, never acted on. */
	removeQueuedEntry?(id: string, reason?: "removed" | "to-editor" | "sent-now"): AcpQueuedEntry | null;
	/** Moves one entry up (-1) or down (+1) in delivery order; false when it cannot move. */
	moveQueuedEntry?(id: string, delta: -1 | 1): boolean;
	/** The operator's own choice of slot, which pins the entry against steering producers. */
	setQueuedEntryKind?(id: string, kind: AcpQueuedEntryKind): boolean;
	/** Why an interrupt would be refused right now, or null when it would cancel the run. */
	interruptRefusal?(): string | null;
	/** The yolo window's usage, caps and halt for the readouts; null outside yolo. */
	autonomyStatus?(): AutonomyStatus | null;
	/** The skills armed for the next turn, by name, for the readouts. */
	activeSkillSurface?(): ReadonlyArray<string>;
	dispose?(): void;
}

export type AcpQueuedEntryKind = "steer" | "follow-up";

/** One message waiting in the chat loop's steering queue, as the loop holds it. */
export interface AcpQueuedEntry {
	id: string;
	kind: AcpQueuedEntryKind;
	text: string;
	/** Epoch milliseconds the message was queued. */
	enqueuedAt: number;
	pinned?: boolean;
	display?: { text: string; note?: string };
	referencedPaths?: ReadonlyArray<string>;
}

/**
 * The fleet controls the ACP steering surface reaches. Narrowed to the two
 * operations an external client may perform on a worker it did not start, so a
 * client cannot enqueue, route, or re-plan dispatch work through this server.
 */
export interface AcpDispatchControl {
	/**
	 * Queue operator guidance on a running worker's open stdin. Throws with an
	 * operator-facing message for every refusal; delivery itself is confirmed
	 * later and out of band, so a return here means queued, never delivered.
	 */
	steer(runId: string, text: string): void;
	abort(runId: string): void;
	snapshot(): {
		running: ReadonlyArray<{ runId: string; runtimeKind: string }>;
		retrying: ReadonlyArray<{ runId: string }>;
	};
}

export interface AcpRoutingSnapshot {
	target: string | null;
	model: string | null;
}

export interface AcpSafeSettingsSnapshot extends AcpRoutingSnapshot {
	thinkingLevel: ThinkingLevel;
	autonomy: AutonomyLevel;
	/** What the yolo mode description reads to state the real sandbox and judge; never sent to the client. */
	containment?: { sandbox: SandboxMode; judgeEnabled: boolean };
}

/**
 * Who an ACP client's settings changes and approval answers are attributed to: the PanCode GUI names itself and
 * is the operator's own surface, any other client is acp (#434).
 */
export type AcpClientSurface = "acp" | "gui";

interface AcpSettingsControl {
	read(): AcpSafeSettingsSnapshot;
	commit(patch: AcpSafeSettingsPatch, source: AcpClientSurface): AcpSafeSettingsSnapshot;
}

export interface PancodeAcpServerOptions {
	transport: AcpJsonRpcPeerTransport;
	chat: AcpServerChat;
	session?: SessionContract;
	providers?: ProvidersContract;
	settings?: AcpSettingsControl;
	/** Wired only by the composition root; absent means `_pancode/dispatch/steer` refuses. */
	dispatch?: AcpDispatchControl;
	/**
	 * The 13 wire-shaped operator commands. Absent means the catalog is not
	 * announced and both command methods refuse, which is what an embedder that
	 * wired no fleet, bus, or provider contract must observe.
	 */
	commands?: AcpCommandControl;
	/**
	 * The operator's tasks, the session's plan, its decisions and the memory
	 * tier, read for `_pancode/session/board`. Absent means the method is not
	 * announced and refuses.
	 */
	board?: () => AcpBoardSource;
	/** Project context notes for the operator, shown once on the first prompt this process serves. */
	startupHints?: () => ReadonlyArray<StartupHint>;
	/**
	 * The shared /handoff lifecycle, bound by the composition root. Absent means
	 * the three handoff methods are not announced and refuse.
	 */
	handoff?: AcpHandoffControl;
	/**
	 * The terminal's `/fleet run` approval: compile a named playbook for
	 * review and start it only against the hash that was approved. Absent means
	 * the two fleet methods are not announced and refuse.
	 */
	fleet?: AcpFleetControl;
	/**
	 * The board panel's two writes, with the terminal overlays' semantics:
	 * superseding a decision (a correction also yields the turn the terminal
	 * submits) and proposing a task-bank entry as durable memory. Absent means
	 * both methods refuse.
	 */
	boardActions?: AcpBoardActions;
	/**
	 * The session's extensions and their reload coordinator, for
	 * `_pancode/extensions/list` and `/reload`. Absent means both refuse.
	 */
	extensions?: AcpExtensionsControl;
	/**
	 * The chat loop's out-of-turn rounds, for `_pancode/aside/*` (`/btw` and
	 * `/draft`). Absent means the three methods refuse.
	 */
	aside?: AcpAsideControl;
	/** The telemetry read model for pull methods and live quantities (#434). */
	telemetryReadModel?: TelemetryReadModel;
	/** Lazy provider quota production for telemetry quota requests (#434). */
	refreshQuota?: () => Promise<void>;
	/** Bind the domain projection and its live read model to the hosted session (#434). */
	bindTelemetrySession?: (sessionId: string) => void;
	/**
	 * The plugin-resource reload /reload hub runs, so a PanHub change made
	 * elsewhere reaches this open session. Absent means the method refuses.
	 */
	hubReload?: AcpHubReload;
	/**
	 * The chat's context accounting, read for `_pancode/context/ledger`.
	 * Absent means the method is not announced and refuses.
	 */
	contextLedger?: () => ContextLedger;
	/** Ownership-checked cancellation of project context work, distinct from chat reduction. */
	cancelContextOperation?: (sessionId: string, cwd: string, operationId?: string) => boolean;
	/**
	 * The session's task-board plan, re-read after every settled tool call so a
	 * change reaches the client as the standard `plan` update. Absent means no
	 * `plan` update is sent; `_pancode/session/board` still carries the plan.
	 */
	plan?: () => TaskBoardSnapshot | null;
	/**
	 * Probes the workspace's Git facts for `_meta[ACP_WORKSPACE_META_KEY]` on the
	 * session responses and on `session_info_update` when they change. Absent
	 * means the capability is not announced and no workspace view is sent.
	 */
	workspace?: (cwd: string) => Promise<WorkspaceSnapshot>;
	/**
	 * The `/view` overlay's provider inputs for the bound session, read for
	 * `_pancode/artifacts/*`. Absent means both methods are not announced
	 * and refuse.
	 */
	artifacts?: AcpArtifactsSource;
	/**
	 * Expands operator syntax in a prompt as the terminal does before it submits:
	 * `@path` file and image references, prompt templates and `/skill` requests,
	 * plus the prompt's own image blocks. Absent means the text is submitted as
	 * typed and image blocks are not accepted.
	 */
	expandPrompt?: (
		text: string,
		images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }>,
		signal?: AbortSignal,
	) => Promise<AcpPromptExpansion>;
	toolRegistry?: ToolRegistry;
	/**
	 * The terminal's `!` line gate: labels the information-flow sources an
	 * operator shell line names and returns why they could not be labeled, which
	 * keeps that line's output out of context. Absent means
	 * `_pancode/session/shell` is not announced and refuses, as it does when
	 * the session readers it records and replays through are not wired.
	 */
	labelOperatorCommand?: (command: string, cwd: string) => string | null;
	/** Runs before an operator shell line reaches the ledger, so a ledger fact can precede it. */
	beforeShellEntryRecorded?: () => void;
	/**
	 * Tool calls the host makes on the operator's behalf inside a prompt turn,
	 * such as the dispatch a `/council` command starts. They arrive as the same
	 * engine-shaped `tool_execution_*` events the chat emits and are announced
	 * as the turn's own calls, so an approval one parks binds to a call the
	 * client can see.
	 */
	hostToolEvents?: { onEvent(handler: (event: AcpServerEvent) => void): () => void };
	mcpCapabilities?: Pick<McpCapabilitySource, "attachClientServers" | "detachClientServers">;
	/** The limits `acp --read-only` and `--allow-tools` set; every session is held within them. */
	operatorToolLimits?: Pick<TurnConstraints, "readOnly" | "allowedTools">;
	bus?: TelemetryHub;
	autonomy?: () => AutonomyLevel;
	/** Shared with the deferred front when the workspace binds after initialize. */
	handshake?: AcpHandshake;
	/**
	 * Carries `ask_user` rounds and harness cards to a client that advertised
	 * `pancode/interviews`. Absent means the host asks nobody.
	 */
	interviews?: AcpInterviewChannel;
	/** Carries MCP elicitations to a client that advertised `pancode/elicitation`. Absent means servers are told nobody answers. */
	elicitation?: AcpElicitationChannel;
	/**
	 * Answers a dispatched worker's permission ask on the operator's behalf. Absent
	 * means worker asks are never forwarded, whatever the client advertises.
	 */
	workerPermissions?: { resolve(runId: string, requestId: string, decision: "approve" | "deny"): void };
	/** Resolves the first queued workspace request after every handler is installed. */
	onReady?: () => void;
	/** Initial effective next-turn route captured when a session is bound. */
	routing?: () => AcpRoutingSnapshot;
	/** Durable rich-entry reader used by standard session/load. */
	readSessionEntries?: (sessionId: string) => ReadonlyArray<SessionEntry>;
	/**
	 * Builds the provider context; this is deliberately separate from client
	 * replay. `upto` is the historical cut a /tree switch makes: sidecars written
	 * after the selected turn stay out, where a live leaf keeps them.
	 */
	buildReplayMessages?: (
		entries: ReadonlyArray<SessionEntry>,
		leafTurnId: string | null,
		scope?: "leaf" | "upto",
	) => ReadonlyArray<AgentMessage>;
	/** Apply a route change only to this hosted session, leaving saved defaults alone. */
	setSessionRouting?: (
		patch: { target?: string; model?: string; thinkingLevel?: ThinkingLevel },
		source: AcpClientSurface,
	) => void;
	onActiveSessionAutonomyChange?: (level: AutonomyLevel | null) => void;
	/**
	 * Why yolo cannot run in this process (root outside a container), or null
	 * (#407). A client's choice of yolo is refused while it is set; otherwise
	 * the explicit choice counts as the operator's acceptance.
	 */
	yoloRefusal?: () => string | null;
	/** The yolo containment the readouts name; absent means the autonomy readout is null. */
	autonomyPosture?: () => AcpAutonomyPosture;
	cwd?: string;
	version?: string;
	permissionTimeoutMs?: number;
	/**
	 * Where text this process did not author goes instead of the wire. Stdout is
	 * JSON-RPC only, so the operator-facing detail behind a failure lands on the
	 * unstructured stderr tail (CONTRACT C001 §6). Defaults to dropping it.
	 */
	diagnostics?: (line: string) => void;
	/**
	 * Clock the tool-progress interval floor measures against. Injectable
	 * because the floor and the per-call frame ceiling are otherwise only
	 * observable by spending {@link ACP_MIN_TOOL_PROGRESS_INTERVAL_MS} of real
	 * time per frame, which puts a 64-frame ceiling sixteen seconds away.
	 */
	now?: () => number;
}

/**
 * Bus channels this server is willing to forward over the opt-in
 * `_pancode/event` notification. Nothing outside this list is forwardable:
 * the list is the allowlist, and a client's requested kinds are intersected
 * with it rather than trusted. `safety.loop_blocked` was the first member; the
 * dispatch lifecycle joined it so a client can draw a live fleet board from
 * reported facts instead of inferring one from tool titles or timing;
 * `evidence.assessed` precedes a run's terminal event, once the run's
 * assessment is journaled ahead of its seal, so the board can show first-pass
 * success and a finding count without reading PanCode's state tree. The last four are the
 * session's own health: without them a client can only infer that context was
 * compacted, that the window is close to full, that the loop guard stopped a
 * turn on volume rather than repetition, or that a target went down, by
 * watching timing and tool titles.
 *
 * Every kind here is the literal EVENTS name of the live event it
 * forwards. That is the invariant: a kind is never renamed on the way out, so
 * `grep` finds the producer from the wire frame and a client's kind list and
 * PanCode's own channel table cannot drift into two vocabularies.
 */
export const ACP_FORWARDABLE_EVENT_KINDS = [
	"safety.loop_blocked",
	"run.enqueued",
	"run.started",
	"run.progressed",
	"run.completed",
	"run.failed",
	"evidence.assessed",
	"compaction.ended",
	"context.activity_changed",
	"context.warning_raised",
	"safety.tool_budget_exceeded",
	"provider.health_changed",
	"run.scope_notice_raised",
	"job.changed",
] as const;

export type AcpForwardableEventKind = (typeof ACP_FORWARDABLE_EVENT_KINDS)[number];

/** A handoff seeds a successor and replays it through the same readers a load needs. */
export function handoffWired(options: PancodeAcpServerOptions): boolean {
	return options.handoff !== undefined && branchesWired(options);
}

/** Tree, switch and fork restore through the same readers `session/load` needs. */
export function branchesWired(options: PancodeAcpServerOptions): boolean {
	return (
		options.session !== undefined &&
		options.readSessionEntries !== undefined &&
		options.buildReplayMessages !== undefined &&
		options.chat.resetForSession !== undefined
	);
}

/** A shell line is recorded in the session and replayed into context through the same readers. */
export function shellWired(options: PancodeAcpServerOptions): boolean {
	return options.labelOperatorCommand !== undefined && branchesWired(options);
}

/** The per-entry operations the terminal's queue navigator performs, plus the send-now resubmit. */
export function queueEditWired(options: PancodeAcpServerOptions): boolean {
	const chat = options.chat;
	return (
		chat.queueEntries !== undefined &&
		chat.removeQueuedEntry !== undefined &&
		chat.moveQueuedEntry !== undefined &&
		chat.setQueuedEntryKind !== undefined
	);
}

export interface AcpHandshakeFeatures {
	version?: string;
	session: boolean;
	loadSession: boolean;
	settings: boolean;
	providers: boolean;
	commandsCapability?: AcpCommandsCapability & { count?: number; promptTurns?: boolean };
	/** The chat enforces a client ceiling; absent reads as false. */
	ceiling?: boolean;
	steer: boolean;
	dispatch: boolean;
	toolRegistry: boolean;
	bus: boolean;
	/** Whether `_pancode/session/board` answers; absent reads as false. */
	board?: boolean;
	/** Whether the board's supersede and memory-propose methods answer; absent reads as false. */
	boardActions?: boolean;
	/** Whether the session tree, branch switch and fork methods answer; absent reads as false. */
	branches?: boolean;
	/** Whether the handoff prepare, commit and cancel methods answer; absent reads as false. */
	handoff?: boolean;
	/** Whether the fleet preview and run methods answer; absent reads as false. */
	fleet?: boolean;
	/** Whether `_pancode/context/ledger` answers; absent reads as false. */
	contextLedger?: boolean;
	/** Whether `_pancode/artifacts/list` and `/read` answer; absent reads as false. */
	artifacts?: boolean;
	/** Whether `_pancode/jobs/list` answers; absent reads as false. */
	jobs?: boolean;
	/** Whether the extension list and reload methods answer; absent reads as false. */
	extensions?: boolean;
	/** Whether `_pancode/hub/reload` answers; absent reads as false. */
	hubReload?: boolean;
	/** Whether the side-question and draft methods answer; absent reads as false. */
	aside?: boolean;
	/** Whether the `_pancode/telemetry/*` methods answer and updates are pushed; absent reads as false. */
	telemetry?: boolean;
	/** Whether session responses and `session_info_update` carry the workspace view; absent reads as false. */
	workspace?: boolean;
	/** Whether prompts are expanded, which is what admits image blocks; absent reads as false. */
	images?: boolean;
	/** Whether the host can ask `ask_user` rounds over `_pancode/interview/request`; absent reads as false. */
	interviews?: boolean;
	/** Whether the host can ask MCP elicitations over `_pancode/elicitation/request`; absent reads as false. */
	elicitation?: boolean;
	/** Whether the host can forward worker permission asks over `session/request_permission`; absent reads as false. */
	workerPermissions?: boolean;
	/**
	 * The operator's explicit `--permission-timeout`. A client's negotiated
	 * `timeoutMs` never overrides it, and the echo names this value instead.
	 */
	pinnedTimeoutMs?: number;
	/** Whether `_pancode/session/shell` runs operator shell lines; absent reads as false. */
	shell?: boolean;
	/** Whether `_pancode/session/queue_edit` acts on one queued entry; absent reads as false. */
	queueEdit?: boolean;
}

export interface AcpHandshake {
	readonly initialized: boolean;
	readonly enabledEventKinds: ReadonlySet<AcpForwardableEventKind>;
	readonly toolProgressEnabled: boolean;
	/** The client advertised `pancode/interviews` and this host can ask over it. */
	readonly interviewsEnabled: boolean;
	/** The client advertised `pancode/workerPermissions`: a person answers forwarded worker asks. */
	readonly workerPermissionsEnabled: boolean;
	/** The applied interview window when the client negotiated one at initialize, else null. */
	readonly interviewTimeoutMs: number | null;
	/** The client advertised `pancode/elicitation` and this host can ask over it. */
	readonly elicitationEnabled: boolean;
	/** The applied elicitation window when the client negotiated one at initialize, else null. */
	readonly elicitationTimeoutMs: number | null;
	/** The applied `session/request_permission` window when the client negotiated one at initialize, else null. */
	readonly permissionRequestTimeoutMs: number | null;
	/** The client advertised `pancode/queue` and is sent `_pancode/session/queue_changed`. */
	readonly queueEventsEnabled: boolean;
	/** The client advertised `pancode/readouts`: it is sent readouts frames and admission `_meta`. */
	readonly readoutsEnabled: boolean;
	/** The client advertised `pancode/usage`: usage `_meta` carries the full read-model quantities, not their displays. */
	readonly fullUsageEnabled: boolean;
	readonly workspaceInstanceId: string;
	/** The surface this client's settings changes and approval answers are attributed to, from `clientInfo.name` (#434). */
	readonly clientSurface: AcpClientSurface;
	initialize(params: unknown): AcpInitializeResponse;
	authenticate(params: unknown): never;
}
