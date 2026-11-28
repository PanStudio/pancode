// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The host services a command or action reaches for work that outlives one call: headless PanCode runs, git
 * worktrees the host owns, the project's declared checks and its claims ledger. Each is present on the context only
 * when `runtime.services.<name>` is declared and approved; tools, hooks and fleet workers never receive them.
 */

/**
 * Where a run, a check or a git call works: the session's workspace, a worktree this extension created, or `path`, an
 * absolute directory inside a write root the operator granted this command (`ctx.paths`).
 */
export type ExtensionWorkPlace = "workspace" | { worktree: string; sub?: string } | { path: string };

export interface ExtensionRunRequest {
	prompt: string;
	/** With `model`, or neither: then `run` resolves the operator's default target and model as a headless run would. */
	target?: string;
	model?: string;
	thinking?: string;
	/** Defaults to the workspace. */
	cwd?: ExtensionWorkPlace;
	/** Must be one the manifest's `runs.autonomy` lists; defaults to `default`. */
	autonomy?: "default" | "yolo";
	readOnly?: boolean;
	/** `false` runs with `--no-delegate`: the run's agent dispatches no workers of its own. */
	delegate?: false;
	/** The text of a `run --answers` file, at most 64 KiB. */
	answers?: string;
	/** At most the manifest's `runs.maxTimeoutSeconds`. */
	timeoutSeconds: number;
	/** At most the manifest's `runs.maxCostUsd`, which is also the default when it declares one. */
	maxCostUsd?: number;
	/**
	 * An absolute directory inside a write root the operator granted this command (`ctx.paths`). The run keeps its
	 * PanCode data, state and cache in `home/{data,state,cache}`, which the host creates, so it shares no sessions or
	 * memory with any other run; it still uses the operator's config (targets, credentials, installed extensions) and
	 * reads their installed components and tools. `runs.digest` reads what such a run persisted.
	 */
	home?: string;
}

/** A page of a run's `--output-format stream-json` frames. `next` is the cursor for the following page. */
export interface ExtensionRunFrames {
	frames: ReadonlyArray<Readonly<Record<string, unknown>>>;
	next: number;
	/** Frames the host no longer holds because the cursor fell behind its window. */
	dropped: number;
	done: boolean;
}

export interface ExtensionRunEnd {
	exitCode: number | null;
	/**
	 * The `run_end` frame's outcome (`succeeded`, `failed`, `canceled` or `timed_out`), or `canceled`/`timed_out`/`error`
	 * when the run ended without one.
	 */
	outcome: string;
	/** The run's `run_end` frame (the `run --output-format json` envelope), null when it wrote none. */
	end: Readonly<Record<string, unknown>> | null;
	stderrTail: string;
	error?: string;
}

/**
 * What a run started with a `home` persisted, read from that home after it ended. The main session is the earliest
 * one opened in the run's directory, else the earliest in the home.
 */
export interface ExtensionRunDigest {
	sessionId: string | null;
	/**
	 * Interviews an extension tool put to the author. `reached` holds the distinct checkpoint ids their questions
	 * declared, in first-asked order; `answered` interviews finished, `unscripted` were cancelled because the
	 * answers file had no answer, and `unanswered` were cancelled any other way.
	 */
	gates: { reached: string[]; interviews: number; answered: number; unscripted: number; unanswered: number };
	/**
	 * Refusals by an extension: `hookBlocks` are its hooks' block_tool effects (journal `hook.ran`), `toolRefusals`
	 * its own tools' calls that returned an error outside an interview (session ledger).
	 */
	refusals: { hookBlocks: number; toolRefusals: number };
	/** Calls the loop guard blocked (journal `middleware.fired` from `guard.loop` with a block_tool effect). */
	loopGuardBlocks: number;
	/** The session's token attribution (`pancode telemetry tokens`): provider-measured input and output; null without a session. */
	tokens: {
		usage: string;
		calls: number;
		unmeasuredCalls: number;
		fresh: number | null;
		cached: number | null;
		input: number;
		output: number;
		/** Measured calls with no cache-read count: in input, in neither fresh nor cached. */
		unsplitCalls?: number;
	} | null;
}

/** `pancode extensions run <extension> <command> --json` in a place, as `runs.command` starts it. */
export interface ExtensionRunCommandRequest {
	extension: string;
	command: string;
	/** Defaults to the workspace. */
	cwd?: ExtensionWorkPlace;
	/** Runs against this run home's PanCode data, state and cache, as `runs.start` does. */
	home?: string;
	/** At most the manifest's `runs.maxTimeoutSeconds`. */
	timeoutSeconds: number;
}

export interface ExtensionRunCommandResult {
	/** Null when the command did not exit on its own (stopped, timed out or never started). */
	exitCode: number | null;
	/** Its standard output, at most 1 MiB: the `--json` result when it answered. */
	stdout: string;
	/** The last 4 KiB of its standard error. */
	stderrTail: string;
	/** Why it did not start or was stopped, when it was. */
	error?: string;
}

export interface ExtensionRuns {
	start(request: ExtensionRunRequest): Promise<{ id: string }>;
	/** At most `limit` frames (default 200, at most 1000) from `cursor`; waits up to `waitMs` (at most 30000) for one. */
	frames(id: string, options?: { cursor?: number; limit?: number; waitMs?: number }): Promise<ExtensionRunFrames>;
	wait(id: string): Promise<ExtensionRunEnd>;
	cancel(id: string): Promise<void>;
	/**
	 * Why `start` would refuse runs with these settings here before any starts, null when it would not: an autonomy
	 * the manifest does not allow, a writable or yolo run in a read-only session, runs nested too deep, or contained
	 * yolo this host cannot confine. A busy service or an unusable `cwd` still refuse at `start`. With `answers`, the
	 * text of a `run --answers` file, it is first why that text is no valid answers file, as `pancode run` words it
	 * without the file name.
	 */
	refusal(options?: { autonomy?: "default" | "yolo"; readOnly?: boolean; answers?: string }): Promise<string | null>;
	/** What an ended run started with a `home` persisted. */
	digest(id: string): Promise<ExtensionRunDigest>;
	/**
	 * Run another installed extension's command headless and return its `--json` answer. Present only when the
	 * manifest declares `runs.commands: true`; it counts as a run toward `maxConcurrent` and the nesting depth.
	 */
	command(request: ExtensionRunCommandRequest): Promise<ExtensionRunCommandResult>;
}

/** A path the operator named on the command line for a flag the verb declares in `runtime.cli[].paths`. */
export interface ExtensionPathGrant {
	flag: string;
	access: "read" | "write";
	/** Absolute: the flag's value resolved against the workspace. A write root exists; a read path may not. */
	path: string;
}

export interface ExtensionWorktree {
	id: string;
	/** The worktree's root, an absolute path under the project's `.pancode/worktrees/ext-<extension id>/`. */
	path: string;
	/** Where the workspace sits in the worktree: `path` itself unless the workspace is a subdirectory of its repository. */
	cwd: string;
	head: string;
	kept: boolean;
}

export interface ExtensionGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExtensionWorktrees {
	/**
	 * A detached worktree of the workspace's repository at `base` (default HEAD). `copy` names workspace-relative regular
	 * files to copy in as they are on disk. Without `keep` the worktree is removed when the request ends.
	 */
	create(options?: { base?: string; copy?: ReadonlyArray<string>; keep?: boolean }): Promise<ExtensionWorktree>;
	list(): Promise<ExtensionWorktree[]>;
	remove(id: string): Promise<void>;
	/** Read-only git (rev-parse, ls-tree, ls-files, status, diff, log, show, cat-file, merge-base) in a place. */
	git(place: ExtensionWorkPlace, args: ReadonlyArray<string>): Promise<ExtensionGitResult>;
	checkout(id: string, commit: string): Promise<void>;
	/** Remove untracked and ignored files except the `keep` entries. */
	clean(id: string, options?: { keep?: ReadonlyArray<string> }): Promise<void>;
	/** Copy workspace files in again, over whatever the worktree holds there. */
	copy(id: string, paths: ReadonlyArray<string>): Promise<void>;
	/**
	 * Commit everything, untracked files included, with the host identity, except the untracked files `leaveOut` names
	 * (an entry ending in `/` covers a directory). HEAD afterwards, unchanged when nothing changed.
	 */
	commit(
		id: string,
		message: string,
		options?: { leaveOut?: ReadonlyArray<string> },
	): Promise<{ head: string; leftOut: string[] }>;
	/** Refs under `refs/heads/pancode/<extension id>/` only. */
	refs: {
		get(name: string): Promise<string | null>;
		create(name: string, commit: string): Promise<void>;
		/** Move `name` from `from` to `to` only when it still points at `from`. */
		swap(name: string, to: string, from: string, message: string): Promise<boolean>;
	};
}

export interface ExtensionCheck {
	id: string;
	kind: string;
	command: ReadonlyArray<string>;
	cwd: string;
	timeoutMs: number;
	/** A sweep's runs; check `<id>/<run>` names one. */
	runs?: ReadonlyArray<string>;
	/** Workspace-relative files the check's command names, the inputs a worktree needs as the workspace holds them. */
	inputs: ReadonlyArray<string>;
}

export interface ExtensionCheckResult {
	ok: boolean;
	/** `succeeded` when the check ran to a verdict; `failed`, `timed-out`, `unavailable` and the like when it did not. */
	execution: string;
	/** The verdict of a check that ran: `passed` or `failed`; null when there is none. */
	validation: string | null;
	exitCode: number | null;
	/** The check's report, at most its last 64 KiB. */
	text: string;
	durationMs: number;
	/** Names this result to `claims.finish`; the host keeps the result, so a claim is only ever PanCode's own. */
	receipt: string;
}

/** What a check id names in a place, as `verify` resolves it, without running anything. */
export type ExtensionCheckResolution =
	| {
			ok: true;
			/** `catalog` for a declared check, else the derived kind (`package`, `toolchain`, `task`, `unavailable`). */
			kind: string;
			/**
			 * Workspace-relative files a worktree from HEAD needs copied in (`worktrees.copy`, one call) to judge the check
			 * as the workspace would: the verifier catalog when there is one, and for a catalog check the files it names
			 * that are untracked or changed since HEAD. At most 256 files and 32 MiB, else `ok: false`.
			 */
			inputs: ReadonlyArray<string>;
			/**
			 * A catalog check's declared definition as `check` and `measure` run it in this place, the verifier catalog's
			 * entry as JSON; a sweep run's has the run directory on its argv. Absent for a derived check.
			 */
			check?: Readonly<Record<string, unknown>>;
			/** A sweep run's directory, relative to the place, as the check's `runs` names it. */
			run?: string;
	  }
	| { ok: false; message: string };

export interface ExtensionVerify {
	list(place?: ExtensionWorkPlace): Promise<ExtensionCheck[]>;
	/** Resolve a check id as `check` would, catalog and derived checks alike, without running it. */
	resolve(id: string, place?: ExtensionWorkPlace): Promise<ExtensionCheckResolution>;
	/**
	 * Run a check as `verify` would, under the host verification sandbox: a catalog check in this process, a derived
	 * one (a package script, a toolchain check) through `pancode verifiers dry-run` in the place.
	 */
	check(id: string, place?: ExtensionWorkPlace): Promise<ExtensionCheckResult>;
	/**
	 * Run a catalog check's command and read one finite number, `metric`, from its numeric payload. A result whose
	 * command ran carries `receipt`, naming the run to `claims.finish` as `check` would; its execution is `succeeded`,
	 * `failed`, `timed-out` or `aborted`, and a plain measurement never yields a claim.
	 */
	measure(id: string, metric: string, place?: ExtensionWorkPlace): Promise<ExtensionMeasureResult>;
}

export type ExtensionMeasureResult =
	| { ok: true; value: number; receipt: string }
	| { ok: false; reason: string; receipt?: string };

export interface ExtensionClaims {
	/**
	 * Record the hypotheses of a slate this extension keeps under `name` (a `pancode.hypothesis-slate.v1` document).
	 * Returns the ledger id each slate id got, null for one recorded unchanged before.
	 */
	hypotheses(name: string, slate: string): Promise<Record<string, string | null>>;
	/** Start `checks` as one run, binding the proposed hypotheses that name them; the bound ids per check. */
	begin(run: string, checks: ReadonlyArray<string>): Promise<Record<string, string[]>>;
	/**
	 * Record the claims the run's checks were judged into and test the hypotheses `begin` bound. A hypothesis in
	 * `withoutClaim` is tested on the run alone, never with the claim as its evidence. The claim id per check. An
	 * outcome `{ check, execution: "aborted" }` names a check the run stopped before judging: its hypotheses are tested
	 * as aborted, with no receipt and never a claim.
	 */
	finish(
		run: string,
		outcomes: ReadonlyArray<{ check: string; receipt: string } | { check: string; execution: "aborted" }>,
		options?: { withoutClaim?: ReadonlyArray<string> },
	): Promise<Record<string, string>>;
	/** The project's latest ledger records, newest last. */
	read(options?: {
		types?: ReadonlyArray<"claim" | "hypothesis" | "hypothesis-test">;
		limit?: number;
	}): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}
