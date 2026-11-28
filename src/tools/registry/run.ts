// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { recordUncontainedShell } from "../../core/sandbox/launch-record.js";
import { invalidateWorkspaceSecretScans } from "../../core/sandbox/secret-files.js";
import type { SandboxLaunchWhy } from "../../core/sandbox/types.js";
import { type ToolName, ToolNames } from "../../core/tool-names.js";
import type { MiddlewareEffect, ToolCallLanding } from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { escapeScopeOptionConsequence, escapeScopeOptionLabel } from "../../domains/safety/escape-scope.js";
import {
	type FlowRestrictionSet,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
} from "../../domains/safety/information-flow.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import { approvalGiver } from "../approval-note.js";
import { settleObservationCharge } from "../observation.js";
import type { ToolResultDigest } from "../result-disposition.js";
import { shapeToolResult, toolResultDigestFor } from "../result-shaping.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import {
	disposeAdmissionArgs,
	hookLanding,
	prepareAdmissionCall,
	prepareToolArgs,
	resolveToolResultDisposition,
} from "./call-prep.js";
import type { ExecutionProvenance, RegistryDeps, RegistryVerdict, ToolInvokeOptions } from "./contract.js";
import { applyToolResultEffects, firstBlockToolEffect, guardRuleIds } from "./hook-effects.js";
import { nestedBlockedVerdict, nestedChainResults, nestedExecutions, recordedExecution } from "./nested-calls.js";
import type { RegistryScope } from "./scope.js";
import {
	blockedVerdict,
	FLOW_BLOCK_REASON_CODE,
	FLOW_RESTRICTIONS_DETAIL,
	flowBlockedVerdict,
	SNAPSHOT_REQUIRED_REASON_CODE,
	withFlowRestrictions,
} from "./verdicts.js";

/** Tools whose completion may have written in the workspace, so the cached secret-mask scan is renewed. */
const WORKSPACE_WRITING_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Write,
	ToolNames.Edit,
	ToolNames.Bash,
	ToolNames.RunScript,
	// A run script has Node; it may write files.
	ToolNames.Browser,
]);
/**
 * A call reaching execution without the main-session sandbox. A job command admitted only contained is refused
 * (true). Otherwise a main-session bash or run_script call journals that the session's shell ran uncontained, once per
 * reason, so no record of the session reads as contained by omission.
 */
function refusesUncontainedLaunch(
	deps: RegistryDeps,
	spec: ToolSpec,
	options: ToolInvokeOptions,
	jobNeedsContainment: () => boolean,
): boolean {
	if (options.shellSandbox !== undefined) return false;
	if (jobNeedsContainment()) return true;
	if ((deps.principal ?? "main") !== "main") return false;
	if (spec.name !== ToolNames.Bash && spec.name !== ToolNames.RunScript) return false;
	if (deps.sandboxState === undefined || deps.containment === undefined) return false;
	const readOnly = deps.readOnly === true || options.turnConstraints?.readOnly === true;
	const hasBackend = readOnly ? deps.containment().readOnlySandbox === true : deps.containment().sandbox;
	const state = deps.sandboxState();
	const why: SandboxLaunchWhy =
		state.mode === "off"
			? "sandbox-off"
			: !hasBackend
				? "no-backend"
				: !readOnly && (deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) === "yolo"
					? "unconfined-opt-in"
					: "operator-authority";
	recordUncontainedShell({
		caller: readOnly ? "main-read-only" : "main",
		why,
		mode: state.mode,
		backend: state.backend,
	});
	return false;
}

/**
 * Running an admitted call: the tool body with its hooks, rewrite, snapshot and result shaping, the body-start
 * notice, the escape scope offer on ask_user, and the admit-park-or-run step every call goes through.
 */
export function createRegistryRun(reg: RegistryScope) {
	const { deps, tools, hookSettled, bodyStartListeners } = reg;
	const notifyBodyStart = (options: ToolInvokeOptions | undefined): void => {
		const toolCallId = options?.toolCallId;
		if (toolCallId === undefined || toolCallId.length === 0) return;
		for (const listener of bodyStartListeners) {
			try {
				listener(toolCallId);
			} catch {
				// A status listener's failure never stops the call.
			}
		}
	};

	const runSpec = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): Promise<RegistryVerdict> => {
		let resultDisposition = spec.metadata?.resultDisposition;
		// Admission prepared these arguments; a rewrite never takes over their cleanup.
		const admittedArgs = call.args ?? {};
		// An admitted rewrite carries its own prepared arguments, released alongside.
		let rewrittenArgs: Record<string, unknown> | undefined;
		/** When the body started, so an awaited after_tool hook learns how long it ran. */
		let bodyStartedAt: number | undefined;
		let execution: ExecutionProvenance = {};
		// Set when a hook's approval request handed the call to the ask route, which then owns its arguments.
		let handedOff = false;
		const bodyMs = (): number => (bodyStartedAt === undefined ? 0 : Math.round(performance.now() - bodyStartedAt));
		// Resolved once per admitted call, so the before_tool hook, the body and
		// the after_tool hook all mean the same landing (undefined: not yet resolved).
		let landing: ToolCallLanding | null | undefined;
		// A flow refusal records the decision it re-shapes, then settles as blocked.
		const flowBlocked = (reason: string): RegistryVerdict => {
			reg.recordRegistryDisposition(call, decision, "blocked", { reasonCode: FLOW_BLOCK_REASON_CODE });
			return { ...flowBlockedVerdict(decision, call.tool, reason), ...execution };
		};
		const withheld = (restrictions: FlowRestrictionSet | null, what: string): RegistryVerdict | null => {
			if (restrictions === null) return null;
			deps.flow?.absorb(restrictions, {
				tool: spec.name,
				...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
			});
			// A label that did not reach the ledger must not be outlived by the
			// content it labels: the transcript would then hold the bytes
			// without the restriction across a restart. The content is withheld
			// and the queued label is retried on the next ledger access.
			const unlabeled = deps.flow?.refusal() ?? null;
			return unlabeled === null ? null : flowBlocked(`${spec.name} ${what} withheld: ${unlabeled}`);
		};
		// Extension runtime after_tool hooks are awaited only when one matches this tool.
		const afterEffects = (
			result: ToolResult,
			digest: ToolResultDigest,
		): ReadonlyArray<MiddlewareEffect> | Promise<ReadonlyArray<MiddlewareEffect>> => {
			const syncAfter = reg.runToolHook("after_tool", spec, call, decision, options, result, digest);
			if (!deps.middleware?.hasAwaitedHook?.("after_tool", spec.name)) return syncAfter;
			const awaited = reg.runAwaitedToolHook(
				"after_tool",
				spec,
				call,
				decision,
				options,
				landing === undefined ? hookLanding(spec, call) : landing,
				syncAfter,
				result,
				digest,
				bodyMs(),
			);
			return awaited.then((effects) => [...syncAfter, ...effects]);
		};
		try {
			// Explicit information-flow violations are final at every autonomy
			// level, including yolo, and are decided before any hook can run the
			// body. Permitted here grants nothing: admission already ran. A policy
			// that cannot label sources refuses the source tools outright.
			// Yolo admits the transfer as well (#407); the source's label is still
			// absorbed below, so the session keeps the record of what it carried.
			const flowViolation = reg.trueYolo()
				? null
				: (reg.sourceAdmissionRefusal(spec, call) ?? reg.outboundFlowViolation(spec, call));
			if (flowViolation !== null) return flowBlocked(flowViolation);
			// A call a hook parked for approval already passed its hook stage; it runs on that stage's effects.
			const settled = options !== undefined ? hookSettled.get(options) : undefined;
			// The hook layer is the only control stage past safety admission. Guards
			// (loop, protected artifacts, dispatch dedup) are before_tool
			// registrations; the first block_tool effect decides the verdict. Keep
			// this gate inside the admission cleanup boundary: dispatch may already
			// own a provisional reservation by the time a guard blocks execution.
			let beforeEffects = settled ?? reg.runToolHook("before_tool", spec, call, decision, options);
			let block = settled !== undefined ? null : firstBlockToolEffect(beforeEffects);
			// Extension runtime hooks are awaited only when one matches this tool,
			// so a call nothing gates takes no extra turn of the event loop.
			if (settled === undefined && !block && deps.middleware?.hasAwaitedHook?.("before_tool", spec.name)) {
				landing = hookLanding(spec, call);
				const awaited = await reg.runAwaitedToolHook("before_tool", spec, call, decision, options, landing, beforeEffects);
				beforeEffects = [...beforeEffects, ...awaited];
				block = firstBlockToolEffect(awaited);
				const rewrite = block ? undefined : awaited.find((effect) => effect.kind === "rewrite_tool_input");
				if (rewrite?.kind === "rewrite_tool_input") {
					const rewritten = reg.admitRewrite(spec, call, rewrite, options);
					const carried = "carriedApproval" in rewritten ? rewritten.carriedApproval : undefined;
					if ("refusal" in rewritten) block = { kind: "block_tool", reason: rewritten.refusal, severity: "hard-block" };
					else {
						rewrittenArgs = rewritten.admitted.args ?? {};
						const judged = await reg.judgeRewrite(spec, call, rewritten, rewrite.source, options, beforeEffects);
						block = judged.block;
						if (block === null) {
							if (judged.landing !== undefined) landing = judged.landing;
							// The prepared rewrite runs, so the body and after_tool see what the
							// hooks judged and dispatch does not prepare it a second time.
							call = rewritten.admitted;
							decision = rewritten.decision;
							if (carried !== undefined && options?.approval !== undefined)
								options = { ...options, approval: { ...options.approval, carriedOver: carried } };
							beforeEffects = [
								...beforeEffects,
								{
									kind: "annotate_tool_result",
									message: `${spec.name} input rewritten by extension ${rewrite.source}: ${rewrite.reason}${carried !== undefined && options?.approval !== undefined ? `; ${approvalGiver(options.approval.requestedBy)} carried over because the rewrite only narrows the approved call` : ""}`,
									severity: "info",
								},
							];
						}
					}
				}
			}
			if (block) {
				const verdict = reg.guardBlocked(call, decision, block.reason, guardRuleIds.get(block));
				return block.redundantRepeat === true ? { ...verdict, redundantRepeat: true } : verdict;
			}
			// A hook asked the operator. A call that carries an approval already has
			// one; any other takes the route every ask takes (judge, refusals, card)
			// and, once released, runs on these effects.
			const approvalAsk =
				settled === undefined && options?.approval === undefined
					? beforeEffects.find((effect) => effect.kind === "request_approval")
					: undefined;
			if (approvalAsk?.kind === "request_approval") {
				if (rewrittenArgs !== undefined)
					return reg.guardBlocked(
						call,
						decision,
						`${spec.name} did not run: a hook asked for approval of a call an extension rewrote, and a rewritten call is not parked for approval (${approvalAsk.reason})`,
					);
				handedOff = true;
				const parkOptions: ToolInvokeOptions = { ...(options ?? {}) };
				hookSettled.set(parkOptions, beforeEffects);
				return await reg.routeAsk(
					call,
					call,
					reg.hookApprovalOutcome(call, decision, approvalAsk.reason),
					parkOptions,
					beforeEffects,
				);
			}
			// Recoverability point: admission allowed the call and no hook blocked it,
			// so a snapshot here precedes exactly the bodies that will run.
			const snapshot = await reg.snapshotBeforeBody(spec, call, decision, options);
			if (snapshot.missing !== null && decision.policy?.recoverable === true) {
				const reason = `${spec.name} did not run: it was admitted without approval because a workspace snapshot would undo it, and no complete snapshot could be taken (${snapshot.missing}). Take a route that discards nothing, or record the open decision for the operator.`;
				const verdict = blockedVerdict(decision, `${call.tool} blocked: no workspace snapshot`, reason, {
					kind: "block",
					reasonCode: SNAPSHOT_REQUIRED_REASON_CODE,
				});
				reg.recordRegistryDisposition(call, verdict.decision, "blocked", {
					reasonCode: SNAPSHOT_REQUIRED_REASON_CODE,
				});
				return verdict;
			}
			if (snapshot.note !== null) beforeEffects = [...beforeEffects, snapshot.note];
			try {
				const preparedArgs = prepareToolArgs(spec, call.args ?? {});
				resultDisposition = resolveToolResultDisposition(spec, preparedArgs);
				const {
					allowsObservationPath: _callerPathFilter,
					writeTargetViolation: _callerWriteCheck,
					gitContext: _callerGitContext,
					flowAdmitsUrl: _callerFlowAdmitsUrl,
					flowAdmitsFileTarget: _callerFlowAdmitsFileTarget,
					hookLanding: _callerHookLanding,
					operatorYolo: _callerOperatorYolo,
					shellSandbox: _callerShellSandbox,
					...callerOptions
				} = options ?? {};
				const allowsObservationPath = deps.safety.policy?.allowsObservationPath;
				const writeTargetViolation =
					spec.name === ToolNames.Artifact
						? (deps.safety.policy?.artifactTargetViolation ?? deps.safety.policy?.writeTargetViolation)
						: deps.safety.policy?.writeTargetViolation;
				// What this result will carry, decided from the path or tool name
				// before the body runs, so a link swapped in afterwards cannot
				// unlabel it and so the label exists before any screening.
				const ruleRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				if (landing === undefined && deps.middleware?.hasAwaitedHook?.("after_tool", spec.name))
					landing = hookLanding(spec, call);
				const executionOptions: ToolInvokeOptions = {
					...callerOptions,
					...(allowsObservationPath ? { allowsObservationPath } : {}),
					...(writeTargetViolation ? { writeTargetViolation } : {}),
					...(deps.principal === "worker" && deps.git !== undefined ? { gitContext: deps.git } : {}),
					...(reg.operatorYoloScope(deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== undefined &&
					deps.readOnly !== true &&
					options?.turnConstraints?.readOnly !== true
						? { operatorYolo: true as const }
						: {}),
					...(decision.policy?.shellSandbox !== undefined
						? { shellSandbox: reg.shellSandboxPolicy(decision.policy.shellSandbox, options) }
						: {}),
					...(landing !== undefined && landing !== null ? { hookLanding: landing } : {}),
					...(deps.flow !== undefined && !reg.trueYolo()
						? {
								flowAdmitsUrl: (url: string) => reg.outboundFlowViolation(spec, { tool: spec.name, args: { url } }),
								flowAdmitsFileTarget: (url: string) => reg.fileTargetFlowViolation(spec, call, url),
							}
						: {}),
				};
				// Fail closed: a job command admitted only contained never runs without its sandbox (XR-12).
				if (refusesUncontainedLaunch(deps, spec, executionOptions, () => reg.jobNeedsContainment(spec, call))) {
					const reason = `${spec.name} did not run: its command is admitted only in the sandbox, and the call reached execution without the sandbox policy.`;
					const verdict = blockedVerdict(decision, `${call.tool} blocked: contained command without its sandbox`, reason, {
						kind: "block",
						reasonCode: "host_effect_not_admitted",
					});
					reg.recordRegistryDisposition(call, verdict.decision, "blocked", { reasonCode: "host_effect_not_admitted" });
					return verdict;
				}
				bodyStartedAt = performance.now();
				execution = { executionStarted: true };
				notifyBodyStart(options);
				const result = await spec.run(preparedArgs, executionOptions);
				if (WORKSPACE_WRITING_TOOLS.has(spec.name)) invalidateWorkspaceSecretScans();
				// A body that delegated to a nested invocation the registry refused
				// (the gateway calling a denied capability) hands the refusal back
				// whole, and this call settles as that same blocked verdict: the
				// model, telemetry, and the ledger then see exactly what a direct
				// call to the capability would have produced.
				const nestedBlocked = nestedBlockedVerdict(result);
				const nested = nestedExecutions.get(result);
				if (nestedBlocked !== null) execution = recordedExecution(nestedBlocked);
				else if (nested !== undefined) {
					decision = nested.decision;
					execution = nested.execution;
				} else execution = nestedChainResults.get(result) ?? execution;
				// A trusted body (dispatch, monitor) labels what it carried back from
				// a worker's context; that label joins the source rule's own.
				const reportedRestrictions = result.details?.[FLOW_RESTRICTIONS_DETAIL];
				const sourceRestrictions = mergeFlowRestrictions(
					ruleRestrictions,
					isFlowRestrictionSet(reportedRestrictions) ? reportedRestrictions : null,
				);
				// The restriction enters the ledger before the result goes anywhere:
				// not to the screening classifier, not to the hooks, not to the model.
				// An error can quote the source, so it is labeled and absorbed too.
				const resultWithheld = withheld(sourceRestrictions, "result");
				if (resultWithheld !== null) {
					// Nothing of the result reaches the model, so the turn pool pays for none of it (C-17).
					settleObservationCharge(result, 0);
					return resultWithheld;
				}
				// A refusal settles only after its label is absorbed: an MCP server's
				// refusal quotes the server's own text, which the source rule labels
				// exactly as it would label a result.
				if (nestedBlocked !== null) return nestedBlocked;
				const labeled = withFlowRestrictions(result, sourceRestrictions);
				const after = afterEffects(labeled, toolResultDigestFor(spec, labeled, resultDisposition, options));
				const finalResult = shapeToolResult(
					spec,
					applyToolResultEffects(
						labeled,
						[...beforeEffects, ...(after instanceof Promise ? await after : after)],
						labeled !== result,
						nestedExecutions.has(result) ? "call" : nestedChainResults.has(result) ? "chain" : null,
					),
					options,
					resultDisposition,
				);
				// The turn pool pays for what the model receives once shaping has cut the result (C-17).
				settleObservationCharge(finalResult);
				return { kind: "ok", result: finalResult, decision, ...execution };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A body that threw may have read the source before failing, so
				// its message carries the same label as a result would.
				const thrownRestrictions = deps.safety.policy?.flowRestrictionsFor?.(call) ?? null;
				const errorWithheld = withheld(thrownRestrictions, "error");
				if (errorWithheld !== null) return errorWithheld;
				const result: ToolResult = withFlowRestrictions({ kind: "error", message }, thrownRestrictions);
				const after = afterEffects(result, toolResultDigestFor(spec, result, resultDisposition, options));
				return {
					kind: "ok",
					result: shapeToolResult(
						spec,
						applyToolResultEffects(result, [...beforeEffects, ...(after instanceof Promise ? await after : after)]),
						options,
						resultDisposition,
					),
					decision,
					...execution,
				};
			}
		} finally {
			// A call handed to the ask route keeps its prepared arguments: its refusal or its approved run releases them.
			if (!handedOff) {
				disposeAdmissionArgs(spec, admittedArgs);
				if (rewrittenArgs !== undefined && rewrittenArgs !== admittedArgs) disposeAdmissionArgs(spec, rewrittenArgs);
			}
		}
	};
	/**
	 * An ask_user call while contained yolo holds an escape scope on offer (M-7): the host-owned option the tool adds
	 * to a question about running outside the sandbox, which grants the scope only when the operator picks it.
	 */
	const withEscapeScopeOffer = (call: ClassifierCall, options: ToolInvokeOptions | undefined) => {
		const ledger = deps.escapeScopes;
		if (call.tool !== ToolNames.AskUser || deps.principal === "worker" || ledger === undefined) return options;
		const scope = ledger.pendingOffer();
		if (scope === null) return options;
		return {
			...(options ?? {}),
			escapeScopeOffer: {
				label: escapeScopeOptionLabel(scope),
				description: escapeScopeOptionConsequence(scope),
				accept: () => ledger.grant(scope, "ask-user"),
			},
		};
	};

	/** Admit, park or run one call; `invoke` adds the main agent's denial memory around it. */
	const invokeAdmitted = async (call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict> => {
		const factSpec = tools.get(call.tool as ToolName);
		const factCall = factSpec?.resolveAdmissionFacts
			? { ...call, args: await factSpec.resolveAdmissionFacts(call.args ?? {}) }
			: call;
		const admissionCall = prepareAdmissionCall(factSpec, factCall);
		const outcome = reg.admit(admissionCall, undefined, options);
		if (outcome.kind === "terminal") {
			disposeAdmissionArgs(tools.get(admissionCall.tool as ToolName), admissionCall.args ?? {});
			return reg.observeBlockedAttempt(admissionCall, outcome.verdict, options) ?? outcome.verdict;
		}
		if (outcome.kind === "execute") {
			return runSpec(outcome.spec, admissionCall, outcome.decision, withEscapeScopeOffer(admissionCall, options));
		}
		return reg.routeAsk(admissionCall, factCall, outcome, options);
	};
	return { runSpec, invokeAdmitted };
}
