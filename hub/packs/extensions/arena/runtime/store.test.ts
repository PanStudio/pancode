import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArenaVoteError, listMatches, readVote, recordVote, writeMatch } from "./store.ts";
import { match, vote } from "./test-fixtures.ts";
import type { ArenaMatch } from "./types.ts";
import { ArenaRevealRefused, arenaMatchView, fitArenaView } from "./view.ts";

const scratch = (): string => join(mkdtempSync(join(tmpdir(), "arena-")), "arena");
const pair: Array<[string, string]> = [
	["t1", "m1"],
	["t2", "m2"],
];

describe("arena votes and reveal", () => {
	it("hides identity until a vote, refuses early reveal, and journals replacements", async () => {
		const root = scratch();
		const id = "20260101-000000-abcd";
		writeMatch(root, match(id, pair, { order: [1, 0] }));
		const blind = arenaMatchView(root, match(id, pair, { order: [1, 0] }), null);
		assert.equal(blind.revealed, false);
		assert.ok(blind.entries.every((entry) => entry.reveal === null));
		assert.equal(blind.entries[0]?.finalText, "answer 1");
		assert.doesNotMatch(JSON.stringify(blind), /t1|m2|"tokens"|"cost"|durationMs/);
		assert.throws(() => arenaMatchView(root, match(id, pair), null, { reveal: true }), ArenaRevealRefused);

		await assert.rejects(recordVote(root, id, { choice: "C", note: null, replace: false }), ArenaVoteError);
		await recordVote(root, id, { choice: "A", note: "cleaner", replace: false });
		await assert.rejects(recordVote(root, id, { choice: "B", note: null, replace: false }), /--replace/);
		const replaced = await recordVote(root, id, { choice: "B", note: null, replace: true });
		assert.equal(replaced.replaced, true);
		assert.equal(readVote(root, id)?.choice, "B");
		assert.equal(readFileSync(join(root, "votes.jsonl"), "utf8").trim().split("\n").length, 2);

		const listed = listMatches(root);
		const shown = arenaMatchView(root, listed[0]?.match as ArenaMatch, listed[0]?.vote ?? null, { reveal: true });
		assert.equal(shown.entries[0]?.reveal?.target, "t2");
		assert.equal(shown.entries[0]?.reveal?.cost, "not measured");
	});

	it("refuses a vote on a match that has not completed", async () => {
		const root = scratch();
		const id = "20260101-000000-0001";
		writeMatch(root, match(id, pair, { status: "running" }));
		await assert.rejects(recordVote(root, id, { choice: "A", note: null, replace: false }), /running/);
	});

	it("redacts contender identities, sessions and worktrees before a vote and keeps them raw after", () => {
		const root = scratch();
		const id = "20260101-000000-feed";
		const raw =
			"target t2 not found in settings.targets; model gpt-6-luna. session sess-abc at /r/.pancode/worktrees/ext-arena/t-0123456789abcdef (contender 2)";
		const failed = match(
			id,
			[
				["t1", "m1"],
				["t2", "gpt-6-luna"],
			],
			{ order: [1, 0], error: "contender 2 failed: target t2 not found" },
		);
		const second = failed.contenders[1];
		const answer =
			"Fixed /repo/.pancode/worktrees/ext-arena/t-0123456789abcdef/src/foo.ts; log in /state/sessions/sess-abc.json, model gpt-6-luna";
		if (second?.facts) {
			second.facts.sessionId = "sess-abc";
			second.facts.error = raw;
			second.facts.check = { id: "unit", exitCode: 1, tail: `fail in ${raw}` };
			second.facts.finalText = answer;
		}
		writeMatch(root, failed);
		mkdirSync(join(root, id), { recursive: true });
		writeFileSync(join(root, id, "contender-2.diff"), "+// tuned for gpt-6-luna via t2/gpt-6-luna\n");
		const blind = arenaMatchView(root, failed, null);
		assert.equal(
			blind.entries[0]?.finalText,
			"Fixed [worktree]/src/foo.ts; log in /state/sessions/[hidden].json, model [hidden]",
		);
		assert.equal(blind.entries[0]?.diff, "+// tuned for [hidden] via [hidden]\n");
		const text = JSON.stringify([
			blind.error,
			...blind.entries.map((entry) => [entry.error, entry.check, entry.finalText, entry.diff]),
		]);
		assert.doesNotMatch(text, /\bt2\b|gpt-6-luna|sess-abc|0123456789abcdef|contender 2/);
		const shown = arenaMatchView(root, failed, vote("A"), { reveal: true });
		assert.equal(shown.entries[0]?.error, raw);
		assert.equal(shown.entries[0]?.finalText, answer);
		assert.equal(shown.error, "contender 2 failed: target t2 not found");
	});
});

describe("arena vote lock", () => {
	it("lets exactly one of several concurrent processes land a first vote", async () => {
		const root = scratch();
		const base = join(root, "..");
		const id = "20260101-000000-1111";
		writeMatch(root, match(id, pair));
		const go = join(base, "go");
		const script = join(base, "voter.mjs");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
const { recordVote } = await import(${JSON.stringify(join(import.meta.dirname, "store.ts"))});
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
try { await recordVote(${JSON.stringify(root)}, ${JSON.stringify(id)}, { choice: process.argv[2], note: null, replace: false }); console.log("ok"); }
catch (error) { console.log("refused " + error.message); }
`,
		);
		const voters = ["A", "B", "tie", "A", "B", "both-bad"].map(
			(choice) =>
				new Promise<string>((done, fail) => {
					const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, choice], {
						stdio: ["ignore", "pipe", "inherit"],
					});
					let out = "";
					child.stdout.on("data", (chunk) => {
						out += chunk;
					});
					child.on("error", fail);
					child.on("close", () => done(out.trim()));
				}),
		);
		await new Promise((r) => setTimeout(r, 1500));
		writeFileSync(go, "");
		const outcomes = await Promise.all(voters);
		assert.equal(outcomes.filter((line) => line === "ok").length, 1, outcomes.join("\n"));
		assert.ok(
			outcomes.every((line) => line === "ok" || /already has a vote/.test(line)),
			outcomes.join("\n"),
		);
		assert.equal(readFileSync(join(root, "votes.jsonl"), "utf8").trim().split("\n").length, 1);
	});
});

describe("arena answer budget", () => {
	it("cuts the longest diff first, then the longest final text, until the answer fits", () => {
		const root = scratch();
		const id = "20260101-000000-b0d9";
		const m = match(id, pair);
		const first = m.contenders[0];
		if (first?.facts) first.facts.finalText = "f".repeat(20_000);
		writeMatch(root, m);
		writeFileSync(join(root, id, "contender-1.diff"), "d".repeat(30_000));
		writeFileSync(join(root, id, "contender-2.diff"), "e".repeat(5_000));
		const render = (view: ReturnType<typeof arenaMatchView>): string => JSON.stringify(view);
		const view = arenaMatchView(root, m, null);
		const fitted = fitArenaView(view, render, 40_000);
		assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 40_000);
		assert.equal(view.entries[0]?.diffTruncated, true);
		assert.equal(view.entries[1]?.diffTruncated, false, "the shorter diff is left whole");
		assert.equal(view.entries[0]?.finalText.length, 20_000, "final text is cut only once the diffs are gone");

		const tight = arenaMatchView(root, m, null);
		fitArenaView(tight, render, 8_000);
		assert.deepEqual(
			tight.entries.map((entry) => entry.diff),
			["", ""],
		);
		assert.match(tight.entries[0]?.finalText ?? "", /\[final text cut to fit the answer;/);
	});
});
