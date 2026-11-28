// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { IdleExit } from "../server/services/idle-exit.js";
import { harness } from "./harness/app.js";
import { serverProcess } from "./harness/server.js";

// No test here caps its own duration: a spawned server's boot and its boot-time settings read grow with host load, and
// the read holds idle exit as owned work should. Each test awaits the server's own exit instead.
test("two live clients hold the server; last disconnect exits after 2000 ms and logs no token", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pancode-web-idle-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const log = join(dir, "web.log");
	const s = await serverProcess(t, ["--idle-exit", "2000", "--log-file", log]);
	const disconnect = await s.connect(),
		second = await s.connect();
	assert.equal((await s.json("/api/meta")).status, 200);
	disconnect();
	await setTimeout(2300);
	assert.equal(s.child.exitCode, null);
	const started = performance.now();
	second();
	assert.equal(await s.exited, 0);
	const elapsed = performance.now() - started;
	// Only the floor is behavior: the server must not exit before its idle window. How late a loaded runner lets it exit is not.
	assert.ok(elapsed >= 1900, `Idle exit took ${elapsed} ms`);
	const text = await readFile(log, "utf8");
	assert.match(text, /Listening/);
	assert.match(text, /Stopped/);
	assert.ok(!/#(?:ticket|token)=/.test(text));
	assert.equal((await stat(log)).mode & 0o777, 0o600);
});

test("a disconnected live ACP turn holds exit; cancellation settles the turn and reaps the idle child", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pancode-web-idle-turn-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const s = await serverProcess(t, ["--idle-exit", "2000"], {
		PANCODE_WEB_CLI: fileURLToPath(new URL("./fixtures/acp-fixture-child.mjs", import.meta.url)),
		PANCODE_WEB_FIXTURE_SCENARIO: "slow",
	});
	const disconnect = await s.connect();
	const workspace = await s.json("/api/workspaces", { path: dir });
	assert.equal(workspace.status, 200);
	const session = await s.json(`/api/workspaces/${workspace.value.id}/sessions`, {});
	assert.equal(session.status, 200);
	const turn = await s.json(`/api/sessions/${session.value.id}/turns`, { text: "Hold until cancelled" });
	assert.equal(turn.status, 202);
	disconnect();
	await setTimeout(2500);
	assert.equal(s.child.exitCode, null);
	assert.equal((await s.json(`/api/sessions/${session.value.id}/turns/${turn.value.turnId}/cancel`, {})).status, 200);
	const started = performance.now();
	assert.equal(await s.exited, 0);
	assert.ok(performance.now() - started >= 1900);
});

test("an operation retains idle lifetime after its HTTP request, then releases it", async (t) => {
	const h = await harness({ installDelayMs: 900 });
	t.after(h.close);
	let exits = 0;
	let liveAtExit = -1;
	let resolve = () => {};
	const exited = new Promise<void>((settle) => {
		resolve = settle;
	});
	const idle = new IdleExit(
		200,
		() => !!(h.operations.activeCount || h.ops.pendingCount),
		() => {
			exits++;
			liveAtExit = h.operations.activeCount;
			resolve();
		},
	);
	t.after(() => idle.stop());
	const release = idle.hold();
	assert.equal((await h.post("/api/programs/herdr/install")).status, 202);
	release();
	// The 200 ms window lapses well inside the 900 ms install; exit must still wait for the operation to settle.
	await exited;
	assert.equal(liveAtExit, 0, "idle exit fired while the install operation was still live");
	assert.equal(exits, 1);
});
