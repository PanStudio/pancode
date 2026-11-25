// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer's model: what the session tells the editor (`EditorChrome`), the mode that follows from it, the empty
 * prompt and permission keys each mode shows, and the shell and overlay rule words the rails fit. The editor in
 * `pancode-editor.ts` owns the keyboard, the dock and the painting.
 */

import { renderFakeCursor, truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { TurnPreparationPhase } from "../session-control/turn-state.js";
import { fitHintEntries } from "./overlay-frame.js";
import { type PermissionInspectionHint, type PermissionTermsHint, permissionHintEntries } from "./permission-hint.js";
import type { PancodeTheme } from "./theme/index.js";
import { GLYPH } from "./theme/index.js";

// Since Pi 1.4 (4f2422c16) the Editor draws its cursor cell between zero-width
// markers the TUI resolves to reverse video only when it paints, so the composer
// finds the cursor by those markers rather than by an SGR sequence.
const FAKE_CURSOR_BLANK = renderFakeCursor(" ");
export const FAKE_CURSOR_START = FAKE_CURSOR_BLANK.slice(0, FAKE_CURSOR_BLANK.indexOf(" "));
export const EMPTY_PROMPT = `Ask Panos${GLYPH.ellipsis}`;
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
const PREPARING_PROMPT = "PanCode has your prompt and is preparing the turn";
const COMPACTING_PROMPT = "PanCode is compacting the session context";

export interface EditorChrome {
	/** Actor name passed to a docked approval card's top rule. */
	getApprovalActor?: () => string;
	/** Effective session autonomy for composer surface theme context (never drawn as a rail badge). */
	getAutonomy?: () => string;
	/** Monotonic animation clock, injectable for deterministic rendering tests. */
	getAnimationTime?: () => number;
	/** Optional motion override; terminal accessibility preferences always apply. */
	getMotionEnabled?: () => boolean;
	/** Whether Enter currently targets the active PanCode response. */
	isStreaming?: () => boolean;
	/** Whether a permission prompt owns the keyboard. */
	isAwaitingApproval?: () => boolean;
	/** Whether that prompt has a mutation to inspect, and whether it is open (issue #254). */
	getPermissionInspection?: () => PermissionInspectionHint;
	getPermissionTerms?: () => PermissionTermsHint;
	/** Where a consumed prompt sits between the editor and the stream (issue #251). */
	getTurnPreparation?: () => TurnPreparationPhase;
	/** Whether the current draft will actually steer PanCode or live dispatch work on Enter. */
	willEnterSteer?: (text: string) => boolean;
	/** The draft is a command or a shell line, which Enter never queues for the run. */
	getDraftOperator?: (text: string) => "command" | "shell" | null;
	/** The worker a draft's `@target` resolves to, by agent name, and whether it still waits for a slot; null when none. */
	getSteerRecipient?: (token: string) => { agentId: string; queued: boolean } | null;
	/** Count of queued follow-up messages shown on the top rail while non-zero. */
	getQueuedFollowUpCount?: () => number;
	/** Plain key label for opening the follow-up queue (no brackets). */
	getQueueReviewKeyLabel?: () => string | null;
	/** Whether `"!"` shell drafts have been used before, shortening the bottom-rail disclosure. */
	isShellDraftLearned?: () => boolean;
	/** Whether the compact new-user `?` door should show on the empty idle prompt. */
	showCompactKeysDoor?: () => boolean;
	/** Called when the compact `?` door renders so its session lifetime is recorded once. */
	onCompactKeysDoorShown?: () => void;
	/** Resolved submit binding, formatted for display. */
	getSubmitKeyLabel?: () => string;
	/** Resolved multiline binding, formatted for display. */
	getNewlineKeyLabel?: () => string;
}

export type ComposerMode = "MESSAGE" | "FOLLOW-UP" | "STEER" | "CONFIRM" | "PREPARING" | "COMPACTING";

/** One unit of an overlay rule's right end: plain text for fitting, painted when drawn. */
export interface RuleUnit {
	text: string;
	paint: (text: string) => string;
}

/**
 * Cells an overlay rule spends around its labels: `━ ` and a space around the title, at least one cell of fill, and a
 * space and `━` on each side of the right units. Without right units the title keeps `━ `, its space and one fill cell.
 */
export const OVERLAY_RULE_CHROME = 7;
/** Draft rows a decision card leaves visible under itself. */
export const APPROVAL_DRAFT_ROWS = 2;
export const OVERLAY_RULE_BARE = 4;

/**
 * The shell unit that leads the bottom rail while the draft is a shell line, fullest first. The distinguishing word
 * comes first, so every shorter form keeps it.
 */
export const SHELL_RAIL_FORMS: Readonly<Record<"shared" | "private", readonly string[]>> = {
	shared: [
		`$ shared shell ${GLYPH.sep} Enter runs ${GLYPH.sep} Panos sees the output`,
		`$ shared shell ${GLYPH.sep} Enter runs`,
		`$ shared ${GLYPH.sep} Enter runs`,
		"$ shared",
	],
	private: [
		`$ private shell ${GLYPH.sep} Enter runs ${GLYPH.sep} output stays with you`,
		`$ private shell ${GLYPH.sep} Enter runs`,
		`$ private ${GLYPH.sep} Enter runs`,
		"$ private",
	],
};

/** Shortened shell rail forms once `"!"` has been used. */
export const SHELL_RAIL_LEARNED_FORMS: Readonly<Record<"shared" | "private", readonly string[]>> = {
	shared: [`$ shared ${GLYPH.sep} Enter runs`, "$ shared"],
	private: [`$ private ${GLYPH.sep} Enter runs`, "$ private"],
};

export function composerMode(chrome: EditorChrome, text: string): ComposerMode {
	if (chrome.isAwaitingApproval?.() ?? false) return "CONFIRM";
	if (!(chrome.isStreaming?.() ?? false)) {
		// A prompt PanCode is holding is not an idle composer. Streaming outranks it
		// because a steer typed during a live run is what the rail is for, and a
		// steer's own submit passes through this window on its way to the queue.
		const preparation = chrome.getTurnPreparation?.() ?? "idle";
		if (preparation === "compacting") return "COMPACTING";
		if (preparation === "preparing") return "PREPARING";
		return "MESSAGE";
	}
	const willSteer = chrome.willEnterSteer?.(text) ?? text.trim().length > 0;
	return willSteer ? "STEER" : "FOLLOW-UP";
}

/**
 * The permission keys on the composer rail, fitted like the dialog footer so
 * both surfaces narrow in the same order and never drop allow or stop first.
 * The rule spends three columns around a right label, hence the subtraction.
 */
export function confirmRailHint(
	theme: PancodeTheme,
	width: number,
	hasDraft: boolean,
	inspection: PermissionInspectionHint,
	terms: PermissionTermsHint = "closed",
): string {
	// The terms state rides along so an open terms view reads `[Esc] hide terms` here too, never `deny`.
	return theme.fg(
		"decisionKey",
		fitHintEntries(permissionHintEntries(hasDraft, inspection, terms), Math.max(1, width - 3)),
	);
}

/** The line the empty composer shows for the mode it is in. */
export function emptyPromptFor(mode: ComposerMode): string {
	if (mode === "CONFIRM") return CONFIRM_PROMPT;
	if (mode === "PREPARING") return PREPARING_PROMPT;
	if (mode === "COMPACTING") return COMPACTING_PROMPT;
	return EMPTY_PROMPT;
}

export function renderEmptyPrompt(
	line: string,
	width: number,
	theme: PancodeTheme,
	text = EMPTY_PROMPT,
	compactKeysDoor = false,
): string {
	const cursorAt = line.indexOf(FAKE_CURSOR_BLANK);
	if (cursorAt < 0) return line;
	const afterCursorAt = cursorAt + FAKE_CURSOR_BLANK.length;
	const available = Math.max(0, width - 1);
	const invitation =
		text === EMPTY_PROMPT && compactKeysDoor
			? `${theme.fg("inputPlaceholder", `Ask Panos${GLYPH.ellipsis}  `)}${theme.fg("commandHint", "? keys")}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("commandHint", "/ commands")}`
			: theme.fg("inputPlaceholder", text);
	const prompt = truncateToWidth(invitation, available, GLYPH.ellipsis, false);
	const consumed = visibleWidth(prompt);
	return `${line.slice(0, afterCursorAt)}${prompt}${line.slice(afterCursorAt + consumed)}`;
}
