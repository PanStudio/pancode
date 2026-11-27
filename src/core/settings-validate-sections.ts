// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Routes, external agents, fleet nodes, keybindings, and the systemOne, telemetry, prompts, models, report and store sections. */

import {
	STORE_DEFAULT_ROOT_NAME,
	STORE_TAG_CLASSES,
	validatePlacementRules,
	validateStoreProjectId,
	validateStoreRoots,
} from "@pancode/store/paths";
import { PROFILE_IDS } from "../domains/system-one/profiles.js";
import type { PancodeSettings } from "./config.js";
import { STORE_BACKEND_KINDS, type StoreS3Setting, THINKING_LEVELS } from "./defaults.js";
import { MODEL_TIERS } from "./model-tier.js";
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
			url.search !== ""
		) {
			issues.add("store.s3.endpoint", "expected http(s)://host[:port] with no path or query");
			endpoint = undefined;
		}
	}
	const region = "region" in raw ? expectString(issues, "store.s3.region", raw.region) : "us-east-1";
	const bucket = expectString(issues, "store.s3.bucket", raw.bucket);
	const accessKeyId = expectString(issues, "store.s3.accessKeyId", raw.accessKeyId);
	let prefix: string | undefined = "";
	if ("prefix" in raw) {
		if (typeof raw.prefix !== "string") {
			issues.add("store.s3.prefix", `expected a string, got ${describe(raw.prefix)}`);
			prefix = undefined;
		} else if (raw.prefix !== "" && (!raw.prefix.endsWith("/") || raw.prefix.startsWith("/"))) {
			issues.add("store.s3.prefix", "expected an empty prefix or one ending in '/', without a leading '/'");
			prefix = undefined;
		} else prefix = raw.prefix;
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

export function validateStore(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("store", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("store", raw, ["projectId", "backend", "s3", "roots", "placement"]);
	if ("backend" in raw) {
		const backend = expectEnum(issues, "store.backend", raw.backend, STORE_BACKEND_KINDS);
		if (backend !== undefined) settings.store.backend = backend;
	}
	if ("s3" in raw && raw.s3 !== null) settings.store.s3 = validateStoreS3(issues, raw.s3);
	if (settings.store.backend === "s3") {
		if (settings.store.s3 === null && !("s3" in raw && raw.s3 !== null))
			issues.add("store.s3", "expected the bucket's endpoint, region, bucket and accessKeyId when store.backend is s3");
		const placement = raw.placement;
		const placed =
			isRecord(placement) && Object.values(placement).some((rules) => isRecord(rules) && Object.keys(rules).length > 0);
		if (Array.isArray(raw.roots) && raw.roots.length > 0)
			issues.add("store.roots", "local store roots do not apply when store.backend is s3");
		if (placed) issues.add("store.placement", "store placement does not apply when store.backend is s3");
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
