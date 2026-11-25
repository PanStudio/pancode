// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { Id } from "../../../contracts/common.js";
import { AppProblem } from "../../services/problem.js";

/** A stable newest-first keyset shared by file-backed inventories. */
export function artifactPage<T extends { id: string; startedAt: string }>(rows: T[], limit: number, cursor?: string) {
	let before: { id: string; startedAt: string } | undefined;
	if (cursor) {
		try {
			const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!Value.Check(Id, parsed.id) ||
				typeof parsed.startedAt !== "string" ||
				!Number.isFinite(Date.parse(parsed.startedAt))
			)
				throw new Error();
			before = parsed;
		} catch {
			throw new AppProblem("validation", "Invalid artifact cursor.");
		}
	}
	const compare = (a: { id: string; startedAt: string }, b: { id: string; startedAt: string }) =>
		Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id);
	const ordered = rows.sort(compare).filter((row) => !before || compare(row, before) > 0);
	const items = ordered.slice(0, limit),
		last = items.at(-1);
	return {
		items,
		nextCursor:
			ordered.length > items.length && last
				? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url")
				: null,
	};
}
