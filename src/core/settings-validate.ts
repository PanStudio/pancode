// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * There is exactly one schema: the file on disk and the in-memory shape use
 * the same version-2 key names (`targets`, `chat.target`, ...). Validation is
 * strict: unknown keys and type violations are errors carrying the exact key
 * path. Missing keys take DEFAULT_SETTINGS values.
 */

import { isAbsolute } from "node:path";
import { TURN_CONTROL_WORKFLOWS } from "../domains/turn-control/settings.js";
import { AUTONOMY_LEVELS, YOLO_CONFINEMENTS } from "../lib/autonomy/autonomy.js";
import { scratchRootProblem } from "../lib/scratch-roots/scratch-roots.js";
import { validationWrapperProblem } from "../lib/validation-wrappers/validation-wrappers.js";
import type { PancodeSettings } from "./config.js";
import {
	ACTIVE_ROUTING_POSTURES,
	ACTIVE_ROUTING_ROLES,
	COUNCIL_MEMBER_LABEL_PATTERN,
	DEFAULT_SETTINGS,
	MEMORY_DELIVERY_MODES,
	MEMORY_LESSONS_MODES,
	normalizeExitSummaryStyle,
	normalizeOutputStyle,
	SEMANTIC_MODALITIES,
	THEME_NAMED_COLORS,
	THINKING_LEVELS,
	WORKER_PERMISSION_MODES,
	WORKING_SET_PROFILE_IDS,
	WORKSPACE_SNAPSHOT_MODES,
} from "./defaults.js";
import { FUNDING_ID_PATTERN } from "./funding-config.js";
import { LIVE_CHECK_LOGIN_RUNTIMES } from "./sandbox/env-scrub.js";
import { RESOURCE_LIMIT_KEYS, RESOURCE_LIMIT_MAX, SANDBOX_MODES, UNIX_SOCKET_MODES } from "./sandbox/types.js";
import {
	describe,
	expectBoolean,
	expectEnum,
	expectInteger,
	expectNumber,
	expectString,
	expectStringArray,
	Issues,
	type SettingsCoercion,
	type SettingsIssue,
} from "./settings-issues.js";
import {
	type ExternalAgent,
	type FleetNodeConfig,
	normalizeCycleSet,
	normalizeModelRefs,
	validateExternalAgent,
	validateFleetNode,
	validateKeybindings,
	validateModels,
	validatePrompts,
	validateReport,
	validateRoute,
	validateStore,
	validateSystemOne,
	validateTelemetry,
} from "./settings-validate-sections.js";
import { fundingMap, TOOL_GOVERNANCE, validateFundingPool, validateTarget } from "./settings-validate-target.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { isRecord } from "./type-guards.js";
import { RUN_ROLES } from "./views/run-roles.js";

const TOP_LEVEL_KEYS = [
	"version",
	"turnControl",
	"targets",
	"funding",
	"chat",
	"fleet",
	"context",
	"systemOne",
	"safety",
	"interface",
	"integrations",
	"telemetry",
	"report",
	"prompts",
	"models",
	"store",
] as const;

function readSandboxBooleans(issues: Issues, safety: Record<string, unknown>, target: PancodeSettings["safety"]): void {
	for (const key of ["sandboxNetwork", "sandboxUnconfinedLocalWorkers"] as const) {
		if (!(key in safety)) continue;
		const parsed = expectBoolean(issues, `safety.${key}`, safety[key]);
		if (parsed !== undefined) target[key] = parsed;
	}
}

function validateSafetyResources(issues: Issues, raw: unknown, settings: PancodeSettings): void {
	if (!isRecord(raw)) {
		issues.add("safety.resources", `expected a map, got ${describe(raw)}`);
		return;
	}
	issues.unknownKeys("safety.resources", raw, ["main", "workers"]);
	for (const scope of ["main", "workers"] as const) {
		if (!(scope in raw)) continue;
		const block = raw[scope];
		const path = `safety.resources.${scope}`;
		if (!isRecord(block)) {
			issues.add(path, `expected a map, got ${describe(block)}`);
			continue;
		}
		issues.unknownKeys(path, block, RESOURCE_LIMIT_KEYS);
		for (const key of RESOURCE_LIMIT_KEYS) {
			if (!(key in block)) continue;
			if (block[key] === null) {
				settings.safety.resources[scope][key] = null;
				continue;
			}
			const parsed = expectInteger(issues, `${path}.${key}`, block[key], { min: 1, max: RESOURCE_LIMIT_MAX[key] });
			if (parsed !== undefined) settings.safety.resources[scope][key] = parsed;
		}
	}
}

function validateSafetyReview(issues: Issues, review: unknown, settings: PancodeSettings): void {
	if (!isRecord(review)) {
		issues.add("safety.review", `expected a map, got ${describe(review)}`);
		return;
	}
	issues.unknownKeys("safety.review", review, ["enabled", "target", "cadenceToolCalls"]);
	if ("enabled" in review) {
		const parsed = expectBoolean(issues, "safety.review.enabled", review.enabled);
		if (parsed !== undefined) settings.safety.review.enabled = parsed;
	}
	if ("target" in review && review.target !== null) {
		const parsed = expectString(issues, "safety.review.target", review.target);
		if (parsed !== undefined && settings.targets.some((target) => target.id === parsed))
			settings.safety.review.target = parsed;
		else if (parsed !== undefined) issues.add("safety.review.target", `unknown target '${parsed}'`);
	}
	if ("cadenceToolCalls" in review && review.cadenceToolCalls !== null) {
		const parsed = expectInteger(issues, "safety.review.cadenceToolCalls", review.cadenceToolCalls, { min: 1 });
		if (parsed !== undefined) settings.safety.review.cadenceToolCalls = parsed;
	}
}

export interface SettingsValidationResult {
	settings: PancodeSettings;
	issues: SettingsIssue[];
	/** YAML 1.1 booleans read as on/off levels. Loading still succeeds; doctor reports them. */
	coercions: SettingsCoercion[];
}

/**
 * Validate a parsed settings document against the one schema. Returns the
 * settings built from valid fields (defaults fill missing keys) plus every
 * issue found, each carrying the exact key path. Callers that must not
 * proceed on bad input use `readSettings`, which throws when issues exist;
 * doctor reports the same issues read-only.
 */
export function validateSettings(raw: unknown): SettingsValidationResult {
	const issues = new Issues();
	const settings = structuredClone(DEFAULT_SETTINGS);
	if (!isRecord(raw)) {
		issues.add("(root)", `expected a map, got ${describe(raw)}`);
		return { settings, issues: issues.list, coercions: issues.coercions };
	}
	issues.unknownKeys("", raw, TOP_LEVEL_KEYS);
	if ("version" in raw && raw.version !== 2) {
		issues.add(
			"version",
			`expected 2, got ${describe(raw.version)}; only version 2 is read: move settings.yaml aside and the next pancode run writes a version-2 file with the defaults`,
		);
	}
	if ("turnControl" in raw) {
		if (!isRecord(raw.turnControl)) issues.add("turnControl", `expected a map, got ${describe(raw.turnControl)}`);
		else {
			const control = raw.turnControl;
			issues.unknownKeys("turnControl", control, ["workflows"]);
			if ("workflows" in control) {
				if (!Array.isArray(control.workflows))
					issues.add("turnControl.workflows", `expected a list, got ${describe(control.workflows)}`);
				else {
					const workflows: PancodeSettings["turnControl"]["workflows"] = [];
					for (const [index, value] of control.workflows.entries()) {
						const parsed = expectEnum(issues, `turnControl.workflows[${index}]`, value, TURN_CONTROL_WORKFLOWS);
						if (parsed !== undefined) workflows.push(parsed);
					}
					settings.turnControl.workflows = workflows;
				}
			}
		}
	}

	if ("funding" in raw) {
		const definitions = fundingMap(issues, "funding", raw.funding);
		if (definitions) {
			for (const [id, value] of Object.entries(definitions)) {
				const path = `funding.${id}`;
				if (!FUNDING_ID_PATTERN.test(id) || Object.hasOwn(Object.prototype, id)) {
					issues.add(
						path,
						"expected a pool identifier of up to 48 letters, digits, hyphens or underscores, starting with a letter",
					);
					continue;
				}
				const pool = validateFundingPool(issues, path, value);
				if (pool !== undefined) settings.funding[id] = pool;
			}
		}
	}
	if ("targets" in raw) {
		if (!Array.isArray(raw.targets)) issues.add("targets", `expected a list, got ${describe(raw.targets)}`);
		else {
			const seen = new Set<string>();
			const targets: PancodeSettings["targets"] = [];
			for (let index = 0; index < raw.targets.length; index += 1) {
				const target = validateTarget(issues, `targets[${index}]`, raw.targets[index], settings.funding);
				if (!target) continue;
				if (seen.has(target.id)) {
					issues.add(`targets[${index}].id`, `duplicate target id '${target.id}'`);
					continue;
				}
				seen.add(target.id);
				targets.push(target);
			}
			settings.targets = targets;
		}
	}

	if ("chat" in raw) {
		if (!isRecord(raw.chat)) issues.add("chat", `expected a map, got ${describe(raw.chat)}`);
		else {
			const chat = raw.chat;
			issues.unknownKeys("chat", chat, [
				"target",
				"model",
				"thinkingLevel",
				"modelPicker",
				"maxOutputTokens",
				"prewarm",
				"cacheKeepalive",
				"loopsUntilStopped",
				"retry",
				"steering",
			]);
			const routeInput: Record<string, unknown> = {};
			for (const key of ["target", "model", "thinkingLevel"] as const) {
				if (key in chat) routeInput[key] = chat[key];
			}
			const route = validateRoute(
				issues,
				"chat",
				routeInput,
				{ target: settings.chat.target, model: settings.chat.model, thinkingLevel: settings.chat.thinkingLevel },
				settings.targets,
			);
			settings.chat.target = route.target;
			settings.chat.model = route.model;
			settings.chat.thinkingLevel = route.thinkingLevel;
			if ("modelPicker" in chat) {
				if (!isRecord(chat.modelPicker))
					issues.add("chat.modelPicker", `expected a map, got ${describe(chat.modelPicker)}`);
				else {
					issues.unknownKeys("chat.modelPicker", chat.modelPicker, ["cycleSet", "favorites", "recentLimit"]);
					if ("cycleSet" in chat.modelPicker) {
						const parsed = expectStringArray(issues, "chat.modelPicker.cycleSet", chat.modelPicker.cycleSet);
						if (parsed !== undefined) settings.chat.modelPicker.cycleSet = normalizeCycleSet(parsed);
					}
					if ("favorites" in chat.modelPicker) {
						const parsed = expectStringArray(issues, "chat.modelPicker.favorites", chat.modelPicker.favorites);
						if (parsed !== undefined) settings.chat.modelPicker.favorites = normalizeModelRefs(parsed, settings.targets);
					}
					if ("recentLimit" in chat.modelPicker) {
						const parsed = expectInteger(issues, "chat.modelPicker.recentLimit", chat.modelPicker.recentLimit, { min: 1 });
						if (parsed !== undefined) settings.chat.modelPicker.recentLimit = parsed;
					}
				}
			}
			if ("maxOutputTokens" in chat) {
				const parsed = expectInteger(issues, "chat.maxOutputTokens", chat.maxOutputTokens, { min: 0 });
				if (parsed !== undefined) settings.chat.maxOutputTokens = parsed;
			}
			if ("prewarm" in chat) {
				const parsed = expectBoolean(issues, "chat.prewarm", chat.prewarm);
				if (parsed !== undefined) settings.chat.prewarm = parsed;
			}
			if ("cacheKeepalive" in chat) {
				const parsed = expectBoolean(issues, "chat.cacheKeepalive", chat.cacheKeepalive);
				if (parsed !== undefined) settings.chat.cacheKeepalive = parsed;
			}
			if ("loopsUntilStopped" in chat) {
				const parsed = expectBoolean(issues, "chat.loopsUntilStopped", chat.loopsUntilStopped);
				if (parsed !== undefined) settings.chat.loopsUntilStopped = parsed;
			}
			if ("retry" in chat) {
				if (!isRecord(chat.retry)) issues.add("chat.retry", `expected a map, got ${describe(chat.retry)}`);
				else {
					issues.unknownKeys("chat.retry", chat.retry, [
						"enabled",
						"maxRetries",
						"baseDelayMs",
						"maxDelayMs",
						"streamStallMs",
						"firstTokenStallMs",
					]);
					if ("enabled" in chat.retry) {
						const parsed = expectBoolean(issues, "chat.retry.enabled", chat.retry.enabled);
						if (parsed !== undefined) settings.chat.retry.enabled = parsed;
					}
					for (const key of ["maxRetries", "baseDelayMs", "maxDelayMs", "streamStallMs", "firstTokenStallMs"] as const) {
						if (!(key in chat.retry)) continue;
						const parsed = expectInteger(issues, `chat.retry.${key}`, chat.retry[key], { min: 0 });
						if (parsed !== undefined) settings.chat.retry[key] = parsed;
					}
				}
			}
			if ("steering" in chat) {
				if (!isRecord(chat.steering)) issues.add("chat.steering", `expected a map, got ${describe(chat.steering)}`);
				else {
					issues.unknownKeys("chat.steering", chat.steering, ["triage"]);
					if ("triage" in chat.steering) {
						const triage = chat.steering.triage;
						if (!isRecord(triage)) issues.add("chat.steering.triage", `expected a map, got ${describe(triage)}`);
						else {
							const path = "chat.steering.triage";
							const target = settings.chat.steering.triage;
							issues.unknownKeys(path, triage, [
								"enabled",
								"target",
								"model",
								"thinkingLevel",
								"minQueued",
								"timeoutMs",
								"autoInterrupt",
							]);
							for (const key of ["enabled", "autoInterrupt"] as const) {
								if (!(key in triage)) continue;
								const parsed = expectBoolean(issues, `${path}.${key}`, triage[key]);
								if (parsed !== undefined) target[key] = parsed;
							}
							if ("target" in triage) {
								if (triage.target === null) target.target = null;
								else {
									const parsed = expectString(issues, `${path}.target`, triage.target);
									if (parsed !== undefined)
										target.target = settings.targets.some((candidate) => candidate.id === parsed) ? parsed : null;
								}
							}
							if ("model" in triage) {
								if (triage.model === null) target.model = null;
								else {
									const parsed = expectString(issues, `${path}.model`, triage.model);
									if (parsed !== undefined) target.model = parsed;
								}
							}
							// A model without a target is the session target's own model choice, which the
							// active runtime already made; it is dropped the way the memory block drops it.
							if (!target.target) target.model = null;
							if ("thinkingLevel" in triage) {
								const parsed = expectEnum(issues, `${path}.thinkingLevel`, triage.thinkingLevel, THINKING_LEVELS);
								if (parsed !== undefined) target.thinkingLevel = parsed;
							}
							for (const [key, min] of [
								["minQueued", 1],
								["timeoutMs", 1],
							] as const) {
								if (!(key in triage)) continue;
								const parsed = expectInteger(issues, `${path}.${key}`, triage[key], { min });
								if (parsed !== undefined) target[key] = parsed;
							}
						}
					}
				}
			}
		}
	}

	let rawFleet: Record<string, unknown> | null = null;
	if ("fleet" in raw) {
		if (!isRecord(raw.fleet)) issues.add("fleet", `expected a map, got ${describe(raw.fleet)}`);
		else {
			rawFleet = raw.fleet;
			issues.unknownKeys("fleet", rawFleet, [
				"default",
				"profiles",
				"rosters",
				"agentProfiles",
				"defaultNode",
				"adaptiveRouting",
				"nodes",
				"permissions",
				"concurrency",
				"staggerSharedPrefix",
				"keepPeerInstructionFiles",
				"worktrees",
				"retry",
				"limits",
				"history",
			]);
		}
	}
	if (rawFleet && "nodes" in rawFleet) {
		if (!Array.isArray(rawFleet.nodes)) issues.add("fleet.nodes", `expected a list, got ${describe(rawFleet.nodes)}`);
		else {
			const seen = new Set<string>();
			settings.fleet.nodes = rawFleet.nodes
				.map((entry, index) => validateFleetNode(issues, `fleet.nodes[${index}]`, entry, seen))
				.filter((entry): entry is FleetNodeConfig => entry !== null);
		}
	}
	const fleetNodeIds = new Set(settings.fleet.nodes.map((node) => node.id));
	if (rawFleet) {
		if ("defaultNode" in rawFleet) {
			const value = rawFleet.defaultNode;
			if (value === null || (typeof value === "string" && (value === "local" || fleetNodeIds.has(value))))
				settings.fleet.defaultNode = value;
			else issues.add("fleet.defaultNode", "expected null, local, or a fleet.nodes id");
		}
		if ("default" in rawFleet) {
			settings.fleet.default = validateRoute(
				issues,
				"fleet.default",
				rawFleet.default,
				settings.fleet.default,
				settings.targets,
				{
					nodeIds: fleetNodeIds,
				},
			);
		}
		if ("profiles" in rawFleet) {
			if (!isRecord(rawFleet.profiles)) issues.add("fleet.profiles", `expected a map, got ${describe(rawFleet.profiles)}`);
			else {
				const profiles: PancodeSettings["fleet"]["profiles"] = {};
				for (const [rawName, rawProfile] of Object.entries(rawFleet.profiles)) {
					const name = rawName.trim();
					if (!name) {
						issues.add("fleet.profiles", "empty profile name");
						continue;
					}
					const profile = validateRoute(
						issues,
						`fleet.profiles.${name}`,
						rawProfile,
						DEFAULT_SETTINGS.fleet.default,
						settings.targets,
						{
							nodeIds: fleetNodeIds,
						},
					);
					if (profile.target) profiles[name] = profile;
				}
				settings.fleet.profiles = profiles;
			}
		}
		if ("rosters" in rawFleet) {
			if (!isRecord(rawFleet.rosters)) issues.add("fleet.rosters", `expected a map, got ${describe(rawFleet.rosters)}`);
			else {
				const rosters: PancodeSettings["fleet"]["rosters"] = {};
				for (const [rawName, rawRoster] of Object.entries(rawFleet.rosters)) {
					const name = rawName.trim();
					const path = `fleet.rosters.${name}`;
					if (!name) {
						issues.add("fleet.rosters", "empty roster name");
						continue;
					}
					if (!isRecord(rawRoster)) {
						issues.add(path, `expected a map, got ${describe(rawRoster)}`);
						continue;
					}
					issues.unknownKeys(path, rawRoster, ["members"]);
					if (!Array.isArray(rawRoster.members)) {
						issues.add(`${path}.members`, "expected a list");
						continue;
					}
					if (rawRoster.members.length < 2 || rawRoster.members.length > 5)
						issues.add(`${path}.members`, "expected 2 to 5 members");
					const members: PancodeSettings["fleet"]["rosters"][string]["members"] = [];
					const labels = new Set<string>();
					for (const [index, rawMember] of rawRoster.members.entries()) {
						const memberPath = `${path}.members[${index}]`;
						if (!isRecord(rawMember)) {
							issues.add(memberPath, `expected a map, got ${describe(rawMember)}`);
							continue;
						}
						issues.unknownKeys(memberPath, rawMember, ["label", "target", "model", "thinkingLevel", "color", "agent"]);
						const label = expectString(issues, `${memberPath}.label`, rawMember.label);
						const target = expectString(issues, `${memberPath}.target`, rawMember.target);
						if (label !== undefined && !COUNCIL_MEMBER_LABEL_PATTERN.test(label))
							issues.add(`${memberPath}.label`, "expected [a-z][a-z0-9_-]{0,31}");
						if (label !== undefined && labels.has(label)) issues.add(`${memberPath}.label`, "duplicate label");
						if (label !== undefined) labels.add(label);
						if (target !== undefined && !settings.targets.some((entry) => entry.id === target))
							issues.add(`${memberPath}.target`, `unknown target '${target}'`);
						const model =
							rawMember.model === undefined ? undefined : expectString(issues, `${memberPath}.model`, rawMember.model);
						const thinkingLevel =
							rawMember.thinkingLevel === undefined
								? undefined
								: expectEnum(issues, `${memberPath}.thinkingLevel`, rawMember.thinkingLevel, THINKING_LEVELS);
						const color =
							rawMember.color === undefined ? undefined : expectString(issues, `${memberPath}.color`, rawMember.color);
						if (color !== undefined && !THEME_NAMED_COLORS.includes(color as never) && !/^#[0-9a-fA-F]{6}$/u.test(color)) {
							issues.add(`${memberPath}.color`, "expected a theme named color or 6-digit hex color");
						}
						const agent =
							rawMember.agent === undefined ? undefined : expectString(issues, `${memberPath}.agent`, rawMember.agent);
						if (agent === "auto") issues.add(`${memberPath}.agent`, "'auto' is not a council member agent");
						if (label === undefined || target === undefined) continue;
						members.push({
							label,
							target,
							...(model ? { model } : {}),
							...(thinkingLevel ? { thinkingLevel } : {}),
							...(color ? { color } : {}),
							...(agent && agent !== "auto" ? { agent } : {}),
						});
					}
					if (rawRoster.members.length >= 2 && rawRoster.members.length <= 5 && members.length === rawRoster.members.length)
						rosters[name] = { members };
				}
				settings.fleet.rosters = rosters;
			}
		}
		if ("agentProfiles" in rawFleet) {
			if (!isRecord(rawFleet.agentProfiles))
				issues.add("fleet.agentProfiles", `expected a map, got ${describe(rawFleet.agentProfiles)}`);
			else {
				const bindings: PancodeSettings["fleet"]["agentProfiles"] = {};
				for (const [rawAgentId, rawProfileName] of Object.entries(rawFleet.agentProfiles)) {
					const agentId = rawAgentId.trim();
					if (!agentId) {
						issues.add("fleet.agentProfiles", "empty agent id");
						continue;
					}
					if (agentId === "auto") {
						issues.add("fleet.agentProfiles", "'auto' is reserved for coordinator-owned agent selection");
						continue;
					}
					const profile = expectString(issues, `fleet.agentProfiles.${agentId}`, rawProfileName);
					if (profile !== undefined) bindings[agentId] = profile;
				}
				settings.fleet.agentProfiles = bindings;
			}
		}
		if ("adaptiveRouting" in rawFleet) {
			if (!isRecord(rawFleet.adaptiveRouting))
				issues.add("fleet.adaptiveRouting", `expected a map, got ${describe(rawFleet.adaptiveRouting)}`);
			else {
				const adaptive = rawFleet.adaptiveRouting;
				issues.unknownKeys("fleet.adaptiveRouting", adaptive, ["roles", "postures", "agentRoles"]);
				for (const [key, allowed] of [
					["roles", ACTIVE_ROUTING_ROLES],
					["postures", ACTIVE_ROUTING_POSTURES],
				] as const) {
					if (!(key in adaptive)) continue;
					const parsed = expectStringArray(issues, `fleet.adaptiveRouting.${key}`, adaptive[key]);
					if (parsed === undefined) continue;
					const allowedSet = new Set<string>(allowed);
					for (const value of parsed)
						if (!allowedSet.has(value))
							issues.add(`fleet.adaptiveRouting.${key}`, `unsupported ${key === "roles" ? "role" : "posture"} '${value}'`);
					if (parsed.every((value) => allowedSet.has(value))) settings.fleet.adaptiveRouting[key] = parsed as never;
				}
				if ("agentRoles" in adaptive) {
					if (!Array.isArray(adaptive.agentRoles)) issues.add("fleet.adaptiveRouting.agentRoles", "expected a list");
					else {
						const pairs: PancodeSettings["fleet"]["adaptiveRouting"]["agentRoles"] = [];
						const seen = new Set<string>();
						for (const [index, value] of adaptive.agentRoles.entries()) {
							const path = `fleet.adaptiveRouting.agentRoles[${index}]`;
							if (!isRecord(value)) {
								issues.add(path, "expected a map");
								continue;
							}
							issues.unknownKeys(path, value, ["agentId", "executionRole"]);
							const agentId = expectString(issues, `${path}.agentId`, value.agentId);
							const executionRole = expectEnum(issues, `${path}.executionRole`, value.executionRole, RUN_ROLES);
							if (agentId === "auto")
								issues.add(`${path}.agentId`, "'auto' is reserved for coordinator-owned agent selection");
							if (agentId === undefined || agentId === "auto" || executionRole === undefined) continue;
							const pairKey = `${agentId}\u0000${executionRole}`;
							if (seen.has(pairKey)) {
								issues.add(path, "duplicate agent and execution-role pair");
								continue;
							}
							seen.add(pairKey);
							pairs.push({ agentId, executionRole });
						}
						if (pairs.length === adaptive.agentRoles.length) settings.fleet.adaptiveRouting.agentRoles = pairs;
					}
				}
			}
		}
		if ("permissions" in rawFleet) {
			if (!isRecord(rawFleet.permissions))
				issues.add("fleet.permissions", `expected a map, got ${describe(rawFleet.permissions)}`);
			else {
				issues.unknownKeys("fleet.permissions", rawFleet.permissions, ["mode", "escalation"]);
				if ("mode" in rawFleet.permissions) {
					const parsed = expectEnum(issues, "fleet.permissions.mode", rawFleet.permissions.mode, WORKER_PERMISSION_MODES);
					if (parsed !== undefined) settings.fleet.permissions.mode = parsed;
				}
				if ("escalation" in rawFleet.permissions) {
					if (!isRecord(rawFleet.permissions.escalation))
						issues.add("fleet.permissions.escalation", `expected a map, got ${describe(rawFleet.permissions.escalation)}`);
					else {
						const escalation = rawFleet.permissions.escalation;
						issues.unknownKeys("fleet.permissions.escalation", escalation, ["timeoutMs", "fallback"]);
						if ("timeoutMs" in escalation) {
							// The escalation deadline is armed as a timer; past MAX_TIMER_DELAY_MS Node fires it at once. An integer
							// outside the range clamps to its nearer bound rather than failing the whole settings file.
							const parsed = expectInteger(issues, "fleet.permissions.escalation.timeoutMs", escalation.timeoutMs);
							if (parsed !== undefined)
								settings.fleet.permissions.escalation.timeoutMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, parsed));
						}
						if ("fallback" in escalation) {
							const parsed = expectEnum(issues, "fleet.permissions.escalation.fallback", escalation.fallback, [
								"deny",
								"fail",
							] as const);
							if (parsed !== undefined) settings.fleet.permissions.escalation.fallback = parsed;
						}
					}
				}
			}
		}
		if ("concurrency" in rawFleet) {
			if (rawFleet.concurrency === "auto") settings.fleet.concurrency = "auto";
			else {
				const parsed = expectInteger(issues, "fleet.concurrency", rawFleet.concurrency, { min: 1 });
				if (parsed !== undefined) settings.fleet.concurrency = parsed;
			}
		}
		if ("staggerSharedPrefix" in rawFleet) {
			const parsed = expectBoolean(issues, "fleet.staggerSharedPrefix", rawFleet.staggerSharedPrefix);
			if (parsed !== undefined) settings.fleet.staggerSharedPrefix = parsed;
		}
		if ("keepPeerInstructionFiles" in rawFleet) {
			const parsed = expectStringArray(issues, "fleet.keepPeerInstructionFiles", rawFleet.keepPeerInstructionFiles);
			if (parsed !== undefined) settings.fleet.keepPeerInstructionFiles = parsed;
		}
		if ("worktrees" in rawFleet) {
			const rawWorktrees = rawFleet.worktrees;
			if (!isRecord(rawWorktrees)) {
				issues.add("fleet.worktrees", `expected a mapping, got ${describe(rawWorktrees)}`);
			} else {
				issues.unknownKeys("fleet.worktrees", rawWorktrees, ["root"]);
				if ("root" in rawWorktrees) {
					const root = rawWorktrees.root;
					if (
						typeof root === "string" &&
						(root === "auto" || root === "tmpfs" || root === "disk" || (isAbsolute(root) && !root.includes("\0")))
					) {
						settings.fleet.worktrees.root = root;
					} else {
						issues.add(
							"fleet.worktrees.root",
							`expected auto, tmpfs, disk, or an absolute path, got ${describe(rawWorktrees.root)}`,
						);
					}
				}
			}
		}
		for (const [blockName, fields] of [
			[
				"retry",
				[
					["maxRetries", 0],
					["routeCooldownMs", 0],
					["breakerThreshold", 1],
				],
			],
			[
				"limits",
				[
					["toolCallsPerRun", 1],
					["runTimeoutMs", 1],
					["internalRunTimeoutMs", 1],
				],
			],
			["history", [["maxRuns", 1]]],
		] as const) {
			if (!(blockName in rawFleet)) continue;
			const block = rawFleet[blockName];
			if (!isRecord(block)) {
				issues.add(`fleet.${blockName}`, `expected a map, got ${describe(block)}`);
				continue;
			}
			const known = fields.map(([key]) => key);
			if (blockName === "history") known.push("journal" as never);
			issues.unknownKeys(`fleet.${blockName}`, block, known);
			for (const [key, min] of fields) {
				if (!(key in block)) continue;
				const parsed = expectInteger(issues, `fleet.${blockName}.${key}`, block[key], { min });
				if (parsed !== undefined) (settings.fleet[blockName] as unknown as Record<string, unknown>)[key] = parsed;
			}
			if (blockName === "history" && "journal" in block) {
				const parsed = expectBoolean(issues, "fleet.history.journal", block.journal);
				if (parsed !== undefined) settings.fleet.history.journal = parsed;
			}
		}
	}

	if ("context" in raw) {
		if (!isRecord(raw.context)) issues.add("context", `expected a map, got ${describe(raw.context)}`);
		else {
			const context = raw.context;
			issues.unknownKeys("context", context, ["toolResultMaxBytes", "workingSet", "compaction", "memory", "semantic"]);
			if ("toolResultMaxBytes" in context) {
				const parsed = expectInteger(issues, "context.toolResultMaxBytes", context.toolResultMaxBytes, { min: 4096 });
				if (parsed !== undefined) settings.context.toolResultMaxBytes = parsed;
			}
			if ("workingSet" in context) {
				if (!isRecord(context.workingSet))
					issues.add("context.workingSet", `expected a map, got ${describe(context.workingSet)}`);
				else {
					const workingSet = context.workingSet;
					issues.unknownKeys("context.workingSet", workingSet, [
						"enabled",
						"policy",
						"profile",
						"target",
						"protectLastTurns",
						"protectLastSteps",
						"minEvictableTokens",
						"rearmFraction",
					]);
					if ("enabled" in workingSet) {
						const parsed = expectBoolean(issues, "context.workingSet.enabled", workingSet.enabled);
						if (parsed !== undefined) settings.context.workingSet.enabled = parsed;
					}
					if ("policy" in workingSet) {
						const parsed = expectEnum(issues, "context.workingSet.policy", workingSet.policy, [
							"age-horizon",
							"structural-v1",
							"structural-v2",
						] as const);
						if (parsed !== undefined) settings.context.workingSet.policy = parsed;
					}
					if ("profile" in workingSet) {
						const parsed = expectEnum(issues, "context.workingSet.profile", workingSet.profile, WORKING_SET_PROFILE_IDS);
						if (parsed !== undefined) settings.context.workingSet.profile = parsed;
					}
					if ("target" in workingSet) {
						const parsed = expectNumber(issues, "context.workingSet.target", workingSet.target);
						if (parsed !== undefined && (parsed <= 0 || parsed >= 1))
							issues.add("context.workingSet.target", `expected a number > 0 and < 1, got ${parsed}`);
						else if (parsed !== undefined) settings.context.workingSet.target = parsed;
					}
					for (const [key, min] of [
						["protectLastTurns", 1],
						["protectLastSteps", 1],
						["minEvictableTokens", 0],
					] as const) {
						if (!(key in workingSet)) continue;
						const parsed = expectInteger(issues, `context.workingSet.${key}`, workingSet[key], { min });
						if (parsed !== undefined) settings.context.workingSet[key] = parsed;
					}
					if ("rearmFraction" in workingSet) {
						const parsed = expectNumber(issues, "context.workingSet.rearmFraction", workingSet.rearmFraction);
						if (parsed !== undefined && (parsed < 0 || parsed >= 1))
							issues.add("context.workingSet.rearmFraction", `expected a number >= 0 and < 1, got ${parsed}`);
						else if (parsed !== undefined) settings.context.workingSet.rearmFraction = parsed;
					}
				}
			}
			if ("compaction" in context) {
				if (!isRecord(context.compaction))
					issues.add("context.compaction", `expected a map, got ${describe(context.compaction)}`);
				else {
					const compaction = context.compaction;
					issues.unknownKeys("context.compaction", compaction, [
						"provider",
						"maxTokens",
						"auto",
						"threshold",
						"model",
						"systemPrompt",
					]);
					if ("auto" in compaction) {
						const parsed = expectBoolean(issues, "context.compaction.auto", compaction.auto);
						if (parsed !== undefined) settings.context.compaction.auto = parsed;
					}
					if ("threshold" in compaction) {
						const parsed = expectNumber(issues, "context.compaction.threshold", compaction.threshold, { min: 0, max: 1 });
						if (parsed !== undefined) settings.context.compaction.threshold = parsed;
					}
					if ("provider" in compaction) {
						const parsed = expectEnum(issues, "context.compaction.provider", compaction.provider, ["off", "native"] as const);
						if (parsed !== undefined) settings.context.compaction.provider = parsed;
					}
					if ("maxTokens" in compaction) {
						const parsed = expectInteger(issues, "context.compaction.maxTokens", compaction.maxTokens, { min: 1 });
						if (parsed !== undefined) settings.context.compaction.maxTokens = parsed;
					}
					for (const key of ["model", "systemPrompt"] as const) {
						if (!(key in compaction)) continue;
						const parsed = expectString(issues, `context.compaction.${key}`, compaction[key]);
						if (parsed !== undefined) settings.context.compaction[key] = parsed;
					}
				}
			}
			if ("memory" in context) {
				if (!isRecord(context.memory)) issues.add("context.memory", `expected a map, got ${describe(context.memory)}`);
				else {
					const memory = context.memory;
					issues.unknownKeys("context.memory", memory, [
						"enabled",
						"sideShare",
						"surfaces",
						"target",
						"model",
						"thinkingLevel",
						"cadenceToolCalls",
						"trajectorySteps",
						"maxOutputTokens",
						"timeoutMs",
					]);
					if ("enabled" in memory) {
						const parsed = expectBoolean(issues, "context.memory.enabled", memory.enabled);
						if (parsed !== undefined) settings.context.memory.enabled = parsed;
					}
					if ("sideShare" in memory) {
						const parsed = expectNumber(issues, "context.memory.sideShare", memory.sideShare, { min: 0 });
						if (parsed !== undefined) settings.context.memory.sideShare = parsed;
					}
					if ("surfaces" in memory) {
						if (!isRecord(memory.surfaces))
							issues.add("context.memory.surfaces", `expected a map, got ${describe(memory.surfaces)}`);
						else {
							issues.unknownKeys("context.memory.surfaces", memory.surfaces, [
								"observe",
								"delivery",
								"lessons",
								"correct",
								"bank",
								"history",
							]);
							if ("observe" in memory.surfaces) {
								const parsed = expectEnum(issues, "context.memory.surfaces.observe", memory.surfaces.observe, [
									"off",
									"on",
								] as const);
								if (parsed !== undefined) settings.context.memory.surfaces.observe = parsed;
							}
							if ("delivery" in memory.surfaces) {
								const parsed = expectEnum(
									issues,
									"context.memory.surfaces.delivery",
									memory.surfaces.delivery,
									MEMORY_DELIVERY_MODES,
								);
								if (parsed !== undefined) settings.context.memory.surfaces.delivery = parsed;
							}
							if ("lessons" in memory.surfaces) {
								const parsed = expectEnum(
									issues,
									"context.memory.surfaces.lessons",
									memory.surfaces.lessons,
									MEMORY_LESSONS_MODES,
								);
								if (parsed !== undefined) settings.context.memory.surfaces.lessons = parsed;
							}
							for (const key of ["correct", "bank"] as const) {
								if (!(key in memory.surfaces)) continue;
								const parsed = expectEnum(issues, `context.memory.surfaces.${key}`, memory.surfaces[key], [
									"rules",
									"model",
								] as const);
								if (parsed !== undefined) settings.context.memory.surfaces[key] = parsed;
							}
							if ("history" in memory.surfaces) {
								const parsed = expectEnum(issues, "context.memory.surfaces.history", memory.surfaces.history, [
									"off",
									"on",
								] as const);
								if (parsed !== undefined) settings.context.memory.surfaces.history = parsed;
							}
						}
					}
					if ("target" in memory) {
						if (memory.target === null) settings.context.memory.target = null;
						else {
							const parsed = expectString(issues, "context.memory.target", memory.target);
							if (parsed !== undefined)
								settings.context.memory.target = settings.targets.some((target) => target.id === parsed) ? parsed : null;
						}
					}
					if ("model" in memory) {
						if (memory.model === null) settings.context.memory.model = null;
						else {
							const parsed = expectString(issues, "context.memory.model", memory.model);
							if (parsed !== undefined) settings.context.memory.model = parsed;
						}
					}
					if (!settings.context.memory.target) settings.context.memory.model = null;
					else if (settings.context.memory.model === null)
						settings.context.memory.model =
							settings.targets.find((target) => target.id === settings.context.memory.target)?.defaultModel ?? null;
					if ("thinkingLevel" in memory) {
						const parsed = expectEnum(issues, "context.memory.thinkingLevel", memory.thinkingLevel, THINKING_LEVELS);
						if (parsed !== undefined) settings.context.memory.thinkingLevel = parsed;
					}
					for (const [key, min] of [
						["cadenceToolCalls", 2],
						["trajectorySteps", 1],
						["maxOutputTokens", 1],
						["timeoutMs", 1],
					] as const) {
						if (!(key in memory)) continue;
						const parsed = expectInteger(issues, `context.memory.${key}`, memory[key], { min });
						if (parsed !== undefined) settings.context.memory[key] = parsed;
					}
				}
			}
			if ("semantic" in context) {
				if (!isRecord(context.semantic))
					issues.add("context.semantic", `expected a map, got ${describe(context.semantic)}`);
				else {
					const semantic = context.semantic;
					issues.unknownKeys("context.semantic", semantic, [
						"enabled",
						"target",
						"model",
						"assetIdentity",
						"projectorIdentity",
						"canaryFingerprint",
						"modalities",
						"background",
						"inboxes",
					]);
					for (const key of ["enabled", "background"] as const) {
						if (!(key in semantic)) continue;
						const parsed = expectBoolean(issues, `context.semantic.${key}`, semantic[key]);
						if (parsed !== undefined) settings.context.semantic[key] = parsed;
					}
					for (const key of ["target", "model", "assetIdentity", "projectorIdentity", "canaryFingerprint"] as const) {
						if (!(key in semantic)) continue;
						if (semantic[key] === null) settings.context.semantic[key] = null;
						else {
							const parsed = expectString(issues, `context.semantic.${key}`, semantic[key]);
							if (parsed !== undefined) settings.context.semantic[key] = parsed;
						}
					}
					if ("modalities" in semantic) {
						if (!Array.isArray(semantic.modalities) || semantic.modalities.length === 0) {
							issues.add("context.semantic.modalities", "expected a nonempty list");
						} else {
							const modalities = semantic.modalities.map((value, index) =>
								expectEnum(issues, `context.semantic.modalities[${index}]`, value, SEMANTIC_MODALITIES),
							);
							if (
								modalities.every((value) => value !== undefined) &&
								new Set(modalities).size === modalities.length &&
								modalities.includes("text")
							)
								settings.context.semantic.modalities = modalities as typeof settings.context.semantic.modalities;
							else issues.add("context.semantic.modalities", "expected unique modalities including text");
						}
					}
					if ("inboxes" in semantic) {
						if (!Array.isArray(semantic.inboxes)) issues.add("context.semantic.inboxes", "expected a list");
						else {
							const inboxes: typeof settings.context.semantic.inboxes = [];
							const seen = new Set<string>();
							for (const [index, value] of semantic.inboxes.entries()) {
								const path = `context.semantic.inboxes[${index}]`;
								if (!isRecord(value)) {
									issues.add(path, "expected a map");
									continue;
								}
								issues.unknownKeys(path, value, ["id", "root", "scope", "project"]);
								const id = expectString(issues, `${path}.id`, value.id);
								const root = expectString(issues, `${path}.root`, value.root);
								const scope = expectEnum(issues, `${path}.scope`, value.scope, ["project", "global"] as const);
								const project = value.project === null ? null : expectString(issues, `${path}.project`, value.project);
								if (id !== undefined && (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || seen.has(id)))
									issues.add(`${path}.id`, "expected a unique lowercase id up to 32 characters");
								if (root !== undefined && (!isAbsolute(root) || root.includes("\0")))
									issues.add(`${path}.root`, "expected an absolute path without NUL");
								if (scope === "project" && (project === undefined || project === null || !isAbsolute(project)))
									issues.add(`${path}.project`, "project inbox requires an absolute project path");
								if (scope === "global" && project !== null) issues.add(`${path}.project`, "global inbox requires null project");
								if (id !== undefined && root !== undefined && scope !== undefined && project !== undefined) {
									seen.add(id);
									inboxes.push({ id, root, scope, project });
								}
							}
							settings.context.semantic.inboxes = inboxes;
						}
					}
				}
			}
		}
	}

	if ("systemOne" in raw) validateSystemOne(issues, raw.systemOne, settings);
	if ("safety" in raw) {
		if (!isRecord(raw.safety)) issues.add("safety", `expected a map, got ${describe(raw.safety)}`);
		else {
			const safety = raw.safety;
			issues.unknownKeys("safety", safety, [
				"autonomy",
				"limits",
				"review",
				"resources",
				"sandbox",
				"sandboxNetwork",
				"scratchRoots",
				"sandboxPassEnv",
				"liveCheckTargets",
				"sandboxUnixSockets",
				"sandboxUnconfinedLocalWorkers",
				"sandboxCacheMaxGiB",
				"snapshots",
				"validationWrappers",
				"unattendedAfterSeconds",
				"yoloAccepted",
				"yoloConfinement",
				"yoloUnconfinedAccepted",
				"judge",
			]);
			if ("autonomy" in safety) {
				const parsed = expectEnum(issues, "safety.autonomy", safety.autonomy, AUTONOMY_LEVELS);
				if (parsed !== undefined) settings.safety.autonomy = parsed;
			}
			if ("sandbox" in safety) {
				const parsed = expectEnum(issues, "safety.sandbox", safety.sandbox, SANDBOX_MODES);
				if (parsed !== undefined) settings.safety.sandbox = parsed;
			}
			readSandboxBooleans(issues, safety, settings.safety);
			if ("snapshots" in safety) {
				const parsed = expectEnum(issues, "safety.snapshots", safety.snapshots, WORKSPACE_SNAPSHOT_MODES);
				if (parsed !== undefined) settings.safety.snapshots = parsed;
			}
			if ("scratchRoots" in safety) {
				const parsed = expectStringArray(issues, "safety.scratchRoots", safety.scratchRoots);
				if (parsed !== undefined) {
					settings.safety.scratchRoots = parsed.filter((root) => {
						const problem = scratchRootProblem(root);
						if (problem !== null) issues.add("safety.scratchRoots", `${root}: ${problem}`);
						return problem === null;
					});
				}
			}
			if ("liveCheckTargets" in safety) {
				const parsed = expectStringArray(issues, "safety.liveCheckTargets", safety.liveCheckTargets);
				if (parsed !== undefined) {
					settings.safety.liveCheckTargets = [
						...new Set(
							parsed.filter((id) => {
								const target = settings.targets.find((candidate) => candidate.id === id);
								const problem =
									target === undefined
										? "no target with this id"
										: LIVE_CHECK_LOGIN_RUNTIMES.has(target.runtime)
											? null
											: `runtime ${target.runtime} has no login file PanCode can reveal (only ${[...LIVE_CHECK_LOGIN_RUNTIMES].join(", ")})`;
								if (problem !== null) issues.add("safety.liveCheckTargets", `${id}: ${problem}`);
								return problem === null;
							}),
						),
					];
				}
			}
			if ("sandboxPassEnv" in safety) {
				const parsed = expectStringArray(issues, "safety.sandboxPassEnv", safety.sandboxPassEnv);
				if (parsed !== undefined) {
					settings.safety.sandboxPassEnv = parsed.filter((name) => {
						const valid = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
						if (!valid) issues.add("safety.sandboxPassEnv", `${name}: not an environment variable name`);
						return valid;
					});
				}
			}
			if ("validationWrappers" in safety) {
				const parsed = expectStringArray(issues, "safety.validationWrappers", safety.validationWrappers);
				if (parsed !== undefined) {
					settings.safety.validationWrappers = parsed.filter((entry) => {
						const problem = validationWrapperProblem(entry);
						if (problem !== null) issues.add("safety.validationWrappers", `${JSON.stringify(entry)}: ${problem}`);
						return problem === null;
					});
				}
			}
			if ("sandboxUnixSockets" in safety) {
				const parsed = expectEnum(issues, "safety.sandboxUnixSockets", safety.sandboxUnixSockets, UNIX_SOCKET_MODES);
				if (parsed !== undefined) settings.safety.sandboxUnixSockets = parsed;
			}
			if ("sandboxCacheMaxGiB" in safety) {
				const parsed = expectNumber(issues, "safety.sandboxCacheMaxGiB", safety.sandboxCacheMaxGiB, { min: 0 });
				if (parsed !== undefined) settings.safety.sandboxCacheMaxGiB = parsed;
			}
			if ("yoloAccepted" in safety) {
				const parsed = expectBoolean(issues, "safety.yoloAccepted", safety.yoloAccepted);
				if (parsed !== undefined) settings.safety.yoloAccepted = parsed;
			}
			if ("yoloConfinement" in safety) {
				const parsed = expectEnum(issues, "safety.yoloConfinement", safety.yoloConfinement, YOLO_CONFINEMENTS);
				if (parsed !== undefined) settings.safety.yoloConfinement = parsed;
			}
			if ("yoloUnconfinedAccepted" in safety) {
				const parsed = expectBoolean(issues, "safety.yoloUnconfinedAccepted", safety.yoloUnconfinedAccepted);
				if (parsed !== undefined) settings.safety.yoloUnconfinedAccepted = parsed;
			}
			if ("unattendedAfterSeconds" in safety) {
				const parsed = expectInteger(issues, "safety.unattendedAfterSeconds", safety.unattendedAfterSeconds, { min: 0 });
				if (parsed !== undefined) settings.safety.unattendedAfterSeconds = parsed;
			}
			if ("judge" in safety) {
				if (!isRecord(safety.judge)) issues.add("safety.judge", `expected a map, got ${describe(safety.judge)}`);
				else {
					const judge = safety.judge;
					issues.unknownKeys("safety.judge", judge, ["enabled", "target", "model", "environment", "allow", "deny"]);
					if ("enabled" in judge) {
						const parsed = expectBoolean(issues, "safety.judge.enabled", judge.enabled);
						if (parsed !== undefined) settings.safety.judge.enabled = parsed;
					}
					if ("target" in judge && judge.target !== null) {
						const parsed = expectString(issues, "safety.judge.target", judge.target);
						if (parsed !== undefined && settings.targets.some((target) => target.id === parsed))
							settings.safety.judge.target = parsed;
						else if (parsed !== undefined) issues.add("safety.judge.target", `unknown target '${parsed}'`);
					}
					if ("model" in judge && judge.model !== null) {
						const parsed = expectString(issues, "safety.judge.model", judge.model);
						if (parsed !== undefined) settings.safety.judge.model = parsed;
					}
					for (const key of ["environment", "allow", "deny"] as const) {
						if (!(key in judge)) continue;
						const parsed = expectStringArray(issues, `safety.judge.${key}`, judge[key]);
						if (parsed !== undefined) settings.safety.judge[key] = parsed;
					}
				}
			}
			if ("limits" in safety) {
				if (!isRecord(safety.limits)) issues.add("safety.limits", `expected a map, got ${describe(safety.limits)}`);
				else {
					const limits = safety.limits;
					issues.unknownKeys("safety.limits", limits, [
						"sessionCostUsd",
						"chatToolCallsPerTurn",
						"readBytesPerCall",
						"observationBytesPerTurn",
						"templateToolCallsPerTurnMax",
						"templateObservationBytesPerTurnMax",
						"workerResponseSeconds",
						"autonomousToolCalls",
						"autonomousMinutes",
						"autonomousTokens",
						"bashIdleSeconds",
					]);
					if ("sessionCostUsd" in limits) {
						const parsed = expectNumber(issues, "safety.limits.sessionCostUsd", limits.sessionCostUsd, { min: 0 });
						if (parsed !== undefined) settings.safety.limits.sessionCostUsd = parsed;
					}
					for (const key of [
						"chatToolCallsPerTurn",
						"readBytesPerCall",
						"observationBytesPerTurn",
						"workerResponseSeconds",
					] as const) {
						if (!(key in limits)) continue;
						const parsed = expectInteger(issues, `safety.limits.${key}`, limits[key], { min: 1 });
						if (parsed !== undefined) settings.safety.limits[key] = parsed;
					}
					for (const key of ["autonomousToolCalls", "autonomousMinutes", "autonomousTokens", "bashIdleSeconds"] as const) {
						if (!(key in limits)) continue;
						const parsed = expectInteger(issues, `safety.limits.${key}`, limits[key], { min: 0 });
						if (parsed !== undefined) settings.safety.limits[key] = parsed;
					}
					for (const key of ["templateToolCallsPerTurnMax", "templateObservationBytesPerTurnMax"] as const) {
						if (!(key in limits)) continue;
						if (limits[key] === null) {
							settings.safety.limits[key] = null;
							continue;
						}
						const parsed = expectInteger(issues, `safety.limits.${key}`, limits[key], { min: 1 });
						if (parsed !== undefined) settings.safety.limits[key] = parsed;
					}
				}
			}
			if ("resources" in safety) validateSafetyResources(issues, safety.resources, settings);
			if ("review" in safety) validateSafetyReview(issues, safety.review, settings);
		}
	}

	if ("interface" in raw) {
		if (!isRecord(raw.interface)) issues.add("interface", `expected a map, got ${describe(raw.interface)}`);
		else {
			const ui = raw.interface;
			issues.unknownKeys("interface", ui, [
				"exitSummary",
				"demo",
				"outputDetail",
				"smoothStreaming",
				"mode",
				"fullscreenScrollbar",
				"terminalProgress",
				"desktopNotifications",
				"autoUpdate",
				"guiTurnCapacity",
				"panes",
				"keybindings",
			]);
			if ("guiTurnCapacity" in ui) {
				const parsed = expectInteger(issues, "interface.guiTurnCapacity", ui.guiTurnCapacity, { min: 1, max: 16 });
				if (parsed !== undefined) settings.interface.guiTurnCapacity = parsed;
			}
			for (const key of ["terminalProgress", "desktopNotifications", "demo", "autoUpdate"] as const) {
				if (!(key in ui)) continue;
				const parsed = expectBoolean(issues, `interface.${key}`, ui[key]);
				if (parsed !== undefined) (settings.interface as unknown as Record<string, unknown>)[key] = parsed;
			}
			if ("outputDetail" in ui) {
				const style = normalizeOutputStyle(ui.outputDetail);
				if (style) settings.interface.outputDetail = style;
				else issues.add("interface.outputDetail", "expected compact, standard, or detailed");
			}
			if ("exitSummary" in ui) {
				const style = normalizeExitSummaryStyle(ui.exitSummary);
				if (style) settings.interface.exitSummary = style;
				else issues.add("interface.exitSummary", "expected on or off");
			}
			for (const [key, allowed] of [
				["smoothStreaming", ["off", "auto", "on"]],
				["mode", ["regular", "fullscreen"]],
				["fullscreenScrollbar", ["hidden", "auto", "always"]],
			] as const) {
				if (!(key in ui)) continue;
				const parsed = expectEnum(issues, `interface.${key}`, ui[key], allowed);
				if (parsed !== undefined) (settings.interface as unknown as Record<string, unknown>)[key] = parsed;
			}
			if ("panes" in ui) {
				if (!isRecord(ui.panes)) issues.add("interface.panes", `expected a map, got ${describe(ui.panes)}`);
				else {
					const panes = ui.panes;
					issues.unknownKeys("interface.panes", panes, ["notifications", "layout", "workers", "files"]);
					if ("notifications" in panes) {
						const parsed = expectEnum(issues, "interface.panes.notifications", panes.notifications, [
							"failures",
							"all",
							"off",
						] as const);
						if (parsed !== undefined) settings.interface.panes.notifications = parsed;
					}
					if ("layout" in panes) {
						const parsed = expectEnum(issues, "interface.panes.layout", panes.layout, ["off", "workers", "cockpit"] as const);
						if (parsed !== undefined) settings.interface.panes.layout = parsed;
					}
					if ("workers" in panes) {
						if (!isRecord(panes.workers))
							issues.add("interface.panes.workers", `expected a map, got ${describe(panes.workers)}`);
						else {
							const workers = panes.workers;
							issues.unknownKeys("interface.panes.workers", workers, ["ratio"]);
							if ("ratio" in workers) {
								const parsed = expectNumber(issues, "interface.panes.workers.ratio", workers.ratio, {
									min: 0.05,
									max: 0.5,
								});
								if (parsed !== undefined) settings.interface.panes.workers.ratio = parsed;
							}
						}
					}
					if ("files" in panes) {
						if (!isRecord(panes.files)) issues.add("interface.panes.files", `expected a map, got ${describe(panes.files)}`);
						else {
							const files = panes.files;
							issues.unknownKeys("interface.panes.files", files, ["enabled", "mode", "profile", "followCwd", "ratio"]);
							for (const key of ["enabled", "followCwd"] as const) {
								if (!(key in files)) continue;
								const parsed = expectBoolean(issues, `interface.panes.files.${key}`, files[key]);
								if (parsed !== undefined) settings.interface.panes.files[key] = parsed;
							}
							if ("mode" in files) {
								const parsed = expectEnum(issues, "interface.panes.files.mode", files.mode, ["companion", "chooser"] as const);
								if (parsed !== undefined) settings.interface.panes.files.mode = parsed;
							}
							if ("profile" in files) {
								const parsed = expectEnum(issues, "interface.panes.files.profile", files.profile, ["managed", "user"] as const);
								if (parsed !== undefined) settings.interface.panes.files.profile = parsed;
							}
							if ("ratio" in files) {
								const parsed = expectNumber(issues, "interface.panes.files.ratio", files.ratio, { min: 0.05, max: 0.5 });
								if (parsed !== undefined) settings.interface.panes.files.ratio = parsed;
							}
						}
					}
				}
			}
			if ("keybindings" in ui)
				settings.interface.keybindings = validateKeybindings(issues, "interface.keybindings", ui.keybindings);
		}
	}

	if ("integrations" in raw) {
		if (!isRecord(raw.integrations)) issues.add("integrations", `expected a map, got ${describe(raw.integrations)}`);
		else {
			const integrations = raw.integrations;
			issues.unknownKeys("integrations", integrations, [
				"projectResources",
				"externalAgents",
				"runtimePlugins",
				"hub",
				"git",
			]);
			if ("projectResources" in integrations) {
				if (!isRecord(integrations.projectResources))
					issues.add("integrations.projectResources", `expected a map, got ${describe(integrations.projectResources)}`);
				else {
					issues.unknownKeys("integrations.projectResources", integrations.projectResources, ["trustProjectImports"]);
					if ("trustProjectImports" in integrations.projectResources) {
						const parsed = expectBoolean(
							issues,
							"integrations.projectResources.trustProjectImports",
							integrations.projectResources.trustProjectImports,
						);
						if (parsed !== undefined) settings.integrations.projectResources.trustProjectImports = parsed;
					}
				}
			}
			if ("runtimePlugins" in integrations) {
				const parsed = expectStringArray(issues, "integrations.runtimePlugins", integrations.runtimePlugins);
				if (parsed !== undefined) settings.integrations.runtimePlugins = parsed;
			}
			if ("hub" in integrations) {
				if (!isRecord(integrations.hub))
					issues.add("integrations.hub", `expected a map, got ${describe(integrations.hub)}`);
				else {
					const hub = integrations.hub;
					issues.unknownKeys("integrations.hub", hub, ["catalog", "remote", "confirmedRemote", "sync", "index"]);
					for (const key of ["catalog", "remote", "confirmedRemote"] as const) {
						if (!(key in hub)) continue;
						const value = hub[key];
						if (value !== null && typeof value !== "string")
							issues.add(`integrations.hub.${key}`, `expected a string or null, got ${describe(value)}`);
						else settings.integrations.hub[key] = value as string | null;
					}
					if ("sync" in hub) {
						const parsed = expectBoolean(issues, "integrations.hub.sync", hub.sync);
						if (parsed !== undefined) settings.integrations.hub.sync = parsed;
					}
					if ("index" in hub) {
						if (typeof hub.index !== "string")
							issues.add("integrations.hub.index", `expected a string, got ${describe(hub.index)}`);
						else settings.integrations.hub.index = hub.index.trim();
					}
				}
			}
			if ("git" in integrations) {
				if (!isRecord(integrations.git))
					issues.add("integrations.git", `expected a map, got ${describe(integrations.git)}`);
				else {
					issues.unknownKeys("integrations.git", integrations.git, ["commitAttribution", "commitAuthor"]);
					if ("commitAttribution" in integrations.git) {
						const parsed = expectBoolean(issues, "integrations.git.commitAttribution", integrations.git.commitAttribution);
						if (parsed !== undefined) settings.integrations.git.commitAttribution = parsed;
					}
					if ("commitAuthor" in integrations.git) {
						const parsed = expectEnum(issues, "integrations.git.commitAuthor", integrations.git.commitAuthor, [
							"auto",
							"human",
						] as const);
						if (parsed !== undefined) settings.integrations.git.commitAuthor = parsed;
					}
				}
			}
			if ("externalAgents" in integrations) {
				if (!isRecord(integrations.externalAgents))
					issues.add("integrations.externalAgents", `expected a map, got ${describe(integrations.externalAgents)}`);
				else {
					const external = integrations.externalAgents;
					issues.unknownKeys("integrations.externalAgents", external, ["entries", "defaults"]);
					if ("defaults" in external) {
						if (!isRecord(external.defaults))
							issues.add("integrations.externalAgents.defaults", `expected a map, got ${describe(external.defaults)}`);
						else {
							const defaults = external.defaults;
							issues.unknownKeys("integrations.externalAgents.defaults", defaults, [
								"connectTimeoutMs",
								"turnTimeoutMs",
								"permissionTimeoutMs",
								"toolGovernance",
							]);
							for (const key of ["connectTimeoutMs", "turnTimeoutMs", "permissionTimeoutMs"] as const) {
								if (!(key in defaults)) continue;
								const parsed = expectInteger(issues, `integrations.externalAgents.defaults.${key}`, defaults[key], {
									min: key === "turnTimeoutMs" ? 0 : 1,
									max: MAX_TIMER_DELAY_MS,
								});
								if (parsed !== undefined) settings.integrations.externalAgents.defaults[key] = parsed;
							}
							if ("toolGovernance" in defaults) {
								const parsed = expectEnum(
									issues,
									"integrations.externalAgents.defaults.toolGovernance",
									defaults.toolGovernance,
									TOOL_GOVERNANCE,
								);
								if (parsed !== undefined) settings.integrations.externalAgents.defaults.toolGovernance = parsed;
							}
						}
					}
					if ("entries" in external) {
						if (!Array.isArray(external.entries))
							issues.add("integrations.externalAgents.entries", `expected a list, got ${describe(external.entries)}`);
						else {
							const seen = new Set<string>();
							settings.integrations.externalAgents.entries = external.entries
								.map((entry, index) =>
									validateExternalAgent(
										issues,
										`integrations.externalAgents.entries[${index}]`,
										entry,
										settings.integrations.externalAgents.defaults,
										seen,
									),
								)
								.filter((entry): entry is ExternalAgent => entry !== null);
						}
					}
				}
			}
		}
	}

	if ("telemetry" in raw) validateTelemetry(issues, raw.telemetry, settings);
	if ("report" in raw) validateReport(issues, raw.report, settings);
	if ("prompts" in raw) validatePrompts(issues, raw.prompts, settings);
	if ("models" in raw) validateModels(issues, raw.models, settings);
	if ("store" in raw) validateStore(issues, raw.store, settings);

	return { settings, issues: issues.list, coercions: issues.coercions };
}
