// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Keycaps } from "../interaction/Keycaps.js";
import { type Attachment, attachmentSummary } from "./attachments-model.js";
import type { DraftEstimate } from "./composer-model.js";

/** The keys under the field, the attachments going with the draft, and the draft's size estimate. */
export function ComposerKeyboardHint({
	hintId,
	enterSends,
	sendsNow,
	attachments,
	estimate,
}: {
	hintId: string;
	enterSends: boolean;
	/** Alt+S delivers the draft as immediate direction. */
	sendsNow: boolean;
	attachments: readonly Attachment[];
	estimate: DraftEstimate | null;
}) {
	return (
		<p
			className="composer__hint composer__keyboard-hint"
			id={hintId}
			{...(attachments.length > 0 ? { "data-pinned": true } : {})}
		>
			<span className="composer__keys">
				{enterSends ? (
					<span>
						<Keycaps chord="Shift + Enter" /> adds a line
					</span>
				) : (
					<>
						<span>
							<Keycaps chord="Enter" /> adds a line
						</span>{" "}
						<span>
							· <Keycaps chord="Ctrl/Cmd + Enter" /> sends
						</span>
					</>
				)}{" "}
				{sendsNow ? (
					<>
						<span>
							· <Keycaps chord="Alt + S" /> sends now
						</span>{" "}
					</>
				) : null}
				<span>
					· <Keycaps chord="/" /> lists commands
				</span>{" "}
				<span>
					· <Keycaps chord="@" /> adds a file or folder
				</span>{" "}
				<span>
					· <Keycaps chord="↑" /> recalls earlier messages
				</span>{" "}
				<span>
					· <Keycaps chord="Ctrl/Cmd + R" /> searches history
				</span>
			</span>
			{attachments.length > 0 ? <span className="composer__attached"> · {attachmentSummary(attachments)}</span> : null}
			{estimate ? (
				<span className="composer__estimate" title={estimate.title}>
					{" "}
					{estimate.text}
				</span>
			) : null}
		</p>
	);
}
