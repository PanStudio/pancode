// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { QueueEditRequest } from "../../contracts/steering.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { type QueuedMessage, queueActions, queueRowLabel, queueSummary } from "./composer-model.js";

/** The messages waiting on the engine, with the edits the agent announced for each and a way to take them all back. */
export function QueuedMessages({
	queued,
	running,
	queueOps,
	sendNow,
	drain,
	edit,
}: {
	queued: readonly QueuedMessage[];
	running: boolean;
	queueOps: readonly string[] | undefined;
	sendNow: boolean;
	drain: { readonly isPending: boolean; mutate(): void };
	edit: { readonly isPending: boolean; mutate(request: QueueEditRequest): void };
}) {
	return (
		<section className="composer__queue" aria-label="Messages waiting on the engine">
			<div className="composer__queue-head">
				<p className="composer__queue-summary" role="status">
					{queueSummary(queued, running)}
				</p>
				<button
					className="composer__attachment-action"
					type="button"
					disabled={drain.isPending}
					onClick={() => drain.mutate()}
					title="Take every waiting message back out of the queue and into this field."
				>
					{drain.isPending ? "Taking them back…" : "Take them back"}
				</button>
			</div>
			<ol className="composer__queue-list">
				{queued.map((message) => (
					<li key={message.id} className="composer__queue-row">
						<StatusMark tone="warn" label={queueRowLabel(message, running)} />
						<span className="composer__queue-text" title={message.text}>
							{message.text}
						</span>
						<span className="composer__queue-actions">
							{queueActions(message, queued, queueOps, sendNow).map((action) => (
								<button
									key={action.key}
									className={`composer__attachment-action${action.icon ? " composer__attachment-remove" : ""}`}
									type="button"
									disabled={edit.isPending}
									aria-label={action.icon ? `${action.label}: ${message.text.slice(0, 80)}` : undefined}
									title={action.title}
									onClick={() => edit.mutate(action.request)}
								>
									{action.icon ? <Icon name={action.icon} /> : action.label}
								</button>
							))}
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}
