// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The consent-gated services an api 2 runtime reaches over its IPC: embeddings from the configured profile, a
 * completion from the model the operator assigned, and the store limited to the approved tags. One instance
 * serves one host; each call names the extension, session and workspace it runs for.
 */
import { readFile } from "node:fs/promises";
import type {
	ExtensionCompletion,
	ExtensionCompletionRequest,
	ExtensionEmbeddingRequest,
} from "@pancode/sdk/extension";
import type { ExtensionBlobRequest, ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { RUNTIME_V2_LIMITS } from "@pancode/sdk/pack";
import { samplerTemperature } from "../../core/sampler-support.js";
import { validateBlobName, validateTagName } from "../../core/store-paths.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { pricingBasisFields } from "../../core/telemetry/pricing.js";
import type { CallMessageObserver, TelemetryCall } from "../../core/telemetry/producer.js";
import { beginCall, processTelemetryContext } from "../../core/telemetry/producer.js";
import { completeEngineText } from "../../engine/ai.js";
import { resolveEffectivePricing } from "../providers/catalog.js";
import type { EmbeddingResponse } from "../providers/embedding/types.js";
import {
	applyModelCapabilityPatch,
	modelEndpointKey,
	type ProvidersContract,
	type ResolvedRuntimeTarget,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
} from "../providers/index.js";
import { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "../providers/side-call-auth.js";
import type { SessionContract } from "../session/contract.js";
import type { StoreBackend } from "../store/index.js";
import { openStoreBackend } from "../store/index.js";
import { callSettlementFromMessage, reportedModelFromMessage, sideCallShutdownCause } from "../telemetry/call-facts.js";
import type { TelemetryContract } from "../telemetry/contract.js";
import { assignExtensionModel, readExtensionInstallRecord } from "./state.js";
import type {
	ExtensionListOptions,
	ExtensionLoadScope,
	ExtensionModelAssignment,
	ExtensionMutationResult,
} from "./types.js";

/** What one runtime's calls run for. */
export interface ExtensionServiceBinding {
	extensionId: string;
	scope: ExtensionLoadScope;
	sessionId: string | null;
	workspace: string;
	declaration: ExtensionRuntimeDeclarationV2;
	/** Read at each call: a session may turn read-only while a runtime is up. */
	readOnly: () => boolean;
}

export interface ExtensionServiceHost {
	embed?(request: ExtensionEmbeddingRequest, signal: AbortSignal, workspace: string): Promise<EmbeddingResponse>;
	complete?(
		binding: ExtensionServiceBinding,
		request: ExtensionCompletionRequest,
		signal: AbortSignal,
	): Promise<ExtensionCompletion>;
	blobs?(binding: ExtensionServiceBinding, request: ExtensionBlobRequest, signal: AbortSignal): Promise<unknown>;
}

export interface ExtensionHostServicesDeps {
	/** Absent in a host with no model routes: completions then refuse. A function loads them on first use. */
	providers?: ProvidersContract | (() => Promise<ProvidersContract>) | undefined;
	telemetry?: Pick<TelemetryContract, "acquireTelemetrySession"> | undefined;
	session?: Pick<SessionContract, "current"> | undefined;
	/** The tags a run granted, when it granted any; a put outside them is refused. */
	grants?: () => ReadonlyArray<string> | undefined;
	/** The operator's assignment; defaults to the install record. */
	assignment?: (binding: ExtensionServiceBinding) => ExtensionModelAssignment | undefined;
	openStore?: (cwd: string) => Promise<StoreBackend>;
	embed?: ExtensionServiceHost["embed"];
	/**
	 * The attended host's question to the operator. With it, a call with no assignment asks which model to
	 * assign, and a refused route asks again; without it, both refusals name the command.
	 */
	ask?: ExtensionServiceAsk;
}

/** The ask_user overlay, as much of it as choosing a model needs. */
export type ExtensionServiceAsk = (
	questions: ReadonlyArray<{
		header: string;
		question: string;
		options: Array<{ label: string; description: string }>;
		defaultOption: number;
	}>,
) => Promise<{ cancelled?: true; answers: ReadonlyArray<{ options?: string[]; value?: string }> }>;

/** Model spend and calls in flight for one extension in one session. A reload swaps the process, not this. */
interface Ledger {
	spent: number;
	reserved: number;
	running: number;
}

const COMPLETION_TIMEOUT_MS = 120_000;
const KEEP_UNAVAILABLE = "Keep it unavailable";

function assignCommand(extensionId: string): string {
	return `pancode extensions services ${extensionId} --model <target>/<model>`;
}

/** Characters over four, plus a little per message for its framing. An estimate the provider's count replaces. */
function estimateInputTokens(request: ExtensionCompletionRequest): number {
	const chars = (request.system?.length ?? 0) + request.messages.reduce((sum, message) => sum + message.text.length, 0);
	return Math.ceil(chars / 4) + 8 * (request.messages.length + 1);
}

/** The route a target and model resolve to now, and the endpoint that names where calls go. */
function resolveModelRoute(
	providers: ProvidersContract,
	targetId: string,
	wireModelId: string,
): { route: ResolvedRuntimeTarget; endpoint: string } {
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		requestedThinkingLevel: "off",
		requireTools: false,
		requireStreaming: false,
		requireOutputBudget: false,
	});
	if (!resolved.ok)
		throw new Error(
			resolved.diagnostics.find((entry) => entry.severity === "error")?.message ??
				`target ${targetId} does not resolve model ${wireModelId}`,
		);
	const route = resolved.target;
	return {
		route,
		endpoint: modelEndpointKey(route.target, route.wireModelId) ?? `${route.runtimeId}:${route.targetId}`,
	};
}

/**
 * Assign the model an installed extension's completions run on, recording the endpoint it resolves to now.
 * `sessionTokens` may only lower the declared budget.
 */
export function assignExtensionServiceModel(
	providers: ProvidersContract,
	input: { id: string; target: string; model: string; sessionTokens?: number; declared?: number },
	options: ExtensionListOptions = {},
): ExtensionMutationResult & { endpoint?: string } {
	if (input.sessionTokens !== undefined && input.declared !== undefined && input.sessionTokens > input.declared)
		return {
			diagnostics: [
				{
					type: "error",
					message: `--session-tokens may only lower the declared budget of ${input.declared} tokens`,
				},
			],
		};
	let endpoint: string;
	let model: string;
	try {
		const resolved = resolveModelRoute(providers, input.target, input.model);
		endpoint = resolved.endpoint;
		model = resolved.route.wireModelId;
	} catch (error) {
		return { diagnostics: [{ type: "error", message: error instanceof Error ? error.message : String(error) }] };
	}
	const result = assignExtensionModel(
		input.id,
		{
			target: input.target,
			model,
			endpoint,
			...(input.sessionTokens !== undefined ? { sessionTokens: input.sessionTokens } : {}),
		},
		options,
	);
	return result.diagnostics.some((entry) => entry.type === "error") ? result : { ...result, endpoint };
}

/**
 * The call's journal owner: the session's helper when the call serves the current session, else the process's,
 * either way named `extension:<id>` so usage charges the extension.
 */
async function callOwner(
	deps: ExtensionHostServicesDeps,
	binding: ExtensionServiceBinding,
): Promise<{ context: TelemetryContext | undefined; release(): Promise<void> }> {
	const agent = { role: "helper" as const, id: `extension:${binding.extensionId}` };
	const origin = deps.session?.current();
	const acquire = deps.telemetry?.acquireTelemetrySession;
	if (origin && acquire && binding.sessionId !== null && origin.id === binding.sessionId) {
		const lease = await acquire(origin, agent);
		return { context: lease.journaled ? lease.context : undefined, release: () => lease.release() };
	}
	const process = processTelemetryContext();
	return { context: process ? { ...process, agent } : undefined, release: async () => {} };
}

function journalObserver(
	owner: TelemetryContext | undefined,
	route: ResolvedRuntimeTarget,
	onMessage: (message: unknown) => void,
): CallMessageObserver & { close(): void } {
	const pricing = resolveEffectivePricing(route.target, route.runtime, route.wireModelId);
	let call: TelemetryCall | undefined;
	return {
		startAttempt(request) {
			if (!owner) return;
			call = call
				? (call.nextAttempt(request) ?? call)
				: beginCall(
						{
							target: {
								targetId: route.targetId,
								runtimeId: route.runtimeId,
								api: route.runtime.apiFamily,
								requestedModel: route.wireModelId,
								reportedModel: { kind: "unknown", reason: "not-observed" },
							},
							roundKind: "tools-removed",
							toolChoice: "none",
							...request,
						},
						owner,
					);
		},
		settle(message) {
			onMessage(message);
			call?.settle(
				callSettlementFromMessage(
					message,
					{ ...pricingBasisFields(pricing), ...(pricing.rates !== undefined ? { rates: pricing.rates } : {}) },
					sideCallShutdownCause(message),
				),
				reportedModelFromMessage(message),
			);
		},
		withContext: (work) => (call ? call.withContext(work) : work()),
		close() {
			if (call) call.abandon("internal");
		},
	};
}

export function createExtensionHostServices(deps: ExtensionHostServicesDeps): ExtensionServiceHost {
	const ledgers = new Map<string, Ledger>();
	let providers: Promise<ProvidersContract> | undefined;
	const loadProviders = (): Promise<ProvidersContract> | undefined => {
		const given = deps.providers;
		if (!given) return undefined;
		providers ??= typeof given === "function" ? given() : Promise.resolve(given);
		return providers;
	};
	// What the attended operator chose for a dev extension, which has no install record to keep it in.
	const chosen = new Map<string, ExtensionModelAssignment>();
	const asking = new Map<string, Promise<ExtensionModelAssignment | undefined>>();
	const assignmentFor = (binding: ExtensionServiceBinding): ExtensionModelAssignment | undefined =>
		chosen.get(binding.extensionId) ??
		(deps.assignment
			? deps.assignment(binding)
			: binding.scope === "dev"
				? undefined
				: readExtensionInstallRecord(binding.extensionId, { cwd: binding.workspace, scope: binding.scope })?.services
						?.model);

	/** Asks the attended operator which model to assign, once at a time per extension. */
	function askForModel(binding: ExtensionServiceBinding, why: string): Promise<ExtensionModelAssignment | undefined> {
		const ask = deps.ask;
		const routes = loadProviders();
		if (!ask || !routes) return Promise.resolve(undefined);
		const pending = asking.get(binding.extensionId);
		if (pending) return pending;
		const declared = binding.declaration.services?.model;
		const run = (async (): Promise<ExtensionModelAssignment | undefined> => {
			const loaded = await routes;
			const suggested = loaded
				.list()
				.filter((status) => status.available && status.target.defaultModel !== undefined)
				.slice(0, 4)
				.map((status) => `${status.target.id}/${status.target.defaultModel}`);
			const result = await ask([
				{
					header: "Extension model",
					question: [
						`Extension ${binding.extensionId} asks for model completions: ${why}.`,
						`It may spend up to ${declared?.sessionTokens ?? 0} tokens a session, at most ${declared?.maxOutputTokens ?? 0} per reply.`,
						"Choose the target and model its calls go to, or type <target>/<model>. It never uses another route.",
					].join("\n"),
					options: [
						...suggested.map((label) => ({ label, description: "Assign this model to the extension" })),
						{
							label: KEEP_UNAVAILABLE,
							description: `Refuse its calls; ${assignCommand(binding.extensionId)} assigns one later.`,
						},
					],
					defaultOption: suggested.length,
				},
			]);
			const answer = result.cancelled ? undefined : result.answers[0];
			const pick = answer?.value?.trim() || answer?.options?.[0];
			if (!pick || pick === KEEP_UNAVAILABLE) return undefined;
			const slash = pick.indexOf("/");
			if (slash <= 0 || slash === pick.length - 1) throw new Error(`"${pick}" is not <target>/<model>`);
			const target = pick.slice(0, slash);
			const model = pick.slice(slash + 1);
			if (binding.scope === "dev") {
				const resolved = resolveModelRoute(loaded, target, model);
				const record = {
					target,
					model: resolved.route.wireModelId,
					endpoint: resolved.endpoint,
					assignedAt: new Date().toISOString(),
				};
				chosen.set(binding.extensionId, record);
				return record;
			}
			const assigned = assignExtensionServiceModel(
				loaded,
				{ id: binding.extensionId, target, model },
				{ cwd: binding.workspace, scope: binding.scope },
			);
			const error = assigned.diagnostics.find((entry) => entry.type === "error");
			if (error) throw new Error(error.message);
			return assignmentFor(binding);
		})().finally(() => asking.delete(binding.extensionId));
		asking.set(binding.extensionId, run);
		return run;
	}

	async function complete(
		binding: ExtensionServiceBinding,
		request: ExtensionCompletionRequest,
		signal: AbortSignal,
	): Promise<ExtensionCompletion> {
		const declared = binding.declaration.services?.model;
		if (!declared) throw new Error("runtime did not declare runtime.services.model");
		const assigned = assignmentFor(binding) ?? (await askForModel(binding, "no model is assigned to it yet"));
		if (!assigned)
			throw new Error(
				`no model is assigned to extension ${binding.extensionId}; run ${assignCommand(binding.extensionId)}`,
			);
		signal.throwIfAborted();
		const key = `${binding.extensionId}\0${binding.sessionId ?? ""}`;
		const ledger = ledgers.get(key) ?? { spent: 0, reserved: 0, running: 0 };
		ledgers.set(key, ledger);
		const budget = Math.min(declared.sessionTokens, assigned.sessionTokens ?? declared.sessionTokens);
		const maxOutputTokens = Math.min(request.maxOutputTokens ?? declared.maxOutputTokens, declared.maxOutputTokens);
		const reservation = estimateInputTokens(request) + maxOutputTokens;
		// Checked and reserved in one synchronous step, so two calls cannot both fit in the room one leaves.
		if (ledger.running >= RUNTIME_V2_LIMITS.completionConcurrency)
			throw new Error(`model service is busy: ${ledger.running} completions are running`);
		if (ledger.spent + ledger.reserved + reservation > budget)
			throw new Error(
				`model budget refused: this call may need ${reservation} tokens and ${ledger.spent + ledger.reserved} of ${budget} for this session are spent or reserved`,
			);
		ledger.reserved += reservation;
		ledger.running++;
		let sent = false;
		let reported: { tokens: number } | null = null;
		let stopReason: unknown;
		const release = (): void => {
			ledger.reserved -= reservation;
			ledger.running--;
			// A call that reached the provider is charged what it reported, else everything it reserved.
			if (reported) ledger.spent += reported.tokens;
			else if (sent) ledger.spent += reservation;
		};
		try {
			signal.throwIfAborted();
			const routes = loadProviders();
			if (!routes) throw new Error("model service is unavailable in this host");
			const loaded = await routes;
			// A changed route is refused, never followed: the operator approved an endpoint, not a name.
			const refuse = (what: string): Error => {
				chosen.delete(binding.extensionId);
				if (deps.ask) void askForModel(binding, `${what}, so its approval is needed again`).catch(() => {});
				return new Error(
					`approval needed again: ${what}; ${deps.ask ? "choose its model when asked" : `run ${assignCommand(binding.extensionId)}`}`,
				);
			};
			let resolved: ReturnType<typeof resolveModelRoute>;
			try {
				resolved = resolveModelRoute(loaded, assigned.target, assigned.model);
			} catch (error) {
				throw refuse(
					`${assigned.target}/${assigned.model} no longer resolves (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			const { route, endpoint } = resolved;
			if (route.wireModelId !== assigned.model || endpoint !== assigned.endpoint)
				throw refuse(
					`${assigned.target}/${assigned.model} now resolves to ${endpoint} (${route.wireModelId}), not the ${assigned.endpoint} the operator approved`,
				);
			const kbHit = loaded.knowledgeBase?.lookup(route.wireModelId, route.runtime.id) ?? null;
			const model = route.runtime.synthesizeModel(route.target, route.wireModelId, kbHit);
			const refined = refineRuntimeTargetWithModelHints(route, model, loaded.knowledgeBase);
			applyModelCapabilityPatch(model, refined.capabilities);
			const auth = await resolveSideCallAuth(loaded.auth, route.target, route.runtime, LOCAL_API_KEY_FALLBACK, signal);
			signal.throwIfAborted();
			const owner = await callOwner(deps, binding);
			const observer = journalObserver(owner.context, refined, (message) => {
				stopReason = (message as { stopReason?: unknown } | null)?.stopReason;
			});
			// A route that refuses a sampler, Codex among them, answers it with HTTP 400; there it runs at its default.
			const temperature = request.temperature === undefined ? undefined : samplerTemperature(model, request.temperature);
			try {
				const completion = await completeEngineText({
					callTelemetry: observer,
					model,
					systemPrompt: request.system ?? "",
					userPrompt: "",
					messages: request.messages,
					...(temperature !== undefined ? { temperature } : {}),
					maxTokens:
						refined.capabilityDecisions.maxTokens > 0
							? Math.min(maxOutputTokens, refined.capabilityDecisions.maxTokens)
							: maxOutputTokens,
					thinkingLevel: refined.effectiveThinkingLevel,
					signal,
					timeoutMs: COMPLETION_TIMEOUT_MS,
					onUsage: ({ usage, failure }) => {
						sent = failure?.invoked !== false;
						if (usage.unmeteredCalls === undefined)
							reported = { tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
					},
					...auth,
					...(route.target.auth?.headers ? { headers: route.target.auth.headers } : {}),
				});
				return {
					text: completion.text.slice(0, RUNTIME_V2_LIMITS.completionResponseChars),
					stopReason: stopReason === "length" ? "length" : "stop",
					usage: {
						inputTokens: completion.usage.input + completion.usage.cacheRead + completion.usage.cacheWrite,
						outputTokens: completion.usage.output,
					},
				};
			} finally {
				observer.close();
				await owner.release();
			}
		} finally {
			release();
		}
	}

	async function blobs(
		binding: ExtensionServiceBinding,
		request: ExtensionBlobRequest,
		signal: AbortSignal,
	): Promise<unknown> {
		const store = binding.declaration.services?.store;
		if (!store) throw new Error("runtime did not declare runtime.services.store");
		const writes = request.op === "put";
		const approved = writes ? store.write : [...store.read, ...store.write];
		if (!approved.includes(request.tag))
			throw new Error(`store tag '${request.tag}' is not approved for ${writes ? "writing" : "reading"}`);
		const tagProblem = validateTagName(request.tag);
		if (tagProblem !== null) throw new Error(tagProblem);
		if (request.op !== "list") {
			const blobProblem = validateBlobName(request.blob);
			if (blobProblem !== null) throw new Error(blobProblem);
		}
		if (writes) {
			if (binding.readOnly()) throw new Error("store writes are refused in a read-only session");
			const granted = deps.grants?.();
			if (granted !== undefined && !granted.includes(request.tag))
				throw new Error(`store tag '${request.tag}' is outside the tags this run granted`);
		}
		const backend = await (deps.openStore ?? openStoreBackend)(binding.workspace);
		signal.throwIfAborted();
		if (!(await backend.tagExists(request.tag)))
			throw new Error(`store tag '${request.tag}' does not exist; create it first`);
		switch (request.op) {
			case "list":
				return backend.listBlobs(request.tag, {
					...(request.pattern !== undefined ? { pattern: request.pattern } : {}),
					...(request.prefix !== undefined ? { prefix: request.prefix } : {}),
					offset: request.offset,
					limit: request.limit,
				});
			case "stat": {
				const stat = await backend.statBlob(request.tag, request.blob);
				return stat === null ? null : { bytes: stat.bytes, modifiedMs: stat.modifiedMs };
			}
			case "get": {
				const stat = await backend.statBlob(request.tag, request.blob);
				if (stat === null) return null;
				if (stat.bytes > RUNTIME_V2_LIMITS.blobGetBytes)
					throw new Error(
						`${request.tag}:${request.blob} is ${stat.bytes} bytes; get returns at most ${RUNTIME_V2_LIMITS.blobGetBytes}`,
					);
				const got = await backend.getBlobAsPath(request.tag, request.blob, signal);
				const bytes = await readFile(got.path, { signal });
				if (bytes.length > RUNTIME_V2_LIMITS.blobGetBytes)
					throw new Error(`${request.tag}:${request.blob} grew past ${RUNTIME_V2_LIMITS.blobGetBytes} bytes`);
				return { base64: bytes.toString("base64") };
			}
			case "put": {
				const { recordedPut } = await import("@pancode/store");
				const result = await recordedPut(backend, {
					tag: request.tag,
					blob: request.blob,
					source: request.sourcePath,
					actor: {
						actor: "extension",
						extensionId: binding.extensionId,
						...(binding.sessionId !== null ? { sessionId: binding.sessionId } : {}),
					},
					signal,
					...(request.note !== undefined ? { record: { note: request.note } } : {}),
				});
				if (!result.recorded)
					throw new Error(
						`stored ${request.tag}:${request.blob} but could not record it (${result.reason}); put it again to record it`,
					);
				return { bytes: result.put.bytes, sha256: result.put.sha256 };
			}
		}
	}

	return {
		embed:
			deps.embed ??
			(async (request, signal, workspace) => {
				const { embedForExtension } = await import("../semantic-app/index.js");
				return embedForExtension({ projectRoot: workspace }, request, signal);
			}),
		complete,
		blobs,
	};
}
