// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import { ACTIVE_ROUTING_POSTURES, ACTIVE_ROUTING_ROLES, WORKER_PERMISSION_MODES } from "../../core/defaults.js";
import { getAtPath, resolveMemoryRoute } from "../../core/session-routing.js";
/** buildSettingItems: every row the settings center lists, with the fleet profile, agent binding and System 1 rows. */
import {
	formatControlValue,
	OFF_MENU_HAND_ROWS,
	SETTING_CONTROLS,
	settingControl,
	settingInactiveNote,
} from "../../core/settings-controls.js";
import type { Component } from "../../engine/tui.js";
import { visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "../theme/index.js";
import { fleetNodeSettingsSubmenu } from "./fleet-node-settings.js";
import {
	AUTO_PLACEMENT_CHOICE,
	type BuildSettingItemsOptions,
	PROFILE_FIELD_SEPARATOR,
	PROFILE_SUMMARY_VALUE_BUDGET,
	REMOVE_PROFILE_CHOICE,
	ROW_GAP,
	type SettingSubmenuBuilder,
	type SettingsCenterItem,
	SHIPPED_ESCALATION,
	SHIPPED_RESILIENCE_COOLDOWN_MS,
	SITE_OFF_CHOICE,
	UNBIND_CHOICE,
} from "./settings-center-model.js";
import { formatThreshold, truncateProfileFact } from "./settings-change-plan.js";
import {
	chainSubmenus,
	delegationAgentsAffordance,
	editEnumListSubmenu,
	editTextSubmenu,
	profileNameChoices,
	profileTargetChoices,
	scopedModelsSubmenu,
	selectListSubmenu,
	selectModelSubmenu,
	selectOptionalBackgroundTargetSubmenu,
	selectTargetSubmenu,
	textInputSubmenu,
} from "./settings-editors.js";
import {
	commonControlItem,
	maintenanceRows,
	settingItem,
	targetAddCta,
	targetUrlCta,
	thinkingChoices,
} from "./settings-item-rows.js";
import { fleetEndpointRows, fleetNodeRows, targetRows } from "./settings-target-rows.js";

export function buildSettingItems(
	settings: Readonly<PancodeSettings>,
	options?: BuildSettingItemsOptions,
): SettingsCenterItem[] {
	const live = options?.getSettings ?? ((): Readonly<PancodeSettings> => settings);
	const scopeList = settings.chat.modelPicker.cycleSet ?? [];
	const scopeText = scopeList.length > 0 ? scopeList.join(", ") : "(empty)";
	const compaction = settings.context.compaction;
	const retry = settings.chat.retry;
	const terminal = settings.interface;
	const watchdog = settings.safety.review;
	const panes = settings.interface.panes;
	const orchestratorThinking = thinkingChoices(
		options?.providers,
		settings.chat.target,
		settings.chat.model,
		settings.chat.thinkingLevel,
	);
	const workerThinking = thinkingChoices(
		options?.providers,
		settings.fleet.default.target,
		settings.fleet.default.model,
		settings.fleet.default.thinkingLevel,
	);
	const profileCount = Object.keys(settings.fleet.profiles ?? {}).length;
	const addProfileSubmenu = chainSubmenus(
		textInputSubmenu("New profile name"),
		() => selectListSubmenu("Select the profile's target", profileTargetChoices(live, options?.providers)),
		(name, target) => `${name} -> ${target}`,
	);
	const addBindingSubmenu = chainSubmenus(
		textInputSubmenu("Agent id to bind", "Native agents only, such as scout, researcher, or provenance."),
		(agentId) => selectListSubmenu(`Select the profile for ${agentId}`, profileNameChoices(live)),
		(agentId, profile) => `${agentId} -> ${profile}`,
	);
	const targetSubmenu = options?.providers ? selectTargetSubmenu(options.providers) : editTextSubmenu("Connection id");
	const orchestratorModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().chat.target ?? undefined)
		: editTextSubmenu("Type model name");
	const workerModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().fleet.default.target ?? undefined)
		: editTextSubmenu("Type model name");
	const backgroundTargetSubmenu = options?.providers
		? selectOptionalBackgroundTargetSubmenu(options.providers)
		: editTextSubmenu("Memory connection id", "Leave memory connection and model blank to use the chat route.");
	const backgroundModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().context.memory.target ?? undefined)
		: editTextSubmenu("Type memory model name");
	const memoryRoute = resolveMemoryRoute(settings);
	const memoryRouteNote = memoryRoute.source === "chat" ? "Chat route (no memory model set): " : "";
	// Both are optional in the settings type, so the row falls back to the
	// shipped value rather than rendering a blank for a key that is in force.
	const escalation = settings.fleet.permissions.escalation ?? SHIPPED_ESCALATION;
	const resilienceCooldownMs = settings.fleet.retry.routeCooldownMs ?? SHIPPED_RESILIENCE_COOLDOWN_MS;
	const workingSet = settings.context.workingSet;
	const safetyLimits = settings.safety.limits;
	const fleetLimits = settings.fleet.limits;
	const routing = settings.fleet.adaptiveRouting;
	const hub = settings.integrations.hub;
	const activeAgentRoles = routing.agentRoles;
	const favorites = settings.chat.modelPicker?.favorites ?? [];
	const agents = settings.integrations.externalAgents?.entries ?? [];
	const keybindingCount = Object.keys(settings.interface.keybindings ?? {}).length;
	const items: SettingsCenterItem[] = [
		...maintenanceRows(),
		settingItem("safety.autonomy", settings.safety.autonomy, {
			values: ["default", "yolo"],
		}),
		settingItem("fleet.permissions.mode", settings.fleet.permissions.mode ?? "judge", {
			values: WORKER_PERMISSION_MODES,
		}),
		settingItem("fleet.permissions.escalation.timeoutMs", String(escalation.timeoutMs), {
			affordance: "free text",
		}),
		settingItem("fleet.permissions.escalation.fallback", escalation.fallback, {
			values: ["deny", "fail"],
		}),
		settingItem(
			"integrations.externalAgents.defaults.toolGovernance",
			settings.integrations.externalAgents.defaults.toolGovernance,
			{
				values: ["pancode-policy", "agent-managed", "deny-all"],
			},
		),
		settingItem(
			"integrations.projectResources.trustProjectImports",
			String(settings.integrations.projectResources.trustProjectImports),
			{
				values: ["false", "true"],
			},
		),
		settingItem("safetyNet", "always on", {
			affordance: "tuned in .pancode/safety.yaml",
			readOnly: true,
		}),
		settingItem("chat.thinkingLevel", orchestratorThinking.display, {
			values: orchestratorThinking.values,
		}),
		settingItem("chat.target", settings.chat.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("chat.model", settings.chat.model ?? "(connection default)", {
			submenu: orchestratorModelSubmenu,
			editValue: settings.chat.model ?? "",
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("context.memory.target", `${memoryRouteNote}${memoryRoute.target ?? "(unset)"}`, {
			submenu: backgroundTargetSubmenu,
			editValue: settings.context.memory.target ?? "",
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem(
			"context.memory.model",
			memoryRoute.model ?? (memoryRoute.source === "chat" ? "(unset)" : "(connection default)"),
			{
				submenu: backgroundModelSubmenu,
				editValue: settings.context.memory.model ?? "",
				affordance: options?.providers ? "opens picker" : "free text",
			},
		),
		settingItem("context.memory.enabled", String(settings.context.memory.enabled), {
			values: ["true", "false"],
		}),
		settingItem("context.memory.cadenceToolCalls", String(settings.context.memory.cadenceToolCalls), {
			values: ["5", "10", "20", "30"],
		}),
		settingItem("context.memory.trajectorySteps", String(settings.context.memory.trajectorySteps), {
			values: ["4", "8", "12", "20"],
		}),
		settingItem("context.memory.maxOutputTokens", String(settings.context.memory.maxOutputTokens), {
			values: ["100", "200", "400", "800"],
		}),
		settingItem("context.memory.timeoutMs", String(settings.context.memory.timeoutMs), {
			values: ["5000", "10000", "20000", "30000", "60000"],
		}),
		settingItem("chat.prewarm", String(settings.chat.prewarm), {
			values: ["true", "false"],
		}),
		settingItem("fleet.default.target", settings.fleet.default.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("fleet.default.model", settings.fleet.default.model ?? "(connection default)", {
			submenu: workerModelSubmenu,
			editValue: settings.fleet.default.model ?? "",
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("fleet.default.thinkingLevel", workerThinking.display, {
			values: workerThinking.values,
		}),
		settingItem("fleet.retry.maxRetries", String(settings.fleet.retry.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
		settingItem("fleet.staggerSharedPrefix", String(settings.fleet.staggerSharedPrefix), { values: ["true", "false"] }),
		settingItem("fleet.retry.routeCooldownMs", String(resilienceCooldownMs), {
			affordance: "free text",
		}),
		...fleetProfileRows(settings, live, options),
		settingItem("fleet.profiles", "", {
			label: "Add profile",
			submenu: addProfileSubmenu,
			affordance: "Enter: name and route a new profile",
			presentationKind: "action",
			valueSegments: [],
		}),
		...agentBindingRows(settings, live),
		...systemOneRows(settings, live),
		settingItem("fleet.agentProfiles", "", {
			label: "Add agent route",
			...(profileCount > 0 ? { submenu: addBindingSubmenu } : { readOnly: true }),
			affordance: profileCount > 0 ? "Enter binds an agent" : "create a profile first",
			presentationKind: profileCount > 0 ? "action" : "read-only-fact",
			valueSegments: [],
		}),
		settingItem("fleet.adaptiveRouting.roles", routing.roles.length > 0 ? routing.roles.join(", ") : "(none)", {
			submenu: editEnumListSubmenu("Edit active routing roles", ACTIVE_ROUTING_ROLES),
			affordance: `free text from ${ACTIVE_ROUTING_ROLES.join(", ")}`,
			editValue: routing.roles.join(", "),
		}),
		settingItem("fleet.adaptiveRouting.postures", routing.postures.length > 0 ? routing.postures.join(", ") : "(none)", {
			submenu: editEnumListSubmenu("Edit active routing postures", ACTIVE_ROUTING_POSTURES),
			affordance: `free text from ${ACTIVE_ROUTING_POSTURES.join(", ")}`,
			editValue: routing.postures.join(", "),
		}),
		settingItem(
			"fleet.adaptiveRouting.agentRoles",
			activeAgentRoles.length > 0
				? activeAgentRoles.map((pair) => `${pair.agentId}/${pair.executionRole}`).join(", ")
				: "(none)",
			{},
		),
		...fleetNodeRows(
			options?.getFleetNodes?.() ?? [],
			options?.onFleetSettingsChanged
				? {
						text: textInputSubmenu,
						pick: selectListSubmenu,
						refresh: () => options.requestRefresh?.(),
						changed: options.onFleetSettingsChanged,
					}
				: undefined,
		),
		...(options?.onFleetSettingsChanged
			? [
					settingItem("fleet.nodes.add", "Add SSH node", {
						label: "Add SSH node",
						description: "Add a remote worker node with guided SSH setup and project verification.",
						presentationKind: "action",
						submenu: fleetNodeSettingsSubmenu("add", {
							text: textInputSubmenu,
							pick: selectListSubmenu,
							refresh: () => options.requestRefresh?.(),
							changed: options.onFleetSettingsChanged,
						}),
						affordance: "opens guided setup",
					}),
					settingItem("fleet.nodes.discover", "Discover with Tailscale", {
						label: "Discover with Tailscale",
						description: "Find Tailscale peers and review them before adding remote worker nodes.",
						presentationKind: "action",
						submenu: fleetNodeSettingsSubmenu("discover", {
							text: textInputSubmenu,
							pick: selectListSubmenu,
							refresh: () => options.requestRefresh?.(),
							changed: options.onFleetSettingsChanged,
						}),
						affordance: "optional peer discovery",
					}),
				]
			: []),
		settingItem("setting.fleet.defaultNode", settings.fleet.defaultNode ?? "(unset)", {
			label: "Standing worker node preference",
			description:
				"Unpinned work stays local. Leave unset to allow PanCode's once-per-session placement question; explicit and profile pins take priority.",
			submenu: selectListSubmenu("Standing worker node preference", [
				{ value: "(unset)", label: "No standing preference (local until chosen)" },
				{ value: "local", label: "Always prefer local" },
				...settings.fleet.nodes.map((node) => ({ value: node.id, label: `${node.id} (${node.host})` })),
			]),
			affordance: "opens placement picker",
		}),
		...fleetEndpointRows(options?.providers),
		settingItem("interface.panes.notifications", panes.notifications, { values: ["failures", "all", "off"] }),
		settingItem("interface.panes.layout", panes.layout, { values: ["off", "workers", "cockpit"] }),
		settingItem("interface.panes.workers.ratio", formatThreshold(panes.workers.ratio, "0.34"), {
			affordance: "free text",
		}),
		settingItem("fleet.history.journal", String(settings.fleet.history.journal), { values: ["true", "false"] }),
		settingItem("targets", "", {
			description: "Live inference target inventory and routing roles.",
			affordance: "column heading",
			readOnly: true,
			presentationKind: "group-header",
			valueSegments: [],
		}),
		...targetRows(settings, options),
		targetAddCta(),
		targetUrlCta(),
		settingItem("chat.modelPicker.cycleSet", scopeText, {
			submenu: scopedModelsSubmenu(scopeList, options?.providers),
			affordance: "opens provider-backed checklist",
		}),
		settingItem("chat.modelPicker.recentLimit", String(settings.chat.modelPicker.recentLimit), {
			values: ["6", "12", "20", "50"],
		}),
		settingItem("chat.modelPicker.favorites", favorites.length > 0 ? `${favorites.length} pinned` : "(none)", {}),
		settingItem("safety.limits.sessionCostUsd", String(settings.safety.limits.sessionCostUsd), {
			affordance: "free text",
		}),
		settingItem("chat.maxOutputTokens", String(settings.chat.maxOutputTokens), {
			values: ["0", "4096", "8192", "16384", "32768", "65536", "131072"],
		}),
		settingItem("context.toolResultMaxBytes", String(settings.context.toolResultMaxBytes), {
			values: ["4096", "8192", "16384", "32768", "65536", "131072"],
		}),
		settingItem("fleet.concurrency", String(settings.fleet.concurrency), {
			values: ["auto", "1", "2", "4", "8"],
		}),
		settingItem("safety.limits.chatToolCallsPerTurn", String(safetyLimits.chatToolCallsPerTurn), {
			affordance: "free text",
		}),
		settingItem("fleet.limits.toolCallsPerRun", String(fleetLimits.toolCallsPerRun), {
			affordance: "free text",
		}),
		settingItem("fleet.history.maxRuns", String(settings.fleet.history.maxRuns), {
			affordance: "free text",
		}),
		settingItem("safety.limits.readBytesPerCall", String(safetyLimits.readBytesPerCall), {
			affordance: "free text",
		}),
		settingItem("safety.limits.observationBytesPerTurn", String(safetyLimits.observationBytesPerTurn), {
			affordance: "free text",
		}),
		settingItem("fleet.limits.internalRunTimeoutMs", String(fleetLimits.internalRunTimeoutMs), {
			affordance: "free text",
		}),
		settingItem("context.compaction.auto", String(compaction.auto), {
			values: ["true", "false"],
		}),
		settingItem("context.compaction.threshold", formatThreshold(compaction.threshold), {
			values: ["0.7", "0.8", "0.85", "0.9"],
		}),
		settingItem("context.compaction.maxTokens", String(compaction.maxTokens ?? ""), {
			affordance: "free text",
		}),
		settingItem("context.compaction.provider", compaction.provider ?? "off", {
			values: ["off", "native"],
		}),
		settingItem("context.workingSet.enabled", String(workingSet.enabled), {
			values: ["true", "false"],
		}),
		settingItem("context.workingSet.policy", workingSet.policy, {
			values: ["structural-v1", "structural-v2", "age-horizon"],
		}),
		settingItem("context.workingSet.profile", workingSet.profile, {
			values: ["default", "data-analysis", "web-design"],
		}),
		settingItem("context.workingSet.target", formatThreshold(workingSet.target, "0.6"), {
			values: ["0.4", "0.5", "0.6", "0.7"],
		}),
		settingItem("context.workingSet.protectLastTurns", String(workingSet.protectLastTurns), {
			values: ["3", "6", "10", "15"],
		}),
		settingItem("context.workingSet.protectLastSteps", String(workingSet.protectLastSteps), {
			values: ["4", "8", "12", "20"],
		}),
		settingItem("context.workingSet.minEvictableTokens", String(workingSet.minEvictableTokens), {
			values: ["0", "100", "200", "500", "1000"],
		}),
		settingItem("context.workingSet.rearmFraction", formatThreshold(workingSet.rearmFraction, "0.1"), {
			values: ["0", "0.02", "0.05", "0.1"],
		}),
		settingItem("chat.retry.enabled", String(retry.enabled), {
			values: ["true", "false"],
		}),
		settingItem("chat.retry.maxRetries", String(retry.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
		settingItem("chat.retry.baseDelayMs", String(retry.baseDelayMs), {
			values: ["500", "1000", "2000", "5000", "10000"],
		}),
		settingItem("chat.retry.maxDelayMs", String(retry.maxDelayMs), {
			values: ["10000", "30000", "60000", "120000", "300000"],
		}),
		settingItem("chat.retry.streamStallMs", String(retry.streamStallMs), {
			values: ["60000", "120000", "180000", "300000", "600000"],
		}),
		settingItem("chat.retry.firstTokenStallMs", String(retry.firstTokenStallMs), {
			values: ["180000", "300000", "600000", "900000", "1800000"],
		}),
		settingItem("interface.terminalProgress", String(terminal.terminalProgress), {
			values: ["false", "true"],
		}),
		settingItem("interface.outputDetail", terminal.outputDetail, {
			values: ["compact", "standard", "detailed"],
		}),
		settingItem("interface.mode", terminal.mode, {
			values: ["regular", "fullscreen"],
		}),
		settingItem("interface.fullscreenScrollbar", terminal.fullscreenScrollbar, {
			values: ["hidden", "auto", "always"],
		}),
		settingItem("interface.smoothStreaming", terminal.smoothStreaming, {
			values: ["off", "auto", "on"],
		}),
		settingItem("interface.desktopNotifications", String(terminal.desktopNotifications), {
			values: ["false", "true"],
		}),
		settingItem("interface.panes.files.enabled", String(panes.files.enabled), { values: ["true", "false"] }),
		settingItem("interface.panes.files.mode", panes.files.mode, { values: ["companion", "chooser"] }),
		settingItem("interface.panes.files.profile", panes.files.profile, { values: ["managed", "user"] }),
		settingItem("interface.panes.files.followCwd", String(panes.files.followCwd), { values: ["true", "false"] }),
		settingItem("interface.panes.files.ratio", formatThreshold(panes.files.ratio, "0.3"), {
			affordance: "free text",
		}),
		settingItem("safety.review.enabled", String(watchdog.enabled), {
			values: ["false", "true"],
		}),
		// Both optional keys render their absence rather than a fabricated value:
		// an unset target means the session's own, and an unset cadence means the
		// watchdog fires at turn end only. Submitting an empty value clears them.
		settingItem("safety.review.target", watchdog.target ?? "(session target)", {
			submenu: editTextSubmenu("Edit watchdog target; blank uses the session's active target"),
			affordance: "free text",
			editValue: watchdog.target ?? "",
		}),
		settingItem(
			"safety.review.cadenceToolCalls",
			watchdog.cadenceToolCalls === undefined ? "(turn end only)" : String(watchdog.cadenceToolCalls),
			{
				affordance: "free text",
				editValue: watchdog.cadenceToolCalls === undefined ? "" : String(watchdog.cadenceToolCalls),
			},
		),
		settingItem(
			"integrations.runtimePlugins",
			settings.integrations.runtimePlugins.length > 0 ? settings.integrations.runtimePlugins.join(", ") : "(none)",
			{
				submenu: editTextSubmenu("Edit runtime plugins comma-separated list", "Restart PanCode to load changes."),
				affordance: "free text",
			},
		),
		settingItem(
			"integrations.git.commitAttribution",
			settings.integrations.git.commitAttribution ? "enabled" : "disabled",
			{
				values: ["enabled", "disabled"],
			},
		),
		settingItem("integrations.git.commitAuthor", settings.integrations.git.commitAuthor, {
			values: ["auto", "human"],
		}),
		settingItem("context.compaction.model", compaction.model ?? "(orchestrator target)", {
			submenu: editTextSubmenu("Edit compaction model; blank uses the orchestrator"),
			affordance: "free text",
		}),
		settingItem("context.compaction.systemPrompt", compaction.systemPrompt ?? "(built-in)", {
			submenu: editTextSubmenu("Edit compaction prompt path; blank uses the built-in"),
			affordance: "free text",
		}),
		settingItem(
			"integrations.externalAgents.defaults.connectTimeoutMs",
			String(settings.integrations.externalAgents.defaults.connectTimeoutMs),
			{
				affordance: "free text",
			},
		),
		settingItem(
			"integrations.externalAgents.defaults.turnTimeoutMs",
			String(settings.integrations.externalAgents.defaults.turnTimeoutMs),
			{
				affordance: "free text",
			},
		),
		settingItem(
			"integrations.externalAgents.defaults.permissionTimeoutMs",
			String(settings.integrations.externalAgents.defaults.permissionTimeoutMs),
			{
				affordance: "free text",
			},
		),
		settingItem("interface.keybindings", keybindingCount > 0 ? `${keybindingCount} override(s)` : "(defaults)", {}),
		settingItem("integrations.externalAgents.entries", agents.length > 0 ? `${agents.length} agent(s)` : "(none)", {
			...delegationAgentsAffordance(agents, options?.getInteropProposals?.() ?? []),
		}),
		settingItem("integrations.hub.catalog", hub.catalog ?? "(config directory)", {
			submenu: editTextSubmenu("Edit PanHub catalog path; blank uses the config directory"),
			affordance: "free text",
			editValue: hub.catalog ?? "",
		}),
		settingItem("integrations.hub.remote", hub.remote ?? "(local only)", {
			submenu: editTextSubmenu("Edit hub remote URL; blank keeps PanHub local"),
			affordance: "free text",
			editValue: hub.remote ?? "",
		}),
		// Confirming a remote from the settings row would be the trust record
		// confirming itself, so this row reports what the confirm flow wrote.
		settingItem("integrations.hub.confirmedRemote", hub.confirmedRemote ?? "(unconfirmed)", {
			affordance: "set by `pancode hub` on confirmation",
			readOnly: true,
		}),
		settingItem("integrations.hub.sync", String(hub.sync), {
			values: ["true", "false"],
		}),
	];
	for (const item of items) {
		const control = settingControl(item.configPath);
		if (control && item.presentationKind === "setting") {
			item.label = control.label;
			item.description = control.description;
		}
		if (
			control?.kind === "number" ||
			item.configPath === "fleet.concurrency" ||
			["chat.modelPicker.favorites", "interface.keybindings", "fleet.adaptiveRouting.agentRoles"].includes(item.id)
		) {
			if (control) {
				const replacement = commonControlItem(control, live);
				const value = getAtPath(settings, control.path);
				Object.assign(item, replacement, {
					id: item.id,
					section: item.section,
					currentValue: formatControlValue(value),
					editValue:
						value == null
							? ""
							: control.kind === "list"
								? (value as string[]).join(", ")
								: typeof value === "object"
									? JSON.stringify(value)
									: String(value),
				});
				// Object.assign keeps the hand row's old steps; left in place, Space previewed values Enter ignored.
				if (!replacement.values) delete item.values;
			}
		}
	}
	const listed = items.filter((item) => !OFF_MENU_HAND_ROWS.has(item.configPath));
	const paths = new Set(items.map((item) => item.configPath));
	return [
		...listed,
		...SETTING_CONTROLS.filter((control) => control.menu === true && !paths.has(control.path)).map((control) => {
			const item = commonControlItem(control, live);
			const value = getAtPath(settings, control.path);
			item.currentValue = formatControlValue(value);
			item.editValue =
				value == null
					? ""
					: control.kind === "list"
						? (value as string[]).join(", ")
						: typeof value === "object"
							? JSON.stringify(value)
							: String(value);
			return item;
		}),
	].map((item) => {
		const note = settingInactiveNote(item.configPath, settings);
		if (note) item.description += ` ${note}`;
		if (item.configPath === "safety.autonomy") item.description += ` ${yoloAcceptanceNote(settings)}`;
		return item;
	});
}

/** The acceptance records left the menu; the autonomy row still says what they hold and where. */
function yoloAcceptanceNote(settings: Readonly<PancodeSettings>): string {
	const yolo = settings.safety.yoloAccepted ? "accepted" : "not yet accepted";
	const unconfined = settings.safety.yoloUnconfinedAccepted ? "accepted" : "not accepted";
	return `Yolo is ${yolo}; unconfined yolo is ${unconfined} (safety.yoloAccepted and safety.yoloUnconfinedAccepted in settings.yaml).`;
}

function fleetProfileRows(
	settings: Readonly<PancodeSettings>,
	live: () => Readonly<PancodeSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingsCenterItem[] {
	const providers = options?.providers;
	return Object.entries(settings.fleet.profiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, profile]) => {
			const thinking = thinkingChoices(providers, profile.target, profile.model, profile.thinkingLevel);
			const target = profile.target ?? "(unset)";
			const model = profile.model ?? "(unset)";
			const placement = profile.node ?? "auto";
			const summary = `${target}/${model}  ${thinking.display}  ${placement}`;
			const compactThinking = truncateProfileFact(thinking.display, 7);
			const compactPlacement = truncateProfileFact(placement, 7);
			const route = target === settings.fleet.default.target ? model : `${target}/${model}`;
			const routeBudget = Math.max(
				8,
				PROFILE_SUMMARY_VALUE_BUDGET -
					visibleWidth(compactThinking) -
					visibleWidth(compactPlacement) -
					visibleWidth(ROW_GAP) * 2,
			);
			const compactRoute = truncateProfileFact(route, routeBudget);
			return settingItem(`fleet.profiles.${name}`, summary, {
				label: name,
				description: `Profile ${name}. Enter to edit its target, model, thinking level, placement, or remove it.`,
				help: "Choose a connection, model, thinking level, and where this worker runs.",
				submenu: profileWorkbenchSubmenu(name, settings, live, options),
				affordance: "Enter: drill into profile fields",
				valueSegments: [
					{ text: compactRoute, tone: "neutral" },
					{ text: `${ROW_GAP}${compactThinking}`, tone: "neutral" },
					{ text: `${ROW_GAP}${compactPlacement}`, tone: "neutral" },
				],
			});
		});
}

function profileWorkbenchSubmenu(
	name: string,
	settings: Readonly<PancodeSettings>,
	live: () => Readonly<PancodeSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingSubmenuBuilder {
	return (_currentValue: string, done: (value?: string) => void): Component => {
		const fields = [
			{ value: "target", label: "Edit target", presentationKind: "action" as const },
			{ value: "model", label: "Edit model", presentationKind: "action" as const },
			{ value: "thinkingLevel", label: "Edit thinking level", presentationKind: "action" as const },
			{ value: "node", label: "Edit placement", presentationKind: "action" as const },
			{
				value: "remove",
				label: "Remove profile",
				presentationKind: "destructive-action" as const,
			},
		];
		let active: Component;
		const openField = (field?: string): void => {
			if (!field) {
				done();
				return;
			}
			const profile = live().fleet.profiles[name];
			if (!profile) {
				done();
				return;
			}
			if (field === "remove") {
				done(REMOVE_PROFILE_CHOICE);
				return;
			}
			const finish = (value?: string): void =>
				done(value === undefined ? undefined : `${field}${PROFILE_FIELD_SEPARATOR}${value}`);
			if (field === "target") {
				active = selectListSubmenu(
					`Target for profile ${name}`,
					profileTargetChoices(live, options?.providers),
					"Changing the target rebases the model on that target's default.",
				)(profile.target ?? "(unset)", finish);
				return;
			}
			if (field === "model") {
				const submenu = options?.providers
					? selectModelSubmenu(options.providers, () => live().fleet.profiles[name]?.target ?? undefined)
					: editTextSubmenu("Type model name");
				active = submenu(profile.model ?? "(unset)", finish);
				return;
			}
			if (field === "thinkingLevel") {
				const thinking = thinkingChoices(options?.providers, profile.target, profile.model, profile.thinkingLevel);
				active = selectListSubmenu(
					`Thinking level for profile ${name}`,
					thinking.values.map((value) => ({ value, label: value })),
				)(thinking.display, finish);
				return;
			}
			active = selectListSubmenu(`Placement for profile ${name}`, profileNodeChoices(settings, options))(
				profile.node ?? AUTO_PLACEMENT_CHOICE,
				finish,
			);
		};
		const picker = selectListSubmenu(`Profile ${name}`, fields)("", openField);
		active = picker;
		return {
			render: (width: number) => active.render(width),
			handleInput: (data: string) => active.handleInput?.(data),
			invalidate: () => active.invalidate?.(),
		};
	};
}

/** Pin choices: auto placement, never-remote local, then every declared node (with live state when known). */
function profileNodeChoices(
	settings: Readonly<PancodeSettings>,
	options: BuildSettingItemsOptions | undefined,
): Array<{ value: string; label: string }> {
	const live = new Map(options?.getFleetNodes?.().map((node) => [node.id, node] as const) ?? []);
	return [
		{ value: AUTO_PLACEMENT_CHOICE, label: "Let PanCode choose" },
		{ value: "local", label: "local (never remote)" },
		...settings.fleet.nodes.map((node) => {
			const state = live.get(node.id);
			return {
				value: node.id,
				label: `${node.id} (${node.host}${state ? `, ${state.state}` : ""})`,
			};
		}),
	];
}

function agentBindingRows(
	settings: Readonly<PancodeSettings>,
	live: () => Readonly<PancodeSettings>,
): SettingsCenterItem[] {
	return Object.entries(settings.fleet.agentProfiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([agentId, profileName]) => {
			const missing = !settings.fleet.profiles[profileName];
			return settingItem(`fleet.agentProfiles.${agentId}`, profileName, {
				label: `${agentId} ${GLYPH.sep} profile`,
				description: missing
					? `Agent ${agentId} is bound to profile ${profileName}, which does not exist; it dispatches on the fleet default until the profile is created.`
					: `Profile agent ${agentId} dispatches with.`,
				submenu: selectListSubmenu(`Profile for ${agentId}`, [
					...profileNameChoices(live),
					{ value: UNBIND_CHOICE, label: "Remove assignment" },
				]),
			});
		});
}

/** The one System One row. Choosing a hosted target is the operator's consent to that evidence leaving the machine. */
function systemOneRows(
	settings: Readonly<PancodeSettings>,
	live: () => Readonly<PancodeSettings>,
): SettingsCenterItem[] {
	const engineNames = Object.keys(live().systemOne.engines);
	const targetNames = settings.targets.map((target) => target.id);
	const useChoices = [...new Set(["jev", "memory", "main", ...engineNames, ...targetNames])];
	const { use } = settings.systemOne;
	return [
		settingItem("systemOne.use", Array.isArray(use) ? use.join(", ") : (use ?? SITE_OFF_CHOICE), {
			label: "Decision engine",
			description:
				"Experimental opt-in. Off until chosen. It registers the consult tool on the next start, which sends the evidence the agent supplies, including the heads of files it names. A route also drives the judge screen, which sends web and MCP result text at judge time, and steering triage when that is on. main and memory add separate completions to that route; jev sends redacted state to TypeSafe.",
			submenu: selectListSubmenu("Decision engine", [
				{ value: SITE_OFF_CHOICE, label: "Off" },
				...useChoices.map((name) => ({ value: name, label: name })),
			]),
		}),
	];
}
