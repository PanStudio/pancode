// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The model picker's rows: one row per target and model built from the providers' live status, the summary over
 * them, the residency words, and the search that ranks them. The table and detail modules draw these rows; the
 * overlay in `model-selector.ts` owns the keyboard, the refreshes and the frame.
 */

import type { PancodeSettings } from "../../core/config.js";
import { formatCount } from "../../core/format-time.js";
import { listRecentModels } from "../../core/recent-models.js";
import type {
	CapabilityFlags,
	ProviderModelSource,
	ProvidersContract,
	ResolvedRuntimeTarget,
	RuntimeCapabilityDecision,
	RuntimeResolutionDiagnostic,
	TargetStatus,
	ThinkingLevel,
} from "../../domains/providers/index.js";
import {
	chatModelCandidatesForStatus,
	hasLiveModelCatalog,
	isOrchestratorEligibleRuntime,
	modelIdsForStatus,
	modelListNoteForStatus,
	modelResidencyForStatus,
	newerModelNotice,
	resolveRuntimeTarget,
	supportsAgentRoleTools,
	thinkingEffectNote,
} from "../../domains/providers/index.js";
import { fuzzyFilter } from "../../engine/tui.js";
import type { PancodeToken } from "../theme/index.js";
import { GLYPH } from "../theme/index.js";

function healthToken(status: TargetStatus): PancodeToken {
	switch (status.health.status) {
		case "healthy":
			return "success";
		case "degraded":
			return "warning";
		case "down":
			return "error";
		default:
			return "annotation";
	}
}

function capabilityBadges(caps: CapabilityFlags): string {
	let badges = "";
	if (caps.tools) badges += "T";
	if (caps.reasoning) badges += "R";
	if (caps.vision) badges += "V";
	if (caps.embeddings) badges += "E";
	if (caps.rerank) badges += "K";
	if (caps.fim) badges += "F";
	return badges.length > 0 ? badges : "-";
}

function compactTokenCount(value: number): string {
	return Number.isFinite(value) && value > 0 ? formatCount(value) : "?";
}

function contextDecisionLabel(decisions: RuntimeCapabilityDecision): string {
	return `${compactTokenCount(decisions.contextWindow)}ctx`;
}

function maxTokensDecisionLabel(decisions: RuntimeCapabilityDecision): string {
	return compactTokenCount(decisions.maxTokens);
}

export type ModelSource = ProviderModelSource | "missing";
type ModelBucket = "local" | "cloud";
export type ModelRefreshScope = "selected" | "all";

export interface ModelRow {
	value: string;
	target: string;
	model: string;
	runtimeName: string;
	runtimeShortName: string;
	runtimeId: string;
	apiFamily: string;
	bucket: ModelBucket;
	source: ModelSource;
	/** Present when the target's list is not the provider's live answer: what it is instead, and why. */
	sourceNote?: string;
	loadState?: string;
	loadStateDetail?: string;
	/** Whether the model is in memory where it would run; null where residency is not a property of the route. */
	residency?: ModelResidencyWord | null;
	authText: string;
	available: boolean;
	reason: string;
	healthToken: PancodeToken;
	healthText: string;
	/** When the target's health was last checked, as the provider recorded it; null before any check. */
	healthCheckedAt?: string | null;
	caps: CapabilityFlags;
	capabilityDecisions?: RuntimeCapabilityDecision;
	thinking?: string;
	/** Why this model runs another level than the one asked for. */
	thinkingNote?: string | null;
	streaming?: boolean;
	diagnostics?: RuntimeResolutionDiagnostic[];
	badges: string;
	context: string;
	maxTokens: string;
	active: boolean;
	scoped: boolean;
	favorite?: boolean;
	recent?: boolean;
	defaultModel?: boolean;
	focusPinned?: boolean;
	visibleByDefault?: boolean;
	selectable: boolean;
}

export interface ModelOverlaySummary {
	totalModels: number;
	targets: number;
	localModels: number;
	cloudModels: number;
	activeRef: string;
	focusedModels?: number;
	newerModelNotice?: string;
}

export type ModelResidencyWord = "resident" | "loading" | "unloaded" | "failed" | "unknown";

/**
 * Residency as the runtime reported it on its last live answer (J2-F15). A hosted cloud API always serves, so it has
 * none; a gateway or a runtime that does not report it reads `unknown` rather than a guess, and so does a model list
 * that is not the provider's live answer, because a cached state says nothing about what is loaded now.
 */
export function modelResidencyWord(status: TargetStatus, modelId: string): ModelResidencyWord | null {
	if (modelBucket(status) === "cloud") return null;
	if (!hasLiveModelCatalog(status) || modelId.length === 0) return "unknown";
	if (status.discoveredModelStates?.[modelId]?.state === "failed") return "failed";
	switch (modelResidencyForStatus(status, modelId)) {
		case "resident":
			return "resident";
		case "loading":
			return "loading";
		case "absent":
			return "unloaded";
		default:
			return "unknown";
	}
}

/** The residency as one plain sentence, for the selected row's detail and the scope dialog. */
export function modelResidencySentence(word: ModelResidencyWord | null, model: string, target: string): string | null {
	switch (word) {
		case "resident":
			return `${model} is loaded on ${target}, so there is no load to wait for.`;
		case "loading":
			return `${model} is loading on ${target}; the first reply waits for it.`;
		case "unloaded":
			return `${model} is not loaded on ${target}; the first request loads it, which can take a minute.`;
		case "failed":
			return `${target} reported that loading ${model} failed; the first request tries again.`;
		case "unknown":
			return `${target} does not report whether ${model} is loaded.`;
		default:
			return null;
	}
}

export const RESIDENCY_TONES: Record<ModelResidencyWord, PancodeToken> = {
	resident: "success",
	loading: "warning",
	unloaded: "counter",
	failed: "error",
	unknown: "unknownValue",
};

/** Enumerate target wire model ids with live discovery taking precedence when available. */
export function modelsForTarget(status: TargetStatus): string[] {
	return modelIdsForStatus(status);
}

export interface ModelItemsResult {
	rows: ModelRow[];
	summary: ModelOverlaySummary;
}

function fallbackCapabilityDecisions(status: TargetStatus, caps: CapabilityFlags): RuntimeCapabilityDecision {
	const kind = status.runtime?.kind;
	return {
		chat: caps.chat,
		tools: caps.tools,
		reasoning: caps.reasoning,
		vision: caps.vision,
		streaming: kind === "http",
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
	};
}

function providersWithStatusFallback(providers: ProvidersContract, status: TargetStatus): ProvidersContract {
	return {
		...providers,
		getTarget: (id) => providers.getTarget(id) ?? (id === status.target.id ? status.target : null),
		getRuntime: (id) => providers.getRuntime(id) ?? (status.runtime && id === status.runtime.id ? status.runtime : null),
	};
}

interface OverlayRuntimeResolution {
	target: ResolvedRuntimeTarget | null;
	diagnostics: RuntimeResolutionDiagnostic[];
	capabilities: CapabilityFlags;
	capabilityDecisions: RuntimeCapabilityDecision;
	thinking: string;
	thinkingNote: string | null;
	streaming: boolean;
}

/** Resolve the same runtime/capability descriptor used by the footer and chat loop for one overlay row. */
function resolveOverlayRuntimeTarget(input: {
	providers: ProvidersContract;
	status: TargetStatus;
	wireModelId: string;
	requestedThinkingLevel?: ThinkingLevel;
}): OverlayRuntimeResolution {
	const resolution = resolveRuntimeTarget(providersWithStatusFallback(input.providers, input.status), {
		targetId: input.status.target.id,
		wireModelId: input.wireModelId,
		requestedThinkingLevel: input.requestedThinkingLevel ?? "off",
		use: "orchestrator",
		requireTools: true,
		requireStreaming: true,
		requireOutputBudget: true,
	});
	if (resolution.ok) {
		return {
			target: resolution.target,
			diagnostics: resolution.diagnostics,
			capabilities: resolution.target.capabilities,
			capabilityDecisions: resolution.target.capabilityDecisions,
			thinking: resolution.target.modelRuntime.thinking.display,
			thinkingNote: thinkingEffectNote({
				...resolution.target.modelRuntime.thinking,
				model: resolution.target.modelRuntime.modelId,
			}),
			streaming: resolution.target.capabilityDecisions.streaming,
		};
	}
	const capabilities = input.status.capabilities;
	const decisions = fallbackCapabilityDecisions(input.status, capabilities);
	return {
		target: null,
		diagnostics: resolution.diagnostics,
		capabilities,
		capabilityDecisions: decisions,
		thinking: "unresolved",
		thinkingNote: null,
		streaming: decisions.streaming,
	};
}

function modelBucket(status: TargetStatus): ModelBucket {
	const tier = status.runtime?.tier;
	if (
		tier === "protocol" ||
		tier === "local-native" ||
		status.target.url?.includes("127.0.0.1") ||
		status.target.url?.includes("localhost")
	) {
		return "local";
	}
	return "cloud";
}

function shortRuntimeName(name: string): string {
	return name
		.replace(/\s*\(OpenAI-compat\)\s*/g, "")
		.replace(/\s+native API$/i, "")
		.replace(/\s+API$/i, "")
		.replace(/\s+SDK$/i, "");
}

function authLabel(deps: { providers: ProvidersContract; status: TargetStatus }): string {
	const { providers, status } = deps;
	if (!status.runtime) return "unknown";
	const auth = providers.auth.statusForTarget(status.target, status.runtime);
	if (!auth.available) return "disconnected";
	if (auth.source === "environment") return auth.detail ? `env:${auth.detail}` : "environment";
	if (auth.source === "none") return "not required";
	return auth.detail ? `${auth.source}:${auth.detail}` : auth.source;
}

function healthText(status: TargetStatus): string {
	const latency =
		typeof status.health.latencyMs === "number" && Number.isFinite(status.health.latencyMs)
			? ` ${Math.round(status.health.latencyMs)}ms`
			: "";
	if (status.health.status === "unknown") return "unknown";
	if (status.health.lastError) return `${status.health.status}: ${status.health.lastError}`;
	return `${status.health.status}${latency}`;
}

function statusPriority(status: TargetStatus): number {
	if (status.available && status.health.status === "healthy") return 0;
	if (status.available && status.health.status !== "down") return 1;
	return 2;
}

function buildSummary(rows: ReadonlyArray<ModelRow>, targets: number, activeRef: string): ModelOverlaySummary {
	let localModels = 0;
	let cloudModels = 0;
	for (const row of rows) {
		if (!row.selectable) continue;
		if (row.bucket === "local") localModels++;
		else cloudModels++;
	}
	return {
		totalModels: localModels + cloudModels,
		targets,
		localModels,
		cloudModels,
		activeRef,
		focusedModels: rows.filter((row) => row.selectable && row.visibleByDefault !== false).length,
	};
}

/**
 * Build the target-first model picker. Each configured target renders one
 * row per candidate wire model (see `modelsForTarget`). Targets without
 * a resolvable wire model still render a single "no-model" row so users can
 * see the target exists and why it is not selectable. Scope stars come from
 * `settings.chat.modelPicker.cycleSet`: both plain `targetId` and `targetId/wireModelId` refs
 * match so a user can pin either granularity.
 */
export function buildModelItems(deps: {
	settings: Readonly<PancodeSettings>;
	providers: ProvidersContract;
}): ModelItemsResult {
	const activeTarget = deps.settings.chat?.target?.trim() ?? "";
	const activeModel = deps.settings.chat?.model?.trim() ?? "";
	const activeRef = activeTarget && activeModel ? modelRefWords(activeTarget, activeModel) : activeTarget;
	const favoriteSet = new Set(deps.settings.chat.modelPicker?.favorites ?? []);
	const recentSet = new Set(listRecentModels({ limit: deps.settings.chat.modelPicker?.recentLimit ?? 12 }));
	const list = [...deps.providers.list()]
		.filter((status) => {
			return status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime);
		})
		.sort((a, b) => {
			const aActive = a.target.id === activeTarget ? 0 : 1;
			const bActive = b.target.id === activeTarget ? 0 : 1;
			return (
				aActive - bActive ||
				statusPriority(a) - statusPriority(b) ||
				(a.runtime?.displayName ?? a.target.runtime).localeCompare(b.runtime?.displayName ?? b.target.runtime) ||
				a.target.id.localeCompare(b.target.id)
			);
		});
	const scopeSet = new Set(deps.settings.chat.modelPicker.cycleSet ?? []);
	const rows: ModelRow[] = [];
	for (const status of list) {
		const { target } = status;
		const runtimeName = status.runtime?.displayName ?? target.runtime;
		const runtimeShortName = shortRuntimeName(runtimeName);
		const candidates = chatModelCandidatesForStatus(status);
		const sourceNote = modelListNoteForStatus(status);
		const authText = authLabel({ providers: deps.providers, status });
		const bucket = modelBucket(status);
		const singleTarget = list.length === 1;
		if (candidates.length === 0) {
			const fallbackModel = target.defaultModel?.trim() ?? "";
			const resolution =
				fallbackModel.length > 0
					? resolveOverlayRuntimeTarget({
							providers: deps.providers,
							status,
							wireModelId: fallbackModel,
							requestedThinkingLevel: deps.settings.chat?.thinkingLevel,
						})
					: null;
			const rowCaps = resolution?.capabilities ?? status.capabilities;
			const decisions = resolution?.capabilityDecisions ?? fallbackCapabilityDecisions(status, rowCaps);
			const row: ModelRow = {
				value: target.id,
				target: target.id,
				model: "",
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? target.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: "missing",
				residency: modelBucket(status) === "cloud" ? null : "unknown",
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				healthCheckedAt: status.health.lastCheckAt,
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution?.thinking ?? "unresolved",
				thinkingNote: resolution?.thinkingNote ?? null,
				streaming: decisions.streaming,
				diagnostics: resolution?.diagnostics ?? [
					{ severity: "error", code: "model-not-configured", message: `target '${target.id}' has no model configured` },
				],
				badges: capabilityBadges(rowCaps),
				context: contextDecisionLabel(decisions),
				maxTokens: maxTokensDecisionLabel(decisions),
				active: target.id === activeTarget,
				scoped: scopeSet.has(target.id),
				favorite: false,
				recent: false,
				defaultModel: false,
				visibleByDefault: target.id === activeTarget || scopeSet.has(target.id),
				selectable: false,
			};
			rows.push(row);
			continue;
		}
		for (const candidate of candidates) {
			const wireModel = candidate.id;
			const rowRef = `${target.id}/${wireModel}`;
			const resolution = resolveOverlayRuntimeTarget({
				providers: deps.providers,
				status,
				wireModelId: wireModel,
				requestedThinkingLevel: deps.settings.chat?.thinkingLevel,
			});
			const rowCaps = resolution.capabilities;
			const decisions = resolution.capabilityDecisions;
			const badges = capabilityBadges(rowCaps);
			const exactScopeHit = scopeSet.has(rowRef);
			const targetScopeHit = scopeSet.has(target.id);
			const scopeHit = exactScopeHit || targetScopeHit;
			const active = target.id === activeTarget && wireModel === activeModel;
			const favorite = favoriteSet.has(rowRef) || exactScopeHit;
			const recent = recentSet.has(rowRef);
			const defaultModel = wireModel === target.defaultModel;
			const targetScopedFocus = targetScopeHit && (active || defaultModel);
			const focusPinned = singleTarget && candidate.source === "configured";
			const row: ModelRow = {
				value: rowRef,
				target: target.id,
				model: wireModel,
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? target.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: candidate.source,
				...(sourceNote ? { sourceNote } : {}),
				...(candidate.loadState ? { loadState: candidate.loadState } : {}),
				...(candidate.loadStateDetail ? { loadStateDetail: candidate.loadStateDetail } : {}),
				residency: modelResidencyWord(status, wireModel),
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				healthCheckedAt: status.health.lastCheckAt,
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution.thinking,
				thinkingNote: resolution.thinkingNote,
				streaming: resolution.streaming,
				diagnostics: resolution.diagnostics,
				badges,
				context: contextDecisionLabel(decisions),
				maxTokens: maxTokensDecisionLabel(decisions),
				active,
				scoped: scopeHit,
				favorite,
				recent,
				defaultModel,
				focusPinned,
				visibleByDefault: active || favorite || recent || defaultModel || targetScopedFocus || focusPinned,
				// A model that cannot call tools stays listed so the operator can see it
				// exists and why it is refused, but it cannot be chosen for the chat role.
				selectable: supportsAgentRoleTools(decisions),
			};
			rows.push(row);
		}
	}
	const summary = buildSummary(rows, list.length, activeRef);
	const activeStatus = list.find((status) => status.target.id === activeTarget);
	const notice = activeStatus
		? newerModelNotice(activeTarget, activeModel, activeStatus.discoveredModels, activeStatus.discoveredModelCreatedAt)
		: null;
	if (notice !== null) summary.newerModelNotice = notice;
	return { rows, summary };
}

/** A connection and its model the way the composer names them: `mock · mock/judge-model`, never `mock/mock/judge-model`. */
export function modelRefWords(target: string, model: string): string {
	return model.length > 0 ? `${target} ${GLYPH.sep} ${model}` : target;
}

/**
 * Keep the target-qualified ref ahead of the bare model id. This mirrors
 * pi-coding-agent's provider-first model-selector search text, so an exact
 * target/model query ranks ahead of a proxy target carrying that ref as its
 * model id. PanCode's runtime and availability facts remain searchable after the
 * ranking prefix.
 */
function modelSelectorSearchText(row: ModelRow): string {
	const qualifiedModel = row.model.length > 0 ? `${row.target}/${row.model}` : row.target;
	return [
		row.target,
		qualifiedModel,
		row.target,
		row.model,
		row.runtimeName,
		row.runtimeShortName,
		row.runtimeId,
		row.apiFamily,
		row.bucket,
		row.source,
		row.loadState ?? "",
		row.loadStateDetail ?? "",
		row.badges,
		row.context,
		row.maxTokens,
		row.authText,
		row.healthText,
	].join(" ");
}

/**
 * Rows a query names, best first: a word of the ref that starts with the query, then the ref containing every word of
 * it, then the row's other facts (runtime, health, residency) containing them. A scattered-letter match only answers
 * when nothing contains the query, because `ornith` matching an embedding model through letters spread across its
 * runtime name and health is noise, not a result (J2-F09).
 */
export function filterModelRows(rows: ReadonlyArray<ModelRow>, query: string): ModelRow[] {
	const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	if (words.length === 0) return [...rows];
	const tiers: ModelRow[][] = [[], [], []];
	for (const row of rows) {
		const ref = (row.model.length > 0 ? `${row.target}/${row.model}` : row.target).toLowerCase();
		const facts = modelSelectorSearchText(row).toLowerCase();
		if (!words.every((word) => ref.includes(word))) {
			if (words.every((word) => facts.includes(word))) tiers[2]?.push(row);
			continue;
		}
		const first = words[0] ?? "";
		const startsWord = ref.split(/[/\s:_.-]+/u).some((part) => part.startsWith(first)) || ref.startsWith(first);
		tiers[startsWord ? 0 : 1]?.push(row);
	}
	const contained = tiers.flat();
	return contained.length > 0 ? contained : fuzzyFilter([...rows], query, modelSelectorSearchText);
}
