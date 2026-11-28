// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's opt-in readout feeds: queue changes, the session readouts, admission and tool-body notices. */

import type { AcpReadoutsSession } from "./readouts.js";
import { createAcpReadoutsEmitter } from "./readouts.js";
import { queueEditWired } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import { projectQueueEntries } from "./server-session-input.js";
import {
	ACP_MAX_LIVE_TOOL_CALLS,
	eventRecord,
	openWireIdFor,
	sendUpdate,
	toolCallUpdateMeta,
} from "./server-tool-updates.js";
import type { AcpToolCallStatus } from "./types.js";
import { ACP_QUEUE_CHANGED_NOTIFICATION } from "./types.js";
import type { AcpAdmissionMeta } from "./types-readouts.js";
import { ACP_ADMISSION_META_KEY, ACP_READOUTS_NOTIFICATION } from "./types-readouts.js";

export function createAcpServerReadouts(scope: AcpServerScope) {
	const { options } = scope;
	// The chat loop reports every enqueue, hand-over, edit and drain, mid-turn
	// or not. A client that opted in replaces its queue rows with each list
	// instead of polling `queue` while a turn runs.
	const unsubscribeQueueEvents = queueEditWired(options)
		? options.chat.onEvent((raw) => {
				if (eventRecord(raw).type !== "queue_update") return;
				const sessionId = scope.activeSessionId ?? scope.boundSessionId;
				if (!scope.handshake.initialized || !scope.handshake.queueEventsEnabled || sessionId === null) return;
				try {
					options.transport.notify(ACP_QUEUE_CHANGED_NOTIFICATION, {
						sessionId,
						entries: projectQueueEntries(options.chat.queueEntries?.() ?? []),
					});
				} catch {
					options.diagnostics?.("failed to send a queue change notification");
				}
			})
		: () => {};
	// Readouts go to the session a queue change would name, and only to a client that opted in. The chat's
	// events still reach the emitter without one, so its rate clock stays whole.
	const readouts = createAcpReadoutsEmitter({
		now: scope.now,
		send: (params) => {
			try {
				options.transport.notify(ACP_READOUTS_NOTIFICATION, params);
			} catch {
				options.diagnostics?.("failed to send a readouts notification");
			}
		},
		...(options.autonomyPosture !== undefined ? { autonomyPosture: options.autonomyPosture } : {}),
		...(options.chat.autonomyStatus !== undefined
			? { autonomyStatus: () => options.chat.autonomyStatus?.() ?? null }
			: {}),
		...(options.chat.activeSkillSurface !== undefined
			? { activeSkillSurface: () => options.chat.activeSkillSurface?.() ?? [] }
			: {}),
	});
	const readoutsSession = (id: string | null): AcpReadoutsSession | null => {
		if (id === null || !scope.handshake.initialized || !scope.handshake.readoutsEnabled) return null;
		const session = scope.sessions.get(id);
		return session === undefined ? null : { id, autonomy: session.autonomy, holdsPrompt: scope.activeSessionId === id };
	};
	const publishReadouts = (id: string): void => {
		const session = readoutsSession(id);
		if (session !== null) readouts.publish(session);
	};
	const unsubscribeReadouts = options.chat.onEvent((raw) =>
		readouts.chatEvent(raw, readoutsSession(scope.activeSessionId ?? scope.boundSessionId)),
	);
	// The judge's hold on a call the client already drew, as a non-terminal update of that row. The terminal
	// update still arrives once, last, and these frames spend none of the call's progress budget.
	const unsubscribeAdmission =
		options.toolRegistry?.onAdmissionReview?.((event) => {
			const active = scope.activePromptState;
			if (
				!scope.handshake.initialized ||
				!scope.handshake.readoutsEnabled ||
				active === null ||
				scope.activeSessionId === null
			)
				return;
			const wireId = openWireIdFor(active, event.toolCallId);
			if (wireId === null) return;
			const admission: AcpAdmissionMeta =
				event.state === "judging"
					? { version: 1, state: "judging", display: "waiting for the safety judge" }
					: { version: 1, state: "admitted" };
			// A call the judge is reviewing still awaits approval; its allow lets the body run.
			const status: AcpToolCallStatus = event.state === "judging" ? "pending" : "in_progress";
			if (status === "in_progress") active.runningToolCalls.add(wireId);
			try {
				sendUpdate(options.transport, scope.activeSessionId, active, {
					sessionUpdate: "tool_call_update",
					toolCallId: wireId,
					status,
					_meta: { [ACP_ADMISSION_META_KEY]: admission },
				});
			} catch {
				options.diagnostics?.("failed to send an admission update");
			}
		}) ?? (() => {});
	// A call goes on the wire `pending` and turns `in_progress` once, when its body starts: after admission, the judge
	// and any approval. A body that starts before its `tool_call` is emitted makes that call announce itself running.
	const unsubscribeToolBodyStart =
		options.toolRegistry?.onToolBodyStart?.((engineId) => {
			const active = scope.activePromptState;
			if (!scope.handshake.initialized || active === null || scope.activeSessionId === null) return;
			if (active.permissionExpired || active.toolCallLimitReached) return;
			const wireId = openWireIdFor(active, engineId);
			if (wireId === null) {
				if (!active.toolCallWireIds.has(engineId) && active.earlyToolBodies.size < ACP_MAX_LIVE_TOOL_CALLS)
					active.earlyToolBodies.add(engineId);
				return;
			}
			if (active.runningToolCalls.has(wireId)) return;
			active.runningToolCalls.add(wireId);
			const snapshot = active.toolCallSnapshots.get(wireId);
			try {
				sendUpdate(
					options.transport,
					scope.activeSessionId,
					active,
					{ sessionUpdate: "tool_call_update", toolCallId: wireId, status: "in_progress" satisfies AcpToolCallStatus },
					toolCallUpdateMeta(snapshot),
				);
			} catch {
				options.diagnostics?.("failed to send a tool start update");
			}
		}) ?? (() => {});
	return {
		publishReadouts,
		readouts,
		readoutsSession,
		unsubscribeAdmission,
		unsubscribeQueueEvents,
		unsubscribeReadouts,
		unsubscribeToolBodyStart,
	};
}

export type AcpServerReadouts = ReturnType<typeof createAcpServerReadouts>;
