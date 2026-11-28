// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ConfigOption, type SessionConfig } from "../../contracts/session-config.js";
import { ACP_NOTICE_META_KEY, ACP_THINKING_LEVELS_META_KEY } from "../../contracts/wire.js";

const UnselectedTarget = Type.Object(
	{ ...ConfigOption.properties, id: Type.Literal("connection"), currentValue: Type.Null() },
	{ additionalProperties: false },
);

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** PanCode carries an option's notice and a model's thinking levels under `_meta`; the GUI contract holds them flat. */
function liftPancodeMeta(row: Record<string, unknown>): Record<string, unknown> {
	const lifted = structuredClone(row);
	const notice = record(record(row._meta)?.[ACP_NOTICE_META_KEY])?.text;
	if (notice !== undefined) lifted.notice = notice;
	if (Array.isArray(row.options)) {
		lifted.options = row.options.map((value) => {
			const choice = record(value);
			if (choice === null) return value;
			const levels = record(choice._meta)?.[ACP_THINKING_LEVELS_META_KEY];
			return levels === undefined ? structuredClone(choice) : { ...structuredClone(choice), thinkingLevels: levels };
		});
	}
	return lifted;
}

/** Only the conversation controls the GUI acts on cross this seam; arbitrary metadata stays in the child. */
export function projectSessionConfigOptions(raw: unknown): SessionConfig["options"] | undefined | null {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length > 16) return null;
	const options: SessionConfig["options"] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const row: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value : {};
		if (row.id !== "connection" && row.id !== "model" && row.id !== "thinkingLevel") continue;
		if (seen.has(row.id)) return null;
		seen.add(row.id);
		// GUI-03: ACP reports an unconfigured target as null. Its absence stays in SessionConfig.target;
		// omitting this unselected control must not discard the model or thinking controls beside it.
		if (row.id === "connection" && row.currentValue === null) {
			if (!Value.Check(UnselectedTarget, Value.Clean(UnselectedTarget, structuredClone(row)))) return null;
			continue;
		}
		const projected = Value.Clean(ConfigOption, liftPancodeMeta(row));
		if (!Value.Check(ConfigOption, projected)) return null;
		options.push(projected);
	}
	return options;
}
