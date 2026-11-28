// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { bindPackActivitySink } from "../core/pack-activity.js";
import type { SessionContract } from "../domains/session/index.js";

export function bindSessionPackActivity(session: SessionContract): () => void {
	return bindPackActivitySink((activity) => {
		const current = session.current();
		if (!current) return false;
		const attributed = { ...activity, sessionId: activity.sessionId ?? current.id };
		session.appendEntry({
			kind: "custom",
			customType: activity.type,
			parentTurnId: activity.turnId ?? null,
			timestamp: activity.at,
			data: attributed,
			display: false,
		});
		return true;
	});
}
