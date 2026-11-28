// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { TSchema } from "typebox";
import { normalizePromptHint } from "../core/prompt-hint.js";
import type { ToolName } from "../core/tool-names.js";
import type { ToolPlacement } from "../core/tool-surface.js";
import type { ToolCallLanding } from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { ImageContent } from "../engine/types.js";
import type { DispatchPlanView } from "./dispatch-plan.js";
import type { ToolPresentationPolicy } from "./presentation.js";
import type { HostEffectCall, OutboundFile, ToolInvokeOptions } from "./registry-contract.js";
import type { ToolResultDisposition } from "./result-disposition.js";

export type ToolExecutionMode = "sequential" | "parallel";

type ToolSourceScope = "core" | "domain";

export type ToolPromptHintRole = "session" | "worker" | "bound-worker";

interface ToolPromptHintVariants {
	session?: string;
	worker?: string;
	boundWorker?: string;
}

type ToolPromptHintMetadata = string | ToolPromptHintVariants;

/** Worked examples, never part of the permanently attached tool schema. */
export interface ToolUsageExample {
	goal: string;
	args: Readonly<Record<string, unknown>>;
	/** Also show this one call in the reachable capability's compact orientation. */
	startup?: boolean;
}

/** Resolve one tool's guidance for the exact prompt role being compiled. */
export function resolveToolPromptHint(
	hint: ToolPromptHintMetadata | undefined,
	role: ToolPromptHintRole,
): string | undefined {
	if (typeof hint === "string") return normalizePromptHint(hint);
	if (!hint) return undefined;
	const selected =
		role === "session" ? hint.session : role === "bound-worker" ? (hint.boundWorker ?? hint.worker) : hint.worker;
	return normalizePromptHint(selected);
}

export interface ToolSourceInfo {
	owner?: import("../core/package-identity.js").PackageIdentity;
	path: string;
	scope: ToolSourceScope;
	/** Verified installed capability identity, when this is a harness extension tool. */
	extension?: import("../domains/extensions/types.js").ExtensionProvenance;
}

interface ToolResultSizePolicy {
	kind: "exact" | "bounded" | "summary" | "truncate";
	maxBytes?: number;
	/** Combined image and text payload cap when it differs from the text cap (an MCP screenshot); defaults to maxBytes. */
	imageMaxBytes?: number;
	/** Scratch retention ceiling for this tool; defaults to the generic 10 MiB cap. */
	offloadMaxBytes?: number;
	followUpHint?: string;
}

export interface ToolMetadata {
	/** False keeps a contextual capability discoverable without adding it to the session startup prompt. */
	startupPrompt?: boolean;
	/** Short statement of the tool's purpose for audit/UI surfaces. */
	objective: string;
	/** Stable UI label shown in compact renderers. */
	uiLabel: string;
	/** Read-only idempotent MCP polling: bounded by call budgets rather than repetition. */
	repeatableRead?: boolean;
	/**
	 * Declared by an api 2 extension tool: the call changes no state. The loop
	 * guard reads any other successful extension call as a possible mutation
	 * that resets identical-call counts (F-C13). Absent on every other tool.
	 */
	readOnly?: boolean;
	/** Declared by an api 2 extension tool: identical arguments have the same effect, so a verbatim repeat is a loop candidate. */
	idempotent?: boolean;
	/** Expected result-size behavior at the registry boundary. */
	resultSizePolicy: ToolResultSizePolicy;
	/** Independent operator-presentation and model-context policy for this result. */
	resultDisposition?: ToolResultDisposition;
	/**
	 * One sentence of usage guidance rendered when this tool is on the frozen
	 * surface. A string applies to every role; variants keep session consent
	 * rules out of ordinary and recipe-bound workers. Most tools need none.
	 */
	promptHint?: ToolPromptHintMetadata;
	/** Compact capability orientation for coordinators, even when its schema is behind gateway. */
	discoveryHint?: string;
	/** Small worked calls disclosed by the gateway and checked against parameters. */
	examples?: ReadonlyArray<ToolUsageExample>;
	/**
	 * How transcript surfaces present this tool's block under Standard output style.
	 * Optional: tools that declare nothing fold like every other tool.
	 */
	presentation?: ToolPresentationPolicy;
}

export interface ToolConfirmation {
	ruleId: string;
	detail: string;
	hints: ReadonlyArray<string>;
}

/** What a per-call confirmation may depend on besides the arguments: the session the call runs in, as `run` sees it. */
export interface ToolConfirmationContext {
	sessionId?: string;
}

export interface ToolSpec {
	name: ToolName;
	description: string;
	sourceInfo?: ToolSourceInfo;
	metadata?: ToolMetadata;
	/**
	 * Which surface carries this tool: `direct` attaches its schema on every
	 * turn, `gateway` hides it behind `gateway` find/describe/call. Absent means
	 * the name's placement in src/core/tool-surface.ts. Placement changes what the
	 * model sees, never admission: `invoke` runs any registered spec by name.
	 */
	placement?: ToolPlacement;
	/**
	 * TypeBox schema advertised to the model so it knows which named
	 * parameters the tool accepts. Must be a Type.Object(...). Runtime
	 * validation still happens inside `run()`, so the schema is advisory
	 * to the model, not an enforcement boundary.
	 */
	parameters: TSchema;
	/** Smaller attached schema; canonical validation and gateway describe retain parameters. */
	modelParameters?: TSchema;
	/**
	 * What `modelParameters` requires beyond `parameters`: `prepare` fills it before
	 * the wire schema validates a call, `restore` removes it before the canonical
	 * schema and the tool body see the call.
	 */
	modelArguments?: {
		prepare(args: Record<string, unknown>): Record<string, unknown>;
		restore(args: Record<string, unknown>): Record<string, unknown>;
	};
	/** Base action class for this tool when arguments are trivial. */
	baseActionClass: ActionClass;
	/**
	 * The base class under a read-only ceiling, when the base class rests on
	 * something the operator did not set: an MCP tool classed read only by
	 * the server's own readOnlyHint.
	 */
	readOnlyActionClass?: ActionClass;
	/** A safety-net confirmation required at every autonomy level. */
	confirmationRuleId?: string;
	/**
	 * The same rail decided per call, for a tool whose arguments decide whether
	 * the operator must confirm. Wins over `confirmationRuleId` when it returns one.
	 */
	confirmationFor?(args: Record<string, unknown>, context?: ToolConfirmationContext): ToolConfirmation | undefined;
	/** Harness-owned projection of executable effects for the safety engine. Never package-supplied code. */
	safetyCall?(args: Record<string, unknown>): ClassifierCall | undefined;
	/**
	 * Per-tool execution mode. Read-only tools set `"parallel"` so the model
	 * can batch scans; mutating or filesystem-racing tools set `"sequential"`
	 * so two `bash` or `edit` calls in the same batch never run concurrently.
	 */
	executionMode?: ToolExecutionMode;
	/**
	 * True for a tool whose abort only stops a local process or wait it started, leaving nothing half-done: in the
	 * main session a steer the operator queued while it runs ends the call after a short grace period (FX-32).
	 */
	steerInterruptible?: true;
	/**
	 * Optional argument normalizer applied before the tool body (and its own
	 * internal validation). Mirrors pi's `prepareArguments`: lets a tool accept
	 * the common weak-model argument shapes (legacy top-level fields, a
	 * JSON-string array) without hand-parsing inside every `run`. Must be pure
	 * and idempotent; a throwing normalizer is ignored and the raw args pass
	 * through. Tools that also want direct `run` calls normalized should invoke
	 * the same function at the top of `run`.
	 */
	prepareArguments?(args: Record<string, unknown>): Record<string, unknown>;
	/**
	 * Resolve an argument-sensitive canonical disposition after normalization
	 * and before execution. The registry applies the result exactly once after
	 * middleware has annotated the terminal result.
	 */
	resolveResultDisposition?(
		args: Record<string, unknown>,
		declared: ToolResultDisposition | undefined,
	): ToolResultDisposition | undefined;
	/**
	 * Synchronous admission planner. Unlike `prepareArguments`, this runs before
	 * safety/autonomy mapping so approval-sensitive tools can attach the exact
	 * immutable artifact—and provisional resources—that admission and execution
	 * share. Resource owners must pair it with `disposeAdmissionArguments`.
	 */
	prepareAdmissionArguments?(args: Record<string, unknown>): Record<string, unknown>;
	/**
	 * Awaited before `prepareAdmissionArguments` for facts admission needs that only an
	 * async read can give, such as whether a remote store blob exists. It returns the
	 * arguments admission and execution then see, and never throws.
	 */
	resolveAdmissionFacts?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** Release provisional resources when prepared admission is denied or execution returns. */
	disposeAdmissionArguments?(args: Record<string, unknown>): void;
	/** Trusted admission artifact renderer used by policy after preparation. */
	describeDispatchPlan?(args: Record<string, unknown>): DispatchPlanView;
	/**
	 * Whether a before_tool rewrite of prepared admission arguments provably
	 * narrows the original's authority, so an operator approval of the original
	 * carries over to it (WX2). Absent means a rewrite never keeps an approval.
	 */
	rewriteNarrows?(original: Record<string, unknown>, rewritten: Record<string, unknown>): boolean;
	/**
	 * Host commands this call will run as its caller outside its own body, read
	 * from prepared admission arguments. Each is admitted as the direct call it
	 * stands for, at the caller's autonomy and never under a one-shot grant for
	 * this call. Any that would park or be blocked refuses this call outright,
	 * with a hard block reported first (F6).
	 */
	hostEffectCalls?(args: Record<string, unknown>): ReadonlyArray<HostEffectCall>;
	/**
	 * The files this call sends off the host, read from prepared admission
	 * arguments: an MCP tool's file arguments. A call that sends any is
	 * admitted as outward and never as read, the approval shows each
	 * consequence, and each source's information-flow labels go with the call.
	 */
	outboundFiles?(args: Record<string, unknown>): ReadonlyArray<OutboundFile>;
	/**
	 * Where this call lands, read from prepared admission arguments, for the
	 * awaited hook phase. Path-taking tools that resolve against the process
	 * cwd need none: the registry resolves their `path` itself (`pathToolLanding`).
	 */
	describeHookLanding?(args: Record<string, unknown>): ToolCallLanding | null;
	/** Execute the tool. Only called after admission. */
	run(args: Record<string, unknown>, options?: ToolInvokeOptions): Promise<ToolResult>;
}

export type ToolResultDetails = Record<string, unknown>;

export type ToolResult =
	| {
			kind: "ok";
			output: string;
			/** Bounded visual evidence accompanying the mandatory text result. */
			images?: ImageContent[];
			details?: ToolResultDetails;
			/** Internal registry projection consumed only by the agent-tool adapter. */
			modelContext?: string;
			/**
			 * Early-termination hint propagated to pi-agent-core's
			 * `AgentToolResult.terminate`. When every finalized tool result in
			 * the current batch sets this to true, the agent loop stops without
			 * a follow-up LLM call. Used by terminal artifact writers where
			 * writing the artifact is the whole turn.
			 */
			terminate?: boolean;
	  }
	| { kind: "error"; message: string; details?: ToolResultDetails; modelContext?: string };
