// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** One `targets[]` entry: capabilities, auth, pricing, the LM Studio and LiteLLM blocks, and the funding pools and bindings it draws on. */

import type { PancodeSettings } from "./config.js";
import type { FundingBinding, FundingPool } from "./funding-config.js";
import {
	FUNDING_ID_PATTERN,
	FUNDING_PAYERS,
	FUNDING_PERIODS,
	FUNDING_SCHEMES,
	FUNDING_SIGNALS,
	FUNDING_STAMP_PATTERN,
	FUNDING_UNIT_PATTERN,
	isFundingCurrency,
	isFundingInstant,
	isInstitutionalPool,
} from "./funding-config.js";
import { BOOLEAN_CAPABILITY_KEYS } from "./runtime-vocabulary.js";
import {
	describe,
	expectBoolean,
	expectEnum,
	expectInteger,
	expectNumber,
	expectString,
	expectStringArray,
	expectStringRecord,
	type Issues,
} from "./settings-issues.js";
import { isRecord } from "./type-guards.js";

/** Copilot SDK context tiers a copilot-sdk target may opt into; absent means `default`. */
const COPILOT_CONTEXT_TIERS = ["default", "long_context"] as const;
const TOOL_CALL_FORMATS = ["openai", "anthropic", "hermes", "llama3-json", "mistral", "qwen", "xml"] as const;
const THINKING_FORMATS = [
	"qwen-chat-template",
	"openrouter",
	"zai",
	"anthropic-extended",
	"deepseek-r1",
	"openai-codex",
	"harmony",
] as const;
const STRUCTURED_OUTPUTS = ["json-schema", "gbnf", "xgrammar", "none"] as const;
export const TOOL_GOVERNANCE = ["pancode-policy", "agent-managed", "deny-all"] as const;

type TargetCapabilities = NonNullable<PancodeSettings["targets"][number]["capabilities"]>;

function validateCapabilities(issues: Issues, path: string, value: unknown): TargetCapabilities | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, [
		"chat",
		"tools",
		"toolCallFormat",
		"reasoning",
		"thinkingFormat",
		"structuredOutputs",
		"vision",
		"audio",
		"embeddings",
		"rerank",
		"fim",
		"contextWindow",
		"maxTokens",
	]);
	const out: TargetCapabilities = {};
	for (const key of BOOLEAN_CAPABILITY_KEYS) {
		if (key in value) {
			const v = expectBoolean(issues, `${path}.${key}`, value[key]);
			if (v !== undefined) out[key] = v;
		}
	}
	if ("toolCallFormat" in value) {
		const v = expectEnum(issues, `${path}.toolCallFormat`, value.toolCallFormat, TOOL_CALL_FORMATS);
		if (v !== undefined) out.toolCallFormat = v;
	}
	if ("thinkingFormat" in value) {
		const v = expectEnum(issues, `${path}.thinkingFormat`, value.thinkingFormat, THINKING_FORMATS);
		if (v !== undefined) out.thinkingFormat = v;
	}
	if ("structuredOutputs" in value) {
		const v = expectEnum(issues, `${path}.structuredOutputs`, value.structuredOutputs, STRUCTURED_OUTPUTS);
		if (v !== undefined) out.structuredOutputs = v;
	}
	if ("contextWindow" in value) {
		const v = expectInteger(issues, `${path}.contextWindow`, value.contextWindow, { min: 0 });
		if (v !== undefined) out.contextWindow = v;
	}
	if ("maxTokens" in value) {
		const v = expectInteger(issues, `${path}.maxTokens`, value.maxTokens, { min: 0 });
		if (v !== undefined) out.maxTokens = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validateAuth(
	issues: Issues,
	path: string,
	value: unknown,
): PancodeSettings["targets"][number]["auth"] | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["apiKeyEnvVar", "apiKeyRef", "oauthProfile", "headers"]);
	const out: NonNullable<PancodeSettings["targets"][number]["auth"]> = {};
	for (const key of ["apiKeyEnvVar", "apiKeyRef", "oauthProfile"] as const) {
		if (key in value) {
			const v = expectString(issues, `${path}.${key}`, value[key]);
			if (v !== undefined) out[key] = v;
		}
	}
	if ("headers" in value) {
		const v = expectStringRecord(issues, `${path}.headers`, value.headers);
		if (v !== undefined && Object.keys(v).length > 0) out.headers = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validatePricing(
	issues: Issues,
	path: string,
	value: unknown,
): PancodeSettings["targets"][number]["pricing"] | undefined {
	if (value === "free") return value;
	if (!isRecord(value)) {
		issues.add(path, `expected 'free' or a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["input", "output", "cacheRead", "cacheWrite"]);
	const input = expectNumber(issues, `${path}.input`, value.input, { min: 0 });
	const output = expectNumber(issues, `${path}.output`, value.output, { min: 0 });
	if (input === undefined || output === undefined) return undefined;
	const out: Exclude<NonNullable<PancodeSettings["targets"][number]["pricing"]>, "free"> = { input, output };
	if ("cacheRead" in value) {
		const v = expectNumber(issues, `${path}.cacheRead`, value.cacheRead, { min: 0 });
		if (v !== undefined) out.cacheRead = v;
	}
	if ("cacheWrite" in value) {
		const v = expectNumber(issues, `${path}.cacheWrite`, value.cacheWrite, { min: 0 });
		if (v !== undefined) out.cacheWrite = v;
	}
	return out;
}

type LmStudioLoadSetting = NonNullable<NonNullable<PancodeSettings["targets"][number]["lmstudio"]>["load"]>;

function validateLmStudioLoad(issues: Issues, path: string, value: unknown): LmStudioLoadSetting | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, [
		"contextLength",
		"flashAttention",
		"evalBatchSize",
		"numExperts",
		"offloadKvCacheToGpu",
		"parallel",
		"speculativeDraftMaxTokens",
	]);
	const load: LmStudioLoadSetting = {};
	for (const key of ["contextLength", "evalBatchSize", "numExperts", "parallel", "speculativeDraftMaxTokens"] as const) {
		if (key in value) {
			const parsed = expectInteger(issues, `${path}.${key}`, value[key], { min: 1 });
			if (parsed !== undefined) load[key] = parsed;
		}
	}
	for (const key of ["flashAttention", "offloadKvCacheToGpu"] as const) {
		if (key in value) {
			const parsed = expectBoolean(issues, `${path}.${key}`, value[key]);
			if (parsed !== undefined) load[key] = parsed;
		}
	}
	return Object.keys(load).length > 0 ? load : undefined;
}

function validateLmStudioSettings(
	issues: Issues,
	path: string,
	value: unknown,
): PancodeSettings["targets"][number]["lmstudio"] | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["load", "models", "request"]);
	const out: NonNullable<PancodeSettings["targets"][number]["lmstudio"]> = {};
	if ("load" in value) {
		const load = validateLmStudioLoad(issues, `${path}.load`, value.load);
		if (load !== undefined) out.load = load;
	}
	if ("models" in value) {
		if (!isRecord(value.models)) {
			issues.add(`${path}.models`, `expected a map, got ${describe(value.models)}`);
		} else {
			const models: NonNullable<typeof out.models> = {};
			for (const [modelId, entry] of Object.entries(value.models)) {
				const entryPath = `${path}.models.${modelId}`;
				if (!isRecord(entry)) {
					issues.add(entryPath, `expected a map, got ${describe(entry)}`);
					continue;
				}
				issues.unknownKeys(entryPath, entry, ["load"]);
				const load = "load" in entry ? validateLmStudioLoad(issues, `${entryPath}.load`, entry.load) : undefined;
				if (load !== undefined) models[modelId] = { load };
			}
			if (Object.keys(models).length > 0) out.models = models;
		}
	}
	if ("request" in value) {
		if (!isRecord(value.request)) {
			issues.add(`${path}.request`, `expected a map, got ${describe(value.request)}`);
		} else {
			issues.unknownKeys(`${path}.request`, value.request, ["ttlSeconds", "draftModel", "reasoning"]);
			const request: NonNullable<typeof out.request> = {};
			if ("ttlSeconds" in value.request) {
				const parsed = expectInteger(issues, `${path}.request.ttlSeconds`, value.request.ttlSeconds, { min: 1 });
				if (parsed !== undefined) request.ttlSeconds = parsed;
			}
			if ("draftModel" in value.request) {
				const parsed = expectString(issues, `${path}.request.draftModel`, value.request.draftModel);
				if (parsed !== undefined) request.draftModel = parsed;
			}
			if ("reasoning" in value.request) {
				const parsed = expectEnum(issues, `${path}.request.reasoning`, value.request.reasoning, [
					"auto",
					"off",
					"on",
					"low",
					"medium",
					"high",
				] as const);
				if (parsed !== undefined) request.reasoning = parsed;
			}
			if (Object.keys(request).length > 0) out.request = request;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validateLiteLLMSettings(
	issues: Issues,
	path: string,
	value: unknown,
): PancodeSettings["targets"][number]["litellm"] | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["request"]);
	const out: NonNullable<PancodeSettings["targets"][number]["litellm"]> = {};
	if ("request" in value) {
		if (!isRecord(value.request)) {
			issues.add(`${path}.request`, `expected a map, got ${describe(value.request)}`);
		} else {
			issues.unknownKeys(`${path}.request`, value.request, [
				"tags",
				"sendSessionId",
				"timeoutSeconds",
				"streamTimeoutSeconds",
				"numRetries",
			]);
			const request: NonNullable<typeof out.request> = {};
			if ("tags" in value.request) {
				const parsed = expectStringArray(issues, `${path}.request.tags`, value.request.tags);
				if (parsed !== undefined) {
					const invalidTag = parsed.find((tag) => tag.includes(","));
					if (invalidTag) issues.add(`${path}.request.tags`, "tags may not contain commas");
					else if (parsed.length > 0) request.tags = [...new Set(parsed)];
				}
			}
			if ("sendSessionId" in value.request) {
				const parsed = expectBoolean(issues, `${path}.request.sendSessionId`, value.request.sendSessionId);
				if (parsed !== undefined) request.sendSessionId = parsed;
			}
			for (const key of ["timeoutSeconds", "streamTimeoutSeconds"] as const) {
				if (key in value.request) {
					const parsed = expectNumber(issues, `${path}.request.${key}`, value.request[key], { min: 0.001, max: 86_400 });
					if (parsed !== undefined) request[key] = parsed;
				}
			}
			if ("numRetries" in value.request) {
				const parsed = expectInteger(issues, `${path}.request.numRetries`, value.request.numRetries, { min: 0, max: 100 });
				if (parsed !== undefined) request.numRetries = parsed;
			}
			if (Object.keys(request).length > 0) out.request = request;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function fundingMap(issues: Issues, path: string, value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) return value;
	issues.add(path, "expected a map");
	return undefined;
}

function fundingString(
	issues: Issues,
	path: string,
	value: unknown,
	accept: (text: string) => boolean,
	expected: string,
): string | undefined {
	if (typeof value === "string" && accept(value)) return value;
	issues.add(path, expected);
	return undefined;
}

export function validateFundingPool(issues: Issues, path: string, value: unknown): FundingPool | undefined {
	const raw = fundingMap(issues, path, value);
	if (!raw) return undefined;
	issues.unknownKeys(path, raw, ["scheme", "payer", "nativeUnit", "fee", "grant", "local"]);
	const scheme = expectEnum(issues, `${path}.scheme`, raw.scheme, FUNDING_SCHEMES);
	if (scheme === undefined) return undefined;
	const pool: FundingPool = { scheme };
	if ("payer" in raw) {
		const payer = expectEnum(issues, `${path}.payer`, raw.payer, FUNDING_PAYERS);
		if (payer !== undefined) pool.payer = payer;
	}
	if ("nativeUnit" in raw) {
		const nativeUnit = fundingString(
			issues,
			`${path}.nativeUnit`,
			raw.nativeUnit,
			(v) => FUNDING_UNIT_PATTERN.test(v),
			"expected a unit identifier",
		);
		if (nativeUnit !== undefined) pool.nativeUnit = nativeUnit;
	}
	if ("fee" in raw) {
		const p = `${path}.fee`;
		const fee = fundingMap(issues, p, raw.fee);
		if (fee) {
			issues.unknownKeys(p, fee, ["amount", "currency", "period"]);
			const amount = expectNumber(issues, `${p}.amount`, fee.amount, { min: 0 });
			const currency = fundingString(
				issues,
				`${p}.currency`,
				fee.currency,
				isFundingCurrency,
				"expected an ISO 4217 currency",
			);
			const period = expectEnum(issues, `${p}.period`, fee.period, FUNDING_PERIODS);
			if (amount !== undefined && currency !== undefined && period !== undefined) pool.fee = { amount, currency, period };
		}
	}
	if ("grant" in raw) {
		const p = `${path}.grant`;
		const grant = fundingMap(issues, p, raw.grant);
		if (grant) {
			issues.unknownKeys(p, grant, ["amount", "expiresAt"]);
			const expiresAt = fundingString(
				issues,
				`${p}.expiresAt`,
				grant.expiresAt,
				isFundingInstant,
				"expected an ISO UTC timestamp",
			);
			const amount = "amount" in grant ? expectNumber(issues, `${p}.amount`, grant.amount, { min: 0 }) : undefined;
			if (amount !== undefined && pool.nativeUnit === undefined)
				issues.add(`${path}.nativeUnit`, "required when a grant amount is declared");
			if (expiresAt !== undefined)
				pool.grant = { expiresAt, ...(amount !== undefined && pool.nativeUnit !== undefined ? { amount } : {}) };
		}
	}
	if ("local" in raw) {
		const p = `${path}.local`;
		const local = fundingMap(issues, p, raw.local);
		if (local) {
			issues.unknownKeys(p, local, ["activeWatts", "idleWatts", "tariff"]);
			const power: NonNullable<FundingPool["local"]> = {};
			for (const key of ["activeWatts", "idleWatts"] as const) {
				if (!(key in local)) continue;
				const watts = expectNumber(issues, `${p}.${key}`, local[key], { min: 0 });
				if (watts !== undefined) power[key] = watts;
			}
			if (power.activeWatts !== undefined && power.idleWatts !== undefined && power.activeWatts < power.idleWatts) {
				issues.add(`${p}.activeWatts`, "must be at least idleWatts");
				delete power.activeWatts;
				delete power.idleWatts;
			}
			if ("tariff" in local) {
				const tariff = fundingMap(issues, `${p}.tariff`, local.tariff);
				if (tariff) {
					issues.unknownKeys(`${p}.tariff`, tariff, ["ratePerKwh", "currency"]);
					const ratePerKwh = expectNumber(issues, `${p}.tariff.ratePerKwh`, tariff.ratePerKwh, { min: 0 });
					const currency = fundingString(
						issues,
						`${p}.tariff.currency`,
						tariff.currency,
						isFundingCurrency,
						"expected an ISO 4217 currency",
					);
					if (ratePerKwh !== undefined && currency !== undefined) power.tariff = { ratePerKwh, currency };
				}
			}
			pool.local = power;
		}
	}
	return pool;
}

function validateFundingBinding(
	issues: Issues,
	path: string,
	value: unknown,
	definitions: PancodeSettings["funding"],
): FundingBinding | undefined {
	const raw = fundingMap(issues, path, value);
	if (!raw) return undefined;
	issues.unknownKeys(path, raw, ["pool", "detection"]);
	const id = fundingString(
		issues,
		`${path}.pool`,
		raw.pool,
		(v) => FUNDING_ID_PATTERN.test(v),
		"expected a funding pool identifier",
	);
	if (id === undefined) return undefined;
	const pool = Object.hasOwn(definitions, id) ? definitions[id] : undefined;
	if (pool === undefined) {
		issues.add(`${path}.pool`, `no funding pool '${id}' is defined in user settings`);
		return undefined;
	}
	if (isInstitutionalPool(pool) && (pool.scheme !== "declared" || pool.grant === undefined)) {
		issues.add(`${path}.pool`, "an institutional binding requires a declared pool with a grant expiry");
		return undefined;
	}
	const binding: FundingBinding = { pool: id };
	if ("detection" in raw) {
		const p = `${path}.detection`;
		const detection = fundingMap(issues, p, raw.detection);
		if (detection) {
			issues.unknownKeys(p, detection, ["signal", "loginStamp", "verifiedAt"]);
			const signal = expectEnum(issues, `${p}.signal`, detection.signal, FUNDING_SIGNALS);
			const loginStamp = fundingString(
				issues,
				`${p}.loginStamp`,
				detection.loginStamp,
				(v) => FUNDING_STAMP_PATTERN.test(v),
				"expected an opaque login stamp",
			);
			const verifiedAt = fundingString(
				issues,
				`${p}.verifiedAt`,
				detection.verifiedAt,
				isFundingInstant,
				"expected an ISO UTC timestamp",
			);
			if (signal !== undefined && loginStamp !== undefined && verifiedAt !== undefined)
				binding.detection = { signal, loginStamp, verifiedAt };
		}
	}
	return binding;
}

export function validateTarget(
	issues: Issues,
	path: string,
	value: unknown,
	funding: PancodeSettings["funding"],
): PancodeSettings["targets"][number] | null {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"runtime",
		"url",
		"auth",
		"defaultModel",
		"wireModels",
		"capabilities",
		"lifecycle",
		"gateway",
		"pricing",
		"funding",
		"cache",
		"lmstudio",
		"litellm",
		"ollama",
		"maxConcurrentRequests",
		"trustedUnmediated",
		"contextTier",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const runtime = "runtime" in value ? expectString(issues, `${path}.runtime`, value.runtime) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("runtime" in value)) issues.add(`${path}.runtime`, "required");
	if (id === undefined || runtime === undefined) return null;
	const target: PancodeSettings["targets"][number] = { id, runtime };
	if ("url" in value) {
		const v = expectString(issues, `${path}.url`, value.url);
		if (v !== undefined) target.url = v;
	}
	if ("auth" in value) {
		const v = validateAuth(issues, `${path}.auth`, value.auth);
		if (v !== undefined) target.auth = v;
	}
	if ("wireModels" in value) {
		const v = expectStringArray(issues, `${path}.wireModels`, value.wireModels);
		if (v !== undefined && v.length > 0) target.wireModels = v;
	}
	if ("defaultModel" in value) {
		const v = expectString(issues, `${path}.defaultModel`, value.defaultModel);
		if (v !== undefined) target.defaultModel = v;
	} else if (target.wireModels?.[0]) {
		target.defaultModel = target.wireModels[0];
	}
	if ("capabilities" in value) {
		const v = validateCapabilities(issues, `${path}.capabilities`, value.capabilities);
		if (v !== undefined) target.capabilities = v;
	}
	if ("lifecycle" in value) {
		const v = expectEnum(issues, `${path}.lifecycle`, value.lifecycle, ["user-managed", "pancode-managed"] as const);
		if (v !== undefined) target.lifecycle = v;
	}
	if ("gateway" in value) {
		const v = expectBoolean(issues, `${path}.gateway`, value.gateway);
		if (v !== undefined) target.gateway = v;
	}
	if ("pricing" in value) {
		const v = validatePricing(issues, `${path}.pricing`, value.pricing);
		if (v !== undefined) target.pricing = v;
	}
	if ("funding" in value) {
		const binding = validateFundingBinding(issues, `${path}.funding`, value.funding, funding);
		if (binding !== undefined) target.funding = binding;
	}
	if ("cache" in value) {
		if (!isRecord(value.cache)) issues.add(`${path}.cache`, "expected a map");
		else {
			issues.unknownKeys(`${path}.cache`, value.cache, ["retention", "deployment", "warm"]);
			target.cache = {};
			if ("retention" in value.cache) {
				const retention = expectEnum(issues, `${path}.cache.retention`, value.cache.retention, [
					"none",
					"short",
					"long",
				] as const);
				if (retention !== undefined) target.cache.retention = retention;
			}
			if ("deployment" in value.cache) {
				const binding = value.cache.deployment;
				const bindingPath = `${path}.cache.deployment`;
				if (!isRecord(binding)) issues.add(bindingPath, "expected a map");
				else {
					issues.unknownKeys(bindingPath, binding, ["backend", "controlUrl", "model", "build", "gatewayDeploymentId"]);
					const backend = expectEnum(issues, `${bindingPath}.backend`, binding.backend, [
						"llamacpp",
						"vllm",
						"lmstudio",
					] as const);
					for (const key of ["controlUrl", "model", "build"] as const) {
						if (key === "build" && backend === "lmstudio" && binding[key] === undefined) continue;
						if (typeof binding[key] !== "string" || !binding[key].trim())
							issues.add(`${bindingPath}.${key}`, "expected a nonempty string");
					}
					if (typeof binding.controlUrl === "string") {
						try {
							const url = new URL(binding.controlUrl);
							if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
								throw new Error("invalid URL");
						} catch {
							issues.add(`${bindingPath}.controlUrl`, "expected an HTTP(S) URL without credentials, query, or fragment");
						}
					}
					if (
						binding.gatewayDeploymentId !== undefined &&
						(typeof binding.gatewayDeploymentId !== "string" || !binding.gatewayDeploymentId.trim())
					)
						issues.add(`${bindingPath}.gatewayDeploymentId`, "expected a nonempty string");
					if (
						backend &&
						typeof binding.controlUrl === "string" &&
						typeof binding.model === "string" &&
						(typeof binding.build === "string" || backend === "lmstudio")
					) {
						target.cache.deployment = {
							backend,
							controlUrl: binding.controlUrl,
							model: binding.model,
							...(typeof binding.build === "string" ? { build: binding.build } : {}),
							...(typeof binding.gatewayDeploymentId === "string" ? { gatewayDeploymentId: binding.gatewayDeploymentId } : {}),
						};
					}
				}
			}
			if ("warm" in value.cache) {
				if (!isRecord(value.cache.warm)) issues.add(`${path}.cache.warm`, "expected a map");
				else {
					issues.unknownKeys(`${path}.cache.warm`, value.cache.warm, [
						"startup",
						"maxInputTokens",
						"maxDurationMs",
						"cooldownMs",
					]);
					target.cache.warm = {};
					if ("startup" in value.cache.warm) {
						const startup = expectBoolean(issues, `${path}.cache.warm.startup`, value.cache.warm.startup);
						if (startup !== undefined) target.cache.warm.startup = startup;
					}
					for (const key of ["maxInputTokens", "maxDurationMs", "cooldownMs"] as const) {
						const bound = value.cache.warm[key];
						if (bound === undefined) continue;
						if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 1)
							issues.add(`${path}.cache.warm.${key}`, "expected a positive safe integer");
						else target.cache.warm[key] = bound;
					}
				}
			}
		}
	}
	if ("lmstudio" in value) {
		const v = validateLmStudioSettings(issues, `${path}.lmstudio`, value.lmstudio);
		if (v !== undefined) target.lmstudio = v;
	}
	if ("litellm" in value) {
		const v = validateLiteLLMSettings(issues, `${path}.litellm`, value.litellm);
		if (v !== undefined) target.litellm = v;
	}
	if ("ollama" in value) {
		if (!isRecord(value.ollama)) {
			issues.add(`${path}.ollama`, `expected a map, got ${describe(value.ollama)}`);
		} else {
			issues.unknownKeys(`${path}.ollama`, value.ollama, ["numCtx"]);
			const ollama: NonNullable<PancodeSettings["targets"][number]["ollama"]> = {};
			if ("numCtx" in value.ollama) {
				const parsed = expectInteger(issues, `${path}.ollama.numCtx`, value.ollama.numCtx, { min: 1 });
				if (parsed !== undefined) ollama.numCtx = parsed;
			}
			if (Object.keys(ollama).length > 0) target.ollama = ollama;
		}
	}
	if ("maxConcurrentRequests" in value) {
		const v = expectInteger(issues, `${path}.maxConcurrentRequests`, value.maxConcurrentRequests, { min: 1 });
		if (v !== undefined) target.maxConcurrentRequests = v;
	}
	if ("trustedUnmediated" in value) {
		const v = expectBoolean(issues, `${path}.trustedUnmediated`, value.trustedUnmediated);
		if (v !== undefined) target.trustedUnmediated = v;
	}
	if ("contextTier" in value) {
		if (runtime !== "copilot-sdk") {
			issues.add(`${path}.contextTier`, `applies only to copilot-sdk connections, not runtime ${describe(runtime)}`);
		} else {
			const v = expectEnum(issues, `${path}.contextTier`, value.contextTier, COPILOT_CONTEXT_TIERS);
			if (v !== undefined) target.contextTier = v;
		}
	}
	return target;
}
