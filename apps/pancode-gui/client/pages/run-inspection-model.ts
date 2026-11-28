// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { matchesText } from "../design/text-match.js";

/** Only page-owned filters travel to the list; launch credentials never do. */
export function listDestination(path: string, search: URLSearchParams, keys: readonly string[]): string {
	const next = new URLSearchParams();
	for (const key of keys) {
		const value = search.get(key);
		if (value) next.set(key, value);
	}
	return `${path}${next.size ? `?${next}` : ""}`;
}

export function evidenceDestination(runId: string): string {
	return `/evidence?${new URLSearchParams({ run: runId })}`;
}

export type InspectionSort = "newest" | "oldest" | "name";
export function inspectionSort(value: string | null): InspectionSort {
	return value === "oldest" || value === "name" ? value : "newest";
}

/** Sorting changes only the retained window; it never implies a search of unloaded artifacts. */
export function sortInspectionRecords<T>(
	rows: readonly T[],
	sort: InspectionSort,
	identity: (row: T) => { name: string; date: string; id: string },
): T[] {
	return [...rows].sort((a, b) => {
		const av = identity(a),
			bv = identity(b);
		const at = Date.parse(av.date),
			bt = Date.parse(bv.date);
		if (sort !== "name" && Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
		const time = Number.isFinite(at) && Number.isFinite(bt) ? at - bt : 0;
		return (
			(sort === "name" ? av.name.localeCompare(bv.name) : sort === "oldest" ? time : -time) || av.id.localeCompare(bv.id)
		);
	});
}

export function evidenceVerdictTone(verdict: string) {
	return verdict === "compromised"
		? "fail"
		: verdict === "reviewed" || verdict === "grounded"
			? "success"
			: "unverified";
}

/** An empty status filter admits every run; "active" admits runs that have not ended, any other value ended runs. */
export function matchesRunStatus(status: string, endedAt: string | null | undefined): boolean {
	return !status || (status === "active" ? !endedAt : !!endedAt);
}

type EvidenceRow = {
	verdict: string;
	run: { runId: string; agentId?: string | null; wireModelId?: string | null; tags: readonly string[] };
};
export function matchesEvidence(item: EvidenceRow, verdict: string, query: string): boolean {
	return (
		(!verdict || item.verdict === verdict) &&
		matchesText(query, [item.run.runId, item.run.agentId ?? "", item.run.wireModelId ?? "", ...item.run.tags])
	);
}

export function evidenceVerdictTally(items: readonly { verdict: string }[]): {
	supported: number;
	compromised: number;
} {
	return {
		supported: items.filter((item) => item.verdict === "reviewed" || item.verdict === "grounded").length,
		compromised: items.filter((item) => item.verdict === "compromised").length,
	};
}
