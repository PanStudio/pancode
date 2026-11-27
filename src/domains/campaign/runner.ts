// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isRecord } from "../../core/type-guards.js";
import { type PancodeLaunch, type RunEnvPolicy, runEnv } from "../extensions/services/run-env.js";
import { withContainedYoloPin } from "../safety/autonomy.js";
import { type CampaignMetrics, entryRootEnv, entryRoots, foldCampaignMetrics, loadCampaignMetrics } from "./fold.js";
import type { RosterEntry } from "./roster.js";

/** 2: entries repeat (`repetition`), and each carries the run's `completion` and `verification` from its run_end. */
export const CAMPAIGN_SCHEMA_VERSION = 2;
/** The `run --output-format json` envelope schema the campaign reads (src/cli/modes/run-json-schema-v2.ts). */
const RUN_END_SCHEMA_VERSION = 3;

/** `run --timeout` expiry and an unscripted question (src/cli/run-answers.ts UNSCRIPTED_EXIT_CODE). */
const RUN_TIMEOUT_EXIT = 124;
const RUN_UNSCRIPTED_EXIT = 5;
/** Seconds an entry gets beyond its own `--timeout` to write its records before the campaign stops it. */
const TIMEOUT_GRACE_SECONDS = 30;
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_TEXT_MAX = 4000;
const ERROR_TAIL_LINES = 3;

export interface CampaignProbe {
	extension: string;
	command: string;
}

export interface CampaignInput {
	/** The seeded project every entry starts from; it is copied, never written. */
	fixture: string;
	roster: ReadonlyArray<RosterEntry>;
	/** A `run --answers` file, already validated by the caller. */
	answers: string;
	prompt: string;
	/** Absent or empty; every entry's project copy, home, logs and entry.json land under it. */
	out: string;
	/** How many times the whole roster runs, one pass after another; 1 runs each entry once. */
	repeat: number;
	/** Each entry's `run --timeout`; null runs without one. */
	timeoutSeconds: number | null;
	autonomy: "default" | "yolo";
	/** An extension command whose `--json` result is recorded as the desk's final status after each run. */
	probe: CampaignProbe | null;
	/**
	 * The operator's PanCode config root. Every entry runs against it directly, as an arena contender does, so its
	 * targets, installed extensions and credential store are the operator's own: no secret is copied under `out`,
	 * and an OAuth refresh an entry makes lands in the operator's store under its lock instead of in a copy that
	 * is thrown away, which would strand a rotated refresh token.
	 */
	operatorConfig: string;
	/**
	 * The operator's installed components directory (`<data>/components`). Entries resolve runtime SDKs such as
	 * copilot-sdk and claude-sdk from it, read-only, since their own data roots start empty.
	 */
	operatorComponents: string;
	/** The operator's toolchain root (`<data>/tools`). Entries resolve vendored tool binaries from it, read-only. */
	operatorTools: string;
	pancode: PancodeLaunch;
	env: Record<string, string>;
	envPolicy: RunEnvPolicy;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
}

/**
 * How an entry's run ended: `completed` exited 0, `unscripted` stopped on a question the answers file did not
 * script, `timed-out` hit `--timeout`, `failed` exited otherwise, `canceled` was stopped by the operator or never
 * started, and `error` could not be set up or launched.
 */
export type CampaignEntryStatus = "completed" | "unscripted" | "timed-out" | "failed" | "canceled" | "error";

export interface CampaignProbeResult {
	extension: string;
	command: string;
	exitCode: number | null;
	/** The command's text result, clipped. */
	text: string | null;
	data: unknown;
	error: string | null;
}

/** The completion the run's host sealed (its run_end `completion`): the agent's `finish` claim and the assessment. */
export interface CampaignEntryCompletion {
	/** Null when the agent declared nothing through `finish`. */
	claimed: "done" | "partly_done" | "not_done" | null;
	assessed: "done" | "partly_done" | "not_done" | "unknown";
	/** The open obligations that lowered the claim, such as `failed_check` or `unvalidated_mutation`. */
	facts: string[];
}

/** The host's verdict on the run from its run_end: outcome, cause codes and the `--verify` checks' states. */
export interface CampaignEntryVerification {
	outcome: string;
	outcomeDetail: string | null;
	causes: string[];
	checks: Array<{ command: string; status: string }>;
}

export interface CampaignEntryResult {
	schemaVersion: number;
	/** The entry's roster position, from 0. */
	index: number;
	/** Which pass over the roster this run is, from 0. */
	repetition: number;
	label: string;
	target: string;
	model: string;
	thinking: string | null;
	status: CampaignEntryStatus;
	exitCode: number | null;
	startedAt: string | null;
	/** Wall time of the run process; reported, never a pass criterion. */
	wallMs: number | null;
	dir: string;
	metrics: CampaignMetrics;
	/** Null when the run wrote no run_end envelope, or one without a completion. */
	completion: CampaignEntryCompletion | null;
	/** Null when the run wrote no run_end envelope. */
	verification: CampaignEntryVerification | null;
	desk: CampaignProbeResult | null;
	error: string | null;
}

export interface CampaignResult {
	schemaVersion: number;
	fixture: string;
	answers: string;
	prompt: string;
	out: string;
	timeoutSeconds: number | null;
	repeat: number;
	autonomy: "default" | "yolo";
	startedAt: string;
	completedAt: string;
	canceled: boolean;
	entries: CampaignEntryResult[];
}

/** An input the campaign refuses before any entry starts. */
export class CampaignInputError extends Error {}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function validateCampaignInput(input: Pick<CampaignInput, "fixture" | "out" | "prompt">): void {
	if (input.prompt.trim().length === 0) throw new CampaignInputError("campaign run needs a non-empty --prompt");
	const fixture = resolve(input.fixture);
	const out = resolve(input.out);
	if (!existsSync(fixture)) throw new CampaignInputError(`--fixture ${fixture} does not exist`);
	if (isSameOrDescendant(out, fixture))
		throw new CampaignInputError(`--out ${out} is inside the fixture; the fixture is copied whole`);
	if (existsSync(out) && readdirSync(out).length > 0)
		throw new CampaignInputError(`--out ${out} already holds files; name an absent or empty directory`);
}

/** `<NN>-<label>`, and `-r<K>` after it when the roster repeats, so a single pass keeps its layout. */
function entryDirName(index: number, label: string, repetition: number, repeat: number): string {
	const name = `${String(index + 1).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
	return repeat > 1 ? `${name}-r${repetition + 1}` : name;
}

function runArgs(input: CampaignInput, entry: RosterEntry, project: string): string[] {
	return [
		...input.pancode.args,
		"run",
		"--cwd",
		project,
		"--target",
		entry.target,
		"--model",
		entry.model,
		...(entry.thinking !== null ? ["--thinking", entry.thinking] : []),
		"--answers",
		input.answers,
		...(input.timeoutSeconds !== null ? ["--timeout", String(input.timeoutSeconds)] : []),
		...(input.autonomy === "yolo" ? ["--autonomy", "yolo"] : []),
		"--output-format",
		"json",
		"--",
		input.prompt,
	];
}

function statusOf(result: SafeCommandResult): CampaignEntryStatus {
	if (result.aborted) return "canceled";
	if (result.timedOut || result.exitCode === RUN_TIMEOUT_EXIT) return "timed-out";
	if (result.launched === false) return "error";
	if (result.exitCode === 0) return "completed";
	if (result.exitCode === RUN_UNSCRIPTED_EXIT) return "unscripted";
	return "failed";
}

/** The last lines a child wrote to stderr, without the `error:` lead printError puts on each. */
function tail(text: string): string | null {
	const lines = text
		.trim()
		.split("\n")
		.slice(-ERROR_TAIL_LINES)
		.map((line) => line.replace(/^error: /u, ""))
		.join("\n");
	return lines.length > 0 ? lines : null;
}

const COMPLETION_STATES = new Set(["done", "partly_done", "not_done"]);

/**
 * The run's own verdict from the one `run_end` line `run --output-format json` writes to stdout. A run that never got
 * that far (no launch, a forced exit) leaves both fields null.
 */
function readRunEnd(stdout: string): {
	completion: CampaignEntryCompletion | null;
	verification: CampaignEntryVerification | null;
} {
	let envelope: Record<string, unknown> | null = null;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const frame = JSON.parse(line) as unknown;
			if (isRecord(frame) && frame.type === "run_end" && frame.schemaVersion === RUN_END_SCHEMA_VERSION) envelope = frame;
		} catch {
			// A line that is not whole JSON is not the envelope; the envelope is always one serialized line.
		}
	}
	if (envelope === null) return { completion: null, verification: null };
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	const raw = envelope.completion;
	const completion: CampaignEntryCompletion | null =
		isRecord(raw) && typeof raw.assessed === "string"
			? {
					claimed:
						typeof raw.claimed === "string" && COMPLETION_STATES.has(raw.claimed)
							? (raw.claimed as CampaignEntryCompletion["claimed"])
							: null,
					assessed: COMPLETION_STATES.has(raw.assessed) ? (raw.assessed as CampaignEntryCompletion["assessed"]) : "unknown",
					facts: strings(raw.facts),
				}
			: null;
	const causes = Array.isArray(envelope.causes) ? envelope.causes : [];
	const checks = isRecord(envelope.verify) && Array.isArray(envelope.verify.checks) ? envelope.verify.checks : [];
	const verification: CampaignEntryVerification = {
		outcome: typeof envelope.outcome === "string" ? envelope.outcome : "unknown",
		outcomeDetail: typeof envelope.outcomeDetail === "string" ? envelope.outcomeDetail : null,
		causes: strings(causes.map((cause) => (isRecord(cause) ? cause.code : undefined))),
		checks: checks.flatMap((check) =>
			isRecord(check) && typeof check.command === "string" && typeof check.status === "string"
				? [{ command: check.command, status: check.status }]
				: [],
		),
	};
	return { completion, verification };
}

/** Run the extension command the operator named and keep its structured result as the desk's final status. */
async function probeDesk(
	input: CampaignInput,
	probe: CampaignProbe,
	project: string,
	env: Record<string, string>,
): Promise<CampaignProbeResult> {
	const base = { extension: probe.extension, command: probe.command };
	let result: SafeCommandResult;
	try {
		result = await runCommandVector(
			input.pancode.file,
			[...input.pancode.args, "extensions", "run", probe.extension, probe.command, "--json"],
			{
				cwd: project,
				workspaceRoot: project,
				env,
				timeoutMs: PROBE_TIMEOUT_MS,
				...(input.signal ? { signal: input.signal } : {}),
			},
		);
	} catch (error) {
		return { ...base, exitCode: null, text: null, data: null, error: errorText(error) };
	}
	if (result.exitCode !== 0)
		return { ...base, exitCode: result.exitCode, text: null, data: null, error: tail(result.stderr) ?? "probe failed" };
	try {
		const parsed = JSON.parse(result.stdout.trim()) as { output?: { text?: unknown; data?: unknown } };
		const text = typeof parsed.output?.text === "string" ? parsed.output.text.trim().slice(0, PROBE_TEXT_MAX) : null;
		return { ...base, exitCode: 0, text, data: parsed.output?.data ?? null, error: null };
	} catch (error) {
		return { ...base, exitCode: 0, text: null, data: null, error: `unreadable --json result: ${errorText(error)}` };
	}
}

async function runEntry(
	input: CampaignInput,
	entry: RosterEntry,
	index: number,
	repetition: number,
): Promise<CampaignEntryResult> {
	const dir = join(input.out, entryDirName(index, entry.label, repetition, input.repeat));
	const project = join(dir, "project");
	const roots = entryRoots(join(dir, "home"), input.operatorConfig, input.operatorComponents, input.operatorTools);
	const result: CampaignEntryResult = {
		schemaVersion: CAMPAIGN_SCHEMA_VERSION,
		index,
		repetition,
		label: entry.label,
		target: entry.target,
		model: entry.model,
		thinking: entry.thinking,
		status: "canceled",
		exitCode: null,
		startedAt: null,
		wallMs: null,
		dir,
		metrics: foldCampaignMetrics(null, [], [], null),
		completion: null,
		verification: null,
		desk: null,
		error: null,
	};
	const save = (): void => {
		safeResourceWrite(join(dir, "entry.json"), `${JSON.stringify(result, null, 2)}\n`);
	};
	mkdirSync(dir, { recursive: true });
	if (input.signal?.aborted) {
		result.error = "canceled before it started";
		save();
		return result;
	}
	try {
		cpSync(input.fixture, project, { recursive: true });
		for (const root of [roots.data, roots.state, roots.cache]) mkdirSync(root, { recursive: true, mode: 0o700 });
		const scoped = {
			...runEnv(input.env, input.envPolicy, entry.target),
			...input.pancode.env,
			...entryRootEnv(roots),
		};
		const env = input.autonomy === "yolo" ? withContainedYoloPin(scoped) : scoped;
		const stdout = openSync(join(dir, "run.stdout.log"), "w");
		const stderr = openSync(join(dir, "run.stderr.log"), "w");
		let run: SafeCommandResult;
		result.startedAt = new Date().toISOString();
		try {
			run = await runCommandVector(input.pancode.file, runArgs(input, entry, project), {
				cwd: project,
				workspaceRoot: project,
				env,
				timeoutMs: input.timeoutSeconds === null ? 0 : (input.timeoutSeconds + TIMEOUT_GRACE_SECONDS) * 1000,
				output: {
					onStdout: (chunk) => void writeSync(stdout, chunk),
					onStderr: (chunk) => void writeSync(stderr, chunk),
					retainTailBytes: 4096,
				},
				...(input.signal ? { signal: input.signal } : {}),
			});
		} finally {
			closeSync(stdout);
			closeSync(stderr);
		}
		result.exitCode = run.exitCode;
		result.wallMs = run.durationMs;
		result.status = statusOf(run);
		if (result.status !== "completed") result.error = run.failure ?? tail(run.stderr);
		try {
			Object.assign(result, readRunEnd(readFileSync(join(dir, "run.stdout.log"), "utf8")));
		} catch (error) {
			result.error = result.error ?? `run_end: ${errorText(error)}`;
		}
		try {
			result.metrics = loadCampaignMetrics(roots, project);
		} catch (error) {
			result.error = result.error ?? `metrics: ${errorText(error)}`;
		}
		if (input.probe !== null && result.status !== "canceled")
			result.desk = await probeDesk(input, input.probe, project, env);
	} catch (error) {
		result.status = "error";
		result.error = errorText(error);
	}
	save();
	return result;
}

/**
 * Run one fixture across a roster, one entry at a time so wall times do not contend, and the whole roster `repeat`
 * times, one pass after another, so a route's variance shows across passes. Each entry gets a fresh copy
 * of the fixture and its own empty PanCode data, state and cache roots beside the operator's config and installed
 * components, runs headless `pancode run --answers`, and is folded from what that run persisted. An entry that
 * fails, times out or cannot start is recorded and the campaign moves on; a stop signal cancels the running entry
 * and the rest.
 */
export async function runCampaign(input: CampaignInput): Promise<CampaignResult> {
	validateCampaignInput(input);
	if (!Number.isInteger(input.repeat) || input.repeat < 1)
		throw new CampaignInputError("campaign run repeats the roster a positive whole number of times");
	const fixture = resolve(input.fixture);
	const out = resolve(input.out);
	mkdirSync(out, { recursive: true });
	const normalized: CampaignInput = { ...input, fixture, out, answers: resolve(input.answers) };
	const startedAt = new Date().toISOString();
	const entries: CampaignEntryResult[] = [];
	for (let repetition = 0; repetition < input.repeat; repetition++) {
		const pass = input.repeat > 1 ? `pass ${repetition + 1}/${input.repeat} ` : "";
		for (const [index, entry] of input.roster.entries()) {
			const lead = `${pass}entry ${index + 1}/${input.roster.length} ${entry.label}`;
			input.onProgress?.(`${lead}: running`);
			const result = await runEntry(normalized, entry, index, repetition);
			const seconds = result.wallMs === null ? "" : ` in ${(result.wallMs / 1000).toFixed(1)}s`;
			input.onProgress?.(`${lead}: ${result.status}${seconds}`);
			entries.push(result);
		}
	}
	return {
		schemaVersion: CAMPAIGN_SCHEMA_VERSION,
		fixture,
		answers: normalized.answers,
		prompt: input.prompt,
		out,
		timeoutSeconds: input.timeoutSeconds,
		repeat: input.repeat,
		autonomy: input.autonomy,
		startedAt,
		completedAt: new Date().toISOString(),
		canceled: input.signal?.aborted === true,
		entries,
	};
}
