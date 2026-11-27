// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, test } from "node:test";
import type { ExtensionCompletionRequest } from "@pancode/sdk/extension";
import {
	capabilityEnvelope,
	type ExtensionBinaryDeclaration,
	envelopeGrowth,
	parseExtensionRuntimeV2,
} from "@pancode/sdk/pack";
import { readBlobHistory } from "@pancode/store";
import { sha256Hex } from "../../src/core/hash.js";
import { recentPackageActivity } from "../../src/core/package-activity.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { pancodeStateDir } from "../../src/core/xdg.js";
import {
	assignExtensionServiceModel,
	createExtensionHostServices,
	type ExtensionHostServicesDeps,
	type ExtensionServiceBinding,
	type ExtensionServiceHost,
} from "../../src/domains/extensions/host-services.js";
import {
	type ExtensionCommandRow,
	extensionInvocation,
	resolveExtensionAliases,
} from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { readOnlyRuntimeDeclaration } from "../../src/domains/extensions/runtime-sandbox.js";
import {
	installPackBinaries,
	type PackBinaryCaller,
	packBinaryPath,
	parsePackBinaryRun,
	removePackBinaries,
	resolvePackBinary,
	runPackBinary,
	syncPackBinaries,
} from "../../src/domains/extensions/services/binaries.js";
import { resolveExtensionKeys } from "../../src/domains/extensions/services/keys.js";
import { createExtensionPaneHost, type ExtensionPaneOwner } from "../../src/domains/extensions/services/pane.js";
import {
	installExtension,
	installedExtensionClaims,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import type { MuxContract, MuxOpenUtilityPaneRequest } from "../../src/domains/mux/contract.js";
import { createDockKeyGate } from "../../src/domains/mux/dock-keys.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { modelEndpointKey } from "../../src/domains/providers/index.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { currentToolPlatform } from "../../src/domains/toolchain/index.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { startExtensionHost } from "../../src/entry/extension-host.js";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";
import { settleExtensionKeys } from "../../src/interactive/surfaces/extension-pane-keys.js";
import { resolveExtensionLine } from "../../src/session-control/extension-line.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

type Faux = ReturnType<typeof registerEngineFauxProvider>;

const answer = (text: string, stopReason: "stop" | "length" = "stop") => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "ext-services-fixture",
	provider: "fixture",
	model: "chat",
	stopReason,
	timestamp: Date.now(),
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

/** One cloud target, `fixture`, whose model `chat` streams from the faux provider. Its url can move. */
function fixtureRoutes(compat?: object): { faux: Faux; providers: ProvidersContract; target: { url: string } } {
	const faux = registerEngineFauxProvider({ api: "ext-services-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	const capabilities = { chat: true, tools: false, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const target = { id: "fixture", runtime: "fixture", url: "https://fixture.invalid/v1", defaultModel: "chat" };
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "oauth",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => ({ ...faux.getModel(id), ...(compat ? { compat } : {}) }),
	} as unknown as RuntimeDescriptor;
	const providers = {
		list: () => [
			{ target, runtime, available: true, capabilities, discoveredModels: ["chat"], discoveredModelsSource: "probe" },
		],
		getTarget: (id: string) => (id === target.id ? target : undefined),
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		auth: {
			resolveForTarget: async () => ({
				providerId: "fixture",
				available: true,
				credentialType: "oauth",
				source: "stored-oauth",
				detail: "fixture",
				apiKey: "fixture-key",
			}),
		},
	} as unknown as ProvidersContract;
	return { faux, providers, target };
}

const services = (extra: Record<string, unknown> = {}) => ({
	model: { sessionTokens: 1000, maxOutputTokens: 200 },
	store: { read: ["refs"], write: ["drafts"] },
	...extra,
});

function binding(workspace: string, overrides: Partial<ExtensionServiceBinding> = {}): ExtensionServiceBinding {
	return {
		extensionId: "scribe",
		scope: "user",
		sessionId: "s1",
		workspace,
		declaration: parseExtensionRuntimeV2({ api: 2, entrypoint: "extension.mjs", services: services() }),
		readOnly: () => false,
		...overrides,
	};
}

/** The assignment the operator made while `target` resolved where it does now. */
function assignedNow(routes: ReturnType<typeof fixtureRoutes>): NonNullable<ExtensionHostServicesDeps["assignment"]> {
	const target = routes.providers.getTarget("fixture");
	ok(target);
	const endpoint = modelEndpointKey(target, "chat");
	ok(endpoint);
	const assignment = { target: "fixture", model: "chat", endpoint, assignedAt: "2026-01-01T00:00:00Z" };
	return () => assignment;
}

const ask = (text: string, maxOutputTokens = 200): ExtensionCompletionRequest => ({
	messages: [{ role: "user", text }],
	maxOutputTokens,
});
const live = () => new AbortController().signal;

test("a model call with no assignment names the command that assigns one, and reaches no provider", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const { faux, providers } = fixtureRoutes();
	const host = createExtensionHostServices({ providers, assignment: () => undefined });
	await rejects(
		host.complete?.(binding(env.dir), ask("hi"), live()) ?? Promise.resolve(),
		/no model is assigned to extension scribe; run pancode extensions services scribe --model <target>\/<model>/u,
	);
	equal(faux.state.callCount, 0);
});

test("an attended host asks which model to assign once, and a declined ask keeps the call refused", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const { faux, providers } = fixtureRoutes();
	faux.setResponses([answer("chosen"), answer("again")]);
	const offered: string[][] = [];
	let pick = "Keep it unavailable";
	const host = createExtensionHostServices({
		providers,
		ask: async (questions) => {
			offered.push(questions[0]?.options.map((option) => option.label) ?? []);
			return { answers: [{ options: [pick] }] };
		},
	});
	const dev = binding(env.dir, { scope: "dev" });
	await rejects(host.complete?.(dev, ask("hi"), live()) ?? Promise.resolve(), /no model is assigned/u);
	pick = "fixture/chat";
	equal((await host.complete?.(dev, ask("hi"), live()))?.text, "chosen");
	equal((await host.complete?.(dev, ask("hi"), live()))?.text, "again");
	deepStrictEqual(offered, [
		["fixture/chat", "Keep it unavailable"],
		["fixture/chat", "Keep it unavailable"],
	]);
});

test("two calls that together exceed the session budget: exactly one runs", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const routes = fixtureRoutes();
	const { faux, providers } = routes;
	faux.setResponses([answer("one"), answer("two")]);
	const declaration = parseExtensionRuntimeV2({
		api: 2,
		entrypoint: "extension.mjs",
		services: services({ model: { sessionTokens: 300, maxOutputTokens: 200 } }),
	});
	const host = createExtensionHostServices({ providers, assignment: assignedNow(routes) });
	const bound = binding(env.dir, { declaration });
	const settled = await Promise.allSettled([
		host.complete?.(bound, ask("first"), live()),
		host.complete?.(bound, ask("second"), live()),
	]);
	deepStrictEqual(
		settled.map((entry) => entry.status),
		["fulfilled", "rejected"],
	);
	match(String((settled[1] as PromiseRejectedResult).reason), /model budget refused/u);
	equal(faux.state.callCount, 1, "the refused call never reached the provider");
});

test("spent budget carries across calls, and an over-budget call is refused before any provider request", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const routes = fixtureRoutes();
	const { faux, providers } = routes;
	// The faux provider reports usage from the text it streams: about a token for every four characters.
	faux.setResponses([answer("x".repeat(3200), "length")]);
	const host = createExtensionHostServices({ providers, assignment: assignedNow(routes) });
	const first = await host.complete?.(binding(env.dir), ask("draft"), live());
	ok(first);
	equal(first.stopReason, "length");
	const spent = first.usage.inputTokens + first.usage.outputTokens;
	ok(spent < 1000 && spent + 200 > 1000, `the reply spent ${spent} of the 1000 budget`);
	await rejects(host.complete?.(binding(env.dir), ask("again"), live()) ?? Promise.resolve(), /model budget refused/u);
	equal(faux.state.callCount, 1, "the refusal came before any provider request");
	// The budget is the session's: another session starts with its own.
	faux.setResponses([answer("fresh")]);
	equal((await host.complete?.(binding(env.dir, { sessionId: "s2" }), ask("third"), live()))?.text, "fresh");
});

test("a route that moved since the operator approved it needs approval again", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const routes = fixtureRoutes();
	const { faux, providers, target } = routes;
	const host = createExtensionHostServices({ providers, assignment: assignedNow(routes) });
	target.url = "https://elsewhere.invalid/v1";
	await rejects(
		host.complete?.(binding(env.dir), ask("hi"), live()) ?? Promise.resolve(),
		/approval needed again: fixture\/chat now resolves to .*elsewhere.*; run pancode extensions services scribe/u,
	);
	equal(faux.state.callCount, 0);
});

test("a route that refuses a sampler runs the call at its default temperature", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const routes = fixtureRoutes({ supportsTemperature: false });
	const sent: Array<number | undefined> = [];
	routes.faux.setResponses([
		(_context: unknown, options: { temperature?: number } | undefined) => {
			sent.push(options?.temperature);
			return answer("plain");
		},
	]);
	const host = createExtensionHostServices({ providers: routes.providers, assignment: assignedNow(routes) });
	equal((await host.complete?.(binding(env.dir), { ...ask("hi"), temperature: 0.4 }, live()))?.text, "plain");
	deepStrictEqual(sent, [undefined]);
});

test("a completion is journaled in the session and attributed to the extension", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const routes = fixtureRoutes();
	const { faux, providers } = routes;
	faux.setResponses([answer("noted")]);
	const sessionId = "ext-journal";
	const session = {
		current: () => ({ id: sessionId, cwd: env.dir, cwdHash: "ext-journal-repo" }),
	} as unknown as SessionContract;
	const journals = createSessionJournals(pancodeStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	const telemetry = { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract;
	const host = createExtensionHostServices({ providers, telemetry, session, assignment: assignedNow(routes) });
	const reply = await host.complete?.(binding(env.dir, { sessionId }), { system: "terse", ...ask("note it") }, live());
	ok(reply);
	await journals.flush();
	const journal = await readCallJournal(telemetrySessionDirectory(pancodeStateDir(), sessionId));
	const records = journal.records.map(({ record }) => record);
	const started = records.find((record) => record.k === "call.started");
	ok(started, "the call is journaled");
	deepStrictEqual(started.ctx.agent, { role: "helper", id: "extension:scribe" });
	const settled = records.find((record) => record.k === "call.settled")?.data as CallSettled | undefined;
	equal(settled?.disposition, "settled");
	deepStrictEqual(
		[settled?.usage?.input, settled?.usage?.output].map((fact) => (fact?.kind === "measured" ? fact.value : fact?.kind)),
		[reply.usage.inputTokens, reply.usage.outputTokens],
	);
});

test("a put to an approved tag records the extension as its actor; anything else is refused", async (t) => {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	t.after(() => env.restore());
	const workspace = path.join(env.dir, "workspace");
	mkdirSync(workspace);
	const source = path.join(workspace, "draft.md");
	writeFileSync(source, "draft one\n");
	const backend = await openStoreBackend(workspace);
	await backend.getOrCreateTag("drafts");
	await backend.getOrCreateTag("refs");
	let granted: string[] | undefined;
	const host = createExtensionHostServices({ grants: () => granted });
	const put = (overrides: Partial<ExtensionServiceBinding> = {}, tag = "drafts") =>
		host.blobs?.(
			binding(workspace, overrides),
			{ op: "put", tag, blob: "a.md", sourcePath: source, note: "first pass" },
			live(),
		) ?? Promise.resolve();
	deepStrictEqual(Object.keys((await put()) as object).sort(), ["bytes", "sha256"]);
	const { records } = await readBlobHistory(backend, "drafts", "a.md");
	deepStrictEqual(
		records.map((record) => record.kind),
		["put"],
	);
	deepStrictEqual(records[0]?.producedBy, { actor: "extension", extensionId: "scribe", sessionId: "s1" });
	equal(records[0]?.note, "first pass");
	await rejects(put({}, "refs"), /'refs' is not approved for writing/u);
	await rejects(put({}, "secrets"), /'secrets' is not approved for writing/u);
	await rejects(put({ readOnly: () => true }), /read-only session/u);
	granted = ["refs"];
	await rejects(put(), /outside the tags this run granted/u);
	granted = undefined;
	// A read of an approved tag returns the bytes; a read tag is readable but never writable.
	const got = (await host.blobs?.(binding(workspace), { op: "get", tag: "drafts", blob: "a.md" }, live())) as {
		base64: string;
	};
	equal(Buffer.from(got.base64, "base64").toString(), "draft one\n");
	deepStrictEqual(await host.blobs?.(binding(workspace), { op: "stat", tag: "refs", blob: "none.md" }, live()), null);
	await rejects(
		host.blobs?.(binding(workspace), { op: "stat", tag: "secrets", blob: "x" }, live()) ?? Promise.resolve(),
		/not approved for reading/u,
	);
});

test("adding either service, raising the budget or adding a tag is envelope growth", () => {
	const envelope = (value: Record<string, unknown> | undefined) =>
		capabilityEnvelope(parseExtensionRuntimeV2({ api: 2, entrypoint: "extension.mjs", services: value }));
	const base = envelope(undefined);
	const both = envelope(services());
	deepStrictEqual(envelopeGrowth(base, both), [
		"may request completions from an operator-assigned model (1000 tokens a session, 200 a reply)",
		"reads store tags: refs",
		"writes store tags: drafts",
	]);
	deepStrictEqual(envelopeGrowth(both, both), []);
	deepStrictEqual(
		envelopeGrowth(
			both,
			envelope(
				services({
					model: { sessionTokens: 2000, maxOutputTokens: 400 },
					store: { read: ["refs", "notes"], write: ["drafts", "out"] },
				}),
			),
		),
		[
			"a larger model budget (2000 tokens a session, approved 1000)",
			"longer model replies (400 tokens, approved 200)",
			"reads store tags: notes",
			"writes store tags: out",
		],
	);
});

test("a bare alias, a program, a changed pin, a program's new key, a global key and the pane are envelope growth", () => {
	const program = (name: string, version: string, sha: string, env: string[]) => ({
		name,
		version,
		license: "MIT",
		homepage: "https://example.invalid",
		env,
		downloads: { "linux-x64": { url: "https://example.invalid/p", sha256: sha.repeat(64) } },
	});
	const envelope = (extra: Record<string, unknown>) =>
		capabilityEnvelope(
			parseExtensionRuntimeV2({
				api: 2,
				entrypoint: "extension.mjs",
				commands: [{ name: "play", description: "play" }],
				...extra,
			}),
		);
	const base = envelope({ binaries: [program("player", "1.0.0", "a", ["THEME"])] });
	const grown = envelope({
		commands: [{ name: "play", description: "play", alias: "tunes" }],
		binaries: [program("player", "1.0.0", "b", ["THEME", "VOLUME"]), program("helper", "2.0.0", "c", [])],
		keys: [{ key: "alt+m", action: "play", label: "Play" }],
		services: { pane: true },
		events: ["pane_changed"],
	});
	deepStrictEqual(envelopeGrowth(base, grown), [
		"claims bare commands: /tunes",
		"may open a pane below PanCode",
		"program player changed: 1.0.0 (approved 1.0.0)",
		"program player environment: VOLUME",
		"new program: helper 2.0.0",
		"new keys: alt+m:play",
		"new events: pane_changed",
	]);
	deepStrictEqual(envelopeGrowth(grown, grown), []);
	throws(() => envelope({ services: { pane: true } }), /needs a declared binary/u);
	throws(
		() => envelope({ binaries: [program("player", "1.0.0", "a", [])], events: ["pane_changed"] }),
		/declares no runtime.services.pane/u,
	);
});

const runtimeSource = `export default (api) => {
	api.handle("members", (_args, ctx) => ({ text: [typeof ctx.complete, typeof ctx.blobs].join(" ") }));
	api.handle("write", async (args, ctx) => {
		const reply = await ctx.complete({ messages: [{ role: "user", text: args }], maxOutputTokens: 50, temperature: 0.2 });
		const put = await ctx.blobs.put("drafts", "note.md", "draft.md");
		return { text: reply.text + " " + put.bytes };
	});
	api.handle("hang", async (_args, ctx) => {
		await ctx.complete({ messages: [{ role: "user", text: "wait" }] });
		return { text: "done" };
	});
	api.handle("leave", (_args, ctx) => {
		void ctx.complete({ messages: [{ role: "user", text: "left behind" }] }).catch(() => {});
		return { text: "left" };
	});
};
`;

/** Installs `scribe` for the user, with the services it declares, in a scratch home; returns the workspace. */
function installScribe(dir: string, declared: Record<string, unknown> | undefined): string {
	const root = path.join(dir, "source");
	const cwd = path.join(dir, "workspace");
	process.env.HOME = dir;
	mkdirSync(root);
	mkdirSync(cwd);
	writeFileSync(path.join(cwd, "draft.md"), "from the runtime\n");
	writeFileSync(
		path.join(root, "pancode-extension.json"),
		JSON.stringify({
			id: "scribe",
			version: "1.0.0",
			description: "Writes with a model",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				commands: ["members", "write", "hang", "leave"].map((name) => ({ name, description: name })),
				permissions: { fs: { read: ["workspace"] } },
				...(declared ? { services: declared } : {}),
			},
		}),
	);
	writeFileSync(path.join(root, "extension.mjs"), runtimeSource);
	ok(installExtension(root, { cwd, scope: "user" }).extension?.loadable);
	return cwd;
}

async function inWorkspace(t: { after(fn: () => unknown): void }, declared: Record<string, unknown> | undefined) {
	const env = await isolatePancodeEnv("pancode-ext-services-");
	const previous = process.cwd();
	const cleanup: Array<() => Promise<void>> = [];
	t.after(async () => {
		for (const step of cleanup.reverse()) await step();
		process.chdir(previous);
		env.restore();
	});
	const cwd = installScribe(env.dir, declared);
	process.chdir(cwd);
	return { cwd, cleanup };
}

function attended(serviceHost: ExtensionServiceHost): OperatorExtensions {
	return new OperatorExtensions({
		services: serviceHost,
		context: () => ({ workspace: process.cwd(), sessionId: "attended", mode: "interactive" }),
		isIdle: () => true,
		onlyId: "scribe",
	});
}

const invoke = (operator: OperatorExtensions, command: string, args = "", signal = live()) =>
	operator.invoke(extensionInvocation("scribe", command), args, [], signal);

test("a runtime that declares no services gets no service members", async (t) => {
	const { cleanup } = await inWorkspace(t, undefined);
	const operator = attended(createExtensionHostServices({}));
	cleanup.push(() => operator.dispose());
	equal((await operator.reload("startup")).status, "committed");
	equal((await invoke(operator, "members")).text, "undefined undefined");
});

test("the runtime's ending request and its disposal both abort a model call in flight", async (t) => {
	const { cleanup } = await inWorkspace(t, services());
	const aborted: string[] = [];
	let started!: () => void;
	const waiting = () =>
		new Promise<void>((resolve) => {
			started = resolve;
		});
	const serviceHost: ExtensionServiceHost = {
		complete: (_binding, request, signal) =>
			new Promise((_resolve, reject) => {
				started();
				signal.addEventListener("abort", () => {
					aborted.push(request.messages[0]?.text ?? "");
					reject(signal.reason);
				});
			}),
	};
	const operator = attended(serviceHost);
	cleanup.push(() => operator.dispose());
	equal((await operator.reload("startup")).status, "committed");
	let running = waiting();
	equal((await invoke(operator, "leave")).text, "left");
	await running;
	for (let spin = 0; spin < 50 && aborted.length === 0; spin++) await new Promise((resolve) => setTimeout(resolve, 20));
	deepStrictEqual(aborted, ["left behind"], "the request that made the call settled, so the call ended with it");
	running = waiting();
	const hung = rejects(invoke(operator, "hang"), /cancelled/u);
	await running;
	await operator.dispose();
	await hung;
	deepStrictEqual(aborted, ["left behind", "wait"], "disposal aborted the call in flight");
});

test("the noninteractive host completes and puts the same as the attended one", async (t) => {
	const { cwd, cleanup } = await inWorkspace(t, services());
	const { faux, providers } = fixtureRoutes();
	const backend = await openStoreBackend(cwd);
	await backend.getOrCreateTag("drafts");
	const assigned = assignExtensionServiceModel(
		providers,
		{ id: "scribe", target: "fixture", model: "chat" },
		{ cwd, scope: "user" },
	);
	ok(assigned.endpoint, JSON.stringify(assigned.diagnostics));
	const seen: Array<number | undefined> = [];
	faux.setResponses(
		["attended", "headless"].map((text) => (_context: unknown, options: { temperature?: number } | undefined) => {
			seen.push(options?.temperature);
			return answer(text);
		}),
	);

	const operator = attended(createExtensionHostServices({ providers }));
	cleanup.push(() => operator.dispose());
	equal((await operator.reload("startup")).status, "committed");
	equal((await invoke(operator, "write", "go")).text, "attended 17");
	await operator.dispose();

	const notices: string[] = [];
	const host = startExtensionHost({
		mode: "headless",
		list: (root) => listInstalledExtensions(root, { all: true }),
		runtimeHooks: createExtensionRuntimeHookBridge(),
		bus: createTelemetryHub(),
		chat: { isStreaming: () => false, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => "headless-session",
		targetId: () => "fixture",
		notify: (line) => notices.push(line),
		services: { providers },
	});
	cleanup.push(() => host.dispose());
	equal((await host.ready).status, "committed", notices.join("\n"));
	equal((await invoke(host.operator, "write", "go")).text, "headless 17");
	deepStrictEqual(seen, [0.2, 0.2], "both hosts passed the temperature through");
	const actors = (await readBlobHistory(backend, "drafts", "note.md")).records
		.filter((record) => record.kind === "put")
		.map((record) => record.producedBy)
		.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
	deepStrictEqual(actors, [
		{ actor: "extension", extensionId: "scribe", sessionId: "attended" },
		{ actor: "extension", extensionId: "scribe", sessionId: "headless-session" },
	]);
});

/**
 * The services a package's manifest unlocks beyond model calls and blobs.
 * `ctx.pane`: one pane per extension in the dock slot the View dock shares,
 * running only a declared binary, with taps and the global key classified by
 * one gate and every change reported to the package.
 */

const BINARY = "pancode-pane-fixture";

function paneBinary(): ExtensionBinaryDeclaration {
	return {
		name: BINARY,
		version: "1.0.0",
		license: "MIT",
		homepage: "https://example.invalid",
		env: ["FIXTURE_HOME"],
		downloads: {},
		documents: [],
	};
}

interface FakeMux {
	mux: MuxContract;
	opened: MuxOpenUtilityPaneRequest[];
	closed: string[];
	slot: { paneId: string; label: string; hidden: boolean } | null;
	exit(): void;
}

function fakeMux(options: { available?: boolean } = {}): FakeMux {
	const gone = new Set<(record: MuxPaneRecord) => void>();
	let next = 1;
	const fake: FakeMux = {
		opened: [],
		closed: [],
		slot: null,
		exit() {
			const slot = fake.slot;
			if (!slot) return;
			fake.slot = null;
			for (const handler of gone)
				handler({
					ref: { paneId: slot.paneId, tabId: "t", workspaceId: "w" },
					purpose: "utility",
					label: slot.label,
					openedAt: 0,
				});
		},
		mux: undefined as unknown as MuxContract,
	};
	fake.mux = {
		available: () => options.available !== false,
		detection: () => ({ reason: "not inside herdr" }),
		onPaneGone(handler: (record: MuxPaneRecord) => void) {
			gone.add(handler);
			return () => gone.delete(handler);
		},
		docks: () => (fake.slot ? [{ slot: "extension", paneId: fake.slot.paneId, hidden: fake.slot.hidden }] : []),
		dockVisibility: () => (fake.slot ? (fake.slot.hidden ? "hidden" : "visible") : "closed"),
		async openUtilityPane(request: MuxOpenUtilityPaneRequest) {
			fake.opened.push(request);
			const paneId = `p${next++}`;
			fake.slot = { paneId, label: request.label, hidden: request.dock?.hidden === true };
			return { paneId, tabId: "t", workspaceId: "w" };
		},
		async closePane(paneId: string) {
			fake.closed.push(paneId);
			if (fake.slot?.paneId === paneId) fake.exit();
			return true;
		},
		async hideDock() {
			if (fake.slot) fake.slot.hidden = true;
			return fake.slot !== null;
		},
		async showDock() {
			if (!fake.slot) return null;
			fake.slot.hidden = false;
			return { paneId: fake.slot.paneId, tabId: "t", workspaceId: "w" };
		},
		async focusSelf() {
			return true;
		},
	} as unknown as MuxContract;
	return fake;
}

describe("extension pane service", () => {
	let root: string;
	let previousData: string | undefined;
	const owner = (extensionId: string): ExtensionPaneOwner => ({
		extensionId,
		declaration: { binaries: [paneBinary()] },
		storeDir: path.join(root, "store", extensionId),
	});

	before(() => {
		root = mkdtempSync(path.join(tmpdir(), "pane-service-"));
		previousData = process.env.PANCODE_DATA_DIR;
		process.env.PANCODE_DATA_DIR = path.join(root, "data");
		for (const id of ["music", "other"]) {
			const dir = path.join(root, "data", "tools", "ext", id, BINARY, "1.0.0");
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, BINARY), "#!/bin/sh\n");
			chmodSync(path.join(dir, BINARY), 0o755);
			mkdirSync(path.join(root, "store", id), { recursive: true });
		}
	});
	after(() => {
		if (previousData === undefined) delete process.env.PANCODE_DATA_DIR;
		else process.env.PANCODE_DATA_DIR = previousData;
		rmSync(root, { recursive: true, force: true });
	});

	it("opens the declared binary in the shared dock slot, once, and reports each change", async () => {
		const fake = fakeMux();
		const changes: string[] = [];
		const host = createExtensionPaneHost({
			mux: () => fake.mux,
			press: () => undefined,
			changed: (id, change) => changes.push(`${id}:${change.state}:${change.reason}`),
		});
		const music = owner("music");
		const state = await host.call(music, "open", {
			binary: BINARY,
			args: ["--playlist", "pancode"],
			env: { FIXTURE_HOME: "home" },
			title: "music",
			rows: 18,
			share: 0.05,
		});
		strictEqual(state, "visible");
		strictEqual(fake.opened.length, 1);
		const request = fake.opened[0];
		deepStrictEqual(request?.argv.slice(1), ["--playlist", "pancode"]);
		strictEqual(path.basename(request?.argv[0] ?? ""), BINARY);
		strictEqual(request?.cwd, music.storeDir);
		deepStrictEqual(request?.env, { FIXTURE_HOME: "home" });
		deepStrictEqual(request?.dock, { slot: "extension", share: 0.05, minCells: 18 });
		strictEqual(await host.call(music, "open", { binary: BINARY }), "visible");
		strictEqual(fake.opened.length, 1);

		strictEqual(await host.call(music, "hide", {}), "hidden");
		strictEqual(await host.call(music, "state", {}), "hidden");
		strictEqual(await host.call(music, "reveal", {}), "visible");
		fake.exit();
		strictEqual(await host.call(music, "state", {}), "closed");
		deepStrictEqual(changes, [
			"music:visible:opened",
			"music:hidden:hidden",
			"music:visible:revealed",
			"music:closed:exited",
		]);
	});

	it("refuses what the manifest did not declare and anything outside the store", async () => {
		const host = createExtensionPaneHost({ mux: () => fakeMux().mux, press: () => undefined, changed: () => undefined });
		const music = owner("music");
		await rejects(host.call(music, "open", { binary: "sh" }), /pane binary 'sh' is not declared/u);
		await rejects(
			host.call(music, "open", { binary: BINARY, env: { LD_PRELOAD: "x" } }),
			/does not declare the environment key LD_PRELOAD/u,
		);
		await rejects(
			host.call(music, "open", { binary: BINARY, tap: { file: "../escape", action: "toggle" } }),
			/inside the extension's store/u,
		);
		const victim = path.join(root, "victim.txt");
		writeFileSync(victim, "keep-me");
		symlinkSync(victim, path.join(music.storeDir, "escape-link"));
		await rejects(
			host.call(music, "open", { binary: BINARY, tap: { file: "escape-link", action: "toggle" } }),
			/symbolic link/u,
		);
		strictEqual(readFileSync(victim, "utf8"), "keep-me");
		symlinkSync(path.join(root, "dangling-target"), path.join(music.storeDir, "dangling-link"));
		await rejects(
			host.call(music, "open", { binary: BINARY, tap: { file: "dangling-link", action: "toggle" } }),
			/symbolic link/u,
		);
		strictEqual(existsSync(path.join(root, "dangling-target")), false);
		await rejects(host.call(music, "open", { binary: BINARY, rows: 40 }), /rows must be a whole number from 1 to 24/u);
		const none = createExtensionPaneHost({
			mux: () => fakeMux({ available: false }).mux,
			press: () => undefined,
			changed: () => undefined,
		});
		await rejects(none.call(music, "open", { binary: BINARY }), /herdr panes are not available \(not inside herdr\)/u);
		const headless = createExtensionPaneHost({ mux: () => null, press: () => undefined, changed: () => undefined });
		await rejects(headless.call(music, "open", { binary: BINARY }), /no pane host/u);
	});

	it("takes the slot from the View dock and from another extension's pane", async () => {
		const fake = fakeMux();
		const changes: string[] = [];
		let viewClosed = 0;
		const host = createExtensionPaneHost({
			mux: () => fake.mux,
			press: () => undefined,
			changed: (id, change) => changes.push(`${id}:${change.state}:${change.reason}`),
			closeViewDock: async () => {
				viewClosed += 1;
				fake.slot = null;
				return true;
			},
		});
		fake.slot = { paneId: "viewer", label: "extension", hidden: false };
		await host.call(owner("music"), "open", { binary: BINARY });
		strictEqual(viewClosed, 1);
		await host.call(owner("other"), "open", { binary: BINARY });
		strictEqual(host.owns("other"), true);
		strictEqual(await host.call(owner("music"), "state", {}), "closed");
		deepStrictEqual(changes, ["music:visible:opened", "music:closed:replaced", "other:visible:opened"]);
		strictEqual(await host.yieldSlot(), true);
		strictEqual(fake.slot, null);
		await host.call(owner("music"), "open", { binary: BINARY });
		await host.release("music");
		deepStrictEqual(changes.slice(-3), ["other:closed:replaced", "music:visible:opened", "music:closed:closed"]);
	});

	it("presses the tap action from the pane's tap file and the global key through one double-tap gate", async () => {
		const fake = fakeMux();
		let clock = 0;
		const presses: string[] = [];
		const host = createExtensionPaneHost({
			mux: () => fake.mux,
			press: (id, action) => presses.push(`${id}:${action.id}:${action.source}:${action.key}`),
			changed: () => undefined,
			gate: createDockKeyGate({ now: () => clock }),
		});
		const music = owner("music");
		await host.call(music, "open", { binary: BINARY, tap: { file: "taps/pane", action: "toggle" } });
		appendFileSync(path.join(music.storeDir, "taps", "pane"), "tap\n");
		for (let wait = 0; wait < 40 && presses.length === 0; wait += 1) await new Promise((done) => setTimeout(done, 25));
		clock = 100;
		host.key("music", "toggle");
		clock = 200;
		host.key("music", "next");
		clock = 5000;
		host.key("music", "toggle");
		await new Promise((done) => setTimeout(done, 10));
		deepStrictEqual(presses, [
			"music:toggle:dock:tap",
			"music:toggle:key:double",
			"music:next:key:tap",
			"music:toggle:key:tap",
		]);
		strictEqual(host.owner(), "music");
		await host.dispose();
		strictEqual(host.owner(), null);
		strictEqual(fake.slot, null);
	});
});

describe("extension binaries service", () => {
	const NAME = "pancode-bin-fixture";
	const script = Buffer.from(`#!/bin/sh\nprintf '%s|%s|%s' "$FIXTURE_HOME" "$(pwd)" "$1"\n`);
	let root: string;
	let previousPath: string | undefined;
	let previousData: string | undefined;

	const caller = (parent = "command", readOnly = false): PackBinaryCaller => ({
		owner: { kind: "extension", id: "fixture", version: "1.0.0", digest: "", scope: "user" },
		sessionId: null,
		parent,
		readOnly,
	});

	function binary(sha256: string): ExtensionBinaryDeclaration {
		const platform = currentToolPlatform();
		return {
			...paneBinary(),
			name: NAME,
			downloads: platform ? { [platform]: { url: "https://example.invalid/fixture", sha256, archive: "raw" } } : {},
		};
	}

	before(() => {
		root = mkdtempSync(path.join(tmpdir(), "binary-service-"));
		previousPath = process.env.PATH;
		previousData = process.env.PANCODE_DATA_DIR;
		process.env.PANCODE_DATA_DIR = root;
	});
	after(() => {
		process.env.PATH = previousPath;
		if (previousData === undefined) delete process.env.PANCODE_DATA_DIR;
		else process.env.PANCODE_DATA_DIR = previousData;
		rmSync(root, { recursive: true, force: true });
	});

	it("installs only bytes matching the pinned sha256 and runs the pin in the store with declared keys", async () => {
		const wrong = await installPackBinaries("fixture", [binary("0".repeat(64))], {
			fetch: async () => script,
			mirror: null,
		});
		strictEqual(wrong[0]?.ok, false);
		strictEqual(/checksum mismatch/u.test(wrong[0]?.message ?? ""), true);

		const pinned = binary(sha256Hex(script));
		const missing = packBinaryPath("fixture", pinned);
		strictEqual("reason" in missing && /pancode hub install extension:fixture/u.test(missing.reason), true);
		strictEqual("reason" in missing && /pancode tools install/u.test(missing.reason), false);
		const [installed] = await installPackBinaries("fixture", [pinned], { fetch: async () => script, mirror: null });
		strictEqual(installed?.ok, true);
		strictEqual(resolvePackBinary("fixture", pinned).source, "vendored");

		const store = mkdtempSync(path.join(root, "store-"));
		const request = parsePackBinaryRun({ name: NAME, args: ["status"], env: { FIXTURE_HOME: "home" } }, [pinned]);
		const result = await runPackBinary("fixture", [pinned], request, store, caller());
		deepStrictEqual(result, { exitCode: 0, timedOut: false, stdout: `home|${store}|status`, stderr: "" });

		await rejects(
			runPackBinary("fixture", [pinned], request, store, caller("observe")),
			/ctx.binaries runs only from a command, an action or a tool call, not from an event or timer handler/u,
		);
		await rejects(runPackBinary("fixture", [pinned], request, store, caller("tool", true)), /read-only turn/u);
		const runs = recentPackageActivity("fixture").filter((entry) => entry.kind === "binary:run");
		deepStrictEqual(
			runs.slice(-3).map((entry) => [entry.outcome, entry.details?.parent, entry.details?.args]),
			[
				["ok", "command", ["status"]],
				["refused", "observe", ["status"]],
				["refused", "tool", ["status"]],
			],
		);

		removePackBinaries("fixture");
		strictEqual(resolvePackBinary("fixture", pinned).source, "none");
	});

	it("never runs a same-named program on PATH in place of the pin", () => {
		const bin = path.join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(path.join(bin, NAME), `#!/bin/sh\necho "${NAME} 2.0.0"\n`);
		chmodSync(path.join(bin, NAME), 0o755);
		process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
		const shadowed = resolvePackBinary("fixture", binary("0".repeat(64)));
		strictEqual(shadowed.source, "none");
		strictEqual(shadowed.binaryPath, null);
		const missing = packBinaryPath("fixture", binary("0".repeat(64)));
		strictEqual("reason" in missing && /PATH/u.test(missing.reason), false);
	});

	it("refuses an undeclared binary, an undeclared or reserved environment key, and runaway arguments", () => {
		const pinned = binary("0".repeat(64));
		const loader = { ...pinned, env: ["FIXTURE_HOME", "LD_PRELOAD"] };
		throws(() => parsePackBinaryRun({ name: "sh" }, [pinned]), /binary 'sh' is not declared/u);
		throws(() => parsePackBinaryRun({ name: NAME, env: { OTHER: "x" } }, [pinned]), /environment key OTHER/u);
		throws(() => parsePackBinaryRun({ name: NAME, env: { LD_PRELOAD: "x" } }, [loader]), /environment key LD_PRELOAD/u);
		throws(() => parsePackBinaryRun({ name: NAME, args: Array(65).fill("a") }, [pinned]), /at most 64 strings/u);
		throws(() => parsePackBinaryRun({ name: NAME, timeoutMs: 60_000 }, [pinned]), /from 1 to 10000/u);
	});

	it("follows the installed copies: an install downloads the pin and removing the last copy deletes it", async (t) => {
		const platform = currentToolPlatform();
		if (!platform) return t.skip("no pinned platform here");
		const env = await isolatePancodeEnv("pancode-ext-binaries-");
		t.after(() => env.restore());
		const source = path.join(env.dir, "player");
		const cwd = path.join(env.dir, "workspace");
		mkdirSync(source);
		mkdirSync(cwd);
		writeFileSync(
			path.join(source, "pancode-extension.json"),
			JSON.stringify({
				id: "player",
				version: "1.0.0",
				description: "Plays",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					commands: [{ name: "play", description: "play", alias: "tunes" }],
					binaries: [
						{
							name: NAME,
							version: "1.0.0",
							license: "MIT",
							homepage: "https://example.invalid",
							downloads: { [platform]: { url: "https://example.invalid/fixture", sha256: sha256Hex(script) } },
						},
					],
				},
			}),
		);
		writeFileSync(
			path.join(source, "extension.mjs"),
			`export default (api) => api.handle("play", () => ({ text: "ok" }));\n`,
		);
		ok(installExtension(source, { cwd, scope: "user" }).extension?.loadable);
		strictEqual(installedExtensionClaims("tunes", cwd), true);

		const store = path.join(env.dir, "tools");
		const orphan = path.join(store, "ext", "player", "stale-bin", "1.0.0");
		mkdirSync(orphan, { recursive: true });
		deepStrictEqual(await syncPackBinaries("player", cwd, { root: store, fetch: async () => script, mirror: null }), []);
		strictEqual(existsSync(path.join(store, "ext", "player", NAME)), true);
		strictEqual(existsSync(path.join(store, "ext", "player", "stale-bin")), false);
		ok(removeExtension("player", { cwd, scope: "user" }).removed);
		deepStrictEqual(await syncPackBinaries("player", cwd, { root: store }), []);
		strictEqual(existsSync(path.join(store, "ext", "player")), false);
	});

	it("refuses write-class tools and read-only runtimes for packages declaring binaries, and tracks member growth", () => {
		const base = {
			api: 2,
			entrypoint: "extension.mjs",
			permissions: { fs: { write: ["out"] } },
			binaries: [
				{
					name: NAME,
					version: "1.0.0",
					license: "MIT",
					homepage: "https://example.invalid",
					downloads: {
						"linux-x64": { url: "https://example.invalid/a.tgz", sha256: "a".repeat(64), archive: "tar.gz", member: "bin/a" },
					},
				},
			],
		};
		throws(
			() =>
				parseExtensionRuntimeV2({
					...base,
					tools: [{ name: "mutate", description: "mutate", inputSchema: { type: "object" }, actionClass: "write" }],
				}),
			/no exec or binaries/u,
		);
		const parsed = parseExtensionRuntimeV2(base);
		throws(
			() =>
				readOnlyRuntimeDeclaration(parsed, {
					available: true,
					backend: "bwrap",
					executable: "/usr/bin/bwrap",
					reason: null,
				}),
			/external programs that run outside the sandbox/u,
		);
		const envA = capabilityEnvelope(parsed);
		const envMember = capabilityEnvelope(
			parseExtensionRuntimeV2({
				...base,
				binaries: [
					{
						...base.binaries[0],
						downloads: {
							"linux-x64": {
								url: "https://example.invalid/a.tgz",
								sha256: "a".repeat(64),
								archive: "tar.gz",
								member: "bin/evil",
							},
						},
					},
				],
			}),
		);
		ok(envelopeGrowth(envA, envMember).some((line) => /changed/u.test(line)));
	});
});

describe("extension keys and aliases", () => {
	it("binds an Alt+letter key once and refuses taken, shared and malformed keys", () => {
		const { bound, refused } = resolveExtensionKeys(
			[
				{ extensionId: "music", keys: [{ key: "Alt+A", action: "toggle", label: "Music" }] },
				{
					extensionId: "radio",
					keys: [
						{ key: "alt+r", action: "play", label: "Radio" },
						{ key: "alt+q", action: "quit", label: "Quit" },
					],
				},
				{
					extensionId: "clock",
					keys: [
						{ key: "alt+r", action: "show", label: "Clock" },
						{ key: "ctrl+k", action: "show", label: "Clock" },
						{ key: "alt+b", action: "show", label: "Clock" },
					],
				},
			],
			new Map([["alt+q", "pancode.app.quit"]]),
			new Map([["b", "the extension workspace"]]),
		);
		deepStrictEqual(bound, [{ extensionId: "music", key: "alt+a", letter: "a", action: "toggle", label: "Music" }]);
		deepStrictEqual(
			refused.map((entry) => `${entry.extensionId} ${entry.reason}`),
			[
				"radio alt+r is also claimed by clock",
				"radio alt+q already runs pancode.app.quit",
				"clock alt+r is also claimed by radio",
				"clock ctrl+k is not an Alt+letter key",
			],
		);
	});

	it("gives a bare alias to one extension and refuses one a built-in, a prompt or another alias holds", () => {
		const row = (extensionId: string, invocation: string, command: string): ExtensionCommandRow => ({
			origin: "extension",
			invocation,
			extensionId,
			scope: "user",
			description: "",
			generation: 1,
			available: true,
			alias: { command },
		});
		const settled = resolveExtensionAliases(
			[
				row("music", "music", "music"),
				row("shadow", "model", "pick"),
				row("notes", "review", "review"),
				row("a", "twin", "go"),
				row("b", "twin", "go"),
			],
			new Set(["model"]),
			["review"],
		);
		deepStrictEqual(
			settled.map((entry) => `${entry.invocation} ${entry.available} ${entry.reason ?? ""}`.trim()),
			[
				"music true",
				"model false /model is a built-in command; use /ext:shadow:pick",
				"review false /review belongs to an existing prompt template; use /ext:notes:review",
				"twin false /twin is also claimed by b; use /ext:a:go",
				"twin false /twin is also claimed by a; use /ext:b:go",
			],
		);
		const transientRefused = resolveExtensionAliases(
			[{ ...row("notes", "review", "review"), available: false, transient: true }],
			new Set(),
			["Review"],
		);
		strictEqual(transientRefused[0]?.transient, undefined);
		const stubRuntime = { commands: () => transientRefused } as unknown as OperatorExtensions;
		strictEqual(resolveExtensionLine("/review", "review", stubRuntime, [{ name: "Review" }]), null);
	});

	it("keeps built-in default keys reserved even when rebound and starts deferred extensions on key press", async (t) => {
		const manager = createKeybindingManagerForTesting({ "pancode.output.cycle": "alt+z", "pancode.leader": [] });
		const settled = settleExtensionKeys(
			[
				{
					extensionId: "music",
					keys: [
						{ key: "alt+o", action: "a", label: "A" },
						{ key: "alt+z", action: "b", label: "B" },
					],
				},
			],
			manager,
		);
		strictEqual(settled.bound.length, 0);
		strictEqual(settled.refused.length, 2);

		const env = await isolatePancodeEnv("pancode-ext-key-ondemand-");
		const previous = process.cwd();
		t.after(() => {
			process.chdir(previous);
			env.restore();
		});
		const source = path.join(env.dir, "keyed");
		const cwd = path.join(env.dir, "workspace");
		mkdirSync(source);
		mkdirSync(cwd);
		writeFileSync(
			path.join(source, "pancode-extension.json"),
			JSON.stringify({
				id: "keyed",
				version: "1.0.0",
				description: "Key-driven on-demand extension",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					commands: [{ name: "ping", description: "ping" }],
					keys: [{ key: "alt+k", action: "toggle", label: "Keyed" }],
				},
			}),
		);
		writeFileSync(
			path.join(source, "extension.mjs"),
			`export default (api) => { api.handle("ping", () => ({ text: "ok" })); api.action("toggle", (e) => ({ text: e.source + ":" + e.key })); };\n`,
		);
		ok(installExtension(source, { cwd, scope: "user" }).extension?.loadable);
		process.chdir(cwd);
		const operator = new OperatorExtensions({
			context: () => ({ workspace: cwd, sessionId: "s1", mode: "interactive" }),
			isIdle: () => true,
		});
		t.after(() => operator.dispose());
		equal((await operator.reload("startup")).status, "committed");
		equal(operator.entries()[0]?.state, "inactive");
		const out = await operator.action("keyed", { id: "toggle", source: "key", key: "tap" });
		equal(out.text, "key:tap");
		equal(operator.entries()[0]?.state, "ready");
	});
});
