// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionCompletionRequest } from "@pancode/sdk/extension";
import { capabilityEnvelope, envelopeGrowth, parseExtensionRuntimeV2 } from "@pancode/sdk/pack";
import { readBlobHistory } from "@pancode/store";
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
import { extensionInvocation } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { modelEndpointKey } from "../../src/domains/providers/index.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { startExtensionHost } from "../../src/entry/extension-host.js";
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
