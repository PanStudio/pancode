// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Private Node IPC bootstrap for operator runtime API v2. Shipped as ordinary JS: no runtime compiler or dependency install. */
import { pathToFileURL } from "node:url";
import { createRuntimeRegistration } from "./runtime-registration.mjs";

const PROTOCOL = 2;
// The host bounds requests and embeddings itself; these only fail an extension early with a clearer message.
const MAX_CONCURRENT = 8;

const commands = new Map();
const observers = new Map();
const hooks = new Map();
const tools = new Map();
const actions = new Map();
const interviews = new Map();
const disposers = [];
/** Host requests in flight, by id. A v2 runtime may hold several at once. */
const requests = new Map();
/** Requests the operator interrupted: their handlers see `ctx.signal` abort and still answer. */
const interrupted = new Set();
/** This runtime's own calls to host-held state and store, by id. */
const calls = new Map();
let identity;
let snapshot;
let declaration;
let options;
let registering = false;
let active = false;
let disposing = false;
let callSequence = 0;

function send(message) {
	if (process.connected) process.send({ protocol: PROTOCOL, instance: identity, ...message });
}
function call(op, payload) {
	if (disposing || !process.connected) return Promise.reject(new Error("runtime is disposing"));
	if (calls.size >= MAX_CONCURRENT) return Promise.reject(new Error("too many host service calls"));
	const id = `call-${++callSequence}`;
	return new Promise((resolve, reject) => {
		calls.set(id, { resolve, reject });
		send({ kind: "call", id, op, ...payload });
	});
}
function keyValue(scope, declared) {
	const guard = (run) => (declared ? run() : Promise.reject(new Error(`runtime did not declare ${scope}`)));
	return Object.freeze({
		get: (key) => guard(() => call(`${scope}.get`, { key })),
		set: (key, value, opts) =>
			guard(() =>
				call(`${scope}.set`, { key, value, ...(opts?.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) }),
			),
		delete: (key) => guard(() => call(`${scope}.delete`, { key })),
		keys: () => guard(() => call(`${scope}.keys`, {})),
	});
}
let state;
let store;
let storeDir;
let projectDir;
/** Request caps the host sent with `init`; the host checks every request again. */
let limits = {};

function completionRequest(request) {
	const model = declaration.services.model;
	if (request === null || typeof request !== "object") throw new Error("completion request must be an object");
	const messages = request.messages;
	if (!Array.isArray(messages) || messages.length === 0)
		throw new Error("completion request needs at least one message");
	if (messages.length > limits.completionMessages)
		throw new Error(`completion request allows at most ${limits.completionMessages} messages`);
	let chars = typeof request.system === "string" ? request.system.length : 0;
	for (const message of messages) {
		if (message?.role !== "user" && message?.role !== "assistant")
			throw new Error("completion message role must be user or assistant");
		if (typeof message.text !== "string" || message.text.length === 0)
			throw new Error("completion message text must be non-empty text");
		chars += message.text.length;
	}
	if (chars > limits.completionRequestChars)
		throw new Error(`completion request exceeds ${limits.completionRequestChars} characters`);
	const temperature = request.temperature;
	if (temperature !== undefined && !(typeof temperature === "number" && temperature >= 0 && temperature <= 2))
		throw new Error("completion temperature must be a number from 0 to 2");
	const ceiling = request.maxOutputTokens;
	if (ceiling !== undefined && !(Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= model.maxOutputTokens))
		throw new Error(`completion maxOutputTokens must be a whole number from 1 to ${model.maxOutputTokens}`);
	return {
		...(typeof request.system === "string" ? { system: request.system } : {}),
		messages: messages.map((message) => ({ role: message.role, text: message.text })),
		...(ceiling !== undefined ? { maxOutputTokens: ceiling } : {}),
		...(temperature !== undefined ? { temperature } : {}),
	};
}
function completion(value) {
	if (
		typeof value?.text !== "string" ||
		(value.stopReason !== "stop" && value.stopReason !== "length") ||
		!Number.isInteger(value.usage?.inputTokens) ||
		!Number.isInteger(value.usage?.outputTokens)
	)
		throw new Error("host returned a malformed completion");
	return Object.freeze({
		text: value.text,
		stopReason: value.stopReason,
		usage: Object.freeze({ inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens }),
	});
}
function blobs(parentRequestId) {
	const { read, write } = declaration.services.store;
	const run = (request) => {
		const approved = request.op === "put" ? write : [...read, ...write];
		if (!approved.includes(request.tag))
			return Promise.reject(
				new Error(`store tag '${request.tag}' is not approved for ${request.op === "put" ? "writing" : "reading"}`),
			);
		return call("blobs", { request, parentRequestId });
	};
	return Object.freeze({
		list: (tag, opts = {}) =>
			run({
				op: "list",
				tag,
				...(opts.pattern !== undefined ? { pattern: opts.pattern } : {}),
				...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
				...(opts.offset !== undefined ? { offset: opts.offset } : {}),
				...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			}),
		stat: (tag, blob) => run({ op: "stat", tag, blob }),
		get: (tag, blob) =>
			run({ op: "get", tag, blob }).then((value) => {
				if (value === null) return null;
				if (typeof value?.base64 !== "string") throw new Error("host returned a malformed blob");
				const bytes = Buffer.from(value.base64, "base64");
				if (bytes.length > limits.blobGetBytes) throw new Error("host returned an oversized blob");
				return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
			}),
		put: (tag, blob, sourcePath, opts = {}) =>
			run({ op: "put", tag, blob, sourcePath, ...(opts.note !== undefined ? { note: opts.note } : {}) }),
	});
}

/** The run, worktree, verify and claims services: the host validates every argument, so these only shape the call. */
function service(kind, parentRequestId) {
	return (op, payload = {}) => call(kind, { request: { ...payload, op }, parentRequestId });
}
function runs(parentRequestId) {
	const run = service("runs", parentRequestId);
	return Object.freeze({
		start: (request) => run("start", { run: request }),
		frames: (id, opts = {}) => run("frames", { id, ...opts }),
		wait: (id) => run("wait", { id }),
		cancel: (id) => run("cancel", { id }),
		refusal: (opts = {}) => run("refusal", opts),
	});
}
function worktrees(parentRequestId) {
	const run = service("worktrees", parentRequestId);
	return Object.freeze({
		create: (opts = {}) => run("create", opts),
		list: () => run("list"),
		remove: (id) => run("remove", { id }),
		git: (place, args) => run("git", { place, args }),
		checkout: (id, commit) => run("checkout", { id, commit }),
		clean: (id, opts = {}) => run("clean", { id, ...opts }),
		copy: (id, paths) => run("copy", { id, paths }),
		commit: (id, message, opts = {}) => run("commit", { id, message, ...opts }),
		refs: Object.freeze({
			get: (name) => run("refs.get", { name }),
			create: (name, commit) => run("refs.create", { name, commit }),
			swap: (name, to, from, message) => run("refs.swap", { name, to, from, message }),
		}),
	});
}
function verify(parentRequestId) {
	const run = service("verify", parentRequestId);
	return Object.freeze({
		list: (place) => run("list", place === undefined ? {} : { place }),
		resolve: (id, place) => run("resolve", { id, ...(place === undefined ? {} : { place }) }),
		check: (id, place) => run("check", { id, ...(place === undefined ? {} : { place }) }),
		measure: (id, metric, place) => run("measure", { id, metric, ...(place === undefined ? {} : { place }) }),
	});
}
function claims(parentRequestId) {
	const run = service("claims", parentRequestId);
	return Object.freeze({
		hypotheses: (name, slate) => run("hypotheses", { name, slate }),
		begin: (id, checks) => run("begin", { run: id, checks }),
		finish: (id, outcomes, opts = {}) => run("finish", { run: id, outcomes, ...opts }),
		read: (opts = {}) => run("read", opts),
	});
}
/** A request's progress line still waiting on the rate limit, sent before the request answers. */
const progressFlushes = new Map();
/** One line at a time, at most four a second: the latest line wins, so a busy loop never floods the IPC. */
function progress(requestId) {
	let last = 0;
	let pending;
	let timer;
	const flush = () => {
		timer = undefined;
		last = Date.now();
		if (requests.has(requestId)) send({ kind: "progress", id: requestId, text: pending });
	};
	progressFlushes.set(requestId, () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		flush();
	});
	return (text) => {
		pending = String(text).replace(/\s+/gu, " ").slice(0, 200);
		if (timer !== undefined) return;
		const wait = 250 - (Date.now() - last);
		if (wait <= 0) flush();
		else timer = setTimeout(flush, wait);
	};
}
function operatorServices(message) {
	if (message.kind !== "command" && message.kind !== "action") return {};
	const services = declaration.services ?? {};
	const long =
		message.kind === "command" && declaration.commands.some((entry) => entry.name === message.name && entry.long);
	return {
		...(services.runs ? { runs: runs(message.id) } : {}),
		...(services.worktrees ? { worktrees: worktrees(message.id) } : {}),
		...(services.verify ? { verify: verify(message.id) } : {}),
		...(services.claims ? { claims: claims(message.id) } : {}),
		...(long ? { progress: progress(message.id) } : {}),
	};
}

function binaries(parentRequestId) {
	return Object.freeze({
		run: (name, args = [], opts = {}) =>
			call("binaries", {
				request: {
					name,
					args,
					...(opts.env !== undefined ? { env: opts.env } : {}),
					...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
				},
				parentRequestId,
			}),
	});
}
function pane(parentRequestId) {
	const run = (op, payload = {}) => call("pane", { request: { ...payload, op }, parentRequestId });
	return Object.freeze({
		open: (request) => run("open", request),
		close: () => run("close"),
		hide: () => run("hide"),
		reveal: () => run("reveal"),
		state: () => run("state"),
		palette: () => run("palette"),
	});
}
async function dispose(reason) {
	if (disposing) return;
	disposing = true;
	active = false;
	for (const controller of requests.values()) controller.abort();
	for (const pending of calls.values()) pending.reject(new Error("runtime is disposing"));
	calls.clear();
	await Promise.allSettled(disposers.map((handler) => Promise.resolve().then(() => handler(reason))));
	process.exit(0);
}
process.on("disconnect", () => {
	// Parent loss must also stop idle timers, even if a disposer never resolves.
	setTimeout(() => process.exit(1), 250);
	void dispose("parent-disconnected");
});
function errorText(error) {
	try {
		const raw =
			error instanceof Error
				? typeof error.message === "string" && error.message.length > 0
					? error.message
					: error.name
				: String(error);
		return (typeof raw === "string" && raw.length > 0 ? raw : "unknown error").slice(0, 512);
	} catch {
		return "unprintable error";
	}
}

/** Reasons already reported, so a handler that drops the same refusal on every event sends one line. */
const unhandled = new Set();
// Node's default exits on a rejection nobody handled, such as a handler's unawaited `ctx.store.set` the host
// refused; that cost every later command of the package. Once active the runtime reports it and keeps serving.
process.on("unhandledRejection", (reason) => {
	const error = errorText(reason);
	if (!active) {
		if (disposing) return;
		send({ kind: "fatal", error });
		void dispose("protocol-or-startup-failure");
		return;
	}
	if (unhandled.has(error) || unhandled.size >= 32) return;
	unhandled.add(error);
	send({ kind: "unhandled", error });
});

async function initialize(message) {
	if (identity) throw new Error("duplicate initialization");
	identity = message.instance;
	snapshot = Object.freeze(message.snapshot);
	declaration = message.declaration;
	options = Object.freeze({ ...message.options });
	limits = Object.freeze({ ...message.limits });
	if (typeof message.storeDir === "string") storeDir = message.storeDir;
	if (typeof message.projectDir === "string") projectDir = message.projectDir;
	state = keyValue("state", declaration.state.session === true);
	store = keyValue("store", declaration.state.store === true);
	const registration = createRuntimeRegistration(
		declaration,
		{ commands, observers, hooks, tools, actions, interviews },
		disposers,
	);
	registering = true;
	const module = await import(pathToFileURL(message.entrypoint).href);
	if (typeof module.default !== "function") throw new Error("runtime must export a default factory");
	await module.default(registration.api);
	if (disposing) return;
	registering = false;
	registration.finish();
	send({
		kind: "ready",
		commands: [...commands.keys()],
		events: [...observers.keys()],
		hooks: [...hooks.keys()],
		tools: [...tools.keys()],
		actions: [...actions.keys()],
		interviews: [...interviews.keys()],
		rss: process.memoryUsage().rss,
	});
}

const TABLES = {
	command: commands,
	observe: observers,
	hook: hooks,
	tool: tools,
	action: actions,
	interview: interviews,
};

async function serve(message) {
	if (!active) throw new Error("runtime not active");
	if (typeof message.id !== "string" || requests.has(message.id)) throw new Error("invalid request id");
	const name =
		message.kind === "observe" ? message.event?.event : message.kind === "hook" ? message.event?.point : message.name;
	const handler = TABLES[message.kind].get(name);
	if (requests.size >= MAX_CONCURRENT || !handler) {
		send({
			kind: "error",
			id: message.id,
			error: handler ? "runtime is busy" : `no handler for ${message.kind} ${String(name)}`,
		});
		return;
	}
	const controller = new AbortController();
	requests.set(message.id, controller);
	const context = Object.freeze({
		snapshot,
		requestId: message.id,
		signal: controller.signal,
		options,
		state,
		store,
		...(declaration.services?.embedding
			? { embed: (request) => call("embed", { request, parentRequestId: message.id }) }
			: {}),
		...(declaration.services?.model
			? {
					complete: async (request) =>
						completion(await call("complete", { request: completionRequest(request), parentRequestId: message.id })),
				}
			: {}),
		...(declaration.services?.store ? { blobs: blobs(message.id) } : {}),
		...(storeDir !== undefined ? { storeDir } : {}),
		...(projectDir !== undefined ? { projectDir } : {}),
		...(message.kind === "command" && Array.isArray(message.argv) ? { argv: Object.freeze([...message.argv]) } : {}),
		...(declaration.binaries?.length ? { binaries: binaries(message.id) } : {}),
		...(declaration.services?.pane ? { pane: pane(message.id) } : {}),
		...operatorServices(message),
	});
	// An interrupted request still owes its answer; a cancelled one does not.
	const answers = () => !disposing && (!controller.signal.aborted || interrupted.has(message.id));
	const input =
		message.kind === "command" ? message.args : message.kind === "tool" ? message.input : Object.freeze(message.event);
	try {
		const output = await handler(input, context);
		// A cancelled request has no authority; its late answer is dropped here and again by the host.
		if (answers()) {
			progressFlushes.get(message.id)?.();
			send({ kind: "result", id: message.id, output: output ?? null });
		}
	} catch (error) {
		if (answers()) {
			progressFlushes.get(message.id)?.();
			send({ kind: "error", id: message.id, error: errorText(error) });
		}
	} finally {
		progressFlushes.delete(message.id);
		requests.delete(message.id);
		interrupted.delete(message.id);
	}
}

process.on("message", async (message) => {
	try {
		if (message?.protocol !== PROTOCOL || typeof message.instance !== "string") throw new Error("invalid host protocol");
		if (message.kind === "init") {
			await initialize(message);
			return;
		}
		if (message.instance !== identity || disposing) return;
		switch (message.kind) {
			case "activate":
				if (registering || !declaration || active) throw new Error("invalid activation");
				active = true;
				send({ kind: "active" });
				return;
			case "dispose":
				await dispose(message.reason);
				return;
			case "cancel":
				interrupted.delete(message.id);
				requests.get(message.id)?.abort();
				return;
			case "interrupt":
				if (!requests.has(message.id)) return;
				interrupted.add(message.id);
				requests.get(message.id).abort();
				return;
			case "snapshot":
				snapshot = Object.freeze(message.snapshot);
				return;
			case "returned": {
				const pending = calls.get(message.id);
				if (!pending) return;
				calls.delete(message.id);
				if (typeof message.error === "string") pending.reject(new Error(message.error));
				else pending.resolve(message.value);
				return;
			}
			case "command":
			case "observe":
			case "hook":
			case "tool":
			case "action":
			case "interview":
				await serve(message);
				return;
			default:
				throw new Error("unknown host message");
		}
	} catch (error) {
		send({ kind: "fatal", error: errorText(error) });
		void dispose("protocol-or-startup-failure");
	}
});
