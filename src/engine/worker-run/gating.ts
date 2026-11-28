// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * What gates a native worker run's tool calls: its budget and delivery tools, the loop guard and
 * read-streak rule, the observation store, the information-flow ledger, the protected-artifacts
 * guard, the task gates, and the tool registry those registrations compose.
 */

import { ToolNames } from "../../core/tool-names.js";
import { createWorkerObservationStore } from "../../domains/context/worker/recall.js";
import { workerEconomicsView } from "../../domains/dispatch/economics-view.js";
import { createReadStreakRegistration } from "../../domains/middleware/read-streak.js";
import { createMiddlewareToolChoiceControl } from "../../domains/middleware/tool-choice-control.js";
import { mergeFlowRestrictions } from "../../domains/safety/information-flow.js";
import { createProtectedArtifactsRegistration } from "../../domains/safety/protected-artifacts-registration.js";
import { sessionChangesTree } from "../../domains/safety/run-effects.js";
import { seedRecallLineage } from "../../lib/worker-wire/context-seed.js";
import type { WorkerBudget } from "../../lib/worker-wire/spec-contract.js";
import { createWorkerGitContext } from "../../tools/git-exec.js";
import type { RegistryDeps } from "../../tools/registry/contract.js";
import { clearTaskGates, configureWorkerTaskGates, contractDeclaresTaskGates } from "../../tools/verify/task-gates.js";
import {
	callRepeatsAsRead,
	createLoopGuardRegistration,
	resolveDeliveryTools,
	workerLoopBlockBudget,
} from "../loop-guard.js";
import type { PancodeWorkerEvent } from "../worker-events.js";
import { createWorkerExtensionHookRegistrations } from "../worker-extension-hooks.js";
import type { WorkerRunInput } from "../worker-run-types.js";
import { createWorkerToolRegistry } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

/** Return the admitted worker specification budget unchanged. */
function resolveWorkerRuntimeBudget(input: Pick<WorkerRunInput, "budget">): WorkerBudget {
	return input.budget;
}
export function createWorkerGating(scope: WorkerRunScope) {
	const { input, emit, phase, safety, workerSettings, activeWorkerTools } = scope;
	const workerBudget = resolveWorkerRuntimeBudget(input);
	const deliveryTools = resolveDeliveryTools(input.allowedTools, input.product);
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The model round that may only report: the one after the refusal limit tripped.

	const loopGuardRegistration = createLoopGuardRegistration({
		safety,
		readResultMaxBytes: workerSettings.context.toolResultMaxBytes,
		toolCallCap: workerBudget.hardCap,
		...(workerBudget.ceiling !== undefined ? { toolCallCeiling: workerBudget.ceiling } : {}),
		toolCallSoftLimit: workerBudget.toolCalls,
		// A worker's blocks all land in one run-long bucket, so the bound on
		// them is a statement about this run's length, not about a turn.
		turnBlockBudget: workerLoopBlockBudget(workerBudget.toolCalls),
		turnSynthesisLockout: workerBudget.synthesis,
		// Once locked, the next model round is forced text-only at the
		// request level. The lockout directive alone relies on model compliance.
		onSynthesisLockout: () => {
			if (workerBudget.synthesis) phase.lockTools("tools");
		},
	});
	const seedLineage = seedRecallLineage(input.contextSeed);
	// X3: a writer worker gets the main agent's read-streak rule. Its first note rides the tool result; the second
	// step is this run's thrash host note, with the streak as its cause. Writing means holding edit or write, not
	// merely a delivery tool: an orientation run delivers through code_nav.
	const workerCanWrite =
		input.readOnly !== true && activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write);
	const workerCanPlan = activeWorkerTools.includes(ToolNames.Tasks);
	const readStreakRegistration =
		deliveryTools.length > 0 && workerCanWrite
			? createReadStreakRegistration({
					// The worker's configured scratch roots count as scratch, as its run-effects recorder reads them.
					classifiers: { repeatsAsRead: callRepeatsAsRead, changesTree: sessionChangesTree(() => workerSettings) },
					workspaceRoot: () => input.cwd ?? process.cwd(),
					surface: {
						canWrite: true,
						canPlan: workerCanPlan,
						canAsk: activeWorkerTools.includes(ToolNames.AskUser),
					},
					secondStep: (count) => {
						scope.readStreakEscalated = count;
					},
					// A later step of the same call (a chain's edit) that resets the streak withdraws the second step.
					onReset: () => {
						scope.readStreakEscalated = 0;
						scope.streakNoteOpen = false;
					},
					// X7: a worker is never continued by an operator, so a streak past every note meets the decision gate,
					// and its second refused round ends the run as a bound does, with its own outcome code.
					unattended: true,
					stall: (detail) => {
						emit({ type: "pancode_run_outcome", payload: { outcomeCode: "exploration_stalled" } });
						if (scope.workerBoundAborted) return;
						scope.workerBoundAborted = true;
						phase.seal(`exploration_stalled: ${detail}`);
						process.stderr.write(`[worker] read-streak gate: ${detail}; stopped the run\n`);
						scope.abortWorkerForBound?.();
					},
				})
			: null;
	const observations = createWorkerObservationStore(input.telemetryContext?.runId, seedLineage);
	// Run-scoped ledger: the inherited set plus what this run's reads add. It
	// lives in memory only; every growth is reported to the parent at once and
	// sealed in the receipt, so the parent's session ledger absorbs it before
	// any output of this run reaches its context.
	scope.runFlow = input.flowRestrictions ?? null;
	const workerFlow: NonNullable<RegistryDeps["flow"]> = {
		mcpTransport: (tool) => scope.workerMcp?.transportOf(tool) ?? null,
		carried: () => scope.runFlow,
		refusal: () => null,
		absorb: (set) => {
			const before = scope.runFlow?.restrictions.length ?? 0;
			scope.runFlow = mergeFlowRestrictions(scope.runFlow, set);
			// Every growth reaches the parent on the receipt-bearing lane, so the
			// label precedes any output derived from the read.
			if (scope.runFlow !== null && scope.runFlow.restrictions.length > before) {
				emit({ type: "pancode_flow_restrictions", payload: { set: scope.runFlow } } as PancodeWorkerEvent);
			}
		},
	};
	// The protected-artifacts guard starts from the parent-session snapshot
	// and has no persistence sink. It can still absorb worker-local
	// protect_path effects from snapshot rules and the dispatching session's
	// extension hooks for the rest of this run.
	const protectedArtifacts = createProtectedArtifactsRegistration({
		...(input.protectedArtifactState !== undefined
			? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// A checker (verifier, debugger) has no shell; the gate commands its task
	// names are what it may run through verify (task-gates.ts). Every other role sees none.
	if (contractDeclaresTaskGates(input.resultContract?.kind)) {
		configureWorkerTaskGates(input.task);
	} else {
		clearTaskGates();
	}
	const registry = createWorkerToolRegistry(
		input.middlewareSnapshot,
		safety,
		{
			...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
			...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
			...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
			...(input.mcp?.attestation.skills !== undefined ? { mcpSkills: input.mcp.attestation.skills } : {}),
		},
		// Workers run unattended, so the loop guard carries the hard tool-call
		// cap in addition to repetition blocking, plus the synthesis lockout:
		// after the loop-block budget the worker is told to report from what it
		// gathered instead of burning the lifetime cap on a retry spiral, and
		// the bounded backstop reason is watched in telemetry.onFinish below to
		// abort a worker that keeps calling tools anyway.
		[
			loopGuardRegistration,
			...(readStreakRegistration !== null ? [readStreakRegistration] : []),
			protectedArtifacts,
			// The dispatching session's extension gates, run there for each call they match.
			...(input.extensionHookHost !== undefined
				? createWorkerExtensionHookRegistrations(input.extensionHookHost.hooks, input.extensionHookHost.request)
				: []),
		],
		input.readOnly,
		(effects) => middlewareToolChoice.apply(effects),
		input.agentLedger === undefined
			? undefined
			: {
					read: () => input.agentLedger?.read() ?? null,
					post: (body) => input.agentLedger?.post(body, scope.runFlow ?? undefined) ?? { ok: false, reason: "no-ledger" },
				},
		observations.recall,
		input.taskGit !== undefined
			? createWorkerGitContext({
					allowance: input.taskGit.allowance,
					executePermitted: input.taskGit.executePermitted,
					cwd: input.cwd ?? process.cwd(),
					...(input.taskGit.taskWorktree !== undefined ? { taskWorktree: input.taskGit.taskWorktree } : {}),
				})
			: undefined,
		input.permitAllowance?.executeAutonomy,
		workerFlow,
		input.mcp !== undefined
			? (registry) => {
					const { attestation: admitted, createSource } = input.mcp as NonNullable<WorkerRunInput["mcp"]>;
					// Declarations and trust are read from the project root admission
					// used, never from a task worktree that holds neither, and nothing
					// this run observes is written back to the operator's catalog. The
					// servers themselves start in this run's tree, under its sandbox:
					// the task worktree's root, never the subdirectory a dispatch from
					// one gives as cwd. Without a task worktree the cwd is already the
					// tree root admission resolved, including a compete candidate's own
					// worktree, whose source checkout lies outside its write roots.
					scope.workerMcp = createSource({
						cwd: admitted.projectRoot,
						launchRoot: input.taskGit?.taskWorktree?.path ?? input.cwd ?? process.cwd(),
						registry,
						persistCatalog: false,
						admitted,
						// A worker reads the store and writes only the tags its dispatch granted.
						store: { writable: false, ...(input.storeGrant !== undefined ? { grant: input.storeGrant } : {}) },
					});
					return scope.workerMcp;
				}
			: undefined,
		(effects, hookInput) => protectedArtifacts.absorbAwaited(hookInput, effects),
		input.storeGrant,
		async () => workerEconomicsView(input.limits),
	);

	return {
		workerBudget,
		deliveryTools,
		middlewareToolChoice,
		loopGuardRegistration,
		seedLineage,
		workerCanWrite,
		workerCanPlan,
		readStreakRegistration,
		observations,
		registry,
	};
}
