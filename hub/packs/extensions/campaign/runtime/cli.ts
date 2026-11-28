import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { RosterError, readRoster } from "./roster.ts";
import type {
	CampaignAutonomy,
	CampaignEntryResult,
	CampaignEntryStatus,
	CampaignInput,
	CampaignProbe,
	CampaignResult,
} from "./types.ts";

export const HELP = `Usage:
  pancode campaign run --fixture <dir> --roster <roster.yaml> --answers <answers.yaml> --prompt <text> --out <dir>
                          [--repeat <N>] [--timeout <seconds>] [--probe <extension>:<command>]
                          [--autonomy default|yolo] [--json] [--exit-code]

Runs one seeded project across a roster of models and reports, per entry: how
the run ended, the extension gates it reached, extension refusals, loop-guard
blocks, input tokens fresh and cached, output tokens, wall time, and the run's
completion (its finish claim, the host's assessment and the facts that lowered
it) and verification (outcome and cause codes).

The roster file is a mapping with one key, roster: a list of entries, each with
target, model, an optional thinking level and an optional label (default
<target>/<model>[@<thinking>]); labels must be unique. The answers file is a
\`pancode run --answers\` file and is validated before anything starts; a fixture
that asks no questions takes \`answers: []\`.

Entries run one at a time, and --repeat N runs the whole roster N times, one
pass after another; each run is its own entry with its pass in entry.json
(repetition, from 0) and, when N > 1, in its directory (<NN-label>-r<K>). Each
entry gets a fresh copy of the fixture and its own
empty PanCode data, state and cache under --out, so entries share no sessions
or memory. Each uses your config directory as it is (targets, credentials,
installed extensions), as your own \`pancode run\` would: nothing secret is
copied under --out, and a login an entry refreshes is saved to your credential
store. Each also reads the runtime components you installed with
\`pancode tools install\` (copilot-sdk, claude-sdk) from your data directory,
and never installs or writes one there. Each runs headless
\`pancode run --answers\` in its fixture copy; run.stdout.log keeps the run's
stream-json frames, whose run_end gives the entry its completion and
verification, and run.stderr.log the last 4 KiB of its stderr.

Metrics come from what the run persisted: its session ledger (extension
interviews and the checkpoint ids they asked, extension tool refusals), its
journal (extension block_tool hooks, loop-guard blocks) and the token
attribution of \`telemetry tokens\` (provider-measured totals). --probe runs
\`pancode extensions run <extension> <command> --json\` in the copy after the
run and records its result as the desk's final status.

Status per entry: completed (exit 0), unscripted (exit 5: a question the
answers file does not script), timed-out (--timeout), failed (any other exit),
canceled, or error (the entry could not be set up or launched). A failing entry
is reported and the campaign continues.

options:
  --fixture <dir>          the project every entry starts from; copied, never written
  --roster <file>          the roster YAML
  --answers <file>         the run --answers file every entry uses
  --prompt <text>          the task every entry is given
  --out <dir>              absent or empty directory for the copies, homes, logs and <NN-label>/entry.json
  --repeat <N>             run the whole roster N times (default: 1)
  --timeout <seconds>      each entry's run --timeout (default and most: 86400)
  --probe <ext>:<command>  extension command recorded as the desk's final status
  --autonomy default|yolo  every entry's autonomy (default: default); yolo is contained
  --json                   print the whole campaign as JSON
  --exit-code              exit 1 unless every entry completed

Exit codes: 0 when every entry was run (whatever each one's status), 1 when the
campaign itself failed, 2 on a usage error, and the signal's code when stopped.
With --exit-code a finished campaign exits 0 only when every entry completed,
and 1 when some or all did not. The --json document carries completion.state
and verdict.aggregate (pass: every entry completed, fail: none did, else
partial) with each entry's status.`;

/** The longest run the manifest's `runs.maxTimeoutSeconds` allows, and so each entry's timeout by default. */
export const MAX_TIMEOUT_SECONDS = 86_400;

export class CampaignUsageError extends Error {}

/** The host side of the command: the paths the operator named, file reads, the host's checks, and the campaign. */
export interface CampaignHost {
	/** The absolute path the operator granted for `flag`, as given; throws CampaignUsageError when none was granted. */
	path(flag: string): string;
	readText(file: string): string;
	yaml(text: string): Promise<unknown>;
	/** Why the runs service refuses this answers text, null when it takes it. */
	answersRefusal(text: string): Promise<string | null>;
	/** Null when contained yolo can run here, else why not. */
	yoloRefusal(): Promise<string | null>;
	run(input: CampaignInput): Promise<CampaignResult>;
	/** True once the operator asked to stop; the document is still printed. */
	interrupted(): boolean;
}

export interface CampaignCliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const VALUE_FLAGS = new Set([
	"--fixture",
	"--roster",
	"--answers",
	"--prompt",
	"--out",
	"--repeat",
	"--timeout",
	"--probe",
	"--autonomy",
]);

interface Parsed {
	values: Map<string, string>;
	json: boolean;
	exitCode: boolean;
}

/** A value flag's value is always the next argument, even one that starts with `--`. */
export function parseRunArgs(args: ReadonlyArray<string>): Parsed {
	const parsed: Parsed = { values: new Map(), json: false, exitCode: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--exit-code") {
			parsed.exitCode = true;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			const value = args[i + 1];
			if (value === undefined) throw new CampaignUsageError(`${arg} needs a value`);
			if (parsed.values.has(arg)) throw new CampaignUsageError(`${arg} given more than once`);
			parsed.values.set(arg, value);
			i++;
			continue;
		}
		throw new CampaignUsageError(arg.startsWith("-") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
	}
	return parsed;
}

function required(parsed: Parsed, flag: string): string {
	const value = parsed.values.get(flag);
	if (value === undefined || value.trim().length === 0) throw new CampaignUsageError(`campaign run needs ${flag}`);
	return value;
}

function probeOf(value: string | undefined): CampaignProbe | null {
	if (value === undefined) return null;
	const colon = value.indexOf(":");
	if (colon <= 0 || colon === value.length - 1)
		throw new CampaignUsageError(`--probe takes <extension>:<command>, got '${value}'`);
	return { extension: value.slice(0, colon), command: value.slice(colon + 1) };
}

function timeoutOf(value: string | undefined): number {
	if (value === undefined) return MAX_TIMEOUT_SECONDS;
	const seconds = Number(value);
	if (!Number.isInteger(seconds) || seconds <= 0)
		throw new CampaignUsageError("--timeout takes a positive whole number of seconds");
	if (seconds > MAX_TIMEOUT_SECONDS)
		throw new CampaignUsageError(`--timeout takes at most ${MAX_TIMEOUT_SECONDS} seconds`);
	return seconds;
}

function repeatOf(value: string | undefined): number {
	if (value === undefined) return 1;
	const times = Number(value);
	if (!Number.isInteger(times) || times <= 0) throw new CampaignUsageError("--repeat takes a positive whole number");
	return times;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function physical(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}

function isSameOrInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The fixture must exist, and `--out` must be absent or empty and outside it, since the fixture is copied whole. */
export function validateCampaignPaths(fixture: string, out: string, prompt: string): void {
	if (prompt.trim().length === 0) throw new CampaignUsageError("campaign run needs a non-empty --prompt");
	const fixtureStat = statSync(fixture, { throwIfNoEntry: false });
	if (fixtureStat === undefined) throw new CampaignUsageError(`--fixture ${fixture} does not exist`);
	if (!fixtureStat.isDirectory()) throw new CampaignUsageError(`--fixture ${fixture} is not a directory`);
	if (isSameOrInside(out, fixture) || isSameOrInside(physical(out), physical(fixture)))
		throw new CampaignUsageError(`--out ${out} is inside the fixture; the fixture is copied whole`);
	if (existsSync(out) && readdirSync(out).length > 0)
		throw new CampaignUsageError(`--out ${out} already holds files; name an absent or empty directory`);
}

async function campaignInput(parsed: Parsed, host: CampaignHost): Promise<CampaignInput> {
	required(parsed, "--fixture");
	required(parsed, "--out");
	const prompt = required(parsed, "--prompt");
	required(parsed, "--roster");
	required(parsed, "--answers");
	const timeoutSeconds = timeoutOf(parsed.values.get("--timeout"));
	const repeat = repeatOf(parsed.values.get("--repeat"));
	const probe = probeOf(parsed.values.get("--probe"));
	const autonomy = parsed.values.get("--autonomy") ?? "default";
	if (autonomy !== "default" && autonomy !== "yolo") throw new CampaignUsageError("--autonomy takes default or yolo");
	const fixture = host.path("--fixture");
	const out = host.path("--out");
	const rosterFile = host.path("--roster");
	const answersFile = host.path("--answers");
	let roster: CampaignInput["roster"];
	try {
		roster = await readRoster(host.readText(rosterFile), (text) => host.yaml(text));
	} catch (error) {
		if (error instanceof RosterError) throw new CampaignUsageError(`--roster ${rosterFile}: ${error.message}`);
		throw new CampaignUsageError(`--roster ${rosterFile}: cannot read the file: ${errorText(error)}`);
	}
	let answers: string;
	try {
		answers = host.readText(answersFile);
	} catch (error) {
		throw new CampaignUsageError(`--answers ${answersFile}: cannot read the file: ${errorText(error)}`);
	}
	const refusal = await host.answersRefusal(answers);
	if (refusal !== null) throw new CampaignUsageError(`--answers ${answersFile}: ${refusal}`);
	validateCampaignPaths(fixture, out, prompt);
	if (autonomy === "yolo") {
		const yolo = await host.yoloRefusal();
		if (yolo !== null) throw new CampaignUsageError(yolo);
	}
	return {
		fixture,
		roster,
		answersFile,
		answers,
		prompt,
		out,
		repeat,
		timeoutSeconds,
		autonomy: autonomy as CampaignAutonomy,
		probe,
	};
}

/** The `formatColumns` layout of PanCode's own tables: columns padded to the widest cell, two spaces apart. */
export function formatColumns(rows: ReadonlyArray<ReadonlyArray<string>>, gap = 2): string {
	if (rows.length === 0) return "";
	const widths: number[] = [];
	for (const row of rows) for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
	const line = (row: ReadonlyArray<string>): string =>
		row
			.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? cell.length) + gap)))
			.join("")
			.trimEnd();
	return `${rows.map(line).join("\n")}\n`;
}

const count = (value: number | null | undefined): string =>
	value === null || value === undefined ? "-" : String(value);

function deskCell(entry: CampaignEntryResult): string {
	if (entry.desk === null) return "-";
	const line = entry.desk.error !== null ? `probe error: ${entry.desk.error}` : (entry.desk.text ?? "");
	const first = line.split("\n")[0] ?? "";
	return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

/** The label a row shows: with --repeat, the pass is part of it, since one label then names several runs. */
function entryName(result: CampaignResult, entry: CampaignEntryResult): string {
	return result.repeat > 1 ? `${entry.label} r${entry.repetition + 1}` : entry.label;
}

function completionCell(entry: CampaignEntryResult): string {
	const completion = entry.completion;
	if (completion === null) return "-";
	return completion.claimed === completion.assessed
		? completion.assessed
		: `${completion.claimed ?? "none"}>${completion.assessed}`;
}

export function renderCampaign(result: CampaignResult): string {
	const rows = [
		[
			"ENTRY",
			"STATUS",
			"EXIT",
			"DONE",
			"GATES",
			"REFUSALS h/t",
			"LOOP",
			"INPUT",
			"FRESH",
			"CACHED",
			"OUTPUT",
			"WALL",
			"DESK",
		],
		...result.entries.map((entry) => {
			const { metrics } = entry;
			return [
				entryName(result, entry),
				entry.status,
				count(entry.exitCode),
				completionCell(entry),
				String(metrics.gates.reached.length),
				`${metrics.refusals.hookBlocks}/${metrics.refusals.toolRefusals}`,
				String(metrics.loopGuardBlocks),
				count(metrics.tokens?.input),
				count(metrics.tokens?.fresh),
				count(metrics.tokens?.cached),
				count(metrics.tokens?.output),
				entry.wallMs === null ? "-" : `${(entry.wallMs / 1000).toFixed(1)}s`,
				deskCell(entry),
			];
		}),
	];
	const notes = result.entries.flatMap((entry) => {
		const lines: string[] = [];
		const name = entryName(result, entry);
		if (entry.metrics.gates.reached.length > 0) lines.push(`${name}: gates ${entry.metrics.gates.reached.join(", ")}`);
		const facts = entry.completion?.facts ?? [];
		if (facts.length > 0) lines.push(`${name}: completion facts ${facts.join(", ")}`);
		const unsplit = entry.metrics.tokens?.unsplitCalls;
		if (unsplit) lines.push(`${name}: ${unsplit} call(s) without a cache split, in INPUT only`);
		if (entry.error !== null) lines.push(`${name}: ${entry.error.split("\n").join(" / ")}`);
		return lines;
	});
	return `${formatColumns(rows)}${notes.length > 0 ? `\n${notes.join("\n")}\n` : ""}\nentries and logs under ${result.out}\n`;
}

type CampaignAggregate = "pass" | "partial" | "fail";

/** Pass when every entry completed, fail when none did, partial otherwise. */
export function campaignVerdict(result: CampaignResult): {
	aggregate: CampaignAggregate;
	entries: Array<{ label: string; repetition: number; status: CampaignEntryStatus }>;
} {
	const passed = result.entries.filter((entry) => entry.status === "completed").length;
	const aggregate: CampaignAggregate = passed === 0 ? "fail" : passed === result.entries.length ? "pass" : "partial";
	return {
		aggregate,
		entries: result.entries.map((entry) => ({ label: entry.label, repetition: entry.repetition, status: entry.status })),
	};
}

async function runCommand(args: ReadonlyArray<string>, host: CampaignHost): Promise<CampaignCliResult> {
	const parsed = parseRunArgs(args);
	const input = await campaignInput(parsed, host);
	const result = await host.run(input);
	const verdict = campaignVerdict(result);
	// completion says whether the batch ran to its end; verdict says how its entries fared. Only --exit-code lets the
	// verdict reach the exit code.
	const completion = result.canceled
		? { state: "stopped" as const, stopReason: "signal" as const }
		: { state: "completed" as const, stopReason: null };
	const stdout = parsed.json
		? `${JSON.stringify({ ...result, completion, verdict }, null, 2)}\n`
		: renderCampaign(result);
	const exitCode = host.interrupted() ? 1 : parsed.exitCode && verdict.aggregate !== "pass" ? 1 : 0;
	return { stdout, stderr: "", exitCode };
}

/** `pancode campaign ...`: the answer, its diagnostics and its exit code. The host is built only for a run. */
export async function runCampaignCli(
	args: ReadonlyArray<string>,
	host: () => CampaignHost,
): Promise<CampaignCliResult> {
	const [verb, ...rest] = args;
	if (verb === undefined || args.includes("--help") || args.includes("-h"))
		return { stdout: `${HELP}\n`, stderr: "", exitCode: 0 };
	try {
		if (verb !== "run") throw new CampaignUsageError(`unknown campaign command: ${verb}`);
		return await runCommand(rest, host());
	} catch (error) {
		if (error instanceof CampaignUsageError)
			return {
				stdout: "",
				stderr: `error: campaign: ${error.message}\n  see pancode campaign --help\n`,
				exitCode: 2,
			};
		return { stdout: "", stderr: `error: campaign: ${errorText(error)}\n`, exitCode: 1 };
	}
}
