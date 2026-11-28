// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import {
	type MainSandboxPolicy,
	mainSandboxPolicy,
	readOnlyMainSandboxPolicy,
	readOnlyScratchDir,
} from "../../core/sandbox/main-session.js";
import type { HomeReadList, SandboxEnvPolicy, UnixSocketMode } from "../../core/sandbox/types.js";
import { type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { type AdmissionDisposition, evaluateAdmission } from "../../domains/safety/admission.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { OperatorDefaultScope, OperatorYoloScope } from "../../domains/safety/policy-engine.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../../lib/autonomy/autonomy.js";
import type { ToolSpec } from "../tool-spec.js";
import { applyRegisteredToolClassification } from "./call-prep.js";
import type { HostEffectCall, RegistryDeps, ToolInvokeOptions } from "./contract.js";
import type { ContainedRoots, RegistryScope } from "./scope.js";

/** The operator's sandbox environment, socket, and home-read choices a contained main shell command carries. */
function shellSandboxScope(deps: RegistryDeps): {
	env?: SandboxEnvPolicy;
	unixSockets?: UnixSocketMode;
	homeReads?: HomeReadList;
} {
	const homeReads = deps.sandboxHomeReads?.();
	return {
		...(deps.sandboxEnv !== undefined ? { env: deps.sandboxEnv() } : {}),
		...(deps.sandboxUnixSockets !== undefined ? { unixSockets: deps.sandboxUnixSockets() } : {}),
		...(homeReads !== undefined ? { homeReads } : {}),
	};
}

/**
 * The operator's scopes for a registry's calls: the yolo, default and read-only scopes admission runs under,
 * host effects judged as their direct calls, and the sandbox policy a contained main shell command carries.
 */
export function createOperatorScopes(reg: RegistryScope) {
	const { deps, tools, shellEgress } = reg;
	// The operator's own yolo exists only on the main session's registry (#419).
	const operatorYoloScope = (level: AutonomyLevel): OperatorYoloScope | undefined =>
		level === "yolo" && (deps.principal ?? "main") === "main" && deps.scratchRoots !== undefined
			? {
					scratchRoots: deps.scratchRoots(),
					...(deps.scriptSandbox !== undefined ? { scriptSandbox: deps.scriptSandbox() } : {}),
					...(deps.hookDrift !== undefined ? { hookDrift: deps.hookDrift } : {}),
				}
			: undefined;
	// The operator's own default exists only there too, beside its containment.
	const operatorDefaultScope = (level: AutonomyLevel): OperatorDefaultScope | undefined =>
		level === "default" &&
		(deps.principal ?? "main") === "main" &&
		deps.scratchRoots !== undefined &&
		deps.containment !== undefined
			? { level: "default", scratchRoots: deps.scratchRoots(), ...deps.containment() }
			: undefined;
	// A read-only main session at either level: its shell calls run in the
	// read-only sandbox where one exists, and never under the operator's yolo.
	const operatorReadOnlyScope = (): OperatorDefaultScope | undefined => {
		if ((deps.principal ?? "main") !== "main" || deps.scratchRoots === undefined || deps.containment === undefined)
			return undefined;
		return {
			level: "default",
			scratchRoots: deps.scratchRoots(),
			sandbox: deps.containment().readOnlySandbox === true,
			snapshots: false,
			readOnly: true,
		};
	};
	const withOperatorScope = (
		level: AutonomyLevel,
		readOnly = false,
	): { operatorYolo?: OperatorYoloScope; operatorDefault?: OperatorDefaultScope } => {
		if (readOnly) {
			const operatorDefault = operatorReadOnlyScope();
			return operatorDefault === undefined ? {} : { operatorDefault };
		}
		const yolo = operatorYoloScope(level);
		if (yolo !== undefined) return { operatorYolo: yolo };
		const operatorDefault = operatorDefaultScope(level);
		return operatorDefault === undefined ? {} : { operatorDefault };
	};
	/**
	 * A host effect that declares `unsandboxed: true` (a scheduled job's argv)
	 * runs outside the sandbox: it is not a model's request to escape one. It is
	 * judged as the uncontained call it is, as on a host without a sandbox, so it
	 * earns no containment relief and raises no escape ask. A job whose
	 * uncontained command would ask is judged again contained, below.
	 */
	const hostEffectScope = (
		effectCall: ClassifierCall,
		level: AutonomyLevel,
	): { operatorYolo?: OperatorYoloScope; operatorDefault?: OperatorDefaultScope } => {
		const scope = withOperatorScope(level);
		if (effectCall.args?.unsandboxed !== true || scope.operatorDefault === undefined) return scope;
		return { operatorDefault: { ...scope.operatorDefault, sandbox: false } };
	};
	/**
	 * Each host effect is admitted exactly as its direct call would be, by the
	 * same evaluator, and never under a one-shot grant for the calling tool.
	 */
	const admitHostEffect = (
		effectCall: ClassifierCall,
		level: AutonomyLevel,
		scope: { operatorYolo?: OperatorYoloScope; operatorDefault?: OperatorDefaultScope },
	): AdmissionDisposition => {
		const effectSpec = tools.get(effectCall.tool as ToolName);
		return evaluateAdmission({
			principal: deps.principal ?? "main",
			effects: [effectCall],
			safety: deps.safety,
			autonomy: level,
			...scope,
			...(deps.workerExecuteAutonomy !== undefined ? { workerExecuteAutonomy: deps.workerExecuteAutonomy } : {}),
			...(effectSpec !== undefined
				? { normalize: (raw: SafetyDecision) => applyRegisteredToolClassification(raw, effectSpec) }
				: {}),
			// A host check that runs a test runner owes the same session consent
			// its direct verify call would ask for.
			...(deps.sessionCodeConsent?.pending() === true ? { sessionCodeConsentPending: true } : {}),
		});
	};
	/**
	 * The sandbox every effect runs in when each, as the contained bash call it
	 * would be, is admitted unasked and contained; otherwise null.
	 */
	const containedEffectsSandbox = (
		effects: ReadonlyArray<HostEffectCall>,
		level: AutonomyLevel,
	): ContainedRoots | null => {
		let roots: ContainedRoots | null = null;
		for (const effect of effects) {
			const { unsandboxed: _uncontained, ...args } = effect.call.args ?? {};
			const admission = admitHostEffect({ ...effect.call, args }, level, withOperatorScope(level));
			const sandbox = admission.kind === "allow" ? admission.decision.policy?.shellSandbox : undefined;
			if (sandbox === undefined) return null;
			roots = sandbox;
		}
		return roots;
	};
	/**
	 * Whether a job's commands, as the exact arguments that execute, would be
	 * refused uncontained, so they may run only in the sandbox admission put on
	 * the decision. A session-consent ask is not counted: approving it admits the
	 * uncontained command.
	 */
	const jobNeedsContainment = (spec: ToolSpec, call: ClassifierCall): boolean => {
		if (call.tool !== ToolNames.Job) return false;
		const level = deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		for (const effect of spec.hostEffectCalls?.(call.args ?? {}) ?? []) {
			const admission = admitHostEffect(effect.call, level, hostEffectScope(effect.call, level));
			if (admission.kind === "deny" || (admission.kind === "ask" && admission.source !== "session-consent")) return true;
		}
		return false;
	};
	const shellSandboxPolicy = (
		roots: { workspace: string; scratchRoots: ReadonlyArray<string>; readOnly?: true },
		options: ToolInvokeOptions | undefined,
	): MainSandboxPolicy => {
		const scope = { workspace: roots.workspace, scratchRoots: roots.scratchRoots, ...shellSandboxScope(deps) };
		return shellEgress.apply(
			roots.readOnly === true
				? readOnlyMainSandboxPolicy({
						...scope,
						scratchDir: readOnlyScratchDir(options?.sessionId ?? deps.currentSessionId?.()),
					})
				: mainSandboxPolicy(scope),
			options,
		);
	};
	/**
	 * True yolo for this registry's calls (#407): the operator's session at
	 * yolo, or a worker whose permit inherited it. Admission decides the net;
	 * this tells the information-flow gate, which runs past admission, that its
	 * refusals do not hold either.
	 */
	const trueYolo = (): boolean =>
		(deps.principal ?? "main") === "worker"
			? deps.workerExecuteAutonomy === "yolo"
			: operatorYoloScope(deps.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL) !== undefined;
	return {
		operatorYoloScope,
		withOperatorScope,
		hostEffectScope,
		admitHostEffect,
		containedEffectsSandbox,
		jobNeedsContainment,
		shellSandboxPolicy,
		trueYolo,
	};
}
