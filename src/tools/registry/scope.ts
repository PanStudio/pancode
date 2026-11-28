// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ToolName } from "../../core/tool-names.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { GitHookDriftReport } from "../../domains/safety/hook-drift.js";
import type {
	AdmissionReviewEvent,
	PermissionRequiredMeta,
	RegistryDeps,
	RegistryVerdict,
	ToolBoundaryReminder,
	ToolInvokeOptions,
} from "../registry-contract.js";
import type { createShellEgress, OperatorAskQueue } from "../registry-operator-asks.js";
import type { ToolResultDigest } from "../result-disposition.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import type { createRegistryAttempts } from "./attempts.js";
import type { createFlowGates } from "./flow.js";
import type { createOperatorScopes } from "./operator-scope.js";
import type { createSnapshotGate } from "./snapshot.js";

export interface ParkedCall {
	readRootApproval?: true;
	call: ClassifierCall;
	decision: SafetyDecision;
	meta: PermissionRequiredMeta;
	resolve: (verdict: RegistryVerdict) => void;
	/**
	 * Seals the park at the instant the operator's decision lands, before the
	 * admitted body runs. Idempotent, so the resolve paths that never reach a
	 * body still report exactly one park.
	 */
	closePark: () => void;
	options?: ToolInvokeOptions;
	abortCleanup?: () => void;
	/** The hook drift a `git-hooks-changed` park showed the operator. */
	hookDrift?: GitHookDriftReport;
	/** Set when a before_tool hook's `request_approval` parked the call: what its hook stage decided. */
	settledHookEffects?: ReadonlyArray<MiddlewareEffect>;
	/** Settles an operator-only ask once the operator approves it (a contained command's egress ask). */
	approve?: (requestedBy: string | undefined) => void;
}

export type ContainedRoots = NonNullable<NonNullable<SafetyDecision["policy"]>["shellSandbox"]>;

/**
 * What createRegistry shares with the factories in this directory. Its collections are plain fields, fixed before
 * any factory runs. Each factory's functions are getters over createRegistry's consts, so a read before one exists
 * throws as it did when they were closures of one function.
 */
export interface RegistryScope {
	readonly deps: RegistryDeps;
	readonly tools: Map<ToolName, ToolSpec>;
	readonly hookSettled: WeakMap<ToolInvokeOptions, ReadonlyArray<MiddlewareEffect>>;
	readonly parked: ParkedCall[];
	readonly permissionListeners: Set<
		(call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void
	>;
	readonly askQueue: OperatorAskQueue;
	readonly shellEgress: ReturnType<typeof createShellEgress>;
	readonly admissionReviewListeners: Set<(event: AdmissionReviewEvent) => void>;
	readonly bodyStartListeners: Set<(toolCallId: string) => void>;
	readonly boundaryReminderListeners: Set<
		(reminders: ReadonlyArray<ToolBoundaryReminder>, input: MiddlewareHookInput) => void
	>;
	readonly operatorYoloScope: ReturnType<typeof createOperatorScopes>["operatorYoloScope"];
	readonly withOperatorScope: ReturnType<typeof createOperatorScopes>["withOperatorScope"];
	readonly hostEffectScope: ReturnType<typeof createOperatorScopes>["hostEffectScope"];
	readonly admitHostEffect: ReturnType<typeof createOperatorScopes>["admitHostEffect"];
	readonly containedEffectsSandbox: ReturnType<typeof createOperatorScopes>["containedEffectsSandbox"];
	readonly jobNeedsContainment: ReturnType<typeof createOperatorScopes>["jobNeedsContainment"];
	readonly shellSandboxPolicy: ReturnType<typeof createOperatorScopes>["shellSandboxPolicy"];
	readonly trueYolo: ReturnType<typeof createOperatorScopes>["trueYolo"];
	readonly outboundFlowViolation: ReturnType<typeof createFlowGates>["outboundFlowViolation"];
	readonly fileTargetFlowViolation: ReturnType<typeof createFlowGates>["fileTargetFlowViolation"];
	readonly sourceAdmissionRefusal: ReturnType<typeof createFlowGates>["sourceAdmissionRefusal"];
	readonly snapshotBeforeBody: ReturnType<typeof createSnapshotGate>["snapshotBeforeBody"];
	readonly recordRegistryDisposition: ReturnType<typeof createRegistryAttempts>["recordRegistryDisposition"];
	readonly observeBlockedAttempt: ReturnType<typeof createRegistryAttempts>["observeBlockedAttempt"];
	readonly observeRejectedAttempt: ReturnType<typeof createRegistryAttempts>["observeRejectedAttempt"];
	readonly guardOverrideForRejectedAttempt: ReturnType<typeof createRegistryAttempts>["guardOverrideForRejectedAttempt"];
	readonly guardBlocked: ReturnType<typeof createRegistryAttempts>["guardBlocked"];
	readonly runToolHook: (
		hook: "before_tool" | "after_tool",
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
		result?: ToolResult,
		resultDigest?: ToolResultDigest,
	) => ReadonlyArray<MiddlewareEffect>;
}
