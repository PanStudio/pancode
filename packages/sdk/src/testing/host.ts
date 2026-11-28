// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
	ExtensionBlobs,
	ExtensionContextV2,
	ExtensionFactoryV2,
	ExtensionKeyValue,
	ExtensionOutputV2,
} from "../extension/public-api-v2.js";
import { resolveExtensionEntrypoint } from "../pack/command-schema.js";
import { createMemoryKeyValueHost } from "../pack/key-value.js";
import type { ExtensionRuntimeDeclarationV2 } from "../pack/manifest-v2.js";
import {
	parseExtensionBlobRequest,
	parseExtensionCompletion,
	parseExtensionCompletionRequest,
	parseExtensionHookResult,
	parseExtensionOutputV2,
	parseExtensionToolResult,
	parseInterviewNext,
} from "../pack/runtime-output-v2.js";
import { RUNTIME_LIMITS } from "../pack/runtime-schema.js";
import { RUNTIME_V2_LIMITS } from "../pack/runtime-schema-v2.js";
import { loadJsonManifest } from "./manifest.js";
import { createRuntimeRegistration } from "./registration.js";
import type { ExtensionTestHost, ExtensionTestOptions, ExtensionTestServices } from "./test-api.js";
import { createTestClock } from "./test-clock.js";

/** Match the runtime's JSON IPC, including copy semantics and refusal of unserializable values. */
function wire<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * The fake model and store a test supplies, behind the checks PanCode makes: only what the manifest declares
 * appears on the context, and each request is validated against the declaration before the fake sees it.
 */
function testServices(
	declaration: ExtensionRuntimeDeclarationV2,
	options: ExtensionTestOptions,
): Pick<ExtensionContextV2, "complete" | "blobs"> {
	const model = declaration.services?.model;
	const storeTags = declaration.services?.store;
	const missing = (what: string): Error => new Error(`the test host was given no ${what} fake`);
	const fakes = options.blobs;
	const blobs = (request: unknown): ExtensionBlobs => {
		const parsed = storeTags ? parseExtensionBlobRequest(wire(request), storeTags) : undefined;
		if (!parsed || !fakes) throw missing("blobs");
		return fakes;
	};
	return {
		...(model
			? {
					complete: async (request) => {
						const parsed = parseExtensionCompletionRequest(wire(request), model);
						if (!options.complete) throw missing("complete");
						return parseExtensionCompletion(wire(await options.complete(parsed)));
					},
				}
			: {}),
		...(storeTags
			? {
					blobs: Object.freeze<ExtensionBlobs>({
						list: async (tag, opts) => wire(await blobs({ op: "list", tag, ...opts }).list(tag, opts)),
						stat: async (tag, blob) => wire(await blobs({ op: "stat", tag, blob }).stat(tag, blob)),
						get: async (tag, blob) => {
							const bytes = await blobs({ op: "get", tag, blob }).get(tag, blob);
							if (bytes !== null && bytes.byteLength > RUNTIME_V2_LIMITS.blobGetBytes)
								throw new Error(`${tag}:${blob} is larger than ${RUNTIME_V2_LIMITS.blobGetBytes} bytes`);
							return bytes === null ? null : new Uint8Array(bytes);
						},
						put: async (tag, blob, sourcePath, opts) =>
							wire(await blobs({ op: "put", tag, blob, sourcePath, ...opts }).put(tag, blob, sourcePath, opts)),
					}),
				}
			: {}),
	};
}

/**
 * Loads a package's api 2 runtime in this process and drives it as PanCode
 * would: JSON copies across the boundary, declared deadlines, the runtime's
 * output validators, and a clock the test advances.
 */
export async function createExtensionTestHost(
	root: string,
	options: ExtensionTestOptions = {},
	services: ExtensionTestServices = {},
): Promise<ExtensionTestHost> {
	const canonical = realpathSync(root);
	const { id: extensionId, runtime: declaration } = (services.loadManifest ?? loadJsonManifest)(canonical);
	const hookHost = services.isBuiltinTool !== undefined ? { isBuiltinTool: services.isBuiltinTool } : {};
	const values = Object.fromEntries(declaration.config.map((field) => [field.key, field.default]));
	for (const [key, value] of Object.entries(options.options ?? {})) {
		const field = declaration.config.find((entry) => entry.key === key);
		if (
			!field ||
			typeof value !== field.type ||
			(typeof value === "number" && !Number.isFinite(value)) ||
			(field.options && !field.options.includes(String(value)))
		)
			throw new Error(`invalid config option '${key}'`);
		values[key] = value;
	}
	const snapshot = {
		plugin: wire(options.plugin ?? null),
		workspace: realpathSync(options.workspace ?? canonical),
		sessionId: options.sessionId === undefined ? "test-session" : options.sessionId,
		generation: 1,
		mode: "interactive" as const,
		activeWorkspace: null as string | null,
		pancodeVersion: "0.0.0-test",
	};
	const memory = (services.keyValue ?? createMemoryKeyValueHost)();
	let disposed = false;
	const controllers = new Set<AbortController>();
	const keyValue = (scope: "state" | "store"): ExtensionKeyValue => {
		const guard = (...keys: unknown[]): void => {
			if (disposed) throw new Error("runtime is disposing");
			if (!(scope === "state" ? declaration.state.session : declaration.state.store))
				throw new Error(`runtime did not declare ${scope}`);
			for (const key of keys)
				if (typeof key !== "string" || key.length === 0 || key.length > 200) throw new Error("invalid key");
		};
		return Object.freeze({
			async get<T = unknown>(key: string) {
				guard(key);
				return wire(memory.get(scope, key)) as { value: T | undefined; version: number };
			},
			async set(key: string, value: unknown, opts?: { ifVersion?: number }) {
				guard(key);
				if (opts?.ifVersion !== undefined && !Number.isInteger(opts.ifVersion)) throw new Error("invalid version");
				return memory.set(scope, key, wire(value), opts?.ifVersion);
			},
			async delete(key: string) {
				guard(key);
				memory.delete(scope, key);
			},
			async keys() {
				guard();
				return memory.keys(scope);
			},
		});
	};
	const state = keyValue("state"),
		store = keyValue("store");
	const serviceFakes = testServices(declaration, options);
	const registration = (services.register ?? createRuntimeRegistration)(declaration);
	const clock = createTestClock();
	try {
		const url = pathToFileURL(resolveExtensionEntrypoint(canonical, declaration.entrypoint));
		url.searchParams.set("pancode-test-instance", randomUUID());
		await clock.run(async () => {
			const module = (await import(url.href)) as { default?: ExtensionFactoryV2 };
			if (typeof module.default !== "function") throw new Error("runtime must export a default factory");
			await module.default(registration.api);
		});
		registration.finish();
	} catch (error) {
		disposed = true;
		clock.dispose();
		await Promise.allSettled(registration.disposers.map((handler) => handler("startup-failure")));
		throw error;
	}
	const request = async <I, O>(
		kind: string,
		handler: ((input: I, ctx: ExtensionContextV2) => unknown) | undefined,
		input: I,
		timeoutMs: number,
		parse: (value: unknown) => O,
	): Promise<O> => {
		if (disposed) throw new Error("runtime not active");
		if (!handler) throw new Error(`no handler for ${kind}`);
		if (controllers.size >= RUNTIME_V2_LIMITS.concurrentRequests) throw new Error("runtime is busy");
		const controller = new AbortController();
		controllers.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const context: ExtensionContextV2 = Object.freeze({
			snapshot: Object.freeze({ ...snapshot }),
			requestId: randomUUID(),
			signal: controller.signal,
			options: Object.freeze({ ...values }),
			state,
			store,
			...serviceFakes,
		});
		try {
			const abandoned = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener(
					"abort",
					() =>
						reject(
							disposed
								? new Error("runtime disposed")
								: (services.timeoutError?.(kind) ?? new Error(`extension ${kind} timed out`)),
						),
					{ once: true },
				);
				timer = setTimeout(() => controller.abort(), timeoutMs);
			});
			const output = await Promise.race([
				clock.run(() =>
					Promise.resolve().then(() => {
						const copied = wire(input);
						return handler(kind === "command" || kind === "tool" ? copied : Object.freeze(copied), context);
					}),
				),
				abandoned,
			]);
			return parse(wire(output ?? null));
		} finally {
			if (timer) clearTimeout(timer);
			controllers.delete(controller);
		}
	};
	const output = (value: unknown, origin: "command" | "action"): ExtensionOutputV2 => {
		const parsed = parseExtensionOutputV2(value, declaration, origin);
		if (parsed.workspace) snapshot.activeWorkspace = "enter" in parsed.workspace ? parsed.workspace.enter : null;
		return parsed;
	};
	let nextTick = declaration.tickMs ?? Infinity;
	let stop: Promise<void> | undefined;
	const host: ExtensionTestHost = {
		command(name, args = "") {
			if (Buffer.byteLength(args) > RUNTIME_LIMITS.argumentBytes)
				return Promise.reject(new Error("extension arguments exceed 16 KiB"));
			return request(
				"command",
				registration.commands.get(name),
				args,
				declaration.commands.find((entry) => entry.name === name)?.timeoutMs ?? RUNTIME_LIMITS.commandMs,
				(value) => output(value, "command"),
			);
		},
		observe(event) {
			// The real host moves the runtime's snapshot before it delivers a workspace event.
			if (event.event === "workspace_enter") snapshot.activeWorkspace = event.workspace;
			else if (event.event === "workspace_leave") snapshot.activeWorkspace = null;
			return request(
				"observe",
				registration.observers.get(event.event),
				event,
				RUNTIME_V2_LIMITS.observationMs,
				(value) => (value === null ? undefined : parseExtensionOutputV2(value, declaration, "observation")),
			);
		},
		hook(event, opts = {}) {
			return request(
				"hook",
				registration.hooks.get(event.point),
				event,
				opts.timeoutMs ??
					declaration.hooks.find((entry) => entry.on === event.point)?.timeoutMs ??
					RUNTIME_V2_LIMITS.hookMs,
				(value) => parseExtensionHookResult(value, declaration, event.point, extensionId, hookHost),
			);
		},
		tool(name, input) {
			return request(
				"tool",
				registration.tools.get(name),
				input,
				declaration.tools.find((entry) => entry.name === name)?.timeoutMs ?? RUNTIME_V2_LIMITS.toolMs,
				(value) => parseExtensionToolResult(value, declaration),
			);
		},
		action(id, key) {
			return request(
				"action",
				registration.actions.get(id),
				{ id, source: "panel", ...(key === undefined ? {} : { key }) },
				RUNTIME_V2_LIMITS.observationMs,
				(value) => output(value, "action"),
			);
		},
		interview(answer) {
			return request(
				"interview",
				registration.interviews.get(answer.id),
				answer,
				RUNTIME_V2_LIMITS.observationMs,
				(value) => parseInterviewNext(value, declaration),
			);
		},
		leave() {
			const workspace = snapshot.activeWorkspace;
			if (workspace === null) return Promise.reject(new Error("no workspace is active"));
			return host.observe({ event: "workspace_leave", workspace });
		},
		tick() {
			if (declaration.tickMs === undefined) return Promise.reject(new Error("runtime declares no tick"));
			return host.observe({ event: "tick", intervalMs: declaration.tickMs });
		},
		state,
		store,
		get now() {
			return clock.now;
		},
		async advance(ms) {
			if (disposed) throw new Error("runtime not active");
			if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(clock.now + ms))
				throw new Error("advance requires nonnegative safe-integer milliseconds");
			const until = clock.now + ms;
			const outputs: Array<ExtensionOutputV2 | undefined> = [];
			while (nextTick <= until) {
				clock.now = nextTick;
				nextTick += declaration.tickMs ?? Infinity;
				outputs.push(await host.tick());
			}
			clock.now = until;
			return outputs;
		},
		dispose() {
			if (stop) return stop;
			disposed = true;
			for (const controller of controllers) controller.abort();
			stop = (async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						clock.run(() =>
							Promise.allSettled(registration.disposers.map((handler) => Promise.resolve().then(() => handler("disposed")))),
						),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, RUNTIME_LIMITS.disposeMs);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
					clock.dispose();
				}
			})();
			return stop;
		},
	};
	return host;
}
