// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { gitExecFileSync } from "../../core/internal-git-run.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { PLAYBOOK_COMMAND_BASE_ENV, type PlaybookCommand } from "../agents/playbook-commands.js";
import { readVerifiedRun } from "../telemetry/run-record.js";
import type { RunHostVerificationCheck } from "./types.js";
import { captureWorkspaceSnapshot } from "./write-boundary.js";

const MEMO_VERSION = 3;

interface MemoEntry {
	key: string;
	runId: string;
	check: RunHostVerificationCheck;
}

interface MemoFile {
	version: typeof MEMO_VERSION;
	entries: MemoEntry[];
}

function repositoryRoot(cwd: string): string {
	return gitExecFileSync(["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

/** Untracked files git does not ignore under `root`; undefined when git cannot list them. */
function untrackedCount(root: string): number | undefined {
	try {
		const listed = gitExecFileSync(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		return listed.split("\0").filter((entry) => entry.length > 0).length;
	} catch {
		return undefined;
	}
}

/**
 * The checkout a check judged: its root, HEAD, a digest of HEAD plus working-tree content, and how many untracked
 * files it held, which HEAD alone does not name.
 */
export function checkedTree(
	cwd: string,
): { root: string; head: string; fingerprint: string; untracked?: number } | null {
	try {
		const snapshot = captureWorkspaceSnapshot(repositoryRoot(cwd));
		const fingerprint = sha256Hex(
			JSON.stringify({
				head: snapshot.head,
				entries: [...snapshot.entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			}),
		);
		const untracked = untrackedCount(snapshot.root);
		return { root: snapshot.root, head: snapshot.head, fingerprint, ...(untracked !== undefined ? { untracked } : {}) };
	} catch {
		return null;
	}
}

export function workspaceFingerprint(cwd: string): string | null {
	return checkedTree(cwd)?.fingerprint ?? null;
}

function memoPath(stateDir: string): string {
	return join(stateDir, "dispatch-verification-memo.json");
}

export function readMemo(stateDir: string): MemoFile {
	const target = memoPath(stateDir);
	if (!existsSync(target)) return { version: MEMO_VERSION, entries: [] };
	try {
		const parsed = JSON.parse(readFileSync(target, "utf8")) as MemoFile;
		if (parsed.version === MEMO_VERSION && Array.isArray(parsed.entries)) return parsed;
	} catch {
		// A damaged cache is a miss. Receipts remain the authoritative evidence.
	}
	return { version: MEMO_VERSION, entries: [] };
}

function writeMemo(stateDir: string, memo: MemoFile): void {
	const target = memoPath(stateDir);
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(memo, null, 2), "utf8");
	renameSync(temporary, target);
}

export function storeMemoEntry(stateDir: string, entry: MemoEntry): void {
	const target = memoPath(stateDir);
	withStateFileLockSync(target, () => {
		const memo = readMemo(stateDir);
		memo.entries = [entry, ...memo.entries.filter((candidate) => candidate.key !== entry.key)].slice(0, 512);
		writeMemo(stateDir, memo);
	});
}

/**
 * Whether a memo entry's evidence run sealed an execution of this very check on this tree (D3-2). The memo file is
 * plain state any writer of the state directory can edit, so a hit counts only when `runId` names a run whose seal
 * verifies and whose sealed checks hold this check (same id, argv, cwd and tree fingerprint) passing with exit 0, run
 * there rather than reused. A forged or dangling entry, or one whose run has not sealed yet, is a miss and the check
 * runs.
 */
export function memoEvidenceSealed(stateDir: string, entry: MemoEntry, check: string, fingerprint: string): boolean {
	let run: ReturnType<typeof readVerifiedRun>;
	try {
		run = readVerifiedRun(stateDir, entry.runId);
	} catch {
		// An entry whose run id is not a safe id names no run.
		return false;
	}
	const sealed = run?.result?.state === "resolved" ? run.result.value.hostVerification?.checks : undefined;
	return (sealed ?? []).some(
		(candidate) =>
			candidate.check === check &&
			entry.check.check === check &&
			candidate.exitCode === 0 &&
			!candidate.memo &&
			candidate.evidenceRunId === null &&
			candidate.notRun === undefined &&
			candidate.cwd === entry.check.cwd &&
			candidate.argv.length === entry.check.argv.length &&
			candidate.argv.every((part, index) => part === entry.check.argv[index]) &&
			candidate.tree?.fingerprint === fingerprint,
	);
}

export function memoKey(
	command: PlaybookCommand,
	judgment: string,
	fingerprint: string,
	env: NodeJS.ProcessEnv,
): string {
	const names = [...PLAYBOOK_COMMAND_BASE_ENV, ...command.env];
	const values = Object.fromEntries(names.map((name) => [name, env[name] ?? null]));
	return sha256Hex(JSON.stringify({ fingerprint, judgment, env: values }));
}
