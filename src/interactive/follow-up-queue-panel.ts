// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "../session-control/chat-loop.js";
import { formatQueueAge, queueEntryMarks, queueSlotWord } from "./overlays/queue-navigator.js";
import { dotSep, GLYPH, type PancodeTheme, pancodeTheme, rule } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

/** Cells kept between a row's text and what sits at its right edge. */
const RIGHT_GAP = 2;
/** A row's text keeps at least this many cells; keys that would leave it less drop first. */
const MIN_TEXT_CELLS = 12;
const HELD_WORDS = "held, nothing sent";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	/** Action labels already formatted from the live binding manager. */
	getNavigateKey?: () => string | undefined;
	getSendNowKey?: () => string | undefined;
	/** The overlay holding the keyboard, `closed` when the composer has it. */
	getOverlayState?: () => string;
	/** No run is going to take the queue, so it waits for the operator (#447). */
	isHeld?: () => boolean;
	now?: () => number;
}

/** A message as one line of text. */
function flat(message: QueuedChatMessage): string {
	return message.text.replace(/\s+/g, " ").trim();
}

/** The steer wears the user's glyph in the action tone; a message for later wears the queued glyph. */
function slotGlyph(theme: PancodeTheme, message: QueuedChatMessage): string {
	return queueSlotWord(message) === "steer" ? theme.fg("attention", GLYPH.user) : theme.fg("body", GLYPH.queued);
}

/** `left` cut with `…` to leave room for `right` at the row's right edge; `right` drops when the text would starve. */
function edgeRow(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth === 0 || width - rightWidth - RIGHT_GAP < MIN_TEXT_CELLS) {
		return truncateToWidth(left, width, GLYPH.ellipsis);
	}
	const room = width - rightWidth - RIGHT_GAP;
	const shown = truncateToWidth(left, room, GLYPH.ellipsis);
	return `${shown}${" ".repeat(Math.max(RIGHT_GAP, width - visibleWidth(shown) - rightWidth))}${right}`;
}

/**
 * The steering queue as an open island above the composer. Compact is one row: the count, the hold when there is
 * one and the next message. Standard is a `Queue N` rule with the composer keys at its right and up to three
 * messages under it; detailed adds each message's mode and age. The navigator is the whole list with its keys.
 */
export function createFollowUpQueuePanel(options: FollowUpQueuePanelOptions = {}): FollowUpQueuePanel {
	let messages: QueuedChatMessage[] = [];
	let dirty = true;
	let cachedWidth = 0;
	let cachedKey: string | undefined;
	let cachedLines: string[] = [];

	const render = (width: number): string[] => {
		const overlay = options.getOverlayState?.() ?? "closed";
		const now = (options.now ?? Date.now)();
		const held = options.isHeld?.() === true;
		const policy = tierPolicy();
		// The waits are part of the key where they show: a cache over the last queue change froze them at that age.
		const key = [
			skinEpoch(),
			tierRevision(),
			overlay,
			held,
			options.getNavigateKey?.(),
			options.getSendNowKey?.(),
			...(policy.queueRowDetail ? messages.map((message) => formatQueueAge(now - message.enqueuedAt)) : []),
		].join("|");
		if (!dirty && cachedWidth === width && cachedKey === key) return cachedLines;
		cachedLines = messages.length === 0 || overlay === "queue-navigator" ? [] : lines(width, overlay, held, now);
		cachedWidth = width;
		cachedKey = key;
		dirty = false;
		return cachedLines;
	};

	const lines = (width: number, overlay: string, held: boolean, now: number): string[] => {
		const theme = pancodeTheme();
		const policy = tierPolicy();
		const safe = Math.max(1, width);
		// These are composer keys, so they say nothing while an overlay owns the keyboard.
		const navigate = overlay === "closed" ? options.getNavigateKey?.() : undefined;
		const sendNow = overlay === "closed" ? options.getSendNowKey?.() : undefined;
		const review = `${navigate && navigate.length > 0 ? navigate : "/help"} review`;
		const keyHint = (text: string): string => theme.fg("keyboardHint", text);
		const separator = dotSep(theme);
		const head = messages[0];
		if (head === undefined) return [];

		if (policy.queueRows === 0) {
			// The top composer rail already renders `› N queued` at compact; keep the above-editor row only while held.
			if (!held) return [];
			const left = [
				`${slotGlyph(theme, head)} ${theme.fg("body", `${messages.length} queued`)}`,
				theme.fg("warning", HELD_WORDS),
				`${theme.fg("annotation", "next:")} ${theme.fg("body", flat(head))}`,
			].join(separator);
			return [edgeRow(left, overlay === "closed" ? keyHint(review) : "", safe)];
		}

		// When not held, the top composer rail directly beneath already owns `› N queued · <key> review`,
		// so omit the redundant `Queue N` header rule and save a vertical row. Keep the header while held,
		// showing only the send-now key (the top composer rail still owns `<key> review`).
		const rows: string[] = [];
		if (held) {
			const title = `Queue ${messages.length}`;
			const titleWidth = visibleWidth(`${title} ${GLYPH.sep} ${HELD_WORDS}`) + 2;
			const sendNowHint = overlay === "closed" && sendNow && sendNow.length > 0 ? `${sendNow} send now` : "";
			const showSendNow = sendNowHint.length > 0 && titleWidth + visibleWidth(sendNowHint) + 6 <= safe;
			const heading = `${theme.style("sectionHeading", title, { bold: true })}${separator}${theme.fg("warning", HELD_WORDS)}`;
			rows.push(
				rule(theme, safe, {
					left: heading,
					leftRaw: true,
					...(showSendNow
						? { right: keyHint(sendNowHint), rightRaw: true, rightTail: theme.fg("divider", GLYPH.rule) }
						: {}),
				}),
			);
		}
		for (const message of messages.slice(0, policy.queueRows)) {
			const glyph = slotGlyph(theme, message);
			if (!policy.queueRowDetail) {
				rows.push(truncateToWidth(`${glyph} ${theme.fg("body", flat(message))}`, safe, GLYPH.ellipsis));
				continue;
			}
			const mode = `${queueSlotWord(message)}${queueEntryMarks(message)}`;
			const modeText = queueSlotWord(message) === "steer" ? theme.fg("attention", mode) : theme.fg("body", mode);
			const age = theme.fg("annotation", formatQueueAge(now - message.enqueuedAt));
			rows.push(edgeRow(`${glyph} ${modeText}  ${theme.fg("body", flat(message))}`, age, safe));
		}
		const hidden = messages.length - policy.queueRows;
		if (hidden > 0) rows.push(truncateToWidth(`  ${theme.fg("annotation", `+${hidden} more`)}`, safe, GLYPH.ellipsis));
		return rows;
	};

	return {
		setMessages(nextMessages): void {
			messages = [...nextMessages];
			dirty = true;
		},
		render,
		invalidate(): void {
			dirty = true;
		},
	};
}
