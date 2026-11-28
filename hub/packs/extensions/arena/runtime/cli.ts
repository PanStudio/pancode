import { isArenaChoice } from "./blind.ts";
import { formatColumns } from "./render.ts";
import { computeStandings } from "./standings.ts";
import { ArenaVoteError, isArenaMatchId, listMatches, readMatch, readVote, recordVote } from "./store.ts";
import {
	ARENA_MAX_CONTENDERS,
	ARENA_MIN_CONTENDERS,
	type ArenaAutonomy,
	type ArenaContenderSpec,
	type ArenaMatch,
} from "./types.ts";
import { type ArenaMatchView, ArenaRevealRefused, arenaMatchView, fitArenaView } from "./view.ts";

export const HELP = `Usage:
  pancode arena run --contender <target>/<model> --contender <target>/<model> [...] [options] <prompt>
  pancode arena show <match-id> [--reveal] [--json]
  pancode arena vote <match-id> A|B|C|D|tie|both-bad [--note <text>] [--replace] [--json]
  pancode arena list [--suite <name>] [--json]
  pancode arena standings [--suite <name>] [--json]

Runs one prompt on 2 to ${ARENA_MAX_CONTENDERS} contenders side by side, shows
their work under blind labels, and records which one you preferred. PanCode
records results and never judges: no model grades a contender, and standings
come from your votes.

run options:
  --contender <target>/<model>  a contender; split at the first "/", repeat 2 to ${ARENA_MAX_CONTENDERS} times
  --cwd <dir>                   project to run in (default: current directory)
  --timeout <seconds>           each contender's run --timeout (default 600, at most 86400)
  --max-cost-usd <N>            each contender's run --max-cost-usd (default and at most 1000);
                                unpriced routes are not bounded
  --check <verifier-id>         dry-run this verifier in each contender's worktree when it finishes
  --suite <name>                tag the match; list and standings can filter on it
  --seed <n>                    seed for the blind order (default random, stored with the match)
  --read-only                   run contenders read-only even inside a Git repository
  --autonomy default|yolo       every contender's autonomy (default: default); yolo is contained
  --json                        print the blind match view as JSON

Inside a Git repository every contender works in its own worktree from HEAD,
so uncommitted changes are not part of the baseline; each leaves a diff and the
worktrees are removed afterwards. Outside Git the contenders run read-only.

At --autonomy yolo every contender runs contained yolo: the OS sandbox, the
safety judge and your autonomous caps stay on, and a call that would need you
is refused back to the contender. The match records the autonomy, and each
contender's facts count what paused it and the calls it left open, like its
blocks. Unconfined yolo is refused here.

show hides who each contender is, along with duration, tokens and cost, until
the match has a vote; --reveal before voting is refused. vote records one
choice per match, and --replace changes it; every vote stays in the journal.
standings counts wins, losses, ties and both-bad per target/model, and shows an
Elo rating once an identity has 5 or more votes.

Matches live under <project>/.pancode/data/arena/<match-id>/.`;

/** What a match run takes from the command line; the runner adds the place and the host services. */
export interface ArenaRunRequest {
	prompt: string;
	contenders: ArenaContenderSpec[];
	seed?: number;
	suite: string | null;
	timeoutSeconds: number;
	maxCostUsd: number | null;
	check: string | null;
	readOnly: boolean;
	autonomy: ArenaAutonomy;
}

/** The host side of the command: where matches live and how a match runs. */
export interface ArenaHost {
	/** The project's match directory. */
	root: string;
	/** Null when contained yolo can run here, else why not. */
	yoloRefusal(): Promise<string | null>;
	/** Run one match; a usage problem found before it starts throws ArenaUsageError, a refusal ArenaCommandError. */
	run(request: ArenaRunRequest): Promise<ArenaMatch>;
	/** True once the operator asked to stop; the answer is still printed. */
	interrupted?(): boolean;
}

export interface ArenaCliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

type Slug = "usage" | "unknown_flag" | "unknown_command";

export class ArenaUsageError extends Error {
	readonly slug: Slug;
	constructor(message: string, slug: Slug = "usage") {
		super(message);
		this.slug = slug;
	}
}

/** A failure the command reports as `error: <message>` with exit 1. */
export class ArenaCommandError extends Error {}

/** The run ceilings the manifest declares for `runtime.services.runs`. */
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_COST_USD = 1000;

interface Parsed {
	positional: string[];
	values: Map<string, string[]>;
	flags: Set<string>;
}

const VALUE_FLAGS = new Set([
	"--contender",
	"--cwd",
	"--timeout",
	"--max-cost-usd",
	"--check",
	"--suite",
	"--seed",
	"--note",
	"--autonomy",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--reveal", "--replace", "--read-only"]);
const VERBS = ["run", "show", "vote", "list", "standings"];

export function parse(
	args: ReadonlyArray<string>,
	allowedValues: ReadonlyArray<string>,
	allowedFlags: ReadonlyArray<string>,
): Parsed {
	const parsed: Parsed = { positional: [], values: new Map(), flags: new Set() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			parsed.positional.push(...args.slice(i + 1));
			break;
		}
		// `--flag value` or `--flag=value`, and a value flag never takes the next flag as its value.
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equals === -1 ? arg : arg.slice(0, equals);
		if (VALUE_FLAGS.has(name) && allowedValues.includes(name)) {
			let value: string | undefined;
			if (equals !== -1) value = arg.slice(equals + 1);
			else {
				value = args[i + 1];
				if (value === undefined || value.startsWith("--")) throw new ArenaUsageError(`${name} requires a value`);
				i++;
			}
			parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
			continue;
		}
		if (BOOLEAN_FLAGS.has(arg) && allowedFlags.includes(arg)) {
			parsed.flags.add(arg);
			continue;
		}
		if (arg.startsWith("-")) throw new ArenaUsageError(`unknown flag: ${name}`, "unknown_flag");
		parsed.positional.push(arg);
	}
	return parsed;
}

function single(parsed: Parsed, flag: string): string | undefined {
	const values = parsed.values.get(flag);
	if (values !== undefined && values.length > 1) throw new ArenaUsageError(`${flag} given more than once`);
	return values?.[0];
}

function contenderSpec(value: string): ArenaContenderSpec {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new ArenaUsageError(`--contender takes <target>/<model>, got '${value}'`);
	}
	return { target: value.slice(0, slash), model: value.slice(slash + 1) };
}

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new ArenaUsageError(`${flag} takes a positive whole number`);
	return parsed;
}

function matchIdArg(parsed: Parsed, verb: string): string {
	const id = parsed.positional[0];
	if (id === undefined) throw new ArenaUsageError(`arena ${verb} needs a match id`);
	if (!isArenaMatchId(id)) throw new ArenaUsageError(`'${id}' is not an arena match id`);
	return id;
}

function indent(text: string, maxLines: number): string {
	const lines = text.split("\n");
	const shown = lines.slice(0, maxLines).map((line) => `    ${line}`);
	if (lines.length > maxLines) shown.push(`    ... ${lines.length - maxLines} more lines (--json has all)`);
	return shown.join("\n");
}

export function renderView(view: ArenaMatchView): string {
	const out: string[] = [];
	out.push(
		`match ${view.id}  ${view.status}  ${view.isolation}${view.autonomy === "yolo" ? "  autonomy yolo (contained)" : ""}${view.suite ? `  suite ${view.suite}` : ""}`,
	);
	out.push(`prompt: ${view.prompt}`);
	if (view.error) out.push(`error: ${view.error}`);
	if (view.vote)
		out.push(`vote: ${view.vote.choice}${view.vote.note ? ` (${view.vote.note})` : ""}  at ${view.vote.votedAt}`);
	else if (view.status === "complete") {
		const labels = view.entries.map((entry) => entry.label).join("|");
		out.push(`blind: vote with pancode arena vote ${view.id} ${labels}|tie|both-bad`);
	}
	for (const entry of view.entries) {
		out.push("");
		const stat = entry.diffStat
			? `diff ${entry.diffStat.files} file(s) +${entry.diffStat.insertions} -${entry.diffStat.deletions}`
			: "no diff";
		out.push(
			`── ${entry.label} ── ${entry.status}  exit ${entry.exitCode ?? "?"}${entry.timedOut ? " (timed out)" : ""}  turns ${entry.turns ?? "?"}  tools ${entry.toolCalls ?? "?"} (${entry.toolErrors ?? "?"} errors)  writes ${entry.writes ?? "?"}  blocks ${entry.blocks ?? "?"}${entry.yolo !== null ? `  open decisions ${entry.yolo.openDecisions}${entry.yolo.paused !== null ? ` (yolo paused: ${entry.yolo.paused})` : ""}` : ""}  ${stat}`,
		);
		if (entry.reveal) {
			const seconds = entry.reveal.durationMs === null ? "?" : `${(entry.reveal.durationMs / 1000).toFixed(1)}s`;
			out.push(
				`   ${entry.label} = ${entry.reveal.target}/${entry.reveal.model}  ${seconds}  tokens ${entry.reveal.tokens}  cost ${entry.reveal.cost}${entry.reveal.sessionId ? `  session ${entry.reveal.sessionId}` : ""}`,
			);
		}
		if (entry.check) {
			out.push(`   check ${entry.check.id}: exit ${entry.check.exitCode ?? "?"}`);
			out.push(indent(entry.check.tail.split("\n").slice(-3).join("\n"), 3));
		}
		if (entry.error) out.push(`   error: ${entry.error}`);
		out.push("   final:");
		out.push(indent(entry.finalText.length > 0 ? entry.finalText : "(no final text)", 30));
		if (entry.diff !== null && entry.diff.length > 0) {
			out.push("   diff:");
			out.push(indent(entry.diff.trimEnd(), 60));
		}
	}
	return `${out.join("\n")}\n`;
}

/** A match view as the command prints it, cut to fit what a command may answer. */
function answer(view: ArenaMatchView, json: boolean): string {
	return fitArenaView(view, (fitted) => (json ? `${JSON.stringify(fitted)}\n` : renderView(fitted)));
}

class Out {
	stdout = "";
	stderr = "";
	write(text: string): void {
		this.stdout += text;
	}
	error(message: string): void {
		this.stderr += `error: ${message}\n`;
	}
}

export function validateRunShape(contenders: ArenaContenderSpec[], prompt: string): void {
	if (prompt.trim().length === 0) throw new ArenaUsageError("arena run needs a prompt");
	const count = contenders.length;
	if (count < ARENA_MIN_CONTENDERS || count > ARENA_MAX_CONTENDERS) {
		throw new ArenaUsageError(
			`arena run takes ${ARENA_MIN_CONTENDERS} to ${ARENA_MAX_CONTENDERS} contenders, got ${count}`,
		);
	}
}

async function runCommand(args: string[], host: ArenaHost, out: Out): Promise<number> {
	const parsed = parse(
		args,
		["--contender", "--cwd", "--timeout", "--max-cost-usd", "--check", "--suite", "--seed", "--autonomy"],
		["--json", "--read-only"],
	);
	const contenders = (parsed.values.get("--contender") ?? []).map(contenderSpec);
	const prompt = parsed.positional.join(" ");
	const timeoutSeconds = positiveInteger("--timeout", single(parsed, "--timeout"), 600);
	if (timeoutSeconds > MAX_TIMEOUT_SECONDS)
		throw new ArenaUsageError(`--timeout takes at most ${MAX_TIMEOUT_SECONDS} seconds`);
	const costText = single(parsed, "--max-cost-usd");
	const maxCostUsd = costText === undefined ? null : Number(costText);
	if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
		throw new ArenaUsageError("--max-cost-usd takes a positive number");
	}
	if (maxCostUsd !== null && maxCostUsd > MAX_COST_USD)
		throw new ArenaUsageError(`--max-cost-usd takes at most ${MAX_COST_USD}`);
	const seedText = single(parsed, "--seed");
	const seed = seedText === undefined ? undefined : Number(seedText);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
		throw new ArenaUsageError("--seed takes a whole number from 0 to 4294967295");
	}
	const autonomy = single(parsed, "--autonomy") ?? "default";
	if (autonomy !== "default" && autonomy !== "yolo") throw new ArenaUsageError("--autonomy takes default or yolo");
	validateRunShape(contenders, prompt);
	if (autonomy === "yolo") {
		const refusal = await host.yoloRefusal();
		if (refusal !== null) throw new ArenaUsageError(refusal);
	}
	const json = parsed.flags.has("--json");
	const match = await host.run({
		prompt,
		contenders,
		...(seed !== undefined ? { seed } : {}),
		suite: single(parsed, "--suite") ?? null,
		timeoutSeconds,
		maxCostUsd,
		check: single(parsed, "--check") ?? null,
		readOnly: parsed.flags.has("--read-only"),
		autonomy,
	});
	out.write(answer(arenaMatchView(host.root, match, null), json));
	if (host.interrupted?.() === true) return 1;
	return match.status === "complete" ? 0 : 1;
}

function showCommand(args: string[], host: ArenaHost, out: Out): number {
	const parsed = parse(args, ["--cwd"], ["--json", "--reveal"]);
	const id = matchIdArg(parsed, "show");
	const match = readMatch(host.root, id);
	if (match === null) {
		out.error(`no arena match ${id} under ${host.root}`);
		return 1;
	}
	try {
		const view = arenaMatchView(host.root, match, readVote(host.root, id), { reveal: parsed.flags.has("--reveal") });
		out.write(answer(view, parsed.flags.has("--json")));
		return 0;
	} catch (error) {
		if (error instanceof ArenaRevealRefused) {
			out.error(error.message);
			return 1;
		}
		throw error;
	}
}

async function voteCommand(args: string[], host: ArenaHost, out: Out): Promise<number> {
	const parsed = parse(args, ["--cwd", "--note"], ["--json", "--replace"]);
	const id = matchIdArg(parsed, "vote");
	const choice = parsed.positional[1];
	if (choice === undefined || !isArenaChoice(choice) || parsed.positional.length > 2) {
		throw new ArenaUsageError("arena vote takes one choice: A, B, C, D, tie or both-bad");
	}
	try {
		const vote = await recordVote(host.root, id, {
			choice,
			note: single(parsed, "--note") ?? null,
			replace: parsed.flags.has("--replace"),
		});
		if (parsed.flags.has("--json")) out.write(`${JSON.stringify(vote)}\n`);
		else
			out.write(
				`recorded ${vote.choice} for match ${id}${vote.replaced ? " (replaced the earlier vote)" : ""}; arena show ${id} reveals who is who\n`,
			);
		return 0;
	} catch (error) {
		if (error instanceof ArenaVoteError) {
			out.error(error.message);
			return 1;
		}
		throw error;
	}
}

function listCommand(args: string[], host: ArenaHost, out: Out): number {
	const parsed = parse(args, ["--cwd", "--suite"], ["--json"]);
	if (parsed.positional.length > 0) throw new ArenaUsageError(`unexpected argument: ${parsed.positional[0]}`);
	const suite = single(parsed, "--suite");
	const entries = listMatches(host.root).filter(({ match }) => suite === undefined || match.suite === suite);
	// Identities appear only for voted matches, so the list never unblinds a pending one.
	const rows = entries.map(({ match, vote }) => ({
		id: match.id,
		createdAt: match.createdAt,
		status: match.status,
		suite: match.suite,
		prompt: match.prompt,
		contenders: match.contenders.length,
		vote: vote?.choice ?? null,
		identities: vote === null ? null : match.contenders.map((c) => `${c.target}/${c.model}`),
	}));
	if (parsed.flags.has("--json")) {
		out.write(`${JSON.stringify({ matches: rows })}\n`);
		return 0;
	}
	if (rows.length === 0) {
		out.write("no arena matches yet; start one with pancode arena run\n");
		return 0;
	}
	const table = [
		["MATCH", "STATUS", "N", "VOTE", "SUITE", "PROMPT"],
		...rows.map((row) => [
			row.id,
			row.status,
			String(row.contenders),
			row.vote ?? "-",
			row.suite ?? "-",
			row.prompt.length > 60 ? `${row.prompt.slice(0, 57)}...` : row.prompt,
		]),
	];
	out.write(`${formatColumns(table)}\n`);
	return 0;
}

function standingsCommand(args: string[], host: ArenaHost, out: Out): number {
	const parsed = parse(args, ["--cwd", "--suite"], ["--json"]);
	if (parsed.positional.length > 0) throw new ArenaUsageError(`unexpected argument: ${parsed.positional[0]}`);
	const standings = computeStandings(listMatches(host.root), single(parsed, "--suite") ?? null);
	if (parsed.flags.has("--json")) {
		out.write(`${JSON.stringify(standings)}\n`);
		return 0;
	}
	if (standings.standings.length === 0) {
		out.write(`no voted matches yet (${standings.matches} recorded)\n`);
		return 0;
	}
	const table = [
		["TARGET/MODEL", "VOTES", "WINS", "LOSSES", "TIES", "BOTH-BAD", "ELO"],
		...standings.standings.map((s) => [
			s.identity,
			String(s.votes),
			String(s.wins),
			String(s.losses),
			String(s.ties),
			String(s.bad),
			s.score === null ? `n/a (<${standings.minVotesForScore} votes)` : String(s.score),
		]),
	];
	out.write(
		`${formatColumns(table)}\n${standings.votedMatches} voted of ${standings.matches} matches${standings.suite ? ` in suite ${standings.suite}` : ""}. These are your recorded votes; PanCode does not judge.\n`,
	);
	return 0;
}

/** `pancode arena <verb> ...`: help, usage errors and every verb, as text the host prints. */
export async function runArenaCli(args: string[], host: () => ArenaHost): Promise<ArenaCliResult> {
	const out = new Out();
	const [verb, ...rest] = args;
	// Help is an option, so a literal "--help" after "--" is prompt text, not a request for help.
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	if (verb === undefined || options.includes("--help") || options.includes("-h")) {
		return { stdout: `${HELP}\n`, stderr: "", exitCode: 0 };
	}
	const done = (exitCode: number): ArenaCliResult => ({ stdout: out.stdout, stderr: out.stderr, exitCode });
	try {
		switch (verb) {
			case "run":
				return done(await runCommand(rest, host(), out));
			case "show":
				return done(showCommand(rest, host(), out));
			case "vote":
				return done(await voteCommand(rest, host(), out));
			case "list":
				return done(listCommand(rest, host(), out));
			case "standings":
				return done(standingsCommand(rest, host(), out));
			default:
				if (verb === "--json") throw new ArenaUsageError("name a subcommand");
				if (verb.startsWith("-")) throw new ArenaUsageError(`unknown flag: ${verb}`, "unknown_flag");
				throw new ArenaUsageError(`unknown arena command: ${verb}`, "unknown_command");
		}
	} catch (error) {
		if (error instanceof ArenaUsageError) {
			// One diagnostic and a pointer to help, never the whole page.
			const command = VERBS.includes(verb) ? `pancode arena ${verb}` : "pancode arena";
			if (options.includes("--json")) {
				out.write(`${JSON.stringify({ version: 1, ok: false, error: { code: error.slug, message: error.message } })}\n`);
			}
			out.stderr += `${command}: ${error.message}\nsee: ${command} --help\n`;
			return done(2);
		}
		out.error(error instanceof Error ? error.message : String(error));
		return done(1);
	}
}
