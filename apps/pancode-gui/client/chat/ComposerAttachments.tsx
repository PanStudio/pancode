// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import { attachmentBadge, attachmentReview } from "./attachment-review-model.js";
import { type Attachment, attachmentSize } from "./attachments-model.js";

function saveAttachment(item: Attachment): void {
	const url =
		item.kind === "file"
			? URL.createObjectURL(new Blob([item.text], { type: "text/plain;charset=utf-8" }))
			: `data:${item.mimeType};base64,${item.data}`;
	const link = document.createElement("a");
	link.href = url;
	link.download = item.name;
	link.click();
	if (item.kind === "file") setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The attachments going with the next request, each with its review, save and remove controls. */
export function AttachmentList({
	attachments,
	pending,
	onReview,
	onRemove,
}: {
	attachments: readonly Attachment[];
	pending: boolean;
	onReview: (id: string) => void;
	onRemove: (id: string) => void;
}) {
	return (
		<ul className="composer__attachments" aria-label="Attachments to send with this request">
			{attachments.map((item) => (
				<li key={item.id}>
					{item.kind === "image" ? (
						<img src={`data:${item.mimeType};base64,${item.data}`} alt="" width={28} height={28} />
					) : (
						<span className="composer__attachment-file" aria-hidden="true">
							{attachmentBadge(item.name)}
						</span>
					)}
					<span className="composer__attachment-name">
						<button
							type="button"
							className="composer__attachment-title"
							onClick={() => onReview(item.id)}
							title={`Review ${item.name}`}
							aria-haspopup="dialog"
						>
							{item.name}
						</button>
						<small>{item.kind === "image" ? `${item.width}×${item.height}` : `text, ${attachmentSize(item.bytes)}`}</small>
					</span>
					<button type="button" className="composer__attachment-action" onClick={() => saveAttachment(item)}>
						Save<span className="sr-only"> {item.name}</span>
					</button>
					<button
						type="button"
						className="composer__attachment-action composer__attachment-remove"
						disabled={pending}
						onClick={() => onRemove(item.id)}
					>
						<Icon name="close" />
						<span className="sr-only">Remove {item.name}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** A paste too large to place in the field, held for the operator to save or dismiss. */
export function PasteReview({
	pasteReview,
	onDismiss,
}: {
	pasteReview: { text: string; reason: string; bytes: number };
	onDismiss: () => void;
}) {
	return (
		<div className="composer__paste-review" role="status">
			<div className="composer__paste-head">
				<StatusMark tone="warn" label="Paste kept for review" />
				<span className="composer__paste-size">· {attachmentSize(pasteReview.bytes)}</span>
				<span className="composer__paste-actions">
					<button
						type="button"
						className="composer__attachment-action"
						onClick={() => {
							const url = URL.createObjectURL(new Blob([pasteReview.text], { type: "text/plain;charset=utf-8" }));
							const link = document.createElement("a");
							link.href = url;
							link.download = "pancode-gui-pasted-text.txt";
							link.click();
							setTimeout(() => URL.revokeObjectURL(url), 1000);
						}}
					>
						Save full paste
					</button>
					<button type="button" className="composer__attachment-action" onClick={onDismiss}>
						Dismiss paste
					</button>
				</span>
			</div>
			<p>{pasteReview.reason}</p>
			<details>
				<summary>Preview pasted text</summary>
				<pre>
					{pasteReview.text.slice(0, 4000)}
					{pasteReview.text.length > 4000 ? "\n… Preview shortened. The download contains the full paste." : ""}
				</pre>
			</details>
		</div>
	);
}

export function AttachmentReview({
	item,
	pending,
	onClose,
	onRemove,
}: {
	item: Attachment;
	pending: boolean;
	onClose: () => void;
	onRemove: () => void;
}) {
	const review = attachmentReview(item);
	return (
		<Dialog title={item.name} eyebrow="Attachment review" size="wide" className="attachment-review" onClose={onClose}>
			<p className="attachment-review__meta">{review.detail}</p>
			{item.kind === "image" ? (
				<img className="attachment-review__image" src={`data:${item.mimeType};base64,${item.data}`} alt={item.name} />
			) : (
				<textarea
					className="attachment-review__text"
					aria-label="Attachment text preview"
					readOnly
					rows={16}
					value={review.text ?? ""}
				/>
			)}
			{review.truncated && (
				<p className="attachment-review__note">
					Preview shortened to 12,000 characters. The full text is kept for sending and download.
				</p>
			)}
			<div className="attachment-review__actions">
				<button type="button" onClick={() => saveAttachment(item)}>
					<Icon name="artifacts" /> Save original
				</button>
				<button type="button" disabled={pending} onClick={onRemove}>
					Remove attachment
				</button>
				<button type="button" className="primary" onClick={onClose}>
					Keep attachment
				</button>
			</div>
		</Dialog>
	);
}
