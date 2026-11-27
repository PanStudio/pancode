// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { UNICODE_GLYPH } from "../../core/glyphs.js";
import type { TierPolicy } from "../../core/presentation-tier.js";
import type { SkillLoadRefusal } from "../../core/skill-activation.js";
import { isRecord } from "../../core/type-guards.js";
import { actionClassWords } from "../../core/views/approval-words.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { redactToolArgs } from "../../lib/secrets/redaction.js";
import { gatewayChainPending, gatewayChainPlan, gatewayChainSteps } from "../../tools/gateway-display.js";
import {
	classifyResourceRead,
	type ResolvedToolRow,
	resolveToolRow,
	type ToolClass,
	type ToolRowPair,
} from "../../tools/presentation.js";
/** The tool action row: status glyph, class mark, verb, object, and the settled ledger tail, for single calls and chains. */
import { cardHead } from "../card.js";
import { functionText, GLYPH, joinFacts, releaseSpaces, toolFunction } from "../theme/index.js";
import {
	ARG_PREVIEW_LIMIT,
	budgetedDuration,
	contentWidth,
	detailsOf,
	didNotRun,
	green,
	guidance,
	isChainCall,
	liveElapsed,
	numberField,
	optionalCompactMs,
	presentedCall,
	red,
	SEP,
	STATUS_ERROR_GLYPH,
	STATUS_OK_GLYPH,
	stripShellWrapperForDisplay,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	theme,
	toolMeta,
	truncate,
	yellow,
} from "./tool-call-model.js";
import { ledgerTail, skillLoadFacts, skillRefusalOf } from "./tool-facts.js";

/** Longest URL label a row states; a narrower row gets a shorter one. */
const URL_LABEL_LIMIT = 48;

/**
 * A URL as a row names it: the host and the tail of the path, never the whole
 * URL. The label keeps as much of the path's tail as fits `budget`, so at 40
 * columns it still wraps as one token instead of splitting mid-path.
 */
function urlLabel(raw: string, budget = URL_LABEL_LIMIT): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return truncate(sanitizeCallTargetText(raw), ARG_PREVIEW_LIMIT);
	}
	const host = sanitizeCallTargetText(url.host);
	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => sanitizeCallTargetText(segment));
	if (segments.length === 0) return host;
	const whole = `${host}/${segments.join("/")}`;
	if (whole.length <= budget) return whole;
	for (const keep of [2, 1]) {
		if (segments.length <= keep) continue;
		const tail = `${host}/${GLYPH.ellipsis}/${segments.slice(-keep).join("/")}`;
		if (tail.length <= budget || keep === 1) return truncate(tail, Math.max(budget, 24));
	}
	return truncate(whole, Math.max(budget, 24));
}

/** The URL label budget for a row `width` columns wide: its content column, capped. */
function urlBudget(width: number | undefined): number {
	return width === undefined ? URL_LABEL_LIMIT : Math.max(24, Math.min(URL_LABEL_LIMIT, contentWidth(width)));
}

/**
 * Why a skill did not load, and the one move that changes it, in the words the
 * row states after `skill <name> not loaded`. Commands read in the
 * slash-command accent.
 */
function refusalFact(refusal: SkillLoadRefusal): string {
	const command = (text: string) => guidance(sanitizeCallTargetText(text));
	const skill = `/skill ${refusal.name}`;
	switch (refusal.kind) {
		case "manual-only":
			return `${toolMeta("manual-only: ")}${command(skill)}`;
		case "untrusted":
			return `${toolMeta("untrusted: review it in ")}${command("/hub")}`;
		case "not-imported":
			return toolMeta(sanitizeCallTargetText(`not imported: found in ${refusal.source ?? "?"}/${refusal.scope ?? "?"}`));
		case "not-installed":
			return `${toolMeta("not installed: ")}${command(skill)}`;
		case "not-ready":
			return `${toolMeta(`installed but ${sanitizeCallTargetText(refusal.state ?? "not ready")}: `)}${command("/hub")}`;
		case "operator-only":
			return `${toolMeta("only you can load it: ")}${command(skill)}`;
		case "recipe-bound":
			return toolMeta("not declared for this run");
		case "not-requested":
			return toolMeta("not requested this turn");
		case "unapproved": {
			const server = refusal.source?.startsWith("mcp:") === true ? refusal.source.slice("mcp:".length) : "";
			const argument = refusal.name.startsWith(`${server}:`) ? refusal.name.slice(server.length + 1) : refusal.name;
			return `${toolMeta("not approved: ")}${command(`/mcp trust ${server} --skill ${argument}`)}`;
		}
		case "unverified":
			return toolMeta("failed verification against its manifest");
		case "unavailable":
			return toolMeta("its MCP server is unavailable");
		default:
			return toolMeta("unknown skill");
	}
}

/**
 * Header status follows Pi's call lifecycle before and during execution, then
 * becomes `"ok"` or `"error"` at settlement, or `"unfinished"` for a call that
 * returned without failing but ran out its own wait. The
 * glyph hangs off the right of the header line so the tool name + args read
 * left-to-right without extra punctuation.
 */
type HeaderStatus =
	| "forming"
	| "ready"
	| "running"
	| "ok"
	| "unfinished"
	| "cancelled"
	| "not_run"
	| "error"
	| undefined;

/** Keeps a refusal reason to one scannable clause on the status tail. */
const BLOCK_REASON_LIMIT = 72;

export interface StatusMeta {
	durationMs?: number | undefined;
	elapsedMs?: number | undefined;
	outcome?: ToolExecutionFinished["outcome"];
	/** Refusal reason, rendered only alongside a non-executed outcome. */
	blockReason?: string | undefined;
	/** What an in-flight call has produced so far (`146 lines`, `3 edits`). */
	live?: string | undefined;
	/**
	 * The tier's budgets: which durations show and whether provenance (a batch id) does. Absent for inspection and
	 * export, which state everything.
	 */
	policy?: TierPolicy | undefined;
}

/**
 * The first sentence of a refusal reason, without its closing period. The
 * rest of the reason is guidance for the model and stays in the expanded
 * block. A first sentence still over the limit is cut at a word.
 */
export function blockReasonClause(reason: string): string {
	const first = /^[\s\S]+?[.!?](?=\s|$)/u.exec(reason)?.[0] ?? reason;
	const clause = first.replace(/\.$/u, "");
	if (clause.length <= BLOCK_REASON_LIMIT) return clause;
	const head = clause.slice(0, BLOCK_REASON_LIMIT - GLYPH.ellipsis.length);
	const space = head.lastIndexOf(" ");
	return `${(space > BLOCK_REASON_LIMIT / 2 ? head.slice(0, space) : head).trimEnd()}${GLYPH.ellipsis}`;
}

/**
 * A refusal's tail in an operator's words. `short` and the denial reason are written for the model and the audit,
 * so the action class and the third-person "User" stay there, in /view.
 */
/** The first words of the denial PanCode writes for a card nobody answered (`unattendedPermissionReason`). */
export const UNATTENDED_REFUSAL = /^The operator did not answer this \S+ approval within (\d+) s/u;
/** A card a person denied: `User` at this terminal, or an attached approver by name (`overlay-permission-lifecycle`). */
export const DENIED_AT_PROMPT = /^(?:User|attach \S+(?: \([^)]*\))?) denied this call at the permission prompt/u;

function refusalTail(reason: string): string {
	// `The operator did not answer…, so PanCode…` lost its point to the cut; the operator is the reader here.
	const unattended = UNATTENDED_REFUSAL.exec(reason);
	if (unattended) return `no answer in ${unattended[1]} s, so PanCode denied it`;
	const clause = blockReasonClause(reason);
	if (/^User denied this call/u.test(clause)) return clause.replace(/^User denied/u, "you denied");
	// An attached approver's denial already names that client (`attach c2 (apr) denied this call…`).
	// The row already leads with the tool and ends on `✗ blocked`, so the tail keeps only what was refused.
	const blocked = /^\S+ blocked: ([a-z_]+)( in \S+)?$/u.exec(clause);
	return blocked ? `${actionClassWords(blocked[1] ?? "")}${blocked[2] ?? ""}` : clause;
}

function statusGlyph(status: HeaderStatus, meta: StatusMeta = {}): string {
	if (status === undefined) return "";
	const budget = meta.policy?.toolDurations;
	const live = meta.live === undefined ? "" : toolMeta(`${SEP}${meta.live}`);
	if (status === "forming") return ` ${toolMeta(GLYPH.queued)}${toolMeta(" preparing")}${live}`;
	if (status === "ready") return ` ${toolMeta(GLYPH.queued)}${toolMeta(" queued")}${live}`;
	if (status === "running") {
		// The progressive verb already says the call is running; the tail adds
		// only the live mark and the elapsed time.
		const elapsed = liveElapsed(meta.elapsedMs, budget);
		return ` ${theme.fg("activity", GLYPH.running)}${elapsed === null ? "" : toolMeta(` ${elapsed}`)}${live}`;
	}
	const duration = budgetedDuration(meta.durationMs, budget);
	const durationSuffix = duration ? toolMeta(`${SEP}${duration}`) : "";
	if (status === "ok") return ` ${green(STATUS_OK_GLYPH)}${durationSuffix}`;
	if (status === "unfinished") return ` ${yellow(GLYPH.warn)}${durationSuffix}`;
	if (status === "cancelled") return ` ${toolMeta(GLYPH.cancelled)}${durationSuffix}`;
	if (status === "not_run") return ` ${yellow(GLYPH.warn)}${toolMeta(" output limit")}`;
	// A failed row ends on its state, glyph and word, in the error role: `✗ failed`, or the outcome that stands for it
	// (`✗ aborted`, `✗ blocked`). The exit status and a refusal's reason are facts on the row, never a suffix.
	const word = meta.outcome ?? "failed";
	return `${durationSuffix} ${red(`${STATUS_ERROR_GLYPH} ${word}`)}`;
}

/**
 * A refusal that names no rule tells the operator only that something was stopped, so a refused or stopped row
 * states its reason as its last fact, ahead of `✗`. It rides the lead, so a narrow row cuts the reason, never the
 * state.
 */
function refusalReason(status: HeaderStatus, meta: StatusMeta): string {
	if (status !== "error") return "";
	const reason = meta.outcome !== undefined ? meta.blockReason?.trim() : undefined;
	return reason ? toolMeta(`${SEP}${refusalTail(reason)}`) : "";
}

/** A running process whose stop already went out: its card must not keep the live mark beside a stop row. */
function stoppingCall(call: ToolExecutionStart | ToolExecutionFinished): boolean {
	return !("result" in call) && call.stopping === true;
}

/** The stop mark and the call's own clock, in place of the live mark while the process ignores or works through a stop. */
function stoppingGlyph(meta: StatusMeta): string {
	const elapsed = optionalCompactMs(meta.elapsedMs);
	return ` ${theme.fg("warning", GLYPH.cancelled)}${elapsed === null ? "" : toolMeta(` ${elapsed}`)}`;
}

const CLASS_MARKS: Readonly<Record<ToolClass, string>> = {
	observe: GLYPH.toolHeader,
	search: GLYPH.toolHeader,
	knowledge: GLYPH.classKnowledge,
	mutate: GLYPH.classMutate,
	execute: GLYPH.classExecute,
	network: GLYPH.classNetwork,
	delegate: GLYPH.workerAgent,
	interaction: GLYPH.classInteraction,
	external: GLYPH.classExternal,
};

/** The class mark in the gutter with the space that separates it from the verb; a failed call's in the error role. */
export function classMark(toolClass: ToolClass, failed = false): string {
	return theme.fg(
		failed ? "error" : toolClass === "execute" ? "shellAction" : "toolGlyph",
		`${CLASS_MARKS[toolClass]} `,
	);
}

/** The row a call reads as, from its redacted arguments and, once settled, its result. */
export function resolveRow(call: ToolExecutionStart | ToolExecutionFinished): ResolvedToolRow {
	const finished = "result" in call ? call : null;
	const context = { cardAttached: call.cardAttached === true, cwd: process.cwd() };
	if (isChainCall(call)) {
		const args = redactToolArgs(call.args);
		return {
			spec: CHAIN_ROW,
			toolName: call.toolName,
			args: isRecord(args) ? args : {},
			viaGateway: false,
			externalLabel: null,
			context,
		};
	}
	const details = detailsOf(finished?.result);
	const refusedGateway =
		finished?.isError === true &&
		call.viaGateway === true &&
		(finished.outcome === "blocked" ||
			details?.nestedBlockedVerdict !== undefined ||
			(isRecord(details?.refusal) &&
				(details.refusal.kind === "unknown_capability" || details.refusal.kind === "tool_surface")));
	const row = resolveToolRow(
		call.toolName,
		redactToolArgs(call.args),
		details,
		refusedGateway ? undefined : call.actionClass,
		context,
	);
	if (refusedGateway && row.spec.class === "external" && row.externalLabel === null) {
		return { ...row, spec: { ...row.spec, verbs: ["calling", "refused"] }, viaGateway: true };
	}
	return call.viaGateway === true ? { ...row, viaGateway: true } : row;
}

/**
 * A gateway chain is one aggregate action whose steps nest beneath it, one
 * row each (`chainStepRows`). Its own object is the step count; the steps and
 * their bindings never repeat as a `steps ›` argument dump.
 */
const CHAIN_ROW: ResolvedToolRow["spec"] = {
	class: "external",
	verbs: ["chaining", "chained"],
	consumes: ["op", "steps"],
	nouns: ["chain", "chains"],
};

/**
 * Longest object a row states before it cuts with an ellipsis. A wide row
 * states more of a command, up to 120 characters; a question to the operator
 * is the whole point of its row and runs to 160.
 */
function objectLimit(toolClass: ToolClass, width?: number): number {
	if (toolClass === "interaction") return 160;
	if (width === undefined) return ARG_PREVIEW_LIMIT;
	return Math.max(ARG_PREVIEW_LIMIT, Math.min(120, contentWidth(width) - 24));
}

/**
 * The row's object: a command or a pattern in backticks, a URL as its host
 * and path tail, a path as its tail when it must be cut, anything else plain;
 * an MCP or extension capability as `server › tool`. Always one sanitized line.
 */
export function rowObject(
	row: ResolvedToolRow,
	finished: ToolExecutionFinished | null,
	width?: number,
	budget?: number,
): string {
	if (row.externalLabel !== null) {
		const [server, capability] = sanitizeCallTargetText(row.externalLabel).split(` ${UNICODE_GLYPH.crumb} `);
		return `${theme.fg("toolMetadata", server ?? "")}${theme.fg("divider", ` ${GLYPH.crumb} `)}${theme.fg("toolCapability", capability ?? "")}`;
	}
	const skill = finished === null ? null : skillLoadFacts(finished);
	if (skill !== null)
		return `skill ${theme.fg("skillIdentity", truncate(sanitizeCallTargetText(skill.name), ARG_PREVIEW_LIMIT))}`;
	if (row.spec.object === undefined) return sanitizeCallTargetText(row.toolName);
	const display = objectDisplay(row, width, budget);
	if (display === null) return "";
	if (display.style === "url" || display.style === "path") return theme.fg("toolTarget", display.shown);
	const clean = display.shown.length < display.full.length ? `${display.shown}${GLYPH.ellipsis}` : display.shown;
	return theme.fg(
		display.style === "code" ? "toolCommand" : "toolTarget",
		display.style === "code" ? `\`${clean}\`` : clean,
	);
}

/**
 * The object as the row shows it: `full` is the sanitized one-line text, and
 * `shown` is what survives the row's length limit (without the ellipsis). A
 * URL shows as its host and path tail, and a cut path as `…` and its tail,
 * ellipsis included.
 */
export function objectDisplay(
	row: ResolvedToolRow,
	width?: number,
	budget?: number,
): { full: string; shown: string; style?: "code" | "url" | "path" } | null {
	const object = row.spec.object?.(row.args, row.context) ?? null;
	if (object === null) return null;
	if (object.style === "url")
		return { full: object.text, shown: urlLabel(object.text, budget ?? urlBudget(width)), style: "url" };
	const full = displayText(object.text, object.style);
	const limit = budget ?? objectLimit(row.spec.class, width);
	if (object.style === "path") {
		// A path that fits beside its verb stays whole, so no `path ›` row repeats
		// it. One that must be cut leaves room for the outcome too, so its tail
		// and the row's status share the first line.
		if (width === undefined) return { full, shown: full.length <= limit ? full : pathTail(full, limit), style: "path" };
		const whole = Math.min(limit, contentWidth(width) - 10);
		const cut = Math.max(budget === undefined ? 16 : 1, Math.min(limit, contentWidth(width) - 20));
		return { full, shown: full.length <= whole ? full : pathTail(full, cut), style: "path" };
	}
	const shown = full.length <= limit ? full : full.slice(0, Math.max(0, limit - GLYPH.ellipsis.length));
	return object.style === undefined ? { full, shown } : { full, shown, style: object.style };
}

/**
 * A path cut to `limit` characters from the left, so the file name survives:
 * `…/src/net/retry.js`. The tail starts at a directory boundary when one falls
 * inside it.
 */
function pathTail(full: string, limit: number): string {
	const chars = Array.from(full);
	const tail = chars.slice(Math.max(0, chars.length - Math.max(1, limit - GLYPH.ellipsis.length))).join("");
	const slash = tail.indexOf("/");
	return `${GLYPH.ellipsis}${slash > 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
}

export function displayText(value: string, style?: "code" | "url" | "path"): string {
	return sanitizeCallTargetText(style === "code" ? stripShellWrapperForDisplay(value) : value);
}

/**
 * The question and answer pairs a settled call resolved, as its registry row
 * reads them from the structured result. A failed or blocked call resolved
 * nothing.
 */
export function resolvedPairs(row: ResolvedToolRow, finished: ToolExecutionFinished | null): readonly ToolRowPair[] {
	if (finished === null || finished.isError || finished.outcome !== undefined || row.spec.pairs === undefined) return [];
	return row.spec.pairs(row.args, detailsOf(finished.result));
}

/**
 * A single pair rides the row as `→ answer` when the row's object already
 * states its question; every other set nests, one `question → answer` row each.
 */
export function inlinePair(row: ResolvedToolRow, pairs: readonly ToolRowPair[]): ToolRowPair | null {
	const only = pairs.length === 1 ? pairs[0] : undefined;
	if (only === undefined) return null;
	const display = objectDisplay(row);
	return display !== null && display.full === displayText(only.question) ? only : null;
}

export function styledVerb(verb: string, row?: ResolvedToolRow): string {
	const kind =
		row === undefined
			? "builtin"
			: toolFunction(
					row.toolName,
					row.spec.class,
					row.toolName === "context" && row.args.scope === "skills" ? "skill" : classifyResourceRead(row.toolName, row.args),
				);
	return functionText(theme, kind, verb);
}

export function headerLine(
	call: ToolExecutionStart | ToolExecutionFinished,
	status: HeaderStatus,
	meta: StatusMeta,
	width: number,
): string {
	const parts = sublineParts(call, status, meta, width);
	return `${parts.lead}${parts.tail}`;
}

interface SublineParts {
	/** Mark, verb, object and ledger facts. Breakable across wraps. */
	lead: string;
	/**
	 * Status glyph, duration, and any offload path, composed as one unit. A
	 * wrap may fall before the status glyph but never between the glyph, the
	 * duration, and the offload path. Begins with a joining space so it attaches
	 * to the lead's last line when they share a row. Empty for a call with no
	 * status yet.
	 */
	tail: string;
}

export function sublineParts(
	call: ToolExecutionStart | ToolExecutionFinished,
	status: HeaderStatus,
	meta: StatusMeta,
	width?: number,
	objectBudget?: number,
	omitRequester = false,
): SublineParts {
	const finished = "result" in call ? call : null;
	if (isChainCall(call)) return chainSublineParts(call, finished, status, meta);
	const row = resolveRow(call);
	// A refused skill load reads as plainly as a load: what did not load, why,
	// and the move that changes it.
	const refusal = skillRefusalOf(finished);
	// A skill already loaded is a no-op, not a failure (CLI-P56): the row says so without an error glyph.
	if (refusal !== null && refusal.kind === "already-loaded") {
		const lead = `${classMark("knowledge")}${toolMeta("skill")} ${theme.fg("skillIdentity", sanitizeCallTargetText(refusal.name))} ${toolMeta("already loaded")}`;
		return { lead, tail: "" };
	}
	if (refusal !== null) {
		const lead = `${classMark("knowledge", status === "error")}${toolMeta("skill")} ${theme.fg("skillIdentity", sanitizeCallTargetText(refusal.name))} ${functionText(theme, "skill", "not loaded")}${toolMeta(SEP)}${refusalFact(refusal)}${refusalReason(status, meta)}`;
		return { lead, tail: statusGlyph(status, meta) };
	}
	const settled =
		status === "ok" || status === "unfinished" || status === "cancelled" || status === "not_run" || status === "error";
	const notRun = didNotRun(finished);
	// A change the tool refused or failed to apply never landed, so the row
	// must not read "edited" beside its error glyph.
	const failedChange = !notRun && status === "error" && row.spec.class === "mutate";
	const verb =
		status === "forming" || status === "ready"
			? sanitizeCallTargetText(row.toolName)
			: notRun
				? finished?.outcome === "blocked"
					? sanitizeCallTargetText(row.toolName)
					: "not run"
				: failedChange
					? "edit failed"
					: settled
						? row.spec.verbs[1]
						: stoppingCall(call)
							? "stopping"
							: row.spec.verbs[0];
	const target = rowObject(row, finished, width, objectBudget);
	// A call cut off before its arguments named a target still says which tool it was.
	const object =
		(status === "forming" || status === "ready") && stripTerminalSequences(target) === verb
			? ""
			: target.length === 0 && finished?.notRun === true
				? sanitizeCallTargetText(row.toolName)
				: target;
	const scopeText = row.spec.scope?.(row.args, row.context) ?? null;
	const scope = scopeText === null ? "" : ` in ${truncate(sanitizeCallTargetText(scopeText), ARG_PREVIEW_LIMIT)}`;
	const inline = inlinePair(row, resolvedPairs(row, finished));
	const answer =
		inline === null
			? ""
			: ` ${toolMeta(GLYPH.right)} ${theme.fg("body", truncate(sanitizeCallTargetText(inline.answer), ARG_PREVIEW_LIMIT))}`;
	// A resource read names what it read (`handbook`) unless the path the row
	// shows already says so (`docs/retry.md`, `SKILL.md`).
	const resourceLabel = classifyResourceRead(call.toolName, call.args);
	const resource =
		resourceLabel !== null && !stripTerminalSequences(object).toLowerCase().includes(resourceLabel)
			? toolMeta(`${SEP}${resourceLabel}`)
			: "";
	// A process states who started it, because the two read the same otherwise and only one was the model's doing.
	const executed = call.actor !== undefined && !notRun && status !== "forming" && status !== "ready";
	const actor = !executed
		? ""
		: `${toolMeta(call.actor === "operator" ? "you" : "Panos")} ${!settled ? toolMeta(call.actor === "operator" ? "are " : "is ") : ""}`;
	const requestedBy =
		executed && call.requestedBy && !omitRequester
			? toolMeta(` (requested by ${sanitizeCallTargetText(call.requestedBy)})`)
			: "";
	// Arguments the row does not consume never ride the header; detailed states them as the card's `args` row.
	const head = `${classMark(row.spec.class, status === "error")}${actor}${notRun || failedChange ? theme.fg("warning", verb) : styledVerb(verb, row)}${object.length > 0 ? ` ${object}` : ""}${requestedBy}${scope}${answer}${resource}`;
	const provenance = meta.policy === undefined || meta.policy.runSubRows > 0;
	const ledger = finished === null ? null : ledgerTail(finished, row, provenance);
	const local = call.excludeFromContext === true ? toolMeta(`${SEP}not sent to model`) : "";
	// A check here would state the call beside a card whose run may read `!` or `✗`, so the card alone states the outcome.
	// A tally of runs states their outcomes itself, worst first, so it carries no `✓` beside a `1 failed` either.
	// The batch's elapsed time is the run's own fact, so it shows at every tier, a failed batch's included.
	const tallied =
		row.spec.class === "delegate" && finished !== null && numberField(detailsOf(finished.result), "runCount") !== null;
	const cardDuration = optionalCompactMs(meta.durationMs);
	const tail =
		status === "ok" && (row.context.cardAttached === true || tallied)
			? cardDuration === null
				? ""
				: toolMeta(`${SEP}${cardDuration}`)
			: stoppingCall(call) && status === "running"
				? stoppingGlyph(meta)
				: status === "running" && row.spec.class === "interaction"
					? // The person owns this wait: a ticking `● 5.7s` read as PanCode still working on it (HS11).
						` ${theme.fg("attentionRail", GLYPH.phaseBlocked)}${toolMeta(" waiting for you")}`
					: // A failed batch keeps its elapsed at every tier too, then ends on its state.
						statusGlyph(status, status === "error" && tallied ? { ...meta, policy: undefined } : meta);
	const reason = refusalReason(status, meta);
	return ledger !== null
		? { lead: `${head}${ledger.facts}${reason}`, tail: `${tail}${ledger.offload}` }
		: { lead: `${head}${local}${reason}`, tail };
}

/** A question the operator dismissed finished cleanly, but nothing was answered, so its mark is not a success. */
export function settledStatus(finished: ToolExecutionFinished): HeaderStatus {
	if (finished.notRunCause !== undefined) return "not_run";
	// A delegation whose worker was cancelled did not fail; its card under the row already says who stopped it.
	if (finished.isError) {
		const details = detailsOf(finished.result);
		if (details?.outcome === "canceled" || finished.cardsCancelled === true) return "cancelled";
		// A command the run ended under, by a stop or the host, did not fail on its own: it wears ⊘ like the turn's
		// receipt beside it rather than ✗. Its own timeout is still a failure.
		if (details?.aborted === true && details.timedOut !== true && resolveRow(finished).spec.class === "execute")
			return "cancelled";
		return "error";
	}
	const details = detailsOf(finished.result);
	if (resolveRow(finished).spec.class === "interaction" && details?.cancelled === true) return "cancelled";
	// A wait that ran out its own timeout (monitor wait or collect, a pane wait) returned, but what it waited on has
	// not settled: `timed out ✓` read as the work being done.
	return details?.timedOut === true ? "unfinished" : "ok";
}

function sublineStatus(call: ToolExecutionStart | ToolExecutionFinished): HeaderStatus {
	// Discriminate on `result` rather than `isError`: only `ToolExecutionFinished`
	// carries a `result` field, so a `ToolExecutionStart` with a stray
	// `isError: false` (e.g. from a future event-shape change) cannot trip the
	// finished path. `result` is the type's load-bearing field.
	if (!("result" in call)) return call.phase ?? "running";
	return settledStatus(call);
}

/** Live previews keep the phase beside the target even when arguments grow. */
export function singleActionLine(lead: string, tail: string, width: number): string {
	const status = truncateToWidth(tail, Math.max(0, width - 1), GLYPH.ellipsis);
	const budget = Math.max(1, width - visibleWidth(status));
	return theme.base("toolSummary", releaseSpaces(`${truncateToWidth(lead, budget, GLYPH.ellipsis)}${status}`));
}

export function previewActionRows(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	live?: string,
	policy?: TierPolicy,
): string[] {
	if ("result" in call && skillRefusalOf(call) !== null) return renderToolSubline(call, width, policy);
	const status = sublineStatus(call);
	const meta: StatusMeta =
		"result" in call
			? { durationMs: call.durationMs, outcome: call.outcome, blockReason: call.blockReason, policy }
			: { elapsedMs: call.elapsedMs, live, policy };
	let parts = sublineParts(call, status, meta, width);
	// A narrow row gives up who requested the call before any of the command it ran.
	if (visibleWidth(`${parts.lead}${parts.tail}`) > width)
		parts = sublineParts(call, status, meta, width, undefined, true);
	const overflow = visibleWidth(`${parts.lead}${parts.tail}`) - width;
	// Under 60 columns the row would have to give up the command it names or cut
	// a fact in half to stay on one line, so it wraps between its facts instead.
	// A path or URL keeps its own tail when cut, so only a command wraps.
	if (overflow > 0 && width < 60 && objectDisplay(resolveRow(call), width)?.style === "code")
		return cardHead(parts.lead, parts.tail, width).map((line) => theme.base("toolSummary", line));
	if (overflow > 0) {
		const row = resolveRow(call);
		const finished = "result" in call ? call : null;
		const targetWidth = visibleWidth(rowObject(row, finished, width));
		parts = sublineParts(call, status, meta, width, Math.max(1, targetWidth - overflow - 2), true);
	}
	return [singleActionLine(parts.lead, parts.tail, width)];
}

/** Stable action identity, outcome, and captured-result metadata; `policy` budgets it as a tier's transcript row. */
export function renderToolSubline(
	wire: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	policy?: TierPolicy,
): string[] {
	const call = presentedCall(wire);
	const status = sublineStatus(call);
	const meta: StatusMeta =
		"result" in call
			? { durationMs: call.durationMs, outcome: call.outcome, blockReason: call.blockReason, policy }
			: { elapsedMs: call.elapsedMs, policy };
	// A failed call always shows its bounded body, which carries the diagnosis;
	// the row states the outcome once and never excerpts the body onto itself.
	const parts = sublineParts(call, status, meta, width);
	return cardHead(parts.lead, parts.tail, width).map((line) => theme.base("toolSummary", line));
}

/**
 * What a call's row states, as one line of plain text with its class mark and
 * without its outcome tail: `$ ran \`npm test\` · exit 1`. `/view` titles the
 * call with it, so the list reads like the transcript.
 */
export function toolRowTitle(wire: ToolExecutionStart | ToolExecutionFinished): string {
	const call = presentedCall(wire);
	const status = sublineStatus(call);
	const meta: StatusMeta = "result" in call ? { outcome: call.outcome } : {};
	return releaseSpaces(stripTerminalSequences(sublineParts(call, status, meta).lead));
}

/**
 * The chain's own row: `◇ chained 3 steps · 1 failed · 1 not run ✗ · 1.2s`.
 * What each step did is stated on its nested row, never here.
 */
function chainSublineParts(
	call: ToolExecutionStart | ToolExecutionFinished,
	finished: ToolExecutionFinished | null,
	status: HeaderStatus,
	meta: StatusMeta,
): SublineParts {
	const settled =
		status === "ok" || status === "unfinished" || status === "cancelled" || status === "not_run" || status === "error";
	const verb =
		status === "forming" || status === "ready"
			? sanitizeCallTargetText(call.toolName)
			: didNotRun(finished)
				? finished?.outcome === "blocked"
					? "blocked"
					: "not run"
				: CHAIN_ROW.verbs[settled ? 1 : 0];
	const steps = finished === null ? [] : gatewayChainSteps(finished.toolName, finished.result);
	const pending = finished === null ? [] : gatewayChainPending(finished.result);
	const planned = gatewayChainPlan(call.toolName, call.args).length;
	const count = steps.length + pending.length > 0 ? steps.length + pending.length : planned;
	const facts: string[] = [];
	const failed = steps.filter((step) => step.isError).length;
	if (failed > 0) facts.push(`${failed} failed`);
	if (pending.length > 0) facts.push(`${pending.length} not run`);
	if (finished?.evictedReason !== undefined) facts.push("evicted", finished.evictedReason);
	const object = count > 0 ? ` ${count} ${count === 1 ? "step" : "steps"}` : "";
	const factText =
		facts.length > 0 ? toolMeta(joinFacts(["", ...facts.map((fact) => sanitizeCallTargetText(fact))])) : "";
	return {
		lead: `${classMark(CHAIN_ROW.class, status === "error")}${styledVerb(verb, resolveRow(call))}${object}${factText}${refusalReason(status, meta)}`,
		tail: statusGlyph(status, meta),
	};
}
