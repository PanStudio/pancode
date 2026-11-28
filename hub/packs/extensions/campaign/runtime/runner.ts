import {
	closeSync,
	cpSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ExtensionContextV2,
	ExtensionRunCommandResult,
	ExtensionRunEnd,
	ExtensionRuns,
} from "pancode/sdk/extension";
import { type CampaignHost, CampaignUsageError } from "./cli.ts";
import {
	CAMPAIGN_SCHEMA_VERSION,
	type CampaignEntryCompletion,
	type CampaignEntryResult,
	type CampaignEntryStatus,
	type CampaignEntryVerification,
	type CampaignInput,
	type CampaignProbe,
	type CampaignProbeResult,
	type CampaignResult,
	emptyDigest,
	type RosterEntry,
} from "./types.ts";

/** The `run --output-format json` envelope schema the campaign reads from the run_end frame. */
const RUN_END_SCHEMA_VERSION = 3;
/** `run --timeout` expiry and an unscripted question (`pancode run --answers`). */
const RUN_TIMEOUT_EXIT = 124;
const RUN_UNSCRIPTED_EXIT = 5;
const PROBE_TIMEOUT_SECONDS = 120;
const PROBE_TEXT_MAX = 4000;
const ERROR_TAIL_LINES = 3;
const FRAME_PAGE = 1000;
const FRAME_WAIT_MS = 30_000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `<NN>-<label>`, and `-r<K>` after it when the roster repeats, so a single pass keeps its layout. */
export function entryDirName(index: number, label: string, repetition: number, repeat: number): string {
	const name = `${String(index + 1).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
	return repeat > 1 ? `${name}-r${repetition + 1}` : name;
}

/** The last lines a run wrote to stderr, without the `error:` lead PanCode puts on each. */
export function stderrTail(text: string): string | null {
	const lines = text
		.trim()
		.split("\n")
		.slice(-ERROR_TAIL_LINES)
		.map((line) => line.replace(/^error: /u, ""))
		.join("\n");
	return lines.length > 0 ? lines : null;
}

/** How an entry's run ended, from the runs service's end and whether the operator stopped the campaign. */
export function statusOf(end: ExtensionRunEnd, stopped: boolean): CampaignEntryStatus {
	if (stopped || end.outcome === "canceled") return "canceled";
	if (end.exitCode === RUN_TIMEOUT_EXIT || (end.outcome === "timed_out" && end.end === null)) return "timed-out";
	if (end.exitCode === null) return "error";
	if (end.exitCode === 0) return "completed";
	if (end.exitCode === RUN_UNSCRIPTED_EXIT) return "unscripted";
	return "failed";
}

const COMPLETION_STATES = new Set(["done", "partly_done", "not_done"]);

/** The run's own verdict from its run_end frame; a run that never got that far leaves both fields null. */
export function readRunEnd(frame: Readonly<Record<string, unknown>> | null): {
	completion: CampaignEntryCompletion | null;
	verification: CampaignEntryVerification | null;
} {
	if (frame === null || frame.type !== "run_end" || frame.schemaVersion !== RUN_END_SCHEMA_VERSION)
		return { completion: null, verification: null };
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	const raw = frame.completion;
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
	const causes = Array.isArray(frame.causes) ? frame.causes : [];
	const checks = isRecord(frame.verify) && Array.isArray(frame.verify.checks) ? frame.verify.checks : [];
	return {
		completion,
		verification: {
			outcome: typeof frame.outcome === "string" ? frame.outcome : "unknown",
			outcomeDetail: typeof frame.outcomeDetail === "string" ? frame.outcomeDetail : null,
			causes: strings(causes.map((cause) => (isRecord(cause) ? cause.code : undefined))),
			checks: checks.flatMap((check) =>
				isRecord(check) && typeof check.command === "string" && typeof check.status === "string"
					? [{ command: check.command, status: check.status }]
					: [],
			),
		},
	};
}

/** The desk's final status from what `extensions run <extension> <command> --json` answered. */
export function readProbe(probe: CampaignProbe, result: ExtensionRunCommandResult): CampaignProbeResult {
	const base = { extension: probe.extension, command: probe.command };
	if (result.exitCode !== 0)
		return {
			...base,
			exitCode: result.exitCode,
			text: null,
			data: null,
			error: result.error ?? stderrTail(result.stderrTail) ?? "probe failed",
		};
	try {
		const parsed = JSON.parse(result.stdout.trim()) as { output?: { text?: unknown; data?: unknown } };
		const text = typeof parsed.output?.text === "string" ? parsed.output.text.trim().slice(0, PROBE_TEXT_MAX) : null;
		return { ...base, exitCode: 0, text, data: parsed.output?.data ?? null, error: null };
	} catch (error) {
		return { ...base, exitCode: 0, text: null, data: null, error: `unreadable --json result: ${errorText(error)}` };
	}
}

/** Copies the fixture whole. The sandbox masks a secret file as a device, which is copied as an empty file. */
export function copyFixture(fixture: string, project: string): void {
	const masked: string[] = [];
	cpSync(fixture, project, {
		recursive: true,
		filter: (source, destination) => {
			const stat = lstatSync(source);
			if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) return true;
			masked.push(destination);
			return false;
		},
	});
	for (const destination of masked) writeFileSync(destination, "");
}

/** Write `entry.json` whole, so a reader never sees half of it. */
function saveEntry(result: CampaignEntryResult): void {
	const path = join(result.dir, "entry.json");
	writeFileSync(`${path}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

/** Page the run's stream-json frames into `path` as they come, then its end; stopping the campaign cancels it. */
async function followRun(runs: ExtensionRuns, id: string, path: string, signal: AbortSignal): Promise<ExtensionRunEnd> {
	const cancel = (): void => void runs.cancel(id).catch(() => undefined);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const fd = openSync(path, "w");
	try {
		let cursor = 0;
		for (;;) {
			const page = await runs.frames(id, { cursor, limit: FRAME_PAGE, waitMs: FRAME_WAIT_MS });
			for (const frame of page.frames) writeSync(fd, `${JSON.stringify(frame)}\n`);
			cursor = page.next;
			if (page.done) break;
		}
	} finally {
		closeSync(fd);
		signal.removeEventListener("abort", cancel);
	}
	return runs.wait(id);
}

async function runEntry(
	runs: ExtensionRuns,
	signal: AbortSignal,
	input: CampaignInput,
	entry: RosterEntry,
	index: number,
	repetition: number,
): Promise<CampaignEntryResult> {
	const dir = join(input.out, entryDirName(index, entry.label, repetition, input.repeat));
	const project = join(dir, "project");
	const home = join(dir, "home");
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
		metrics: emptyDigest(),
		completion: null,
		verification: null,
		desk: null,
		error: null,
	};
	mkdirSync(dir, { recursive: true });
	if (signal.aborted) {
		result.error = "canceled before it started";
		saveEntry(result);
		return result;
	}
	try {
		copyFixture(input.fixture, project);
		mkdirSync(home, { mode: 0o700 });
		result.startedAt = new Date().toISOString();
		const started = Date.now();
		const { id } = await runs.start({
			prompt: input.prompt,
			target: entry.target,
			model: entry.model,
			...(entry.thinking !== null ? { thinking: entry.thinking } : {}),
			cwd: { path: project },
			home,
			autonomy: input.autonomy,
			answers: input.answers,
			timeoutSeconds: input.timeoutSeconds,
		});
		const end = await followRun(runs, id, join(dir, "run.stdout.log"), signal);
		result.wallMs = Date.now() - started;
		writeFileSync(join(dir, "run.stderr.log"), end.stderrTail);
		result.exitCode = end.exitCode;
		result.status = statusOf(end, signal.aborted);
		if (result.status !== "completed") result.error = end.error ?? stderrTail(end.stderrTail);
		Object.assign(result, readRunEnd(end.end));
		try {
			result.metrics = await runs.digest(id);
		} catch (error) {
			result.error = result.error ?? `metrics: ${errorText(error)}`;
		}
		if (input.probe !== null && result.status !== "canceled") {
			try {
				const answer = await runs.command({
					extension: input.probe.extension,
					command: input.probe.command,
					cwd: { path: project },
					home,
					timeoutSeconds: PROBE_TIMEOUT_SECONDS,
				});
				result.desk = readProbe(input.probe, answer);
			} catch (error) {
				result.desk = { ...input.probe, exitCode: null, text: null, data: null, error: errorText(error) };
			}
		}
	} catch (error) {
		result.status = "error";
		result.error = errorText(error);
	}
	saveEntry(result);
	return result;
}

/**
 * Run one fixture across a roster, one entry at a time so wall times do not contend, and the whole roster `repeat`
 * times, one pass after another, so a route's variance shows across passes. Each entry gets a fresh copy of the
 * fixture and its own run home, runs headless through the runs service, and is folded from what that run persisted.
 * An entry that fails, times out or cannot start is recorded and the campaign moves on; a stop cancels the running
 * entry and the rest.
 */
export async function runCampaign(
	runs: ExtensionRuns,
	signal: AbortSignal,
	input: CampaignInput,
	onProgress: (line: string) => void,
): Promise<CampaignResult> {
	mkdirSync(input.out, { recursive: true });
	const startedAt = new Date().toISOString();
	const entries: CampaignEntryResult[] = [];
	for (let repetition = 0; repetition < input.repeat; repetition++) {
		const pass = input.repeat > 1 ? `pass ${repetition + 1}/${input.repeat} ` : "";
		for (const [index, entry] of input.roster.entries()) {
			const lead = `${pass}entry ${index + 1}/${input.roster.length} ${entry.label}`;
			onProgress(`${lead}: running`);
			const result = await runEntry(runs, signal, input, entry, index, repetition);
			const seconds = result.wallMs === null ? "" : ` in ${(result.wallMs / 1000).toFixed(1)}s`;
			onProgress(`${lead}: ${result.status}${seconds}`);
			entries.push(result);
		}
	}
	return {
		schemaVersion: CAMPAIGN_SCHEMA_VERSION,
		fixture: input.fixture,
		answers: input.answersFile,
		prompt: input.prompt,
		out: input.out,
		timeoutSeconds: input.timeoutSeconds,
		repeat: input.repeat,
		autonomy: input.autonomy,
		startedAt,
		completedAt: new Date().toISOString(),
		canceled: signal.aborted,
		entries,
	};
}

function runsOf(ctx: ExtensionContextV2): ExtensionRuns {
	if (ctx.runs === undefined) throw new Error("this host did not provide the runs service");
	return ctx.runs;
}

/**
 * The host side of `pancode campaign`: the paths the operator named on its command line, the host's YAML parser, and
 * the runs service, which starts each entry in its fixture copy with its own home and folds what it persisted.
 */
export function campaignHost(ctx: ExtensionContextV2): CampaignHost {
	return {
		path(flag) {
			const grant = ctx.paths?.find((entry) => entry.flag === flag);
			if (grant === undefined)
				throw new CampaignUsageError(
					`${flag} names a path only as \`pancode campaign\` grants it; run \`pancode campaign run\` from a shell`,
				);
			return grant.path;
		},
		readText: (file) => readFileSync(file, "utf8"),
		async yaml(text) {
			if (ctx.yaml === undefined) throw new Error("this host parses no YAML for extensions");
			return ctx.yaml(text);
		},
		answersRefusal: (text) => runsOf(ctx).refusal({ answers: text }),
		yoloRefusal: () => runsOf(ctx).refusal({ autonomy: "yolo" }),
		run: (input) =>
			runCampaign(runsOf(ctx), ctx.signal, input, (line) => {
				ctx.progress?.(line);
			}),
		interrupted: () => ctx.signal.aborted,
	};
}
