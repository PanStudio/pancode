// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import type { BuiltinSlashCommand, SlashCommandContext } from "../slash-command-types.js";
import { usageError } from "./usage-error.js";

type SlashRunVerification = ReturnType<NonNullable<SlashCommandContext["verifyRun"]>>;

/** The full receipt and individual checks remain in the viewer's details. */
function formatRunVerificationBlock(runId: string, result: SlashRunVerification): string {
	const verdict = result.ok
		? (result.verificationSummary ?? result.trustSummary ?? "run seal verified; result validation unknown")
		: `failed. ${result.reason}`;
	return `Verification for ${runId}: ${verdict}\n/view run:${runId} · press i for full details and checks.`;
}

export const MEMORY_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "memory",
		rank: 2,
		acp: { subcommands: ["seed"] },
		description: "Inspect, promote, or seed task memory",
		group: "Model and context",
		kinds: ["memory", "memory-seed"],
		subcommandDescriptions: { seed: "Seed the task bank from the newest handoff" },
		args: { subcommands: { seed: {} } },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "memory", reason: parsed.error };
			return parsed.subcommand === "seed" ? { kind: "memory-seed" } : { kind: "memory" };
		},
		handle(command, ctx) {
			if (command.kind === "memory") {
				ctx.openMemory?.();
				return;
			}
			if (command.kind !== "memory-seed") return;
			const result = ctx.seedTaskMemory?.() ?? { status: "not-found" as const };
			switch (result.status) {
				case "seeded":
					ctx.notice(
						"success",
						`task memory seeded ${result.seeded} entr${result.seeded === 1 ? "y" : "ies"} from ${result.source}${result.skipped > 0 ? `; skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : ""}${(result.flowRuleIds?.length ?? 0) > 0 ? `. This session now carries the source's information-flow restrictions (${result.flowRuleIds?.join(", ")}), so a route they refuse fails on the next prompt` : ""}`,
					);
					return;
				case "disabled":
					ctx.notice("warn", "task memory is disabled; enable context.memory.enabled before seeding");
					return;
				case "not-found":
					ctx.notice("info", "no structured task-memory snapshot found in the newest handoff");
					return;
				case "refused":
					ctx.notice("warn", `task memory not seeded: ${result.reason}`);
			}
		},
	},
	{
		name: "remember",
		rank: 2,
		acp: { readOnlyRefuses: true },
		description: "Remember a fact, preference, rule or command; undo or change the scope of the last one",
		group: "Model and context",
		kinds: ["remember"],
		args: { positionals: [{ name: "text", required: true, rest: true }] },
		fromArgs(parsed) {
			const rest = parsed.rest?.trim() ?? "";
			if (parsed.error || rest.length === 0) return usageError("remember", parsed.error);
			const [head = "", ...tail] = rest.split(/\s+/u);
			if (head === "undo" && tail.length <= 1)
				return { kind: "remember", action: "undo", ...(tail[0] ? { captureId: tail[0] } : {}) };
			const scope = (["session", "project", "global"] as const).find((value) => value === tail[0]);
			if (head === "scope" && scope !== undefined && tail.length <= 2)
				return { kind: "remember", action: "scope", scope, ...(tail[1] ? { captureId: tail[1] } : {}) };
			if (head === "scope" && tail.length <= 2)
				return usageError("remember", "scope takes session, project or global, then an optional capture id");
			if (head === "forget" && tail.length > 0)
				return { kind: "remember", action: "forget", text: rest.slice("forget".length).trim() };
			return { kind: "remember", action: "remember", text: rest };
		},
		handle(command, ctx) {
			if (command.kind !== "remember") return;
			const memory = ctx.operatorMemory;
			if (!memory) {
				ctx.notice("error", "remember is not wired: no chat session is bound to this process");
				return;
			}
			const work = (async () => {
				const report =
					command.action === "undo"
						? await memory.undo(command.captureId)
						: command.action === "scope" && command.scope !== undefined
							? await memory.rescope(command.scope, command.captureId)
							: command.action === "forget"
								? await memory.forget(command.text ?? "")
								: await memory.remember(command.text ?? "");
				ctx.notice(report.level === "warning" ? "warn" : report.level, report.text);
			})().catch((error: unknown) => {
				ctx.notice("error", `remember failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			ctx.holdReplyFor?.(work);
		},
	},
	{
		name: "view",
		rank: 2,
		acp: false,
		description: "Browse session artifacts and verify run records",
		group: "Work",
		kinds: ["view", "view-verify"],
		args: {
			positionals: [{ name: "filter", required: false, rest: true }],
			subcommands: {
				verify: {
					positionals: [{ name: "runId", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "view", reason: parsed.error };
			if (parsed.subcommand === "verify") {
				const runId = parsed.positionals[0] ?? "";
				return { kind: "view-verify", runId };
			}
			return parsed.rest ? { kind: "view", filter: parsed.rest } : { kind: "view" };
		},
		handle(command, ctx) {
			if (command.kind === "view") {
				ctx.openView?.(command.filter);
				return;
			}
			if (command.kind !== "view-verify") return;
			if (!ctx.verifyRun) {
				ctx.notice("warn", "Run verification is unavailable on this surface");
				return "rejected";
			}
			const result = ctx.verifyRun(command.runId);
			const block = formatRunVerificationBlock(command.runId, result);
			if (result.ok) ctx.notice(result.compromised ? "warn" : "success", block);
			else ctx.notice("error", block);
		},
	},
];
