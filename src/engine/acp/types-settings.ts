// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Safe settings and targets: the `_pancode/settings` read and patch shapes,
 * the target list and probe result, and the model-to-target setting paths.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import { literalUnion } from "../../core/telemetry/enums.js";
import { THINKING_LEVELS } from "../../core/views/thinking-levels.js";
import {
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TARGETS,
	ACP_TARGET_MODEL_LIMIT,
	ACP_TRUNCATED_META_KEY,
	AcpRuntimeComponent,
	closed,
	noControls,
} from "./types.js";

const settingTarget = Type.Union([
	Type.String({ minLength: 1, maxLength: ACP_MAX_TARGET_ID_BYTES, pattern: noControls }),
	Type.Null(),
]);
const settingModel = Type.Union([
	Type.String({ minLength: 1, maxLength: ACP_MAX_MODEL_ID_BYTES, pattern: noControls }),
	Type.Null(),
]);
const AcpThinkingLevelSchema = literalUnion(THINKING_LEVELS);
export const AcpAutonomyLevelSchema = Type.Union([Type.Literal("default"), Type.Literal("yolo")]);
export const ACP_SAFE_SETTINGS_KEYS = ["chat.target", "chat.model", "chat.thinkingLevel", "safety.autonomy"] as const;
/** `params.patch` of `_pancode/settings/patch_safe`. */
export const AcpSafeSettingsPatchSchema = Type.Object(
	{
		"chat.target": Type.Optional(settingTarget),
		"chat.model": Type.Optional(settingModel),
		"chat.thinkingLevel": Type.Optional(AcpThinkingLevelSchema),
		"safety.autonomy": Type.Optional(AcpAutonomyLevelSchema),
	},
	closed,
);
export type AcpSafeSettingsPatch = Static<typeof AcpSafeSettingsPatchSchema>;
/** The result of `_pancode/settings/get_safe` and `_pancode/settings/patch_safe`. */
export const AcpSafeSettings = Type.Object(
	{
		settings: Type.Object(
			{
				chat: Type.Object({ target: settingTarget, model: settingModel, thinkingLevel: AcpThinkingLevelSchema }, closed),
				safety: Type.Object({ autonomy: AcpAutonomyLevelSchema }, closed),
			},
			closed,
		),
		editable: Type.Array(
			Type.Union([
				Type.Literal("chat.target"),
				Type.Literal("chat.model"),
				Type.Literal("chat.thinkingLevel"),
				Type.Literal("safety.autonomy"),
			]),
			{ maxItems: 4, minItems: 4, uniqueItems: true },
		),
	},
	closed,
);
export type AcpSafeSettings = Static<typeof AcpSafeSettings>;

/** One configured target in `_pancode/targets/list`. */
export const AcpTarget = Type.Object(
	{
		id: Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }),
		runtime: Type.String({ maxLength: 64 }),
		/** Default, declared and discovered model ids, deduplicated, at most {@link ACP_TARGET_MODEL_LIMIT}. */
		models: Type.Array(Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), { maxItems: ACP_TARGET_MODEL_LIMIT }),
		/** True when the target knows more model ids than `models` carries. */
		modelsTruncated: Type.Optional(Type.Boolean()),
		thinkingLevels: Type.Optional(
			Type.Record(
				Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }),
				Type.Array(Type.String({ maxLength: 16 }), { maxItems: THINKING_LEVELS.length }),
			),
		),
		isOrchestrator: Type.Boolean(),
		/** The endpoint with credentials, query and fragment removed; null when the target has none. */
		url: Type.Optional(Type.Union([Type.String({ maxLength: 2048 }), Type.Null()])),
		defaultModel: Type.Optional(Type.Union([Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), Type.Null()])),
		available: Type.Optional(Type.Boolean()),
		/** The provider domain's health status as this process last observed it. */
		health: Type.Optional(Type.String({ maxLength: 64 })),
		tier: Type.Optional(Type.String({ maxLength: 64 })),
		contextWindow: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])),
	},
	closed,
);
export type AcpTarget = Static<typeof AcpTarget>;
/** The result of `_pancode/targets/list`. `_meta["pancode/truncated"]` marks a list cut at the line budget. */
export const AcpTargetList = Type.Object(
	{
		targets: Type.Array(AcpTarget, { maxItems: ACP_MAX_TARGETS }),
		_meta: Type.Optional(Type.Object({ [ACP_TRUNCATED_META_KEY]: Type.Optional(Type.Boolean()) }, closed)),
	},
	closed,
);
export type AcpTargetList = Static<typeof AcpTargetList>;

/** The result of `_pancode/targets/probe`. */
export const AcpTargetProbe = Type.Object(
	{
		targetId: Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }),
		healthy: Type.Boolean(),
		latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		reason: Type.Union([
			Type.Null(),
			Type.Literal("not-configured"),
			Type.Literal("unreachable"),
			Type.Literal("unsupported"),
			Type.Literal("probe-failed"),
			Type.Literal("component-missing"),
		]),
		/** With `component-missing`: the `pancode tools install` id the target's runtime needs. */
		component: Type.Optional(AcpRuntimeComponent),
	},
	closed,
);
export type AcpTargetProbe = Static<typeof AcpTargetProbe>;

export const MODEL_TARGET_PATHS: Readonly<Record<string, string>> = {
	"chat.model": "chat.target",
	"fleet.default.model": "fleet.default.target",
	"context.memory.model": "context.memory.target",
	"context.compaction.model": "chat.target",
};
