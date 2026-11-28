// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { forcedAcpAgentId } from "../../domains/interop/peer-modes.js";
import { isToolProfileName, TOOL_PROFILE_NAMES } from "../../tools/profiles.js";
import {
	COUNCIL_MAX_ROUNDS,
	COUNCIL_SYNTHESIS_MODES,
	type CouncilCommandOptions,
	isCouncilSynthesisMode,
	parseCouncilDeadline,
} from "../council.js";
import { parseDraftArgs } from "../drafts.js";
import {
	LOOP_NO_HOST_NOTICE,
	LOOP_OBSERVE_VERBS,
	LOOP_SUBCOMMAND_DESCRIPTIONS,
	parseLoopLine,
	runLoopCommand,
} from "../loop-command.js";
import { type PollCommandOptions, pollChoiceProblem } from "../poll.js";
import type { BuiltinSlashCommand, RunCommandOptions } from "../slash-command-types.js";
import {
	admissionSignal,
	externalIgnoredFlags,
	externalRunAgent,
	handleCouncil,
	handleOracle,
	handlePoll,
	handleRun,
	isRunThinkingLevel,
	RUN_THINKING_LEVELS,
	standingLimits,
	startDelegate,
} from "./run.js";
import { usageError } from "./usage-error.js";

export const WORK_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "run",
		rank: 1,
		acp: { streams: "dispatch" },
		description: "Run a fleet agent on a task",
		group: "Work",
		kinds: ["run"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--agent-profile", takesValue: true, valueName: "profile" },
				{ name: "--runtime", takesValue: true, valueName: "runtimeId" },
				{ name: "--target", takesValue: true, valueName: "id" },
				{ name: "--worktree" },
				{ name: "--read-only" },
				{ name: "--model", takesValue: true, valueName: "id" },
				{ name: "--thinking", takesValue: true, values: RUN_THINKING_LEVELS, valueName: "level" },
				{ name: "--tool-profile", takesValue: true, values: TOOL_PROFILE_NAMES },
				{ name: "--require", takesValue: true, repeatable: true, valueName: "cap" },
				{ name: "--share" },
			],
			positionals: [
				{ name: "agent", required: true },
				{ name: "task", required: true, rest: true },
			],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return usageError("run", parsed.error);
			const options: RunCommandOptions = {};

			const workerProfile = parsed.flags.get("--agent-profile");
			if (typeof workerProfile === "string") options.workerProfile = workerProfile;

			const workerRuntime = parsed.flags.get("--runtime");
			if (typeof workerRuntime === "string") options.workerRuntime = workerRuntime;

			const target = parsed.flags.get("--target");
			if (typeof target === "string") options.target = target;
			if (parsed.flags.has("--worktree")) options.worktree = true;
			if (parsed.flags.has("--read-only")) options.readOnly = true;

			const model = parsed.flags.get("--model");
			if (typeof model === "string") options.model = model;

			const thinking = parsed.flags.get("--thinking");
			if (typeof thinking === "string") {
				if (!isRunThinkingLevel(thinking)) return usageError("run", `--thinking takes ${RUN_THINKING_LEVELS.join(", ")}`);
				options.thinkingLevel = thinking;
			}

			const toolProfile = parsed.flags.get("--tool-profile");
			if (typeof toolProfile === "string") {
				if (!isToolProfileName(toolProfile))
					return usageError("run", `--tool-profile takes ${TOOL_PROFILE_NAMES.join(", ")}`);
				options.toolProfile = toolProfile;
			}

			const requiredCapabilities = parsed.flagValues.get("--require");
			if (requiredCapabilities && requiredCapabilities.length > 0) {
				options.requiredCapabilities = [...requiredCapabilities];
			}

			if (parsed.flags.has("--share")) options.share = true;

			const agentId = parsed.positionals[0] ?? "";
			const task = parsed.positionals[1] ?? "";

			// `acp:<id>` is external whatever the settings say, so its refusal is a parse error and the draft stays.
			const forcedId = forcedAcpAgentId(agentId);
			const forced = forcedId !== null ? externalIgnoredFlags(options) : [];
			if (forced.length > 0) {
				return usageError("run", `${forcedId} is an external agent, which ignores ${forced.join(", ")}`);
			}
			return { kind: "run", agentId, task, options, source: trimmed };
		},
		handle(command, ctx) {
			if (command.kind !== "run") return;
			const { agentId, task, options } = command;
			const external = externalRunAgent(agentId, ctx);
			if (external !== null) {
				const ignored = externalIgnoredFlags(options);
				if (ignored.length > 0) {
					ctx.notice(
						"error",
						`${external} is an external agent, which ignores ${ignored.join(", ")}. usage: /run <agent> [--share] [--read-only] <task>`,
					);
					ctx.render?.();
					return "rejected";
				}
				startDelegate(
					{
						kind: "delegate",
						agentId: external,
						task,
						source: command.source,
						...(options.share ? { share: true } : {}),
						...(options.readOnly ? { readOnly: true } : {}),
					},
					ctx,
				);
				return;
			}
			ctx.echoOperatorCommand?.(command.source);
			const start = admissionSignal();
			void (async () => {
				try {
					await handleRun(
						agentId,
						task,
						{
							onAdmission: start.resolve,
							dispatch: ctx.dispatch,
							...(ctx.getDecisionBoard ? { getDecisionBoard: ctx.getDecisionBoard } : {}),
							...(ctx.getAgentRoleFacts ? { getAgentRoleFacts: ctx.getAgentRoleFacts } : {}),
							io: ctx.io,
							notice: ctx.notice,
							runtimeForTarget: (id) => ctx.providers.getTarget(id)?.runtime ?? null,
							bus: ctx.bus,
							...(ctx.submitOperatorNote ? { submitOperatorNote: ctx.submitOperatorNote } : {}),
							...standingLimits(ctx),
						},
						options,
					);
				} catch (error) {
					// A throw before admission is a run that never started; say so instead of losing it.
					ctx.notice("error", `run did not start: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					start.resolve("refused");
				}
				ctx.render?.();
			})();
			ctx.awaitDispatchStart?.(start.promise);
		},
	},
	{
		name: "btw",
		rank: 3,
		acp: false,
		description: "Ask a side question that never enters the session transcript",
		group: "Work",
		kinds: ["btw"],
		args: {
			positionals: [{ name: "question", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const question = parsed.rest?.trim() ?? "";
			if (parsed.error || question.length === 0) return usageError("btw", parsed.error);
			return { kind: "btw", question };
		},
		handle(command, ctx) {
			if (command.kind !== "btw") return;
			ctx.openSideQuestion?.(command.question);
		},
	},
	{
		name: "draft",
		rank: 3,
		acp: false,
		description: "Draft 2-4 answers in parallel and pick the strongest",
		group: "Work",
		kinds: ["draft"],
		args: {
			positionals: [{ name: "request", required: true, rest: true }],
		},
		fromArgs(parsed) {
			if (parsed.error) return usageError("draft", parsed.error);
			const read = parseDraftArgs(parsed.rest ?? "");
			if ("error" in read) return usageError("draft", read.error);
			return { kind: "draft", request: read.request, count: read.count };
		},
		handle(command, ctx) {
			if (command.kind !== "draft") return;
			ctx.openDraft?.(command.request, command.count);
		},
	},
	{
		name: "oracle",
		rank: 3,
		acp: { streams: "dispatch", injectsUserTurn: true, readOnlyRefuses: true },
		description: "Have a read-only advisor challenge a question against settled decisions",
		group: "Work",
		kinds: ["oracle"],
		args: {
			positionals: [{ name: "question", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const question = parsed.rest?.trim() ?? "";
			if (parsed.error || question.length === 0) return usageError("oracle", parsed.error);
			return { kind: "oracle", question };
		},
		handle(command, ctx) {
			if (command.kind !== "oracle") return;
			const operation = (async () => {
				await handleOracle(command.question, ctx);
				ctx.render?.();
			})();
			ctx.holdReplyFor?.(operation);
		},
	},
	{
		name: "council",
		rank: 3,
		acp: { streams: "dispatch", promptTurn: true },
		description: "Ask several read-only agents the same task, then vote or synthesize",
		group: "Work",
		kinds: ["council"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--roster", takesValue: true, valueName: "name" },
				{ name: "--rounds", takesValue: true, valueName: "n" },
				{ name: "--synthesis", takesValue: true, values: COUNCIL_SYNTHESIS_MODES },
				{ name: "--agent", takesValue: true, valueName: "id" },
				{ name: "--deadline", takesValue: true, valueName: "duration" },
			],
			positionals: [{ name: "task", required: true, rest: true }],
		},
		fromArgs(parsed, trimmed) {
			const task = parsed.rest?.trim() ?? "";
			if (parsed.error) return usageError("council", parsed.error);
			if (task.length === 0) return usageError("council", "Missing required argument: task");
			const options: CouncilCommandOptions = {};
			const roster = parsed.flags.get("--roster");
			if (typeof roster === "string") options.roster = roster;
			const agent = parsed.flags.get("--agent");
			if (typeof agent === "string" && agent.trim().length > 0) options.agent = agent.trim();
			const deadline = parsed.flags.get("--deadline");
			if (typeof deadline === "string") {
				const ms = parseCouncilDeadline(deadline);
				if (ms === undefined) return usageError("council", "--deadline takes a duration such as 30s, 5m or 500ms");
				options.memberDeadlineMs = ms;
			}
			const rounds = parsed.flags.get("--rounds");
			if (typeof rounds === "string") {
				const parsedRounds = Number(rounds);
				// The tool bounds rounds at one to three, and a council that is
				// refused after admission has already shown the operator a plan it
				// cannot run, so the same bound is enforced where it was typed.
				if (!Number.isInteger(parsedRounds) || parsedRounds < 1 || parsedRounds > COUNCIL_MAX_ROUNDS) {
					return usageError("council", `--rounds must be an integer 1..${COUNCIL_MAX_ROUNDS}`);
				}
				options.rounds = parsedRounds;
			}
			const synthesis = parsed.flags.get("--synthesis");
			if (typeof synthesis === "string") {
				if (!isCouncilSynthesisMode(synthesis))
					return usageError("council", `--synthesis takes ${COUNCIL_SYNTHESIS_MODES.join(", ")}`);
				options.synthesis = synthesis;
			}
			return { kind: "council", task, options, source: trimmed };
		},
		handle(command, ctx) {
			if (command.kind !== "council") return;
			// The question the round answers sits above its cards, as a /run's does.
			ctx.echoOperatorCommand?.(command.source);
			const operation = (async () => {
				await handleCouncil(command.task, command.options, ctx);
				ctx.render?.();
			})();
			ctx.holdReplyFor?.(operation);
		},
	},
	{
		name: "poll",
		rank: 3,
		acp: { streams: "dispatch", promptTurn: true },
		description: "Poll n independent agents on a question and show the vote distribution",
		group: "Work",
		kinds: ["poll"],
		args: {
			parseFlagsBeforeRest: true,
			flags: [
				{ name: "--options", takesValue: true, valueName: "a|b|c" },
				{ name: "--models", takesValue: true, valueName: "target[/model],..." },
				{ name: "--rationale", takesValue: false },
				{ name: "--deadline", takesValue: true, valueName: "duration" },
			],
			positionals: [{ name: "n question", required: true, rest: true }],
		},
		fromArgs(parsed, trimmed) {
			if (parsed.error) return usageError("poll", parsed.error);
			const match = /^(\d+)\s+([\s\S]+)$/u.exec(parsed.rest?.trim() ?? "");
			if (match === null) return usageError("poll", "Missing required arguments: n question");
			const options: PollCommandOptions = { participants: Number(match[1]), question: (match[2] ?? "").trim() };
			const choices = parsed.flags.get("--options");
			if (typeof choices === "string") {
				const list = choices
					.split("|")
					.map((choice) => choice.trim())
					.filter((choice) => choice.length > 0);
				if (list.length < 2) return usageError("poll", "--options takes two or more choices, a|b|c");
				for (const choice of list) {
					const problem = pollChoiceProblem(choice);
					if (problem !== undefined) return usageError("poll", `--options ${problem}`);
				}
				options.options = list;
			}
			const models = parsed.flags.get("--models");
			if (typeof models === "string") options.models = models.split(",").filter((entry) => entry.trim().length > 0);
			if (parsed.flags.get("--rationale") === true) options.rationale = true;
			const deadline = parsed.flags.get("--deadline");
			if (typeof deadline === "string") {
				const ms = parseCouncilDeadline(deadline);
				if (ms === undefined) return usageError("poll", "--deadline takes a duration such as 30s, 5m or 500ms");
				options.memberDeadlineMs = ms;
			}
			return { kind: "poll", options, source: trimmed };
		},
		handle(command, ctx) {
			if (command.kind !== "poll") return;
			ctx.echoOperatorCommand?.(command.source);
			const operation = (async () => {
				await handlePoll(command.options, ctx);
				ctx.render?.();
			})();
			ctx.holdReplyFor?.(operation);
		},
	},
	{
		name: "loop",
		rank: 2,
		// Its jobs fire user turns later, outside any prompt, which is what this marker tells a client.
		// Listing and controlling jobs submits nothing, so those verbs stay available while a prompt runs.
		acp: {
			injectsUserTurn: true,
			injectsUserTurnExcept: LOOP_OBSERVE_VERBS,
			reads: ["", "status"],
			// Resume restarts jobs that fire turns, so a ceiling does not admit it.
			sessionOnly: ["stop", "pause"],
		},
		description: "Run a bounded recurring job: a main-context task or a typed command",
		group: "Work",
		kinds: ["loop"],
		args: {
			flags: [
				{ name: "--count", takesValue: true, valueName: "runs" },
				{ name: "--for", takesValue: true, valueName: "duration" },
				{ name: "--until-stopped", takesValue: false },
				{ name: "--timeout", takesValue: true, valueName: "duration" },
				{ name: "--until", takesValue: true, valueName: "json.path == value" },
				{ name: "--on-match", takesValue: true, values: ["notice", "main_turn"] },
				{ name: "--follow-up", takesValue: true, valueName: "text" },
				{ name: "--command", takesValue: true, valueName: "program [args...]" },
			],
			positionals: [
				{ name: "every", required: false },
				{ name: "task", required: false, rest: true },
			],
			subcommands: {
				status: { positionals: [{ name: "id", required: false }] },
				pause: { positionals: [{ name: "id", required: true }] },
				resume: { positionals: [{ name: "id", required: true }] },
				stop: { flags: [{ name: "--now" }], positionals: [{ name: "id", required: false }] },
			},
		},
		subcommandDescriptions: LOOP_SUBCOMMAND_DESCRIPTIONS,
		// The one hand parser left: `--command program [args…]` takes the rest of the line as argv,
		// which CommandArgsSpec cannot express, and parseLoopLine carries its own quoting and duration rules.
		match(text) {
			if (!/^\/loop(?:\s|$)/u.test(text)) return null;
			const parsed = parseLoopLine(text.slice("/loop".length));
			return parsed.ok
				? { kind: "loop", command: parsed.command }
				: { kind: "usage-error", command: "loop", reason: parsed.reason };
		},
		handle(command, ctx) {
			if (command.kind !== "loop") return;
			if (ctx.jobs === undefined) {
				ctx.notice("warn", LOOP_NO_HOST_NOTICE);
				return "rejected";
			}
			const output = (lines: ReadonlyArray<string>) => ctx.io.stdout(`${lines.join("\n")}\n`);
			const run = () => runLoopCommand(command.command, { jobs: ctx.jobs, notice: ctx.notice, output, now: Date.now });
			// The reply waits for acceptance where the host answers when the work ends (ACP); the
			// terminal queues it behind earlier local operations so `/loop` sees a just-made job.
			if (ctx.holdReplyFor) {
				ctx.holdReplyFor(run());
				return;
			}
			(ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation()))(run);
		},
	},
];
