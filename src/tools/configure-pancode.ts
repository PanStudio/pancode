// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { isFleetRoutingPath, PANCODE_SETTINGS_RULE_ID, ROUTING_PIN_HINT } from "../domains/safety/routing-settings.js";
import { StringEnum } from "../engine/ai.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import { lazyTool, type ToolSurface } from "./lazy-tool.js";
import type { ToolConfirmation, ToolSpec } from "./tool-spec.js";

export interface ConfigurePancodeDeps {
	/** An operator is attached who can answer the approval card. False for headless runs. */
	interactive: boolean;
	getAutonomy?: () => AutonomyLevel;
}

export type ConfigurePancodeChange =
	| { kind: "control"; path: string; value: string }
	| { kind: "target"; id: string; target: TargetDescriptor };

export interface ConfigurePancodeProposal {
	id: string;
	path: string;
	change: ConfigurePancodeChange;
	before: string;
	preview: string;
	expiresAt: number;
}

/** The one pending proposal per tool instance, shared by the eager approval card and the lazily loaded runner. */
export interface ConfigurePancodeState {
	pending: ConfigurePancodeProposal | null;
}

/**
 * Why this call may only propose, or null when the operator can approve an
 * apply here. The one place that decides it, so a later autonomy design can
 * change it without touching the tool. At yolo nobody answers the card (#407),
 * headless has no operator, and a read-only run writes nothing.
 */
export function configurePancodeApplyRefusal(context: {
	autonomy: AutonomyLevel | undefined;
	interactive: boolean;
	readOnly: boolean;
}): string | null {
	if (context.readOnly) return "this run is read-only";
	if (!context.interactive) return "no operator is attached to approve it (headless run)";
	if (context.autonomy === "yolo") return "at autonomy yolo nobody reviews the approval card";
	if (context.autonomy !== "default") return "the session autonomy is unknown";
	return null;
}

/**
 * PanCode's guided self-configuration. The model previews one change to the
 * user's saved settings; the operator approves the exact diff on the
 * registry's confirmation card, which journals the approval, and the save
 * goes through the settings writer and is appended to the settings change log.
 * Where nobody can approve (headless, read-only, yolo) a preview is a
 * proposal: the diff plus the steps the operator runs. One pending proposal
 * per session keeps the card and the stale-value check unambiguous. It never
 * accepts credentials, safety or trust settings, or arbitrary paths.
 */
export function createConfigurePancodeTool(deps: ConfigurePancodeDeps): ToolSpec {
	const state: ConfigurePancodeState = { pending: null };
	const surface: ToolSurface = {
		name: ToolNames.ConfigurePancode,
		description:
			"Propose a change to PanCode's saved user settings, then apply the exact proposal after the operator approves its diff. action=preview with a path and a text value returns the diff; action=apply with that proposalId shows the operator an approval card. Paths: chat routing and model picker, fleet.default.*, fleet.profiles, fleet.agentProfiles, fleet.rosters, fleet.concurrency, fleet.limits.*, fleet.retry.*, context.memory.connection/model, interface display settings, and connections.<id> whose value is a JSON object with runtime, url, defaultModel, wireModels, gateway, capabilities and auth.apiKeyEnvVar (the NAME of an environment variable) or auth.oauthProfile. For agent model bindings preview fleet.profiles first, then fleet.agentProfiles; each value is a complete JSON map. Never pass API keys or secrets; credentials are stored by the operator with pancode auth login. Headless, read-only and yolo runs can only preview: hand the operator the diff and steps it returns. Safety, permissions, autonomy, trust and credentials are changed only by the operator. For a one-off run, pin dispatch's connection and model instead of saving routing.",
		placement: "gateway",
		parameters: Type.Object({
			action: StringEnum(["preview", "apply"]),
			path: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
			proposalId: Type.Optional(Type.String()),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		confirmationFor(args): ToolConfirmation | undefined {
			if (args.action !== "apply" || !state.pending || args.proposalId !== state.pending.id) return undefined;
			if (
				configurePancodeApplyRefusal({ autonomy: deps.getAutonomy?.(), interactive: deps.interactive, readOnly: false }) !==
				null
			)
				return undefined;
			const routing = isFleetRoutingPath(state.pending.path);
			return {
				ruleId: routing ? "fleet-routing-settings" : PANCODE_SETTINGS_RULE_ID,
				detail: `configure_pancode saves this change to your user settings (settings.yaml):\n${state.pending.preview}`,
				hints: routing ? [ROUTING_PIN_HINT] : [],
			};
		},
	};
	// The runner holds the settings controls and validator, which a worker never needs until a call runs.
	return lazyTool(surface, async () =>
		(await import("./configure-pancode-runner.js")).configurePancodeRunner(surface, deps, state),
	);
}
