// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Session format admission, checked before every resume.
 *
 * This build reads exactly one format. A session from a newer PanCode is
 * refused because this build would silently drop whatever that build
 * understood, and resuming would write the truncated reading back over the
 * original. Any other version is not a session this build wrote.
 */

import { CURRENT_SESSION_FORMAT_VERSION } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";

export { CURRENT_SESSION_FORMAT_VERSION };

export function checkSessionFormatVersion(meta: SessionMeta, sessionPath: string): void {
	// meta.json is read without a schema, so the field can be missing or of any type.
	const version: unknown = meta.sessionFormatVersion;
	if (version === CURRENT_SESSION_FORMAT_VERSION) return;
	if (typeof version === "number" && version > CURRENT_SESSION_FORMAT_VERSION) {
		throw new Error(
			`session was written by a newer PanCode (format version ${version}, this build reads version ${CURRENT_SESSION_FORMAT_VERSION}): ${sessionPath}. Upgrade PanCode to resume this session.`,
		);
	}
	throw new Error(
		`session metadata has an unsupported format version (expected ${CURRENT_SESSION_FORMAT_VERSION}, got ${version === undefined ? "none" : JSON.stringify(version)}): ${sessionPath}. Remove the session directory to start a new session.`,
	);
}
