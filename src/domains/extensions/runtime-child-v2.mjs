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

async function initialize(message) {
	if (identity) throw new Error("duplicate initialization");
	identity = message.instance;
	snapshot = Object.freeze(message.snapshot);
	declaration = message.declaration;
	options = Object.freeze({ ...message.options });
	limits = Object.freeze({ ...message.limits });
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
	});
	const input =
		message.kind === "command" ? message.args : message.kind === "tool" ? message.input : Object.freeze(message.event);
	try {
		const output = await handler(input, context);
		// A cancelled request has no authority; its late answer is dropped here and again by the host.
		if (!controller.signal.aborted && !disposing) send({ kind: "result", id: message.id, output: output ?? null });
	} catch (error) {
		if (!controller.signal.aborted && !disposing)
			send({ kind: "error", id: message.id, error: String(error).slice(0, 512) });
	} finally {
		requests.delete(message.id);
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
				requests.get(message.id)?.abort();
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
		send({ kind: "fatal", error: String(error).slice(0, 512) });
		void dispose("protocol-or-startup-failure");
	}
});
