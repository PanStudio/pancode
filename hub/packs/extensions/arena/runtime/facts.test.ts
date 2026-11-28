import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { blindOrder } from "./blind.ts";
import { contenderWrites, readArenaStream } from "./facts.ts";
import { computeStandings } from "./standings.ts";
import { match, sum, vote } from "./test-fixtures.ts";

function frames(...values: unknown[]): string {
	return values.map((value) => JSON.stringify(value)).join("\n");
}

describe("arena stream facts", () => {
	it("counts writes, blocks and errors and keeps unpriced cost unmeasured", () => {
		const facts = readArenaStream(
			frames(
				{ type: "session", id: "sess1" },
				{ type: "tool_execution_end", actionClass: "write", outcome: "ok", isError: false },
				{ type: "tool_execution_end", actionClass: "write", outcome: "blocked", decision: "blocked", isError: true },
				{ type: "tool_execution_end", actionClass: "read", outcome: "error", isError: true },
				{ type: "tool_execution_end", actionClass: "read", outcome: "ok", decision: "denied" },
				{ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall" }] } },
				{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done here" }] } },
				{ type: "agent_end", usage: { totalTokens: sum(10), cost: { usd: sum(0, 2), free: false } } },
				{ type: "agent_end", usage: { totalTokens: sum(5), cost: { usd: sum(0, 1), free: false } } },
				"not json",
			),
		);
		assert.equal(facts.sessionId, "sess1");
		assert.deepEqual([facts.toolCalls, facts.writes, facts.blocks, facts.toolErrors, facts.turns], [4, 1, 2, 1, 2]);
		assert.equal(facts.finalText, "done here");
		assert.equal(facts.totalTokens?.measured, 15);
		assert.equal(facts.cost?.usd.unknownCount, 3);
		assert.equal(facts.cost?.usd.measured, 0);
	});

	it("counts a gateway chain as its steps, not its steps and the wrapper frame", () => {
		const facts = readArenaStream(
			frames(
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "gateway", outcome: "error", isError: true },
				{ type: "tool_execution_end", toolCallId: "c1:w", parentToolCallId: "c1", actionClass: "write", outcome: "ok" },
				{ type: "tool_execution_end", toolCallId: "c1:r", parentToolCallId: "c1", outcome: "error", isError: true },
				{ type: "tool_execution_end", toolCallId: "g2", toolName: "gateway", outcome: "ok" },
			),
		);
		assert.deepEqual([facts.toolCalls, facts.writes, facts.toolErrors], [3, 1, 1]);
	});

	it("counts a file an extension tool wrote, which the stream reports as execute", () => {
		const facts = readArenaStream(
			frames({ type: "tool_execution_end", toolName: "extension_desk__record", actionClass: "execute", outcome: "ok" }),
		);
		assert.equal(facts.writes, 0);
		assert.equal(contenderWrites(facts.writes, { files: 1, insertions: 25, deletions: 0 }), 1);
		assert.equal(contenderWrites(3, { files: 1, insertions: 2, deletions: 0 }), 3, "edits to one file keep their count");
		assert.equal(contenderWrites(0, null), 0, "a read-only contender has no diff");
	});
});

describe("arena blind order", () => {
	it("is a seeded permutation", () => {
		assert.deepEqual(blindOrder(4, 7), blindOrder(4, 7));
		assert.deepEqual([...blindOrder(4, 7)].sort(), [0, 1, 2, 3]);
		const seen = new Set<string>();
		for (let seed = 0; seed < 50; seed++) seen.add(blindOrder(3, seed).join(""));
		assert.ok(seen.size > 3, "different seeds give different orders");
	});
});

describe("arena standings", () => {
	const duel = (n: number, choice: string) => ({
		match: match(`20260101-00000${n}-0000`, [
			["x", "strong"],
			["y", "weak"],
		]),
		vote: vote(choice),
	});

	it("tallies wins, ties and both-bad, and scores only past the vote floor", () => {
		const entries = [
			...[0, 1, 2, 3].map((n) => duel(n, "A")),
			duel(4, "tie"),
			duel(5, "both-bad"),
			{ match: duel(6, "A").match, vote: null },
			{
				match: match("20260101-000007-0000", [
					["x", "strong"],
					["x", "strong"],
				]),
				vote: vote("A"),
			},
		];
		const result = computeStandings(entries);
		assert.equal(result.matches, 8);
		assert.equal(result.votedMatches, 6);
		const [first, second] = result.standings;
		assert.equal(first?.identity, "x/strong");
		assert.deepEqual([first?.wins, first?.losses, first?.ties, first?.bad, first?.votes], [4, 0, 1, 1, 6]);
		assert.deepEqual([second?.wins, second?.losses], [0, 4]);
		assert.ok((first?.score ?? 0) > 1000 && (second?.score ?? 2000) < 1000);
		assert.ok(computeStandings(entries.slice(0, 2)).standings.every((s) => s.score === null));
		assert.equal(computeStandings(entries, "other").standings.length, 0);
	});

	it("rates by Elo, replayed in match order whatever order the records arrive in", () => {
		// x wins five, then y wins the sixth: 1067/933 after the streak, 1045/955 after the upset.
		const entries = [duel(0, "A"), duel(1, "A"), duel(2, "A"), duel(3, "A"), duel(4, "A"), duel(5, "B")];
		for (const order of [entries, [...entries].reverse()]) {
			const scores = Object.fromEntries(computeStandings(order).standings.map((s) => [s.identity, s.score]));
			assert.deepEqual(scores, { "x/strong": 1045, "y/weak": 955 });
		}
	});

	it("does not count a vote whose label names no contender", () => {
		const result = computeStandings([duel(0, "A"), ...[1, 2, 3, 4].map((n) => duel(n, "D"))]);
		assert.equal(result.votedMatches, 1);
		assert.ok(result.standings.every((s) => s.votes === 1 && s.score === null));
	});

	it("splits K across a many-way match and leaves ratings alone on both-bad", () => {
		const four = (n: number, choice: string) => ({
			match: match(`20260101-00000${n}-0000`, [
				["x", "a"],
				["x", "b"],
				["x", "c"],
				["x", "d"],
			]),
			vote: vote(choice),
		});
		const won = computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "A"))).standings;
		assert.equal(won[0]?.identity, "x/a");
		assert.deepEqual(
			won.map((s) => s.score),
			[1071, 976, 976, 976],
		);
		assert.ok(computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "both-bad"))).standings.every((s) => s.score === 1000));
		assert.ok(computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "tie"))).standings.every((s) => s.score === 1000));
	});
});
