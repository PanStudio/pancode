// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readPancodeVersionLabel } from "../core/build-info.js";
import type { PancodeSettings } from "../core/config.js";
import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { pancodeProjectRoot } from "../core/project-root.js";
import { asciiOnly } from "../core/terminal-preferences.js";
import { markProjectSeen, projectSeen } from "../core/welcome-seen.js";
import type { ContextState } from "../domains/context/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/index.js";
import { effectiveYoloConfinement } from "../domains/safety/autonomy.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { type Component, type Keybinding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { brandMark, GLYPH, meter, type PancodeTheme, padAnsi, pancodeTheme, wordmarkName } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import {
	paintWelcomeRowWordmark,
	paintWelcomeWordmark,
	WELCOME_WORDMARK,
	WELCOME_WORDMARK_WIDE,
} from "./welcome-art.js";

/** Reduced terminals and screen readers get the same one-row identity as demo-off. */
function richWelcomeEnabled(demo: boolean | undefined): boolean {
	return demo !== false && !asciiOnly() && process.env.PANCODE_SCREEN_READER !== "1";
}

const PRODUCT_TAGLINE = "Systems software for coding agents";

const WELCOME_TAGLINES = [
	"Ask Panos how to use or extend PanCode.",
	"Ask Panos to explain code before you change it.",
	"/view shows every tool call and its full output.",
	"/model switches the chat model.",
	"/rewind undoes file changes.",
	"/usage shows activity, accounts and model use.",
] as const;

// Stage 0 and hydration share one choice; redraws and /new keep the launch's line.
const SESSION_TAGLINE = WELCOME_TAGLINES[Math.floor(Math.random() * WELCOME_TAGLINES.length)] ?? WELCOME_TAGLINES[0];

/**
 * What the route can honestly be said to be.
 *
 * `checking` is its own state and is never spelled as ready or unavailable. A
 * target that is configured but not yet probed reports
 * `health.status === "unknown"` with `available` still true, and printing that
 * as either verdict is a claim the process has not earned. `available === false`
 * is a different thing: it is a configuration or auth-level refusal that holds
 * without any probe (see `authStatusFor` in domains/providers/extension.ts), so
 * it is reported as unavailable immediately.
 */
export type WelcomeRouteState = "checking" | "ready" | "degraded" | "unavailable" | "unset";

/**
 * Project-context state, mirroring `ContextState["pancodeMd"]` plus the honest
 * fourth answer for "the authoritative read has not happened yet". `stale` is
 * carried through rather than folded into `ok`, because a stale PANCODE.md
 * has a different next step than a current one.
 */
export type WelcomeProjectContextState = "checking" | "ok" | "stale" | "none" | "malformed";

export interface WelcomeDashboardDeps {
	providers: Pick<ProvidersContract, "list">;
	/** Terminal height, which decides whether the launchpad can afford its art. */
	getTerminalRows?: () => number | undefined;
	/** In-memory recipe inventory; excludes internal helper agents. */
	getAgentCount?: () => number;
	getSettings?: () => Readonly<PancodeSettings>;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	/**
	 * The authoritative project-context reader from the context domain. It is
	 * synchronous on a cache miss (it walks ancestors for PANCODE.md), so it
	 * is never called from `render`; the dashboard refreshes it off the frame and
	 * paints `checking` until the first reading lands.
	 */
	getContextState?: (cwd: string) => ContextState;
	getProjectPreload?: (cwd: string) => string | null;
	/** Effective label for the submit binding; null when unbound or disabled. */
	getSubmitKeyLabel?: () => string | null;
	/** Effective shortcut labels; null hides an unbound action. */
	getKeyLabel?: (action: Keybinding) => string | null;
	/**
	 * Connected subscription quota, already summarized, or null when nothing is
	 * connected yet. Read synchronously on every frame, so the supplier must
	 * serve a cached value and do its own refreshing off the render path.
	 */
	getQuotaSummary?: () => string | null;
	/**
	 * The reminder that this repository's own configuration is not applied, or
	 * null. Read on every frame, so the supplier serves a cached line.
	 */
	getProjectConfigReminder?: () => string | null;
	/**
	 * Whether default autonomy's shell calls run in the OS sandbox here, or null
	 * while the host probe has not answered. Read on every frame, so it never probes.
	 */
	getShellContained?: () => boolean | null;
	/**
	 * Reads the latest earlier session in `cwd`, off the frame and only on a terminal. Supplied by the hydrated
	 * presentation: session history stays out of the Stage 0 closure this module belongs to.
	 */
	readLastSession?: (cwd: string, now: number) => Promise<WelcomeLastSession | null>;
	/** Called when an off-render refresh lands, so the frame owner can ask for one. */
	onFactsRefreshed?: () => void;
	/**
	 * How the off-render refresh is deferred. Production yields to the event loop
	 * so no filesystem work ever runs on the render call stack; tests inject a
	 * synchronous runner for determinism.
	 */
	scheduleRefresh?: (run: () => void) => void;
	now?: () => number;
}

export interface WelcomeDashboardStats {
	outputStyle?: OutputStyle;
	cwd: string;
	workspace: WorkspaceSnapshot | null;
	/** Null when unset. `formatTargetLabel` owns the one spelling for that. */
	targetLabel: string | null;
	modelLabel: string | null;
	route: WelcomeRouteState;
	/** The actionable half of a failure. Null whenever the route is fine. */
	routeReason: string | null;
	/** `checking` in session mode: the collapsed row does not show it, so it is not read. */
	projectContext: WelcomeProjectContextState;
	projectPreload?: string | null;
	/** Null in session mode: the collapsed row prints no key hint. */
	submitKeyLabel: string | null;
	autonomy: string;
	/** The operator's yolo confinement; read only at yolo, absent reads contained. */
	yoloConfinement?: string;
	/** False when default's shell calls run uncontained on this host; absent or null while unknown. */
	shellContained?: boolean | null;
	targets: string;
	fleet: string;
	/** One line of connected subscription usage; null hides the row entirely. */
	quota: string | null;
	/** Project configuration that is not applied, and the command that reviews it. */
	projectConfig?: string | null;
	/** The first launchpad for this project: the stacked wordmark shows at every tier. */
	firstBoot?: boolean;
	/** The route's context window in tokens; absent or null when nothing declared one. */
	contextWindow?: number | null;
	/** The latest earlier session here, `checking` until it is read, null when there is none. */
	lastSession?: WelcomeLastSession | "checking" | null;
	/** The clock the `last here` age is measured against. */
	now?: number;
}

/** The earlier session the `last here` row quotes. */
export interface WelcomeLastSession {
	lastActiveAt: string;
	/** The first operator words, or null when the session withheld them. */
	preview: string | null;
	name: string | null;
}

export type WelcomeDashboardMode = "launchpad" | "session";

export interface WelcomeDashboardComponent extends Component {
	collapseToSessionHeader(): boolean;
	/** The welcome owns idle teaching while its full panel is visible. */
	isLaunchpadVisible?(): boolean;
	resetToLaunchpad(): boolean;
	/** Stop off-render refreshes from requesting frames after teardown. */
	dispose(): void;
}

/**
 * How long a project-context reading is trusted, and how soon a reading that
 * could not be taken is retried. The retry is shorter than the trust window so a
 * transient failure resolves quickly, and longer than a frame so a permanently
 * failing read cannot become a per-frame scan.
 *
 * A failure never renews the trust window. Once reads have been failing for
 * longer than the window, the header stops asserting the last value and says
 * `checking` instead, so a stale `ok` cannot outlive the evidence for it.
 */
export const WELCOME_PROJECT_CONTEXT_TTL_MS = 10_000;
export const WELCOME_PROJECT_CONTEXT_RETRY_MS = 2_000;

/** Columns the route's failure reason is allowed before it is cut. */
const ROUTE_REASON_MAX = 48;

/**
 * Neutralize a string that came from outside this process before it is styled.
 *
 * Provider reasons, upstream error bodies, branch names, model ids and paths all
 * reach the header from somewhere the header does not control, and a header is a
 * bad place to discover that a payload can move the cursor. `sanitizeCallTargetText`
 * is the project's existing one-line sanitizer (OSC and CSI stripped, C0 and DEL
 * neutralized, whitespace collapsed); this is a thin alias so the intent reads at
 * every call site.
 */
function plainOneLine(value: string): string {
	return sanitizeCallTargetText(value);
}

function findCurrentStatus(
	statuses: ReadonlyArray<TargetStatus>,
	settings: Readonly<PancodeSettings> | undefined,
): TargetStatus | null {
	const targetId = settings?.chat?.target ?? null;
	if (!targetId) return null;
	return statuses.find((status) => status.target.id === targetId) ?? null;
}

/**
 * One short line an operator can act on. Reasons arrive as anything from
 * `ECONNREFUSED 127.0.0.1:1234` to a multi-line upstream body, so the text is
 * sanitized to one line and then cut by terminal columns — not by code units,
 * which would split a surrogate pair or a combining sequence.
 */
function shortRouteReason(status: TargetStatus): string | null {
	const cleaned = plainOneLine(status.health.lastError ?? status.reason ?? "");
	if (cleaned.length === 0) return null;
	return visibleWidth(cleaned) > ROUTE_REASON_MAX
		? truncateToWidth(cleaned, ROUTE_REASON_MAX, GLYPH.ellipsis, false)
		: cleaned;
}

function deriveRoute(
	current: TargetStatus | null,
	targetLabel: string | null,
	modelLabel: string | null,
): { route: WelcomeRouteState; routeReason: string | null } {
	// A route needs both halves. A configured target with no model and no default
	// model cannot answer a prompt, so it is unset rather than ready: the previous
	// header advertised `dynamo · no model · ready`, which was never true.
	if (targetLabel === null || modelLabel === null) return { route: "unset", routeReason: null };
	// A target id that matches no listed target is a real misconfiguration, not an
	// unprobed one.
	if (current === null) return { route: "unavailable", routeReason: "no such target in settings" };
	// `available: false` is decided from configuration and auth without probing.
	if (!current.available || current.health.status === "down")
		return { route: "unavailable", routeReason: shortRouteReason(current) };
	if (current.health.status === "degraded") return { route: "degraded", routeReason: shortRouteReason(current) };
	if (current.health.status === "healthy") return { route: "ready", routeReason: null };
	// "unknown": configured and permitted, but no probe has returned a verdict.
	return { route: "checking", routeReason: null };
}

function normalizeProjectContext(state: ContextState | null | undefined): WelcomeProjectContextState | null {
	const value = state?.pancodeMd;
	if (value === "ok" || value === "stale" || value === "none" || value === "malformed") return value;
	return null;
}

// ---------------------------------------------------------------------------
// Width fitting. Every measurement goes through pi's `visibleWidth`, so ANSI,
// CJK, emoji and combining sequences are counted in terminal columns rather
// than in code units.
// ---------------------------------------------------------------------------

interface Unit {
	text: string;
	/** Lower survives longer. Units at or below `protectRank` are never dropped. */
	rank: number;
}

/**
 * Fit `units` into `maxWidth` by dropping whole low-priority units rather than
 * tail-truncating the joined string. Display order is the order given and is
 * independent of rank, so a unit can be shown first and still be the first to go.
 * Protected units that still overflow are truncated with an ellipsis, so the most
 * important fact is partly visible rather than absent — which is what the previous
 * header got wrong: it appended everything and clipped, making the route the first
 * casualty of a long path.
 */
function fitByPriority(theme: PancodeTheme, units: ReadonlyArray<Unit>, maxWidth: number, protectRank = 0): string {
	const separator = ` ${GLYPH.sep} `;
	const sep = theme.fg("annotation", separator);
	const sepWidth = visibleWidth(separator);
	const kept = units.map((unit) => ({ ...unit, dropped: false }));
	const total = (): number => {
		const live = kept.filter((unit) => !unit.dropped);
		if (live.length === 0) return 0;
		return live.reduce((sum, unit) => sum + visibleWidth(unit.text), 0) + sepWidth * (live.length - 1);
	};
	while (total() > maxWidth) {
		const droppable = kept.filter((unit) => !unit.dropped && unit.rank > protectRank);
		let worst = droppable[0];
		if (worst === undefined) break;
		for (const unit of droppable) if (unit.rank > worst.rank) worst = unit;
		worst.dropped = true;
	}
	const joined = kept
		.filter((unit) => !unit.dropped)
		.map((unit) => unit.text)
		.join(sep);
	return visibleWidth(joined) <= maxWidth ? joined : truncateToWidth(joined, maxWidth, GLYPH.ellipsis, false);
}

/**
 * The collapsed session header: persistent `▐P▌ PanCode <version>` identity,
 * plus an actionable warning chip only when untrusted project config needs attention.
 * Route, autonomy, workspace, and context are permanently owned by the status line / deck.
 */
function sessionRow(theme: PancodeTheme, stats: WelcomeDashboardStats, version: string, width: number): string {
	const mark = brandMark(theme);
	const markWidth = visibleWidth(mark);
	if (width <= markWidth + 1) return truncateToWidth(mark, width, "", false);
	const room = width - markWidth - 1;
	const shortVersion = version
		.replace(/ · .*$/u, "")
		.replace(new RegExp(` ${GLYPH.sep.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} .*$`, "u"), "");
	const versionTag = theme.fg("annotation", version);
	const shortVersionTag = theme.fg("annotation", shortVersion);
	const identity = `${wordmarkName(theme)} ${versionTag}`;
	const projectWarning = stats.projectConfig ? theme.fg("warning", plainOneLine(stats.projectConfig)) : null;
	if (projectWarning !== null) {
		const idUnit =
			visibleWidth(identity) + visibleWidth(projectWarning) + 3 <= room
				? identity
				: visibleWidth(versionTag) + visibleWidth(projectWarning) + 3 <= room
					? versionTag
					: shortVersionTag;
		const units: Unit[] = [
			{ text: idUnit, rank: 1 },
			// Actionable untrusted-config warning outlasts the product name and version.
			{ text: projectWarning, rank: 0 },
		];
		return `${mark} ${fitByPriority(theme, units, room)}`;
	}
	const shown =
		visibleWidth(identity) <= room
			? identity
			: visibleWidth(versionTag) <= room
				? versionTag
				: visibleWidth(shortVersionTag) <= room
					? shortVersionTag
					: "";
	return shown.length > 0 ? `${mark} ${shown}` : truncateToWidth(mark, width, "", false);
}

// ---------------------------------------------------------------------------
// The launchpad: persistent brand + non-duplicated session-start orientation.
// ---------------------------------------------------------------------------

/** Cells of a fact label: the widest labels, `awareness` and `last here`. */
const FACT_LABEL_WIDTH = 9;
/** Fact rows hang two cells under the header row. */
const FACT_INDENT = 2;
/** Cells between the stacked wordmark and the facts. */
const COLUMN_GAP = 3;
/** Under this many terminal rows every tier shows the compact form (H1). */
const SHORT_TERMINAL_ROWS = 20;
/** Under this many cells a fact label stacks above its value (W1). */
const STACKED_FACT_WIDTH = 44;
/** Rows of the stacked wordmark, and so of a launchpad that shows it. */
const STACKED_ROWS = 11;
/** Columns from which the stacked wordmark uses its wide letters. */
const WIDE_ART_MIN_WIDTH = 100;

/**
 * The brand form, from first boot, tier, and viewport dimensions:
 * - First boot: full 11-row stacked wordmark at every tier when `width >= 76 && rows >= 24`.
 * - Subsequent boots: `compact` uses `▐P▌` mark (zero giant art); `standard`/`detailed` use
 *   the 5-row horizontal one-band wordmark above orientation facts when `width >= 57 && rows >= 30`, else `▐P▌`.
 */
type BrandForm = "stacked" | "band-above" | "mark";

function brandForm(firstBoot: boolean, columns: number, rows: number, evidence: boolean): BrandForm {
	if (rows < SHORT_TERMINAL_ROWS) return "mark";
	if (firstBoot && columns >= 76 && rows >= 24) return "stacked";
	if (firstBoot && columns >= 57 && rows >= 24) return "band-above";
	if (!evidence) return "mark";
	if (columns >= 57 && rows >= 30) return "band-above";
	return "mark";
}

/** The single action that most improves the session, and whether it blocks. */
interface NextStep {
	action: string;
	/** What waits on it; empty when the action says it all. */
	effect: string;
	blocks: boolean;
}

/** Steps that block work, worst first: a route that cannot answer, then project configuration that is not applied. */
function blockers(stats: WelcomeDashboardStats): NextStep[] {
	const steps: NextStep[] = [];
	if (stats.route === "unset")
		steps.push({ action: "/config connects a model", effect: "nothing can run until one is connected", blocks: true });
	if (stats.route === "unavailable")
		steps.push({ action: "/config repairs the route", effect: "nothing can run until it answers", blocks: true });
	if (stats.projectConfig) steps.push({ action: plainOneLine(stats.projectConfig), effect: "", blocks: true });
	return steps;
}

/** `‖ action · effect`, dropping the effect before the action is cut. Nothing the operator must act on is dim. */
function stepText(theme: PancodeTheme, step: NextStep, room: number): string {
	const lead = step.blocks ? `${theme.fg("attention", GLYPH.phaseBlocked)} ` : "";
	const units: Unit[] = [
		{ text: theme.fg(step.blocks ? "body" : "guidance", step.action), rank: 0 },
		...(step.effect ? [{ text: theme.fg(step.blocks ? "body" : "annotation", step.effect), rank: 1 }] : []),
	];
	return `${lead}${fitByPriority(theme, units, Math.max(1, room - visibleWidth(lead)))}`;
}

/** Route health verdict for `detailed` without repeating raw `target · model` or context window. */
function healthValue(theme: PancodeTheme, stats: WelcomeDashboardStats, room: number): string {
	const target = stats.targetLabel ? plainOneLine(stats.targetLabel) : null;
	const reason = stats.routeReason ? [{ text: theme.fg("body", plainOneLine(stats.routeReason)), rank: 2 }] : [];
	if (stats.route === "ready") {
		return fitByPriority(
			theme,
			[
				{ text: theme.fg("success", `${GLYPH.ok} ready`), rank: 0 },
				...(target ? [{ text: theme.fg("body", `${target} target healthy`), rank: 1 }] : []),
			],
			room,
		);
	}
	if (stats.route === "checking") {
		return fitByPriority(
			theme,
			[
				{ text: theme.fg("annotation", "checking"), rank: 0 },
				...(target ? [{ text: theme.fg("annotation", `${target} target`), rank: 1 }] : []),
			],
			room,
		);
	}
	if (stats.route === "degraded") {
		return fitByPriority(theme, [{ text: theme.fg("warning", `${GLYPH.warn} degraded`), rank: 0 }, ...reason], room);
	}
	if (stats.route === "unavailable") {
		return fitByPriority(theme, [{ text: theme.fg("error", `${GLYPH.error} unavailable`), rank: 0 }, ...reason], room);
	}
	return truncateToWidth(theme.fg("warning", `${GLYPH.warn} no model connected`), room, GLYPH.ellipsis, false);
}

/** OS sandbox containment verdict for `detailed` without duplicating the status bar's autonomy badge. */
function sandboxValue(theme: PancodeTheme, stats: WelcomeDashboardStats, room: number): string {
	const sep = ` ${GLYPH.sep} `;
	if (stats.autonomy === "yolo") {
		const text =
			stats.yoloConfinement === "unconfined" ? `unconfined${sep}no OS sandbox` : `contained${sep}OS sandbox active`;
		return truncateToWidth(
			theme.fg(stats.yoloConfinement === "unconfined" ? "warning" : "body", text),
			room,
			GLYPH.ellipsis,
			false,
		);
	}
	const text =
		stats.shellContained === true
			? `auto in workspace${sep}OS sandbox active`
			: stats.shellContained === false
				? `auto edits${sep}no OS sandbox`
				: "auto edits";
	return truncateToWidth(theme.fg("body", text), room, GLYPH.ellipsis, false);
}

/** Project awareness (`PANCODE.md`) status plus its actionable command when indexing or repair is needed. */
function awarenessValue(theme: PancodeTheme, stats: WelcomeDashboardStats, room: number): string {
	switch (stats.projectContext) {
		case "none":
			return fitByPriority(
				theme,
				[
					{ text: theme.fg("body", "not indexed yet"), rank: 0 },
					{ text: theme.fg("guidance", "/context init"), rank: 1 },
				],
				room,
			);
		case "stale":
			return fitByPriority(
				theme,
				[
					{ text: theme.fg("warning", "out of date"), rank: 0 },
					{ text: theme.fg("guidance", "/context refresh"), rank: 1 },
				],
				room,
			);
		case "malformed":
			return fitByPriority(
				theme,
				[
					{ text: theme.fg("warning", "PANCODE.md needs repair"), rank: 0 },
					{ text: theme.fg("guidance", "/context"), rank: 1 },
				],
				room,
			);
		case "ok": {
			const preload = stats.projectPreload ? plainOneLine(stats.projectPreload) : null;
			const split = preload ? preload.indexOf(": ") : -1;
			const files = preload === null ? "PANCODE.md" : split > 0 ? preload.slice(0, split) : preload;
			const note = preload !== null && split > 0 ? preload.slice(split + 2) : null;
			return fitByPriority(
				theme,
				[
					{ text: theme.fg("body", "up to date"), rank: 0 },
					{ text: theme.fg("annotation", files), rank: 1 },
					...(note ? [{ text: theme.fg("annotation", note), rank: 2 }] : []),
				],
				room,
			);
		}
		case "checking":
			return theme.fg("annotation", "checking");
	}
}

/** A meter of the most-used subscription window, then the windows themselves, dropped whole from the right. */
function usageValue(theme: PancodeTheme, quota: string, room: number): string {
	const summary = sanitizeCallTargetText(quota).replace(/% used/g, "%");
	const used = Math.max(0, ...[...summary.matchAll(/(\d+(?:\.\d+)?)%/gu)].map((found) => Number(found[1])));
	const bar = 10;
	const units = summary.split(/ [·|] /u).map((text, index) => ({ text: theme.fg("body", text), rank: index }));
	const words = fitByPriority(theme, units, Math.max(1, room - bar - 1));
	return `${meter(theme, { value: used, max: 100, width: bar, amount: "" })} ${words}`;
}

function relativeAge(iso: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(minutes)) return "earlier";
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** `11m ago · "first words…" · /resume`; only the quote is ever cut. */
function lastValue(theme: PancodeTheme, stats: WelcomeDashboardStats, room: number): string {
	const last = stats.lastSession;
	if (last === undefined || last === "checking") return theme.fg("annotation", "checking");
	if (last === null) return theme.fg("annotation", "no earlier session here");
	const sep = ` ${GLYPH.sep} `;
	const age = relativeAge(last.lastActiveAt, stats.now ?? Date.now());
	const resume = "/resume";
	const words = last.preview ?? last.name;
	const quoteRoom = room - visibleWidth(age) - visibleWidth(resume) - 2 * visibleWidth(sep) - 2;
	const quote =
		words && quoteRoom >= 8 ? [`"${truncateToWidth(plainOneLine(words), quoteRoom, GLYPH.ellipsis, false)}"`] : [];
	return fitByPriority(
		theme,
		[
			{ text: theme.fg("body", age), rank: 0 },
			...quote.map((text) => ({ text: theme.fg("body", text), rank: 2 })),
			{ text: theme.fg("guidance", resume), rank: 1 },
		],
		room,
	);
}

/**
 * The launchpad header row: persistent `▐P▌` mark, `PanCode`, version and, where it fits, the
 * product tagline, never duplicating the route.
 */
function headerRows(theme: PancodeTheme, version: string, room: number): string[] {
	const mark = brandMark(theme);
	const name = wordmarkName(theme);
	const short = version
		.replace(/ · .*$/u, "")
		.replace(new RegExp(` ${GLYPH.sep.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} .*$`, "u"), "");
	const tagline = theme.fg("annotation", ` ${GLYPH.sep} ${PRODUCT_TAGLINE}`);
	const identities = [
		`${name} ${theme.fg("annotation", version)}${tagline}`,
		`${name} ${theme.fg("annotation", short)}${tagline}`,
		`${name} ${theme.fg("annotation", version)}`,
		`${name} ${theme.fg("annotation", short)}`,
		name,
	];
	for (const identity of identities) {
		if (visibleWidth(`${mark} ${identity}`) <= room) return [`${mark} ${identity}`];
	}
	return [truncateToWidth(mark, room, "", false)];
}

function launchpadFacts(
	theme: PancodeTheme,
	stats: WelcomeDashboardStats,
	version: string,
	width: number,
	evidence: boolean,
	provenance: boolean,
	/** Physical rows a W1 launchpad may take: whole facts give way from the bottom while blockers stay. */
	limit = Number.MAX_SAFE_INTEGER,
): string[] {
	const blocked = blockers(stats);
	const stackLabels = width < STACKED_FACT_WIDTH;
	const valueRoom = Math.max(1, stackLabels ? width - FACT_INDENT : width - FACT_INDENT - FACT_LABEL_WIDTH - 2);
	const header = headerRows(theme, version, width);
	if (!evidence) {
		return [...header, ...blocked.map((step) => stepText(theme, step, width))];
	}
	const indent = " ".repeat(FACT_INDENT);
	const fact = (label: string, value: string): string[] =>
		stackLabels
			? [`${indent}${theme.fg("fieldName", label)}`, ...wrapTextWithAnsi(value, valueRoom).map((row) => `${indent}${row}`)]
			: [`${indent}${theme.fg("fieldName", label.padEnd(FACT_LABEL_WIDTH))}  ${value}`];

	const blockerRows = blocked.map((step) => `${indent}${stepText(theme, step, Math.max(1, width - FACT_INDENT))}`);
	const groups: string[][] = [];
	if (provenance) {
		groups.push(fact("health", healthValue(theme, stats, valueRoom)));
		groups.push(fact("sandbox", sandboxValue(theme, stats, valueRoom)));
	}
	groups.push(fact("awareness", awarenessValue(theme, stats, valueRoom)));
	if (stats.quota !== null) {
		groups.push(fact("usage", usageValue(theme, stats.quota, valueRoom)));
	}
	groups.push(fact("last here", lastValue(theme, stats, valueRoom)));

	const body: string[] = [];
	for (const group of groups) {
		if (stackLabels && header.length + blockerRows.length + body.length + group.length > limit) break;
		body.push(...group);
	}
	return [...header, ...blockerRows, ...body];
}

export function buildWelcomeDashboardLines(
	stats: WelcomeDashboardStats,
	versionLabel: string,
	width: number,
	mode: WelcomeDashboardMode,
	_getKeyLabel?: WelcomeDashboardDeps["getKeyLabel"],
	tagline = SESSION_TAGLINE,
	terminalRows?: number,
): string[] {
	const version = versionLabel.replace(/ \(unreleased(?: · ([^)]+))?\)$/u, (_match, commit: string | undefined) =>
		commit ? ` ${GLYPH.sep} ${commit}` : "",
	);
	const theme = pancodeTheme();
	const safeWidth = Math.max(1, width);
	if (mode === "session") {
		const coverage = stats.projectPreload
			? wrapTextWithAnsi(
					`${theme.fg("fieldName", "Instructions  ")}${theme.fg("body", sanitizeCallTargetText(stats.projectPreload))}`,
					safeWidth,
				)
			: [];
		return [padAnsi(sessionRow(theme, stats, version, safeWidth), safeWidth), ...coverage];
	}
	const rows = terminalRows ?? Number.MAX_SAFE_INTEGER;
	const short = rows < SHORT_TERMINAL_ROWS;
	const policy = tierPolicy(short ? "compact" : (stats.outputStyle ?? "standard"));
	const firstBoot = stats.firstBoot === true;
	const form = brandForm(firstBoot, safeWidth, rows, policy.evidence);
	const art =
		form === "stacked"
			? paintWelcomeWordmark(safeWidth >= WIDE_ART_MIN_WIDTH ? WELCOME_WORDMARK_WIDE : WELCOME_WORDMARK, theme)
			: form === "band-above"
				? paintWelcomeRowWordmark(theme)
				: [];
	const artWidth = form === "stacked" ? visibleWidth(art[0] ?? "") : 0;
	const factStart = artWidth > 0 ? artWidth + COLUMN_GAP : 0;
	const factWidth = Math.max(1, safeWidth - factStart);
	const facts = launchpadFacts(
		theme,
		stats,
		version,
		factWidth,
		policy.evidence,
		policy.provenance,
		Math.floor((terminalRows ?? 24) / 2),
	);
	const block = facts.map((row) => truncateToWidth(row, factWidth, GLYPH.ellipsis, false));
	const taglineIndent = policy.evidence && factWidth >= 26 ? " ".repeat(FACT_INDENT) : "";
	const taglineRoom = Math.max(1, factWidth - taglineIndent.length);
	const taglineRows =
		!tagline || factWidth < 24
			? []
			: factWidth < STACKED_FACT_WIDTH
				? [`${taglineIndent}${truncateToWidth(theme.fg("annotation", tagline), taglineRoom, GLYPH.ellipsis, false)}`]
				: wrapTextWithAnsi(theme.fg("annotation", tagline), taglineRoom).map((row) => `${taglineIndent}${row}`);
	const besideArt = (lines: readonly string[], offset: number): string[] =>
		Array.from({ length: Math.max(art.length, lines.length + offset) }, (_, index) => {
			const fact = lines[index - offset] ?? "";
			const mark = art[index] ?? "";
			return fact === "" ? mark : `${padAnsi(mark, artWidth)}${" ".repeat(COLUMN_GAP)}${fact}`;
		});
	let lines: string[];
	if (form === "stacked") {
		const withGap =
			policy.evidence && taglineRows.length > 0 && block.length + 1 + taglineRows.length <= STACKED_ROWS
				? [...block, "", ...taglineRows]
				: block.length + taglineRows.length <= STACKED_ROWS
					? [...block, ...taglineRows]
					: block;
		lines = besideArt(withGap, Math.max(0, Math.floor((STACKED_ROWS - withGap.length) / 2)));
	} else {
		const head = art.length > 0 ? [...art, ""] : [];
		const fitsGap = head.length + block.length + 1 + taglineRows.length <= STACKED_ROWS;
		const gap = policy.evidence && fitsGap ? [""] : [];
		const withTagline = !short && taglineRows.length > 0 ? [...block, ...gap, ...taglineRows] : block;
		lines = [...head, ...withTagline];
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, GLYPH.ellipsis, false));
}

/**
 * Everything that can change what the banner prints, flattened to one comparable
 * string. Deliberately short: the previous signature folded in extension counts,
 * task-memory size, capabilities and wiki facts that no render path read, so
 * unrelated background activity invalidated the render cache and rebuilt rows
 * that could not have differed.
 */
function statsSignature(stats: WelcomeDashboardStats): string {
	const workspace = stats.workspace;
	return [
		stats.cwd,
		workspace &&
			`${workspace.isGit}\x01${workspace.branch}\x01${workspace.dirty}\x01${workspace.ahead}\x01${workspace.behind}\x01${workspace.pending}\x01${workspace.gitUnknown}`,
		stats.targetLabel,
		stats.modelLabel,
		stats.route,
		stats.routeReason,
		stats.projectContext,
		stats.projectPreload,
		stats.autonomy,
		stats.yoloConfinement,
		stats.shellContained,
		stats.outputStyle,
		stats.quota,
		stats.projectConfig,
		stats.firstBoot,
		stats.contextWindow,
		stats.lastSession === undefined || stats.lastSession === null || typeof stats.lastSession === "string"
			? stats.lastSession
			: `${stats.lastSession.lastActiveAt}\x01${stats.lastSession.preview}\x01${stats.lastSession.name}`,
	].join("\0");
}

const launchRoots = new Map<string, string>();
function launchRoot(cwd: string): string {
	let root = launchRoots.get(cwd);
	if (root === undefined) {
		root = pancodeProjectRoot(cwd);
		launchRoots.set(cwd, root);
	}
	return root;
}

/**
 * Whether this launch is the project's first. Only a launchpad painted on a terminal counts, so a piped process
 * neither reads nor writes the marker and never decides a project's first boot.
 */
function firstBootHere(): boolean {
	return process.stdout.isTTY === true && !projectSeen(launchRoot(process.cwd()));
}

const markedRoots = new Set<string>();
/** Records the first launchpad after it painted, off the frame that painted it. */
function noteLaunchpadPainted(): void {
	if (process.stdout.isTTY !== true) return;
	const root = launchRoot(process.cwd());
	if (markedRoots.has(root)) return;
	markedRoots.add(root);
	setTimeout(() => markProjectSeen(root), 0).unref?.();
}

interface ProjectContextReading {
	cwd: string;
	state: WelcomeProjectContextState;
	preload: string | null;
	/** When the last *successful* read landed. Never renewed by a failure. */
	readAt: number;
	/** When the last attempt finished, successful or not. Paces retries. */
	attemptedAt: number;
	/** When the current failure streak began; null while reads succeed. */
	failingSince: number | null;
}

export class WelcomeDashboard implements WelcomeDashboardComponent {
	private cachedRender: { width: number; signature: string; lines: string[] } | null = null;
	private context: ProjectContextReading | null = null;
	/** Single-flight latch: a read slower than the TTL must not stack refreshes. */
	private contextRefreshing = false;
	private pendingTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private last: { cwd: string; value: WelcomeLastSession | null } | null = null;
	private lastReading = false;
	/** Bumped by a new session, so a read begun for the session just left cannot land on the new launchpad. */
	private lastEpoch = 0;
	private mode: WelcomeDashboardMode = "launchpad";
	private readonly now: () => number;
	private readonly schedule: (run: () => void) => void;
	/**
	 * Read once, here, rather than inside a frame: resolving it walks up for
	 * package.json and parses it, which is filesystem work the render path must
	 * not do even once.
	 */
	private readonly version: string;

	constructor(private readonly deps: WelcomeDashboardDeps) {
		this.now = deps.now ?? ((): number => Date.now());
		this.schedule =
			deps.scheduleRefresh ??
			((run: () => void): void => {
				this.pendingTimer = setTimeout(() => {
					this.pendingTimer = null;
					run();
				}, 0);
				this.pendingTimer.unref?.();
			});
		this.version = readPancodeVersionLabel();
	}

	render(width: number): string[] {
		const settings = this.deps.getSettings?.();
		const mode = richWelcomeEnabled(settings?.interface?.demo) ? this.mode : "session";
		const terminalRows = this.deps.getTerminalRows?.();
		const stats = this.stats(mode, terminalRows);
		const signature = `${skinEpoch()}\0${tierRevision()}\0${mode}\0${statsSignature(stats)}\0${terminalRows}`;
		const cached = this.cachedRender;
		if (cached !== null && cached.width === width && cached.signature === signature) return cached.lines;
		const lines = buildWelcomeDashboardLines(
			stats,
			this.version,
			width,
			mode,
			this.deps.getKeyLabel,
			SESSION_TAGLINE,
			terminalRows,
		);
		this.cachedRender = { width, signature, lines };
		if (mode === "launchpad") noteLaunchpadPainted();
		return lines;
	}

	isLaunchpadVisible(): boolean {
		const settings = this.deps.getSettings?.();
		return this.mode === "launchpad" && richWelcomeEnabled(settings?.interface?.demo);
	}

	/** Collapse once, before first-submit dispatch can append transcript output. */
	collapseToSessionHeader(): boolean {
		if (this.mode === "session") return false;
		this.mode = "session";
		this.cachedRender = null;
		return true;
	}

	/** A genuinely new session gets a fresh launchpad and a fresh one-time transition. */
	resetToLaunchpad(): boolean {
		if (this.mode === "launchpad") return false;
		this.mode = "launchpad";
		this.context = null;
		// The session just left is now the earlier session here, so `last here` reads again.
		this.last = null;
		this.lastReading = false;
		this.lastEpoch += 1;
		this.cachedRender = null;
		return true;
	}

	/**
	 * Drops the rendered lines only. The project-context reading is not
	 * width-dependent, and pi cascades `invalidate` on terminal cell-dimension
	 * reports; dropping the reading there would flash the header back to
	 * `checking` for a fact that had not changed.
	 */
	invalidate(): void {
		this.cachedRender = null;
	}

	/**
	 * After this, a refresh already in flight lands on the floor: it neither
	 * writes state nor asks for a frame from a presentation that is being torn
	 * down.
	 */
	dispose(): void {
		this.disposed = true;
		if (this.pendingTimer !== null) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private stats(mode: WelcomeDashboardMode, terminalRows: number | undefined): WelcomeDashboardStats {
		const settings = this.deps.getSettings?.();
		const statuses = this.deps.providers.list();
		const current = findCurrentStatus(statuses, settings);
		const targetLabel = current?.target.id ?? settings?.chat?.target ?? null;
		const modelLabel = settings?.chat?.model ?? current?.target.defaultModel ?? null;
		const workspace = this.deps.getWorkspaceSnapshot?.() ?? null;
		const cwd = workspace?.cwd ?? process.cwd();
		const { route, routeReason } = deriveRoute(current, targetLabel, modelLabel);
		// The collapsed row prints neither of these, so it does not pay for them:
		// no background context read, and no cache invalidation when either
		// changes while the header cannot show it. `/new` returns to the launchpad
		// and the check resumes on the next frame.
		const launchpad = mode === "launchpad";
		const outputStyle = settings?.interface?.outputDetail ?? "standard";
		const preload = launchpad && this.context?.cwd === cwd ? this.context.preload : null;
		// Only facts a row shows are read: usage and the earlier session cost a provider read and a history scan.
		const short = terminalRows !== undefined && terminalRows < SHORT_TERMINAL_ROWS;
		const showOrientation = launchpad && tierPolicy(short ? "compact" : outputStyle).evidence;
		const window = current?.contextWindowProvenance === "runtime-default" ? null : current?.capabilities.contextWindow;
		return {
			outputStyle,
			firstBoot: launchpad && firstBootHere(),
			contextWindow: typeof window === "number" && window > 0 ? window : null,
			...(showOrientation ? { lastSession: this.lastSessionFor(cwd), now: this.now() } : {}),
			cwd,
			workspace,
			targetLabel,
			modelLabel,
			route,
			routeReason,
			projectContext: showOrientation ? this.projectContext(cwd) : "checking",
			projectPreload: preload,
			submitKeyLabel: null,
			autonomy: settings?.safety?.autonomy ?? "default",
			yoloConfinement: effectiveYoloConfinement(settings?.safety),
			shellContained: this.deps.getShellContained?.() ?? null,
			quota: showOrientation ? (this.deps.getQuotaSummary?.() ?? null) : null,
			targets: "",
			fleet: "",
			projectConfig: this.deps.getProjectConfigReminder?.() ?? null,
		};
	}

	/**
	 * Returns immediately, always, and never touches the filesystem. On a miss it
	 * reports `checking` and schedules the authoritative read off the frame. A
	 * reading is only ever served for the cwd it was taken in, so a directory
	 * change reports `checking` again rather than the previous repository's answer.
	 */
	private projectContext(cwd: string): WelcomeProjectContextState {
		const cached = this.context;
		if (cached === null || cached.cwd !== cwd) {
			this.scheduleContextRefresh(cwd);
			return "checking";
		}
		const at = this.now();
		// Reads that have been failing for longer than the trust window stop
		// standing in for a current one. Without this a stale `ok` survives every
		// failed refresh forever.
		if (cached.failingSince !== null && at - cached.failingSince >= WELCOME_PROJECT_CONTEXT_TTL_MS) {
			if (at - cached.attemptedAt >= WELCOME_PROJECT_CONTEXT_RETRY_MS) this.scheduleContextRefresh(cwd);
			return "checking";
		}
		if (at - cached.readAt < WELCOME_PROJECT_CONTEXT_TTL_MS) return cached.state;
		const due = cached.failingSince === null ? cached.attemptedAt : cached.attemptedAt + WELCOME_PROJECT_CONTEXT_RETRY_MS;
		if (at >= due) this.scheduleContextRefresh(cwd);
		// A refresh is in flight or pending; keep showing the last real reading
		// rather than flickering to `checking` on every TTL boundary.
		return cached.state;
	}

	/**
	 * The earlier session, or `checking` while its read is pending. The read runs once per directory off the frame;
	 * off a terminal it never runs, since a piped process has no launchpad an operator reads.
	 */
	private lastSessionFor(cwd: string): WelcomeLastSession | null | "checking" {
		if (this.last?.cwd === cwd) return this.last.value;
		const read = process.stdout.isTTY === true ? this.deps.readLastSession : undefined;
		if (read === undefined || this.lastReading || this.disposed) return "checking";
		this.lastReading = true;
		const epoch = this.lastEpoch;
		this.schedule(() => {
			void read(cwd, this.now())
				.catch(() => null)
				.then((value) => {
					if (epoch !== this.lastEpoch) return;
					this.lastReading = false;
					if (this.disposed) return;
					this.last = { cwd, value };
					this.cachedRender = null;
					this.deps.onFactsRefreshed?.();
				});
		});
		return "checking";
	}

	private scheduleContextRefresh(cwd: string): void {
		const read = this.deps.getContextState;
		if (read === undefined || this.contextRefreshing || this.disposed) return;
		this.contextRefreshing = true;
		this.schedule(() => {
			if (this.disposed) {
				this.contextRefreshing = false;
				return;
			}
			let resolved: WelcomeProjectContextState | null = null;
			let preload: string | null = null;
			try {
				resolved = normalizeProjectContext(read(cwd));
				preload = this.deps.getProjectPreload?.(cwd) ?? null;
			} catch {
				// A read that threw proves nothing about the workspace. Never turn it
				// into `ok` or `none`.
				resolved = null;
			} finally {
				this.contextRefreshing = false;
			}
			if (this.disposed) return;
			const at = this.now();
			// A reading belongs to the directory it was taken in. If cwd moved while
			// this was in flight, the entry is still filed under its own cwd and the
			// next frame will report `checking` for the new one.
			const previous = this.context !== null && this.context.cwd === cwd ? this.context : null;
			this.context =
				resolved === null
					? {
							cwd,
							state: previous?.state ?? "checking",
							preload: previous?.preload ?? null,
							// Deliberately not renewed: a failure must not extend the trust
							// window of the value it failed to confirm.
							readAt: previous?.readAt ?? 0,
							attemptedAt: at,
							failingSince: previous?.failingSince ?? at,
						}
					: { cwd, state: resolved, preload, readAt: at, attemptedAt: at, failingSince: null };
			this.cachedRender = null;
			this.deps.onFactsRefreshed?.();
		});
	}
}

export function createWelcomeDashboard(deps: WelcomeDashboardDeps): WelcomeDashboard {
	return new WelcomeDashboard(deps);
}

/** Same welcome geometry before hydration, using only the settings already read. */
export function createBootWelcome(
	settings: Readonly<PancodeSettings>,
	submitKeyLabel: string | null,
	getKeyLabel?: WelcomeDashboardDeps["getKeyLabel"],
): Component {
	const target = settings.targets.find((entry) => entry.id === settings.chat.target);
	const model = settings.chat.model ?? target?.defaultModel ?? null;
	const version = readPancodeVersionLabel();
	const mode = richWelcomeEnabled(settings.interface.demo) ? "launchpad" : "session";
	const stats: WelcomeDashboardStats = {
		outputStyle: settings.interface.outputDetail,
		firstBoot: mode === "launchpad" && firstBootHere(),
		lastSession: "checking",
		cwd: process.cwd(),
		workspace: null,
		targetLabel: settings.chat.target ?? null,
		modelLabel: model,
		route: target && model ? "checking" : "unset",
		routeReason: null,
		projectContext: "checking",
		submitKeyLabel,
		// Boot reserves the quota slots without making a provider read.
		quota: null,
		autonomy: settings.safety.autonomy,
		yoloConfinement: effectiveYoloConfinement(settings.safety),
		targets: "",
		fleet: "",
	};
	let cached: { width: number; rows: number; epoch: number; lines: string[] } | null = null;
	return {
		render: (width) => {
			const rows = process.stdout.rows;
			if (cached?.width === width && cached.rows === rows && cached.epoch === skinEpoch()) return cached.lines;
			const lines = buildWelcomeDashboardLines(stats, version, width, mode, getKeyLabel, SESSION_TAGLINE, rows);
			cached = { width, rows, epoch: skinEpoch(), lines };
			if (mode === "launchpad") noteLaunchpadPainted();
			return lines;
		},
		invalidate: () => {
			cached = null;
		},
	};
}
