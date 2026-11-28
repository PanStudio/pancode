// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import {
	combineSafeOutput,
	createRetainedStreamWindow,
	resolveSafeCwd,
	runCommandVector,
	SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
	SAFE_EXEC_DEFAULT_TIMEOUT_MS,
	type SafeCommandResult,
} from "../core/safe-exec.js";
import {
	type HostLaunchLabel,
	hostLaunchPhrase,
	sandboxedLabel,
	uncontainedLabel,
} from "../core/sandbox/host-launch.js";
import { seamLaunchLabel, seamOrHostLaunch, settleHostLaunch } from "../core/sandbox/host-launch-record.js";
import {
	confinedIntegrationPolicy,
	type MainSandboxPolicy,
	mainSandboxWriteHint,
	optInLaunch,
} from "../core/sandbox/main-session.js";
import type { ResourceLimits } from "../core/sandbox/types.js";
import { workerSandboxApplies, workerSandboxConfigured } from "../core/sandbox/worker-process.js";
import { layeredConfineList, layeredMainHomeReads } from "../core/settings-layers.js";
import { ToolNames } from "../core/tool-names.js";
import { gitArgvCommand } from "../domains/safety/git-policy.js";
import { StringEnum } from "../engine/ai.js";
import { effectiveScratchRoots } from "../lib/scratch-roots/scratch-roots.js";
import {
	gitConfigBool,
	gitConfigValue,
	resolveGitHooksDirectory,
	typedArgvIsTaskMutation,
	typedGitEnv,
	typedGitInspectEnv,
	typedGitMutationArgv,
} from "./git-exec.js";
import { checkGitFields, GIT_OPS, gitInspectArgv, isGitInspectOp } from "./git-inspect.js";
import type { ToolInvokeOptions } from "./registry-contract.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./tool-spec.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import { COMMIT_IDENTITY } from "./worktree-commit.js";

const TRUNCATION_MARKER = "\n[output truncated]\n";

export function timeoutArg(args: Record<string, unknown>, fallback = SAFE_EXEC_DEFAULT_TIMEOUT_MS): number {
	return typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : fallback;
}

function cwdArg(args: Record<string, unknown>): string | undefined {
	return typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
}

export function trimOutputHeadTail(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;
	if (maxBytes <= 0) return "";
	const markerAllowance = Buffer.byteLength(`\n[... ${buf.byteLength} bytes omitted ...]\n`, "utf8");
	const bodyBudget = Math.max(0, maxBytes - markerAllowance);
	const headCap = Math.floor(bodyBudget / 3);
	const tailCap = bodyBudget - headCap;
	const window = createRetainedStreamWindow(headCap, tailCap);
	window.append(buf);
	return window.render().text;
}

function formatTimeoutSeconds(timeoutMs: number): string {
	return `${Number((timeoutMs / 1000).toFixed(3))} s`;
}

export function maxOutputArg(args: Record<string, unknown>): number {
	return typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
		? Math.floor(args.max_output_bytes)
		: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * The EXECUTE plane's standardized exec record: what ran, where, how it
 * ended, how long it took, and whether output was capped. Shared by git and
 * verify so ledgers and observers read one shape.
 */
export function safeCommandDetails(result: SafeCommandResult): ToolResultDetails {
	return {
		command: [result.file, ...result.args].join(" "),
		argv: [result.file, ...result.args],
		cwd: result.cwd,
		launched: result.launched === true,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		aborted: result.aborted,
		timedOut: result.timedOut,
		outputCapped: result.outputCapped,
	};
}

export async function runVectorTool(
	action: string,
	file: string,
	vectorArgs: ReadonlyArray<string>,
	args: Record<string, unknown>,
	options?: {
		signal?: AbortSignal;
		env?: Record<string, string>;
		typedGitWritablePaths?: ReadonlyArray<string>;
		/** The main-session sandbox a contained call runs in (verify's checks). */
		shellSandbox?: MainSandboxPolicy;
		/** `safety.resources.main` ceilings for a verify check's command. */
		resourceLimits?: ResourceLimits;
		/** The root `cwd` must stay inside; the process working directory when absent. */
		workspaceRoot?: string;
		/** Where the program runs (P8); its settled launch record rides on `details.sandbox`. */
		launchLabel?: HostLaunchLabel;
		/**
		 * When true, `args.max_output_bytes` only trims the returned text
		 * (head, dropped-byte marker, tail); the child runs under the default
		 * safe-exec output cap so a small cap never kills the check.
		 */
		truncateOutputOnly?: boolean;
	},
): Promise<ToolResult> {
	const timeoutMs = timeoutArg(args);
	const requestedMaxOutputBytes = maxOutputArg(args);
	const truncateOnly = options?.truncateOutputOnly === true;
	const processMaxOutputBytes = truncateOnly ? SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES : requestedMaxOutputBytes;
	try {
		const runOptions: Parameters<typeof runCommandVector>[2] = { timeoutMs, maxOutputBytes: processMaxOutputBytes };
		const cwd = cwdArg(args);
		if (cwd !== undefined) runOptions.cwd = cwd;
		if (options?.signal !== undefined) runOptions.signal = options.signal;
		if (options?.env !== undefined) runOptions.env = options.env;
		if (options?.typedGitWritablePaths !== undefined) runOptions.typedGitWritablePaths = options.typedGitWritablePaths;
		if (options?.shellSandbox !== undefined) runOptions.shellSandbox = options.shellSandbox;
		if (options?.resourceLimits !== undefined) runOptions.resourceLimits = options.resourceLimits;
		if (options?.workspaceRoot !== undefined) runOptions.workspaceRoot = options.workspaceRoot;
		const label = options?.launchLabel;
		if (label !== undefined) runOptions.launchLabel = seamLaunchLabel(label);
		const result = await runCommandVector(file, vectorArgs, runOptions);
		const combined = combineSafeOutput(result);
		const output = truncateOnly
			? trimOutputHeadTail(combined, requestedMaxOutputBytes)
			: truncateUtf8(combined, requestedMaxOutputBytes, TRUNCATION_MARKER);
		const details: ToolResultDetails = {
			...safeCommandDetails(result),
			...(label !== undefined ? { sandbox: seamOrHostLaunch(result.sandbox, label, result) } : {}),
		};
		if (result.aborted) return { kind: "error", message: `${action}: aborted`, details };
		if (result.timedOut) {
			const status =
				action === "verify"
					? `${action}: timed out after ${formatTimeoutSeconds(timeoutMs)}`
					: `${action}: timed out after ${timeoutMs}ms`;
			return {
				kind: "error",
				message: output.trim().length > 0 ? `${status}\n\n${output.trim()}` : status,
				details: { ...details, timeoutMs },
			};
		}
		if (result.outputCapped)
			return {
				kind: "error",
				message:
					output.trim().length > 0
						? `${action}: output exceeded ${processMaxOutputBytes} bytes\n\n${output.trim()}`
						: `${action}: output exceeded ${processMaxOutputBytes} bytes`,
				details,
			};
		if (result.exitCode !== 0) {
			const sandboxHint =
				options?.shellSandbox === undefined ? null : mainSandboxWriteHint(combined, options.shellSandbox);
			const hints = [result.resourceNote ?? null, sandboxHint].filter((hint): hint is string => hint !== null);
			return {
				kind: "error",
				message: `${action}: exited with code ${result.exitCode ?? "?"}: ${output.trim()}${hints.map((hint) => `\n${hint}`).join("")}`,
				details,
			};
		}
		return { kind: "ok", output, details };
	} catch (err) {
		const message = `${action}: ${err instanceof Error ? err.message : String(err)}`;
		if (options?.launchLabel === undefined) return { kind: "error", message };
		const sandbox = settleHostLaunch(options.launchLabel, { outcome: "launch-failed" });
		return { kind: "error", message, details: { sandbox } };
	}
}

/**
 * Where typed git runs (P8). A worker's runs under the worker's sandbox. In
 * the main session it runs in the main-session sandbox, network off, when
 * `safety.confine` names `git` (hooks run inside it too; a signing helper or
 * a network hook then fails), and on the host, as before and labelled so,
 * when it does not. `workspace` is the session's tree.
 */
function typedGitLaunch(
	workspace: string = process.cwd(),
	confine: ReadonlyArray<string> = layeredConfineList(workspace),
): { label: HostLaunchLabel; policy?: MainSandboxPolicy } | { refused: string } {
	if (workerSandboxConfigured()) {
		return {
			label: workerSandboxApplies()
				? sandboxedLabel("typed-git", "worker-policy", "git")
				: uncontainedLabel("typed-git", "unconfined-opt-in", "git"),
		};
	}
	const decided = optInLaunch("typed-git", "git", confine);
	if ("refused" in decided) return decided;
	if (!decided.confined) return { label: decided.label };
	return {
		label: decided.label,
		policy: confinedIntegrationPolicy({
			workspace,
			scratchRoots: effectiveScratchRoots([], workspace),
			stateDirs: [],
			network: "off",
			homeReads: layeredMainHomeReads(workspace),
		}),
	};
}

/**
 * Run a typed add or commit. Admission already judged the exact argv; for a
 * worker admitted by its standing allowance rather than an approval, the
 * task worktree and the hooks rule are checked again right before Git runs,
 * because a parallel call could have moved HEAD in between.
 */
async function runTypedGitMutation(
	argv: string[],
	op: "add" | "commit",
	args: Record<string, unknown>,
	options: ToolInvokeOptions | undefined,
	launch: { label: HostLaunchLabel; policy?: MainSandboxPolicy },
): Promise<ToolResult> {
	const policy = launch.policy;
	let cwd: string;
	try {
		cwd = resolveSafeCwd(cwdArg(args));
	} catch (err) {
		return { kind: "error", message: `git: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!typedArgvIsTaskMutation(argv)) {
		return { kind: "error", message: `git: op ${op} built an argv outside the task set; nothing ran` };
	}
	const context = options?.gitContext;
	if (context !== undefined && (options?.approval === undefined || context.allowance === "worktree")) {
		if (options?.approval === undefined && !context.executePermitted && context.hooksInsideWorkingTree(cwd)) {
			return {
				kind: "error",
				message: `git: op ${op} would run repository hooks from inside the working tree and this permit has no execute capability; nothing ran`,
			};
		}
		const attested = context.taskWorktree?.attest(cwd) ?? {
			ok: false as const,
			detail: "this run owns no task worktree",
		};
		if (!attested.ok) return { kind: "error", message: `git: ${attested.detail}` };
	}
	// Hooks run on typed commits (operator decision Q5). The directory Git
	// resolved is pinned for this one command, so a configuration change after
	// admission cannot swap in another hooks directory.
	const hooks = resolveGitHooksDirectory(cwd);
	if (hooks === null)
		return { kind: "error", message: `git: cannot resolve the hooks directory for ${cwd}; nothing ran` };
	const config: Array<readonly [string, string]> = [["core.hooksPath", hooks.hooks]];
	if (op === "commit") {
		// Signing runs the operator's helper only when the operator's own
		// configuration requires signed commits; otherwise it is off for this
		// command, so no signing program can be selected behind the operator.
		if (gitConfigBool(cwd, "commit.gpgsign") !== true) config.push(["commit.gpgsign", "false"]);
		if (gitConfigValue(cwd, "user.name") === null) config.push(["user.name", COMMIT_IDENTITY]);
		if (gitConfigValue(cwd, "user.email") === null) config.push(["user.email", `${COMMIT_IDENTITY}@local`]);
	}
	const env = typedGitEnv(config, op === "add" ? { GIT_LITERAL_PATHSPECS: "1" } : {});
	return runVectorTool("git", "git", argv, args, {
		...(options?.signal !== undefined ? { signal: options.signal } : {}),
		...(context?.allowance === "worktree" && context.taskWorktree?.typedGitWritablePaths !== undefined
			? { typedGitWritablePaths: context.taskWorktree.typedGitWritablePaths }
			: {}),
		...(policy !== undefined ? { shellSandbox: policy } : {}),
		launchLabel: launch.label,
		env,
	});
}

export const gitTool: ToolSpec = {
	name: ToolNames.Git,
	description:
		'Typed git fields, never a shell or an argv array. args.op status, diff, log, or show inspects; args.rev names a revision or an a..b range (one commit: args={op:"show",rev:"HEAD~1"}; 20 commits: args={op:"log",limit:20}). args.op add stages args.paths (literal paths); args.op commit commits the index with args.message. add and commit need approval unless a worker owns an attested task worktree under git worktree. A field the op does not take is refused, and free-form command strings are not accepted.',
	parameters: Type.Object({
		// `mode` is what code_nav, evidence and monitor call their selector, and a
		// model reaching for it here spent three calls on "last 3 commits".
		op: Type.Optional(
			StringEnum([...GIT_OPS], {
				description:
					"status, diff, log, or show to inspect; add (with paths) or commit (with message) to stage and commit. For 20 commits use op=log and limit=20.",
			}),
		),
		mode: Type.Optional(StringEnum([...GIT_OPS], { description: "Same as op." })),
		action: Type.Optional(StringEnum([...GIT_OPS], { description: "Same as op." })),
		rev: Type.Optional(
			Type.String({
				description:
					"show: one revision (default HEAD); log: that revision or an a..b range; diff: one revision against the worktree, or a..b between two.",
			}),
		),
		path: Type.Optional(Type.String({ description: "Limit status/diff/log/show to one path." })),
		paths: Type.Optional(Type.Array(Type.String(), { description: "add: literal paths to stage." })),
		message: Type.Optional(Type.String({ description: "commit: the commit message." })),
		cached: Type.Optional(Type.Boolean({ description: "diff: staged changes (--cached)." })),
		stat: Type.Optional(
			Type.Boolean({ description: "diff/show: summary only; log: changed files per commit (--stat)." }),
		),
		name_only: Type.Optional(Type.Boolean({ description: "diff/show: file names only." })),
		limit: Type.Optional(Type.Number({ description: "log: commits to show (default 20, max 200)." })),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)." })),
		max_output_bytes: Type.Optional(Type.Number({ description: "Output cap in bytes (default 600000)." })),
	}),
	baseActionClass: "read",
	// add and commit write the index and the task branch; two in one batch must not race.
	executionMode: "sequential",
	/**
	 * add and commit are Git mutations, so the safety net and the Git
	 * classifier judge the exact argv they run, spelled as the bash command a
	 * model would have written. Inspection runs as the read it is.
	 */
	safetyCall(args) {
		const check = checkGitFields(args);
		if (!check.ok) return undefined;
		const built = typedGitMutationArgv(check.op, check.args);
		if (built === null || !built.ok) return undefined;
		const cwd = cwdArg(args);
		return {
			tool: ToolNames.Bash,
			projection: "typed-git",
			args: { command: gitArgvCommand(built.argv), ...(cwd !== undefined ? { cwd } : {}) },
		};
	},
	hostLaunchNote() {
		const launch = typedGitLaunch();
		return "refused" in launch ? `git will not run: ${launch.refused}` : `git ${hostLaunchPhrase(launch.label)}`;
	},
	async run(args, options) {
		const check = checkGitFields(args);
		if (!check.ok) return { kind: "error", message: check.error };
		const launch = typedGitLaunch();
		if ("refused" in launch) return { kind: "error", message: `git: ${launch.refused}; nothing ran` };
		if (isGitInspectOp(check.op)) {
			// Inspection never runs an external diff, a text conversion filter, or a pager.
			const inspect = {
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
				...(launch.policy !== undefined ? { shellSandbox: launch.policy } : {}),
				launchLabel: launch.label,
				env: typedGitInspectEnv(),
			};
			return runVectorTool("git", "git", gitInspectArgv(check.op, check.args), check.args, inspect);
		}
		const built = typedGitMutationArgv(check.op, check.args);
		if (built === null) return { kind: "error", message: `git: op ${check.op} has no argv; nothing ran` };
		if (!built.ok) return { kind: "error", message: built.error };
		return runTypedGitMutation(built.argv, built.op, check.args, options, launch);
	},
};
