import type { ArenaChoice, ArenaMatch, ArenaVote } from "./types.ts";

/** Shared fixtures for the pack's tests. */
export const sum = (measured: number, unknownCount = 0) => ({
	measured,
	estimated: 0,
	unknownCount,
	absentCount: 0,
	coverage: { measured: unknownCount > 0 ? 0 : 1, estimated: 0, unknown: unknownCount },
});

export function match(
	id: string,
	contenders: Array<[string, string]>,
	overrides: Partial<ArenaMatch> = {},
): ArenaMatch {
	return {
		schemaVersion: 1,
		id,
		createdAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:01:00.000Z",
		status: "complete",
		prompt: "fix it",
		suite: null,
		root: "/nowhere",
		baselineSha: null,
		isolation: "read-only",
		seed: 1,
		order: contenders.map((_, index) => index),
		timeoutSeconds: 60,
		maxCostUsd: null,
		check: null,
		contenders: contenders.map(([target, model], index) => ({
			target,
			model,
			index,
			status: "done",
			facts: {
				exitCode: 0,
				timedOut: false,
				durationMs: 1000,
				sessionId: `s${index}`,
				turns: 1,
				toolCalls: 0,
				toolErrors: 0,
				writes: 0,
				blocks: 0,
				totalTokens: sum(100),
				cost: { usd: sum(0, 1), free: false },
				finalText: `answer ${index}`,
				diff: null,
				check: null,
				error: null,
			},
		})),
		error: null,
		...overrides,
	};
}

export function vote(choice: string): ArenaVote {
	return { schemaVersion: 1, matchId: "x", choice: choice as ArenaChoice, note: null, votedAt: "t", replaced: false };
}
