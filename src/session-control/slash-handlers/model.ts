// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { resolveSettingsArea, SETTINGS_AREAS } from "../../core/settings-areas.js";
import {
	acceptsImageInput,
	copilotContextTierLabel,
	resolveModelCapabilities,
	resolveModelReference,
} from "../../domains/providers/index.js";
import type { BuiltinSlashCommand } from "../slash-command-types.js";

/** The seven areas a person names; Recent & Pinned is the landing page, not a destination. */
export const SETTINGS_AREA_IDS = SETTINGS_AREAS.filter((area) => area.id !== "recent").map((area) => area.id);

export const MODEL_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "thinking",
		rank: 2,
		acp: false,
		description: "Set the chat thinking level",
		group: "Model and context",
		kinds: ["thinking-set", "thinking-picker"],
		args: { positionals: [{ name: "level", required: false }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "thinking", reason: parsed.error };
			const level = parsed.positionals[0];
			return level ? { kind: "thinking-set", level } : { kind: "thinking-picker" };
		},
		handle(command, ctx) {
			if (command.kind === "thinking-picker") {
				if (ctx.openThinkingPicker) ctx.openThinkingPicker();
				else ctx.notice("error", "thinking picker is not wired in this session");
				return;
			}
			if (command.kind !== "thinking-set") return;
			const result = ctx.setThinkingLevel?.(command.level) ?? { status: "unavailable" as const };
			if (result.status === "applied") {
				ctx.notice("success", `thinking: ${result.display}${result.note ? ` (${result.note})` : ""}`);
			} else if (result.status === "unsupported") {
				ctx.notice("error", `thinking level "${result.level}" is not available here; try ${result.supported.join(", ")}`);
			} else {
				ctx.notice("error", "thinking level cannot be set right now");
			}
			ctx.render?.();
		},
	},
	{
		name: "model",
		rank: 1,
		acp: false,
		description: "Pick a model, or set one by name",
		group: "Model and context",
		kinds: ["model", "model-set"],
		args: {
			positionals: [{ name: "pattern", required: false, rest: true }],
		},
		fromArgs(parsed) {
			const pattern = parsed.positionals[0];
			if (pattern) {
				return { kind: "model-set", pattern };
			}
			return { kind: "model" };
		},
		handle(command, ctx) {
			if (command.kind === "model") {
				ctx.openModel?.();
				return;
			}
			if (command.kind !== "model-set") return;
			void (async () => {
				try {
					await ctx.providers.probeAllLive();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.notice("warn", `model refresh failed; resolving cached catalog: ${msg}`);
				}
				const chatTarget = ctx.getChatTarget?.();
				const result = resolveModelReference(command.pattern, ctx.providers, {
					use: "chat",
					...(chatTarget != null ? { preferTarget: chatTarget } : {}),
				});
				if (!result.ref) {
					ctx.notice("error", result.error ?? `no match for "${command.pattern}"`);
					ctx.render?.();
					return;
				}
				if (result.warning) ctx.notice("warn", result.warning);
				// "reported" means the host's own notice already said what landed.
				if (ctx.applyModelRef?.(result.ref) === "applied") {
					const suffix = result.ref.thinkingLevel ? ` thinking=${result.ref.thinkingLevel}` : "";
					const status = ctx.providers.list().find((candidate) => candidate.target.id === result.ref?.target);
					const caps = status ? resolveModelCapabilities(status, result.ref.model, ctx.providers.knowledgeBase) : null;
					const imageInput = caps === null ? "unknown" : acceptsImageInput({ vision: caps.vision }) ? "yes" : "no";
					const tierLabel = copilotContextTierLabel(status?.target);
					const tier = tierLabel ? ` · ${tierLabel}` : "";
					ctx.notice(
						"success",
						`active this session: ${result.ref.target}/${result.ref.model}${suffix}${tier} · image input ${imageInput}`,
					);
				}
				ctx.render?.();
			})().catch((error: unknown) => {
				// A switch that threw did not happen; say so rather than leave the old model looking chosen.
				ctx.notice("error", `model not changed: ${error instanceof Error ? error.message : String(error)}`);
				ctx.render?.();
			});
		},
	},
	{
		name: "settings",
		rank: 1,
		aliases: [
			{ name: "login", args: "models" },
			{ name: "config", args: "models" },
		],
		acp: false,
		description: "Open interactive settings",
		group: "PanCode",
		kinds: ["settings"],
		args: {
			positionals: [
				{ name: "area", required: false },
				{ name: "group", required: false },
			],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "settings", reason: parsed.error };
			const name = parsed.positionals[0];
			if (name === undefined) return { kind: "settings" };
			const area = resolveSettingsArea(name);
			if (!area) {
				return {
					kind: "usage-error",
					command: "settings",
					reason: `Unknown area: ${name} (one of ${SETTINGS_AREA_IDS.join(", ")})`,
				};
			}
			const group = parsed.positionals[1];
			if (group === undefined) return { kind: "settings", area };
			return { kind: "usage-error", command: "settings", reason: `Use /settings [area]; ${group} is not an area option` };
		},
		handle(command, ctx) {
			if (command.kind === "settings") ctx.openSettings?.(command.area);
		},
	},
];
