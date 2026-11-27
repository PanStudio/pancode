// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { createAcpRuntimeNoticeRelay, subscribeAcpNotices } from "../../src/engine/acp/runtime-notice.js";
import { createReloadClasses } from "../../src/entry/reload-classes.js";
import { createSessionExtensionHosting } from "../../src/entry/session-extension-hosting.js";

const fragment = (id: string, body: string) => `---\nid: ${id}\nversion: 1\ndescription: Test.\n---\n${body}\n`;

test("/reload prompts reports a modified fragment by id and keeps the old table when one is broken", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pancode-reload-prompts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "identity"));
	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "One."));
	const bus = createTelemetryHub();
	let requested = 0;
	bus.subscribe("prompts.reload_requested", () => {
		requested += 1;
	});
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => root,
		hub: () => undefined,
		reloadHub: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: root,
	});
	const operators = async () => ({ status: "ok", message: "", failures: [], nextSession: [] });

	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "Two."));
	const changed = await reloads.run("prompts", operators);
	strictEqual(changed.failed, false);
	match(changed.text, /modified: 1 \(identity\.main\)/u);
	match(changed.text, /safety rule packs/u);
	strictEqual(requested, 1);

	writeFileSync(join(root, "identity", "broken.md"), "no frontmatter\n");
	const broken = await reloads.run("prompts", operators);
	strictEqual(broken.failed, true);
	ok(broken.text.includes("previous table kept"));
	match(broken.text, /broken\.md/u);
	strictEqual(requested, 1);
});

test("/reload prompts reports a failed recipe rediscovery instead of failed: none", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pancode-reload-recipes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "identity"));
	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "One."));
	const bus = createTelemetryHub();
	bus.subscribe("prompts.reload_requested", (payload) => {
		(payload as { failures?: string[] }).failures?.push("agent id collides with plugin recipe x");
	});
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => root,
		hub: () => undefined,
		reloadHub: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: root,
	});
	const result = await reloads.run("prompts", async () => ({
		status: "ok",
		message: "",
		failures: [],
		nextSession: [],
	}));
	strictEqual(result.failed, true);
	match(result.text, /Agent recipes .*collides with plugin recipe x/u);
	ok(!result.text.includes("failed: none"));
	ok(!result.text.includes("recipes: rediscovered"));
});

test("/reload hub does not claim every agent recipe reloaded", async () => {
	const bus = createTelemetryHub();
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => process.cwd(),
		hub: () => undefined,
		reloadHub: () => ({ generation: 2, packages: [] }) as never,
		extensions: () => [],
		fragmentsRoot: process.cwd(),
	});
	const report = await reloads.run("hub", async () => ({
		status: "ok",
		message: "",
		failures: [],
		nextSession: [],
	}));
	match(report.text, /agent recipes only from changed packages/u);
	ok(!/prompts, agents and playbooks reload here/u.test(report.text));
});

test("/reload settings recovers after a prior config.reload_failed event", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pancode-reload-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bus = createTelemetryHub();
	const settings = { chat: {}, safety: {} } as never;
	let shouldFail = true;
	const reloads = createReloadClasses({
		config: {
			get: () => settings,
			reload: () => {
				if (shouldFail)
					bus.emit("config.reload_failed", {
						message: "bad namespace key",
						headline: "bad namespace key",
						file: "settings.json",
						keys: ["bad"],
					});
			},
		} as never,
		bus,
		cwd: () => root,
		hub: () => undefined,
		reloadHub: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: root,
	});
	const operators = async () => ({ status: "ok", message: "", failures: [], nextSession: [] });

	const first = await reloads.run("settings", operators);
	strictEqual(first.failed, true);
	match(first.text, /bad namespace key/u);

	shouldFail = false;
	const recovered = await reloads.run("settings", operators);
	strictEqual(recovered.failed, false);
	match(recovered.text, /failed: none/u);
});

test("deferred /reload mcp reports thrown errors and drops a superseded deferred notice", async () => {
	const bus = createTelemetryHub();
	const notices: Array<{ target: string; text: string; failed: boolean }> = [];
	bus.subscribe("reload.applied", (payload) => {
		notices.push(payload);
	});
	let idle = false;
	let releaseFirst!: () => void;
	let calls = 0;
	const empty = { added: [], removed: [], changed: [], unchanged: [], needsTrust: [], diagnostics: [] };
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => process.cwd(),
		hub: () => undefined,
		reloadHub: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: process.cwd(),
		mcp: {
			idle: () => idle,
			source: () => ({
				reloadDeclarations: async () => {
					calls += 1;
					if (calls === 1) {
						await new Promise<void>((resolve) => {
							releaseFirst = resolve;
						});
						return empty;
					}
					if (calls === 2) return empty;
					throw new Error("boom");
				},
			}),
		},
	});
	const operators = async () => ({ status: "ok", message: "", failures: [], nextSession: [] });

	// Defer, wake up in flight, then supersede with an immediate reload.
	const deferred = await reloads.run("mcp", operators);
	match(deferred.text, /deferred:/u);
	idle = true;
	bus.emit("turn.settled", { stopReason: "stop", terminal: true, retries: 0, bareFinishRefusals: 0 } as never);
	await new Promise((resolve) => setImmediate(resolve));
	const immediate = await reloads.run("mcp", operators);
	strictEqual(immediate.failed, false);
	releaseFirst();
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(notices.length, 0);

	// Deferred throw reports failure notice instead of vanishing.
	idle = false;
	await reloads.run("mcp", operators);
	idle = true;
	bus.emit("turn.settled", { stopReason: "stop", terminal: true, retries: 0, bareFinishRefusals: 0 } as never);
	await new Promise((resolve) => setImmediate(resolve));
	strictEqual(notices.length, 1);
	strictEqual(notices[0]?.failed, true);
	match(notices[0]?.text ?? "", /boom/u);
});

test("session extension hosting cancels deferred reload on reload() and disposes cleanly when start resolves after dispose", async () => {
	const bus = createTelemetryHub();
	const notices: string[] = [];
	bus.subscribe("reload.applied", (payload) => {
		notices.push(payload.text);
	});
	let idle = false;
	let disposedHosts = 0;
	let releaseStart!: () => void;
	const hosting = createSessionExtensionHosting({
		bus,
		idle: () => idle,
		commit: () => ({ status: "committed", generation: 1, hooks: 0 }) as never,
		report: () => undefined,
		start: async () => {
			await new Promise<void>((resolve) => {
				releaseStart = resolve;
			});
			return {
				ready: Promise.resolve({ status: "committed", message: "ok", degraded: 0 }),
				restart: async () => ({ status: "committed", message: "ok", degraded: 0 }),
				operator: { entries: () => [] },
				dispose: async () => {
					disposedHosts += 1;
				},
			} as never;
		},
	});

	// reload() cancels a pending deferral so turn.settled does not fire a second reload.
	const step = await hosting.reloadStep();
	strictEqual(step.status, "deferred");
	hosting.reload();
	await new Promise((resolve) => setImmediate(resolve));
	idle = true;
	bus.emit("turn.settled", { stopReason: "stop", terminal: true, retries: 0, bareFinishRefusals: 0 } as never);
	const disposing = hosting.dispose();
	releaseStart();
	await disposing;
	strictEqual(disposedHosts, 1);
	strictEqual(notices.length, 0);
});

test("subscribeAcpNotices re-announces commands on deferred MCP reload and flushes session notices without dedupe", () => {
	const bus = createTelemetryHub();
	const sent: Array<{ sessionId: string; key: string; text: string }> = [];
	let announcements = 0;
	let bound: string | null = null;
	const relay = createAcpRuntimeNoticeRelay((sessionId, notice) =>
		sent.push({ sessionId, key: notice.key, text: notice.text }),
	);
	const stop = subscribeAcpNotices(
		bus,
		relay,
		() => bound,
		() => {
			announcements += 1;
		},
	);
	try {
		bus.emit("reload.applied", { target: "mcp", text: "first", failed: false });
		relay.flush("s1");
		bus.emit("reload.applied", { target: "mcp", text: "second", failed: false });
		relay.flush("s1");
		strictEqual(sent.length, 2);
		bound = "s1";
		bus.emit("reload.applied", { target: "mcp", text: "third", failed: false });
		strictEqual(announcements, 1);
	} finally {
		stop();
	}
});
