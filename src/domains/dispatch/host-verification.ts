// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { PancodeSettings } from "../../core/config.js";
import { sha256Hex } from "../../core/hash.js";
import { withoutRepositoryEnv } from "../../core/internal-git.js";
import { gitExecFileSync } from "../../core/internal-git-run.js";
import { PATH_BOUNDARY_MAX_ENTRIES, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { sandboxEnvPolicy } from "../../core/sandbox/env-scrub.js";
import { buildSandboxInvocation } from "../../core/sandbox/invocation.js";
import { type MainSandboxPolicy, mainSandboxPolicy, mainShellContained } from "../../core/sandbox/main-session.js";
import { withMountAliases } from "../../core/sandbox/mount-aliases.js";
import { discoverSecretMasks } from "../../core/sandbox/secret-files.js";
import type { SandboxMode } from "../../core/sandbox/types.js";
import { unixSocketLaunch } from "../../core/sandbox/unix-sockets.js";
import { physicalSandboxPath, settingsFileMasks, workerSandboxMasks } from "../../core/sandbox/worker-process.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { PLAYBOOK_COMMAND_BASE_ENV } from "../agents/playbook-commands.js";
import { effectiveScratchRoots } from "../safety/scratch-roots.js";
import { CODE_STEP_CAPTURE_MAX_BYTES } from "./code-step.js";
import type { DispatchRequest } from "./contract.js";
import { BASE_PREFLIGHT_EXIT, BASE_PREFLIGHT_SCRIPT, baseModulesLinks } from "./host-verification-base.js";
import { failsTheSameOnBase, hostCheckBaseNote } from "./host-verification-note.js";
import {
	BASE_REPLAY_CACHE_MAX,
	BASE_REPLAY_LINES_MAX,
	type BaseReplay,
	baseReplayCache,
	boundedLine,
	manifestsMatchBase,
	outputLines,
	readBaseReplay,
	resolvedBaseSha,
	storeBaseReplay,
	taskCheckOutput,
	taskRoots,
} from "./host-verification-replay.js";
import { checkDedupeKey, outputTail, runResolvedCheck } from "./host-verification-runner.js";
import {
	lintFormatScopeArgv,
	lintScriptFollowUpChecks,
	type ResolvedCheck,
	taskChecks,
} from "./host-verification-scope.js";
import type { RunHostVerification, RunHostVerificationAttribution, RunHostVerificationCheck } from "./types.js";
import { type VerificationSlotEvents, withVerificationSlot } from "./verification-slot.js";

const HTTP_URL_RE = /\bhttps?:\/\/\S+/gu;

/**
 * Path-like tokens a failing check named. A separator and a source or document
 * extension are both required, which is the grammar `path-scope.ts:302` already
 * uses to decide which prose tokens read as repository paths; without the
 * extension list `10/20 passing` and `v1.2.3` become implicated files. Probed
 * against node:test, tsc, and stack-trace output: relative, absolute, and
 * `./`-prefixed forms all match and stop at a trailing `:line:col`.
 */
const CHECK_OUTPUT_PATH_RE =
	/\/?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]*\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|py|go|rs|c|h|cc|cpp|hpp|java|rb|sh|toml|css|html|sql)\b/gu;

/** Implicated paths recorded on a receipt, matching the intent path-list cap. */
const IMPLICATED_PATH_CAP = PATH_BOUNDARY_MAX_ENTRIES;

/**
 * Compare each failing whole-repo check against the task's base commit.
 *
 * The check runs once on an isolated archive of the base, cached per base sha
 * (see {@link BaseReplay}), under the check's own declared timeout however long
 * it took on the task. A failing check fails the same way on the base when the
 * base run fails too and the task's output, compared line by line through
 * {@link outputLines}, adds nothing the base's lacks. When every failing check
 * fails the same way on the base, the failures predate the task: the
 * verification is sealed `not_implicated` with reason `failures_present_on_base`
 * and the run is not rejected. A lint or format check scoped to the task's
 * changed files (see {@link scopeCheckToTask}) judges only the task's own files
 * and is never excused by the base.
 */
export async function compareHostVerificationBase(input: {
	verification: RunHostVerification | undefined;
	request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree" | "candidateWorktree">;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Reports the wait for the verification slot each base replay takes; see {@link withVerificationSlot}. */
	slot?: VerificationSlotEvents;
	/** Stops the base replay: a check not yet replayed stays not_compared, and the one in flight is killed. */
	signal?: AbortSignal;
}): Promise<void> {
	const failures = input.verification?.checks.filter((check) => check.exitCode !== 0) ?? [];
	if (failures.length === 0) return;
	// A compete candidate's checkout is isolated from the base it was cut from, as a task worktree is.
	const worktree = input.request.taskWorktree ?? input.request.candidateWorktree;
	for (const check of failures)
		check.baseComparison = { status: "not_compared", reason: "no isolated task base available" };
	if (worktree === undefined) return;
	const candidates = failures.flatMap((check) => {
		const declared = (input.request.resolvedVerification ?? [])
			.flatMap((entry) => [entry, ...lintScriptFollowUpChecks(entry)])
			.find((entry) => entry.check === check.check);
		const reason =
			declared === undefined
				? "declared check unavailable"
				: declared.kind !== undefined && declared.kind !== "command"
					? "judged check cannot be replayed as a command"
					: lintFormatScopeArgv(declared) !== null &&
							(check.argv.length !== declared.argv.length || check.argv.some((arg, index) => arg !== declared.argv[index]))
						? "check was scoped to the task's changed files"
						: declared.argv.some((arg) => arg.includes(worktree.path))
							? "command refers to the worker checkout"
							: null;
		check.baseComparison = { status: "not_compared", base: worktree.base, ...(reason ? { reason } : {}) };
		return reason === null && declared !== undefined ? [{ check, declared }] : [];
	});
	if (candidates.length === 0) return;
	// The seatbelt backend permits shared temporary writes; only bubblewrap
	// contains an arbitrary comparison command to this checkout (flywheel p9/C1).
	const sandbox = sandboxAvailability();
	if (!sandbox.available || sandbox.backend !== "bwrap" || sandbox.executable === null) {
		for (const { check } of candidates)
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "isolated base comparison sandbox unavailable",
			};
		return;
	}
	const backend = sandbox.backend;
	const executable = sandbox.executable;
	// The archived base has no installed dependencies. When the manifests match,
	// the base borrows the task's dependency view: the nearest node_modules from
	// the check cwd upward (a nested task worktree's is its enclosing checkout's)
	// and each workspace package's own, linked inside the private tmpfs.
	const linksByCwd = new Map(
		candidates.map(({ declared }) => [declared.cwd, baseModulesLinks(worktree.path, declared.cwd)] as const),
	);
	const linkModules = [...linksByCwd.values()].some((links) => links.length > 0);
	if (linkModules && !(await manifestsMatchBase(worktree.path, worktree.base))) {
		for (const { check } of candidates)
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "base dependencies were not provisioned: package.json or the lockfile differs from the base",
			};
		return;
	}
	for (const { check, declared } of candidates) {
		if (input.signal?.aborted) break;
		const relativeCwd = relative(worktree.path, declared.cwd);
		if (
			relativeCwd === ".." ||
			relativeCwd.startsWith("../") ||
			resolve(worktree.path, relativeCwd) !== resolve(declared.cwd)
		) {
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "check cwd is outside the task worktree",
			};
			continue;
		}
		const env = Object.fromEntries(
			PLAYBOOK_COMMAND_BASE_ENV.flatMap((name) => {
				const value = (input.env ?? process.env)[name];
				return value === undefined ? [] : [[name, value]];
			}),
		);
		const baseSha = resolvedBaseSha(worktree.path, worktree.base);
		const links = linksByCwd.get(declared.cwd) ?? [];
		const cacheKey =
			baseSha === null
				? null
				: sha256Hex(
						JSON.stringify({
							baseSha,
							argv: declared.argv,
							relativeCwd,
							links,
							timeout: declared.timeoutMs,
							env,
						}),
					);
		const replay = async (): Promise<BaseReplay> => {
			// The archive lives only in bubblewrap's private tmpfs. Even SIGKILL
			// cannot leave a checkout or shared Git registration behind (flywheel p9/C1).
			const basePath = `/tmp/verification-base-${randomUUID()}`;
			const script = [
				'base_dir="$1"; source_dir="$2"; base_ref="$3"; relative_cwd="$4"; node_bin="$5"; preflight="$6"; link_count="$7"; shift 7',
				'mkdir -p "$base_dir" || exit 125',
				'git -C "$source_dir" archive "$base_ref" | tar -x -C "$base_dir" || exit 125',
				'while [ "$link_count" -gt 0 ]; do',
				'  link_path="$base_dir/$2"; mkdir -p "$(dirname "$link_path")" || exit 125',
				'  rm -rf "$link_path"; ln -s "$1" "$link_path" || exit 125',
				"  shift 2; link_count=$((link_count - 1))",
				"done",
				'cd "$base_dir/$relative_cwd" || exit 125',
				'case "$(pwd -P)/" in "$base_dir/"*) ;; *) exit 125 ;; esac',
				'export TMPDIR="$base_dir" TMP="$base_dir" TEMP="$base_dir"',
				'"$node_bin" -e "$preflight" "$base_dir" "$1" || exit $?',
				'exec "$@"',
			].join("\n");
			// The base check runs repository code, so it gets a worker command's
			// credential, settings, escape-socket and workspace secret masks too,
			// over the worktree and the source checkout it was cut from.
			const baseMasks = [...workerSandboxMasks(), ...settingsFileMasks()];
			const secretMasks = discoverSecretMasks(
				{ workspaceRoots: [worktree.path, worktree.root, ...links.map((link) => dirname(link.target))] },
				baseMasks,
			).masks;
			const sockets = unixSocketLaunch("block", sandbox, { workspaceRoots: [worktree.path], privateTmp: true }, [
				...baseMasks,
				...secretMasks,
			]);
			const masks = withMountAliases([...baseMasks, ...secretMasks, ...sockets.masks], undefined, [
				physicalSandboxPath(worktree.path),
				physicalSandboxPath(worktree.root),
				...links.map((link) => physicalSandboxPath(dirname(link.target))),
			]);
			// A sandbox that cannot see the mount aliases would leave secrets readable.
			if (masks instanceof Error) return { exitCode: null, incomplete: true, lines: [] };
			const invocation = buildSandboxInvocation(
				{
					command: {
						argv: [
							"/bin/bash",
							"-o",
							"pipefail",
							"-c",
							script,
							"base-check",
							basePath,
							worktree.path,
							worktree.base,
							relativeCwd,
							process.execPath,
							BASE_PREFLIGHT_SCRIPT,
							String(links.length),
							...links.flatMap((link) => [link.target, link.relativePath]),
							...declared.argv,
						],
					},
					cwd: worktree.path,
					writableRoots: [],
					network: false,
					maskedPaths: masks,
					...sockets.fields,
				},
				backend,
				executable,
			);
			const outcome = await runCommandVector(invocation.file, invocation.args, {
				cwd: worktree.path,
				workspaceRoot: worktree.path,
				env,
				timeoutMs: declared.timeoutMs,
				killGraceMs: 0,
				maxOutputBytes: CODE_STEP_CAPTURE_MAX_BYTES,
				...(input.signal !== undefined ? { signal: input.signal } : {}),
			});
			// The preflight, not the check's exit code, decides whether the check could start on the base.
			const startFailed =
				outcome.exitCode === BASE_PREFLIGHT_EXIT && /^base preflight: .* does not resolve$/mu.test(outcome.stderr);
			return {
				exitCode: outcome.exitCode,
				...(startFailed ? { startFailed } : {}),
				incomplete:
					startFailed ||
					outcome.timedOut ||
					outcome.signal !== null ||
					outcome.outputCapped ||
					outcome.failure !== null ||
					outcome.exitCode === null ||
					outcome.exitCode === 125,
				lines: outputLines(`${outcome.stdout}\n${outcome.stderr}`, [basePath]).slice(0, BASE_REPLAY_LINES_MAX),
			};
		};
		const stateDir = input.stateDir ?? pancodeStateDir();
		const slotted = (): Promise<BaseReplay> =>
			withVerificationSlot(`base replay of ${declared.check}`, replay, input.slot);
		const cachedReplay = async (key: string): Promise<BaseReplay> => {
			const stored = readBaseReplay(stateDir, key);
			if (stored !== undefined) return stored;
			// Another process may have replayed this base while this one waited for the slot.
			const result = await withVerificationSlot(
				`base replay of ${declared.check}`,
				async () => readBaseReplay(stateDir, key) ?? (await replay()),
				input.slot,
			);
			if (!result.incomplete) {
				try {
					storeBaseReplay(stateDir, key, result);
				} catch {
					// The cache saves a rerun; failing to write it changes no verdict.
				}
			}
			return result;
		};
		try {
			let pending = cacheKey === null ? undefined : baseReplayCache.get(cacheKey);
			if (pending === undefined) {
				pending = cacheKey === null ? slotted() : cachedReplay(cacheKey);
				if (cacheKey !== null) {
					baseReplayCache.set(cacheKey, pending);
					while (baseReplayCache.size > BASE_REPLAY_CACHE_MAX) {
						const oldest = baseReplayCache.keys().next().value;
						if (oldest === undefined) break;
						baseReplayCache.delete(oldest);
					}
					// Only a completed replay is a fact about the base; a timeout or setup failure is retried next time.
					pending.then(
						(result) => {
							if (result.incomplete) baseReplayCache.delete(cacheKey);
						},
						() => baseReplayCache.delete(cacheKey),
					);
				}
			}
			const { exitCode, incomplete, startFailed, lines } = await pending;
			if (startFailed === true) {
				check.baseComparison = {
					status: "not_compared",
					base: worktree.base,
					reason: "the check could not start on the base",
				};
				continue;
			}
			// A failure the base has too excuses the task only when the task's output
			// adds nothing to the base's: a new error in an already red check rejects.
			const known = new Set(lines);
			const added =
				incomplete || exitCode === 0
					? []
					: outputLines(taskCheckOutput(check), taskRoots(worktree.path)).filter((line) => !known.has(line));
			check.baseComparison = {
				status: incomplete ? "not_compared" : exitCode === 0 ? "passed" : "failed",
				base: worktree.base,
				...(exitCode !== null ? { exitCode } : {}),
				...(incomplete
					? { reason: "base check could not complete in the isolated comparison" }
					: added.length > 0
						? {
								reason: `the task's output has ${added.length} line${added.length === 1 ? "" : "s"} the base's does not, first: ${JSON.stringify(boundedLine(added[0] ?? ""))}`,
							}
						: {}),
			};
		} catch {
			// Comparison is explanatory evidence; setup failure retains the host rejection.
			check.baseComparison = {
				status: "not_compared",
				base: worktree.base,
				reason: "isolated base comparison could not run",
			};
		}
	}
	const verification = input.verification;
	// A candidate's check that never started judged nothing, so it cannot keep its run rejected either (M10a).
	const judged =
		input.request.candidateWorktree === undefined ? failures : failures.filter((check) => check.notRun === undefined);
	if (verification?.status === "rejected" && judged.every(failsTheSameOnBase)) {
		// Every failure is already present on the base: the task did not cause it.
		verification.status = "not_implicated";
		verification.reason = "failures_present_on_base";
	}
}

export function hostVerificationRejection(
	verification: RunHostVerification | undefined,
): { outcomeCode: "host_verification_rejected"; detail: string } | null {
	if (verification?.status !== "rejected") return null;
	// Name a failure the run is rejected for, not one its base already has.
	const failedCheck =
		verification.checks.find((check) => check.exitCode !== 0 && !failsTheSameOnBase(check)) ??
		verification.checks.find((check) => check.exitCode !== 0);
	return {
		outcomeCode: "host_verification_rejected",
		detail:
			(verification.reason !== undefined
				? `host verification rejected: ${verification.reason}`
				: failedCheck === undefined
					? "host verification rejected"
					: failedCheck.report !== undefined
						? `host verification check '${failedCheck.check}' rejected: ${failedCheck.report.summary}`
						: `host verification check '${failedCheck.check}' rejected with exit code ${failedCheck.exitCode}`) +
			(failedCheck === undefined
				? "; the base was not compared"
				: `; ${hostCheckBaseNote(failedCheck)}. The host ran this check; rejection is not evidence that the worker skipped validation.`),
	};
}

/**
 * The sandbox host verification runs a run's declared checks in. A worker
 * may have written the test files and helpers a check executes, so the host
 * runs them where the main session's own bash would: the main-session
 * sandbox rooted at the run's workspace. A task worktree's checks also get
 * the secret masks of the checkout it was cut from, whose untracked secret
 * files the worktree's own scan never sees. `off` runs them bare, as does `auto`
 * on a host with no backend, where the worker itself ran unsandboxed; under
 * `required` a missing backend refuses each check rather than running it bare.
 */
export function hostVerificationSandbox(
	settings: Readonly<Pick<PancodeSettings, "safety" | "targets">> | undefined,
	workspace: string | Pick<NonNullable<DispatchRequest["taskWorktree"]>, "path" | "root">,
	availability = sandboxAvailability(),
): MainSandboxPolicy | undefined {
	const mode: SandboxMode = settings?.safety.sandbox ?? "auto";
	if (mode === "off" || (mode === "auto" && !mainShellContained(mode, availability))) return undefined;
	const root = typeof workspace === "string" ? workspace : workspace.path;
	const source = typeof workspace === "string" || workspace.root === workspace.path ? undefined : workspace.root;
	return mainSandboxPolicy({
		workspace: root,
		scratchRoots: effectiveScratchRoots(settings?.safety.scratchRoots ?? [], root),
		...(source !== undefined ? { sourceCheckout: source } : {}),
		...(settings !== undefined
			? { env: sandboxEnvPolicy(settings), unixSockets: settings.safety.sandboxUnixSockets }
			: {}),
	});
}

/** What sits at a path, as the mode of its tree entry at a commit names it. */
function treeEntryKind(mode: string): string {
	if (mode === "040000" || mode === "160000") return "directory";
	return mode === "120000" ? "symbolic link" : "file";
}

/**
 * A path a compete candidate's check needs that the candidate broke: the check's cwd, or a numeric-compare input,
 * tracked in the commit the worktree started from but missing from the worktree or replaced by another type (a file
 * by a directory, a directory by a file or link), so the check cannot start or provenance refuses it (M10a). The
 * reason names the path; undefined when nothing is broken, or when that commit never had the path (an untracked or
 * ignored file the worktree never received), which is not the candidate's doing.
 */
function candidateBrokenPath(
	candidate: NonNullable<DispatchRequest["candidateWorktree"]>,
	check: ResolvedCheck,
): string | undefined {
	const inputs = check.kind === "numeric-compare" ? (check.numeric?.inputs ?? []) : [];
	for (const path of [check.cwd, ...inputs]) {
		const rel = relative(candidate.path, path);
		if (rel === "" || relativePathEscapes(rel)) continue;
		let entry: string;
		try {
			const args = ["-C", candidate.root, "ls-tree", "-z", "--full-tree", candidate.base, "--", rel.split(sep).join("/")];
			entry = gitExecFileSync(args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
				env: { ...withoutRepositoryEnv(), GIT_LITERAL_PATHSPECS: "1" },
			});
		} catch {
			continue;
		}
		const mode = entry.slice(0, entry.indexOf(" "));
		if (mode === "") continue;
		const was = treeEntryKind(mode);
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined)
			return `'${path}' is missing from the candidate's worktree but exists in the commit it started from`;
		const now = stat.isSymbolicLink()
			? "symbolic link"
			: stat.isDirectory()
				? "directory"
				: stat.isFile()
					? "file"
					: "special file";
		if (now !== was)
			return `'${path}' is a ${now} in the candidate's worktree but a ${was} in the commit it started from`;
	}
	return undefined;
}

export async function runHostVerification(input: {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree" | "candidateWorktree">;
	workerSuccessful: boolean;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	/** The sandbox every check runs in; see {@link hostVerificationSandbox}. Absent runs them bare. */
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	/** Reports each check waiting for and taking the verification slot; see {@link withVerificationSlot}. */
	slot?: VerificationSlotEvents;
}): Promise<RunHostVerification | undefined> {
	const checks = input.request.resolvedVerification;
	if (checks === undefined || checks.length === 0) return undefined;
	if (!input.workerSuccessful) return { status: "skipped", reason: "worker_not_successful", checks: [] };
	const stateDir = input.stateDir ?? pancodeStateDir();
	const env = input.env ?? process.env;
	const results: RunHostVerificationCheck[] = [];
	const brokenPaths: string[] = [];
	for (const [index, resolvedCheck] of taskChecks(input.request).entries()) {
		const broken =
			input.request.candidateWorktree === undefined
				? undefined
				: candidateBrokenPath(input.request.candidateWorktree, resolvedCheck);
		if (broken !== undefined) {
			// The candidate broke what its check needs: a verdict on the candidate, not a host failure (M10a).
			const reason = `check '${resolvedCheck.check}' cannot start: ${broken}`;
			results.push({
				check: resolvedCheck.check,
				argv: [...resolvedCheck.argv],
				cwd: resolvedCheck.cwd,
				exitCode: 1,
				durationMs: 0,
				memo: false,
				outputTail: outputTail(`${reason}; nothing ran`),
			});
			brokenPaths.push(reason);
			continue;
		}
		const outcome = await runResolvedCheck({
			runId: input.runId,
			index,
			resolvedCheck,
			stateDir,
			env,
			...(input.shellSandbox !== undefined ? { shellSandbox: input.shellSandbox } : {}),
			...(input.onDiagnostic !== undefined ? { onDiagnostic: input.onDiagnostic } : {}),
			...(input.slot !== undefined ? { slot: input.slot } : {}),
		});
		results.push(outcome.check);
	}
	if (input.request.candidateWorktree !== undefined) {
		if (brokenPaths.length > 0) return { status: "rejected", reason: brokenPaths.join("; "), checks: results };
		// A compete candidate's check that never started for a host cause (spawn failure, refusal, no configuration,
		// shutdown) judged nothing: it is not run, never a rejection (M10a).
		const judged = results.filter(
			(check) => check.notRun === undefined || check.notRun === "nothing-changed" || check.notRun === "no-tests",
		);
		if (judged.length < results.length && judged.every((check) => check.exitCode === 0)) {
			return { status: "skipped", reason: "check_not_started", checks: results };
		}
	}
	if (judgedNothingForNoTests(results)) return { status: "skipped", reason: NO_TESTS_COLLECTED_REASON, checks: results };
	return {
		status: results.every((check) => check.exitCode === 0) ? "verified" : "rejected",
		checks: results,
	};
}

const NO_TESTS_COLLECTED_REASON = "no_tests_collected";

/**
 * No check ran a test, and one ran but collected none. Such a run is not `verified`: that status lets the merge gate
 * land the worktree and the board print a pass, while nothing was judged (CLI-P51).
 */
function judgedNothingForNoTests(checks: ReadonlyArray<RunHostVerificationCheck>): boolean {
	return (
		checks.some((check) => check.notRun === "no-tests") &&
		checks.every((check) => check.notRun !== undefined && check.exitCode === 0)
	);
}

function implicatedPaths(outputExcerpt: string, checkCwd: string): string[] {
	const withoutUrls = outputExcerpt.replace(HTTP_URL_RE, (url) => " ".repeat(url.length));
	const paths = new Set<string>();
	for (const match of withoutUrls.matchAll(CHECK_OUTPUT_PATH_RE)) paths.add(resolve(checkCwd, match[0]));
	return [...paths].sort();
}

export interface BatchVerificationParticipant {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification" | "intent" | "cwd" | "taskWorktree">;
	workerSuccessful: boolean;
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	/** Reports this run's checks waiting for and taking the verification slot. */
	slot?: VerificationSlotEvents;
}

export interface BatchVerificationGate {
	/** This run holds a capacity lease and its worker is spawned, so it may be writing. */
	live(runId: string): void;
	/** Park until every live member has arrived or left, then return this run's verdict. */
	arrive(input: BatchVerificationParticipant): Promise<RunHostVerification | undefined>;
	/** Release a member that will never arrive. Idempotent, and a no-op for one already parked. */
	abandon(runId: string): void;
}

interface ParkedMember {
	participant: BatchVerificationParticipant;
	settle: (value: RunHostVerification | undefined) => void;
	/**
	 * Reject the parked promise so the member's finalization takes the identical
	 * path a single-task dispatch takes when its declared check cannot run at all
	 * (`extension.ts:5544` throws into the finalization catch at 5669 and the run
	 * is marked failed). Silently dropping a declared check must never look like
	 * never having declared one.
	 */
	fail: (error: unknown) => void;
}

/**
 * The member's declared write roots resolved in the frame its own request ran in.
 *
 * An empty result means UNCONFINED, never "writes nothing": `intent.ts:139`
 * normalizes a `"."` scope entry to an empty list, a request may omit
 * `write_roots` entirely, and `extension.ts:1949` only builds a write boundary
 * for a non-empty list, so such a run executed with no write confinement at all.
 */
function memberBoundary(participant: BatchVerificationParticipant): string[] {
	const writeRoots = participant.request.intent?.writeRoots ?? [];
	return writeRoots.map((root) => resolvePathBoundary(participant.request.cwd ?? process.cwd(), root));
}

/**
 * Charge one failing batch check to the members that own it.
 *
 * The charge follows write-root coverage across the whole wave, not just across
 * the members that declared the check: a live sibling that declared no check, or
 * whose own worker failed, still edited the shared checkout, so a named path
 * inside its boundary and inside no declarer's is positive evidence that the
 * declarers are innocent. That exculpation demands every named path be owned
 * elsewhere; one path nobody claims leaves the failure unowned and every
 * declarer is charged. When the owner is a member that declared no check the
 * charge set comes out empty, because a run has nothing to reject on for a check
 * it never asked for; that is the attribution rule applied faithfully, and the
 * alternative is rejecting a worker the evidence points away from, which is the
 * defect this gate exists to remove.
 *
 * Exculpation always requires positive evidence, so a declarer that ran
 * unconfined is charged unconditionally: with no boundary there is nothing to
 * test the failing paths against, and it is the member most able to have broken
 * the tree. `basis` is the weakest evidence behind the charge set, never the
 * strongest, so `write_roots` on a receipt means every charged run has a named
 * path inside its own declared boundary.
 *
 * A `worktree: true` member's checks run inside its own task worktree (F6),
 * so their batch identity differs from every sibling's and a failure there is
 * judged against that member's own checkout and write roots.
 */
function attributeFailure(input: {
	implicated: ReadonlyArray<string>;
	declarers: ReadonlyArray<BatchVerificationParticipant>;
	wave: ReadonlyArray<BatchVerificationParticipant>;
}): { charged: Set<string>; basis: RunHostVerificationAttribution["basis"]; decisive: string[] } {
	const declared = new Set(input.declarers.map((member) => member.runId));
	const implicatedDeclarers = new Set<string>();
	const unconfined = new Set<string>();
	const decisive = new Set<string>();
	for (const member of input.declarers) {
		const boundary = memberBoundary(member);
		if (boundary.length === 0) {
			unconfined.add(member.runId);
			continue;
		}
		const hits = input.implicated.filter((path) => writeRootsCover(boundary, path));
		if (hits.length === 0) continue;
		implicatedDeclarers.add(member.runId);
		for (const hit of hits) decisive.add(hit);
	}
	const others = input.wave.filter((member) => !declared.has(member.runId));
	const ownedElsewhere =
		input.implicated.length > 0 &&
		input.implicated.every((path) => others.some((member) => writeRootsCover(memberBoundary(member), path)));
	const localized = implicatedDeclarers.size > 0 || ownedElsewhere;
	const charged = localized ? new Set(implicatedDeclarers) : new Set(declared);
	for (const runId of unconfined) charged.add(runId);
	return {
		charged,
		basis:
			!localized || unconfined.size > 0
				? "unattributable"
				: implicatedDeclarers.size > 0
					? "write_roots"
					: "attributed_elsewhere",
		decisive: [...decisive].sort(),
	};
}

/**
 * One settlement barrier per wave of a parallel dispatch batch.
 *
 * A check run while a sibling is still editing the shared checkout judges a tree
 * neither worker authored: three coders on one kvlog batch (round 5, 2026-09-02)
 * all sealed `host_verification_rejected` for one worker's broken test. Every
 * live member parks at the verification step, each distinct resolved check runs
 * once for the whole wave on the settled tree, and a failure is charged by
 * write-root coverage across the wave.
 *
 * Membership is what is LIVE, never what was requested. A run still queued for
 * capacity holds no lease and cannot write, and waiting on it would deadlock
 * every batch larger than `fleet.concurrency`: parked members keep their lease
 * until dispatch finalization ends, so the queued member's `admit` would never be
 * granted and the batch would hang. Live-only membership still costs a queued
 * member the difference between the first live member finishing and the last.
 * Admission waits are advisory (c7670370e), so that wait has no deadline of its
 * own. Only a caller deadline, such as the dispatch call's `timeout_ms`, can
 * expire the queued member's `admit`, and `dispatchBatch` aborts every already
 * dispatched run when one member's admission throws. Releasing the lease before parking would let a fresh writer into the checkout
 * the settlement is about to judge, which is the defect itself, so the wait
 * stands until the lease lifecycle is restructured.
 *
 * The gate is multi-shot: a batch larger than the effective capacity admits in
 * waves, and each wave forms its own barrier from the members live at that
 * moment. Latching after the first settlement would drop every later member onto
 * the per-run path and reproduce the original defect verbatim, since those
 * members are admitted together and would run the shared check concurrently on
 * the checkout their siblings are still editing.
 *
 * One narrow window survives, and it is the reason `live()` registers as early
 * as the worker spawn: a member that goes live WHILE a wave's checks are
 * executing joins the next wave, so its edits can land in the tree the running
 * check is judging. Reaching it takes either a lease freed mid-settlement, which
 * means a sibling whose finalization failed before the barrier, or a member of
 * `dispatchBatch`'s sequential loop (`extension.ts:6194`) whose worker had not
 * spawned yet when every earlier member had already finished. The next wave
 * re-runs the check on the settled tree, so a stale verdict is bounded to the
 * one wave that raced.
 */
export function createBatchVerificationGate(
	options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): BatchVerificationGate {
	const stateDir = options.stateDir ?? pancodeStateDir();
	const env = options.env ?? process.env;
	const liveMembers = new Set<string>();
	const parked = new Map<string, ParkedMember>();
	let settling = false;

	const perRun = (participant: BatchVerificationParticipant): Promise<RunHostVerification | undefined> =>
		runHostVerification({
			runId: participant.runId,
			request: participant.request,
			workerSuccessful: participant.workerSuccessful,
			stateDir,
			env,
			...(participant.shellSandbox !== undefined ? { shellSandbox: participant.shellSandbox } : {}),
			...(participant.onDiagnostic !== undefined ? { onDiagnostic: participant.onDiagnostic } : {}),
			...(participant.slot !== undefined ? { slot: participant.slot } : {}),
		});

	/** Today's value for a member that contributes no check; runs no command. */
	const nothingToRun = (participant: BatchVerificationParticipant): RunHostVerification | undefined => {
		const checks = participant.request.resolvedVerification;
		if (checks === undefined || checks.length === 0) return undefined;
		return { status: "skipped", reason: "worker_not_successful", checks: [] };
	};

	async function settleBatch(wave: ReadonlyArray<ParkedMember>): Promise<void> {
		const members = wave.map((entry) => entry.participant);
		const contributors = members.filter(
			(member) => member.workerSuccessful && (member.request.resolvedVerification?.length ?? 0) > 0,
		);
		const memberChecks = new Map(contributors.map((member) => [member, taskChecks(member.request)]));
		const distinct = new Map<
			string,
			{ resolvedCheck: ResolvedCheck; owner: BatchVerificationParticipant; index: number }
		>();
		const checkKeys = new Map<ResolvedCheck, string>();
		for (const member of contributors) {
			for (const resolvedCheck of memberChecks.get(member) ?? []) {
				const key = checkDedupeKey(resolvedCheck);
				checkKeys.set(resolvedCheck, key);
				if (!distinct.has(key)) distinct.set(key, { resolvedCheck, owner: member, index: distinct.size });
			}
		}
		const ran = new Map<string, { check: RunHostVerificationCheck; owner: string; outputExcerpt: string }>();
		// Every member of the wave is parked on these checks, so each card says when they wait for the slot.
		const waveSlot: VerificationSlotEvents = {
			onWaiting: () => {
				for (const member of members) member.slot?.onWaiting?.();
			},
			onTaken: () => {
				for (const member of members) member.slot?.onTaken?.();
			},
		};
		for (const [key, entry] of distinct) {
			const outcome = await runResolvedCheck({
				runId: entry.owner.runId,
				index: entry.index,
				resolvedCheck: entry.resolvedCheck,
				stateDir,
				env,
				...(entry.owner.shellSandbox !== undefined ? { shellSandbox: entry.owner.shellSandbox } : {}),
				// The owning member's callback, because the artifact directory is
				// named for that same run and the diagnostic text is closed over the
				// run id it was built for (`extension.ts:5534`); any other member's
				// callback would name a run whose artifacts the failure is not under.
				...(entry.owner.onDiagnostic !== undefined ? { onDiagnostic: entry.owner.onDiagnostic } : {}),
				slot: { ...waveSlot, onUnavailable: (error) => entry.owner.slot?.onUnavailable?.(error) },
			});
			ran.set(key, { check: outcome.check, owner: entry.owner.runId, outputExcerpt: outcome.outputExcerpt });
		}
		const attribution: RunHostVerificationAttribution[] = [];
		const chargedByKey = new Map<string, Set<string>>();
		for (const [key, entry] of ran) {
			if (entry.check.exitCode === 0) continue;
			const declarers = contributors.filter((member) =>
				(memberChecks.get(member) ?? []).some((candidate) => checkKeys.get(candidate) === key),
			);
			const implicated = implicatedPaths(entry.outputExcerpt, entry.check.cwd);
			const verdict = attributeFailure({ implicated, declarers, wave: members });
			chargedByKey.set(key, verdict.charged);
			const decisive = new Set(verdict.decisive);
			attribution.push({
				check: entry.check.check,
				// The paths that decided the charge lead the capped list. A large
				// suite names more than 32 files and the sealed evidence has to
				// contain the path a receipt was charged on, or it documents nothing.
				implicated: [...verdict.decisive, ...implicated.filter((path) => !decisive.has(path))].slice(
					0,
					IMPLICATED_PATH_CAP,
				),
				charged: [...verdict.charged].sort(),
				basis: verdict.basis,
			});
		}
		attribution.sort((first, second) => (first.check < second.check ? -1 : first.check > second.check ? 1 : 0));
		for (const entry of wave) {
			const member = entry.participant;
			if (!contributors.includes(member)) {
				entry.settle(nothingToRun(member));
				continue;
			}
			const own: RunHostVerificationCheck[] = [];
			let rejected = false;
			let unimplicated = false;
			for (const resolvedCheck of memberChecks.get(member) ?? []) {
				const key = checkKeys.get(resolvedCheck);
				if (key === undefined) throw new Error("host verification: declared check has no batch identity");
				const shared = ran.get(key);
				if (shared === undefined) continue;
				own.push(
					shared.owner === member.runId || shared.check.evidenceRunId !== undefined
						? { ...shared.check, argv: [...shared.check.argv] }
						: { ...shared.check, argv: [...shared.check.argv], evidenceRunId: shared.owner },
				);
				if (shared.check.exitCode === 0) continue;
				if (chargedByKey.get(key)?.has(member.runId) === true) rejected = true;
				else unimplicated = true;
			}
			entry.settle({
				// `verified` states that every declared check passed, which is what
				// `trust-status.ts:619` certifies and what the board and
				// `worker-evidence.ts:161` print. An exculpated member's checks array
				// still carries a non-zero exit code, so it seals its own status
				// instead of borrowing that claim.
				status: rejected
					? "rejected"
					: unimplicated
						? "not_implicated"
						: judgedNothingForNoTests(own)
							? "skipped"
							: "verified",
				...(!rejected && unimplicated ? { reason: "batch_settled_not_implicated" } : {}),
				...(!rejected && !unimplicated && judgedNothingForNoTests(own) ? { reason: NO_TESTS_COLLECTED_REASON } : {}),
				checks: own,
				strategy: "batch-settled",
				// Copied per receipt so no two members of the batch share a mutable array.
				...(attribution.length > 0
					? {
							attribution: attribution.map((record) => ({
								...record,
								implicated: [...record.implicated],
								charged: [...record.charged],
							})),
						}
					: {}),
			});
		}
	}

	function maybeSettle(): void {
		if (settling || parked.size === 0) return;
		for (const runId of liveMembers) {
			if (!parked.has(runId)) return;
		}
		settling = true;
		// The wave closes here. Its members leave `liveMembers` so a member that
		// arrives during the settlement forms the next barrier instead of joining
		// one whose checks are already executing.
		const wave = [...parked.values()];
		for (const runId of parked.keys()) liveMembers.delete(runId);
		parked.clear();
		void settleBatch(wave)
			.catch(async (error) => {
				// The barrier must never be the reason a receipt cannot seal, so a
				// member whose own checks still run gets today's per-run result. A
				// member whose per-run attempt throws the same way takes the throw:
				// swallowing it would seal a run that declared a check it never
				// executed as `host_verification=not_requested` and succeeded, while
				// the identical single-task dispatch fails the run.
				for (const entry of wave) {
					entry.participant.onDiagnostic?.(error);
					try {
						entry.settle(await perRun(entry.participant));
					} catch (fallbackError) {
						entry.fail(fallbackError);
					}
				}
			})
			.finally(() => {
				settling = false;
				maybeSettle();
			});
	}

	return {
		live(runId) {
			liveMembers.add(runId);
		},
		abandon(runId) {
			// Dropping the id out of `liveMembers` rather than remembering it in a
			// second set keeps the membership of a later wave exact: the same run
			// abandons again when its finalPromise settles, long after its own wave.
			if (parked.has(runId) || !liveMembers.delete(runId)) return;
			maybeSettle();
		},
		arrive(input) {
			liveMembers.add(input.runId);
			// The executor runs synchronously, so the member is registered before
			// arrive() yields and two concurrent arrivals cannot miss each other.
			const parkedPromise = new Promise<RunHostVerification | undefined>((settle, fail) => {
				parked.set(input.runId, { participant: input, settle, fail });
			});
			maybeSettle();
			return parkedPromise;
		},
	};
}
