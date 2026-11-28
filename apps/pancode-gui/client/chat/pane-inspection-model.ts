// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ArtifactList } from "../../contracts/artifacts.js";
import { matchesText } from "../design/text-match.js";
import type { BranchRow } from "./branch-model.js";

export function paneBranchRows(rows: readonly BranchRow[], query: string, kind: string): BranchRow[] {
	return rows.filter((row) => (!kind || row.kind === kind) && matchesText(query, [row.text, row.label, row.word]));
}

export function paneArtifactRows(
	rows: ArtifactList["artifacts"],
	query: string,
	category: string,
): ArtifactList["artifacts"] {
	return rows.filter(
		(row) =>
			(!category || row.category === category) && matchesText(query, [row.title, row.subtitle, row.id, row.category]),
	);
}
