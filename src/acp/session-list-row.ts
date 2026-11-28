// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One saved session as ACP `session/list` describes it. The desktop app reads the same ledger without an engine and
 * projects each row through here too, so both answers bound, redact and pick the current route alike.
 */

import type { SessionMeta } from "../domains/session/contract.js";
import { safeConfiguredIdentifier, safeIso, safeStoredIdentifier, safeStoredString } from "./server-bounds.js";
import { ACP_MAX_MODEL_ID_BYTES, ACP_MAX_TARGET_ID_BYTES } from "./types.js";

export const ACP_MAX_SESSION_ID_BYTES = 128;
export const ACP_MAX_LABEL_BYTES = 256;

export type SessionListFields = {
	name?: string;
	createdAt: string;
	endedAt: string | null;
	target: string | null;
	model: string | null;
	firstMessagePreview?: string;
	messageCount?: number;
	/** The newest of last activity, end and creation. */
	updatedAt: string;
};

/** A stored id the wire can carry; a session with any other id is left out of the list. */
export function listableSessionId(id: unknown): boolean {
	return safeStoredIdentifier(id, ACP_MAX_SESSION_ID_BYTES) !== null;
}

/** Throws `AcpRequestError` when a configured route cannot be represented safely. */
export function sessionListFields(meta: SessionMeta): SessionListFields {
	const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
	const messageCount = meta.messageCount;
	return {
		...(label.length > 0 ? { name: label } : {}),
		createdAt: safeIso(meta.createdAt),
		endedAt: meta.endedAt === null ? null : safeIso(meta.endedAt),
		target: safeConfiguredIdentifier(meta.currentTarget ?? meta.target, ACP_MAX_TARGET_ID_BYTES),
		model: safeConfiguredIdentifier(meta.currentModel ?? meta.model, ACP_MAX_MODEL_ID_BYTES),
		...(meta.firstMessagePreview !== undefined
			? { firstMessagePreview: safeStoredString(meta.firstMessagePreview, ACP_MAX_LABEL_BYTES) }
			: {}),
		...(typeof messageCount === "number" && Number.isSafeInteger(messageCount) && messageCount >= 0
			? { messageCount }
			: {}),
		updatedAt: safeIso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
	};
}
