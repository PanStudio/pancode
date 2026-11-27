// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The host services a command or action reaches for work that outlives one call: headless PanCode runs, git
 * worktrees the host owns, the project's declared checks and its claims ledger. Each is present on the context only
 * when `runtime.services.<name>` is declared and approved; tools, hooks and fleet workers never receive them.
 */

/** Where a run, a check or a git call works: the session's workspace, or a worktree this extension created. */
export type ExtensionWorkPlace = "workspace" | { worktree: string; sub?: string };

export interface ExtensionRunRequest {
	prompt: string;
	target: string;
	model: string;
	thinking?: string;
	/** Defaults to the workspace. */
	cwd?: ExtensionWorkPlace;
	/** Must be one the manifest's `runs.autonomy` lists; defaults to `default`. */
	autonomy?: "default" | "yolo";
	readOnly?: boolean;
	/** The text of a `run --answers` file, at most 64 KiB. */
	answers?: string;
	/** At most the manifest's `runs.maxTimeoutSeconds`. */
	timeoutSeconds: number;
	/** At most the manifest's `runs.maxCostUsd`, which is also the default when it declares one. */
	maxCostUsd?: number;
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
	/** The `run_end` frame's outcome, or `canceled`/`timed_out`/`error` when the run ended without one. */
	outcome: string;
	/** The run's `run_end` frame (the `run --output-format json` envelope), null when it wrote none. */
	end: Readonly<Record<string, unknown>> | null;
	stderrTail: string;
	error?: string;
}

export interface ExtensionRuns {
	start(request: ExtensionRunRequest): Promise<{ id: string }>;
	/** At most `limit` frames (default 200, at most 1000) from `cursor`; waits up to `waitMs` (at most 30000) for one. */
	frames(id: string, options?: { cursor?: number; limit?: number; waitMs?: number }): Promise<ExtensionRunFrames>;
	wait(id: string): Promise<ExtensionRunEnd>;
	cancel(id: string): Promise<void>;
}

export interface ExtensionWorktree {
	id: string;
	/** Absolute path, inside this extension's store directory. */
	path: string;
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
	 * A detached worktree of the workspace's repository at `base` (default HEAD). `copy` names workspace files to copy
	 * in as they are on disk. Without `keep` the worktree is removed when the request ends.
	 */
	create(options?: { base?: string; copy?: ReadonlyArray<string>; keep?: boolean }): Promise<ExtensionWorktree>;
	list(): Promise<ExtensionWorktree[]>;
	remove(id: string): Promise<void>;
	/** Read-only git (rev-parse, ls-tree, ls-files, status, diff, log, show, cat-file, merge-base) in a place. */
	git(place: ExtensionWorkPlace, args: ReadonlyArray<string>): Promise<ExtensionGitResult>;
	checkout(id: string, commit: string): Promise<void>;
	/** Remove untracked and ignored files except the `keep` entries. */
	clean(id: string, options?: { keep?: ReadonlyArray<string> }): Promise<void>;
	/** Commit everything with the host identity, except untracked `leaveOut` paths; HEAD afterwards. */
	commit(id: string, message: string, options?: { leaveOut?: ReadonlyArray<string> }): Promise<{ head: string }>;
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
}

export interface ExtensionCheckResult {
	ok: boolean;
	exitCode: number | null;
	text: string;
	durationMs: number;
	timedOut: boolean;
}

export interface ExtensionVerify {
	list(place?: ExtensionWorkPlace): Promise<ExtensionCheck[]>;
	/** Run a declared check as `verify` would, under the host verification sandbox. */
	check(id: string, place?: ExtensionWorkPlace): Promise<ExtensionCheckResult>;
	/** Run a check and read one numeric `metric` from its output. */
	measure(
		id: string,
		metric: string,
		place?: ExtensionWorkPlace,
	): Promise<{ ok: true; value: number } | { ok: false; reason: string }>;
}

export interface ExtensionClaims {
	append(record: Readonly<Record<string, unknown>>): Promise<{ id: string }>;
	read(options?: { kind?: string; limit?: number }): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}
