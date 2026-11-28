// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Routes, external agents, fleet nodes, keybindings, and the systemOne, telemetry, prompts, models, report and store sections. */

import { isAbsolute } from "node:path";
import {
	STORE_DEFAULT_ROOT_NAME,
	STORE_TAG_CLASSES,
	validatePlacementRules,
	validateS3Prefix,
	validateStoreProjectId,
	validateStoreRoots,
} from "@pancode/store/paths";
import type { PancodeSettings } from "./config.js";
import {
	PROFILE_IDS,
	STORE_BACKEND_KINDS,
	type StoreS3Setting,
	type StoreSharedSetting,
	THINKING_LEVELS,
} from "./defaults.js";
import { MODEL_TIERS } from "./model-tier.js";
import { parseEgressAllowEntry, upstreamProxyProblem } from "./sandbox/egress/policy.js";
import { homeReadRootProblem } from "./sandbox/home-read-roots.js";
import { EGRESS_MODES, EGRESS_PRESET_NAMES, HOME_READ_MODES, HOME_READ_TOOLCHAINS } from "./sandbox/types.js";
import {
	describe,
	expectBoolean,
	expectEnum,
	expectInteger,
	expectString,
	expectStringArray,
	expectStringRecord,
	type Issues,
} from "./settings-issues.js";
import { TOOL_GOVERNANCE } from "./settings-validate-target.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { isRecord } from "./type-guards.js";

/**
 * Routing references (orchestrator/worker targets, scope, favorites) must
 * point at a configured target id. Dangling references are normalized away
 * deterministically rather than rejected: deleting a target must not brick
 * every session that still mentions it.
 */
type FleetRoute = PancodeSettings["fleet"]["default"];
type ExternalAgentDefaults = PancodeSettings["integrations"]["externalAgents"]["defaults"];
export type ExternalAgent = PancodeSettings["integrations"]["externalAgents"]["entries"][number];
export type FleetNodeConfig = PancodeSettings["fleet"]["nodes"][number];

export function validateRoute(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: FleetRoute,
	targets: ReadonlyArray<PancodeSettings["targets"][number]>,
	options?: { nodeIds?: ReadonlySet<string> },
): FleetRoute {
	const out = structuredClone(defaults);
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return out;
	}
	const allowNode = options?.nodeIds !== undefined;
	issues.unknownKeys(
		path,
		value,
		allowNode ? ["target", "model", "thinkingLevel", "node"] : ["target", "model", "thinkingLevel"],
	);
	if ("target" in value) {
		if (value.target === null) out.target = null;
		else {
			const parsed = expectString(issues, `${path}.target`, value.target);
			if (parsed !== undefined) out.target = targets.some((entry) => entry.id === parsed) ? parsed : null;
		}
	}
	if ("model" in value) {
		if (value.model === null) out.model = null;
		else {
			const parsed = expectString(issues, `${path}.model`, value.model);
			if (parsed !== undefined) out.model = parsed;
		}
	}
	if ("thinkingLevel" in value) {
		const parsed = expectEnum(issues, `${path}.thinkingLevel`, value.thinkingLevel, THINKING_LEVELS);
		if (parsed !== undefined) out.thinkingLevel = parsed;
	}
	if (allowNode && "node" in value) {
		if (value.node === null) delete out.node;
		else {
			const parsed = expectString(issues, `${path}.node`, value.node);
			if (parsed !== undefined && (parsed === "local" || options.nodeIds?.has(parsed) === true)) out.node = parsed;
		}
	}
	if (!out.target) out.model = null;
	else if (out.model === null) out.model = targets.find((entry) => entry.id === out.target)?.defaultModel ?? null;
	return out;
}

export function normalizeModelRefs(
	refs: ReadonlyArray<string>,
	targets: ReadonlyArray<PancodeSettings["targets"][number]>,
): string[] {
	const targetIds = new Set(targets.map((target) => target.id));
	return refs.filter((ref) => {
		const [targetId, ...model] = ref.split("/");
		return Boolean(targetId && targetIds.has(targetId) && model.join("/").trim());
	});
}

export function normalizeCycleSet(refs: ReadonlyArray<string>): string[] {
	return refs.filter((ref) => Boolean(ref.trim().split("/")[0]));
}

export function validateExternalAgent(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: ExternalAgentDefaults,
	seen: Set<string>,
): ExternalAgent | null {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"command",
		"args",
		"cwd",
		"env",
		"connectTimeoutMs",
		"turnTimeoutMs",
		"stallTimeoutMs",
		"toolGovernance",
		"trustedUnmediated",
		"projectContext",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const command = "command" in value ? expectString(issues, `${path}.command`, value.command) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("command" in value)) issues.add(`${path}.command`, "required");
	if (id === undefined || command === undefined) return null;
	if (id === "auto") {
		issues.add(`${path}.id`, "'auto' is reserved for coordinator-owned agent selection");
		return null;
	}
	if (seen.has(id)) {
		issues.add(`${path}.id`, `duplicate external agent id '${id}'`);
		return null;
	}
	seen.add(id);
	const agent: ExternalAgent = {
		id,
		command,
		args: [],
		connectTimeoutMs: defaults.connectTimeoutMs,
		turnTimeoutMs: defaults.turnTimeoutMs,
		toolGovernance: defaults.toolGovernance,
	};
	if ("args" in value) {
		const parsed = expectStringArray(issues, `${path}.args`, value.args);
		if (parsed !== undefined) agent.args = parsed;
	}
	for (const key of ["connectTimeoutMs", "turnTimeoutMs"] as const) {
		if (!(key in value)) continue;
		const parsed = expectInteger(issues, `${path}.${key}`, value[key], {
			min: key === "turnTimeoutMs" ? 0 : 1,
			max: MAX_TIMER_DELAY_MS,
		});
		if (parsed !== undefined) agent[key] = parsed;
	}
	if ("stallTimeoutMs" in value) {
		const parsed = expectInteger(issues, `${path}.stallTimeoutMs`, value.stallTimeoutMs);
		if (parsed !== undefined) agent.stallTimeoutMs = parsed;
	}
	if ("toolGovernance" in value) {
		const parsed = expectEnum(issues, `${path}.toolGovernance`, value.toolGovernance, TOOL_GOVERNANCE);
		if (parsed !== undefined) agent.toolGovernance = parsed;
	}
	if ("trustedUnmediated" in value) {
		const parsed = expectBoolean(issues, `${path}.trustedUnmediated`, value.trustedUnmediated);
		if (parsed !== undefined) agent.trustedUnmediated = parsed;
	}
	if ("projectContext" in value) {
		const parsed = expectEnum(issues, `${path}.projectContext`, value.projectContext, ["none", "bounded"] as const);
		if (parsed !== undefined) agent.projectContext = parsed;
	}
	for (const key of ["cwd"] as const) {
		if (!(key in value)) continue;
		const parsed = expectString(issues, `${path}.${key}`, value[key]);
		if (parsed !== undefined) agent[key] = parsed;
	}
	if ("env" in value) {
		const parsed = expectStringRecord(issues, `${path}.env`, value.env);
		if (parsed !== undefined && Object.keys(parsed).length > 0) agent.env = parsed;
	}
	return agent;
}

export function validateFleetNode(
	issues: Issues,
	path: string,
	value: unknown,
	seen: Set<string>,
): FleetNodeConfig | null {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"host",
		"user",
		"port",
		"identityFile",
		"pancodeEntry",
		"pancodeVersionCommand",
		"labels",
		"maxWorkers",
		"residency",
		"allowUnsandboxed",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const host = "host" in value ? expectString(issues, `${path}.host`, value.host) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("host" in value)) issues.add(`${path}.host`, "required");
	if (id === undefined || host === undefined) return null;
	if (id === "local") {
		issues.add(`${path}.id`, "'local' is reserved for the implicit local node");
		return null;
	}
	if (seen.has(id)) {
		issues.add(`${path}.id`, `duplicate fleet node id '${id}'`);
		return null;
	}
	seen.add(id);
	const node: FleetNodeConfig = { id, host, maxWorkers: 2 };
	for (const key of ["user", "identityFile", "pancodeEntry", "pancodeVersionCommand"] as const) {
		if (!(key in value)) continue;
		const parsed = expectString(issues, `${path}.${key}`, value[key]);
		if (parsed !== undefined) node[key] = parsed;
	}
	if ("port" in value) {
		const parsed = expectInteger(issues, `${path}.port`, value.port, { min: 1, max: 65535 });
		if (parsed !== undefined) node.port = parsed;
	}
	if ("labels" in value) {
		const parsed = expectStringArray(issues, `${path}.labels`, value.labels);
		if (parsed !== undefined) node.labels = parsed;
	}
	if ("maxWorkers" in value) {
		const parsed = expectInteger(issues, `${path}.maxWorkers`, value.maxWorkers, { min: 1 });
		if (parsed !== undefined) node.maxWorkers = parsed;
	}
	if ("residency" in value) {
		const parsed = expectEnum(issues, `${path}.residency`, value.residency, ["observe", "manage"] as const);
		if (parsed !== undefined) node.residency = parsed;
	}
	if ("allowUnsandboxed" in value) {
		const parsed = expectBoolean(issues, `${path}.allowUnsandboxed`, value.allowUnsandboxed);
		if (parsed !== undefined) node.allowUnsandboxed = parsed;
	}
	return node;
}

export function validateKeybindings(issues: Issues, path: string, value: unknown): Record<string, string | string[]> {
	if (!isRecord(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return {};
	}
	const next: Record<string, string | string[]> = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const id = rawKey.trim();
		if (!id) {
			issues.add(path, "empty keybinding id");
			continue;
		}
		if (typeof rawValue === "string") {
			const parsed = expectString(issues, `${path}.${id}`, rawValue);
			if (parsed !== undefined) next[id] = parsed;
		} else if (Array.isArray(rawValue)) {
			const parsed = expectStringArray(issues, `${path}.${id}`, rawValue);
			if (parsed !== undefined && parsed.length > 0) next[id] = parsed;
		} else issues.add(`${path}.${id}`, `expected a string or list of strings, got ${describe(rawValue)}`);
	}
	return next;
}

const SYSTEM_ONE_ENGINE_KINDS = ["systemone", "llm"] as const;

/**
 * `systemOne` is a map keyed by operator-chosen names, and assigning a key
 * called `__proto__` onto a plain object rewrites its prototype instead of
 * adding an entry, so that one name is refused rather than stored.
 */
function acceptedMapKey(issues: Issues, path: string, key: string): boolean {
	if (key.trim().length === 0) {
		issues.add(path, "expected a non-empty name");
		return false;
	}
	if (key === "__proto__") {
		issues.add(`${path}.${key}`, "reserved name");
		return false;
	}
	return true;
}

/** `safety.homeReads`: per-caller home read modes and what `listed` shows back. */
export function validateHomeReads(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("safety.homeReads", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("safety.homeReads", raw, ["main", "workers", "roots", "toolchains"]);
	const next = settings.safety.homeReads;
	for (const caller of ["main", "workers"] as const) {
		if (!(caller in raw)) continue;
		const parsed = expectEnum(issues, `safety.homeReads.${caller}`, raw[caller], HOME_READ_MODES);
		if (parsed !== undefined) next[caller] = parsed;
	}
	if ("roots" in raw) {
		const parsed = expectStringArray(issues, "safety.homeReads.roots", raw.roots);
		if (parsed !== undefined) {
			next.roots = [
				...new Set(
					parsed.filter((root) => {
						const problem = homeReadRootProblem(root);
						if (problem !== null) issues.add("safety.homeReads.roots", `${root}: ${problem}`);
						return problem === null;
					}),
				),
			];
		}
	}
	if ("toolchains" in raw) {
		const parsed = expectStringArray(issues, "safety.homeReads.toolchains", raw.toolchains);
		if (parsed !== undefined) {
			next.toolchains = [
				...new Set(
					parsed.filter((name): name is (typeof HOME_READ_TOOLCHAINS)[number] => {
						const known = (HOME_READ_TOOLCHAINS as readonly string[]).includes(name);
						if (!known)
							issues.add(
								"safety.homeReads.toolchains",
								`${name}: unknown toolchain (known: ${HOME_READ_TOOLCHAINS.join(", ")})`,
							);
						return known;
					}),
				),
			];
		}
	}
}

/** `safety.egress`: per-caller shell egress and the upstream proxy. */
export function validateEgress(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("safety.egress", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("safety.egress", raw, ["main", "workers", "upstreamProxy"]);
	for (const caller of ["main", "workers"] as const) {
		if (!(caller in raw)) continue;
		const path = `safety.egress.${caller}`;
		const value = raw[caller];
		if (!isRecord(value)) {
			issues.add(path, `expected a map, got ${describe(value)}`);
			continue;
		}
		issues.unknownKeys(path, value, ["mode", "allow", "presets"]);
		const next = settings.safety.egress[caller];
		if ("mode" in value) {
			const parsed = expectEnum(issues, `${path}.mode`, value.mode, EGRESS_MODES);
			if (parsed !== undefined) next.mode = parsed;
		}
		if ("allow" in value) {
			const parsed = expectStringArray(issues, `${path}.allow`, value.allow);
			if (parsed !== undefined) {
				next.allow = parsed.filter((entry) => {
					const origin = parseEgressAllowEntry(entry);
					if (typeof origin === "string") issues.add(`${path}.allow`, `${JSON.stringify(entry)}: ${origin}`);
					return typeof origin !== "string";
				});
			}
		}
		if ("presets" in value) {
			const parsed = expectStringArray(issues, `${path}.presets`, value.presets);
			if (parsed !== undefined) {
				next.presets = [
					...new Set(
						parsed.filter((name): name is (typeof EGRESS_PRESET_NAMES)[number] => {
							const known = (EGRESS_PRESET_NAMES as readonly string[]).includes(name);
							if (!known) issues.add(`${path}.presets`, `${name}: unknown preset (known: ${EGRESS_PRESET_NAMES.join(", ")})`);
							return known;
						}),
					),
				];
			}
		}
	}
	if ("upstreamProxy" in raw) {
		if (raw.upstreamProxy === null) settings.safety.egress.upstreamProxy = null;
		else {
			const parsed = expectString(issues, "safety.egress.upstreamProxy", raw.upstreamProxy);
			if (parsed !== undefined) {
				// The value may carry credentials, so the diagnostic never repeats it.
				const problem = upstreamProxyProblem(parsed);
				if (problem !== null) issues.add("safety.egress.upstreamProxy", problem);
				else settings.safety.egress.upstreamProxy = parsed;
			}
		}
	}
}

export function validateSystemOne(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("systemOne", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("systemOne", raw, ["use", "engines"]);
	const next = settings.systemOne;
	if ("use" in raw) {
		if (raw.use === null) next.use = null;
		else if (Array.isArray(raw.use)) {
			const names = raw.use.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
			if (names.length !== raw.use.length) {
				issues.add("systemOne.use", "expected a list of route names, each an engine, a target, jev, memory or main");
			} else next.use = names;
		} else {
			const use = expectString(issues, "systemOne.use", raw.use);
			if (use !== undefined) {
				if (use.trim().length === 0) issues.add("systemOne.use", "expected a route name, a list of them, or off");
				else next.use = use;
			}
		}
	}
	if ("engines" in raw) {
		if (!isRecord(raw.engines)) issues.add("systemOne.engines", `expected a map, got ${describe(raw.engines)}`);
		else {
			const engines: PancodeSettings["systemOne"]["engines"] = {};
			for (const [name, value] of Object.entries(raw.engines)) {
				const path = `systemOne.engines.${name}`;
				if (!acceptedMapKey(issues, "systemOne.engines", name)) continue;
				if (!isRecord(value)) {
					issues.add(path, `expected a map, got ${describe(value)}`);
					continue;
				}
				issues.unknownKeys(path, value, ["kind", "target", "model", "profile"]);
				const kind = expectEnum(issues, `${path}.kind`, value.kind, SYSTEM_ONE_ENGINE_KINDS);
				const target = expectString(issues, `${path}.target`, value.target);
				if (kind === undefined || target === undefined) continue;
				// A binding to a target nobody configured would fail at the call site,
				// where nothing connects the failure back to this line.
				if (!settings.targets.some((entry) => entry.id === target)) {
					issues.add(`${path}.target`, `target '${target}' is not defined in targets`);
					continue;
				}
				const engine: PancodeSettings["systemOne"]["engines"][string] = { kind, target };
				if ("model" in value) {
					const model = expectString(issues, `${path}.model`, value.model);
					if (model !== undefined) engine.model = model;
				}
				if ("profile" in value) {
					// An unknown profile is refused rather than read as generic: it would ask
					// the model questions its contract was never checked against.
					const profile = expectEnum(issues, `${path}.profile`, value.profile, PROFILE_IDS);
					if (profile !== undefined && kind !== "systemone")
						issues.add(`${path}.profile`, "only a systemone engine has a capability profile");
					else if (profile !== undefined) engine.profile = profile;
				}
				engines[name] = engine;
			}
			next.engines = engines;
		}
	}
}

const TELEMETRY_CAPTURE_FLAGS = ["content", "deltas", "providerHeaders", "busTrace"] as const;

export function validateTelemetry(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("telemetry", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("telemetry", raw, ["mode", "research"]);
	const next = settings.telemetry;
	if ("mode" in raw) {
		const parsed = expectEnum(issues, "telemetry.mode", raw.mode, ["standard", "research"] as const);
		if (parsed !== undefined) next.mode = parsed;
	}
	if (!("research" in raw)) return;
	if (!isRecord(raw.research)) {
		issues.add("telemetry.research", `expected a map, got ${describe(raw.research)}`);
		return;
	}
	issues.unknownKeys("telemetry.research", raw.research, TELEMETRY_CAPTURE_FLAGS);
	for (const flag of TELEMETRY_CAPTURE_FLAGS) {
		if (!(flag in raw.research)) continue;
		const parsed = expectBoolean(issues, `telemetry.research.${flag}`, raw.research[flag]);
		if (parsed !== undefined) next.research[flag] = parsed;
	}
}

export function validatePrompts(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("prompts", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("prompts", raw, ["profile"]);
	if ("profile" in raw) {
		const parsed = expectEnum(issues, "prompts.profile", raw.profile, ["v1", "v2"] as const);
		if (parsed !== undefined) settings.prompts.profile = parsed;
	}
}

export function validateModels(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("models", `expected a map, got ${describe(raw)}`);
		return;
	}
	const models: PancodeSettings["models"] = {};
	for (const [modelId, entry] of Object.entries(raw)) {
		const path = `models.${modelId}`;
		if (modelId.trim().length === 0) {
			issues.add("models", "empty model id");
			continue;
		}
		if (!isRecord(entry)) {
			issues.add(path, `expected a map, got ${describe(entry)}`);
			continue;
		}
		issues.unknownKeys(path, entry, ["tier"]);
		if (!("tier" in entry)) continue;
		const tier = expectEnum(issues, `${path}.tier`, entry.tier, MODEL_TIERS);
		if (tier !== undefined) models[modelId] = { tier };
	}
	settings.models = models;
}

export function validateReport(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("report", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("report", raw, ["offers"]);
	if ("offers" in raw) {
		const parsed = expectEnum(issues, "report.offers", raw.offers, ["ask", "off"] as const);
		if (parsed !== undefined) settings.report.offers = parsed;
	}
}

function validateStoreS3(issues: Issues, raw: unknown): StoreS3Setting | null {
	if (!isRecord(raw)) {
		issues.add("store.s3", `expected a map, got ${describe(raw)}`);
		return null;
	}
	issues.unknownKeys("store.s3", raw, ["endpoint", "region", "bucket", "prefix", "accessKeyId", "pathStyle"]);
	let endpoint = expectString(issues, "store.s3.endpoint", raw.endpoint);
	if (endpoint !== undefined) {
		let url: URL | null = null;
		try {
			url = new URL(endpoint);
		} catch {
			url = null;
		}
		if (
			url === null ||
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			url.username !== "" ||
			url.password !== ""
		) {
			issues.add("store.s3.endpoint", "expected http(s)://host[:port] with no credentials, path, query, or fragment");
			endpoint = undefined;
		}
	}
	const region = "region" in raw ? expectString(issues, "store.s3.region", raw.region) : "us-east-1";
	let bucket = expectString(issues, "store.s3.bucket", raw.bucket);
	if (bucket !== undefined && (!/^[A-Za-z0-9._-]+$/u.test(bucket) || bucket === "." || bucket === "..")) {
		issues.add("store.s3.bucket", "expected a bucket name of letters, digits, '.', '_' and '-'");
		bucket = undefined;
	}
	const accessKeyId = expectString(issues, "store.s3.accessKeyId", raw.accessKeyId);
	let prefix: string | undefined = "";
	if ("prefix" in raw) {
		if (typeof raw.prefix !== "string") {
			issues.add("store.s3.prefix", `expected a string, got ${describe(raw.prefix)}`);
			prefix = undefined;
		} else {
			const problem = validateS3Prefix(raw.prefix);
			if (problem !== null) {
				issues.add("store.s3.prefix", problem);
				prefix = undefined;
			} else prefix = raw.prefix;
		}
	}
	const pathStyle = "pathStyle" in raw ? expectBoolean(issues, "store.s3.pathStyle", raw.pathStyle) : false;
	if (
		endpoint === undefined ||
		region === undefined ||
		bucket === undefined ||
		accessKeyId === undefined ||
		prefix === undefined ||
		pathStyle === undefined
	)
		return null;
	return { endpoint: endpoint.replace(/\/$/u, ""), region, bucket, prefix, accessKeyId, pathStyle };
}

function validateStoreShared(issues: Issues, raw: unknown): StoreSharedSetting | null {
	if (!isRecord(raw)) {
		issues.add("store.shared", `expected a map, got ${describe(raw)}`);
		return null;
	}
	issues.unknownKeys("store.shared", raw, ["root"]);
	const root = expectString(issues, "store.shared.root", raw.root);
	if (root === undefined) return null;
	if (!isAbsolute(root)) {
		issues.add("store.shared.root", `expected an absolute path, got ${root}`);
		return null;
	}
	return { root };
}

export function validateStore(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("store", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("store", raw, ["projectId", "backend", "shared", "s3", "roots", "placement"]);
	if ("backend" in raw) {
		const backend = expectEnum(issues, "store.backend", raw.backend, STORE_BACKEND_KINDS);
		if (backend !== undefined) settings.store.backend = backend;
	}
	if ("shared" in raw && raw.shared !== null) settings.store.shared = validateStoreShared(issues, raw.shared);
	if ("s3" in raw && raw.s3 !== null) settings.store.s3 = validateStoreS3(issues, raw.s3);
	const backend = settings.store.backend;
	if (backend === "shared" && settings.store.shared === null && !("shared" in raw && raw.shared !== null))
		issues.add("store.shared", "expected the shared folder's root when store.backend is shared");
	if (backend === "s3" && settings.store.s3 === null && !("s3" in raw && raw.s3 !== null))
		issues.add("store.s3", "expected the bucket's endpoint, region, bucket and accessKeyId when store.backend is s3");
	if (backend !== "local") {
		const placement = raw.placement;
		const placed =
			isRecord(placement) && Object.values(placement).some((rules) => isRecord(rules) && Object.keys(rules).length > 0);
		if (Array.isArray(raw.roots) && raw.roots.length > 0)
			issues.add("store.roots", `local store roots do not apply when store.backend is ${backend}`);
		if (placed) issues.add("store.placement", `store placement does not apply when store.backend is ${backend}`);
	}
	if ("projectId" in raw) {
		const id = expectString(issues, "store.projectId", raw.projectId);
		if (id !== undefined) {
			const problem = validateStoreProjectId(id);
			if (problem !== null) issues.add("store.projectId", problem);
			else settings.store.projectId = id;
		}
	}
	let rootsValid = true;
	if ("roots" in raw) {
		if (!Array.isArray(raw.roots)) {
			issues.add("store.roots", `expected a list, got ${describe(raw.roots)}`);
			rootsValid = false;
		} else {
			const roots: PancodeSettings["store"]["roots"] = [];
			raw.roots.forEach((entry, index) => {
				const path = `store.roots[${index}]`;
				if (!isRecord(entry)) {
					issues.add(path, `expected a map, got ${describe(entry)}`);
					rootsValid = false;
					return;
				}
				issues.unknownKeys(path, entry, ["name", "path", "durable", "purge"]);
				const name = expectString(issues, `${path}.name`, entry.name);
				const dir = expectString(issues, `${path}.path`, entry.path);
				const durable = "durable" in entry ? expectBoolean(issues, `${path}.durable`, entry.durable) : true;
				let purge: string | null = null;
				if ("purge" in entry && entry.purge !== null) {
					const parsed = expectString(issues, `${path}.purge`, entry.purge);
					if (parsed === undefined) rootsValid = false;
					else purge = parsed;
				}
				if (name === undefined || dir === undefined || durable === undefined) {
					rootsValid = false;
					return;
				}
				roots.push({ name, path: dir, durable, purge });
			});
			if (rootsValid && roots.length > 0) {
				const problem = validateStoreRoots(roots);
				if (problem !== null) {
					issues.add("store.roots", problem);
					rootsValid = false;
				}
			}
			if (rootsValid) settings.store.roots = roots;
		}
	}
	if (!("placement" in raw)) return;
	const placement = raw.placement;
	if (!isRecord(placement)) {
		issues.add("store.placement", `expected a map, got ${describe(placement)}`);
		return;
	}
	issues.unknownKeys("store.placement", placement, ["byTag", "byClass"]);
	const byTag = "byTag" in placement ? expectStringRecord(issues, "store.placement.byTag", placement.byTag) : {};
	const byClassRaw =
		"byClass" in placement ? expectStringRecord(issues, "store.placement.byClass", placement.byClass) : {};
	if (byTag === undefined || byClassRaw === undefined || !rootsValid) return;
	const byClass: PancodeSettings["store"]["placement"]["byClass"] = {};
	for (const [tagClass, root] of Object.entries(byClassRaw)) {
		const known = STORE_TAG_CLASSES.find((candidate) => candidate === tagClass);
		if (known === undefined) {
			issues.add(`store.placement.byClass.${tagClass}`, `expected one of ${STORE_TAG_CLASSES.join(", ")}`);
			return;
		}
		byClass[known] = root;
	}
	const rootNames =
		settings.store.roots.length > 0 ? settings.store.roots.map((root) => root.name) : [STORE_DEFAULT_ROOT_NAME];
	const problem = validatePlacementRules({ byTag, byClass }, rootNames);
	if (problem !== null) {
		issues.add("store.placement", problem);
		return;
	}
	settings.store.placement = { byTag, byClass };
}
