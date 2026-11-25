// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Reported reasoning, behind a disclosure. Thinking is provenance, not prose: collapsed it is one quiet
 * line with its first sentence, and the words "reported by PanCode" travel with it for assistive
 * technology and appear above the full text once opened. The body is only rendered while open, so a
 * long streamed thought does not re-lay out a closed line on every frame. Models write their thoughts in
 * markdown, so the body renders it as the answer does (gui-verify 10).
 */

import { useState } from "react";
import type { TimelineItem } from "../../contracts/sessions.js";
import { MarkdownContent } from "../render/Markdown.js";
import { REASONING_LABEL, REASONING_SOURCE, reasoningPreview } from "./chat-turn.js";

export function ReasoningDisclosure({ item, compact = false }: { item: TimelineItem; compact?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<details
			className={`reasoning${compact ? " reasoning--row" : ""}`}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="reasoning__summary" title={`${REASONING_LABEL}, ${REASONING_SOURCE}`}>
				<span className="reasoning__glyph" aria-hidden="true">
					✎
				</span>
				<span className="reasoning__label">{REASONING_LABEL}</span>
				<span className="sr-only">{REASONING_SOURCE}</span>
				<span className="reasoning__preview">{reasoningPreview(item.text, item.status === "in_progress")}</span>
			</summary>
			{open ? (
				<div className="reasoning__body">
					<p className="reasoning__source">{REASONING_SOURCE}</p>
					<div className="reasoning__text">
						<MarkdownContent source={item.text} complete={item.status !== "in_progress"} />
					</div>
				</div>
			) : null}
		</details>
	);
}
