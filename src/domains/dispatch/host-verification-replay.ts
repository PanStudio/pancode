// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gitExecFileSync, gitVia } from "../../core/internal-git-run.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { redactCommandOutputSecrets } from "../../lib/secrets/redact.js";
import { OUTPUT_TAIL_BYTES } from "./host-verification-runner.js";
import type { RunHostVerificationCheck } from "./types.js";

/** Lockfiles whose agreement lets the base replay borrow the task's installed dependencies. */
const DEPENDENCY_MANIFESTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
];

/** Each manifest is absent on both sides or has the same blob id; hashes avoid reading lockfiles into memory. */
export async function manifestsMatchBase(root: string, base: string): Promise<boolean> {
	const git = (args: string[]) =>
		gitVia(runCommandVector, ["-C", root, ...args], { timeoutMs: 5_000, maxOutputBytes: 1_024 });
	try {
		return await manifestsMatch(root, base, git);
	} catch {
		// PanCode refused its own hash-object after config drift: unproven manifests do not match.
		return false;
	}
}

async function manifestsMatch(
	root: string,
	base: string,
	git: (args: string[]) => ReturnType<typeof runCommandVector>,
): Promise<boolean> {
	for (const name of DEPENDENCY_MANIFESTS) {
		const atBase = await git(["rev-parse", "--verify", "-q", `${base}:${name}`]);
		const baseId = atBase.exitCode === 0 ? atBase.stdout.trim() : null;
		if (!existsSync(join(root, name))) {
			if (baseId !== null) return false;
			continue;
		}
		if (baseId === null) return false;
		const inTask = await git(["hash-object", "--", name]);
		if (inTask.exitCode !== 0 || inTask.stdout.trim() !== baseId) return false;
	}
	return true;
}

/**
 * Base replays of whole-repo checks, one per base commit, check command, cwd
 * and environment, so every task cut from one base pays for each failing
 * check's base run once. In flight they are shared in memory; once complete
 * they are kept under the state root, so another session on the machine reuses
 * them too. Both are bounded.
 */
export interface BaseReplay {
	exitCode: number | null;
	incomplete: boolean;
	/** The base tree could not resolve the check's toolchain; never cached, never compared. */
	startFailed?: boolean;
	/** The base run's output as {@link outputLines}. */
	lines: string[];
}

// Version 3 drops replays recorded before the base check ran under the secret masks.
const BASE_REPLAY_VERSION = 3;

export const BASE_REPLAY_CACHE_MAX = 64;

export const BASE_REPLAY_LINES_MAX = 20_000;

export const baseReplayCache = new Map<string, Promise<BaseReplay>>();

function baseReplayPath(stateDir: string, key: string): string {
	return join(stateDir, "dispatch-verification-base", `${key}.json`);
}

export function readBaseReplay(stateDir: string, key: string): BaseReplay | undefined {
	try {
		const parsed = JSON.parse(readFileSync(baseReplayPath(stateDir, key), "utf8")) as {
			version?: unknown;
			exitCode?: unknown;
			lines?: unknown;
		};
		if (
			parsed.version !== BASE_REPLAY_VERSION ||
			typeof parsed.exitCode !== "number" ||
			!Array.isArray(parsed.lines) ||
			!parsed.lines.every((line) => typeof line === "string")
		)
			return undefined;
		return { exitCode: parsed.exitCode, incomplete: false, lines: parsed.lines as string[] };
	} catch {
		// A missing or damaged entry is a miss; the base runs again.
		return undefined;
	}
}

export function storeBaseReplay(stateDir: string, key: string, replay: BaseReplay): void {
	const target = baseReplayPath(stateDir, key);
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(
		temporary,
		JSON.stringify({ version: BASE_REPLAY_VERSION, exitCode: replay.exitCode, lines: replay.lines }),
		"utf8",
	);
	renameSync(temporary, target);
	const stale = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => ({ name, mtimeMs: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(BASE_REPLAY_CACHE_MAX);
	for (const entry of stale) rmSync(join(dir, entry.name), { force: true });
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

const PASSING_LINE_RE = /^(?:✔|✓|√|ok\b|PASS\b)/u;

/**
 * A check's output as lines comparable across two checkouts: escape codes
 * stripped, each checkout root replaced, every digit run (line and column
 * numbers, counts, durations) replaced, whitespace collapsed, and blank or
 * passing-test lines dropped.
 */
export function outputLines(output: string, roots: ReadonlyArray<string>): string[] {
	const ordered = [...new Set(roots)].sort((left, right) => right.length - left.length);
	const lines = new Set<string>();
	for (const raw of redactCommandOutputSecrets(output).split(/\r?\n/u)) {
		let line = raw.replace(ANSI_ESCAPE_RE, "");
		for (const root of ordered) line = line.split(root).join("<root>");
		line = line.replace(/\d+/gu, "N").replace(/\s+/gu, " ").trim();
		if (line !== "" && !PASSING_LINE_RE.test(line)) lines.add(line);
	}
	return [...lines];
}

/** What the failing check printed on the task: its full artifact log when there is one, else the receipt tail. */
export function taskCheckOutput(check: RunHostVerificationCheck): string {
	if (check.artifactPath !== undefined) {
		try {
			const log = readFileSync(check.artifactPath, "utf8");
			// The code-step log is a header, a blank line, then the captured output.
			const body = log.indexOf("\n\n");
			if (body >= 0) return log.slice(body + 2);
		} catch {
			// Fall back to the tail sealed on the receipt.
		}
	}
	// A full tail starts mid-line; that partial line is not output the base could match.
	return Buffer.byteLength(check.outputTail, "utf8") >= OUTPUT_TAIL_BYTES - 4
		? check.outputTail.slice(check.outputTail.indexOf("\n") + 1)
		: check.outputTail;
}

export function taskRoots(path: string): string[] {
	try {
		return [path, realpathSync(path)];
	} catch {
		return [path];
	}
}

/** A failure line short enough for a receipt reason. */
export function boundedLine(line: string): string {
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function resolvedBaseSha(root: string, base: string): string | null {
	try {
		return gitExecFileSync(["-C", root, "rev-parse", "--verify", "-q", `${base}^{commit}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		}).trim();
	} catch {
		return null;
	}
}
