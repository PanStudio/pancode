// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Runtime notices over ACP (M-32). The residency, degraded-inference, memory
 * route and quota producers publish `runtime.notice_raised` on the bus, and
 * the terminal shows each one as a keyed notice. An ACP client gets the same
 * notice as `session_info_update` with `_meta["pancode/notice"]`, the channel
 * startup and host status lines use, once per notice key per session. A notice
 * raised before a session is bound waits for that session's next prompt, the
 * way startup hints do, so the client already holds the session id.
 *
 * Session notices (a restart-bound setting, a changed git hook, a failed
 * extension or middleware hook, a foreign worker's ask, an MCP reload) cross
 * on the same channel. Each one is news, so these are not deduplicated by key;
 * a held one is replaced by a newer one with its key.
 */
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { RuntimeNoticePayload } from "../../core/telemetry/live-events.js";
import { type SessionNotice, subscribeSessionNotices } from "../../session-control/session-notices.js";

interface AcpRuntimeNotice {
	level: RuntimeNoticePayload["level"];
	text: string;
	/** The terminal's notice key: `runtime-notice:<kind>:<targetId>`. */
	key: string;
}

/** Notices held while no session is bound; distinct keys, oldest kept. */
const MAX_HELD_NOTICES = 32;

const LEVELS: ReadonlySet<string> = new Set(["info", "warning", "error"]);

function readRuntimeNotice(payload: unknown): AcpRuntimeNotice | null {
	if (payload === null || typeof payload !== "object") return null;
	const notice = payload as Partial<Record<keyof RuntimeNoticePayload, unknown>>;
	if (typeof notice.kind !== "string" || typeof notice.message !== "string" || notice.message.trim().length === 0) {
		return null;
	}
	const level = typeof notice.level === "string" && LEVELS.has(notice.level) ? notice.level : "info";
	const targetId = typeof notice.targetId === "string" ? notice.targetId : "";
	return {
		level: level as AcpRuntimeNotice["level"],
		text: notice.message,
		key: `runtime-notice:${notice.kind}:${targetId}`,
	};
}

interface AcpRuntimeNoticeRelay {
	/** One `runtime.notice_raised` payload; `sessionId` is the bound session, or null before one is bound. */
	raise(payload: unknown, sessionId: string | null): void;
	/** One session notice; `sessionId` as for `raise`. */
	session(notice: SessionNotice, sessionId: string | null): void;
	/** Sends the notices held while no session was bound. */
	flush(sessionId: string): void;
}

export function createAcpRuntimeNoticeRelay(
	send: (sessionId: string, notice: AcpRuntimeNotice) => void,
): AcpRuntimeNoticeRelay {
	const shown = new Set<string>();
	const held = new Map<string, { notice: AcpRuntimeNotice; dedupe: boolean }>();
	const deliver = (sessionId: string, notice: AcpRuntimeNotice): void => {
		const id = `${sessionId}\u0000${notice.key}`;
		if (shown.has(id)) return;
		shown.add(id);
		send(sessionId, notice);
	};
	return {
		raise(payload, sessionId) {
			const notice = readRuntimeNotice(payload);
			if (notice === null) return;
			if (sessionId !== null) deliver(sessionId, notice);
			else if (!held.has(notice.key) && held.size < MAX_HELD_NOTICES) held.set(notice.key, { notice, dedupe: true });
		},
		session(notice, sessionId) {
			const relayed: AcpRuntimeNotice = {
				level: notice.level === "warn" ? "warning" : notice.level,
				text: notice.text,
				key: notice.key,
			};
			if (sessionId !== null) send(sessionId, relayed);
			else if (held.has(relayed.key) || held.size < MAX_HELD_NOTICES)
				held.set(relayed.key, { notice: relayed, dedupe: false });
		},
		flush(sessionId) {
			const pending = [...held.values()];
			held.clear();
			for (const entry of pending) {
				if (entry.dedupe) deliver(sessionId, entry.notice);
				else send(sessionId, entry.notice);
			}
		},
	};
}

/** Subscribes the relay to runtime and session notices; `boundSession` reads the session a notice goes to now. */
export function subscribeAcpNotices(
	bus: Pick<TelemetryHub, "subscribe">,
	relay: AcpRuntimeNoticeRelay,
	boundSession: () => string | null,
	/** After a `/reload` from any caller, and after a deferred reload applies, the bound session hears the commands it may type now. */
	announceCommands?: (sessionId: string) => void,
): () => void {
	const announce = (): void => {
		const sessionId = boundSession();
		if (sessionId !== null) announceCommands?.(sessionId);
	};
	const unsubscribers = [
		bus.subscribe("runtime.notice_raised", (payload) => relay.raise(payload, boundSession())),
		subscribeSessionNotices(bus, (notice) => relay.session(notice, boundSession())),
		bus.subscribe("session.reloaded", announce),
		// A deferred extensions or MCP reload can change extension commands or MCP prompts after the report went out.
		bus.subscribe("reload.applied", announce),
	];
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}
