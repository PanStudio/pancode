// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Resolves the target a dispatch runs on: worker targets and profiles from settings, capability info and
 * capability gates, tool-call capability, best-available and capability-matched picks, and the resolved target.
 */

import type { AgentRecipe } from "../agents/recipe.js";
import type { ConfigContract } from "../config/contract.js";
import { type EffectivePricing, resolveEffectivePricing } from "../providers/catalog.js";
import {
	type CapabilityFlags,
	canonicalizeWireModelId,
	firstRuntimeResolutionError,
	isTargetEligibleRuntime,
	type ProvidersContract,
	probeCapabilitiesForModel,
	type ResolvedRuntimeTarget,
	type RuntimeApiFamily,
	type RuntimeDescriptor,
	resolveModelCapabilities,
	resolveRuntimeTarget,
	runtimeResolutionWarnings,
	type TargetDescriptor,
	type TargetStatus,
	type ThinkingLevel,
} from "../providers/index.js";
import { runtimeNotRegistered } from "../providers/runtime-not-registered.js";
import type { DispatchRequest } from "./contract.js";
import { compactDiagnosticText } from "./run-outcome-detail.js";

export interface ResolvedTarget {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags | null;
	modelCapabilities: CapabilityFlags | null;
	/**
	 * What actually answered the tool-support question for this wire model: the
	 * server's live report (an operator false may lower it), else the operator's
	 * own target override, else the knowledge-base entry, else null when nothing
	 * named it. The merged `modelCapabilities` cannot express this,
	 * because a runtime default of `tools: false` is indistinguishable there
	 * from a measurement, and a knowledge-base miss on a local model id is
	 * routine rather than an answer. See {@link targetToolCapability}.
	 */
	toolsCapabilityExplicit: boolean | null;
	runtimeResolution: ResolvedRuntimeTarget;
	effectivePricing: EffectivePricing;
	/** Why the route this run got is not the route it asked for. Belongs in the outcome. */
	routeWarning?: string;
	/**
	 * Which setting chose this route (`fleet default`, a fleet profile, a target named in the call), so a plan card can
	 * say why a worker does not run on the session's model. Absent where no dispatch selection ran.
	 */
	routeSource?: string;
	/**
	 * What a successful resolution still warned about, such as a model id the
	 * target never advertised. It is reported to the operator but never merged
	 * into the outcome detail: it says something about the route, not about why
	 * the run ended.
	 */
	resolutionWarnings?: string[];
}

interface WorkerTargetConfig {
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

type WorkerProfileMap = Record<string, WorkerTargetConfig>;

type WorkerAgentBindingMap = Record<string, string>;

interface WorkerTargets {
	workerDefault: WorkerTargetConfig | null;
	workerProfiles: WorkerProfileMap;
	agentBindings: WorkerAgentBindingMap;
	targetOrder: string[];
}

interface TargetResolutionSuccess {
	ok: true;
	target: ResolvedTarget;
}

interface TargetResolutionFailure {
	ok: false;
	reason: string;
	message: string;
}

type TargetResolutionAttempt = TargetResolutionSuccess | TargetResolutionFailure;

interface RouteSelection {
	label: string;
	targetId: string | null;
	selectedWorkerTarget: WorkerTargetConfig | null;
	problem: string | null;
}

interface BestAvailableWorker {
	workerTarget: WorkerTargetConfig;
	status: TargetStatus;
	order: number;
	healthRank: number;
}

function capabilityInfoForTarget(providers: ProvidersContract, targetId: string): CapabilityFlags | null {
	return providers.list().find((entry) => entry.target.id === targetId)?.capabilities ?? null;
}

function capabilityInfoForStatusModel(
	providers: ProvidersContract,
	status: TargetStatus,
	wireModelId: string | null | undefined,
): CapabilityFlags | null {
	const modelId = wireModelId ?? status.target.defaultModel ?? null;
	const detectedReasoning = modelId ? providers.getDetectedReasoning(status.target.id, modelId) : null;
	return resolveModelCapabilities(status, modelId, providers.knowledgeBase, { detectedReasoning });
}

export function capabilityInfoForModel(
	providers: ProvidersContract,
	targetId: string,
	wireModelId: string | null | undefined,
): CapabilityFlags | null {
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (!status) return null;
	return capabilityInfoForStatusModel(providers, status, wireModelId);
}

function runtimeIdForTarget(providers: ProvidersContract, targetId: string): string | null {
	return providers.getTarget(targetId)?.runtime ?? null;
}

function supportsRequiredCapabilities(
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): boolean {
	if (!required || required.length === 0) return true;
	if (!capabilities) return false;
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") return false;
	}
	return true;
}

/**
 * API families whose wire protocol carries tool calls. Membership is a property
 * of the protocol, not of any one model: every server speaking one of these can
 * express a tool call, so a model served over it is presumed able to take one
 * until something says otherwise. The excluded families (`embeddings-http`,
 * `rerank-http`) have no tool surface to offer at all.
 */
const TOOL_CARRYING_API_FAMILIES: ReadonlySet<RuntimeApiFamily> = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"ollama-native",
	"claude-agent-sdk",
	"claude-code-subprocess",
]);

/**
 * Whether this run may be offered tools at all.
 *
 * An answer decides: the server's live report first (an operator false may
 * lower it, an operator true never raises it), then the operator's own target
 * override, then a knowledge-base entry that names the model. The chat path
 * resolves the same order, so a llama.cpp or LM Studio model the server reports
 * without tool support gets no worker tools even though the runtime default is
 * `tools: true`. Only when nothing answered does the runtime default apply.
 *
 * A runtime default of `tools: false` on a protocol runtime is a placeholder,
 * not a measurement: the generic `openai-compat` descriptor cannot know what an
 * arbitrary local server has loaded. A knowledge-base miss on a local model id
 * is routine (a new quant, a renamed GGUF, a model newer than the catalog), so
 * reading that miss as "no tools" denied every dispatch against every unlisted
 * local model while the same target answered tool calls fine on the chat path.
 * An unanswered question lets a tool-carrying protocol try and surface a real
 * provider error if the server genuinely cannot.
 */
export function targetToolCapability(
	target: Pick<ResolvedTarget, "toolsCapabilityExplicit" | "modelCapabilities"> & {
		runtime: Pick<RuntimeDescriptor, "defaultCapabilities" | "apiFamily">;
	},
): boolean {
	if (target.toolsCapabilityExplicit !== null) return target.toolsCapabilityExplicit;
	if (target.modelCapabilities?.tools === true) return true;
	if (target.runtime.defaultCapabilities.tools === true) return true;
	return TOOL_CARRYING_API_FAMILIES.has(target.runtime.apiFamily);
}

/**
 * The sources that can actually answer "does this model take tools": the
 * server's live report for the wire model, the operator's own target override,
 * and the knowledge-base entry. Null means nothing named it, which is the common
 * case for a local model id the catalog has never seen.
 */
export function explicitToolCapability(
	providers: Pick<ProvidersContract, "knowledgeBase">,
	target: TargetDescriptor,
	wireModelId: string,
	status: TargetStatus | undefined,
): boolean | null {
	const operator = typeof target.capabilities?.tools === "boolean" ? target.capabilities.tools : undefined;
	const live = status ? probeCapabilitiesForModel(status, wireModelId)?.tools : undefined;
	if (typeof live === "boolean") return live && operator === false ? false : live;
	if (operator !== undefined) return operator;
	const hit = providers.knowledgeBase?.lookup(wireModelId, target.runtime) ?? null;
	const fromKnowledgeBase = hit?.entry.capabilities?.tools;
	return typeof fromKnowledgeBase === "boolean" ? fromKnowledgeBase : null;
}

export function readWorkerTargets(settings: ReturnType<ConfigContract["get"]> | undefined): WorkerTargets {
	const workerDefault = settings?.fleet?.default
		? {
				target: settings.fleet.default.target ?? null,
				model: settings.fleet.default.model ?? null,
				thinkingLevel: (settings.fleet.default.thinkingLevel ?? "off") as ThinkingLevel,
			}
		: null;
	const workerProfiles: WorkerProfileMap = {};
	for (const [name, profile] of Object.entries(settings?.fleet?.profiles ?? {})) {
		workerProfiles[name] = {
			target: profile.target ?? null,
			model: profile.model ?? null,
			thinkingLevel: (profile.thinkingLevel ?? "off") as ThinkingLevel,
		};
	}
	const agentBindings: WorkerAgentBindingMap = {};
	for (const [agentId, profileName] of Object.entries(settings?.fleet?.agentProfiles ?? {})) {
		const id = agentId.trim();
		const profile = profileName.trim();
		if (id.length > 0 && profile.length > 0) agentBindings[id] = profile;
	}
	const targetOrder = settings?.targets?.map((target) => target.id) ?? [];
	return { workerDefault, workerProfiles, agentBindings, targetOrder };
}

function pickCapabilityMatchedWorker(
	required: ReadonlyArray<string> | undefined,
	runtimeId: string | undefined,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): WorkerTargetConfig | null {
	if ((!required || required.length === 0) && !runtimeId) return null;
	if (
		workerDefault?.target &&
		(!runtimeId || runtimeIdForTarget(providers, workerDefault.target) === runtimeId) &&
		supportsRequiredCapabilities(capabilityInfoForModel(providers, workerDefault.target, workerDefault.model), required)
	) {
		return workerDefault;
	}
	for (const profile of Object.values(workerProfiles)) {
		if (!profile.target) continue;
		if (runtimeId && runtimeIdForTarget(providers, profile.target) !== runtimeId) continue;
		if (supportsRequiredCapabilities(capabilityInfoForModel(providers, profile.target, profile.model), required)) {
			return profile;
		}
	}
	return null;
}

export function targetUsabilityProblem(status: TargetStatus | null | undefined): string | null {
	if (!status) return null;
	if (!status.runtime) return runtimeNotRegistered(status.target.runtime);
	if (!isTargetEligibleRuntime(status.runtime)) return `runtime '${status.runtime.id}' is not a fleet-dispatch target`;
	if (!status.available) return status.reason.trim() || "unavailable";
	if (status.health.status === "down") {
		return status.health.lastError ? `health down: ${status.health.lastError}` : "health down";
	}
	return null;
}

function healthRankForBestAvailable(status: TargetStatus): number {
	if (status.health.status === "healthy") return 0;
	if (status.health.status === "unknown") return 1;
	return 2;
}

export function requiredCapabilityFailureDetail(
	targetId: string,
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): string | null {
	if (!required || required.length === 0) return null;
	if (!capabilities) return `capability info unavailable for target '${targetId}'`;
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") {
			return `capability '${name}' not supported by target '${targetId}'`;
		}
	}
	return null;
}

function pickBestAvailableWorker(
	providers: ProvidersContract,
	targetOrder: ReadonlyArray<string>,
	required: ReadonlyArray<string> | undefined,
	runtimeId: string | undefined,
	selectedModel: string | null,
	selectedThinkingLevel: ThinkingLevel,
): BestAvailableWorker | null {
	const orderById = new Map(targetOrder.map((id, index) => [id, index]));
	const statuses = providers.list();
	const candidates: BestAvailableWorker[] = [];
	for (const [index, status] of statuses.entries()) {
		if (targetUsabilityProblem(status) !== null) continue;
		if (!status.runtime) continue;
		if (runtimeId && status.runtime.id !== runtimeId && status.target.runtime !== runtimeId) continue;
		const requestedModel = selectedModel ?? status.target.defaultModel ?? null;
		if (!requestedModel) continue;
		const wireModelId = canonicalizeWireModelId(status, requestedModel);
		const capabilities = capabilityInfoForStatusModel(providers, status, wireModelId);
		if (capabilities?.chat !== true) continue;
		if (!supportsRequiredCapabilities(capabilities, required)) continue;
		candidates.push({
			workerTarget: {
				target: status.target.id,
				model: wireModelId,
				thinkingLevel: selectedThinkingLevel,
			},
			status,
			order: orderById.get(status.target.id) ?? targetOrder.length + index,
			healthRank: healthRankForBestAvailable(status),
		});
	}
	candidates.sort((a, b) => a.healthRank - b.healthRank || a.order - b.order);
	return candidates[0] ?? null;
}

function compactRouteReason(reason: string | null | undefined): string {
	const compact = reason ? compactDiagnosticText(reason) : "";
	return compact.length > 0 ? compact : "no usable target";
}

function resolveSelectedDispatchTarget(
	req: DispatchRequest,
	_recipe: AgentRecipe,
	workerDefault: WorkerTargetConfig | null,
	selectedWorkerTarget: WorkerTargetConfig | null,
	providers: ProvidersContract,
	targetId: string,
	routeWarning?: string,
): TargetResolutionAttempt {
	const target = providers.getTarget(targetId);
	if (!target) {
		return { ok: false, reason: `target '${targetId}' not found`, message: `dispatch: target '${targetId}' not found` };
	}
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) {
		return {
			ok: false,
			reason: runtimeNotRegistered(target.runtime),
			message: `dispatch: ${runtimeNotRegistered(target.runtime)}`,
		};
	}
	if (!isTargetEligibleRuntime(runtime)) {
		return {
			ok: false,
			reason: `runtime '${runtime.id}' is not a fleet-dispatch target`,
			message: `dispatch: target '${targetId}' uses runtime '${runtime.id}' (${runtime.kind}); this runtime is not a fleet-dispatch target`,
		};
	}
	const status = providers.list().find((entry) => entry.target.id === target.id);
	const statusProblem = targetUsabilityProblem(status);
	if (statusProblem !== null) {
		return {
			ok: false,
			reason: statusProblem,
			message: `dispatch: target '${targetId}' unavailable: ${statusProblem}`,
		};
	}
	const matchingDefault = workerDefault?.target === targetId ? workerDefault : null;
	const fallbackWorkerTarget = selectedWorkerTarget ?? matchingDefault;
	const requestedWireModelId = req.model ?? fallbackWorkerTarget?.model ?? target.defaultModel;
	if (!requestedWireModelId) {
		return {
			ok: false,
			reason: `no model for target '${targetId}'`,
			message: `dispatch: no model for target '${targetId}' (set a fleet profile model or target.defaultModel)`,
		};
	}
	const wireModelId = status ? canonicalizeWireModelId(status, requestedWireModelId) : requestedWireModelId;
	const thinkingLevel = (req.thinkingLevel ?? fallbackWorkerTarget?.thinkingLevel ?? "off") as ThinkingLevel;
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		requestedThinkingLevel: thinkingLevel,
		use: "dispatch",
		requireOutputBudget: true,
	});
	if (!resolved.ok) {
		const detail =
			firstRuntimeResolutionError(resolved.diagnostics) ?? resolved.diagnostics.map((entry) => entry.message).join("; ");
		return {
			ok: false,
			reason: detail,
			message: `dispatch: target resolution failed: ${detail}`,
		};
	}
	const modelCapabilities = resolved.target.capabilities;
	const capabilityFailure = requiredCapabilityFailureDetail(targetId, modelCapabilities, req.requiredCapabilities);
	if (capabilityFailure !== null) {
		return {
			ok: false,
			reason: capabilityFailure,
			message: `dispatch: admission denied: ${capabilityFailure}`,
		};
	}
	const resolvedTarget: ResolvedTarget = {
		target,
		runtime,
		wireModelId,
		thinkingLevel: resolved.target.effectiveThinkingLevel,
		capabilities: capabilityInfoForTarget(providers, target.id),
		modelCapabilities,
		toolsCapabilityExplicit: explicitToolCapability(providers, target, wireModelId, status),
		runtimeResolution: resolved.target,
		effectivePricing: resolveEffectivePricing(target, runtime, wireModelId),
	};
	if (routeWarning) resolvedTarget.routeWarning = routeWarning;
	const resolutionWarnings = runtimeResolutionWarnings(resolved.diagnostics);
	if (resolutionWarnings.length > 0) resolvedTarget.resolutionWarnings = resolutionWarnings;
	return { ok: true, target: resolvedTarget };
}

function profileRouteSelection(agentId: string, profileName: string, workerProfiles: WorkerProfileMap): RouteSelection {
	const profile = workerProfiles[profileName];
	if (!profile) {
		return {
			label: `agent ${agentId} profile ${profileName}`,
			targetId: null,
			selectedWorkerTarget: null,
			problem: `fleet profile '${profileName}' not configured`,
		};
	}
	if (!profile.target) {
		return {
			label: `agent ${agentId} profile ${profileName}`,
			targetId: null,
			selectedWorkerTarget: profile,
			problem: `fleet profile '${profileName}' has no target`,
		};
	}
	return {
		label: `agent ${agentId} profile ${profileName}`,
		targetId: profile.target,
		selectedWorkerTarget: profile,
		problem: null,
	};
}

export function resolveDispatchTarget(
	req: DispatchRequest,
	recipe: AgentRecipe,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	agentBindings: WorkerAgentBindingMap,
	targetOrder: ReadonlyArray<string>,
	providers: ProvidersContract,
): ResolvedTarget {
	const explicitTarget = req.target ?? null;
	if (explicitTarget) {
		// A call naming the route of the profile it would use anyway (an active route decision previews each candidate by
		// target and model) keeps that profile's thinking level; another route takes only the fleet default's (pc-rc2).
		const profileName = req.workerProfile ?? agentBindings[req.agentId];
		const profile = profileName === undefined ? undefined : workerProfiles[profileName];
		const routeProfile =
			profile !== undefined &&
			profile.target === explicitTarget &&
			(req.model === undefined || profile.model === null || profile.model === req.model)
				? profile
				: null;
		const attempt = resolveSelectedDispatchTarget(req, recipe, workerDefault, routeProfile, providers, explicitTarget);
		if (attempt.ok) return { ...attempt.target, routeSource: "target named in the call" };
		throw new Error(attempt.message);
	}

	let selection: RouteSelection | null = null;
	let source = "fleet default";
	if (req.workerProfile) {
		selection = profileRouteSelection(req.agentId, req.workerProfile, workerProfiles);
		source = `fleet profile ${req.workerProfile} named in the call`;
	}

	const boundProfile = agentBindings[req.agentId];
	if (!selection && boundProfile) {
		selection = profileRouteSelection(req.agentId, boundProfile, workerProfiles);
		source = `fleet profile ${boundProfile} bound to agent ${req.agentId}`;
	}
	// A profile that is missing or has no target is a configuration error, not an unavailable route: falling back to
	// the best-available target would run the worker somewhere the operator never chose.
	if (selection !== null && selection.targetId === null) {
		const defined = Object.keys(workerProfiles);
		throw new Error(
			`dispatch: route admission refused: ${selection.label}: ${selection.problem}; ${defined.length > 0 ? `define it in fleet.profiles or name one of ${defined.map((name) => `'${name}'`).join(", ")}` : "fleet.profiles defines none"}`,
		);
	}

	if (!selection) {
		const capabilityMatchedWorker = pickCapabilityMatchedWorker(
			req.requiredCapabilities,
			req.workerRuntime,
			workerDefault,
			workerProfiles,
			providers,
		);
		if (capabilityMatchedWorker?.target) {
			selection = {
				label: `capability/runtime matched target ${capabilityMatchedWorker.target}`,
				targetId: capabilityMatchedWorker.target,
				selectedWorkerTarget: capabilityMatchedWorker,
				problem: null,
			};
			source = "fleet target matching the required capabilities";
		}
	}

	if (!selection) {
		selection = {
			label: "fleet default",
			targetId: workerDefault?.target ?? null,
			selectedWorkerTarget: workerDefault,
			problem: workerDefault?.target ? null : "not configured",
		};
	}

	if (selection.label === "fleet default" && req.workerRuntime && selection.targetId) {
		const defaultRuntime = runtimeIdForTarget(providers, selection.targetId);
		if (defaultRuntime !== null && defaultRuntime !== req.workerRuntime) {
			selection = {
				...selection,
				targetId: null,
				problem: `fleet default target '${selection.targetId}' does not use requested runtime '${req.workerRuntime}'`,
			};
		}
	}

	if (selection.targetId) {
		const attempt = resolveSelectedDispatchTarget(
			req,
			recipe,
			workerDefault,
			selection.selectedWorkerTarget,
			providers,
			selection.targetId,
		);
		if (attempt.ok) return { ...attempt.target, routeSource: source };
		selection = { ...selection, problem: attempt.reason };
	}

	const selectedModel = req.model ?? selection.selectedWorkerTarget?.model ?? null;
	const selectedThinkingLevel = (selection.selectedWorkerTarget?.thinkingLevel ?? "off") as ThinkingLevel;
	const fallback = pickBestAvailableWorker(
		providers,
		targetOrder,
		req.requiredCapabilities,
		req.workerRuntime,
		selectedModel,
		selectedThinkingLevel,
	);
	if (fallback) {
		const reason = compactRouteReason(selection.problem);
		const warning = `dispatch: ${selection.label} unavailable (${reason}); using best-available target ${fallback.status.target.id}`;
		const attempt = resolveSelectedDispatchTarget(
			req,
			recipe,
			workerDefault,
			fallback.workerTarget,
			providers,
			fallback.status.target.id,
			warning,
		);
		if (attempt.ok)
			return { ...attempt.target, routeSource: `best-available target; ${selection.label} unavailable (${reason})` };
		throw new Error(`${warning}; fallback failed (${compactRouteReason(attempt.reason)})`);
	}

	const runtimeSuffix = req.workerRuntime ? ` for runtime '${req.workerRuntime}'` : "";
	const base = `dispatch: ${selection.label} unavailable (${compactRouteReason(selection.problem)}); no best-available dispatch target found${runtimeSuffix}`;
	if (selection.label === "fleet default" && selection.problem === "not configured") {
		throw new Error(`${base} (set the fleet default, add a fleet profile, or pass target)`);
	}
	throw new Error(base);
}

export function enforceCapabilityGate(
	targetId: string,
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): void {
	if (!required || required.length === 0) return;
	if (!capabilities) {
		throw new Error(`dispatch: admission denied: capability info unavailable for target '${targetId}'`);
	}
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") {
			throw new Error(`dispatch: admission denied: capability '${name}' not supported by target '${targetId}'`);
		}
	}
}
