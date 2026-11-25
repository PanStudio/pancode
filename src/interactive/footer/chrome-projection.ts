// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure presentation projections over `HarnessFactsSnapshot` / `HarnessFactsSource`.
 *
 * Every glyph, theme token, width calculation, spinner frame, and English chrome phrase
 * lives here (beside the footer renderers), keeping `src/interactive/harness-facts.ts`
 * strictly data-only.
 */

import { copilotContextTierLabel } from "../../domains/providers/index.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import { dispatchSegment } from "../footer-panel.js";
import type {
	HarnessFactsSnapshot,
	HarnessFactsSource,
	HarnessRouteReadinessData,
	HarnessThinkingFacts,
} from "../harness-facts.js";
import type { EditorChrome } from "../pancode-editor-model.js";
import { animationStep, collapseHomePath, formatTargetLabel, GLYPH } from "../theme/index.js";
import { abbreviateModelId, modelNickname } from "../theme/labels.js";
import { thinkingNoteWords } from "../thinking-note.js";
import type { ThinkingRailFacts } from "./context-rail.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import type { ComposerKeyContext, KeyHintFacts } from "./key-hints.js";
import { routeFirstOutput, silenceNoteForms } from "./silence-note.js";
import { footerTelemetry } from "./spend.js";
import type { WorkspaceFacts } from "./widgets.js";
import { formatToolTally } from "./widgets.js";

export interface FooterRenderUiContext {
	readonly width: number;
	readonly now: number;
	readonly welcomeVisible: boolean;
	readonly demo: boolean;
	readonly demoHint: string | null;
	readonly deckOpen?: boolean;
	readonly readiness?: HarnessRouteReadinessData | null;
	readonly compactKeysDoor?: boolean;
	readonly fleetBandVisible?: boolean;
	readonly fleetBoardOpen?: boolean;
	readonly whisper?: string | null;
	readonly contextualMoment?: string | null;
	readonly extensionFacts?: ReadonlyArray<string>;
	readonly workspaceLine?: string | null;
	readonly keyContext?: ComposerKeyContext;
	readonly keyHintFacts?: KeyHintFacts;
}

/** Minimal harness-backed callbacks remaining on `EditorChrome` (approval actor and composer surface mode). */
export type HarnessEditorChrome = Pick<EditorChrome, "getApprovalActor" | "getAutonomy">;

function formatPancodeMdState(value: HarnessFactsSnapshot["context"]["pancodeMdState"]): string | null {
	return value ? `PANCODE.md ${value}` : null;
}

function formatMemoryState(count: number | null): string | null {
	return typeof count === "number" && count > 0 ? `mem ${count}` : null;
}

function workspaceFactsFrom(snapshot: WorkspaceSnapshot | null, branchFallback: string | null): WorkspaceFacts {
	if (snapshot) {
		return {
			cwd: collapseHomePath(snapshot.cwd),
			branch: snapshot.branch,
			...(snapshot.detachedAt !== undefined ? { detachedAt: snapshot.detachedAt } : {}),
			...(snapshot.pending || snapshot.gitUnknown ? { branchPending: true } : {}),
			dirty: snapshot.dirty,
			projectType: snapshot.projectType && snapshot.projectType !== "unknown" ? snapshot.projectType : null,
			remote: snapshot.remoteUrl,
		};
	}
	return {
		cwd: collapseHomePath(process.cwd()),
		branch: branchFallback,
		dirty: null,
		projectType: null,
		remote: null,
	};
}

export function projectThinkingRail(facts: HarnessThinkingFacts): ThinkingRailFacts {
	if (facts.alwaysThinks) {
		return { label: "on", hasLevels: false, supportedLevels: [], note: "this model always thinks" };
	}
	if (facts.unprobed) {
		return { label: facts.requestedLevel, hasLevels: false };
	}
	const capability = facts.capability;
	const note =
		capability && facts.resolvedModelId !== null
			? thinkingNoteWords({ ...capability, model: facts.resolvedModelId })
			: null;
	return {
		label:
			note !== null && capability
				? capability.display
				: capability?.mechanism === "none"
					? "unavailable"
					: (capability?.display ?? facts.requestedLevel),
		hasLevels: capability?.mechanism === "effort-levels" || capability?.mechanism === "budget-tokens",
		supportedLevels: capability?.supportedLevels ?? [],
		...(note !== null ? { note } : {}),
		...(capability?.mechanism === "none" && (note === null || facts.isDefaultRequest || facts.noteDelivered)
			? { quiet: true }
			: {}),
	};
}

/** Project one immutable data-only `HarnessFactsSnapshot` plus footer UI state into `FooterDashboardRenderState`. */
export function projectFooterRenderState(
	snapshot: HarnessFactsSnapshot,
	ui: FooterRenderUiContext,
): FooterDashboardRenderState {
	const { route, autonomy, activity, context, work, telemetry, workspace, notices } = snapshot;
	const frame = animationStep(ui.now);
	const tierLabel = copilotContextTierLabel(route.targetStatus?.target);
	const routeLabel = formatTargetLabel(route.targetId ?? undefined, route.modelId ?? undefined, { abbreviate: false });
	const target = tierLabel ? `${routeLabel} ${GLYPH.sep} ${tierLabel}` : routeLabel;
	const spend = footerTelemetry(telemetry.view);
	const silenceNotes = activity.hasStatusProducer
		? silenceNoteForms(
				activity.status,
				ui.now,
				snapshot.retrySettings,
				() => routeFirstOutput(telemetry.view, route.targetId, route.modelId),
				route.runtimeTier,
			)
		: null;
	return {
		outputStyle: snapshot.tier,
		...(ui.extensionFacts && ui.extensionFacts.length > 0 ? { extensionFacts: ui.extensionFacts } : {}),
		...(ui.workspaceLine ? { workspaceLine: ui.workspaceLine } : {}),
		quota: telemetry.quota,
		...(route.runtimeId && route.wireModelId
			? {
					quotaRoute: {
						runtimeId: route.runtimeId,
						wireModelId: route.wireModelId,
					},
				}
			: {}),
		...(workspace.connections
			? { connections: { mcp: [...workspace.connections.mcp], plugins: [...workspace.connections.plugins] } }
			: {}),
		...(telemetry.costCeilingUsd !== undefined ? { costCeilingUsd: telemetry.costCeilingUsd } : {}),
		workspace: workspaceFactsFrom(workspace.snapshot, workspace.branchFallback),
		session: {
			name: workspace.session.name,
			target,
			autonomy: autonomy.mode,
			yoloConfinement: autonomy.yoloConfinement,
			...(autonomy.window ? { autonomyWindow: autonomy.window } : {}),
			targetId: route.targetId,
			modelId: route.modelId,
			leaderArmed: notices.leaderArmed,
			shutdownArmed: notices.shutdownArmed,
			activeSkills: workspace.activeSkills,
			duckBadge: workspace.duckBadge,
			memoryIntervention: workspace.memoryIntervention,
		},
		context: {
			...(context.budget ? { budget: context.budget } : {}),
			label: null,
			used: context.used,
			contextWindow: context.contextWindow,
			toolSchemaTokens: context.toolSchemaTokens,
			compactionThreshold: context.compactionThreshold,
			compactionAuto: context.compactionAuto,
			compactionActive: context.compactionActive,
			pancodeMd: formatPancodeMdState(context.pancodeMdState),
			memory: formatMemoryState(context.memoryCount),
			extensions: context.extensions,
			breakdown: context.breakdown ?? null,
			ledger: context.ledger ?? null,
		},
		agent: {
			statusText: null,
			dispatchSummary: dispatchSegment(work.dispatchRows),
			toolTally: formatToolTally(activity.toolCounts, context.ledger?.toolCount ?? null),
			dispatchRows: work.dispatchRows,
			contextActivity: activity.contextActivity,
			lastTurn: activity.lastTurn,
			taskBoard: work.taskBoard,
			localCapacity: work.localCapacity,
		},
		silenceNotes,
		demo: ui.demo,
		...(ui.keyContext ? { keyContext: ui.keyContext } : {}),
		...(ui.keyHintFacts ? { keyHintFacts: ui.keyHintFacts } : {}),
		background: activity.backgroundCalls,
		welcomeVisible: ui.welcomeVisible,
		demoHint: ui.demoHint,
		notices: notices.live,
		endedNotices: notices.ended,
		...(notices.dismissKeyLabel ? { dismissKeyLabel: notices.dismissKeyLabel } : {}),
		status: activity.status,
		toolCounts: activity.toolCounts,
		dispatchRows: work.dispatchRows,
		throughput: telemetry.throughput,
		telemetry: spend,
		tick: frame,
		now: ui.now,
		factsRevision: snapshot.revision,
		...(ui.deckOpen ? { deckOpen: true } : {}),
		thinking: projectThinkingRail(snapshot.thinking),
		loops: snapshot.work.loops,
		...(ui.readiness !== undefined ? { readiness: ui.readiness } : {}),
		learned: snapshot.learned,
		...(ui.compactKeysDoor ? { compactKeysDoor: true } : {}),
		...(ui.fleetBandVisible ? { fleetBandVisible: true } : {}),
		...(ui.fleetBoardOpen ? { fleetBoardOpen: true } : {}),
		...(ui.whisper !== undefined ? { whisper: ui.whisper } : {}),
		...(ui.contextualMoment !== undefined ? { contextualMoment: ui.contextualMoment } : {}),
	};
}

/**
 * Minimal harness-backed callbacks on `EditorChrome`: actor name for docked approval cards
 * and autonomy mode for composer surface tint.
 */
export function harnessEditorChrome(facts: HarnessFactsSource): HarnessEditorChrome {
	return {
		// The card names the model as the status bar below it does, `gpt-6-luna` rather than the rail's `GPT-6-luna`.
		getApprovalActor: () => {
			const modelId = facts.modelIdentity().modelId;
			return modelId ? abbreviateModelId(modelId) : modelNickname(modelId);
		},
		getAutonomy: () => facts.autonomyMode(),
	};
}
