// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { sha256Hex } from "../../core/hash.js";
import { UnsupportedResponseSchemaError } from "../../core/response-schema.js";
import type { ToolName } from "../../core/tool-names.js";
import {
	endpointIdentityHash,
	toolSignatureOf,
	WORKER_EXTENSION_HOOKS_MAX,
	type WorkerExtensionHook,
} from "../../lib/worker-wire/protocol.js";
import type { CheckoutRootLookup } from "../../tools/task-worktree.js";
import type { AgentRecipe } from "../agents/recipe.js";
import {
	type AgentSpec,
	agentSpecFingerprint,
	isUserVisibleAgent,
	normalizeAgentSpec,
	SHADOW_AGENT_OPERATOR_STAND_IN,
	userOriginAudienceRefusal,
} from "../agents/spec.js";
import { computeSettingsFingerprint } from "../config/index.js";
import type { EffectivePricing } from "../providers/catalog.js";
import type { RuntimeDescriptor } from "../providers/index.js";
import { compileWorkerFlowPolicy, flowUnmediatedAgentRefusal } from "../safety/information-flow.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import { workerPermissionModeForPermit } from "../safety/worker-permit.js";
import { resolveAcpDelegationLifecycle } from "./acp-delegation-lifecycle.js";
import { routeValidationProjection } from "./active-route-planner.js";
import { resolveDispatchAdmissionStage, withStoreGrantBoundaries } from "./admission-scope.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import {
	ACP_SPEC_FINGERPRINT,
	ACP_TOOL_SIGNATURE,
	admissionMaxOutputTokens,
	conservativeRouteAdmissionEstimateUsd,
	UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD,
	withoutDelegationStandInModel,
} from "./bundle-support.js";
import { assessCapabilityMismatch, type CapabilityMismatch } from "./capability-match.js";
import type { DispatchDerivedGrants, DispatchPlanTaskResolution, DispatchRequest } from "./contract.js";
import { withheldLines, writeModeLine } from "./envelope.js";
import { type EffectiveSettings, judgeRoutedPermit, resolveDispatchEnvelopeStage } from "./envelope-stage.js";
import { dispatchResultContract } from "./execution-role.js";
import { architectPlanOutsideWriteRoots } from "./intent-compatibility.js";
import { resolveDispatchPathScope } from "./path-scope.js";
import { planCardLimits, resolveRunWall, runWallCapMs } from "./run-limits.js";
import {
	assertDenyToolsEnforceable,
	assertFlowHandoffMediated,
	assertMainGrantRoutable,
	assertPlannedNodeIdentity,
	assertPostRuntimeToolCompatibility,
	assertProtectedArtifactsEnforceable,
	assertResponseSchemaEnforceable,
	assertRuntimeCanHonorWorkerPermissionMode,
	assertWriteRootsEnforceable,
} from "./runtime-enforceability.js";
import { enforceCapabilityGate, readWorkerTargets, resolveDispatchTarget } from "./target-resolution.js";
import { assertTurnConstraintCompatibility } from "./tool-constraints.js";
import { validateJobSpec } from "./validation.js";
import { assertWorkerContextRequest, hasCallerPersonaOverride } from "./worker-dynamic-prompt.js";
import { workerMcpRuntimeRefusal } from "./worker-mcp.js";
import {
	hookExtensionIds,
	hooksMatchingTools,
	isBlockingHook,
	protectedArtifactStateForRequest,
	resolveEffectiveWorkerBudget,
	unhookedWorkerHooks,
} from "./worker-spec.js";

export function createRoutePreview(rt: DispatchRuntime) {
	const { options } = rt;
	const {
		agents,
		getEffectiveSettings,
		getProtectedArtifactState,
		maybeAgents,
		previewNode,
		projectContext,
		providers,
		safety,
		withLiveAutonomy,
	} = rt.core;

	/**
	 * The user-facing stand-in a shadow refusal may name, or null. The stand-in
	 * is named only when the fixed-route admission preview admits its read-only
	 * run on the same request, so the refusal never suggests a command that is
	 * refused in turn.
	 */
	function admissibleShadowStandIn(req: DispatchRequest, settings: EffectiveSettings): string | null {
		const recipe = agents.get(SHADOW_AGENT_OPERATOR_STAND_IN);
		if (!recipe) return null;
		try {
			if (!isUserVisibleAgent(normalizeAgentSpec(recipe))) return null;
			// The fixed-route admission preview, run for the stand-in on the
			// operator's own request, so the hint can never name a refused route.
			const { delegationAgentId: _delegation, ...rest } = req;
			previewFixed({ ...rest, agentId: recipe.id, readOnly: true }, settings);
			return recipe.id;
		} catch {
			return null;
		}
	}

	/**
	 * Refuses a recipe the request may not run, before any route is resolved, and answers the capability mismatch it
	 * only flags. Dispatch and preview share it, so a plan never shows a run admission refuses.
	 */
	function assertRecipeAdmissible(
		req: DispatchRequest,
		recipe: AgentRecipe,
		settings: EffectiveSettings,
	): { spec: AgentSpec; capabilityMismatch: CapabilityMismatch | null } {
		// Resolve the applied contract once here so a caller's summary allowance
		// on a recipe that carries no summary fails before any model boots.
		dispatchResultContract(req, recipe);
		const spec = normalizeAgentSpec(recipe);
		if (req.requestOrigin === "user" && !isUserVisibleAgent(spec)) {
			throw new Error(userOriginAudienceRefusal(spec, admissibleShadowStandIn(req, settings)));
		}
		if (req.requestOrigin === "harness" && spec.capabilityClass !== "read-only") {
			throw new Error(
				`dispatch: harness-origin runs require a read-only recipe; '${req.agentId}' is ${spec.capabilityClass}`,
			);
		}
		if (hasCallerPersonaOverride(req) && (spec.audience === "shadow" || spec.audience === "internal")) {
			throw new Error(`dispatch: persona overrides are not allowed for ${spec.audience} agent '${req.agentId}'`);
		}
		// A read-only recipe pointed at a mutating task is knowable here and costs
		// a full worker run to discover afterwards. Refuse the pairing the caller
		// chose on purpose; flag the one the classifier may have misread.
		//
		// Gate runs are exempt outright. A reviewer or judge carries the builder's
		// task text so it knows what it is judging, so "document the module" on a
		// verifier is the gate working exactly as designed, not a mismatch.
		const capabilityMismatch =
			req.gate !== undefined
				? null
				: assessCapabilityMismatch({
						agentId: req.agentId,
						capabilityClass: spec.capabilityClass,
						task: req.task,
						autoSelected: req.agentSelection?.mode === "auto",
						resultContractKind: spec.resultContract.kind,
						specs: agents.listSpecs(),
						intent: req.intent ?? null,
					});
		if (capabilityMismatch?.verdict === "refuse") throw new Error(capabilityMismatch.detail);
		const planOutside = architectPlanOutsideWriteRoots(req.agentId, spec.resultContract, req.intent);
		if (planOutside !== null) throw new Error(planOutside);
		return { spec, capabilityMismatch };
	}

	// An external ACP agent runs its own tools where no extension tool hook
	// reaches, so any blocking hook refuses it whatever tools the hook names.
	// Preview shares it so a plan never shows a delegation dispatch refuses.
	/**
	 * Refuses an ACP delegation whose guarantees the external agent cannot keep. Dispatch admission and preview share
	 * it, so a plan never shows a delegation dispatch refuses.
	 */
	function assertAcpDelegationAdmissible(
		req: DispatchRequest,
		agentId: string,
		protectedArtifactState: ProtectedArtifactState,
	): void {
		assertPlannedNodeIdentity(req, { id: "local", kind: "local" });
		assertTurnConstraintCompatibility(req, [], false);
		assertProtectedArtifactsEnforceable("acp-delegation", false, protectedArtifactState);
		const flowPolicy = options?.getFlowPolicy?.();
		if (flowPolicy !== undefined) {
			const refusal = flowUnmediatedAgentRefusal(compileWorkerFlowPolicy(flowPolicy), null);
			if (refusal !== null) throw new Error(refusal);
		}
		assertFlowHandoffMediated("acp-delegation", options?.getFlowRestrictions?.() ?? null);
		assertAcpDelegationUnhooked(agentId);
		if (req.responseSchema !== undefined) {
			throw new UnsupportedResponseSchemaError(
				"dispatch: responseSchema requires the native llamacpp runtime and cannot be enforced by an ACP delegation connection",
			);
		}
		// An external ACP agent runs its own tool loop, so PanCode cannot mediate
		// per-tool writes and cannot honor write-root confinement. Fail closed
		// rather than accept a guarantee we cannot keep.
		if (req.writeRoots !== undefined && req.writeRoots.length > 0) {
			throw new Error(
				"dispatch: writeRoots cannot be enforced on an ACP delegation connection; the external agent runs its own tool surface. Dispatch to a native or claude-sdk worker.",
			);
		}
	}

	function assertAcpDelegationUnhooked(agentId: string): void {
		const gates = [...(options?.workerHooks?.declarations() ?? []), ...(options?.workerHooks?.dropped?.() ?? [])].filter(
			isBlockingHook,
		);
		if (gates.length > 0)
			throw new Error(
				`dispatch: the ACP agent ${agentId} runs its own tools where no extension tool hook reaches, and the blocking hooks of ${hookExtensionIds(gates)} apply to every worker; dispatch to an http connection`,
			);
	}

	/**
	 * Refuses a worker route whose tools a blocking hook gates but the worker
	 * would run past: a gate beyond the spec's hook cap that never reaches the
	 * worker, or one the route's runtime cannot carry. Dispatch, preview and
	 * failover candidates share it, so a refused route is never offered. Answers
	 * the passing hooks the runtime runs without, which dispatch names once.
	 */
	function assertWorkerHooksCarried(
		runtime: RuntimeDescriptor,
		allowedTools: ReadonlyArray<ToolName>,
	): WorkerExtensionHook[] {
		const dropped = options?.workerHooks?.dropped?.() ?? [];
		const droppedGates = hooksMatchingTools(dropped, allowedTools).filter(isBlockingHook);
		if (droppedGates.length > 0)
			throw new Error(
				`dispatch: the blocking tool hooks of ${hookExtensionIds(droppedGates)} fall past the ${WORKER_EXTENSION_HOOKS_MAX} hooks a worker carries and match this worker's tools; reduce the installed tool hooks`,
			);
		const unhooked = unhookedWorkerHooks(
			runtime,
			[...(options?.workerHooks?.declarations() ?? []), ...dropped],
			allowedTools,
		);
		const gates = unhooked.filter(isBlockingHook);
		if (gates.length > 0)
			throw new Error(
				runtime.kind === "subprocess"
					? `dispatch: the ${runtime.id} runtime runs its own tools where no extension tool hook reaches, and the blocking hooks of ${hookExtensionIds(gates)} apply to every worker; route it to an http connection`
					: `dispatch: the ${runtime.id} runtime cannot carry extension tool hooks, and the blocking hooks of ${hookExtensionIds(gates)} match this worker's tools; route it to an http connection`,
			);
		return unhooked;
	}

	function previewFixed(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
		checkoutRoot?: CheckoutRootLookup,
	): DispatchPlanTaskResolution {
		return previewFixedStages(req, settings, checkoutRoot).resolution;
	}

	/**
	 * The fixed-route preview and the grants admission derives on the way: the
	 * requested actions, the MCP attestation after writable servers lose their
	 * network grant, and the worker permit. Null grants for an ACP delegation,
	 * whose tool surface PanCode cannot observe.
	 */
	function previewFixedStages(
		req: DispatchRequest,
		settings: EffectiveSettings,
		checkoutRoot?: CheckoutRootLookup,
	): {
		resolution: DispatchPlanTaskResolution;
		grants: DispatchDerivedGrants | null;
		/** Null for an ACP delegation, whose budget admission prices nothing. */
		pricing: EffectivePricing | null;
	} {
		const isAcpAgent = settings?.integrations.externalAgents?.entries?.some((entry) => entry.id === req.agentId) ?? false;
		if (isAcpAgent && !req.delegationAgentId) req = { ...req, delegationAgentId: req.agentId };
		const validation = routeValidationProjection(req, true);
		const validated = validateJobSpec(validation.jobSpec);
		if (!validated.ok) throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		req = validation.restore(validated.spec);

		if (req.delegationAgentId) {
			assertAcpDelegationAdmissible(
				req,
				req.delegationAgentId,
				protectedArtifactStateForRequest(getProtectedArtifactState(), req),
			);
			const lifecycle = resolveAcpDelegationLifecycle(
				{ ledgerAssignmentsFor: rt.runs.ledgerAssignmentsFor, maybeAgents, projectContext, safety },
				req,
				settings,
			);
			const delegationRecipe = agents.get(req.agentId);
			const resolution: DispatchPlanTaskResolution = {
				agentId: req.agentId,
				specFingerprint:
					delegationRecipe !== null ? agentSpecFingerprint(normalizeAgentSpec(delegationRecipe)) : ACP_SPEC_FINGERPRINT,
				targetId: `delegation:${lifecycle.agentConfig.id}`,
				wireModelId: withoutDelegationStandInModel(req, lifecycle.agentConfig.id).model ?? lifecycle.agentConfig.id,
				runtimeId: "acp",
				node: previewNode({ ...req, node: "local" }).node,
				thinkingLevel: null,
				// An external ACP agent runs its own tool loop, so PanCode cannot observe
				// its surface. The named signature is that unknown, stated once.
				toolSignature: ACP_TOOL_SIGNATURE,
				endpointIdentityHash: sha256Hex(`delegation:${lifecycle.agentConfig.id}`),
				settingsFingerprint: computeSettingsFingerprint(settings ?? null),
				costUpperBoundUsd: UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD,
				costUpperBoundKnown: false,
				routeApproval: null,
			};
			return { resolution, grants: null, pricing: null };
		}

		const recipe = agents.get(req.agentId);
		if (!recipe) throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
		const { spec: agentSpec } = assertRecipeAdmissible(req, recipe, settings);
		const placement = previewNode(req);
		const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => placement.node);
		const admission = resolveDispatchAdmissionStage(req, recipe, safety, pathScope);
		const targets = readWorkerTargets(settings);
		const target = resolveDispatchTarget(
			req,
			recipe,
			targets.workerDefault,
			targets.workerProfiles,
			targets.agentBindings,
			targets.targetOrder,
			providers,
		);
		assertWorkerContextRequest(req, target.runtime.kind === "http");
		enforceCapabilityGate(target.target.id, target.modelCapabilities, req.requiredCapabilities);
		const mcpRuntimeRefusal = workerMcpRuntimeRefusal(req.agentId, admission.allowedTools, target.runtime);
		if (mcpRuntimeRefusal !== null) throw new Error(mcpRuntimeRefusal);
		assertDenyToolsEnforceable(target.runtime, req.denyTools);
		// Preview resolves the envelope the run will: one function, so the card shows what the run gets (M7).
		const stage = resolveDispatchEnvelopeStage({
			req,
			recipe,
			spec: agentSpec,
			admission,
			target,
			settings,
			liveSettings: withLiveAutonomy(settings),
			pathScope,
			judgeSeated: options?.workerAskJudge !== undefined,
			placement,
			...(checkoutRoot === undefined ? {} : { checkoutRoot }),
		});
		const effectiveTools = stage.tools;
		const previewPermit = stage.permit;
		assertPostRuntimeToolCompatibility(req.agentId, agentSpec, stage.envelope, target);
		assertTurnConstraintCompatibility(req, effectiveTools, target.runtime.kind === "http", agents.listSpecs());
		if (!judgeRoutedPermit(previewPermit, settings)) assertMainGrantRoutable(req, target.runtime, previewPermit);
		assertRuntimeCanHonorWorkerPermissionMode(target.runtime, workerPermissionModeForPermit(previewPermit.allowance));
		assertResponseSchemaEnforceable(target.runtime, target.modelCapabilities, req.responseSchema, effectiveTools.length);
		assertWriteRootsEnforceable(target.runtime, stage.envelope.write.roots);
		assertProtectedArtifactsEnforceable(
			target.runtime.id,
			target.runtime.kind !== "subprocess",
			getProtectedArtifactState(),
		);
		assertWorkerHooksCarried(target.runtime, effectiveTools);
		const budget = resolveEffectiveWorkerBudget({
			req,
			recipeId: recipe.id,
			declared: agentSpec.budget,
			allowedTools: effectiveTools,
			settings,
			runtime: target.runtime,
			readOnly: stage.readOnly,
		});
		const endpoint = rt.capacity.endpointCapacityForTarget(target.target.id);
		const outputBoundTokens = admissionMaxOutputTokens(settings, target.modelCapabilities);
		const costUpperBoundUsd = conservativeRouteAdmissionEstimateUsd(target.effectivePricing, outputBoundTokens, req);
		const costUpperBoundKnown = target.effectivePricing.pricedBy !== "none";
		const resolution: DispatchPlanTaskResolution = {
			agentId: req.agentId,
			specFingerprint: agentSpecFingerprint(agentSpec),
			targetId: target.target.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
			node: placement.node,
			thinkingLevel: target.thinkingLevel,
			toolSignature: toolSignatureOf(effectiveTools),
			endpointIdentityHash: endpointIdentityHash(target.target.url),
			settingsFingerprint: computeSettingsFingerprint(settings ?? null),
			costUpperBoundUsd,
			costUpperBoundKnown,
			routeApproval: null,
			limits: planCardLimits({
				priced: costUpperBoundKnown,
				costUpperBoundUsd,
				outputBoundTokens,
				budget,
				nativeWorker: target.runtime.kind === "http",
				responseSeconds: (settings ?? DEFAULT_SETTINGS).safety.limits.workerResponseSeconds,
				wallMs: resolveRunWall({
					capMs: runWallCapMs((settings ?? DEFAULT_SETTINGS).fleet.limits, req.requestOrigin),
					...(agentSpec.budget?.timeoutMs !== undefined ? { recipeMs: agentSpec.budget.timeoutMs } : {}),
					startedAt: 0,
				}).wallMs,
			}),
			writes: writeModeLine(stage.envelope.write),
			...(target.routeSource !== undefined ? { route: target.routeSource } : {}),
			...(stage.envelope.withheld.length > 0 ? { withheld: withheldLines(stage.envelope.withheld) } : {}),
		};
		return {
			resolution,
			grants: {
				requestedActions: admission.requestedActions,
				mcp: admission.mcp ?? null,
				permit: previewPermit,
			},
			pricing: target.effectivePricing,
		};
	}

	return {
		assertAcpDelegationAdmissible,
		assertRecipeAdmissible,
		assertWorkerHooksCarried,
		previewFixed,
		previewFixedStages,
	};
}
