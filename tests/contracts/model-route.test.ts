// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * D14 step 1: `safety.workerIsolation: process` keeps a native worker's provider credential on the host. The worker
 * gets a per-launch surrogate and a dispatcher that sends its model origin to a host route; the route admits only that
 * surrogate, swaps in the real credential, and relays bytes (SSE, WebSocket) unchanged.
 */
import { deepEqual, equal, match, ok, rejects } from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { codexAccountScope } from "../../src/core/codex-account.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sandboxAvailability, sandboxNetworkIsolation } from "../../src/core/sandbox/availability.js";
import { createModelRoute, type ModelRoute, modelRouteSurrogate } from "../../src/core/sandbox/egress/model-route.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { planIsolatedWorkerLaunch, serveIsolatedWorker } from "../../src/core/sandbox/worker-isolation.js";
import { pancodeConfigPath } from "../../src/core/xdg.js";
import { workerIsolationRefusal } from "../../src/domains/dispatch/model-route-binding.js";
import type { SpawnedWorker, SpawnOptions } from "../../src/domains/dispatch/worker-spawn.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { parseWorkerSpec } from "../../src/lib/worker-wire/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const REAL_KEY = "sk-real-provider-key";

interface Upstream {
	origin: string;
	requests: http.IncomingMessage[];
	server: http.Server;
	close(): Promise<void>;
}

async function startUpstream(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Upstream> {
	const requests: http.IncomingMessage[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const server = http.createServer((req, res) => {
		requests.push(req);
		handler(req, res);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		server,
		close: () =>
			new Promise((resolve) => {
				// Upgraded sockets are no longer the HTTP server's to close.
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

async function serveRoute(route: ModelRoute): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	route.serve(listener);
	return (listener.address() as AddressInfo).port;
}

function call(
	port: number,
	options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "POST",
				path: options.path ?? "/v1/responses",
				headers: options.headers,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

function jwt(payload: unknown): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256" })}.${part(payload)}.sig`;
}

describe("model route (host side)", () => {
	let upstream: Upstream | null = null;
	let route: ModelRoute | null = null;
	afterEach(async () => {
		route?.close();
		route = null;
		await upstream?.close();
		upstream = null;
	});

	it("refuses a wrong or missing surrogate, an absolute-form request and CONNECT without dialing", async () => {
		upstream = await startUpstream((_req, res) => res.end("reached"));
		route = createModelRoute({
			origin: upstream.origin,
			surrogate: "pancode-route-right",
			resolve: async () => ({ apiKey: REAL_KEY }),
		});
		const port = await serveRoute(route);
		const wrong = await call(port, { headers: { authorization: "Bearer pancode-route-wrong" } });
		equal(wrong.status, 401);
		match(wrong.body, /credential mismatch/u);
		equal((await call(port, { headers: {} })).status, 401);
		const absolute = await call(port, {
			path: "http://evil.example/steal",
			headers: { authorization: "Bearer pancode-route-right" },
		});
		equal(absolute.status, 421);
		const rebound = await call(port, { headers: { host: "evil.example", authorization: "Bearer pancode-route-right" } });
		equal(rebound.status, 421, "a browser reaching loopback through a rebound name is not the worker");
		const connectStatus = await new Promise<string>((resolve) => {
			const socket = connect(port, "127.0.0.1", () =>
				socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"),
			);
			socket.setEncoding("utf8");
			socket.once("data", (chunk: string) => {
				resolve(chunk.split("\r\n")[0] ?? "");
				socket.destroy();
			});
		});
		match(connectStatus, /^HTTP\/1\.1 405/u);
		equal(upstream.requests.length, 0, "nothing reached the provider");
		ok(route.receipts().every((receipt) => receipt.refused !== undefined && receipt.status === 0));
	});

	it("swaps the surrogate for the real key in the same header and scheme, strips cookies, adds auth headers", async () => {
		upstream = await startUpstream((req, res) => {
			res.writeHead(200, { "content-type": "application/json", "x-upstream": "1" });
			req.pipe(res);
		});
		route = createModelRoute({
			origin: upstream.origin,
			surrogate: "pancode-route-s",
			resolve: async () => ({ apiKey: REAL_KEY, headers: { "X-Org": "org-1" } }),
		});
		const port = await serveRoute(route);
		const bearer = await call(port, {
			path: "/v1/responses?stream=true",
			headers: {
				authorization: "Bearer pancode-route-s",
				cookie: "a=b",
				"x-org": "worker",
				"content-type": "application/json",
			},
			body: '{"model":"m"}',
		});
		equal(bearer.status, 200);
		equal(bearer.body, '{"model":"m"}');
		equal(bearer.headers["x-upstream"], "1");
		const first = upstream.requests[0];
		ok(first);
		equal(first.url, "/v1/responses?stream=true", "the path and query reach the origin unchanged");
		equal(first.headers.authorization, `Bearer ${REAL_KEY}`);
		equal(first.headers.cookie, undefined);
		equal(first.headers["x-org"], "org-1", "the target's auth header wins over the worker's");
		equal(first.headers.host, new URL(upstream.origin).host);
		const xApiKey = await call(port, { headers: { "x-api-key": "pancode-route-s" }, body: "{}" });
		equal(xApiKey.status, 200);
		equal(upstream.requests[1]?.headers["x-api-key"], REAL_KEY);
		equal(upstream.requests[1]?.headers.authorization, undefined);
		deepEqual(
			route.receipts().map((receipt) => [receipt.method, receipt.path, receipt.status]),
			[
				["POST", "/v1/responses", 200],
				["POST", "/v1/responses", 200],
			],
		);
	});

	it("streams SSE as it arrives and closes the upstream request when the worker aborts", async () => {
		let upstreamClosed: () => void = () => {};
		const closed = new Promise<void>((resolve) => {
			upstreamClosed = resolve;
		});
		upstream = await startUpstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: first\n\n");
			res.on("close", () => upstreamClosed());
		});
		route = createModelRoute({ origin: upstream.origin, surrogate: "s-1", resolve: async () => ({ apiKey: REAL_KEY }) });
		const port = await serveRoute(route);
		const firstChunk = await new Promise<string>((resolve, reject) => {
			const req = http.request(
				{ host: "127.0.0.1", port, method: "POST", path: "/v1/stream", headers: { authorization: "Bearer s-1" } },
				(res) => {
					res.setEncoding("utf8");
					res.once("data", (chunk: string) => {
						resolve(chunk);
						req.destroy();
					});
				},
			);
			req.on("error", () => {});
			req.once("error", reject);
			req.end("{}");
		});
		equal(firstChunk, "data: first\n\n", "the first event arrives while the upstream is still open");
		await closed;
	});

	it("re-resolves after a rejection and closes every listener on close", async () => {
		upstream = await startUpstream((_req, res) => res.end("ok"));
		const rejected: Array<string | undefined> = [];
		let key = "key-1";
		route = createModelRoute({
			origin: upstream.origin,
			surrogate: "s-2",
			resolve: async (rejectedApiKey) => {
				rejected.push(rejectedApiKey);
				if (rejectedApiKey !== undefined) key = "key-2";
				return { apiKey: key };
			},
		});
		const port = await serveRoute(route);
		await call(port, { headers: { authorization: "Bearer s-2" }, body: "{}" });
		equal(await route.refresh(), true);
		await call(port, { headers: { authorization: "Bearer s-2" }, body: "{}" });
		deepEqual(rejected, [undefined, "key-1", undefined]);
		equal(upstream.requests[1]?.headers.authorization, "Bearer key-2");
		route.close();
		await rejects(call(port, { headers: { authorization: "Bearer s-2" } }), /ECONNREFUSED|ECONNRESET|socket hang up/u);
	});

	it("answers 401 with the reason when no credential resolves, and 502 when the origin is down", async () => {
		const gone = createServer();
		await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
		const down = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
		await new Promise<void>((resolve) => gone.close(() => resolve()));
		route = createModelRoute({
			origin: down,
			surrogate: "s-3",
			resolve: async () => {
				throw new Error("not signed in to openai-codex; run /login openai-codex");
			},
		});
		const port = await serveRoute(route);
		const noKey = await call(port, { headers: { authorization: "Bearer s-3" }, body: "{}" });
		equal(noKey.status, 401);
		match(noKey.body, /run \/login openai-codex/u);
		route.close();
		route = createModelRoute({
			origin: down,
			surrogate: "s-4",
			resolve: async () => ({ apiKey: REAL_KEY }),
		});
		const unreachable = await call(await serveRoute(route), { headers: { authorization: "Bearer s-4" }, body: "{}" });
		equal(unreachable.status, 502);
		match(unreachable.body, /unreachable/u);
	});
});

describe("model route (worker side)", () => {
	it("sends fetch and the WebSocket handshake for the admitted origin through the route, path unchanged", async () => {
		const upgrades: http.IncomingMessage[] = [];
		const upstream = await startUpstream((req, res) => res.end(`plain ${req.url} ${req.headers.authorization}`));
		upstream.server.on("upgrade", (req: http.IncomingMessage, socket) => {
			upgrades.push(req);
			const accept = createHash("sha1")
				.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			socket.write(Buffer.from([0x81, 0x05, ...Buffer.from("hello")]));
		});
		const route = createModelRoute({
			origin: upstream.origin,
			surrogate: "s-ws",
			resolve: async () => ({ apiKey: REAL_KEY }),
		});
		const port = await serveRoute(route);
		const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "model-route-client-"));
		const script = join(dir, "client.mts");
		const clientModule = new URL("../../src/core/sandbox/egress/model-route-client.ts", import.meta.url).pathname;
		writeFileSync(
			script,
			`import { installModelRouteDispatcher } from ${JSON.stringify(clientModule)};
import { WebSocket } from ${JSON.stringify(import.meta.resolve("undici"))};
await installModelRouteDispatcher({ origin: ${JSON.stringify(upstream.origin)}, route: "http://127.0.0.1:${port}", surrogate: "s-ws" });
const plain = await (await fetch(${JSON.stringify(`${upstream.origin}/backend-api/codex/models?x=1`)}, { headers: { authorization: "Bearer s-ws" } })).text();
const message = await new Promise((resolve, reject) => {
	const socket = new WebSocket(${JSON.stringify(`${upstream.origin.replace("http", "ws")}/backend-api/codex/responses`)}, { headers: { authorization: "Bearer s-ws" } });
	socket.addEventListener("message", (event) => { resolve(String(event.data)); socket.close(); });
	socket.addEventListener("error", (event) => reject(new Error(String(event.message ?? "ws error"))));
});
console.log(JSON.stringify({ plain, message }));
process.exit(0);
`,
		);
		try {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					process.execPath,
					["--import", "tsx", script],
					{ cwd: process.cwd(), timeout: 30_000 },
					(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)),
				),
			);
			const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { plain: string; message: string };
			equal(result.plain, `plain /backend-api/codex/models?x=1 Bearer ${REAL_KEY}`);
			equal(result.message, "hello");
			equal(upgrades[0]?.url, "/backend-api/codex/responses");
			equal(upgrades[0]?.headers.authorization, `Bearer ${REAL_KEY}`);
			ok(route.receipts().some((receipt) => receipt.upgrade === true && receipt.status === 101));
		} finally {
			route.close();
			await upstream.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("surrogates", () => {
	it("keep the shape each client checks and carry nothing of the real key", () => {
		const codexKey = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" }, exp: 1 });
		const codex = modelRouteSurrogate("openai-codex-responses", codexKey);
		ok(codex);
		const parts = codex.split(".");
		equal(parts.length, 3);
		// pi-ai reads the account with atob, PanCode's quota scope with base64url; both see the same account.
		equal(JSON.parse(atob(parts[1] ?? ""))["https://api.openai.com/auth"].chatgpt_account_id, "acct-42");
		equal(codexAccountScope(codex), codexAccountScope(codexKey));
		ok(!codex.includes(codexKey.split(".")[2] ?? "-"));
		equal(modelRouteSurrogate("openai-codex-responses", "not-a-jwt"), null);
		const oauth = modelRouteSurrogate("anthropic-messages", "sk-ant-oat01-real");
		ok(oauth?.includes("sk-ant-oat"), "pi-ai picks Anthropic's OAuth header mode by this prefix");
		const plain = modelRouteSurrogate("anthropic-messages", "sk-ant-api03-real");
		ok(plain?.startsWith("pancode-route-") && !plain.includes("sk-ant"));
		const once = modelRouteSurrogate("openai-completions", REAL_KEY);
		ok(once !== modelRouteSurrogate("openai-completions", REAL_KEY), "each launch gets its own");
	});
});

function cloudRuntime(overrides: Partial<RuntimeDescriptor> = {}, api = "openai-responses"): RuntimeDescriptor {
	return {
		id: "openai",
		displayName: "OpenAI",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-responses",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: (target: TargetDescriptor) =>
			({ id: target.defaultModel, provider: "openai", api, baseUrl: "https://api.example.test/v1" }) as never,
		...overrides,
	};
}

describe("process isolation admission", () => {
	const target: TargetDescriptor = { id: "cloud", runtime: "openai", defaultModel: "m" };
	const facts = (runtime: RuntimeDescriptor, more: { localPlacement?: boolean; platform?: NodeJS.Platform } = {}) =>
		workerIsolationRefusal({
			target: { target, runtime, wireModelId: "m" },
			localPlacement: more.localPlacement ?? true,
			platform: more.platform ?? "linux",
		});

	it("admits a cloud HTTP target and names why every other launch is refused", () => {
		equal(facts(cloudRuntime()), null);
		match(facts(cloudRuntime(), { platform: "darwin" }) ?? "", /requires Linux bwrap; this host is darwin/u);
		match(facts(cloudRuntime({ id: "claude-sdk", kind: "sdk" })) ?? "", /SDK runtime that holds its own credential/u);
		match(facts(cloudRuntime({ kind: "subprocess" })) ?? "", /CLI peer/u);
		match(facts(cloudRuntime({ auth: "claude-cli" })) ?? "", /CLI peer/u);
		match(facts(cloudRuntime(), { localPlacement: false }) ?? "", /fleet node/u);
		match(facts(cloudRuntime({ tier: "local-native" })) ?? "", /residency control/u);
		match(facts(cloudRuntime({}, "google-generative-ai")) ?? "", /speaks google-generative-ai/u);
		match(facts(cloudRuntime({ auth: "none" })) ?? "", /needs no credential/u);
		const local = cloudRuntime({
			synthesizeModel: () => ({ api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" }) as never,
		});
		match(facts(local) ?? "", /local or private address/u);
		for (const refusal of [facts(cloudRuntime({ kind: "sdk" })), facts(local)])
			match(refusal ?? "", /Set safety\.workerIsolation to children/u);
		const placed = (sandbox: { backend: "bwrap" | "none"; degraded?: string }) =>
			workerIsolationRefusal({
				target: { target, runtime: cloudRuntime(), wireModelId: "m" },
				localPlacement: true,
				sandbox,
				platform: "linux",
			});
		equal(placed({ backend: "bwrap" }), null);
		match(placed({ backend: "none" }) ?? "", /runs the worker under bwrap, and this launch has none/u);
		match(placed({ backend: "bwrap", degraded: "no seccomp" }) ?? "", /needs the seccomp baseline \(no seccomp\)/u);
	});
});

describe("isolated worker launch", () => {
	it("runs the worker under bwrap with only the route and the host proxy, no credential, and room to sandbox its children", async (t) => {
		const availability = sandboxAvailability();
		if (
			!availability.available ||
			availability.backend !== "bwrap" ||
			availability.degraded !== undefined ||
			sandboxNetworkIsolation(availability) !== null
		) {
			t.skip("bubblewrap with seccomp and network isolation is not available");
			return;
		}
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-isolated-worker-")));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const workspace = join(scratch, "workspace");
		mkdirSync(workspace);
		mkdirSync(pancodeConfigPath(), { recursive: true });
		const settingsFile = join(pancodeConfigPath(), "settings.yaml");
		writeFileSync(settingsFile, "version: 2\n# settings-secret\n");
		t.after(() => rmSync(settingsFile, { force: true }));
		const host = http.createServer((_request, response) => response.end("host-direct"));
		await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
		t.after(() => host.close());
		const hostPort = (host.address() as AddressInfo).port;
		const route = http.createServer((request, response) => response.end(`route ${request.url}`));
		const script = [
			"const http = require('node:http');",
			"const fs = require('node:fs');",
			"const { spawnSync } = require('node:child_process');",
			"const get = (url, options = {}) => new Promise((done) => { const q = http.request(url, { timeout: 5000, ...options }, (s) => { let b = ''; s.on('data', (d) => (b += d)); s.on('end', () => done(s.statusCode + ' ' + b)); }); q.on('connect', (s, socket) => { socket.destroy(); done(s.statusCode + ' connect'); }); q.on('error', (e) => done('error ' + e.code)); q.on('timeout', () => { q.destroy(); done('timeout'); }); q.end(); });",
			"(async () => {",
			"  const out = {};",
			"  out.route = await get('http://127.0.0.1:3129/v1/responses');",
			`  out.direct = await get('http://127.0.0.1:${hostPort}/');`,
			"  out.proxy = await get('http://127.0.0.1:3128/', { method: 'CONNECT', path: 'example.com:443', headers: { host: 'example.com:443' } });",
			"  out.env = Object.keys(process.env).filter((k) => /api_key|channel/i.test(k));",
			"  out.proxyEnv = process.env.HTTPS_PROXY;",
			`  try { out.settings = fs.readFileSync(${JSON.stringify(settingsFile)}, 'utf8'); } catch (e) { out.settings = e.code; }`,
			"  const nested = spawnSync('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '/bin/echo', 'nested-ok']);",
			"  out.nested = String(nested.stdout).trim() || String(nested.stderr).trim();",
			"  process.stdout.write(JSON.stringify(out));",
			"})();",
		].join("\n");
		const policy: WorkerSandboxSpec = {
			version: WORKER_SANDBOX_SPEC_VERSION,
			mode: "required",
			writableRoots: [workspace],
			readOnlyPaths: [],
			gitWritablePaths: [],
			readableRoots: [workspace, pancodeConfigPath()],
			network: false,
		};
		const launch = planIsolatedWorkerLaunch({
			policy,
			command: [process.execPath, "-e", script],
			cwd: workspace,
			env: {
				...process.env,
				OPENAI_API_KEY: "sk-leak",
				HTTPS_PROXY: "http://proxy.corp.test:8080",
			},
			exposed: [dirname(dirname(process.execPath))],
			credentialEnv: ["OPENAI_API_KEY"],
			availability,
		});
		equal(launch.kind, "isolated", launch.kind === "refused" ? launch.message : "");
		if (launch.kind !== "isolated") return;
		deepEqual(launch.ports, [3128, 3129]);
		const child = spawn(launch.file, launch.args, {
			cwd: workspace,
			env: launch.env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			detached: true,
		});
		const handed: Server[] = [];
		const session = serveIsolatedWorker(child, policy, (listener) => {
			handed.push(listener);
			listener.on("connection", (socket) => route.emit("connection", socket));
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		const code = await new Promise((resolve) => child.once("close", resolve));
		for (const listener of handed) listener.close();
		route.close();
		equal(code, 0, stderr);
		const out = JSON.parse(stdout) as Record<string, unknown>;
		equal(out.route, "200 route /v1/responses");
		equal(out.direct, "error ECONNREFUSED");
		match(String(out.proxy), /^403 /u);
		deepEqual(out.env, []);
		equal(out.proxyEnv, "http://127.0.0.1:3128");
		ok(out.settings !== "version: 2\n# settings-secret\n", "the settings file is masked");
		equal(out.nested, "nested-ok");
		equal(session.egressReceipts().length > 0, true);
	});
});

describe("dispatch under process isolation", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	function bundleWith(runtime: RuntimeDescriptor, spawned: (spec: unknown, options?: SpawnOptions) => SpawnedWorker) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.safety.workerIsolation = "process";
		settings.targets = [
			{ id: "cloud", runtime: runtime.id, defaultModel: "m", auth: { headers: { "X-Secret-Org": "org-secret" } } },
		];
		settings.fleet.default.target = "cloud";
		settings.fleet.default.model = "m";
		const base = dispatchStubContext({ settings, runtime });
		const baseProviders = base.getContract("providers") as ProvidersContract;
		const providers: ProvidersContract = {
			...baseProviders,
			auth: {
				...baseProviders.auth,
				resolveForTarget: async () => ({
					providerId: runtime.id,
					available: true,
					credentialType: "api_key",
					source: "stored-api-key",
					detail: null,
					apiKey: REAL_KEY,
				}),
			},
		};
		const ctx = {
			...base,
			getContract: ((name: string) =>
				name === "providers" ? providers : base.getContract(name as never)) as typeof base.getContract,
		};
		return makeDispatchBundle(ctx, { heartbeatIntervalMs: 3_600_000, spawnWorker: spawned as never });
	}

	it("launches with a route and a surrogate, no credential, and closes the route when the worker exits", async () => {
		let spec: Record<string, unknown> | null = null;
		let isolation: SpawnOptions["isolation"];
		let exit: (value: { exitCode: number; signal: null }) => void = () => {};
		const bundle = bundleWith(cloudRuntime(), (built, options) => {
			spec = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
			isolation = options?.isolation;
			return {
				pid: null,
				promise: new Promise((resolve) => {
					exit = resolve;
				}),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "done" } };
				})(),
			};
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				readOnly: true,
				task: "look",
				requestOrigin: "user",
			});
			const launched = spec as Record<string, unknown> | null;
			ok(launched);
			const parsed = parseWorkerSpec(launched);
			ok(parsed.modelRoute);
			equal(parsed.modelRoute.origin, "https://api.example.test");
			equal(parsed.modelRoute.route, "http://127.0.0.1:3129");
			equal(parsed.apiKey, undefined);
			equal(parsed.authProfile, undefined);
			equal(parsed.target.auth?.headers, undefined);
			const serialized = JSON.stringify(launched);
			ok(!serialized.includes(REAL_KEY) && !serialized.includes("org-secret"), "no credential crosses to the worker");
			// The launch runs under bwrap with the run's child policy; the route is served on the listener it hands over.
			ok(isolation);
			equal(isolation.policy.network, parsed.sandbox?.network);
			const listener = createServer().listen(0, "127.0.0.1");
			await new Promise((resolve) => listener.once("listening", resolve));
			isolation.serveModelRoute(listener);
			const port = (listener.address() as AddressInfo).port;
			equal((await call(port, { headers: { authorization: "Bearer wrong" } })).status, 401);
			exit({ exitCode: 0, signal: null });
			await run.finalPromise;
			await rejects(call(port, { headers: { authorization: "Bearer wrong" } }), /ECONNREFUSED|ECONNRESET|socket hang up/u);
		} finally {
			exit({ exitCode: 0, signal: null });
			await bundle.extension.stop?.();
		}
	});

	it("refuses an SDK runtime before any worker starts", async () => {
		let spawned = 0;
		const bundle = bundleWith(cloudRuntime({ id: "claude-sdk", kind: "sdk" }), () => {
			spawned += 1;
			throw new Error("must not spawn");
		});
		await bundle.extension.start();
		try {
			await rejects(async () => {
				const run = await bundle.contract.dispatch({
					agentId: "coder",
					executionRole: "builder",
					readOnly: true,
					task: "look",
					requestOrigin: "user",
				});
				await run.finalPromise;
			}, /worker isolation unsupported: claude-sdk is an SDK runtime/u);
			equal(spawned, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
