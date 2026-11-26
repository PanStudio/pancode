// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExitSummaryStyle, OutputStyle } from "../core/defaults.js";
import { formatFooterTokens } from "../core/display-units.js";
import { formatCount } from "../core/format-time.js";
import { tierPolicy } from "../core/presentation-tier.js";
import { USAGE_NOT_MEASURED } from "../core/views/usage-words.js";
import { plainOutcomeLabel, refusedCallsWords } from "../domains/dispatch/failure-headline.js";
import { formatOpenDecision } from "../domains/safety/autonomy-window.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSpend, ExitSummarySnapshot } from "./exit-summary-collector.js";
import {
	brandMark,
	exactRouteLabel,
	formatElapsed,
	formatTargetLabel,
	GLYPH,
	type PancodeTheme,
	pancodeTheme,
	rule,
	type SemanticRole,
	widthClass,
	wordmarkName,
} from "./theme/index.js";
import { economyReceipt } from "./usage-words.js";

const count = (value: number): string => value.toLocaleString("en-US");
const countLabel = (value: number | string, noun: string): string =>
	`${typeof value === "number" ? count(value) : value} ${noun}${value === 1 || value === "1" ? "" : "s"}`;

const SPEND_NOT_AVAILABLE = "not available";

/** What joins the facts of one row, and the only place a narrow row may break (E4). */
const FACT_SEPARATOR = ` ${GLYPH.sep} `;

/**
 * How the collector joins the facts of one display. The collector writes it in the same glyph mode this card reads
 * it in, so the split finds every join it made.
 */
const DISPLAY_SEPARATOR = ` ${GLYPH.sep} `;

/** A display the collector joined, back into its facts. No read-model display contains the separator. */
const factsOf = (line: string): string[] => line.split(DISPLAY_SEPARATOR).filter((fact) => fact.length > 0);

/** Body rows start two cells in, under the title rule's text. */
const INDENT = "  ";

/**
 * Token figures in the short form a shared row uses (`2.0k`, `455.9k`), keeping their `≥` or `≈` mark; the cache
 * read reads `cached`. Only figures of 1,000 and more change, so a note's small counts stay as written.
 */
function shortFigures(text: string): string {
	return (
		text
			.replace(/^cache read /u, "cached ")
			.replace(/\d{1,3}(?:,\d{3})+|\d{4,}/gu, (digits) => formatCount(Number(digits.replaceAll(",", ""))))
			// The read model's bound marks are Unicode; the chrome draws them in the mode's glyphs.
			.replace(/(^| )≥/gu, `$1${GLYPH.atLeast}`)
			.replace(/(^| )≈/gu, `$1${GLYPH.estimate}`)
	);
}

/** The session's tokens on a one-line row: fresh and cached apart when both were measured, else the total (F9). */
function spendTokens(spend: Extract<ExitSpend, { kind: "ready" }>): string {
	const split = spend.freshCached;
	return split !== null
		? `${formatCount(split.fresh)} fresh + ${formatCount(split.cached)} cached tokens`
		: `${shortFigures(factsOf(spend.tokens)[0] ?? "")} tokens`;
}

/** Leads a row whose figures span the whole session rather than this visit. */
const WHOLE_SESSION = "whole session";

/** A labelled token figure of the collector's breakdown, as opposed to a note on what no call reported. */
const TOKEN_FIGURE = /^(?:in|out|cache read|cache write|reasoning) \S+$/u;

/** Standard states the figures; detailed adds the notes on what no call reported (2.9). No figure says so. */
function tokenRowFacts(breakdown: string, tier: OutputStyle): string[] {
	const facts = factsOf(breakdown)
		.filter((fact) => tierPolicy(tier).provenance || TOKEN_FIGURE.test(fact))
		.map(shortFigures);
	return facts.length > 0 ? facts : [USAGE_NOT_MEASURED];
}

/**
 * The route-priced cost, then the receipt the economics fold gives: extra cost, seat credits, API equivalent. A
 * declared pool fee belongs to its period, so it is never on this per-session line.
 */
function sessionCostFacts(spend: ExitSummarySnapshot["spend"], tier: OutputStyle): string[] {
	if (spend.kind !== "ready") return [SPEND_NOT_AVAILABLE];
	const receipt = spend.economy ? economyReceipt(spend.economy, null) : [];
	const facts = [spend.cost, ...receipt.map((part) => part.text)];
	// Measured credits are the cost, so even detailed drops the parts that state no amount beside them: `not measured ·
	// extra unknown · 0.2344 credits` read as no cost and a cost at once (tui-verify 15).
	if (tierPolicy(tier).provenance) {
		const stated = facts.filter((fact) => !UNKNOWN_COST.test(fact));
		return stated.length > 0 ? stated : facts;
	}
	// Below detailed a row states one unknown at most (2.9): the measured parts, else the route cost's own words.
	// An API equivalent equal to the route cost restates the same number (`~$0.0013 est · API equiv ~$0.0013`), and
	// one priced for only some calls (`API equiv ~$0.00008 for 1 of 3 calls`) reads as the session's price when it is
	// a sliver of it.
	const amount = dollarAmount(spend.cost);
	const partial = new Set(receipt.filter((part) => part.unknown).map((part) => part.text));
	const known = facts.filter(
		(fact) =>
			!UNKNOWN_COST.test(fact) &&
			!(fact.startsWith(API_EQUIV) && partial.has(fact)) &&
			!(amount !== null && fact.startsWith(API_EQUIV) && dollarAmount(fact.slice(API_EQUIV.length)) === amount),
	);
	return known.length > 0 ? known : [spend.cost];
}

/** The cost as one fact beside others, so `not measured` says what it is about. */
function glanceCost(spend: ExitSummarySnapshot["spend"], tier: OutputStyle): string {
	if (spend.kind !== "ready") return `cost ${SPEND_NOT_AVAILABLE}`;
	const headline = sessionCostFacts(spend, tier)[0] ?? spend.cost;
	return UNKNOWN_COST.test(headline) ? `cost ${headline}` : headline;
}

const API_EQUIV = "API equiv ";

function dollarAmount(text: string): string | null {
	return /\$[\d.,]+/u.exec(text)?.[0] ?? null;
}

/** A cost part that states no amount: `not measured`, `extra unknown`, `API equiv unknown`. */
const UNKNOWN_COST = new RegExp(`${USAGE_NOT_MEASURED}|\\bunknown\\b|${SPEND_NOT_AVAILABLE}`, "u");

/**
 * `3 outcomes · 2 reproduce or numeric-compare passes · 4,115 session tokens per outcome · ~$0.0041 est per outcome`,
 * or the words saying there is nothing to divide by. The share divides the whole session's spend, so it says so
 * (bt-11).
 */
function verifiedFacts(spend: ExitSummarySnapshot["spend"], tier: OutputStyle): string[] {
	if (spend.kind !== "ready") return [SPEND_NOT_AVAILABLE];
	const verified = spend.verified;
	// Below detailed a row states one unknown, so the none case keeps its two facts short (2.9).
	if (verified.kind === "none")
		return tierPolicy(tier).provenance
			? verified.words.split("; ")
			: ["no judged outcome", "command checks are not counted"];
	return [
		countLabel(verified.count, "outcome"),
		...verified.parts,
		verified.tokens === USAGE_NOT_MEASURED
			? `tokens ${USAGE_NOT_MEASURED}`
			: `${verified.tokens} session tokens per outcome`,
		verified.cost === USAGE_NOT_MEASURED ? `cost ${USAGE_NOT_MEASURED}` : `${verified.cost} per outcome`,
	];
}

/**
 * The route as the session header spells it, `target · model`, naming the target once: a model id that already starts
 * with its target's name (`mock` serving `mock/judge-model`) read `mock / mock/judge-model` (E3).
 */
function routeLabel(target: string, model: string): string {
	const named = model.startsWith(`${target}/`) ? model.slice(target.length + 1) : model;
	return exactRouteLabel({ targetId: target, modelId: named }) ?? formatTargetLabel(target, model);
}

/**
 * `lead` then the facts, laid out in `room` cells, each later row starting with `hang`. A row breaks only between
 * facts and drops the separator at the break, so no row starts or ends with `·` and no fact is split across rows
 * (E4). A fact wider than a whole row has no boundary to break at, so it alone wraps at its spaces.
 */
function factRows(lead: string, facts: ReadonlyArray<string>, room: number, hang: string): string[] {
	const rows: string[] = [];
	let row = lead;
	let bare = true;
	const queue = [...facts];
	for (let fact = queue.shift(); fact !== undefined; fact = queue.shift()) {
		const joined = bare ? `${row}${fact}` : `${row}${FACT_SEPARATOR}${fact}`;
		if (visibleWidth(joined) <= room) {
			row = joined;
			bare = false;
			continue;
		}
		const alone = visibleWidth(`${hang}${fact}`) <= room;
		if (!alone && fact.includes(DISPLAY_SEPARATOR)) {
			// A compound fact too wide for any row, such as a `target · model` route, breaks at its own boundaries by the
			// same rule. It starts a row of its own, so its first part never reads as one more fact of the row before it.
			if (!bare) {
				rows.push(row);
				row = hang;
				bare = true;
			}
			queue.unshift(...fact.split(DISPLAY_SEPARATOR));
			continue;
		}
		if (!bare) {
			rows.push(row);
			row = hang;
		}
		if (visibleWidth(`${row}${fact}`) <= room) {
			row = `${row}${fact}`;
			bare = false;
			continue;
		}
		const firstRoom = Math.max(1, room - visibleWidth(row));
		const [first = "", ...overflow] = wrapTextWithAnsi(fact, firstRoom);
		bare = false;
		if (overflow.length === 0) {
			row = `${row}${first}`;
			continue;
		}
		// Only the first piece sits beside the label; the rest rewraps at the row's width under the hanging indent, or a
		// narrow card wrapped every continuation as narrow as the label left the first (CLI-P57).
		const remainder = fact.startsWith(first) ? fact.slice(first.length).trimStart() : overflow.join(" ");
		const rest = wrapTextWithAnsi(remainder, Math.max(1, room - hang.length));
		rows.push(`${row}${first}`, ...rest.slice(0, -1).map((piece) => `${hang}${piece}`));
		row = `${hang}${rest.at(-1) ?? ""}`;
	}
	if (!bare || rows.length === 0) rows.push(row);
	return rows;
}

type ModelSpend = Extract<ExitSummarySnapshot["spend"], { kind: "ready" }>["models"][number];

/** The read model's `target/model` groups, then any model this visit saw that no call record names. */
function modelList(snapshot: ExitSummarySnapshot): Array<{ target: string; model: string; spend?: ModelSpend }> {
	const groups = snapshot.spend.kind === "ready" ? snapshot.spend.models : [];
	const recorded = groups.map((spend) => {
		const slash = spend.key.indexOf("/");
		return { target: spend.key.slice(0, slash), model: spend.key.slice(slash + 1), spend };
	});
	const unreported = snapshot.models.filter(
		(model) => !recorded.some((row) => row.target === model.target && row.model === model.model),
	);
	return [...recorded, ...unreported];
}

/** Hook files shown before the line says how many more there are. */
const GIT_HOOKS_SHOWN = 4;

function gitHookEntry(hook: { path: string; kind: string; key?: string }): string {
	return hook.key === undefined ? `${hook.kind} ${hook.path}` : `${hook.kind} ${hook.key} in ${hook.path}`;
}

/** `changed .git/hooks/pre-commit`, `added core.fsmonitor in .git/config`, or null when nothing changed this visit. */
function gitHooksSummary(snapshot: Pick<ExitSummarySnapshot, "gitHooks">): string[] | null {
	const hooks = snapshot.gitHooks ?? [];
	if (hooks.length === 0) return null;
	const shown = hooks.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
	const more = hooks.length > GIT_HOOKS_SHOWN ? [`${count(hooks.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more];
}

/** How the summary words each outcome of src/domains/safety/internal-git-policy.ts. */
const INTERNAL_GIT_OUTCOMES: Readonly<Record<string, string>> = {
	"hooks-off": "without hooks",
	overridden: "with changed config overridden",
	skipped: "skipped",
	yolo: "under yolo with changes",
};

/**
 * `git worktree add without hooks (added .git/hooks/post-checkout) · git
 * merge under yolo with changes (...)`, or null when PanCode's own git met no drift.
 */
function internalGitSummary(snapshot: Pick<ExitSummarySnapshot, "internalGit">): string[] | null {
	const runs = snapshot.internalGit ?? [];
	if (runs.length === 0) return null;
	const shown = runs.slice(0, GIT_HOOKS_SHOWN).map((run) => {
		const changes = run.changes.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
		const more = run.changes.length > GIT_HOOKS_SHOWN ? [`${count(run.changes.length - GIT_HOOKS_SHOWN)} more`] : [];
		return `${run.operation} ${INTERNAL_GIT_OUTCOMES[run.outcome] ?? run.outcome} (${[...changes, ...more].join(", ")})`;
	});
	const more = runs.length > GIT_HOOKS_SHOWN ? [`${count(runs.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more];
}

/**
 * The autonomy disclosure: what ran without the operator this visit. A yolo window says how long and how many calls
 * ran unasked, then what stopped it and the decisions it left; what PanCode answered for an absent operator follows
 * (#421). Standard and up add the confinement and the cap tokens, detailed lists the open decisions. Null when the
 * visit had no yolo window and answered nothing alone (ob-yolo D7).
 */
function autonomyFacts(snapshot: ExitSummarySnapshot, tier: OutputStyle): string[] | null {
	const facts: string[] = [];
	const report = snapshot.autonomy;
	if (report !== undefined) {
		const total = report.openDecisions.length + report.openDecisionsOmitted;
		facts.push(
			`yolo for ${formatElapsed(report.usage.activeMs)}`,
			`${countLabel(report.usage.toolCalls, "call")} ran unasked`,
		);
		if (report.halted !== null)
			facts.push(
				report.halted.kind === "judge"
					? `ended by the safety judge (${report.halted.detail})`
					: report.halted.kind === "exploration"
						? `ended by the read-streak gate (${report.halted.detail})`
						: `paused at the ${report.halted.detail}`,
			);
		if (total > 0) facts.push(countLabel(total, "open decision"));
		if (tierPolicy(tier).evidence) {
			facts.push(report.confinement, `${formatFooterTokens(report.usage.tokens)} cap tokens`);
			if (total === 0) facts.push("no open decisions");
		}
		if (tierPolicy(tier).provenance) {
			const shown = report.openDecisions.slice(-GIT_HOOKS_SHOWN).map(formatOpenDecision);
			facts.push(...shown);
			if (shown.length > 0 && total > shown.length) facts.push(`${count(total - shown.length)} more`);
		}
	}
	const { questions, permissions } = snapshot.unattended;
	if (questions > 0) facts.push(`${countLabel(questions, "question")} auto-resolved`);
	if (permissions > 0) facts.push(`${countLabel(permissions, "permission ask")} timed out and denied`);
	return facts.length > 0 ? facts : null;
}

/**
 * The failed-check disclosure, worst first: workers whose validation failed or whose record cannot be trusted, check
 * commands that failed, then records left unverified. Null when every check this visit held.
 */
function checkFacts(snapshot: ExitSummarySnapshot): { facts: string[]; failed: boolean; settled: boolean } | null {
	const against = new Map<string, number>();
	let unverified = 0;
	for (const worker of snapshot.workers) {
		// A compromised record says why in plain words; "compromised" alone read as a security incident.
		const words = worker.against ?? (worker.record === "compromised" ? compromisedWords(worker) : undefined);
		if (words !== undefined) against.set(words, (against.get(words) ?? 0) + 1);
		// A worker whose records saw it change nothing, a read-only council member or one stopped early, left nothing
		// to verify; one whose writes no record settled still counts.
		else if (worker.record === "unverified" && worker.wrote !== false) unverified += 1;
	}
	const verify = snapshot.tools.find((tool) => tool.tool === "verify");
	const failedChecks = verify?.failures ?? 0;
	// A check that failed and then passed leaves the workspace passing; the earlier failures are history, not state.
	const recovered = failedChecks > 0 && verify?.lastFailed === false;
	const facts = [
		...[...against].map(([words, n]) =>
			words === "validation failed"
				? `${GLYPH.error} ${countLabel(n, "worker")} failed validation`
				: `${GLYPH.error} ${countLabel(n, "worker")}: ${words}`,
		),
		...(recovered
			? [`${GLYPH.ok} latest check passed (${countLabel(failedChecks, "earlier check")} failed)`]
			: failedChecks > 0
				? [`${GLYPH.error} ${countLabel(failedChecks, "check")} failed`]
				: []),
		...(unverified > 0 ? [`${GLYPH.warn} ${count(unverified)} unverified`] : []),
	];
	if (facts.length === 0) return null;
	return {
		facts,
		failed: against.size > 0 || (failedChecks > 0 && !recovered),
		settled: against.size === 0 && unverified === 0 && recovered,
	};
}

function compromisedWords(worker: ExitSummarySnapshot["workers"][number]): string {
	return worker.recordFailure ?? "not trusted";
}

function workerOutcome(worker: ExitSummarySnapshot["workers"][number]): string {
	return worker.outcome === "succeeded" && worker.against !== undefined ? worker.against : worker.outcome;
}

function outcomes(snapshot: ExitSummarySnapshot): string[] {
	const counts = new Map<string, number>();
	// A run that finished but failed its validation reads as Fleet reads it, not as the exit code's success.
	for (const worker of snapshot.workers) {
		const outcome = workerOutcome(worker);
		counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	}
	// Quitting drains the fleet, so a worker still running when the summary was taken did not keep running.
	const words = [...counts].map(
		([outcome, n]) => `${count(n)} ${outcome === "running" ? "stopped by quitting" : plainOutcomeLabel(outcome)}`,
	);
	// A clean exit says nothing of a refused call; the collected block names it, so this row does too.
	const refused = snapshot.workers.reduce((sum, worker) => sum + (worker.refusedCalls ?? 0), 0);
	if (refused === 0) return words;
	const guarded = snapshot.workers.reduce((sum, worker) => sum + (worker.guardedCalls ?? 0), 0);
	return [...words, refusedCallsWords(refused, guarded)];
}

/**
 * One worker as the detailed card names it: its state glyph, agent, run id and the word that state rests on. The
 * worst of the process outcome, the validation verdict and the record's integrity wins (2.7).
 */
function workerFact(worker: ExitSummarySnapshot["workers"][number]): string {
	const ended = worker.outcome === "succeeded" || worker.outcome === "completed";
	const [glyph, word] =
		worker.against !== undefined
			? [GLYPH.error, worker.against]
			: !ended
				? [
						worker.outcome === "running" || worker.outcome === "cancelled" || worker.outcome === "canceled"
							? GLYPH.cancelled
							: GLYPH.error,
						worker.outcome === "running" ? "stopped by quitting" : plainOutcomeLabel(worker.outcome),
					]
				: worker.record === "compromised"
					? [GLYPH.error, compromisedWords(worker)]
					: worker.record === "reviewed" || worker.record === "grounded"
						? [GLYPH.ok, worker.record]
						: [GLYPH.warn, worker.record === "not available" ? "record not read" : worker.record];
	return `${glyph} ${worker.agent} ${worker.runId} ${word}`;
}

/** A timeline event's offset into the visit, `M:SS`. */
function clock(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Section {
	label: string;
	/** Each entry is one logical line of facts; a later entry starts a row of its own. */
	lines: ReadonlyArray<ReadonlyArray<string>>;
	/** What a cut counts: `… 5 more events`. */
	noun?: string;
	/** Said after the cut count: `resume to inspect`. */
	tail?: string;
	/** The most physical rows the section may take whatever the budget left. */
	maxRows?: number;
	role?: SemanticRole;
}

/** A physical row before painting: the label cells, then the value. */
interface Row {
	label: string;
	value: string;
}

/**
 * The closing line for a visit with no conversation: a launch that sent nothing,
 * or one that only ran a fleet plan. There is no session a resume line could
 * name, so it says that rather than leaving the exit silent.
 */
export function renderExitWithoutConversation(preference: ExitSummaryStyle, tty: boolean): string[] {
	if (preference === "off") return [];
	const line = `PanCode ${GLYPH.sep} no conversation this visit, so there is nothing to resume.`;
	return [tty ? pancodeTheme().fg("annotation", line) : line];
}

/**
 * The exit summary (5.2): an open island of a titled light rule, a label column of facts and the resume command last.
 * `outputStyle` sizes it and `height` caps it in physical rows (`exitRows`), claimed in order: the title, the resume
 * command, the autonomy and failed-check disclosures, then routine facts in tier order. A section that does not fit
 * shortens to its first rows and says how much it left out; when the routine work, tokens, cost or workers would not fit
 * at all, they fold into one `work` glance claimed ahead of the disclosures' later rows. Without a TTY the rows are plain, unwrapped and carry no
 * rule. Pure formatting: no ledger readers, filesystem work, or provider calls on exit.
 */
export function renderExitSummary(
	snapshot: ExitSummarySnapshot | null,
	preference: ExitSummaryStyle,
	width: number,
	tty: boolean,
	outputStyle: OutputStyle = "standard",
	height = 48,
): string[] {
	if (snapshot === null) return [];
	const id = sanitizeCallTargetText(snapshot.sessionId);
	const resumeCommand = `pancode --resume ${id}`;
	if (preference === "off") return [`To resume: ${resumeCommand}`];
	const tier = outputStyle;
	const theme = tty ? pancodeTheme() : null;
	const cells = Math.max(1, Math.floor(width));
	const narrow = tty && widthClass(cells) !== "W3" && widthClass(cells) !== "W4" && widthClass(cells) !== "W5";
	// Labels stack above their values under 44 cells (W1).
	const stacked = tty && widthClass(cells) === "W1";
	const room = tty ? Math.max(1, cells - INDENT.length) : Number.POSITIVE_INFINITY;
	const cap = tierPolicy(tier).exitRows(Math.max(1, Math.floor(height)));

	const spend = snapshot.spend;
	const models = modelList(snapshot);
	const sessions = snapshot.visitSessions ?? 1;
	const otherTools = snapshot.otherSessionToolCalls ?? 0;
	const autonomy = autonomyFacts(snapshot, tier);
	const checks = checkFacts(snapshot);
	const clean = (facts: ReadonlyArray<string>): string[] => facts.map((fact) => sanitizeCallTargetText(fact));
	// A resumed session's tokens, cost, outcomes, cache and models are the read model's whole-session figures, while
	// its work and time are this visit's, so the session-wide rows say whose they are (tui-verify 14).
	const sessionWide = spend.kind === "ready" && spend.sessionBeforeVisit === true;
	const whole = (facts: ReadonlyArray<string>): string[] => (sessionWide ? [WHOLE_SESSION, ...facts] : [...facts]);

	const disclosures: Section[] = [
		...(autonomy ? [{ label: "autonomy", lines: [clean(autonomy)], role: "body" as const }] : []),
		...(checks
			? [
					{
						label: "checks",
						lines: [clean(checks.facts)],
						role: checks.failed ? ("error" as const) : checks.settled ? ("body" as const) : ("warning" as const),
					},
				]
			: []),
	];
	const routine: Section[] = [];
	// The visit's own figures: a card too tight for them folds them into `glance` rather than dropping them.
	const core: Section[] = [];
	let glance: Section | null = null;
	if (!tierPolicy(tier).evidence) {
		const model = models.at(-1);
		routine.push({
			label: "",
			lines: [
				clean(
					whole([
						spend.kind === "ready" ? spendTokens(spend) : `tokens ${SPEND_NOT_AVAILABLE}`,
						spend.kind === "ready" ? (sessionCostFacts(spend, tier)[0] ?? spend.cost) : `cost ${SPEND_NOT_AVAILABLE}`,
						...(model ? [routeLabel(model.target, model.model)] : []),
						...(spend.kind !== "ready"
							? []
							: spend.verified.kind === "none"
								? ["no judged outcome"]
								: [countLabel(spend.verified.count, "verified outcome")]),
					]),
				),
			],
		});
		core.push(...routine);
	} else {
		const hooks = gitHooksSummary(snapshot);
		const git = internalGitSummary(snapshot);
		// A hook runs outside the sandbox on the next git command, so these follow the disclosures.
		if (hooks) disclosures.push({ label: "hooks", lines: [clean(hooks)], role: "warning" });
		if (git) disclosures.push({ label: "git", lines: [clean(git)], role: "warning" });
		// A turn is one operator prompt; a model call is one request sent, workers' included as /usage counts them.
		// A visit that switched sessions keeps its counts across them, but the call count is the named session's.
		const unrecorded = snapshot.unrecordedWorkerFiles;
		const turns = `${countLabel(snapshot.turns, "turn")}${snapshot.sessionTurns !== undefined && sessions > 1 ? ` (${count(snapshot.sessionTurns)} in this session)` : ""}`;
		const calls =
			spend.kind === "ready"
				? [
						`${countLabel(spend.visitCalls + spend.visitNeverSent, "model call")}${spend.visitNeverSent > 0 ? `, ${count(spend.visitNeverSent)} never sent` : ""}${sessions > 1 ? " in this session" : ""}`,
					]
				: [];
		const work: Section = {
			label: "work",
			lines: [
				clean([
					turns,
					...calls,
					countLabel(snapshot.workers.length, "worker"),
					`${countLabel(snapshot.files.length, "file")} changed${unrecorded > 0 ? ` (${countLabel(unrecorded, "worker")} kept no write record)` : ""}`,
					...(sessions > 1 ? [countLabel(sessions, "session")] : []),
					...(snapshot.compactions > 0 ? [countLabel(snapshot.compactions, "compaction")] : []),
				]),
			],
		};
		routine.push(work);
		core.push(work);
		const glanceSpend = [
			spend.kind === "ready" ? spendTokens(spend) : `tokens ${SPEND_NOT_AVAILABLE}`,
			glanceCost(spend, tier),
		];
		const workerCount = countLabel(snapshot.workers.length, "worker");
		glance = {
			label: "work",
			lines: [
				clean(
					sessionWide
						? [turns, ...calls, workerCount, ...whole(glanceSpend)]
						: [turns, ...calls, ...glanceSpend, workerCount],
				),
			],
		};
		routine.push({
			label: "time",
			lines: [
				clean([
					formatElapsed(snapshot.wallMs),
					...(spend.kind !== "ready"
						? [`model time ${SPEND_NOT_AVAILABLE}`]
						: spend.callTime === USAGE_NOT_MEASURED
							? [`model time ${USAGE_NOT_MEASURED}`]
							: spend.callTime !== null
								? [`${spend.callTime} in model calls`]
								: []),
					...(spend.kind === "ready" && spend.callTimeCoverage !== null ? [spend.callTimeCoverage] : []),
				]),
			],
		});
		const tokens: Section = {
			label: "tokens",
			lines: [clean(spend.kind === "ready" ? whole(tokenRowFacts(spend.breakdown, tier)) : [SPEND_NOT_AVAILABLE])],
		};
		const cost: Section = { label: "cost", lines: [clean(whole(sessionCostFacts(spend, tier)))] };
		routine.push(tokens, cost);
		core.push(tokens, cost);
		routine.push({ label: "verified", lines: [clean(whole(verifiedFacts(spend, tier)))] });
		if (tierPolicy(tier).provenance && spend.kind === "ready" && spend.cache !== null) {
			routine.push({
				label: "cache",
				lines: [
					clean(
						whole([
							`${spend.cache.share} of prompt tokens read from cache`,
							...(spend.cache.lastTurn !== null ? [`last turn ${spend.cache.lastTurn}`] : []),
							...(spend.cache.replay !== null ? [spend.cache.replay] : []),
						]),
					),
				],
			});
		}
		if (models.length > 0) {
			routine.push(
				tierPolicy(tier).provenance
					? {
							label: models.length > 1 ? "models" : "model",
							lines: models.map(({ target, model, spend: recorded }, index) =>
								clean(
									(index === 0 ? whole : (facts: string[]) => facts)([
										routeLabel(target, model),
										recorded ? countLabel(recorded.calls, "call") : "no call record names it",
									]),
								),
							),
							noun: "models",
						}
					: {
							label: models.length > 1 ? "models" : "model",
							lines: [
								clean(
									// A route is `target · model` itself, so the routes are one fact listed with commas: joined by
									// the row's `·` two routes read as four peers (tui-verify 4).
									whole([
										[
											...models.slice(0, 3).map((model) => routeLabel(model.target, model.model)),
											...(models.length > 3 ? [`+${count(models.length - 3)} more`] : []),
										].join(", "),
									]),
								),
							],
						},
			);
		}
		if (tierPolicy(tier).provenance && spend.kind === "ready" && spend.byRole.length > 0)
			routine.push({ label: "calls", lines: [clean(whole(factsOf(spend.byRole)))] });
		// Tools are the named session's own; a visit that switched sessions says what the others ran instead of
		// dropping the row when this session ran none (TUI-6). Kinds sort by count, then name.
		if (snapshot.tools.length > 0 || otherTools > 0) {
			const kinds = [...snapshot.tools]
				.filter((tool) => tool.count > 0)
				.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
				.map(({ tool, count: n }) => `${tool} ${count(n)}`);
			const failures = snapshot.tools.reduce((sum, tool) => sum + tool.failures, 0);
			const extras = [
				...(kinds.length === 0 ? ["none in this session"] : []),
				...(otherTools > 0 ? [`${countLabel(otherTools, "call")} in other sessions this visit`] : []),
				...(tierPolicy(tier).provenance && failures > 0 ? [`${count(failures)} failed`] : []),
			];
			routine.push({ label: "tools", lines: [clean([...kinds, ...extras])], noun: "kinds", maxRows: stacked ? 2 : 1 });
		}
		if (snapshot.workers.length > 0) {
			const workers: Section = tierPolicy(tier).provenance
				? { label: "workers", lines: [clean(snapshot.workers.map(workerFact))], noun: "workers" }
				: { label: "workers", lines: [clean(outcomes(snapshot))] };
			routine.push(workers);
			core.push(workers);
		}
		if (tierPolicy(tier).provenance && snapshot.timeline.length > 0)
			routine.push({
				label: "timeline",
				lines: [clean(snapshot.timeline.map((event) => `${clock(event.elapsedMs)} ${event.text}`))],
				noun: "events",
				tail: "resume to inspect",
			});
	}

	const resumeSection: Section = { label: "resume", lines: [[resumeCommand]], role: "commandHint" };
	const all = [...disclosures, ...routine, resumeSection];
	const column = all.reduce((widest, section) => Math.max(widest, section.label.length), 0) + 2;
	const pad = (label: string): string => (label.length === 0 ? "" : label.padEnd(column));
	const hang = " ".repeat(column);

	/** A section's rows showing `shown` of its units, then the count of the rest when `mark` asks for it. */
	const layout = (section: Section, shown: number, mark: boolean): Row[] => {
		const multi = section.lines.length > 1;
		const units = multi ? section.lines.length : (section.lines[0]?.length ?? 0);
		const hidden = units - shown;
		const more =
			hidden > 0 && mark
				? [
						`${GLYPH.ellipsis} ${count(hidden)} more${section.noun ? ` ${section.noun}` : ""}${section.tail ? `${FACT_SEPARATOR}${section.tail}` : ""}`,
					]
				: [];
		const lines = multi
			? [...section.lines.slice(0, shown), ...(more.length > 0 ? [more] : [])]
			: [[...(section.lines[0] ?? []).slice(0, shown), ...more]];
		if (stacked) {
			const values = lines.flatMap((facts) => factRows("", facts, room, ""));
			return section.label.length === 0
				? values.map((value) => ({ label: "", value }))
				: [{ label: section.label, value: "" }, ...values.map((value) => ({ label: "", value }))];
		}
		const rows: Row[] = [];
		lines.forEach((facts, index) => {
			const lead = index === 0 ? pad(section.label) : hang;
			const indent = section.label.length === 0 ? "" : hang;
			factRows(lead, facts, room, indent).forEach((row, at) => {
				const labelCells = index === 0 && at === 0 ? lead.length : 0;
				rows.push({ label: row.slice(0, labelCells), value: row.slice(labelCells) });
			});
		});
		return rows;
	};

	/**
	 * The most of a section that fits `budget` rows. Compact drops whole facts silently, so each row stays one row (a
	 * label and its value under 44 cells); the other tiers say how much they cut. A compact disclosure whose first fact
	 * alone is too wide keeps its first rows, the last closed with an ellipsis. Null when not even the cut count fits.
	 */
	const fit = (section: Section, budget: number): Row[] | null => {
		const perSection = !tierPolicy(tier).evidence ? (stacked ? 2 : 1) : budget;
		const limit = Math.min(budget, perSection, section.maxRows ?? budget);
		if (limit <= 0) return null;
		const units = section.lines.length > 1 ? section.lines.length : (section.lines[0]?.length ?? 0);
		const mark = tierPolicy(tier).evidence;
		for (let shown = units; shown >= (mark ? 0 : 1); shown -= 1) {
			const rows = layout(section, shown, mark);
			if (rows.length <= limit) return rows;
		}
		if (mark) return null;
		const rows = layout(section, 1, false).slice(0, limit);
		const last = rows.at(-1);
		if (last === undefined) return null;
		const valueRoom = Math.max(1, room - visibleWidth(last.label) - 1 - visibleWidth(GLYPH.ellipsis));
		rows[rows.length - 1] = {
			label: last.label,
			value: `${truncateToWidth(last.value, valueRoom, "", false)} ${GLYPH.ellipsis}`,
		};
		return rows;
	};

	// The command and its id are one thing to copy, so under 72 cells it takes a row of its own, never broken inside.
	const resumeRows: Row[] =
		narrow || stacked
			? [{ label: "resume", value: "" }, ...wrapTextWithAnsi(resumeCommand, room).map((value) => ({ label: "", value }))]
			: [{ label: pad("resume"), value: resumeCommand }];

	const left = cap - 1 - resumeRows.length;
	/** Claims each section in order as it fits what `budget` left, after the sections `placed` already holds. */
	const claim = (sections: ReadonlyArray<Section>, budget: number, placed: Map<Section, Row[]>): void => {
		let free = budget;
		for (const section of sections) {
			if (placed.has(section)) continue;
			const rows = fit(section, free);
			if (rows === null) continue;
			placed.set(section, rows);
			free -= rows.length;
		}
	};
	let order = [...disclosures, ...routine];
	let placed = new Map<Section, Row[]>();
	claim(order, left, placed);
	// A tight card, a stacked pane or a short terminal, can spend every row on the disclosures and close on autonomy and
	// checks alone. The visit's turns, calls, tokens, cost and workers then fold into one glance that claims what the
	// disclosures' shortest forms leave, and each disclosure grows only into rows the later ones do not need.
	const folded = glance ?? core[0];
	if (folded && core.some((section) => !placed.has(section))) {
		order = [...disclosures, folded, ...routine.filter((section) => !core.includes(section))];
		placed = new Map();
		const floors = disclosures.map((section) => fit(section, stacked ? 2 : 1)?.length ?? 0);
		const total = (rows: ReadonlyArray<number>): number => rows.reduce((sum, n) => sum + n, 0);
		claim([folded], left - total(floors), placed);
		let free = left - (placed.get(folded)?.length ?? 0);
		// The disclosures share the rows past their shortest forms evenly, then the first ones take what is left.
		const share = Math.floor(Math.max(0, free - total(floors)) / Math.max(1, disclosures.length));
		disclosures.forEach((section, index) => {
			const room = Math.min(free - total(floors.slice(index + 1)), (floors[index] ?? 0) + share);
			const rows = fit(section, room) ?? fit(section, free);
			if (rows === null) return;
			placed.set(section, rows);
			free -= rows.length;
		});
		for (const section of disclosures) {
			const had = placed.get(section)?.length ?? 0;
			const rows = fit(section, had + free);
			if (rows === null || rows.length <= had) continue;
			placed.set(section, rows);
			free -= rows.length - had;
		}
		claim(order, free, placed);
	}
	const body = order.flatMap((section) => {
		const rows = placed.get(section);
		return rows ? [{ section, rows }] : [];
	});
	body.push({ section: resumeSection, rows: resumeRows });

	const sessionText = `${narrow ? "" : "session "}${snapshot.sessionName ? `${sanitizeCallTargetText(snapshot.sessionName)} ${GLYPH.sep} ` : ""}${id}`;
	const meta = !tierPolicy(tier).evidence ? formatElapsed(snapshot.wallMs) : "this visit";
	const paint = (row: Row, role: SemanticRole): string => {
		const text = `${row.label}${row.value}`;
		if (!theme) return `${INDENT}${text}`.trimEnd();
		return `${INDENT}${theme.fg("annotation", row.label)}${theme.fg(role, row.value)}`;
	};
	const lines = body.flatMap(({ section, rows }) => rows.map((row) => paint(row, section.role ?? "body")));
	if (!theme) return [`PanCode ${GLYPH.sep} ${sessionText} ${GLYPH.sep} ${meta}`, ...lines];
	return [titleRule(theme, cells, sessionText, meta), ...lines];
}

/**
 * `▐∀▌ PanCode · session <id> ───── this visit ─`: the meta goes before the title is shortened, and a title wider
 * than the row closes with an ellipsis.
 */
function titleRule(theme: PancodeTheme, cells: number, sessionText: string, meta: string): string {
	const head = `${GLYPH.brand} PanCode ${GLYPH.sep} `;
	const metaCells = visibleWidth(meta) + 4;
	const withMeta = visibleWidth(head) + visibleWidth(sessionText) + 3 + metaCells <= cells;
	const textRoom = Math.max(1, cells - visibleWidth(head) - 3 - (withMeta ? metaCells : 0));
	const text = truncateToWidth(sessionText, textRoom, GLYPH.ellipsis, false);
	const title = `${brandMark(theme)} ${wordmarkName(theme)} ${theme.fg("annotation", GLYPH.sep)} ${theme.style("heading", text, { bold: true })}`;
	return rule(theme, cells, {
		left: title,
		leftRaw: true,
		...(withMeta ? { right: meta, rightTail: theme.fg("divider", GLYPH.rule) } : {}),
	});
}
