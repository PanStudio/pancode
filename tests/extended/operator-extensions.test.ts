// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import fs, { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mock, type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { View } from "@pancode/sdk/extension";
import type { ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { capabilityEnvelope } from "@pancode/sdk/pack";
import type { PackageActivity } from "../../src/core/package-activity.js";
import {
	bindPackageActivitySink,
	flushPackageActivities,
	recordPackageActivity,
} from "../../src/core/package-activity.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import type { SandboxAvailability } from "../../src/core/sandbox/types.js";
import type { DynamicToolName } from "../../src/core/tool-names.js";
import { loadManifestFromRoot, parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { extensionDockPaths } from "../../src/domains/extensions/dock-frame.js";
import { envelopeLines } from "../../src/domains/extensions/envelope-review.js";
import {
	extensionInvocation,
	promptRefs,
	resolveExtensionCommands,
} from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { pinnedContextFile } from "../../src/domains/extensions/pinned-context.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { readOnlyRuntimeDeclaration } from "../../src/domains/extensions/runtime-sandbox.js";
import {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import type { ExtensionSurfaceEvent } from "../../src/domains/extensions/surface-model.js";
import { isLoadableExtension } from "../../src/domains/extensions/types.js";
import { disablePlugin, enablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/state.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import { createAmbientSurfaces } from "../../src/interactive/surfaces/ambient.js";
import { renderView } from "../../src/interactive/surfaces/view-renderer.js";
import type { SlashCommandContext } from "../../src/session-control/slash-command-types.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { dispatchSlashCommand } from "../../src/session-control/slash-dispatch.js";
import { buildExtensionRuntimeToolSpecs } from "../../src/tools/extension-runtime-tools.js";
import { registerHarnessExtensionTools } from "../../src/tools/harness-extensions.js";
import { createRegistry } from "../../src/tools/registry.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

const declaration = {
	api: 2,
	entrypoint: "extension.mjs",
	commands: [{ name: "inspect", description: "Inspect synthetic measurements", timeoutMs: 1000 }],
	events: [],
	ui: ["status", "panel"],
};

test("runtime activity retains admitted extension identity", async (t) => {
	const env = await isolatePancodeEnv("pancode-runtime-identity-");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	const source = path.join(env.dir, "source");
	mkdirSync(source);
	writeFileSync(
		path.join(source, "pancode-extension.json"),
		JSON.stringify({
			id: "decision-log",
			name: "Decision log",
			version: "1.0.0",
			description: "Synthetic runtime tool fixture",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				tools: [
					{
						name: "record_decision",
						description: "Record a decision and its rationale.",
						actionClass: "execute",
						inputSchema: {
							type: "object",
							additionalProperties: false,
							required: ["decision", "rationale"],
							properties: { decision: { type: "string" }, rationale: { type: "string" } },
						},
					},
				],
				permissions: { fs: { read: [], write: [] }, exec: false, net: false },
			},
		}),
	);
	writeFileSync(
		path.join(source, "extension.mjs"),
		'export default (api) => { api.tool("record_decision", () => ({ text: "no decision log", isError: true })); };\n',
	);
	const installed = installExtension(source, { cwd, scope: "user" });
	ok(installed.extension?.loadable, JSON.stringify(installed.diagnostics));
	const entry = installed.extension;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: "identity-session", mode: "interactive" }),
		isIdle: () => true,
	});
	const activity: PackageActivity[] = [];
	let sessionReady = false;
	const unbind = bindPackageActivitySink((row) => {
		if (!sessionReady) return false;
		activity.push(row);
		return true;
	});
	t.after(async () => {
		await runtime.dispose();
		unbind();
		env.restore();
	});
	equal((await runtime.reload("startup")).status, "committed");
	equal(activity.length, 0, "startup waits for a session");
	sessionReady = true;
	flushPackageActivities();
	ok(activity.some((row) => row.kind === "runtime_start" && row.owner.id === entry.id));
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({ hook: (...args) => runtime.hook(...args), tool: (...args) => runtime.tool(...args), notify: () => {} });
	const spec = buildExtensionRuntimeToolSpecs([entry], bridge).find((tool) => tool.name.endsWith("__record_decision"));
	ok(spec);
	const result = await spec.run({ decision: "Retain identity", rationale: "Telemetry probe" });
	equal(result.kind, "error", "the fixture has no decision log");
	deepStrictEqual(result.details?.owner, spec.sourceInfo?.owner);
	equal(spec.sourceInfo?.owner?.version, entry.version);
	equal(spec.sourceInfo?.owner?.digest, entry.provenance?.contentDigest);
	disableExtension(entry.id, { cwd, scope: "user" });
	await runtime.reload();
	const retired = activity.find((row) => row.kind === "runtime_retire" && row.owner.id === entry.id);
	ok(retired);
	deepStrictEqual(retired.owner, spec.sourceInfo?.owner);
});
test("bounded package activity carries dropped counts until delivery is acknowledged", (t) => {
	const owner = { kind: "extension", id: "capture-probe", version: "1.0.0", digest: "capture-probe" };
	const captured: PackageActivity[] = [];
	let ready = false;
	let failing = false;
	let unbind = bindPackageActivitySink((row) => {
		if (!ready) return false;
		if (failing) throw new Error("sink unavailable");
		captured.push(row);
		return true;
	});
	t.after(() => unbind());
	for (let index = 0; index < 250; index += 1) recordPackageActivity({ owner, kind: "startup", details: { index } });
	equal(captured.length, 0);
	ready = true;
	failing = true;
	flushPackageActivities();
	equal(captured.length, 0);
	failing = false;
	flushPackageActivities();
	equal(captured.length, 200);
	equal(captured[0]?.details?.index, 50);
	equal(captured[0]?.captureDroppedBefore, 50);
	equal(
		captured.slice(1).some((row) => row.captureDroppedBefore !== undefined),
		false,
	);
	flushPackageActivities();
	equal(captured.length, 200);
	ready = false;
	for (let index = 0; index < 3; index += 1) recordPackageActivity({ owner, kind: "unacknowledged" });
	unbind();
	unbind = bindPackageActivitySink((row) => {
		captured.push(row);
		return true;
	});
	recordPackageActivity({ owner, kind: "after-rebind" });
	equal(captured.length, 201);
	equal(captured.at(-1)?.captureDroppedBefore, 3);
});

const normal =
	'export default api => { let n=0; api.handle("inspect", (args,ctx) => ({text:JSON.stringify({args,n:++n,snapshot:ctx.snapshot,secret:process.env.PANCODE_TEST_SECRET??null}),status:{text:"SYNTHETIC fixture ready"}})); };';
/** Install into the project and approve it as `config trust extensions` would, returning the entry as it now lists. */
function installProject(source: string, cwd: string, options: { force?: boolean } = {}) {
	const result = installExtension(source, { cwd, scope: "project", ...options });
	trustProjectPackages(cwd, "extensions");
	const id = result.extension?.id;
	const extension = id
		? listInstalledExtensions(cwd, { scope: "project", all: true }).find((entry) => entry.id === id)
		: undefined;
	return { ...result, extension };
}
async function fixture(t: TestContext, script = normal, overrides: Record<string, unknown> = {}) {
	const env = await isolatePancodeEnv("pancode-operator-test-");
	const source = path.join(env.dir, "source");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(cwd);
	const manifest = {
		id: "lab_status.v1",
		name: "Lab status",
		version: "1.0.0",
		description: "Synthetic local fixture",
		// A runtime that only answers commands starts on first use, so a fixture without its own events
		// starts through a wrapper that subscribes to session_open and so runs from reload as before.
		runtime: {
			...declaration,
			...(overrides.events === undefined && overrides.api === undefined
				? { entrypoint: "eager.mjs", events: ["session_open"] }
				: {}),
			...overrides,
		},
	};
	writeFileSync(path.join(source, "pancode-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(source, "extension.mjs"), script);
	writeFileSync(
		path.join(source, "eager.mjs"),
		'import * as extension from "./extension.mjs";\nexport default (api) => { api.on("session_open", () => ({})); return extension.default(api); };\n',
	);
	const result = installProject(source, cwd);
	ok(result.extension && isLoadableExtension(result.extension), JSON.stringify(result.diagnostics));
	const extension = result.extension;
	let sessionId = "pancode-session-one";
	let idle = true;
	const reports: string[] = [];
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId, mode: "interactive" }),
		isIdle: () => idle,
		onReload: (result) => reports.push(result.message),
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	return {
		env,
		source,
		cwd,
		extension,
		runtime,
		manifest,
		reports,
		setSession: (next: string) => {
			sessionId = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
	};
}

test("runtime manifest validates declarations and contained entrypoints without running startup code", async (t) => {
	const f = await fixture(t, 'throw new Error("discovery executed code")');
	ok(loadManifestFromRoot(f.source).valid);
	for (const bad of [
		{ api: 3 },
		{ surprise: true },
		{ entrypoint: "extension.cjs" },
		{ commands: [{ name: "inspect", description: "x", timeoutMs: 0 }] },
		{ events: ["before_tool"] },
		{ ui: ["editor"] },
	]) {
		const parsed = parseExtensionManifest(
			{ ...f.manifest, runtime: { ...declaration, ...bad } },
			"pancode-extension.json",
		);
		equal(parsed.manifest, undefined, JSON.stringify(bad));
	}
	writeFileSync(
		path.join(f.source, "pancode-extension.json"),
		JSON.stringify({ ...f.manifest, runtime: { ...declaration, entrypoint: "../outside.mjs" } }),
	);
	equal(loadManifestFromRoot(f.source).valid, false);
});

test("a runtime sees a filtered environment and keeps instance state between commands", async (t) => {
	const f = await fixture(t);
	process.env.PANCODE_TEST_SECRET = "synthetic-private-value";
	t.after(() => {
		delete process.env.PANCODE_TEST_SECRET;
	});
	await f.runtime.reload();
	const inspect = async (args: string) =>
		JSON.parse((await f.runtime.invoke("ext:lab_status.v1:inspect", args)).text ?? "null");
	const first = await inspect("hello");
	equal(first.secret, null);
	equal(first.n, 1);
	equal(first.args, "hello");
	equal((await inspect("again")).n, 2);
});

test("commands and UI carry runtime generation; relative helpers change only after reviewed reinstall and reload", async (t) => {
	const script =
		'import {label} from "./helper.mjs"; export default api=>api.handle("inspect",()=>({text:label,status:{text:label}}));';
	const f = await fixture(t, script);
	writeFileSync(path.join(f.source, "helper.mjs"), 'export const label="synthetic-first";');
	ok(installProject(f.source, f.cwd, { force: true }).extension?.loadable);
	equal((await f.runtime.reload("startup")).status, "committed");
	const command = "ext:lab_status.v1:inspect";
	equal((await f.runtime.invoke(command, "")).text, "synthetic-first");
	writeFileSync(path.join(f.source, "helper.mjs"), 'export const label="synthetic-second";');
	ok(installProject(f.source, f.cwd, { force: true }).extension?.loadable);
	await rejects(f.runtime.invoke(command, ""), /reload|revoked/);
	equal(f.runtime.entries()[0]?.status, undefined);
	await f.runtime.reload();
	equal((await f.runtime.invoke(command, "")).text, "synthetic-second");
	equal(f.runtime.v2.activeGeneration, 2);
	const installed = installProject(f.source, f.cwd, { force: true }).extension;
	ok(installed?.provenance);
	deepStrictEqual(f.runtime.entries()[0]?.provenance, installed.provenance);
	ok(f.runtime.entries()[0]?.provenance?.contentDigest !== f.extension.provenance.contentDigest);
});

test("disabled project suppresses user runtime and removal reveals user copy", async (t) => {
	const f = await fixture(t);
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user" }).extension?.valid);
	await f.runtime.reload();
	equal(f.runtime.commands()[0]?.scope, "project");
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	f.runtime.v2.reconcile();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /not enabled|revoked|disabled/);
	await f.runtime.reload();
	equal(
		f.runtime.commands().some((row) => row.available),
		false,
	);
	enableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	await f.runtime.reload();
	ok(f.runtime.commands()[0]?.available);
	removeExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	await f.runtime.reload();
	equal(f.runtime.commands()[0]?.scope, "user");
	ok(f.runtime.commands()[0]?.available);
});

test("idle reload is deferred and revalidated instead of interrupting active work", async (t) => {
	const f = await fixture(t);
	f.setIdle(false);
	equal((await f.runtime.reload()).status, "deferred");
	equal(f.runtime.v2.activeGeneration, 0);
	f.setIdle(true);
	f.runtime.maintenance();
	for (let i = 0; i < 100 && !f.runtime.commands()[0]?.available; i++) await delay(20);
	ok(f.runtime.commands()[0]?.available);
});

test("startup reload keeps the boot hook generation; a later reload commits a new one (C-34)", async (t) => {
	const f = await fixture(t);
	let commits = 0;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: "pancode-session-one", mode: "interactive" }),
		isIdle: () => true,
		commitHooks: () => ({ status: "committed", generation: ++commits }),
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	equal(commits, 0, "boot already published the hook generation, so startup publishes no second one");
	equal((await runtime.reload()).status, "committed");
	equal(commits, 1);
});

test("a session host's startup prunes per-session extension state only of sessions that no longer exist (C-35)", async (t) => {
	const env = await isolatePancodeEnv("pancode-orphan-state-");
	t.after(() => env.restore());
	const stateDir = path.join(env.dir, "state");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	mkdirSync(path.join(stateDir, "sessions", "workspace-hash", "kept"), { recursive: true });
	const workspaces = path.join(stateDir, "extension-workspaces");
	const sessions = path.join(stateDir, "extensions", "lab_status.v1", "sessions");
	mkdirSync(workspaces, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	for (const name of ["kept.json", "gone.json", "current.json"]) writeFileSync(path.join(workspaces, name), "null\n");
	for (const name of ["kept.json", "gone.json", "gone.json.bak", "current.json", "notes.txt"])
		writeFileSync(path.join(sessions, name), "{}");
	writeFileSync(path.join(stateDir, "extensions", "lab_status.v1", "store.json"), "{}");
	// Pins and dock files name their session by hash; one of a deleted session that left nothing else must go too.
	const pinned = (id: string) => pinnedContextFile(stateDir, id);
	const docked = (id: string | null) => extensionDockPaths(stateDir, id);
	mkdirSync(path.dirname(pinned("kept")), { recursive: true });
	mkdirSync(path.dirname(docked(null).frameFile), { recursive: true });
	const hashedKept = [pinned("kept"), docked("kept").frameFile, docked("current").tapFile, docked(null).frameFile];
	const hashedGone = [pinned("pin-only"), docked("pin-only").frameFile, docked("pin-only").tapFile];
	for (const file of [...hashedKept, ...hashedGone]) writeFileSync(file, "{}");
	// Another process creates session "racer" and writes its state the moment this host has read the recorded sessions.
	const realReaddir = fs.readdirSync;
	let raced = false;
	mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
		const listed = realReaddir(...args);
		if (!raced && path.resolve(String(args[0])) === path.join(stateDir, "sessions", "workspace-hash")) {
			raced = true;
			mkdirSync(path.join(stateDir, "sessions", "workspace-hash", "racer"));
			writeFileSync(path.join(workspaces, "racer.json"), "null\n");
			writeFileSync(path.join(sessions, "racer.json"), "{}");
			writeFileSync(pinned("racer"), "{}");
		}
		return listed;
	});
	syncBuiltinESMExports();
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: "current", mode: "interactive" }),
		isIdle: () => true,
		list: () => [],
		stateDir: () => stateDir,
	});
	t.after(() => runtime.dispose());
	try {
		equal((await runtime.reload("startup")).status, "committed");
	} finally {
		mock.restoreAll();
		syncBuiltinESMExports();
	}
	ok(raced);
	deepStrictEqual(readdirSync(workspaces).sort(), ["current.json", "kept.json", "racer.json"]);
	deepStrictEqual(readdirSync(sessions).sort(), ["current.json", "kept.json", "notes.txt", "racer.json"]);
	ok(existsSync(pinned("racer")), "a session created while the host pruned keeps its state");
	for (const file of hashedKept) ok(existsSync(file), `${path.basename(file)} belongs to a live session`);
	for (const file of hashedGone) ok(!existsSync(file), `${path.basename(file)} is an orphan`);
	ok(
		existsSync(path.join(stateDir, "extensions", "lab_status.v1", "store.json")),
		"the shared store is not per-session",
	);
});

test("real import failure and missing/undeclared handlers report degraded readiness", async (t) => {
	const f = await fixture(t, 'throw new Error("synthetic import failure")');
	const result = await f.runtime.reload();
	equal(result.status, "committed");
	match(result.message, /1 failed to start/);
	equal(f.runtime.entries()[0]?.state, "failed");
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /synthetic import failure/);
	for (const script of ["export default ()=>{}", 'export default api=>api.handle("undeclared",()=>({text:"bad"}))']) {
		writeFileSync(path.join(f.source, "extension.mjs"), script);
		installProject(f.source, f.cwd, { force: true });
		await f.runtime.reload();
		equal(f.runtime.commands()[0]?.available, false);
	}
});

test("CPU-bound command timeout answers on time and leaves no status", async (t) => {
	const f = await fixture(t, 'export default api=>api.handle("inspect",()=>{while(true){}});', {
		commands: [{ name: "inspect", description: "hang", timeoutMs: 100 }],
	});
	await f.runtime.reload();
	const start = performance.now();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /timed out/);
	ok(performance.now() - start < 3000);
	equal(f.runtime.entries()[0]?.status, undefined);
});

test("cancellation fences ignored abort responses", async (t) => {
	const f = await fixture(
		t,
		'export default api=>{api.handle("inspect",async()=>{await new Promise(r=>setTimeout(r,80));return {text:"late",status:{text:"stale"}}});};',
	);
	await f.runtime.reload();
	const controller = new AbortController();
	const call = f.runtime.invoke("ext:lab_status.v1:inspect", "", [], controller.signal);
	controller.abort();
	await rejects(call, /cancelled|disposed/);
	await delay(150);
	equal(f.runtime.entries()[0]?.status, undefined);
});

test("session switch during request fences old output and rebuilds context", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",async(args,ctx)=>{await new Promise(r=>setTimeout(r,60));return {text:ctx.snapshot.sessionId,status:{text:"session status"}}});',
	);
	await f.runtime.reload();
	const call = f.runtime.invoke("ext:lab_status.v1:inspect", "");
	f.setSession("pancode-session-two");
	f.runtime.invalidateContext();
	await rejects(call, /disposed|revoked/);
	await f.runtime.reload("session-change");
	equal((await f.runtime.invoke("ext:lab_status.v1:inspect", "")).text, "pancode-session-two");
});

test("install change while staging rejects candidate and starts no substituted bytes", async (t) => {
	const f = await fixture(
		t,
		'export default async api=>{await new Promise(r=>setTimeout(r,100));api.handle("inspect",()=>({text:"snapshot"}));};',
	);
	const reload = f.runtime.reload();
	await delay(30);
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	equal((await reload).status, "rejected");
	equal(
		f.runtime.commands().some((row) => row.available),
		false,
	);
});

test("a runtime closed while a reload stages drops the reload without reporting a failure", async (t) => {
	const f = await fixture(
		t,
		'export default async api=>{await new Promise(r=>setTimeout(r,100));api.handle("inspect",()=>({text:"ok"}));};',
	);
	const reload = f.runtime.reload();
	await delay(30);
	await f.runtime.dispose();
	deepStrictEqual(await reload, { status: "rejected", generation: 0, message: "operator runtime is disposed" });
	deepStrictEqual(f.reports, []);
});

test("event observations have no bodies, cannot open panels, and status resets on reload", async (t) => {
	const f = await fixture(
		t,
		'export default api=>{api.handle("inspect",()=>({text:"ok"}));for(const event of ["session_open","turn_end"])api.on(event,(event,ctx)=>({text:JSON.stringify(event),status:{text:(event.reason??event.outcome)+":"+ctx.snapshot.sessionId}}));};',
		{ events: ["session_open", "turn_end"] },
	);
	await f.runtime.reload("startup");
	for (let i = 0; i < 50 && !f.runtime.entries()[0]?.status; i++) await delay(10);
	equal(f.runtime.entries()[0]?.status?.text, "startup:pancode-session-one");
	f.runtime.observeV2({ event: "turn_end", turnId: "turn-1", outcome: "completed", usage: null });
	for (let i = 0; i < 50 && !f.runtime.entries()[0]?.status?.text.startsWith("completed"); i++) await delay(10);
	equal(f.runtime.entries()[0]?.status?.text, "completed:pancode-session-one");
});

test("host rejects forged protocol identity", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",()=>{process.send({protocol:1,instance:"forged",kind:"result",id:"fake",output:{text:"bad"}});return {text:"normal"};});',
	);
	await f.runtime.reload();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /instance mismatch/);
});

test("a rejected typo with a command typed after it is refused, while a path stays prose", () => {
	deepStrictEqual(parseSlashCommand("/modle/thinking"), {
		kind: "unknown-command",
		token: "modle/thinking",
		text: "/modle/thinking",
	});
	equal(parseSlashCommand("/tmp/x is broken").kind, "unknown");
	equal(parseSlashCommand("/home/user/file").kind, "unknown");
});

test("canonical IDs coexist with prompt ownership and preserve escaped/path prose", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	equal(parseSlashCommand(`/${invocation}`).kind, "unknown-command");
	equal(parseSlashCommand(`\\/${invocation}`).kind, "unknown");
	equal(parseSlashCommand("/home/user/file").kind, "unknown");
	const rows = resolveExtensionCommands(f.runtime.commands(), [invocation.toUpperCase()]);
	equal(rows[0]?.available, false);
	match(rows[0]?.reason ?? "", /prompt/);
	await rejects(f.runtime.invoke(invocation, "", [invocation]), /prompt/);
});

test("WTF-P F13: a cut table keeps short code columns whole, a one-row slot keeps content, a cut names its way", () => {
	const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());
	const detail = "project://sections/methodology/research is linked but does not resolve to any record";
	const table = plain(
		renderView(
			{
				t: "table",
				columns: ["severity", "finding", "detail"],
				rows: [
					["warning", "artifact-unresolved", detail],
					["error", "claim-id-duplicate", detail],
				],
			},
			80,
		).lines,
	);
	match(table[2] ?? "", /^warning +│ artifact-unresolved +│ project:/u);
	match(table[3] ?? "", /^error +│ claim-id-duplicate +│/u);
	const ledger: View = {
		t: "kv",
		items: [
			{ label: "sources verified", value: "0" },
			{ label: "required claims without support", value: "3" },
		],
	};
	match(plain(renderView(ledger, 40).lines)[1] ?? "", /^required claims without support +3$/u);
	match(plain(renderView(ledger, 20).lines)[1] ?? "", /^required claims … +3$/u);
	const footer: View = {
		t: "box",
		dir: "col",
		children: ["Draft 1", "Plan 2", "Review 3"].map((text): View => ({ t: "text", text })),
	};
	deepStrictEqual(plain(renderView(footer, 40, { maxRows: 1 }).lines), ["Draft 1"]);
	deepStrictEqual(plain(renderView(footer, 40, { maxRows: 2, cutNote: "Ctrl+G J shows it whole" }).lines), [
		"Draft 1",
		"2 rows cut · Ctrl+G J shows it whole",
	]);
});

test("WTF-P F07/F13: a transcript card cut to its rows names /extensions card, which opens it whole", async () => {
	let listener: ((event: ExtensionSurfaceEvent | null) => void) | undefined;
	const cards: Array<(width: number) => string[]> = [];
	const opened: Array<{ owner: string; title: string | undefined; view: View | undefined }> = [];
	let overlay = "closed";
	const ambient = createAmbientSurfaces({
		operator: {
			surface: {
				subscribe: (next: typeof listener) => {
					listener = next;
					return () => undefined;
				},
				entry: () => undefined,
			},
			closePanel: () => undefined,
		} as unknown as Parameters<typeof createAmbientSurfaces>[0]["operator"],
		tui: { requestRender: () => undefined },
		dock: {
			available: () => false,
			onPress: () => () => undefined,
			dispose: async () => undefined,
		} as unknown as Parameters<typeof createAmbientSurfaces>[0]["dock"],
		overlay: () =>
			({
				getState: () => overlay,
				openExtensionViewPanelState: (owner: string, deps: { panel(): { title?: string; view: View } | undefined }) => {
					opened.push({ owner, title: deps.panel()?.title, view: deps.panel()?.view });
					return true;
				},
			}) as unknown as ReturnType<Parameters<typeof createAmbientSurfaces>[0]["overlay"]>,
		notice: () => undefined,
		appendCard: (render) => cards.push(render),
		showText: () => undefined,
		fill: () => undefined,
		submit: () => undefined,
	});
	const rows = (count: number): View => ({
		t: "box",
		dir: "col",
		children: Array.from({ length: count }, (_, index): View => ({ t: "text", text: `/wtfp:action-${index + 1}` })),
	});
	const help = rows(37);
	listener?.({ kind: "card", extensionId: "wtfp", view: help });
	listener?.({ kind: "card", extensionId: "wtfp", view: rows(2) });
	const tall = (cards[0]?.(100) ?? []).map((line) => stripVTControlCharacters(line));
	equal(tall.length, 24);
	match(tall[22] ?? "", /16 rows cut · \/extensions card 1 shows it whole/u);
	equal(
		(cards[1]?.(100) ?? []).some((line) => line.includes("/extensions card")),
		false,
	);
	equal(ambient.showCard(undefined), "opened");
	deepStrictEqual(opened[0], { owner: "wtfp", title: "Card 1", view: help });
	equal(ambient.showCard(9), "missing");
	overlay = "extension-panel";
	equal(ambient.showCard(1), "busy");
	await ambient.dispose();
});

test("scientific examples are valid packages and the real dashboard labels synthetic evidence", async (t) => {
	const f = await fixture(t);
	for (const name of ["lab-status", "measurements"]) {
		const source = path.resolve("examples/extensions", name);
		ok(loadManifestFromRoot(source).valid, name);
		ok(installProject(source, f.cwd).extension?.loadable);
	}
	await f.runtime.reload();
	const output = await f.runtime.invoke("ext:lab-status:dashboard", "");
	match(output.text, /SYNTHETIC FIXTURE/);
	ok(output.panel);
	match(output.status?.text ?? "", /2\/3 completed/);
	const view = output.panel.view;
	ok(view.t === "box");
	const table = view.children.find((child) => child.t === "table");
	deepStrictEqual(table?.t === "table" ? table.columns : undefined, ["Job", "MPI ranks", "State", "Elapsed s"]);
});

test("post-activation child death is failed and cannot leave a stale status", async (t) => {
	const f = await fixture(t, 'export default api=>api.handle("inspect",()=>{process.exit(23)});');
	await f.runtime.reload();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /exited/);
	equal(f.runtime.entries()[0]?.state, "failed");
});

test("startup CPU loop has a real deadline", { timeout: 12000 }, async (t) => {
	const f = await fixture(t, "while(true){}");
	const start = performance.now();
	equal((await f.runtime.reload()).status, "committed");
	match(f.runtime.entries()[0]?.reason ?? "", /startup timed out/);
	ok(performance.now() - start < 9000);
});

test("unsolicited stdout flood fails without forwarding terminal bytes", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",()=>{process.stdout.write("x".repeat(100000));return {text:"done"}});',
	);
	await f.runtime.reload();
	// The response and pipe chunks can arrive in either order. Both lead to failure.
	await f.runtime.invoke("ext:lab_status.v1:inspect", "").catch(() => {});
	for (let i = 0; i < 100 && f.runtime.entries()[0]?.state !== "failed"; i++) await delay(10);
	match(f.runtime.entries()[0]?.reason ?? "", /diagnostic output/);
});

test("eight-runtime cap is explicit", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 9; i++) {
		writeFileSync(
			path.join(f.source, "pancode-extension.json"),
			JSON.stringify({ ...f.manifest, id: `pancode-fixture-${i}` }),
		);
		ok(installProject(f.source, f.cwd).extension?.loadable);
	}
	await f.runtime.reload();
	equal(f.runtime.entries().filter((entry) => entry.state === "ready").length, 8);
	equal(f.runtime.entries().filter((entry) => entry.reason?.includes("limit is 8")).length, 2);
});

test("UI-only changes in a mixed package revoke frozen tools; workers never start its runtime", async (t) => {
	const f = await fixture(
		t,
		'import {writeFileSync} from "node:fs";writeFileSync("pancode-runtime-started.txt","started");export default api=>api.handle("inspect",()=>({text:"ok"}));',
	);
	const manifest = {
		...f.manifest,
		id: "mixed-fixture",
		capabilities: {
			tools: [
				{
					name: "measure",
					description: "Synthetic tool",
					runtime: "node",
					entrypoint: "measure.cjs",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		},
	};
	writeFileSync(path.join(f.source, "pancode-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(f.source, "measure.cjs"), "console.log(JSON.stringify({value:42,synthetic:true}));");
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user" }).extension?.loadable);
	const name = "extension_mixed-fixture__measure" as DynamicToolName;
	const worker = createWorkerToolRegistry();
	ok(worker.get(name));
	equal(existsSync(path.join(f.cwd, "pancode-runtime-started.txt")), false);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: f.cwd }) });
	registerHarnessExtensionTools(registry, f.cwd);
	const tool = registry.get(name);
	ok(tool);
	equal((await tool.run({})).kind, "ok");
	await f.runtime.reload();
	writeFileSync(path.join(f.source, "extension.mjs"), normal);
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user", force: true }).extension?.loadable);
	await f.runtime.reload();
	equal((await tool.run({})).kind, "error");
	ok(f.runtime.entries().find((entry) => entry.id === "mixed-fixture")?.newSessionReasons.length);
	// No model tool schema was dynamically rebound by the successful runtime reload.
	equal(registry.get(name), tool);
});

test("completion and dispatch preserve display-only prompt ownership at the same canonical spelling", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	let promptNames: Array<{ name: string; description: string; displayOnly: boolean; sourceInfo: { source: string } }> =
		[];
	const provider = createSlashCommandAutocompleteProvider({
		fdPath: null,
		extensionCommands: () => f.runtime.commands(),
		promptTemplates: () => promptNames,
	});
	const line = "/ext:lab";
	const suggestions = () => provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	equal((await suggestions())?.items[0]?.value, invocation);
	promptNames = [
		{ name: invocation, description: "Legacy reference", displayOnly: true, sourceInfo: { source: "project" } },
	];
	const collided = await suggestions();
	equal(collided?.items.length, 1);
	match(String(collided?.items[0]?.description), /reference/);
	let references = 0;
	let turns = 0;
	const ctx = {
		operatorExtensions: f.runtime,
		listPrompts: () => ({ items: promptNames, diagnostics: [] }),
		expandPromptTemplate: () => ({
			expanded: false,
			display: { template: { name: invocation, sourceInfo: { source: "project" } }, text: "Legacy reference" },
		}),
		submitChat: () => {
			turns++;
		},
		showReference: () => {
			references++;
		},
		render: () => {},
		notice: () => {},
	} as unknown as SlashCommandContext;
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation}`), ctx), "accepted");
	equal(references, 1);
	equal(turns, 0);
	equal(f.runtime.entries()[0]?.status, undefined);
});

test("operator dispatch joins local admission and preserves unavailable drafts", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	const operations: Array<() => Promise<void>> = [];
	const outputs: string[] = [];
	const notices: string[] = [];
	const ctx = {
		operatorExtensions: f.runtime,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		runLocalOperation: (operation: () => Promise<void>) => operations.push(operation),
		showExtensionOutput: (_command: string, output: { text: string }) => outputs.push(output.text),
		render: () => {},
		notice: (_level: string, message: string) => notices.push(message),
	} as unknown as SlashCommandContext;
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation} queued args`), ctx), "accepted");
	equal(operations.length, 1);
	equal(outputs.length, 0);
	equal(f.runtime.entries()[0]?.status, undefined, "dispatch must wait for the host's local-operation queue");
	await operations[0]?.();
	equal(JSON.parse(outputs[0] ?? "null").args, "queued args");
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	f.runtime.v2.reconcile();
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation}`), ctx), "rejected");
	equal(dispatchSlashCommand(parseSlashCommand("/ext:unknown:missing"), ctx), "rejected");
	equal(operations.length, 1);
	equal(notices.length, 2);
});

test("no-runtime and queued busy maintenance do no repeated disk verification", async (t) => {
	const f = await fixture(t);
	let lists = 0;
	let idle = true;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		list: () => {
			lists++;
			return [];
		},
		isIdle: () => idle,
	});
	t.after(() => runtime.dispose());
	await runtime.reload();
	const baseline = lists;
	equal(runtime.maintenanceDelayMs, null);
	for (let i = 0; i < 100; i++) {
		runtime.maintenance();
		runtime.v2.reconcile();
		runtime.invalidateContext();
		runtime.observeV2({ event: "turn_end", turnId: "turn-1", outcome: "completed", usage: null });
	}
	equal(lists, baseline);
	idle = false;
	equal((await runtime.reload()).status, "deferred");
	for (let i = 0; i < 100; i++) runtime.maintenance();
	equal(lists, baseline);
	equal(runtime.maintenanceDelayMs, 250);
});

for (const failure of ["context", "inventory"] as const) {
	test(`reload retains cleanup ownership when ${failure} lookup fails before staging`, async (t) => {
		const f = await fixture(t, 'export default api=>{api.handle("inspect",()=>({text:String(process.pid)}));};');
		let broken = false;
		const runtime = new OperatorExtensions({
			context: () => {
				if (broken && failure === "context") throw new Error("context unavailable");
				return { workspace: f.cwd, sessionId: null, mode: "interactive" };
			},
			list: () => {
				if (broken && failure === "inventory") throw new Error("inventory unavailable");
				return [f.extension];
			},
			isIdle: () => true,
		});
		let pid: number | undefined;
		try {
			equal((await runtime.reload()).status, "committed");
			await runtime.invoke("ext:lab_status.v1:inspect", "");
			// The runtime's own process.pid may be a sandbox namespace's; the host's handle names the real child.
			const live = (runtime.v2 as unknown as { processes: Map<string, { pid?: number }> }).processes;
			const childPid = live.get("lab_status.v1")?.pid ?? 0;
			pid = childPid;
			ok(Number.isSafeInteger(pid) && pid > 0);
			broken = true;
			equal((await runtime.reload()).status, "rejected");
			await runtime.dispose();
			throws(() => process.kill(childPid, 0), { code: "ESRCH" });
		} finally {
			await runtime.dispose();
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already reaped by disposal. */
				}
			}
		}
	});
}

test("frozen registry provenance detects a package changed between tool bootstrap and runtime startup", async (t) => {
	const f = await fixture(t);
	const manifest = {
		...f.manifest,
		id: "bootstrap-gap",
		capabilities: {
			tools: [
				{
					name: "measure",
					description: "Synthetic tool",
					runtime: "node",
					entrypoint: "measure.cjs",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		},
	};
	writeFileSync(path.join(f.source, "pancode-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(f.source, "measure.cjs"), 'console.log("42")');
	installProject(f.source, f.cwd);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: f.cwd }) });
	registerHarnessExtensionTools(registry, f.cwd);
	const frozenTools = registry
		.listAll()
		.flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : []));
	writeFileSync(path.join(f.source, "extension.mjs"), `${normal}\n// UI-only changed after schema bootstrap`);
	installProject(f.source, f.cwd, { force: true });
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		frozenTools,
	});
	t.after(() => runtime.dispose());
	await runtime.reload();
	const entry = runtime.entries().find((entry) => entry.id === "bootstrap-gap");
	equal(entry?.toolEvidence, "frozen-registry");
	match(entry?.newSessionReasons.join(" ") ?? "", /differs from the frozen tool registry/);
});

test("runtime activation rejects metadata that differs from the digest-bound manifest", async (t) => {
	const f = await fixture(t);
	const forged = structuredClone(f.extension);
	ok(forged.runtimeV2);
	forged.runtimeV2.ui = [];
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: () => [forged],
	});
	t.after(() => runtime.dispose());
	await runtime.reload();
	await rejects(runtime.invoke("ext:lab_status.v1:inspect", ""), /declarations differ/);
});

test("empty startup reload reports structured readiness and its origin to the UI", async () => {
	const observations: string[] = [];
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: process.cwd(), sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: () => [],
		onReload: (result, reason) => observations.push(`${reason}:${result.degraded}`),
	});
	try {
		const result = await runtime.reload("startup");
		equal(result.status, "committed");
		equal(result.degraded, 0);
		deepStrictEqual(observations, ["startup:0"]);
		ok(!result.message.includes("generation"));
		await runtime.reload();
		deepStrictEqual(observations, ["startup:0", "reload:0"]);
	} finally {
		await runtime.dispose();
	}
});

test("a running extension snapshot follows its served plugin's installation, enable and disable", async (t) => {
	const env = await isolatePancodeEnv("pancode-served-plugin-test-");
	const cwd = path.join(env.dir, "workspace");
	const source = path.join(env.dir, "source");
	mkdirSync(cwd);
	mkdirSync(source);
	writeFileSync(
		path.join(source, "pancode-extension.json"),
		JSON.stringify({
			id: "lab_status.v1",
			name: "Lab status",
			version: "1.0.0",
			description: "Synthetic served plugin fixture",
			plugin: "sample-kit",
			runtime: declaration,
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), normal);
	ok(installExtension(source, { cwd, scope: "user" }).extension);
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		stateDir: () => path.join(env.dir, "state"),
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	equal((await runtime.reload("startup")).status, "committed");
	const inspect = async () => JSON.parse((await runtime.invoke("ext:lab_status.v1:inspect", "")).text);
	deepStrictEqual((await inspect()).snapshot.plugin, null);
	ok(installPlugin(path.resolve(import.meta.dirname, "../fixtures/plugins/sample-kit"), { cwd, scope: "user" }).plugin);
	const enabled = await inspect();
	equal(enabled.n, 2, "plugin changes update the existing child");
	deepStrictEqual(enabled.snapshot.plugin, {
		id: "sample-kit",
		prompts: listInstalledExtensions(cwd).find((entry) => entry.id === "lab_status.v1")?.pluginPrompts,
	});
	ok(enabled.snapshot.plugin.prompts.includes("sample-kit:review"));
	disablePlugin("sample-kit", { cwd, scope: "user" });
	const disabled = await inspect();
	equal(disabled.n, 3);
	equal(disabled.snapshot.plugin, null);
	enablePlugin("sample-kit", { cwd, scope: "user" });
	deepStrictEqual((await inspect()).snapshot.plugin, enabled.snapshot.plugin);
	equal((await runtime.reload()).status, "committed");
	deepStrictEqual((await inspect()).snapshot.plugin, enabled.snapshot.plugin);
	removePlugin("sample-kit", { cwd, scope: "user" });
	equal((await inspect()).snapshot.plugin, null);
});

test("a served plugin's prompt is a plain prompt until its extension is installed and in effect", async (t) => {
	const env = await isolatePancodeEnv("pancode-takeover-test-");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	const plugin = path.join(env.dir, "plugin");
	mkdirSync(path.join(plugin, "dev.pancode", "prompts", "demo-pack"), { recursive: true });
	writeFileSync(path.join(plugin, "dev.pancode", "prompts", "demo-pack", "status.md"), "Report the demo status.\n");
	writeFileSync(
		path.join(plugin, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "demo-pack",
			version: "1.0.0",
			description: "Synthetic plugin fixture",
			extensions: {
				"dev.pancode": {
					manifestVersion: 1,
					resources: { prompts: "dev.pancode/prompts" },
					components: [{ kind: "prompt", id: "status", path: "dev.pancode/prompts/demo-pack/status.md" }],
				},
			},
		}),
	);
	const extension = path.join(env.dir, "extension");
	mkdirSync(extension);
	writeFileSync(
		path.join(extension, "pancode-extension.json"),
		JSON.stringify({
			id: "demo-pack",
			name: "Demo pack",
			version: "1.0.0",
			description: "Synthetic served plugin fixture",
			plugin: "demo-pack",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				commands: [{ name: "status", description: "Show the demo status.", replaces: "prompt" }],
				events: ["session_open"],
				permissions: { fs: { read: [], write: [] }, exec: false, net: false },
			},
		}),
	);
	writeFileSync(
		path.join(extension, "extension.mjs"),
		'export default (api) => { api.handle("status", () => ({ text: "demo status" })); api.on("session_open", () => ({})); };\n',
	);
	ok(installPlugin(plugin, { cwd, scope: "user" }).plugin);
	const prompts = () => loadPromptTemplates({ cwd });
	let turns = 0;
	const shown: string[] = [];
	const ctx = {
		get operatorExtensions() {
			return runtime;
		},
		listPrompts: () => ({ items: prompts().items, diagnostics: [] }),
		expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, prompts()),
		submitChat: () => {
			turns++;
		},
		runLocalOperation: (operation: () => Promise<void>) => void operation(),
		showExtensionOutput: (command: string, _output: unknown, extensionId: string) =>
			shown.push(`${command} ${extensionId}`),
		render: () => {},
		notice: () => {},
	} as unknown as SlashCommandContext;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(env.dir, "state"),
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	const names = () => promptRefs(prompts().items);
	ok(
		names().some((prompt) => prompt.name === "demo-pack:status"),
		"the plugin alone provides the prompt",
	);

	// Plugin alone: no runtime exists, and the name expands as an ordinary prompt template.
	equal((await runtime.reload("startup")).status, "committed");
	deepStrictEqual(runtime.entries(), []);
	deepStrictEqual(runtime.commands(names()), []);
	equal(dispatchSlashCommand(parseSlashCommand("/demo-pack:status"), ctx), "accepted");
	equal(turns, 1);
	deepStrictEqual(shown, []);

	// With its extension installed and running, the same name routes to the runtime command.
	ok(installExtension(extension, { cwd, scope: "user" }).extension);
	equal((await runtime.reload()).status, "committed");
	equal(runtime.entries().find((entry) => entry.id === "demo-pack")?.state, "ready");
	const takeover = runtime.commands(names()).find((row) => row.invocation === "demo-pack:status");
	ok(takeover?.available && takeover.replaces === "prompt", JSON.stringify(takeover));
	equal(dispatchSlashCommand(parseSlashCommand("/demo-pack:status"), ctx), "accepted");
	for (let waited = 0; shown.length === 0 && waited < 10_000; waited += 50) await delay(50);
	equal(turns, 1, "the takeover must not also send the prompt to the model");
	deepStrictEqual(shown, ["demo-pack:status demo-pack"], "the alias carries its extension id, not a token segment");
});

test("a net:false runtime cannot reach loopback, reports its backend, and gets exactly its declared write root", {
	skip: !sandboxAvailability().available,
}, async (t) => {
	let hits = 0;
	const server = createServer((_request, response) => {
		hits++;
		response.end("reached");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const { port } = server.address() as AddressInfo;
	const script = [
		'import { spawnSync } from "node:child_process";',
		"export default api => {",
		'  api.handle("probe", async () => {',
		`    const loopback = await fetch("http://127.0.0.1:${port}/").then(() => "reached", () => "refused");`,
		'    const beside = spawnSync("sh", ["-c", "echo x > beside.txt"]).status === 0;',
		'    const inside = spawnSync("sh", ["-c", "echo x > .research/inside.txt"]).status === 0;',
		"    return { text: JSON.stringify({ loopback, beside, inside }) };",
		"  });",
		"};",
	].join("\n");
	const f = await fixture(t, script, {
		api: 2,
		commands: [{ name: "probe", description: "Probe the sandbox", timeoutMs: 10_000 }],
		ui: [],
		permissions: { fs: { read: [], write: [".research"] }, exec: true, net: false },
	});
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(f.env.dir, "state"),
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	equal(existsSync(path.join(f.cwd, ".research")), false);
	const output = await runtime.invoke(extensionInvocation("lab_status.v1", "probe"), "");
	deepStrictEqual(JSON.parse(String(output.text)), { loopback: "refused", beside: false, inside: true });
	equal(hits, 0);
	ok(existsSync(path.join(f.cwd, ".research", "inside.txt")));
	equal(existsSync(path.join(f.cwd, "beside.txt")), false);
	deepStrictEqual(runtime.entries().find((entry) => entry.id === "lab_status.v1")?.sandbox, {
		backend: sandboxAvailability().backend,
		network: "blocked",
	});
});

test("a stopped runtime removes the empty write roots it created and keeps pre-existing or filled ones", async (t) => {
	const script = [
		'import { writeFileSync } from "node:fs";',
		"export default api => {",
		'  api.handle("probe", async () => { writeFileSync("filled/kept.txt", "x"); return { text: "ok" }; });',
		"};",
	].join("\n");
	const f = await fixture(t, script, {
		api: 2,
		commands: [{ name: "probe", description: "Fill one root", timeoutMs: 10_000 }],
		ui: [],
		permissions: { fs: { read: [], write: [".research/notes", "filled", "existing"] }, exec: false, net: false },
	});
	mkdirSync(path.join(f.cwd, "existing"));
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(f.env.dir, "state"),
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	equal((await runtime.invoke(extensionInvocation("lab_status.v1", "probe"), "")).text, "ok");
	ok(existsSync(path.join(f.cwd, ".research", "notes")), "roots exist while the runtime runs");
	await runtime.dispose();
	equal(existsSync(path.join(f.cwd, ".research")), false, "host-created empty roots and parents are removed");
	ok(existsSync(path.join(f.cwd, "filled", "kept.txt")), "a root with content survives");
	ok(existsSync(path.join(f.cwd, "existing")), "a pre-existing root survives");
});

test("a runtime in a read-only session writes its store but none of its workspace roots, and creates none", async (t) => {
	const script = [
		'import { writeFileSync } from "node:fs";',
		'import path from "node:path";',
		"export default api => {",
		'  api.handle("probe", async (storeDir) => {',
		"    const tryIt = (fn) => { try { fn(); return true; } catch { return false; } };",
		"    return { text: JSON.stringify({",
		'      inside: tryIt(() => writeFileSync(".research/inside.txt", "x")),',
		'      beside: tryIt(() => writeFileSync("beside.txt", "x")),',
		'      store: tryIt(() => writeFileSync(path.join(storeDir, "kept.txt"), "x")),',
		"    }) };",
		"  });",
		"};",
	].join("\n");
	const f = await fixture(t, script, {
		api: 2,
		commands: [{ name: "probe", description: "Probe the write roots", timeoutMs: 10_000 }],
		ui: [],
		permissions: { fs: { read: [], write: [".research", "store"] }, exec: false, net: false },
	});
	const stateDir = path.join(f.env.dir, "state");
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "headless" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => stateDir,
		readOnly: () => true,
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	const storeDir = path.join(stateDir, "extensions", "lab_status.v1", "files");
	const output = await runtime.invoke(extensionInvocation("lab_status.v1", "probe"), storeDir);
	deepStrictEqual(JSON.parse(String(output.text)), { inside: false, beside: false, store: true });
	equal(existsSync(path.join(f.cwd, ".research")), false, "the declared workspace root is not created");
	equal(existsSync(path.join(f.cwd, "beside.txt")), false);
	ok(existsSync(path.join(storeDir, "kept.txt")), "the store is PanCode's home and stays writable");
});

test("a read-only runtime that may run programs needs bubblewrap", () => {
	const declaration = {
		permissions: { fs: { read: [], write: ["store", "out"] }, exec: true, net: false },
	} as unknown as ExtensionRuntimeDeclarationV2;
	throws(
		() => readOnlyRuntimeDeclaration(declaration, { available: true, backend: "seatbelt" } as SandboxAvailability),
		/only a bubblewrap sandbox/,
	);
	throws(() => readOnlyRuntimeDeclaration(declaration, { available: false, reason: "none" } as SandboxAvailability));
	deepStrictEqual(
		readOnlyRuntimeDeclaration(declaration, { available: true, backend: "bwrap" } as SandboxAvailability).permissions.fs
			.write,
		["store"],
	);
});

test("a declared extension can request host embeddings without seeing the route", async (t) => {
	const script = [
		"export default api => {",
		'  api.handle("probe", async (_args, ctx) => {',
		'    if (!ctx.embed) return { text: "unavailable" };',
		'    const result = await ctx.embed({ inputs: [{ kind: "text", text: "lab observation" }], task: "query", expectedProfileIdentity: "profile-1" });',
		"    return { text: JSON.stringify({ identity: result.profileIdentity, dimensions: result.dimensions }) };",
		"  });",
		"};",
	].join("\n");
	const f = await fixture(t, script, {
		api: 2,
		commands: [{ name: "probe", description: "Use a host embedding", timeoutMs: 10_000 }],
		ui: [],
		services: { embedding: true },
	});
	ok(f.extension.runtimeV2);
	match(envelopeLines(capabilityEnvelope(f.extension.runtimeV2)).join("\n"), /Host services: embedding requests/);
	let calls = 0;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(f.env.dir, "state"),
		embed: async (request, _signal, workspace) => {
			calls++;
			equal(workspace, f.cwd);
			deepStrictEqual(request, {
				inputs: [{ kind: "text", text: "lab observation" }],
				task: "query",
				expectedProfileIdentity: "profile-1",
			});
			return { profileIdentity: "profile-1", dimensions: 768, vectors: [Array(768).fill(0)], model: "test" } as never;
		},
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	const output = await runtime.invoke(extensionInvocation("lab_status.v1", "probe"), "");
	deepStrictEqual(JSON.parse(String(output.text)), { identity: "profile-1", dimensions: 768 });
	equal(calls, 1);
});

test("an undeclared extension cannot reach the host embedding callback", async (t) => {
	const f = await fixture(
		t,
		'export default api => api.handle("probe", (_args, ctx) => ({ text: String(ctx.embed === undefined) }));',
		{ api: 2, commands: [{ name: "probe", description: "Check absence", timeoutMs: 10_000 }], ui: [] },
	);
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(f.env.dir, "state"),
		embed: async () => {
			throw new Error("host callback must not run");
		},
	});
	t.after(() => runtime.dispose());
	equal((await runtime.reload("startup")).status, "committed");
	const output = await runtime.invoke(extensionInvocation("lab_status.v1", "probe"), "");
	equal(output.text, "true");
});
