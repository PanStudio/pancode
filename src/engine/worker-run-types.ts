// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { WorkerTelemetryContext } from "../core/telemetry/context.js";
import type { ToolName } from "../core/tool-names.js";
import type { ResultContract } from "../domains/agents/result-contract-types.js";
import type { AgentProduct } from "../domains/agents/spec.js";
import type { WorkerContextSeed } from "../domains/context/worker/contract.js";
import type { RunRole } from "../domains/dispatch/obligation.js";
import type { RunLimits } from "../domains/dispatch/run-limits.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type {
	CapabilityFlags,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import type { FlowRestrictionSet, WorkerFlowPolicyInput } from "../domains/safety/information-flow.js";
import type {
	WorkerGitAllowance,
	WorkerMcpAttestation,
	WorkerPermitAllowance,
} from "../domains/safety/worker-permit.js";
import type { ToolProfileName } from "../tools/profiles.js";
import type { TaskWorktree } from "../tools/task-worktree.js";
import type { AgentLedgerPort, WorkerExtensionHook, WorkerGrantRequestFrame } from "../worker/protocol.js";
import type {
	WorkerBudget,
	WorkerEscalationConfig,
	WorkerPromptMessage,
	WorkerProtectedArtifactState,
} from "../worker/spec-contract.js";
import type { WorkerDecisionBinding } from "../worker/stdin-demux.js";
import type { AgentEvent, AgentMessage } from "./types.js";
import type { PancodeWorkerEvent } from "./worker-events.js";
import type { WorkerHookTransport } from "./worker-extension-hooks.js";

export interface WorkerRunInput {
	telemetryContext?: WorkerTelemetryContext;
	sessionId?: string;
	systemPrompt: string;
	contextSeed?: WorkerContextSeed;
	dynamicPromptMessages?: ReadonlyArray<WorkerPromptMessage>;
	agentId: string;
	task: string;
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	apiKey?: string;
	/** Local PanCode credential owner; remote workers receive only the resolved access credential. */
	authProfile?: string;
	credentialExpiresAt?: number;
	thinkingLevel?: ThinkingLevel;
	/** JSON Schema enforced by the native llama.cpp request payload. */
	responseSchema?: Record<string, unknown>;
	/** Generated context should not vary with local server sampling defaults. */
	sampling?: "deterministic";
	/** Epoch ms when exploration ends; later rounds are the terminal handoff only. */
	synthesisAt?: number;
	/**
	 * The run's sealed limits (fleet M8): handback shares, wall clock, response bound, refusal limit. A direct caller
	 * without them keeps the role table, the settings' response bound and no wall clock.
	 */
	limits?: RunLimits;
	/** The dispatcher's cache lane for this run; absent means the first. */
	cacheLane?: number;
	/** Orchestrator-resolved runtime decision carried on the WorkerSpec. */
	runtimeResolution?: RuntimeTargetSnapshot;
	/**
	 * Terminal contract this run's recipe declares. The worker validates its own
	 * final result against it and spends bounded repair rounds before exiting,
	 * so a model that gathered the right evidence is not failed by the
	 * orchestrator for a recoverable shape mistake it was never told about.
	 */
	resultContract?: ResultContract;
	/** Host-declared internal helper protocol; never inferred from agent names. */
	helperResult?: true;
	/** What this run delivers; decides which delivery tools the reserve keeps live. */
	product?: AgentProduct;
	/**
	 * Where the run sits in the work graph, resolved once at dispatch. It alone picks the share of the usable window
	 * at which the run enters its handback round (M3); a run without one (a direct caller) keeps the CLI-H3 host turn.
	 */
	role?: RunRole;
	/**
	 * The run's agent-ledger port, present only when this run was dispatched
	 * alongside concurrent peers. The ledger tool is registered either way.
	 */
	agentLedger?: AgentLedgerPort;
	/** Workspace root the result contract resolves relative paths against. */
	cwd?: string;
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
	/** Dispatch-resolved agent phase policy and independent hard attempt cap. */
	budget: WorkerBudget;
	/**
	 * Dispatch-time tool profile that narrowed `allowedTools`. Carried so
	 * black-box external CLI runtimes (claude-code, antigravity) that cannot
	 * mediate per-tool calls can refuse a narrowing profile instead of silently
	 * running their full builtin surface. Undefined or "full-agent" imposes no
	 * narrowing.
	 */
	toolProfile?: ToolProfileName;
	/** Worker-safe declarative middleware metadata captured by the orchestrator. */
	middlewareSnapshot?: MiddlewareSnapshot;
	/** Frozen parent-session protection state, enforced before every mediated call. */
	protectedArtifactState?: WorkerProtectedArtifactState;
	/** The dispatching session's extension tool hooks and the round trip that runs them there. */
	extensionHookHost?: { hooks: ReadonlyArray<WorkerExtensionHook>; request: WorkerHookTransport };
	signal?: AbortSignal;
	noSkills?: boolean;
	turnConstraints?: import("../core/turn-constraints.js").TurnConstraints;
	skillPaths?: ReadonlyArray<string>;
	/** Recipe-bound skill names; context(scope=skills) admits exactly these for the run. */
	agentSkills?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/** Non-stall posture for permission-requiring tool calls; default "deny". */
	onPermission?: "deny" | "fail" | "escalate";
	/** The permit allowance behind onPermission, so a denial can say why it was not routed. */
	permitAllowance?: WorkerPermitAllowance;
	/** The permit's MCP attestation; the worker launches only what it names. */
	mcp?: WorkerMcpAttestation;
	/**
	 * The permit's Git allowance, whether its tools already execute code, and
	 * the task worktree the host created for this run, if any (Phase C).
	 * Absent means git inspect: every Git mutation asks.
	 */
	taskGit?: { allowance: WorkerGitAllowance; executePermitted: boolean; taskWorktree?: TaskWorktree };
	/** Escalation bounds, honored only when onPermission="escalate". */
	escalation?: WorkerEscalationConfig;
	/**
	 * Carries a main-routed ask's effect descriptor to the host on the control
	 * lane (Phase D). Wired only when `escalation.grant` is present.
	 */
	emitGrantRequest?: (request: WorkerGrantRequestFrame) => void;
	/** Dispatch-owned restriction on tool admission for this run. */
	readOnly?: boolean;
	/**
	 * A subprocess harness starts with its documented switch that skips the repository's instruction files: the
	 * dispatch compiled their rules that still hold into the run's project message. Other runtimes ignore it.
	 */
	skipRepositoryInstructions?: boolean;
	/** Internal external-connector posture. Native workers ignore it and always use default. */
	autonomy?: import("../domains/safety/autonomy.js").AutonomyLevel;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Enforced at the shared worker safety seam (createWorkerSafety) so both the
	 * native registry and the Claude SDK hook path block out-of-root writes.
	 */
	writeRoots?: ReadonlyArray<string>;
	/** The envelope's word that the run's commands cannot leave a change outside `writeRoots` (fleet M7). */
	writeRootsCommandsBounded?: boolean;
	/** Store tags this run may put into and the dispatch run its records name (M-31). */
	storeGrant?: { tags: ReadonlyArray<string>; dispatchRunId?: string };
	/**
	 * Information-flow restrictions the inherited context carries. Every model
	 * request of this run is judged against them and against what the run's
	 * own reads add, at the same seam the main agent uses.
	 */
	flowRestrictions?: FlowRestrictionSet;
	flowPolicy?: WorkerFlowPolicyInput;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	/** A parent stop can name a closed owner channel for the refusal text; `internal` is the worker's own failure. */
	abort(cause?: "internal" | "owner_channel_closed"): void;
	/**
	 * Queue operator guidance on a runtime that exposes a live input API. Absent
	 * for single-shot subprocess runtimes. Returns true only after the runtime
	 * accepts the input; a steer that races run completion may return false.
	 */
	steer?(text: string): boolean | Promise<boolean>;
	/**
	 * Apply a decision to a parked escalation. Present only on native pi-agent
	 * workers (the runtimes with a registry park loop); external runners omit
	 * it. Returns false when the requestId is unknown or already resolved
	 * (duplicate), so callers can drop the line without crashing. Under a
	 * main-authority permit the decision must carry a binding that names this
	 * attempt and the parked call's argument digest; one that does not denies
	 * the call.
	 */
	resolvePermission?(
		requestId: string,
		decision: "approve" | "deny",
		binding?: WorkerDecisionBinding,
		cause?: "timeout",
	): boolean;
	/**
	 * The parent that owns this ask's window answers within `holdMs`: move the
	 * backstop to just past that, within the hold limit. Present on the same
	 * runtimes as resolvePermission. Returns false when the ask is not the parked
	 * one or the parent does not own its window.
	 */
	holdPermission?(requestId: string, holdMs: number): boolean;
}

export type WorkerEventEmit = (event: AgentEvent | PancodeWorkerEvent) => void;
