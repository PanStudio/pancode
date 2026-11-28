// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The dispatch board's row model and the shared presentation of one run: status, origin, usage, evidence, and card key-value lines. */

import type { Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import type { HostVerificationStatus } from "../core/telemetry/run-vocabulary.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { RunToolBudgetEnvelope } from "../domains/dispatch/budget-envelope.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import { completedRunCaveat } from "../domains/dispatch/failure-headline.js";
import type { DispatchRequestOrigin, RunKind } from "../domains/dispatch/types.js";
import { runKindSupportsLiveSteering } from "../domains/dispatch/types.js";
import type { TrustSummaryProjection, TrustVerdict } from "../domains/evidence/trust-projection.js";
import type { TelemetryRunSummary } from "../domains/telemetry/contract.js";
import type { TelemetrySnapshot } from "../domains/telemetry/index.js";
import type { WorkerAction, WorkerProgressSnapshot } from "../domains/telemetry/worker-progress.js";
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import type { FleetPlanRunView } from "./fleet-plan-runs.js";
import type { RouteFirstOutput } from "./footer/silence-note.js";
import type { CommitPlacement } from "./renderers/worker-answer.js";
import type { PancodeTheme, PancodeToken } from "./theme/index.js";
import {
	fitUnits,
	formatElapsed,
	functionText,
	GLYPH,
	pancodeTheme,
	spinnerFrame,
	toolFunction,
} from "./theme/index.js";
import { finishedActionFault, workerActionParts } from "./worker-activity.js";

export type DispatchBoardStatus = TelemetryRunSummary["status"];

export interface DispatchRetryPresentation {
	attempt: number;
	dueAtMs: number;
	reason: string;
}

export interface DispatchSteerAcknowledgement {
	receivedAtMs: number;
	chars: number;
}

export interface DispatchWriteRecordDowngrade {
	reason: "opaque_tool_succeeded";
	tool: string;
	toolCallId: string;
}

export interface DispatchBoardRow {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	runtimeKind: RunKind;
	runtimeId: string;
	targetId: string;
	wireModelId: string;
	/** Canonical inference scheduler and its independent request-slot bound. */
	endpoint?: { key: string; label: string; limit: number };
	/** Sanitized, one-line summary of the task assigned to this run. */
	taskSummary?: string;
	/** Immutable budget admission provenance for this run. */
	budget?: RunToolBudgetEnvelope;
	status: DispatchBoardStatus;
	elapsedMs: number;
	telemetry?: RunTelemetryV1 | null;
	/** Tokens and cost from the telemetry read model; never the projection's own tally (#434 §11.3). */
	usage: DispatchRunUsage;
	/** The run's first call's TTFT as the read model displays it; null before that call settles (#434). */
	ttft: string | null;
	/** This session's worker calls on the run's route, for saying whether a silent wait is unusual; running rows only. */
	routeFirstOutput?: RouteFirstOutput | null;
	outcomeDetail?: string | null;
	/** Fleet node id; absent renders as the local node. */
	node?: string;
	/** Another PanCode process owns the run: it takes no steering from here, and a cancel goes to its owner as a request. */
	foreign?: true;
	/** Review/compete gate badge (role + cycle). */
	gate?: { role: string; cycle: number };
	council?: { group: string; label: string; color?: string; round: number };
	/** Orchestrator-executed declared verification status. */
	hostVerification?: HostVerificationStatus;
	/**
	 * The canonical trust projection of the sealed receipt, read back from
	 * disk and authenticated against the ledger row. Absent while the run is
	 * live or when the receipt could not be read back, so the card never
	 * implies a verdict the terminal bus event cannot carry.
	 */
	trust?: TrustSummaryProjection;
	/** Which validator failed and on what evidence, beside a validation-failed verdict. */
	validationFailure?: string;
	/** A completed review's failing checks, so the row reads as a review that found issues, not a failed run. */
	reviewFindings?: number;
	/** How the settled run finished beside its outcome, for the caveat the worker card shows too. */
	completion?: { toolCalls?: number; refusedCalls?: number; guardedCalls?: number; contract?: string };
	/** Read back from the run ledger because it settled before this PanCode process started (J2-F16). */
	earlier?: true;
	/** When the run settled, or started while it has not; what the board orders settled runs by, newest first. */
	settledAtMs?: number;
	/** Dead-node failover hops recorded on this run's chain. */
	rerouteCount?: number;
	/** Assignment retry attempts observed on the assignment event stream. */
	failoverHops?: number;
	/** Model context window for the per-worker context meter. */
	contextWindow?: number;
	/** Last assistant message's input+cacheRead+cacheWrite+output: current context occupancy; null until reported. */
	lastContextTokens: number | null;
	/** Tool currently executing in the worker; null between calls. Projected from `progress`. */
	currentTool?: string | null;
	/** Recently finished tools, newest first, bounded. Projected from `progress`. */
	recentTools?: ReadonlyArray<string>;
	/**
	 * The canonical worker-progress projection for this run: the bounded answer
	 * tail, the phase, and the redacted action descriptors. The same projection
	 * the transcript's worker block reads, so opening a run here shows what the
	 * worker is doing rather than a richer spinner.
	 */
	progress?: WorkerProgressSnapshot;
	resultContract?: TelemetryRunSummary["resultContract"];
	/** Where a settled run's proposed commit lands; absent when the board has not read the run's result. */
	commitPlacement?: CommitPlacement;
	/**
	 * Id of the run record sealed for this run (the id `pancode fleet view`
	 * takes). Set only once a terminal dispatch event has
	 * been published, which the dispatch domain does after recordReceipt, so a
	 * running row carries no receipt id and never implies evidence that does
	 * not exist yet.
	 */
	runRecordId?: string;
	/** Waiting retry projected from the live dispatch snapshot. */
	retry?: DispatchRetryPresentation;
	/** Most recent worker delivery acknowledgement for an operator steer. */
	steerAcknowledgement?: DispatchSteerAcknowledgement;
	/** First successful opaque call that opened this run's write record. */
	writeRecordDowngrade?: DispatchWriteRecordDowngrade;
	/**
	 * Where this run sits in a fleet plan: the wave the step was scheduled in
	 * and the step id it executes. Present only for runs a fleet plan
	 * dispatched, so a `/run`, a delegation, or a dispatch-tool run leaves the
	 * board's phase column empty rather than claiming a position it has none of.
	 */
	phase?: DispatchBoardPhase;
	/** Set on the row standing for a whole fleet plan rather than one worker. */
	plan?: FleetPlanRunView;
}

/**
 * A run's tokens and cost as the bound session's telemetry view reads them (#434 §11.3): `unavailable` without a
 * read model, `pending` until the session's journal references the run.
 */
export type DispatchRunUsage =
	| { kind: "unavailable" }
	| { kind: "pending" }
	| { kind: "ready"; prompt: Quantity; output: Quantity; total: Quantity; usd: Quantity };

/** What every run surface says of a run's usage, so the board, the footer and /usage word it identically. */
export interface DispatchUsageText {
	prompt: string;
	output: string;
	total: string;
	cost: string;
	/** Output tokens when every call reported them; a rate over a partial or estimated count would mislead. */
	measuredOutput: number | null;
}

const UNAVAILABLE_USAGE: DispatchUsageText = {
	prompt: "n/a",
	output: "n/a",
	total: "n/a",
	cost: "not available",
	measuredOutput: null,
};
/** The fact separator, from the glyph table so ASCII mode replaces it. */
export const SEP = ` ${GLYPH.sep} `;
const PENDING_USAGE: DispatchUsageText = {
	prompt: GLYPH.none,
	output: GLYPH.none,
	total: GLYPH.none,
	cost: GLYPH.none,
	measuredOutput: null,
};

function measuredCount(fact: Quantity["fact"]): number | null {
	if ("kind" in fact) return fact.kind === "measured" ? fact.value : null;
	return fact.unknownCount === 0 && fact.coverage.estimated === 0 && fact.coverage.measured > 0 ? fact.measured : null;
}

export function dispatchUsageText(usage: DispatchRunUsage): DispatchUsageText {
	if (usage.kind === "unavailable") return UNAVAILABLE_USAGE;
	if (usage.kind === "pending") return PENDING_USAGE;
	return {
		prompt: usage.prompt.display,
		output: usage.output.display,
		total: usage.total.display,
		cost: usage.usd.display,
		measuredOutput: measuredCount(usage.output.fact),
	};
}

/** Output tokens per wall second, or null when the output is not wholly measured or nothing ran yet. */
export function wallTokenRate(row: DispatchBoardRow, _usage: DispatchUsageText): string | null {
	const rate = row.telemetry?.activity.outputPerSecond;
	return row.status !== "enqueued" && rate?.fact.kind === "measured" ? rate.display : null;
}

/** One fleet plan position: the wave index and the step the run executes. */
export interface DispatchBoardPhase {
	wave: number;
	stepId: string;
}

/** Live HTTP/SDK rows are the only rows whose runtime can consume operator guidance. */
export function isDispatchBoardRowSteerable(row: DispatchBoardRow): boolean {
	return (
		row.plan === undefined &&
		// Steering reaches only a worker this process holds the input channel of.
		row.foreign !== true &&
		runKindSupportsLiveSteering(row.runtimeKind) &&
		// A queued run has no worker yet, and a stale one has stopped answering, so a message would reach no one. A
		// stale worker that speaks again is running again, and takes messages again.
		row.status === "running"
	);
}

/** Dispatch abort owns active workers and retry timers, but never terminal history. */
export function isDispatchBoardRowCancellable(row: DispatchBoardRow): boolean {
	// A plan stops through the stop its runner holds, which only the process that started it has.
	if (row.plan !== undefined) return row.plan.state === "running" && row.plan.stoppable === true;
	return row.status === "running" || row.status === "stale" || row.status === "enqueued" || row.status === "retrying";
}

/** Rows of worker prose an expanded card shows before it defers to `/view`. */
export const WORKER_PROGRESS_CARD_ROWS = 6;

export const STATUS_ORDER: Record<DispatchBoardStatus, number> = {
	running: 0,
	cancelling: 1,
	stale: 2,
	retrying: 3,
	enqueued: 4,
	dead: 5,
	failed: 6,
	aborted: 7,
	completed: 8,
};

/**
 * The agent's own name, unadorned. Audience is carried by
 * {@link agentAudiencePresentation}, never by a name prefix: `sh:scout` reads
 * as an agent literally called "sh:scout", and an operator cannot tell a
 * prefix apart from user data at a glance.
 */
export function agentDisplayLabel(row: Pick<DispatchBoardRow, "agentId" | "agentAudience">): string {
	return row.agentId;
}

export interface AgentAudiencePresentation {
	glyph: string;
	token: PancodeToken;
}

/**
 * Visual treatment for a run PanCode started for itself: the sub-process glyph in
 * the subordinate orange tone for shadow and internal harness
 * machinery. Returns null for base/custom agents, which the operator asked for
 * directly and which therefore render like any other row.
 */
function agentAudiencePresentation(row: Pick<DispatchBoardRow, "agentAudience">): AgentAudiencePresentation | null {
	if (row.agentAudience === "shadow") return { glyph: GLYPH.subProcess, token: "shadowDispatchAction" };
	if (row.agentAudience === "internal") return { glyph: GLYPH.subProcess, token: "shadowDispatchAction" };
	return null;
}

export interface DispatchOriginPresentation {
	glyph: string;
	token: PancodeToken;
}

/**
 * Who asked for this run, as the transcript spells it: hollow for the
 * operator's own `/run` or `/delegate`, filled for one the model started by
 * calling a dispatch tool, a quiet dot for the runs PanCode starts for itself and
 * never puts on the transcript. A running `◇` on the board is therefore the
 * operator's own work, on the board and in the footer both.
 *
 * This is a different axis from {@link agentAudiencePresentation}, which says
 * who picked the agent. An operator who approves a plan gets user-origin runs
 * on shadow agents, so a row can carry both marks and mean two true things.
 *
 * Returns null for a row whose origin never reached the projection, so an
 * unknown origin renders as nothing rather than claiming to be internal.
 * Harness runs use the quiet internal dot in the operator's color because PanCode acts on their behalf.
 *
 * Operator and harness runs take the guidance color. The transcript block paints an
 * agent-origin run in action orange because it is the one signal on that
 * surface; a board row sits under the fleet summary, which already owns the
 * quadrant's single orange, so here the filled glyph carries origin by shape.
 */
function dispatchOriginPresentation(row: Pick<DispatchBoardRow, "requestOrigin">): DispatchOriginPresentation | null {
	if (row.requestOrigin === "user") return { glyph: GLYPH.workerHuman, token: "guidance" };
	if (row.requestOrigin === "agent") return { glyph: GLYPH.workerAgent, token: "body" };
	if (row.requestOrigin === "internal") return { glyph: GLYPH.workerInternal, token: "annotation" };
	if (row.requestOrigin === "harness") return { glyph: GLYPH.workerInternal, token: "guidance" };
	return null;
}

/**
 * The full glyph lead for a row: origin first, then audience. Reported with its
 * own display width so each caller can reserve columns for it without
 * measuring ANSI.
 */
export function dispatchRowPrefix(
	theme: PancodeTheme,
	row: Pick<DispatchBoardRow, "agentAudience" | "requestOrigin">,
): { text: string; width: number } {
	const origin = dispatchOriginPresentation(row);
	const audience = agentAudiencePresentation(row);
	const text = `${origin === null ? "" : `${theme.fg(origin.token, origin.glyph)} `}${audience === null ? "" : `${theme.fg(audience.token, audience.glyph)} `}`;
	const width =
		(origin === null ? 0 : visibleWidth(origin.glyph) + 1) + (audience === null ? 0 : visibleWidth(audience.glyph) + 1);
	return { text, width };
}

export interface DispatchStatusPresentation {
	glyph: string;
	label: string;
	/** A live glyph uses the activity accent; its phase word uses the dispatch role. */
	glyphToken?: PancodeToken;
	token: PancodeToken;
}

/**
 * One presentation per run status, shared by the dispatch cards, the task
 * island, and the footer worker lines so a status never changes glyph or color
 * between surfaces. `compact` shortens labels for narrow rows; a `tick`
 * animates the running glyph.
 */
export function dispatchStatusPresentation(
	status: DispatchBoardStatus,
	options: { compact?: boolean; tick?: number } = {},
): DispatchStatusPresentation {
	const compact = options.compact === true;
	switch (status) {
		case "running":
			// Glyph and phase have distinct roles; identities and telemetry stay separate.
			return {
				glyph: options.tick !== undefined ? spinnerFrame(options.tick) : GLYPH.running,
				label: "running",
				glyphToken: "activity",
				token: "dispatchAction",
			};
		case "cancelling":
			// The card and the strip say stopping while the process exits, so the board's status cell does too.
			return { glyph: GLYPH.cancelled, label: "stopping", token: "warning" };
		case "retrying":
			return { glyph: GLYPH.phaseRetry, label: "retrying", token: "warning" };
		case "completed":
			return { glyph: GLYPH.ok, label: compact ? "done" : "completed", token: "success" };
		case "failed":
			return { glyph: GLYPH.error, label: compact ? "fail" : "failed", token: "error" };
		case "dead":
			// The watchdog stopped a worker whose heartbeat went silent: the inline card's words, not the ledger's.
			return { glyph: GLYPH.error, label: "stopped responding", token: "error" };
		case "aborted":
			return { glyph: GLYPH.cancelled, label: "cancelled", token: "annotation" };
		case "stale":
			return { glyph: GLYPH.warnInline, label: "not responding", token: "warning" };
		case "enqueued":
			return { glyph: GLYPH.queued, label: "queued", token: "body" };
	}
}

/** Evidence-readiness state for a dispatch run, derived from the telemetry projection. */
export type EvidenceState = "ready" | "none";

/**
 * Compact, presentation-ready evidence readiness for one run. Derived purely
 * from a TelemetrySnapshot: no run scope is read and no /view artifact bodies
 * are inspected. `viewFilter` is the `/view` deep-link an operator would type
 * to inspect the run or its assessment.
 */
export interface RunEvidencePresentation {
	state: EvidenceState;
	/** The `/view` filter text: evidence:<runId> once assessed, dispatch:<runId> before. */
	viewFilter: string;
}

/**
 * Fold a TelemetrySnapshot into the evidence readiness for one run: a run whose assessment the projection saw is
 * ready (#434). Cheap and pure; it reads no run scope.
 */
export function deriveRunEvidenceState(
	snapshot: TelemetrySnapshot | undefined,
	runId: string,
): RunEvidencePresentation {
	if (!snapshot || runId.length === 0) return { state: "none", viewFilter: `dispatch:${runId}` };
	if (snapshot.runs.find((run) => run.runId === runId)?.evidence)
		return { state: "ready", viewFilter: `evidence:${runId}` };
	return { state: "none", viewFilter: `dispatch:${runId}` };
}

interface EvidenceGlyphPresentation {
	glyph: string;
	word: string;
	token: PancodeToken;
}

// Proof state shares the section 5 glyph language with run status: the ok check for an assessed run. `none` renders
// no marker.
export function evidenceStatePresentation(state: EvidenceState): EvidenceGlyphPresentation | null {
	return state === "ready" ? { glyph: GLYPH.ok, word: "ready", token: "success" } : null;
}

// Dispatch card rows follow the footer dashboard key-value grammar: a dim key
// padded to a shared column, then one trailing space before the value. The
// widest key ("telemetry") sets the column so every value starts aligned.
export const CARD_KV_KEY_WIDTH = "telemetry".length;

export function cardKvKey(theme: PancodeTheme, key: string): string {
	return theme.fg("fieldName", `${key.padEnd(CARD_KV_KEY_WIDTH)} `);
}

// A card key-value row built from whole units. A row that fits keeps its dim
// separator join, the one `fitUnits` draws; an overflowing one is refit unit-by-unit so it closes on a
// whole unit or a dim ellipsis instead of a mid-token clip that reads as a
// complete fact ("total 5" for 5.2k) or a dangling ` · `.
export function cardUnitsLine(
	theme: PancodeTheme,
	key: string,
	units: ReadonlyArray<string>,
	contentWidth: number,
): string {
	const prefix = cardKvKey(theme, key);
	const full = `${prefix}${units.join(theme.fg("divider", SEP))}`;
	return visibleWidth(full) <= contentWidth ? full : fitUnits(theme, prefix, units, contentWidth);
}

/** A prose card value, wrapped inside the columns left by its one-time key. */
export function cardWrappedValueLines(theme: PancodeTheme, key: string, value: string, contentWidth: number): string[] {
	const prefix = cardKvKey(theme, key);
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, contentWidth - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
}

export function retryCountdown(retry: DispatchRetryPresentation, now = Date.now()): string {
	const remainingMs = Math.max(0, retry.dueAtMs - now);
	return remainingMs === 0 ? "now" : `in ${formatElapsed(remainingMs)}`;
}

/** Soften raw tool slugs on `/fleet` action rows: omit `code_nav` (already named by `navigated`) and space snake_case. */
function displayActionTool(tool: string | null): string | null {
	if (tool === null || tool === "code_nav") return null;
	return sanitizeCallTargetText(tool.replace(/_/gu, " "));
}

/**
 * One action in plain words: the verb and object of its redacted descriptor,
 * then the tool when the verb has not named it, as in `ran npm run lint (bash)`.
 * The descriptor was bounded and scrubbed at the worker seam, so this composes
 * text and never inspects an argument.
 */
export function actionPhrase(action: WorkerAction, tense: "running" | "finished"): string {
	const theme = pancodeTheme();
	const parts = workerActionParts(action, tense);
	const verb = functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(parts.verb));
	const object = parts.object.length === 0 ? "" : theme.fg("toolTarget", ` ${sanitizeCallTargetText(parts.object)}`);
	const toolLabel = displayActionTool(parts.tool);
	const tool = toolLabel === null ? "" : theme.fg("toolCapability", ` (${toolLabel})`);
	const fault = finishedActionFault(action);
	const failure = fault === null ? "" : theme.fg(fault.tone, ` ${GLYPH.error} ${fault.words}`);
	return `${verb}${object}${tool}${failure}`;
}

/** How a worker reached its model, in words, for the runtimes that are not an ordinary model call. */
export const RUNTIME_REACH_WORDS: Partial<Record<RunKind, string>> = {
	sdk: "through an agent SDK",
	subprocess: "as a command-line agent",
	"acp-delegation": "delegated to an ACP agent",
};

/**
 * The read model's lower-bound and estimate marks in the glyph vocabulary, so ASCII mode draws `>=` and `~`. The read
 * model keeps `≥` and `≈` in its strings, which other surfaces parse, so the board swaps them only where it draws.
 */
export function boundMark(figure: string): string {
	return figure.replace(/^≥/u, GLYPH.atLeast).replace(/^≈/u, GLYPH.estimate);
}

/** What marks a run that finished as not to be leaned on, so its row cannot read as a plain success. */
const COUNCIL_SYNTHESIS_AGENT = "council-synthesis";

export function completedRunFailure(
	row: Pick<DispatchBoardRow, "status" | "trust" | "completion" | "council" | "agentId">,
): CompletedRunCaveat | null {
	if (row.status !== "completed") return null;
	// A council or poll answers in prose by design, members and synthesis alike, so no-tools says nothing there.
	const synthesizes = row.council !== undefined || row.agentId === COUNCIL_SYNTHESIS_AGENT;
	const { toolCalls, ...completion } = row.completion ?? {};
	return completedRunCaveat({
		...(row.trust !== undefined ? { trust: row.trust } : {}),
		...completion,
		...(toolCalls !== undefined && !synthesizes ? { toolCalls } : {}),
	});
}

/** Who started a run, in words, because the row's glyph only implies it. */
export function runOriginWords(row: Pick<DispatchBoardRow, "requestOrigin">): string | null {
	switch (row.requestOrigin) {
		case "user":
			return "by you";
		case "agent":
			return "by the main agent";
		case "harness":
			return "by PanCode on your behalf";
		case "internal":
			return "by PanCode";
		default:
			return null;
	}
}

function parseOptionalDetail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const detail = value.replace(/\s+/g, " ").trim();
	return detail.length > 0 ? detail : null;
}

/** Only an authenticated independent pass earns the success token; sealed alone is never green. */
export function trustVerdictToken(verdict: TrustVerdict): PancodeToken {
	switch (verdict) {
		case "reviewed":
			return "success";
		case "grounded":
			return "info";
		case "unverified":
			return "body";
		case "compromised":
			return "error";
		default:
			return "annotation";
	}
}

/**
 * Only the two settled verdicts carry a glyph. `◇` and `◆` already mark who
 * started a run on this board, so a hollow diamond here read as an origin.
 */
export function trustVerdictMark(verdict: TrustVerdict): string {
	if (verdict === "reviewed") return `${GLYPH.ok} `;
	if (verdict === "compromised") return `${GLYPH.error} `;
	return "";
}

export function terminalDetail(row: DispatchBoardRow): string | null {
	if (row.status !== "failed" && row.status !== "dead" && row.status !== "aborted") return null;
	return parseOptionalDetail(row.outcomeDetail)?.replace(/^dispatch:\s*/u, "") ?? null;
}

export function isTerminalStatus(status: DispatchBoardStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
}
