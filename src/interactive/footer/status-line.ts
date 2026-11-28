// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Hybrid B->A bottom-anchored status line renderer.
 *
 * Renders the calm 1-to-2-row default bottom chrome over `FooterDashboardRenderState`
 * (projected from `HarnessFactsSnapshot`):
 *   - Dedicated 1-row alert bar above Row 1 only when a live alert exists.
 *   - Compact busy: 1 plain live-work row + 1 `raisedSurface` identity/context/model row (<= 2 rows).
 *   - Standard / detailed (deck closed): 1 `raisedSurface` status bar + 1 key/whisper row.
 *   - Slimmed anchor bar mode (`deckOpen === true`): 1 `raisedSurface` bar with workspace + keys + fold.
 *
 * Uses zero inline keycaps beside facts, keeps absence silent at compact and standard,
 * uses `GLYPH.sep` and `GLYPH.rail` for ASCII parity, and memoizes by width x tier x revision.
 */

import type { JobRecord } from "../../core/job-types.js";
import { presentationTier, type TierPolicy, tierPolicy, tierRevision } from "../../core/presentation-tier.js";
import { asciiOnly, motionEnabled } from "../../core/terminal-preferences.js";
import { ToolNames } from "../../core/tool-names.js";
import { autonomyModeReadout, autonomyWindowReadout } from "../../domains/safety/autonomy-readout.js";
import { taskBoardCounts } from "../../domains/session/task-board.js";
import { getKeybindings, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { redactSecretString } from "../../lib/secrets/redaction.js";
import { tokensPerSecondText } from "../../session-control/assistant-generation-timing.js";
import type { DispatchBoardRow } from "../dispatch-row-model.js";
import { ACTIVE_DISPATCH_STATUSES, loopSegment } from "../footer-panel.js";
import type { HarnessLearnedFacts, HarnessRouteReadinessData } from "../harness-facts.js";
import { actionKeyLabel, formatKeyLabel } from "../keybinding-manager.js";
import { routeWeeklyQuota } from "../quota-view.js";
import type { AgentStatus } from "../status/index.js";
import { retryCountLabel, spinnerFrame } from "../status/index.js";
import {
	brandMark,
	formatElapsed,
	formatWaitClock,
	GLYPH,
	onRaisedTheme,
	type PancodeTheme,
	type PancodeToken,
	paintRaisedSurfaceRow,
	pancodeTheme,
} from "../theme/index.js";
import { fitPathLabel } from "../theme/labels.js";
import { skinEpoch } from "../theme/tokens.js";
import { type ContextOccupancyFacts, contextRailUnit, thinkingRailUnit } from "./context-rail.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { extensionFactLine, extensionFactsKey } from "./extension-facts.js";
import { footerKeyHint } from "./key-hints.js";
import { phaseElapsedMs } from "./live-work.js";
import { type Notification, notificationGlyph, notificationToken, topNotification } from "./notifications.js";

/** Terminal rows under this are height class H1, reducing every tier to the status bar plus urgent/error alerts. */
const FOOTER_H1_ROWS = 20;
/** Measured cells under this are width class W1, reducing every tier to the status bar plus urgent/error alerts. */
const FOOTER_W1_CELLS = 44;
/** At or under this width the key row keeps immediate controls only. */
const FOOTER_NARROW_CELLS = 60;
/** Below this width `default` autonomy drops from Row 1 (YOLO and non-default never drop). */
const AUTONOMY_DEFAULT_MIN_COLS = 96;
/** Below this width, shell commands drop the `bash ` prefix so the command stays whole. */
const COMMAND_SPACIOUS_COLS = 104;
/** From this width, Row 1 keeps the `<target> · ` prefix and elided `~/…/` or `<parent>/<dir>` cwd. */
const ROUTE_TARGET_MIN_COLS = 112;
/** Minimum alert text cells kept before right-aligned `+N` / dismiss keys ride along (copy.md §11). */
const ALERT_MIN_CELLS_WIDE = 36;
const ALERT_MIN_CELLS_MID = 28;
/** Minimum room left on Row 2 before a right-aligned task/loop segment joins. */
const ROW2_RIGHT_MIN_COLS = 24;
/** Minimum model id width preserved when eliding. */
const MODEL_ID_MIN_CELLS = 12;
/** A yolo window with less than this left escalates to an alert row. */
const WINDOW_ENDING_MS = 5 * 60_000;

const cleanCache = new Map<string, string>();
const clean = (value: string): string => {
	const hit = cleanCache.get(value);
	if (hit !== undefined) return hit;
	const sanitized = sanitizeCallTargetText(redactSecretString(value));
	if (cleanCache.size >= 64) cleanCache.clear();
	cleanCache.set(value, sanitized);
	return sanitized;
};

/** Paint a full-width `raisedSurface` bar with 1-cell left and right padding. */
function paintRaisedRow(theme: PancodeTheme, inner: string, width: number): string {
	return paintRaisedSurfaceRow(theme, inner, width, GLYPH.ellipsis);
}

/** Format left identity for Unicode (`default · dir · branch*`) vs ASCII (`default  dir (branch*)`). */
function formatIdentity(mark: string, autonomyText: string, cwdText: string, branchText: string, sep: string): string {
	if (asciiOnly()) {
		const loc = cwdText && branchText ? `${cwdText} (${branchText})` : cwdText || (branchText ? `(${branchText})` : "");
		const parts = [autonomyText, loc].filter(Boolean);
		return parts.length > 0 ? `${mark} ${parts.join("  ")}` : mark;
	}
	const parts = [autonomyText, cwdText, branchText].filter(Boolean);
	return parts.length > 0 ? `${mark} ${parts.join(sep)}` : mark;
}

/** Word-boundary truncation for alerts and feedback lines. */
function fitNoticeWords(text: string, width: number): string {
	const room = Math.max(1, width);
	if (visibleWidth(text) <= room) return text;
	const cut = truncateToWidth(text, room - (visibleWidth(GLYPH.ellipsis) - 1), "", false);
	const space = cut.lastIndexOf(" ");
	const whole = space >= Math.ceil(room * 0.66) ? cut.slice(0, space).replace(/[\s·:;,]+$/u, "") : null;
	return whole === null ? truncateToWidth(text, room, GLYPH.ellipsis, false) : `${whole}${GLYPH.ellipsis}`;
}

/** Maximum full path length shown verbatim at >= 112 cols before preferring `~/…/<parent>/<dir>`. */
const CWD_FULL_MAX_CELLS = 24;

/** Candidate cwd forms from fullest to basename (`full`: ~/…/parent/dir; `parent`: parent/dir; `base`: dir). */
function pathForms(path: string, style: "full" | "parent" | "base"): string[] {
	const parts = path.split("/");
	const root = parts[0] === "~" ? "~/" : parts[0] === "" ? "/" : "";
	const segments = parts.slice(root === "" ? 0 : 1).filter((part) => part.length > 0);
	const lead = `${root}${GLYPH.ellipsis}/`;
	const forms: string[] = [];
	if (style === "full") {
		const twoSegmentElided = segments.length > 2 ? `${lead}${segments.slice(-2).join("/")}` : null;
		if (visibleWidth(path) <= CWD_FULL_MAX_CELLS) forms.push(path);
		if (twoSegmentElided !== null) forms.push(twoSegmentElided);
		if (visibleWidth(path) > CWD_FULL_MAX_CELLS && twoSegmentElided === null) {
			forms.push(fitPathLabel(path, CWD_FULL_MAX_CELLS));
		}
	}
	if ((style === "full" || style === "parent") && segments.length >= 2) {
		forms.push(segments.slice(-2).join("/"));
	}
	const base = segments.at(-1);
	if (base !== undefined) forms.push(base);
	if (forms.length === 0) forms.push(path);
	return [...new Set(forms)];
}

/** Elide a long model id keeping its suffix when narrower than `max`. */
export function elideModelId(id: string, max: number): string {
	const room = Math.max(MODEL_ID_MIN_CELLS, max);
	if (visibleWidth(id) <= room) return id;
	const leaf = id.slice(id.lastIndexOf("/") + 1);
	if (leaf.length > 0 && visibleWidth(leaf) <= room) return leaf;
	const source = leaf.length > 0 ? leaf : id;
	if (visibleWidth(source) <= room) return source;
	const mark = visibleWidth(GLYPH.ellipsis);
	const tailLen = Math.max(Math.min(12, room - 5), Math.floor((room - mark) / 2));
	const headLen = Math.max(4, room - mark - tailLen);
	const head = truncateToWidth(source, headLen, "", false);
	const tail = source.slice(-tailLen);
	return truncateToWidth(`${head}${GLYPH.ellipsis}${tail}`, room, GLYPH.ellipsis, false);
}

function workerRowsOf(rows: ReadonlyArray<DispatchBoardRow>): ReadonlyArray<DispatchBoardRow> {
	return rows.filter((row) => row.plan === undefined);
}

export function isMainBusy(status: AgentStatus): boolean {
	return status.phase !== "idle" && status.phase !== "ended";
}

/** Concise phase/command phrase for Row 1 (and compact busy Row 1 / Work island). */
export function renderPhaseSegment(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	width: number,
	room: number,
): string {
	const status = state.status;
	const now = state.now;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const busy = isMainBusy(status);

	if (!busy) {
		const readiness: HarnessRouteReadinessData | null | undefined = state.readiness;
		if (readiness && !readiness.available) {
			const why = clean(readiness.reason).trim();
			const base = width >= 96 ? "route unavailable" : "unavailable";
			const label =
				why.length > 0 && room >= visibleWidth(base) + 4 + Math.min(12, visibleWidth(why)) ? `${base}: ${why}` : base;
			return truncateToWidth(
				`${theme.fg("warning", GLYPH.warn)} ${theme.fg("warning", label)}`,
				Math.max(1, room),
				GLYPH.ellipsis,
				false,
			);
		}
		if (readiness?.health === "down") {
			return truncateToWidth(
				`${theme.fg("error", GLYPH.error)} ${theme.fg("error", `cannot reach ${clean(readiness.targetId)}`)}`,
				Math.max(1, room),
				GLYPH.ellipsis,
				false,
			);
		}
		if (readiness?.lastStop === "error" || (status.phase === "ended" && status.summary?.stopReason === "error")) {
			return truncateToWidth(
				`${theme.fg("error", GLYPH.error)} ${theme.fg("error", width >= 96 ? "last turn failed" : "failed")}`,
				Math.max(1, room),
				GLYPH.ellipsis,
				false,
			);
		}
		if (readiness?.lastStop === "no_answer") {
			return truncateToWidth(
				`${theme.fg("warning", GLYPH.warn)} ${theme.fg("warning", "no answer")}`,
				Math.max(1, room),
				GLYPH.ellipsis,
				false,
			);
		}
		const bg = state.background?.[0];
		if (bg !== undefined) {
			const elapsed = width >= 80 ? formatElapsed(Math.max(0, now - bg.startedAt)) : "";
			const text = elapsed
				? `${theme.fg("activity", GLYPH.running)} ${theme.fg("activity", clean(bg.purpose))}${sep}${theme.fg("counter", elapsed)}`
				: `${theme.fg("activity", GLYPH.running)} ${theme.fg("activity", clean(bg.purpose))}`;
			return truncateToWidth(text, Math.max(1, room), GLYPH.ellipsis, false);
		}
		const liveWorkers =
			state.fleetBandVisible === true || state.fleetBoardOpen === true
				? 0
				: workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
		if (liveWorkers > 0) {
			const countText = `${GLYPH.workerAgent} ${liveWorkers} ${liveWorkers === 1 ? "worker" : "workers"}`;
			const withReady = `${theme.fg("success", `${GLYPH.ok} ready`)}${sep}${theme.fg("activity", countText)}`;
			if (visibleWidth(withReady) <= room) return withReady;
			return truncateToWidth(theme.fg("activity", countText), Math.max(1, room), GLYPH.ellipsis, false);
		}
		return `${theme.fg("success", GLYPH.ok)} ${theme.fg("success", "ready")}`;
	}

	const spin = theme.fg("harnessAction", spinnerFrame(state.tick));
	// Show the live elapsed clock from the first frame (`0s`), never hiding it on phase transitions.
	const clock = formatWaitClock(phaseElapsedMs(status, now));
	const withClock = (
		lead: string,
		subject: string,
		options?: { token?: PancodeToken; shortSubject?: string; compactClockSep?: boolean },
	): string => {
		const token = options?.token ?? "fieldValue";
		const clockSep = options?.compactClockSep === true && width < 80 ? " " : sep;
		const tail = `${clockSep}${theme.fg("counter", clock)}`;
		const overhead = visibleWidth(lead) + 1 + visibleWidth(tail);
		const subjectRoom = Math.max(4, room - overhead);
		const chosen = options?.shortSubject && visibleWidth(subject) > subjectRoom ? options.shortSubject : subject;
		const fitted = truncateToWidth(chosen, subjectRoom, GLYPH.ellipsis, false);
		return `${lead} ${theme.fg(token, fitted)}${tail}`;
	};

	switch (status.phase) {
		case "tool_blocked":
			return `${theme.fg("warning", GLYPH.phaseBlocked)} ${theme.fg("warning", width >= 96 ? "needs approval" : "approval")}`;
		case "cancelling":
			return withClock(theme.fg("counter", GLYPH.cancelled), "stopping", { token: "counter" });
		case "retrying": {
			const count = retryCountLabel(status.retry);
			const left = status.retry?.dueAt !== undefined ? formatWaitClock(Math.max(0, status.retry.dueAt - now)) : clock;
			const label = width < 80 ? (count ? `retry ${count}` : "retry") : count ? `retrying (${count})` : "retrying";
			const tail = `${sep}${theme.fg("counter", left)}`;
			return truncateToWidth(
				`${theme.fg("warning", GLYPH.phaseRetry)} ${theme.fg("warning", label)}${tail}`,
				Math.max(1, room),
				GLYPH.ellipsis,
				false,
			);
		}
		case "stuck":
			return withClock(theme.fg("warning", GLYPH.warn), width >= 80 ? "no output" : "quiet", {
				token: "warning",
				shortSubject: "quiet",
				compactClockSep: true,
			});
		case "preparing":
			return withClock(spin, "preparing");
		case "compacting": {
			const phase =
				state.agent.contextActivity && "phase" in state.agent.contextActivity
					? (state.agent.contextActivity as { phase?: string }).phase
					: undefined;
			const word =
				phase === "summarize"
					? "summarizing"
					: phase === "state"
						? "saving"
						: width >= 96
							? "compacting context"
							: "compacting";
			return withClock(spin, word, { shortSubject: "compacting" });
		}
		case "dispatching": {
			const live = workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
			const count = live > 0 ? `${live} ${live === 1 ? "worker" : "workers"}` : "workers";
			const word = width >= ROUTE_TARGET_MIN_COLS ? `waiting for ${count}` : count;
			return withClock(spin, word, { shortSubject: count });
		}
		case "waiting_model":
			return withClock(spin, width >= 96 ? "waiting for model" : "waiting", { shortSubject: "waiting" });
		case "thinking":
			return withClock(spin, "thinking");
		case "writing":
			return withClock(spin, status.preparingToolCall ? "preparing tool" : "writing", { shortSubject: "writing" });
		case "tool_running": {
			const tool = status.tool;
			const name = tool?.toolName?.trim() ?? "tool";
			if (name === ToolNames.AskUser) {
				return `${theme.fg("warning", GLYPH.phaseBlocked)} ${theme.fg("warning", width >= 80 ? "needs input" : "input")}`;
			}
			if (name === ToolNames.Dispatch) {
				const live = workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
				const count = live > 0 ? `${live} ${live === 1 ? "worker" : "workers"}` : "workers";
				const word = width >= ROUTE_TARGET_MIN_COLS ? `waiting for ${count}` : count;
				return withClock(spin, word, { shortSubject: count });
			}
			if (tool?.judging === true) return withClock(spin, "checking permission", { shortSubject: "checking" });
			const rawSubject = tool?.toolSubject ? clean(tool.toolSubject) : "";
			if (rawSubject.length > 0) {
				const dropBashPrefix = width < COMMAND_SPACIOUS_COLS && (name === ToolNames.Bash || name === "bash");
				const phrase = dropBashPrefix ? `\`${rawSubject}\`` : `${name} \`${rawSubject}\``;
				return withClock(spin, phrase, { compactClockSep: true });
			}
			return withClock(spin, width >= 96 ? `running ${name}` : name, {
				shortSubject: name,
				compactClockSep: true,
			});
		}
		default:
			return withClock(spin, status.phase.replace(/_/gu, " "));
	}
}

/** Autonomy segment for Row 1. Default drops below 72 cols; non-default never drops. */
function renderAutonomySegment(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	width: number,
	short: boolean,
): { text: string; required: boolean } {
	const autonomy = state.session.autonomy ?? "default";
	if (autonomy === "yolo") {
		const confinement = state.session.yoloConfinement === "unconfined" ? "unconfined" : "contained";
		const osSandbox = state.session.autonomyWindow?.osSandbox !== false;
		const readout = autonomyModeReadout({ confinement, osSandbox, narrow: short, dot: GLYPH.sep });
		const label = short && confinement === "contained" && osSandbox ? "YOLO" : readout.text;
		return {
			text: theme.style(readout.tone === "warning" ? "warning" : "yoloLabel", label, { bold: true }),
			required: true,
		};
	}
	if (autonomy !== "default") {
		return { text: theme.fg("annotation", clean(autonomy)), required: true };
	}
	if (width < AUTONOMY_DEFAULT_MIN_COLS || short) return { text: "", required: false };
	return { text: theme.fg("annotation", "default"), required: false };
}

function renderBranchSegment(theme: PancodeTheme, state: FooterDashboardRenderState): string {
	if (state.workspace.branchPending) return "";
	const unnamed = state.workspace.detachedAt !== undefined ? `detached at ${state.workspace.detachedAt}` : "";
	const branch = clean(state.workspace.branch ?? unnamed);
	if (branch === "") return "";
	const dirty =
		state.workspace.dirty === true && (state.workspace.branch != null || state.workspace.detachedAt !== undefined);
	return dirty ? `${theme.fg("branch", branch)}${theme.fg("warning", "*")}` : theme.fg("branch", branch);
}

export function contextOccupancyFrom(state: FooterDashboardRenderState): ContextOccupancyFacts {
	return {
		...(state.context.budget ? { budget: state.context.budget } : {}),
		used: state.context.used,
		contextWindow: state.context.contextWindow,
		toolSchemaTokens: state.context.toolSchemaTokens,
		breakdown: state.context.breakdown ?? null,
		ledger: state.context.budget ? null : (state.context.ledger ?? null),
	};
}

function renderModelSegment(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	includeTarget: boolean,
	maxModelCells: number,
): string {
	const model = state.session.modelId ? clean(state.session.modelId) : null;
	const target = state.session.targetId ? clean(state.session.targetId) : null;
	const rawId = model ?? clean(state.session.target ?? "not configured");
	const fittedModel = elideModelId(rawId, maxModelCells);
	const paintedModel = theme.style("activeModelIdentity", fittedModel, { bold: true });
	if (includeTarget && model !== null && target) {
		return `${theme.fg("footerIdentity", target)}${theme.fg("separator", ` ${GLYPH.sep} `)}${paintedModel}`;
	}
	return paintedModel;
}

/** Build the `raisedSurface` status bar (Row 1 in standard/detailed and compact idle; Row 2 in compact busy). */
function renderStatusBar(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	width: number,
	policy: TierPolicy,
	options: { includePhase: boolean; compactKeysDoor: boolean; inlineFeedback?: Notification | undefined },
): string {
	const theme = onRaisedTheme(baseTheme);
	const innerWidth = width >= 4 ? width - 2 : width;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const railSep = theme.fg("separator", ` ${GLYPH.rail} `);
	const isCompact = !policy.hintRow;
	const busy = isMainBusy(state.status);
	const mark = brandMark(theme);
	const survival = width < FOOTER_W1_CELLS;

	// Build right side candidates matching copy.md §3 step-downs:
	// - standard/detailed idle: 120+ marks+target, 96 marks, 80 word, 60 ctx-bar only
	// - standard/detailed busy: 120+ target (no thinking), 96/80 ctx-bar (no thinking), 60 percent-only (no `ctx `)
	// - compact (idle & busy Row 2): 120+/96 word, 80 ctx-bar only, 60 percent-only (no `ctx `)
	const contextFacts = contextOccupancyFrom(state);
	const thinking = state.thinking;
	const hasThinking =
		thinking !== undefined && !thinking.quiet && (thinking.hasLevels || thinking.note !== undefined) && !survival;
	const initialThink: "marks" | "word" | "none" = !hasThinking
		? "none"
		: isCompact
			? width >= 96
				? "word"
				: "none"
			: busy
				? "none"
				: width >= 96
					? "marks"
					: width >= 80
						? "word"
						: "none";
	let cachedThinkingMarks: string | null | undefined;
	let cachedThinkingWord: string | null | undefined;
	let cachedCtxBar: string | undefined;
	let cachedCtxBare: string | undefined;
	let cachedCtxPercent: string | undefined;
	const getThinkingMarks = (): string | null => {
		if (cachedThinkingMarks === undefined) {
			cachedThinkingMarks = initialThink === "marks" && thinking ? thinkingRailUnit(theme, thinking, "marks") : null;
		}
		return cachedThinkingMarks;
	};
	const getThinkingWord = (): string | null => {
		if (cachedThinkingWord === undefined) {
			cachedThinkingWord =
				(initialThink === "marks" || initialThink === "word") && thinking
					? thinkingRailUnit(theme, thinking, "word")
					: null;
		}
		return cachedThinkingWord;
	};
	const getCtxBar = (): string => {
		if (cachedCtxBar === undefined) {
			cachedCtxBar = survival ? "" : contextRailUnit(contextFacts, theme, { bar: 6, pair: false });
		}
		return cachedCtxBar;
	};
	const getCtxBare = (): string => {
		if (cachedCtxBare === undefined) {
			cachedCtxBare = contextRailUnit(contextFacts, theme, { bar: 0, pair: false });
		}
		return cachedCtxBare;
	};
	const getCtxPercent = (): string => {
		if (cachedCtxPercent === undefined) {
			cachedCtxPercent = contextRailUnit(contextFacts, theme, { bar: 0, pair: false, prefix: false });
		}
		return cachedCtxPercent;
	};
	const initialCtx: "bar" | "bare" | "percent" | "none" = survival
		? "none"
		: width < 80 && (isCompact || busy)
			? "percent"
			: "bar";
	const doorSuffix = options.compactKeysDoor ? `${sep}${theme.fg("keyboardHint", "?")}` : "";
	const rightSep = isCompact ? sep : railSep;
	const feedbackText = options.inlineFeedback ? clean(options.inlineFeedback.text) : null;
	const compactWorkspace =
		isCompact && feedbackText === null && state.workspaceLine?.trim() ? state.workspaceLine.trim() : null;

	const buildRight = (cfg: {
		ctx: "bar" | "bare" | "percent" | "none";
		think: "marks" | "word" | "none";
		target: boolean;
		modelMax: number;
		feedbackMax?: number;
	}): string => {
		const parts: string[] = [];
		if (feedbackText && (cfg.feedbackMax ?? 0) > 0) {
			parts.push(formatCalmFeedback(theme, feedbackText, cfg.feedbackMax ?? 24));
		} else if (compactWorkspace && (cfg.feedbackMax ?? 0) > 0) {
			parts.push(truncateToWidth(compactWorkspace, cfg.feedbackMax ?? 24, GLYPH.ellipsis, false));
		} else {
			const ctxText =
				cfg.ctx === "bar" ? getCtxBar() : cfg.ctx === "bare" ? getCtxBare() : cfg.ctx === "percent" ? getCtxPercent() : "";
			if (ctxText) parts.push(ctxText);
			const thinkText = cfg.think === "marks" ? getThinkingMarks() : cfg.think === "word" ? getThinkingWord() : null;
			if (thinkText) parts.push(thinkText);
		}
		parts.push(`${renderModelSegment(theme, state, cfg.target, cfg.modelMax)}${doorSuffix}`);
		return parts.join(rightSep);
	};

	const cwdStyle = width >= ROUTE_TARGET_MIN_COLS ? (isCompact ? "parent" : "full") : "base";
	const cwdList = pathForms(clean(state.workspace.cwd), cwdStyle);
	const branch = renderBranchSegment(theme, state);
	const dropCwdFirst = width < 80 && branch !== "" && (isCompact || busy);

	const buildLeft = (cfg: {
		autonomy: "full" | "short" | "none";
		cwdIndex: number; // -1 = omitted
		branch: boolean;
		phaseRoom: number;
	}): string => {
		const auto =
			cfg.autonomy === "none"
				? renderAutonomySegment(theme, state, width, true)
				: renderAutonomySegment(theme, state, width, cfg.autonomy === "short");
		const autoText = auto.text && (cfg.autonomy !== "none" || auto.required) ? auto.text : "";
		const chosenCwd = cfg.cwdIndex >= 0 ? cwdList[Math.min(cfg.cwdIndex, cwdList.length - 1)] : undefined;
		const cwdText = chosenCwd ? theme.fg("workspacePath", chosenCwd) : "";
		const branchText = cfg.branch ? branch : "";
		const identity = formatIdentity(mark, autoText, cwdText, branchText, sep);
		if (!options.includePhase || cfg.phaseRoom <= 0) return identity;
		const phase = renderPhaseSegment(theme, state, width, cfg.phaseRoom);
		return `${identity}${railSep}${phase}`;
	};

	const includeTarget = !isCompact && width >= ROUTE_TARGET_MIN_COLS;
	// Try progressive shedding plans until left + gap(2) + right <= innerWidth.
	type Plan = {
		target: boolean;
		autonomy: "full" | "short" | "none";
		cwdIndex: number;
		branch: boolean;
		think: "marks" | "word" | "none";
		ctx: "bar" | "bare" | "percent" | "none";
		modelMax: number;
		phaseMin: number;
		feedbackMax?: number;
	};
	const firstCwd = dropCwdFirst ? -1 : 0;
	const elidedCwd = dropCwdFirst ? -1 : Math.min(1, Math.max(0, cwdList.length - 1));
	const lastCwd = dropCwdFirst ? -1 : Math.max(0, cwdList.length - 1);
	const idlePhaseNatural =
		options.includePhase && !busy ? visibleWidth(renderPhaseSegment(theme, state, width, innerWidth)) : 0;
	const minPhase = options.includePhase ? (busy ? 18 : Math.max(6, Math.min(20, idlePhaseNatural))) : 0;
	const markOnlyModelMax = Math.max(MODEL_ID_MIN_CELLS, innerWidth - visibleWidth(mark) - 2 - visibleWidth(doorSuffix));
	const inlineText = feedbackText ?? compactWorkspace;
	const fbFull = inlineText ? Math.min(40, visibleWidth(inlineText)) : 0;
	const fbShort = inlineText ? Math.min(24, visibleWidth(inlineText)) : 0;
	const stepThink = (target: "marks" | "word" | "none"): "marks" | "word" | "none" => {
		if (initialThink === "none" || target === "none") return "none";
		if (initialThink === "word" || target === "word") return "word";
		return "marks";
	};
	const stepCtx = (target: "bar" | "bare" | "percent" | "none"): "bar" | "bare" | "percent" | "none" => {
		const rank = { bar: 3, bare: 2, percent: 1, none: 0 } as const;
		return rank[initialCtx] <= rank[target] ? initialCtx : target;
	};
	// Elide long cwd paths (`~/…/<parent>/<dir>`, then `<dir>`) BEFORE dropping `<target>` at >= 112 cols.
	const plans: Plan[] = [
		{
			target: includeTarget,
			autonomy: "full",
			cwdIndex: firstCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 60,
			phaseMin: minPhase,
			feedbackMax: fbFull,
		},
		{
			target: includeTarget,
			autonomy: "full",
			cwdIndex: elidedCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 50,
			phaseMin: minPhase,
			feedbackMax: fbFull,
		},
		{
			target: includeTarget,
			autonomy: "full",
			cwdIndex: lastCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 40,
			phaseMin: minPhase,
			feedbackMax: fbFull,
		},
		{
			target: false,
			autonomy: "full",
			cwdIndex: elidedCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 40,
			phaseMin: minPhase,
			feedbackMax: fbFull,
		},
		{
			target: false,
			autonomy: "full",
			cwdIndex: lastCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 32,
			phaseMin: minPhase,
			feedbackMax: fbFull,
		},
		{
			target: false,
			autonomy: "short",
			cwdIndex: lastCwd,
			branch: true,
			think: stepThink("marks"),
			ctx: stepCtx("bar"),
			modelMax: 28,
			phaseMin: minPhase,
			feedbackMax: fbShort,
		},
		{
			target: false,
			autonomy: "short",
			cwdIndex: lastCwd,
			branch: true,
			think: stepThink("word"),
			ctx: stepCtx("bar"),
			modelMax: 24,
			phaseMin: minPhase,
			feedbackMax: fbShort,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: lastCwd,
			branch: true,
			think: "none",
			ctx: stepCtx("bar"),
			modelMax: 24,
			phaseMin: minPhase,
			feedbackMax: fbShort,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: lastCwd,
			branch: true,
			think: "none",
			ctx: stepCtx("bare"),
			modelMax: 20,
			phaseMin: minPhase,
			feedbackMax: fbShort,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: lastCwd,
			branch: false,
			think: "none",
			ctx: stepCtx("bare"),
			modelMax: 18,
			phaseMin: minPhase,
			feedbackMax: 0,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: -1,
			branch: false,
			think: "none",
			ctx: stepCtx("bare"),
			modelMax: 16,
			phaseMin: options.includePhase ? 10 : 0,
			feedbackMax: 0,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: -1,
			branch: false,
			think: "none",
			ctx: stepCtx("percent"),
			modelMax: 16,
			phaseMin: options.includePhase ? 10 : 0,
			feedbackMax: 0,
		},
		{
			target: false,
			autonomy: "none",
			cwdIndex: -1,
			branch: false,
			think: "none",
			ctx: "none",
			modelMax: markOnlyModelMax,
			phaseMin: 0,
			feedbackMax: 0,
		},
	];

	let chosenLeft = "";
	let chosenRight = "";
	for (const plan of plans) {
		const right = buildRight({
			ctx: plan.ctx,
			think: plan.think,
			target: plan.target,
			modelMax: plan.modelMax,
			...(plan.feedbackMax !== undefined ? { feedbackMax: plan.feedbackMax } : {}),
		});
		const rightWidth = visibleWidth(right);
		const leftWithoutPhase = buildLeft({
			autonomy: plan.autonomy,
			cwdIndex: plan.cwdIndex,
			branch: plan.branch,
			phaseRoom: 0,
		});
		const remaining = innerWidth - rightWidth - 2 - visibleWidth(leftWithoutPhase);
		if (options.includePhase && plan.phaseMin > 0) {
			const phaseAvail = remaining - 3; // ` │ `
			if (phaseAvail < plan.phaseMin) continue;
			const left = buildLeft({
				autonomy: plan.autonomy,
				cwdIndex: plan.cwdIndex,
				branch: plan.branch,
				phaseRoom: phaseAvail,
			});
			if (visibleWidth(left) + 2 + rightWidth <= innerWidth) {
				chosenLeft = left;
				chosenRight = right;
				break;
			}
		} else if (visibleWidth(leftWithoutPhase) + 2 + rightWidth <= innerWidth) {
			chosenLeft = leftWithoutPhase;
			chosenRight = right;
			break;
		}
	}
	if (!chosenLeft && !chosenRight) {
		chosenLeft = mark;
		chosenRight = buildRight({ ctx: "none", think: "none", target: false, modelMax: MODEL_ID_MIN_CELLS });
	}
	const gap = Math.max(1, innerWidth - visibleWidth(chosenLeft) - visibleWidth(chosenRight));
	const inner =
		visibleWidth(chosenLeft) + 1 + visibleWidth(chosenRight) <= innerWidth
			? `${chosenLeft}${" ".repeat(gap)}${chosenRight}`
			: truncateToWidth(`${chosenLeft} ${chosenRight}`, innerWidth, GLYPH.ellipsis, false);
	return paintRaisedRow(baseTheme, inner, width);
}

/** Slimmed 1-row `raisedSurface` anchor bar when the Alt+U deck drawer is open (no repeated facts). */
function renderSlimAnchorBar(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	width: number,
	policy: TierPolicy,
	inlineFeedback?: Notification,
): string {
	const theme = onRaisedTheme(baseTheme);
	const innerWidth = width >= 4 ? width - 2 : width;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const railSep = theme.fg("separator", ` ${GLYPH.rail} `);
	const mark = brandMark(theme);
	const cwdList = pathForms(clean(state.workspace.cwd), width >= ROUTE_TARGET_MIN_COLS ? "full" : "base");
	const branch = renderBranchSegment(theme, state);
	const deckKey = actionKeyLabel("pancode.status.toggle") ?? "Alt+U";
	const fold = theme.fg("keyboardHint", `${deckKey} fold`);

	const busy = isMainBusy(state.status);
	const leaderKey = actionKeyLabel("pancode.leader") ?? "Ctrl+G";
	const learned = state.learned;
	const seasoned =
		learned?.hydrated === true &&
		(learned.features["?"]?.count ?? 0) > 0 &&
		((learned.features["/"]?.count ?? 0) > 0 ||
			Object.keys(learned.features).some((key) => key.startsWith("/") && (learned.features[key]?.count ?? 0) > 0));

	const workspaceSlot = state.workspaceLine?.trim() ? state.workspaceLine : null;
	const controlParts: string[] = inlineFeedback
		? [formatCalmFeedback(theme, inlineFeedback.text, Math.max(16, Math.floor(innerWidth * 0.5)))]
		: workspaceSlot
			? [truncateToWidth(workspaceSlot, Math.max(16, Math.floor(innerWidth * 0.6)), GLYPH.ellipsis, false)]
			: busy
				? [
						theme.fg("keyboardHint", "Enter steers"),
						...(width >= 96 ? [theme.fg("keyboardHint", "/usage"), theme.fg("keyboardHint", "/context")] : []),
					]
				: seasoned || policy.provenance
					? width >= 96
						? ["/usage", "/context", "/fleet"].map((cmd) => theme.fg("keyboardHint", cmd))
						: width >= 80
							? ["/usage", "/context"].map((cmd) => theme.fg("keyboardHint", cmd))
							: []
					: width >= 96
						? [theme.fg("keyboardHint", "? keys"), theme.fg("keyboardHint", `${leaderKey} actions`)]
						: width >= 80
							? [theme.fg("keyboardHint", "? keys"), theme.fg("keyboardHint", leaderKey)]
							: [theme.fg("keyboardHint", "? keys")];

	const rightCandidates: string[] = [
		...(controlParts.length > 0 ? [`${controlParts.join(sep)}${railSep}${fold}`] : []),
		...(controlParts.length > 1 ? [`${controlParts[0]}${railSep}${fold}`] : []),
		fold,
	];

	// Route island owns the autonomy / YOLO badge while the deck is open, so the slimmed anchor bar omits it.
	const leftCandidates: string[] = [
		formatIdentity(mark, "", cwdList[0] ? theme.fg("workspacePath", cwdList[0]) : "", branch, sep),
		formatIdentity(mark, "", cwdList.at(-1) ? theme.fg("workspacePath", cwdList.at(-1) as string) : "", branch, sep),
		formatIdentity(mark, "", cwdList.at(-1) ? theme.fg("workspacePath", cwdList.at(-1) as string) : "", "", sep),
		mark,
	];

	for (const left of leftCandidates) {
		for (const right of rightCandidates) {
			if (visibleWidth(left) + 2 + visibleWidth(right) <= innerWidth) {
				const gap = innerWidth - visibleWidth(left) - visibleWidth(right);
				return paintRaisedRow(baseTheme, `${left}${" ".repeat(gap)}${right}`, width);
			}
		}
	}
	return paintRaisedRow(baseTheme, truncateToWidth(`${mark} ${fold}`, innerWidth, GLYPH.ellipsis, false), width);
}

/** Compact busy Row 1 (plain ground above status bar): `<spinner> <phase/cmd> · <elapsed> · Esc stops` + workers/loop. */
function renderCompactBusyRow(theme: PancodeTheme, state: FooterDashboardRenderState, width: number): string {
	const innerWidth = width >= 4 ? width - 2 : width;
	const pad = width >= 4 ? " " : "";
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const workers =
		state.fleetBoardOpen === true
			? 0
			: workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
	const loops: readonly JobRecord[] = state.loops ?? [];
	const rightParts: string[] = [];
	if (workers > 0) {
		const word = width < 80 ? `${workers}w` : `${workers} ${workers === 1 ? "worker" : "workers"}`;
		rightParts.push(theme.fg("activity", `${GLYPH.workerAgent} ${word}`));
	}
	const loopText = loops.length > 0 ? loopSegment(loops, Math.max(12, Math.floor(innerWidth / 2)), state.now) : null;
	if (loopText) rightParts.push(loopText);
	const right = rightParts.join(sep);
	const rightWidth = visibleWidth(right);

	const stopping = state.status.phase === "cancelling" || state.keyContext === "stopping";
	const esc = stopping
		? theme.fg("annotation", width >= 80 ? "Stop sent, waiting for exit" : `Stopping${GLYPH.ellipsis}`)
		: theme.style("keyboardHint", "Esc stops", { bold: true });
	const escTail = `${sep}${esc}`;
	const leftBudget = right ? Math.max(12, innerWidth - rightWidth - 2) : innerWidth;
	const phaseRoom = Math.max(8, leftBudget - visibleWidth(escTail));
	const phase = renderPhaseSegment(theme, state, width, phaseRoom);
	const left = `${phase}${escTail}`;
	if (right && visibleWidth(left) + 2 + rightWidth <= innerWidth) {
		const gap = innerWidth - visibleWidth(left) - rightWidth;
		return `${pad}${left}${" ".repeat(gap)}${right}`;
	}
	return `${pad}${truncateToWidth(left, innerWidth, GLYPH.ellipsis, false)}`;
}

export function activeTaskBrief(theme: PancodeTheme, state: FooterDashboardRenderState, room: number): string | null {
	const board = state.agent.taskBoard;
	if (!board || board.tasks.length === 0) return null;
	const counts = taskBoardCounts(board);
	if (counts.open === 0) return null;
	const active =
		board.tasks.find((task) => task.status === "active") ?? board.tasks.find((task) => task.status === "blocked");
	const head = `${theme.fg("annotation", "Tasks")} ${theme.fg("counter", `${counts.completed}/${counts.total}`)}`;
	if (!active) return visibleWidth(head) <= room ? head : null;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const titleRoom = room - visibleWidth(head) - 3;
	if (titleRoom < 6) return visibleWidth(head) <= room ? head : null;
	const title = truncateToWidth(clean(active.title), titleRoom, GLYPH.ellipsis, false);
	return `${head}${sep}${theme.fg("annotation", title)}`;
}

export function footerRateSpeed(state: FooterDashboardRenderState): string | null {
	const newest = state.throughput ? null : state.telemetry.kind === "ready" ? state.telemetry.speed : null;
	const settled =
		newest !== null &&
		state.context.budget?.historical !== true &&
		newest.targetId === (state.session.targetId ?? newest.targetId) &&
		newest.modelId === (state.session.modelId ?? newest.modelId)
			? newest
			: null;
	const rate = state.throughput ? state.throughput.tokensPerSecond : settled?.tokensPerSecond;
	const estimated = state.throughput ? state.throughput.estimated === true : settled?.estimated === true;
	if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
	return `${tokensPerSecondText(rate, estimated)} tok/s`;
}

/** Calm setting-change feedback: subdued label + body value (never competing with cyan composer rails). */
function formatCalmFeedback(theme: PancodeTheme, rawText: string, room: number): string {
	const fitted = fitNoticeWords(clean(rawText), room);
	const colon = fitted.indexOf(":");
	if (colon > 0 && colon < fitted.length - 1) {
		return `${theme.fg("metadata", fitted.slice(0, colon + 1))}${theme.fg("notice", fitted.slice(colon + 1))}`;
	}
	return theme.fg("notice", fitted);
}

/** Row 2: Key / Whisper / Contextual Moment row (`standard` and `detailed` when deck closed).
 * Keeps `<deckKey> details` permanently anchored to the right edge across every Row 2 state, so
 * pressing Alt+U morphs `Alt+U details` into `Alt+U fold` at the same right edge. The cue names what opens:
 * a bare `deck` was a word a newcomer had never been told (F21).
 */
function renderKeyWhisperRow(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	width: number,
	feedback: Notification | undefined,
): string {
	const innerWidth = width >= 4 ? width - 2 : width;
	const pad = width >= 4 ? " " : "";
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const railSep = theme.fg("separator", ` ${GLYPH.rail} `);
	const deckKey = actionKeyLabel("pancode.status.toggle") ?? "Alt+U";
	const deckCue = theme.fg("keyboardHint", `${deckKey} details`);
	const deckWidth = visibleWidth(deckCue);

	const composeAnchored = (left: string, rightPrefix = ""): string => {
		const rightFull = rightPrefix ? `${rightPrefix}${railSep}${deckCue}` : deckCue;
		if (left && rightPrefix && visibleWidth(left) + 2 + visibleWidth(rightFull) <= innerWidth) {
			const gap = innerWidth - visibleWidth(left) - visibleWidth(rightFull);
			return `${pad}${left}${" ".repeat(gap)}${rightFull}`;
		}
		if (left && visibleWidth(left) + 2 + deckWidth <= innerWidth) {
			const gap = innerWidth - visibleWidth(left) - deckWidth;
			return `${pad}${left}${" ".repeat(gap)}${deckCue}`;
		}
		if (!left && rightPrefix && visibleWidth(rightFull) <= innerWidth) {
			const gap = innerWidth - visibleWidth(rightFull);
			return `${pad}${" ".repeat(gap)}${rightFull}`;
		}
		if (!left && deckWidth <= innerWidth) {
			const gap = innerWidth - deckWidth;
			return `${pad}${" ".repeat(gap)}${deckCue}`;
		}
		if (left) return `${pad}${truncateToWidth(left, innerWidth, GLYPH.ellipsis, false)}`;
		return `${pad}${truncateToWidth(rightFull, innerWidth, GLYPH.ellipsis, false)}`;
	};

	if (feedback) {
		const fbRoom = innerWidth >= deckWidth + 14 ? innerWidth - deckWidth - 2 : innerWidth;
		return composeAnchored(formatCalmFeedback(theme, feedback.text, fbRoom));
	}

	const loops: readonly JobRecord[] = state.loops ?? [];
	const busy = isMainBusy(state.status);
	const keyContext = state.keyContext ?? "idle";
	const draftContext =
		keyContext !== "idle" &&
		keyContext !== "surface" &&
		keyContext !== "steer-empty" &&
		keyContext !== "hold-empty" &&
		keyContext !== "stopping";

	// One-time contextual moment yields to alerts and setting feedback, takes precedence over whisper cues.
	if (state.contextualMoment && !draftContext) {
		const momentRoom = innerWidth >= deckWidth + 18 ? innerWidth - deckWidth - 2 : innerWidth;
		const momentText = theme.fg("annotation", fitNoticeWords(clean(state.contextualMoment), momentRoom));
		if (busy) {
			const esc = theme.style("keyboardHint", "Esc stops", { bold: true });
			const combinedLeft = `${esc}${sep}${momentText}`;
			if (visibleWidth(combinedLeft) + 2 + deckWidth <= innerWidth) return composeAnchored(combinedLeft);
		}
		return composeAnchored(momentText);
	}

	if (busy) {
		const stopping = state.status.phase === "cancelling" || keyContext === "stopping";
		const queued = state.keyHintFacts?.queued ?? 0;
		const workers =
			state.fleetBoardOpen === true
				? 0
				: workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
		const queueKey = actionKeyLabel("pancode.queue.open");
		const fleetKey = actionKeyLabel("pancode.dispatchBoard.toggle");
		const isShell = keyContext === "shell";
		const isHold = keyContext === "hold" || keyContext === "hold-empty";
		const items: string[] = stopping
			? [theme.fg("annotation", width >= 80 ? "Stop sent, waiting for exit" : `Stopping${GLYPH.ellipsis}`)]
			: isShell
				? [theme.style("keyboardHint", width >= 80 ? "Esc stops command" : "Esc stops", { bold: true })]
				: isHold
					? [
							...(width >= 80 ? [theme.fg("keyboardHint", width >= 96 ? "Enter holds message" : "Enter holds")] : []),
							theme.style("keyboardHint", "Esc stops", { bold: true }),
						]
					: [
							theme.fg("keyboardHint", "Enter steers"),
							theme.style("keyboardHint", "Esc stops", { bold: true }),
							// Top rail owns `<queueKey> review` from 60 cols; Fleet band owns `<fleetKey> detail` while visible.
							...(queued > 0 && queueKey && width < FOOTER_NARROW_CELLS
								? [theme.fg("keyboardHint", `${queueKey} queue`)]
								: []),
							...(workers > 0 && fleetKey && state.fleetBandVisible !== true && state.fleetBoardOpen !== true
								? [theme.fg("keyboardHint", `${fleetKey} fleet`)]
								: []),
						];
		const leftBudget = innerWidth >= deckWidth + 16 ? innerWidth - deckWidth - 2 : innerWidth;
		let left = "";
		for (const item of items) {
			const candidate = left === "" ? item : `${left}${sep}${item}`;
			if (visibleWidth(candidate) > leftBudget) break;
			left = candidate;
		}
		const rightPrefixRoom = innerWidth - visibleWidth(left) - 2 - deckWidth - 3;
		const bandOwnsLoop = state.fleetBandVisible === true && (workers === 0 || width >= 80);
		let rightPrefix = "";
		if (rightPrefixRoom >= ROW2_RIGHT_MIN_COLS) {
			rightPrefix =
				(!bandOwnsLoop && loops.length > 0 ? loopSegment(loops, rightPrefixRoom, state.now) : null) ??
				activeTaskBrief(theme, state, rightPrefixRoom) ??
				"";
		}
		return composeAnchored(left, rightPrefix);
	}

	// Idle Row 2
	const learned: HarnessLearnedFacts | undefined = state.learned;
	const learnedReady = learned?.hydrated === true;
	const basicLearned =
		learnedReady &&
		(learned.features["?"]?.count ?? 0) > 0 &&
		((learned.features["/"]?.count ?? 0) > 0 ||
			Object.keys(learned.features).some((key) => key.startsWith("/") && (learned.features[key]?.count ?? 0) > 0));

	const leftBudget = innerWidth >= deckWidth + 14 ? innerWidth - deckWidth - 2 : innerWidth;
	let left = "";
	if (draftContext) {
		const hint = footerKeyHint(state.now, width <= FOOTER_NARROW_CELLS, leftBudget, keyContext, {
			...state.keyHintFacts,
			learning: false,
		});
		left = hint ? theme.fg("keyboardHint", hint) : "";
	} else if (basicLearned || state.demo === false) {
		const parts: string[] = [];
		const last = state.agent.lastTurn;
		if (last !== null) {
			const workMs = Math.max(0, last.elapsedMs - (last.humanWaitMs ?? 0));
			parts.push(theme.fg("annotation", `last ${formatElapsed(workMs)}`));
		}
		const speed = footerRateSpeed(state);
		if (speed) parts.push(theme.fg("annotation", speed));
		const task = activeTaskBrief(theme, state, Math.max(16, Math.floor(leftBudget / 2)));
		if (task) parts.push(task);
		left = parts.join(sep);
	} else {
		const leftItems = [theme.fg("keyboardHint", "? keys"), theme.fg("keyboardHint", "/ commands")];
		left = leftItems.join(sep);
		if (visibleWidth(left) > leftBudget) left = theme.fg("keyboardHint", "? keys");
	}

	const rightPrefixRoom = (left ? innerWidth - visibleWidth(left) - 2 : innerWidth) - deckWidth - 3;
	const idleWorkers =
		state.fleetBoardOpen === true
			? 0
			: workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
	const bandOwnsLoop = state.fleetBandVisible === true && (idleWorkers === 0 || width >= 80);
	let rightPrefix = "";
	if (state.workspaceLine?.trim() && rightPrefixRoom >= ROW2_RIGHT_MIN_COLS) {
		rightPrefix = truncateToWidth(state.workspaceLine, rightPrefixRoom, GLYPH.ellipsis, false);
	}
	if (!rightPrefix && !bandOwnsLoop && loops.length > 0 && rightPrefixRoom >= ROW2_RIGHT_MIN_COLS) {
		rightPrefix = loopSegment(loops, rightPrefixRoom, state.now) ?? "";
	}
	// A live extension fact outranks the onboarding whisper, so a pack's status and a long command's
	// progress reach an operator who has not learned the whispers yet.
	if (!rightPrefix && rightPrefixRoom >= 10) {
		const sepWidth = visibleWidth(sep);
		for (const fact of state.extensionFacts ?? []) {
			const remaining = rightPrefix === "" ? rightPrefixRoom : rightPrefixRoom - visibleWidth(rightPrefix) - sepWidth;
			if (remaining < 10) break;
			const line = extensionFactLine(theme, fact, remaining);
			if (!line) continue;
			rightPrefix = rightPrefix === "" ? line : `${rightPrefix}${sep}${line}`;
		}
	}
	if (!rightPrefix && !draftContext && state.whisper && rightPrefixRoom >= 14) {
		rightPrefix = truncateToWidth(theme.fg("annotation", clean(state.whisper)), rightPrefixRoom, GLYPH.ellipsis, false);
	}

	return composeAnchored(left, rightPrefix);
}

type FooterAlertKind = "urgent" | "feedback" | "error" | "window" | "weekly" | "silence" | "warning" | "info";

export interface FooterAlert {
	readonly kind: FooterAlertKind;
	readonly text: string;
	readonly tone: PancodeToken;
	readonly glyph: string | null;
	readonly notice: boolean;
	readonly more: boolean;
}

function noticeAlert(notice: Notification, kind: FooterAlertKind): FooterAlert {
	const [first = "", ...rest] = clean(notice.text).split("\n");
	return {
		kind,
		text: first,
		tone: notificationToken(notice.level),
		glyph: notificationGlyph(notice.level),
		notice: true,
		more: rest.length > 0,
	};
}

function newestFirst(notices: ReadonlyArray<Notification>): Notification[] {
	return [...notices].sort((a, b) => b.addedAt - a.addedAt);
}

function isDroppedTuiInfoNotice(entry: Notification): boolean {
	if (entry.level !== "info") return false;
	if (/^\s*tip:/iu.test(entry.text)) return true;
	if (entry.key === "context.cache.cold" || entry.key === "context.cache.reuse-uncertain") return true;
	return /^\s*next reply may be slower:/iu.test(entry.text);
}

/** Collect prioritized live alerts for the dedicated alert row. */
function collectFooterAlerts(
	state: FooterDashboardRenderState,
	width: number,
	policy: TierPolicy,
	options: { surfaceOwnsKeys: boolean; hintRow: boolean },
): { alerts: FooterAlert[]; feedback: Notification | undefined } {
	const now = state.now;
	const narrow = width <= FOOTER_NARROW_CELLS;
	const feedback = topNotification(
		state.notices.filter((notice) => notice.presentation === "setting"),
		now,
	);
	const live = state.notices.filter(
		(entry) =>
			entry.presentation !== "setting" &&
			(entry.expiresAt === null || entry.expiresAt > now) &&
			!isDroppedTuiInfoNotice(entry),
	);
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("pancode.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? typeof state.session.shutdownArmed === "string"
			? state.session.shutdownArmed
			: "Ctrl+C again to quit"
		: state.session.leaderArmed && !options.surfaceOwnsKeys
			? leaderKey
				? `${leaderKey} ${GLYPH.next} choose key`
				: "Choose key"
			: null;
	const silence = state.silenceNotes ?? null;
	const silenceNote = silence?.find((form) => visibleWidth(form) + 2 <= width) ?? silence?.at(-1) ?? null;

	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	const window = state.session.autonomy === "yolo" ? (state.session.autonomyWindow ?? null) : null;
	const readout =
		window === null ? null : autonomyWindowReadout(window, { narrow, dot: GLYPH.sep, resumeHint: "Enter continues" });
	const leftMs =
		window !== null && window.caps.minutes > 0 ? window.caps.minutes * 60_000 - window.usage.activeMs : null;
	const ending = readout !== null && (readout.tone === "warning" || (leftMs !== null && leftMs < WINDOW_ENDING_MS));

	const plain = (kind: FooterAlertKind, text: string, tone: PancodeToken, glyph: string | null): FooterAlert => ({
		kind,
		text,
		tone,
		glyph,
		notice: false,
		more: false,
	});
	const alerts: FooterAlert[] = [
		...(urgent === null ? [] : [plain("urgent", urgent, "warning", null)]),
		...newestFirst(live.filter((entry) => entry.level === "error")).map((entry) => noticeAlert(entry, "error")),
		...(ending && readout ? [plain("window", readout.text, "warning", GLYPH.warn)] : []),
		...(weekly && weekly.severity === "critical" ? [plain("weekly", weekly.label, "error", GLYPH.warn)] : []),
		...(silenceNote === null ? [] : [plain("silence", silenceNote, "warning", GLYPH.warn)]),
		...newestFirst(live.filter((entry) => entry.level === "warning")).map((entry) => noticeAlert(entry, "warning")),
		...(policy.noticeFloor === "info"
			? newestFirst(live.filter((entry) => entry.level === "info" || entry.level === "success")).map((entry) =>
					noticeAlert(entry, "info"),
				)
			: []),
	];
	return { alerts, feedback };
}

function renderAlertRow(
	theme: PancodeTheme,
	alert: FooterAlert,
	others: number,
	dismissable: boolean,
	width: number,
	deckKey: string,
	dismissKeyLabel: string | undefined,
): string {
	const innerWidth = width >= 4 ? width - 2 : width;
	const pad = width >= 4 ? " " : "";
	const body = alert.glyph === null ? alert.text : `${alert.glyph} ${alert.text}`;
	const cut = alert.more || visibleWidth(body) > innerWidth;
	const dismiss =
		dismissable && dismissKeyLabel && !dismissKeyLabel.startsWith("unbound")
			? `${dismissKeyLabel.split(/ [·|.] /u).at(-1) ?? ""} dismiss`
			: "";
	// Each key names what it does: a bare `Ctrl+G X` beside an alert read as part of its text (F21).
	const more = others > 0 ? `${deckKey} +${others} more` : cut ? `${deckKey} more` : "";
	const keys = [more, dismiss].filter(Boolean).join(` ${GLYPH.sep} `);
	const keyText = keys ? theme.fg("keyboardHint", keys) : "";
	const minAlertCells = width >= 96 ? ALERT_MIN_CELLS_WIDE : ALERT_MIN_CELLS_MID;
	// Only the severity lead carries the alert's hue; the message reads as a notice. A lead-less alert keeps its tone.
	const lead = alert.glyph === null ? "" : `${alert.glyph} `;
	const painted = (cells: number): string => {
		const fitted = fitNoticeWords(body, cells);
		if (lead === "" || !fitted.startsWith(lead)) return theme.fg(alert.tone, fitted);
		return `${theme.fg(alert.tone, alert.glyph ?? "")} ${theme.fg("notice", fitted.slice(lead.length))}`;
	};
	if (width < 80 || !keyText || innerWidth - visibleWidth(keyText) - 2 < minAlertCells) {
		return `${pad}${painted(innerWidth)}`;
	}
	const room = innerWidth - visibleWidth(keyText) - 2;
	const shown = painted(room);
	return `${pad}${shown}${" ".repeat(Math.max(2, innerWidth - visibleWidth(shown) - visibleWidth(keyText)))}${keyText}`;
}

interface StatusLineMemo {
	key: string;
	baseKey: string;
	alertRows: string[];
	feedback: Notification | undefined;
	row2: string | null;
	parts: StatusLineParts;
}

export interface StatusLineParts {
	readonly alertRows: string[];
	readonly bodyRows: string[];
}

let lastMemo: StatusLineMemo | null = null;

/**
 * Render the Hybrid B->A status line split into topmost alert row(s) and bottom body row(s),
 * so the footer stack can mount `[...alertRows, ...fleetRows, ...deckRows, ...bodyRows]`.
 * Memoized by width x tier x facts revision when `state.factsRevision` is supplied.
 */
export function renderStatusLineParts(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
	themeOverride?: PancodeTheme,
): StatusLineParts {
	const w = Math.max(1, Math.floor(width));
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	const busy = isMainBusy(state.status);
	const keyContext = state.keyContext ?? "idle";
	const deckOpen = state.deckOpen === true;
	const hasExpiringNotice = state.notices.some((notice) => notice.expiresAt !== null);
	const hasLoops = (state.loops?.length ?? 0) > 0;
	const animating = busy && state.status.phase !== "tool_blocked" && motionEnabled();
	const timed = busy || hasLoops || (state.background?.length ?? 0) > 0 || hasExpiringNotice;
	const timeKey = animating
		? `${Math.floor(state.now / 1000)}:${state.tick}`
		: timed
			? `${Math.floor(state.now / 1000)}`
			: "0";
	const baseKey =
		themeOverride === undefined && state.factsRevision !== undefined
			? [
					w,
					terminalRows,
					policy.tier,
					tierRevision(),
					skinEpoch(),
					state.factsRevision,
					deckOpen ? 1 : 0,
					keyContext,
					state.keyHintFacts?.queued ?? 0,
					state.welcomeVisible ? 1 : 0,
					state.compactKeysDoor ? 1 : 0,
					state.fleetBandVisible ? 1 : 0,
					state.fleetBoardOpen ? 1 : 0,
					state.whisper ?? "",
					state.contextualMoment ?? "",
					state.workspaceLine ?? "",
					extensionFactsKey(state.extensionFacts),
				].join("|")
			: null;
	const memoKey = baseKey !== null ? `${baseKey}|${timeKey}` : null;
	if (memoKey !== null && lastMemo !== null && lastMemo.key === memoKey) return lastMemo.parts;

	const theme = themeOverride ?? pancodeTheme();
	const surfaceOwnsKeys = keyContext === "surface";
	const reduced = w < FOOTER_W1_CELLS || terminalRows < FOOTER_H1_ROWS || surfaceOwnsKeys;
	const showRow2 = !deckOpen && policy.hintRow && !reduced;
	const staticMemo =
		baseKey !== null && lastMemo !== null && lastMemo.baseKey === baseKey && !hasExpiringNotice ? lastMemo : null;

	let alertRows: string[];
	let feedback: Notification | undefined;
	if (staticMemo !== null) {
		alertRows = staticMemo.alertRows;
		feedback = staticMemo.feedback;
	} else {
		const collected = collectFooterAlerts(state, w, policy, { surfaceOwnsKeys, hintRow: showRow2 });
		feedback = collected.feedback;
		const top = collected.alerts[0];
		const shownAlert = top === undefined ? null : !reduced || top.kind === "urgent" || top.kind === "error" ? top : null;
		const deckKey = actionKeyLabel("pancode.status.toggle") ?? "Alt+U";
		alertRows =
			shownAlert !== null
				? [
						renderAlertRow(
							theme,
							shownAlert,
							collected.alerts.length - 1,
							collected.alerts.some((alert) => alert.notice),
							w,
							deckKey,
							state.dismissKeyLabel,
						),
					]
				: [];
	}

	const bodyRows: string[] = [];
	const innerWidth = w >= 4 ? w - 2 : w;
	const pad = w >= 4 ? " " : "";
	let cachedRow2: string | null = null;
	if (deckOpen) {
		bodyRows.push(renderSlimAnchorBar(theme, state, w, policy, feedback));
	} else if (!policy.hintRow && busy && !reduced && alertRows.length === 0) {
		// Compact busy cap: Row 1 carries live phase/Esc/workers/loop, Row 2 carries identity/context/level/model (<= 2 rows).
		// Setting-change feedback renders inline in Row 2 so compact never exceeds 2 rows.
		bodyRows.push(renderCompactBusyRow(theme, state, w));
		bodyRows.push(
			renderStatusBar(theme, state, w, policy, {
				includePhase: false,
				compactKeysDoor: false,
				inlineFeedback: feedback,
			}),
		);
	} else {
		const compactDoor =
			!policy.hintRow && !busy && !reduced && state.compactKeysDoor === true && state.learned?.hydrated === true;
		const inlineFeedback =
			!showRow2 && !(!policy.hintRow && !busy && !reduced && alertRows.length === 0) ? feedback : undefined;
		bodyRows.push(
			renderStatusBar(theme, state, w, policy, {
				includePhase: true,
				compactKeysDoor: compactDoor,
				inlineFeedback,
			}),
		);
		if (showRow2) {
			cachedRow2 =
				staticMemo !== null && !hasLoops && staticMemo.row2 !== null
					? staticMemo.row2
					: renderKeyWhisperRow(theme, state, w, feedback);
			bodyRows.push(cachedRow2);
		} else if (!policy.hintRow && !busy && !reduced && alertRows.length === 0 && feedback !== undefined) {
			// Compact idle setting feedback renders below the status bar in calm body tone (never above, <= 2 rows).
			bodyRows.push(`${pad}${formatCalmFeedback(theme, feedback.text, innerWidth)}`);
		}
	}

	const parts: StatusLineParts = { alertRows, bodyRows };
	if (memoKey !== null && baseKey !== null) {
		lastMemo = { key: memoKey, baseKey, alertRows, feedback, row2: cachedRow2, parts };
	}
	return parts;
}

/**
 * Render the Hybrid B->A status line region (alert row if live, status bar, and key/whisper row).
 * Memoized by width x tier x facts revision when `state.factsRevision` is supplied.
 */
export function renderStatusLine(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
	themeOverride?: PancodeTheme,
): string[] {
	const { alertRows, bodyRows } = renderStatusLineParts(state, width, terminalRows, themeOverride);
	return [...alertRows, ...bodyRows];
}
