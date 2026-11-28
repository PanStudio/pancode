// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PancodePulse, PULSE_SIZE } from "../shell/PancodeMark.js";
import type { StatusTone } from "./status-model.js";

export type { StatusTone } from "./status-model.js";
export { toneForOutcome } from "./status-model.js";

/** One glyph per tone. Exported for compact marks that carry their words in an accessible name. */
export const TONE_GLYPHS: Readonly<Record<StatusTone, string>> = {
	neutral: "·",
	running: "▸",
	success: "●",
	warn: "◐",
	fail: "✕",
	unverified: "◌",
};

export function StatusMark({
	tone = "neutral",
	label,
	detail,
	title,
	live = false,
}: {
	tone?: StatusTone;
	label: string;
	detail?: string;
	title?: string;
	/**
	 * PanCode, a worker or a tool is doing this right now, so the mark carries the PanCode spinner instead of
	 * the tone's glyph. Pass it only for live work. A recorded or replayed state that merely reads
	 * "running" keeps its glyph, because a spinner would claim activity nothing is performing.
	 */
	live?: boolean;
}) {
	return (
		<span className="status-mark" data-tone={tone} data-live={live ? "yes" : undefined} title={title}>
			<span className="status-mark__glyph" aria-hidden="true">
				{live ? <PancodePulse size={PULSE_SIZE.inline} /> : TONE_GLYPHS[tone]}
			</span>
			{label}
			{detail ? <span className="status-mark__detail">{detail}</span> : null}
		</span>
	);
}
