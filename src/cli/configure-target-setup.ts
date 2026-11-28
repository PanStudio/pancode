// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	bindAgentProfileInSettings,
	type PancodeSettings,
	readSettings,
	removeTargetFromSettings,
	settingsPath,
	updateSettings,
} from "../core/config.js";
import { initializePancodeHome } from "../core/init.js";
import { ensureClaudeAgentSdk } from "../domains/install/claude-sdk-install.js";
import {
	applyTargetCredentialPlan,
	openAuthStorage,
	planTargetCredentialRemoval,
	targetRequiresAuth,
} from "../domains/providers/auth/index.js";
import { prepareCopilotSdk } from "../domains/providers/copilot-setup.js";
import {
	buildProviderSupportEntry,
	configuredTargetsForRuntime,
	describeRuntimeModels,
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	recordProbedModelSnapshot,
	recordTargetCheck,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { greetLmStudio } from "../domains/providers/runtimes/common/lmstudio-http.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { registerPancodeOAuthProviders } from "../engine/oauth.js";
import { printError, printOk } from "./argv.js";
import { ask, askYesNo } from "./ask.js";
import type { ParsedArgs } from "./configure-args.js";
import { runInteropReview } from "./configure-interop.js";
import {
	type ConfigureCategory,
	formatCategoryMenu,
	formatRuntimeMenu,
	matchCategoryChoice,
} from "./configure-layout.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import type { ConfigurePrompts } from "./configure-prompts.js";
import {
	applyContextTier,
	applyTarget,
	assertOrchestratorReplacementEligible,
	buildDescriptor,
	chatPickerModels,
	contextTierProblem,
	defaultUrlFor,
	deriveTargetId,
	describeAuthStatus,
	gatewayUrlGuidance,
	inventoryNote,
	normalizeUrl,
	offeredUrlFor,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	preferredModelFor,
	probeLines,
	resolveSupportedWireModels,
	runtimeProbe,
	runtimesForCategory,
	setBackgroundPointer,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	setWorkerProfilePointer,
	targetApiKeyRef,
	targetUrlProblem,
	validateContextWindowOverride,
	validateResolvedModel,
	type WireModelInventory,
	warnUndiscoveredContextWindow,
} from "./configure-target.js";
import { offerCopilotSignIn } from "./copilot-sign-in.js";
import { credentialFileProtection, credentialWriteFailed, printPlaintextCredentialWarning } from "./shared.js";
import { terminalColumns } from "./text-layout.js";

export function ensureRegistryPopulated(): void {
	registerPancodeOAuthProviders();
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
}

function printSummary(settings: PancodeSettings, descriptor: TargetDescriptor, probe: ProbeResult | null): void {
	process.stdout.write(`\nsaved connection ${descriptor.id} (runtime=${descriptor.runtime})\n`);
	if (descriptor.url) process.stdout.write(`  url        ${descriptor.url}\n`);
	if (descriptor.defaultModel) process.stdout.write(`  model      ${descriptor.defaultModel}\n`);
	if (descriptor.auth?.apiKeyEnvVar) process.stdout.write(`  apiKeyEnv  ${descriptor.auth.apiKeyEnvVar}\n`);
	if (descriptor.gateway) process.stdout.write("  gateway    true\n");
	if (descriptor.lifecycle) process.stdout.write(`  lifecycle  ${descriptor.lifecycle}\n`);
	if (descriptor.contextTier) process.stdout.write(`  contextTier ${descriptor.contextTier}\n`);
	if (probe) {
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`  ${line}\n`);
	}
	warnUndiscoveredContextWindow(descriptor, probe);
	if (settings.chat.connection === descriptor.id) process.stdout.write("  orchestrator connection\n");
	if (settings.context.memory.connection === descriptor.id) process.stdout.write("  background memory connection\n");
	if (settings.fleet.default.connection === descriptor.id) process.stdout.write("  fleet default\n");
	for (const [name, profile] of Object.entries(settings.fleet.profiles)) {
		if (profile.connection === descriptor.id) process.stdout.write(`  fleet profile ${name}\n`);
	}
	process.stdout.write(`\nsettings written to ${settingsPath()}\n`);
}

function resolveModelChoice(
	answer: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): string | undefined {
	if (answer.length === 0) return defaultValue;
	const numeric = Number(answer);
	if (Number.isInteger(numeric) && numeric >= 1 && numeric <= wireModels.length) {
		return wireModels[numeric - 1];
	}
	return answer;
}

async function askModelChoice(
	rl: ConfigurePrompts,
	label: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): Promise<string | null> {
	const answer = await ask(rl, `${label} (number or id)`, defaultValue ?? "");
	if (answer === null) return null;
	return resolveModelChoice(answer, wireModels, defaultValue) ?? "";
}

/**
 * A catalog-ordered list has no head worth persisting: openai's first of 38 ids
 * is `gpt-4` because g sorts early, and a target configured without --model
 * used to carry it as the model the operator chose.
 */
function refuseCatalogSeededModel(runtime: RuntimeDescriptor, support: ProviderSupportEntry): void {
	printError(
		`--model is required for ${runtime.id}: its ${support.modelHints.length} model ids come from the provider catalog in name order, which recommends none of them`,
	);
	process.stderr.write(
		`  run \`pancode configure --runtime ${runtime.id}\` with no other flags to choose from the full list\n`,
	);
}

export async function runNonInteractive(runtime: RuntimeDescriptor, args: ParsedArgs): Promise<number> {
	if (!args.id) {
		printError("--id is required when passing flags non-interactively");
		return 2;
	}
	if (args.workerProfileModel !== undefined && args.workerProfile === undefined) {
		printError("--agent-profile-model requires --agent-profile");
		return 2;
	}
	if (args.bindAgent !== undefined && args.workerProfile === undefined) {
		printError("--bind-agent requires --agent-profile");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerProfile.trim().length === 0) {
		printError("--agent-profile must be non-empty");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerModel !== undefined) {
		printError(
			"--fleet-model and --agent-profile conflict; use --agent-profile-model for the profile, or drop --agent-profile to set the fleet default",
		);
		return 2;
	}
	const tierProblem = contextTierProblem(runtime, args.contextTier);
	if (tierProblem !== null) {
		printError(tierProblem);
		return 2;
	}
	if (runtime.id === "claude-sdk") {
		try {
			await ensureClaudeAgentSdk();
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	if (runtime.id === "copilot-sdk") {
		// Non-interactive: the target is written either way; a missing component or login is named as a warning.
		const ready = await prepareCopilotSdk({ print: (text) => process.stdout.write(`${text}\n`) });
		if (!ready.ok) process.stderr.write(`warning: ${ready.message}\n`);
	}
	initializePancodeHome();
	const settings = readSettings();
	const auth = openAuthStorage();
	const support = buildProviderSupportEntry(runtime);
	const existing = settings.connections.find((e) => e.id === args.id);
	if (existing && (getRuntimeRegistry().get(existing.runtime)?.id ?? existing.runtime) !== runtime.id) {
		printError(`connection ${args.id} already exists with runtime ${existing.runtime}`);
		return 2;
	}
	const argsUrlProblem = args.url ? targetUrlProblem(args.url) : null;
	if (argsUrlProblem !== null) {
		printError(`--url: ${argsUrlProblem}`);
		return 2;
	}
	let url: string | undefined = args.url ? normalizeUrl(args.url, runtime.id) : existing?.url;
	if (!url && support.supportsCustomUrl) {
		url = offeredUrlFor(runtime);
	}
	if (!url && runtime.gatewayUrl) {
		printError(`--url is required for ${runtime.id}: give the ${runtime.gatewayUrl.label}`);
		for (const line of gatewayUrlGuidance(runtime)) process.stderr.write(`  ${line}\n`);
		return 2;
	}
	if (url && runtime.id === "lmstudio") {
		const greeting = await greetLmStudio(
			{ id: args.id, runtime: runtime.id, url },
			{ credentialsPresent: new Set(), httpTimeoutMs: 750 },
		);
		if (!greeting.ok) {
			printError(`refusing to save LM Studio connection '${args.id}': ${url} did not return the LM Studio greeting`);
			return 2;
		}
	}
	if (url && (runtime.id === "openai-compat" || runtime.id === "anthropic-compat")) {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint) {
			process.stdout.write(
				`note: detected ${fingerprint.displayName} at ${url}; consider \`pancode connections convert ${args.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle\n`,
			);
		}
	}
	const authStatus = auth.statusForTarget(
		existing ? resolveAuthTarget(existing, runtime) : resolveRuntimeAuthTarget(runtime),
		{ includeFallback: false },
	);
	const apiKeyEnv = args.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar;
	const apiKeyRef =
		runtime.auth === "api-key" && (args.apiKey || existing?.auth?.apiKeyRef || authStatus.source === "stored-api-key")
			? args.apiKey
				? targetApiKeyRef(args.id, settings.connections)
				: (existing?.auth?.apiKeyRef ?? runtime.id)
			: undefined;
	const oauthProfile =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const seed: TargetDescriptor = {
		...existing,
		...buildDescriptor(runtime, args.id, {
			...(url !== undefined ? { url } : {}),
			...(args.model !== undefined
				? { model: args.model }
				: existing?.defaultModel
					? { model: existing.defaultModel }
					: support.defaultModel
						? { model: support.defaultModel }
						: {}),
			...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
			...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
			...(oauthProfile !== undefined ? { oauthProfile } : {}),
			gateway: args.gateway || existing?.gateway === true,
			...(args.lifecycle !== undefined
				? { lifecycle: args.lifecycle }
				: existing?.lifecycle !== undefined
					? { lifecycle: existing.lifecycle }
					: {}),
			...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
			...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
			...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
			...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
			...(existing?.litellm ? { litellm: existing.litellm } : {}),
			...(existing?.ollama ? { ollama: existing.ollama } : {}),
		}),
	};
	seed.capabilities = { ...existing?.capabilities, ...seed.capabilities };
	if (seed.auth) seed.auth = { ...existing?.auth, ...seed.auth };
	applyContextTier(seed, args.contextTier);
	const inventory = await resolveSupportedWireModels(runtime, seed, existing, args.apiKey);
	const model = args.model ?? existing?.defaultModel ?? preferredModelFor(inventory, support);
	if (model === undefined && support.modelSource === "catalog") {
		refuseCatalogSeededModel(runtime, support);
		return 2;
	}
	const fallback = inventory.probeError !== undefined ? inventoryNote(runtime, inventory) : null;
	if (model !== undefined && fallback !== null) {
		process.stderr.write(`warning: model '${model}' was checked against the ${fallback}\n`);
	}
	if (!validateResolvedModel(runtime, seed, model, args.force, inventory)) return 2;
	if (!validateContextWindowOverride(runtime, model, args.contextWindow, args.force)) return 2;
	const descriptor: TargetDescriptor = {
		...existing,
		...buildDescriptor(runtime, args.id, {
			...(url !== undefined ? { url } : {}),
			...(model ? { model } : {}),
			...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
			...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
			...(oauthProfile !== undefined ? { oauthProfile } : {}),
			gateway: args.gateway || existing?.gateway === true,
			...(args.lifecycle !== undefined
				? { lifecycle: args.lifecycle }
				: existing?.lifecycle !== undefined
					? { lifecycle: existing.lifecycle }
					: {}),
			...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
			...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
			...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
			...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
			...(existing?.litellm ? { litellm: existing.litellm } : {}),
			...(existing?.ollama ? { ollama: existing.ollama } : {}),
		}),
	};
	descriptor.capabilities = { ...existing?.capabilities, ...descriptor.capabilities };
	if (descriptor.auth) descriptor.auth = { ...existing?.auth, ...descriptor.auth };
	applyContextTier(descriptor, args.contextTier);
	const setOrchestrator = args.setOrchestrator || args.orchestratorModel !== undefined;
	const setBackground = args.setBackground || args.backgroundModel !== undefined;
	if ((setOrchestrator || setBackground) && !isOrchestratorEligibleRuntime(runtime)) {
		printError(
			`cannot use connection '${descriptor.id}' as a chat or background connection because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
		return 1;
	}
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (args.verify === true) {
		if (!descriptor.defaultModel) {
			printError(`--verify needs a model for connection ${args.id}; pass --model`);
			return 2;
		}
		const { chatTestFix, sendChatTest } = await import("./chat-test.js");
		const key = args.apiKey ?? (apiKeyEnv !== undefined ? process.env[apiKeyEnv] : undefined);
		const outcome = await sendChatTest({
			runtime,
			target: descriptor,
			model: descriptor.defaultModel,
			...(key !== undefined && key !== "" ? { apiKey: key } : {}),
		});
		if (!outcome.ok) {
			printError(
				`test request to ${args.id} / ${descriptor.defaultModel} failed: ${outcome.message}. ${chatTestFix(outcome, {
					provider: runtime.displayName,
					model: descriptor.defaultModel,
					...(url !== undefined ? { url } : {}),
				})} Nothing was saved.`,
			);
			return 1;
		}
		recordTargetCheck(descriptor, descriptor.defaultModel, outcome.latencyMs);
		process.stdout.write(
			`Testing ${args.id} / ${descriptor.defaultModel} ... answered in ${(outcome.latencyMs / 1000).toFixed(1)} s.\n`,
		);
	}
	if (args.apiKey && apiKeyRef) {
		auth.setApiKey(apiKeyRef, args.apiKey);
		// Bailing here leaves nothing half-done: settings are not touched until
		// applyConfiguration below, so a refused credential write means the whole
		// command changed nothing, which is what the non-zero exit now claims.
		if (
			credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; connection '${descriptor.id}' not saved`)
		)
			return 1;
		printPlaintextCredentialWarning();
	}
	const setWorkerDefault = args.setWorkerDefault || (args.workerProfile === undefined && args.workerModel !== undefined);
	const applyConfiguration = (target: PancodeSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator)
			setOrchestratorPointer(target, descriptor, args.orchestratorModel ?? descriptor.defaultModel ?? null);
		if (setBackground) setBackgroundPointer(target, descriptor, args.backgroundModel ?? descriptor.defaultModel ?? null);
		if (setWorkerDefault)
			setWorkerDefaultPointer(target, descriptor, args.workerModel ?? descriptor.defaultModel ?? null);
		if (args.workerProfile !== undefined) {
			setWorkerProfilePointer(
				target,
				args.workerProfile,
				descriptor,
				args.workerProfileModel ?? descriptor.defaultModel ?? null,
			);
			if (args.bindAgent !== undefined) bindAgentProfileInSettings(target, args.bindAgent, args.workerProfile);
		}
	};
	// Apply to the local snapshot for the summary below, then persist the same
	// mutation against the freshest on-disk state under the settings lock so a
	// concurrent session's field-level write-through is never lost.
	applyConfiguration(settings);
	updateSettings(applyConfiguration);
	const probe = await runtimeProbe(runtime, descriptor, args.apiKey);
	if (probe) recordProbedModelSnapshot(descriptor, runtime, probe);
	printSummary(settings, descriptor, probe);
	if (
		runtime.auth === "oauth" &&
		!auth.statusForTarget(existing ? resolveAuthTarget(existing, runtime) : resolveRuntimeAuthTarget(runtime), {
			includeFallback: false,
		}).available
	) {
		process.stdout.write(
			`note: authenticate ${runtime.id} with \`pancode auth login ${runtime.id}\` before using this connection\n`,
		);
	}
	if (args.apiKeyEnv !== undefined && !process.env[args.apiKeyEnv]) {
		process.stderr.write(
			`warning: ${args.apiKeyEnv} is not set in this shell; export it before using connection ${args.id}\n`,
		);
	}
	printOk(`connection ${args.id} saved`);
	return 0;
}

async function pickRuntimeFromEntries(
	rl: ConfigurePrompts,
	entries: ReadonlyArray<ProviderSupportEntry>,
	heading: string,
): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	if (entries.length === 0) {
		process.stderr.write("no runtimes available in this category\n");
		return null;
	}
	process.stdout.write(`${heading}\n`);
	const menu = formatRuntimeMenu(
		entries.map((entry) => ({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			summary: entry.summary,
		})),
		terminalColumns(),
	);
	for (const line of menu) process.stdout.write(`${line}\n`);
	const allowedIds = new Set(entries.map((entry) => entry.runtimeId));
	// A default here reads as a recommendation, and the only basis this list has
	// for one is the featured flag. Falling back to the first entry made the
	// default whatever sorted first by label, so the bucket that advertises
	// llama.cpp, vLLM, and SGLang offered Antigravity CLI to anyone who pressed
	// Enter. With no featured entry there is no recommendation to make, and Enter
	// asks again rather than choosing on the user's behalf.
	const defaultRuntimeId = entries.find((entry) => entry.featured)?.runtimeId ?? "";
	for (;;) {
		const answer = await ask(rl, "\nSelection (number or runtime id)", defaultRuntimeId);
		if (answer === null) return null;
		if (answer.length === 0) {
			process.stderr.write(`pick a number from 1 to ${entries.length}, or type a runtime id\n`);
			continue;
		}
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
			const picked = entries[numeric - 1];
			if (picked) {
				const runtime = registry.get(picked.runtimeId);
				if (runtime) return runtime;
			}
		}
		if (allowedIds.has(answer)) {
			const match = registry.get(answer);
			if (match) return match;
		}
		process.stderr.write(`unknown runtime id for this category: ${answer}\n`);
	}
}

async function pickCategory(rl: ConfigurePrompts): Promise<ConfigureCategory | null> {
	process.stdout.write("\nHow will you connect PanCode to a model?\n\n");
	for (const line of formatCategoryMenu(terminalColumns())) process.stdout.write(`${line}\n`);
	for (;;) {
		const answer = await ask(rl, "\nSelection", "1");
		if (answer === null) return null;
		if (answer.length === 0) continue;
		const category = matchCategoryChoice(answer);
		if (category) return category;
		process.stderr.write(`invalid choice: ${answer}\n`);
	}
}

export async function pickRuntimeViaCategory(rl: ConfigurePrompts): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	const allEntries = listProviderSupportEntries(registry.list());
	const category = await pickCategory(rl);
	if (category === null) return null;
	const filtered = runtimesForCategory(allEntries, category);
	if (filtered.length === 0) {
		process.stderr.write("no runtimes are available in that category in this installation\n");
		return null;
	}
	if (filtered.length === 1) {
		const only = filtered[0];
		if (only) {
			const runtime = registry.get(only.runtimeId);
			if (runtime) {
				process.stdout.write(`\nUsing ${runtime.id} (${only.summary}).\n`);
				return runtime;
			}
		}
	}
	const heading =
		category === "local-app"
			? "\nApps on this computer:"
			: category === "local-server"
				? "\nModel servers:"
				: category === "subscription"
					? "\nAI subscriptions:"
					: category === "external-worker"
						? "\nInstalled coding agents:"
						: "\nProvider APIs:";
	return pickRuntimeFromEntries(rl, filtered, heading);
}

async function maybeSteerToNativeRuntime(
	rl: ConfigurePrompts,
	currentRuntime: RuntimeDescriptor,
	url: string,
): Promise<RuntimeDescriptor> {
	if (currentRuntime.id !== "openai-compat" && currentRuntime.id !== "anthropic-compat") return currentRuntime;
	const fingerprint = await fingerprintNativeRuntime(url);
	if (!fingerprint) return currentRuntime;
	const native = getRuntimeRegistry().get(fingerprint.runtimeId);
	if (!native) return currentRuntime;
	process.stdout.write(`\nDetected ${fingerprint.displayName} at ${url}.\n`);
	const switchIt = await askYesNo(rl, `Use ${fingerprint.runtimeId} runtime instead of ${currentRuntime.id}?`, true);
	if (!switchIt) return currentRuntime;
	process.stdout.write(`Using ${fingerprint.runtimeId} runtime.\n`);
	return native;
}

export async function runTargetSetupInteractive(
	rl: ConfigurePrompts,
	runtime: RuntimeDescriptor,
	defaults: ParsedArgs,
): Promise<number> {
	if (runtime.id === "claude-sdk") {
		try {
			await ensureClaudeAgentSdk({
				...((rl.input as { isTTY?: boolean }).isTTY === true
					? { confirm: (question: string) => askYesNo(rl, question, false) }
					: {}),
			});
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
	if (runtime.id === "copilot-sdk") {
		const ready = await prepareCopilotSdk({
			...((rl.input as { isTTY?: boolean }).isTTY === true
				? {
						confirm: (question: string) => askYesNo(rl, question, false),
						signIn: () =>
							offerCopilotSignIn({
								confirm: (question) => askYesNo(rl, question, true),
								print: (text) => process.stdout.write(`${text}\n`),
							}),
					}
				: {}),
			print: (text) => process.stdout.write(`${text}\n`),
		});
		if (!ready.ok) {
			printError(ready.message);
			return 1;
		}
	}
	const auth = openAuthStorage();
	const settings = readSettings();
	let support = buildProviderSupportEntry(runtime);
	const initialRuntimeId = runtime.id;
	const existingForRuntime = configuredTargetsForRuntime(settings, initialRuntimeId);
	const existing = defaults.id
		? (settings.connections.find((entry) => entry.id === defaults.id && entry.runtime === initialRuntimeId) ?? null)
		: null;
	if (existingForRuntime.length > 0) {
		process.stdout.write(`\nExisting connections for ${runtime.id}:\n`);
		for (const target of existingForRuntime) {
			process.stdout.write(`  - ${target.id}${target.defaultModel ? ` (${target.defaultModel})` : ""}\n`);
		}
	}
	process.stdout.write(`\nSelected runtime: ${runtime.id} (${support.summary})\n`);
	process.stdout.write(`Credentials: ${describeAuthStatus(runtime, existing ?? undefined)}\n`);
	if (support.modelHints.length > 0) {
		process.stdout.write(`Known models: ${describeRuntimeModels(support, 4)}\n`);
	}
	const suggestedId = defaults.id ?? existing?.id ?? deriveTargetId(runtime.id, settings.connections);
	const idInput = await ask(rl, "Connection id", suggestedId);
	if (idInput === null || idInput.length === 0) {
		printError("connection id is required");
		return 2;
	}
	const targetId = idInput;

	let url: string | undefined = existing?.url;
	if (runtime.gatewayUrl) {
		process.stdout.write(`\n${runtime.gatewayUrl.label}:\n`);
		for (const line of gatewayUrlGuidance(runtime)) process.stdout.write(`  ${line}\n`);
		for (;;) {
			const urlInput = await ask(rl, runtime.gatewayUrl.label, defaults.url ?? existing?.url);
			if (urlInput === null) return 0;
			const problem = urlInput.length > 0 ? targetUrlProblem(urlInput) : `the ${runtime.gatewayUrl.label} is required.`;
			if (problem === null) {
				url = normalizeUrl(urlInput, runtime.id);
				break;
			}
			process.stdout.write(`  ${problem}\n`);
		}
	} else if (support.supportsCustomUrl) {
		const urlDefault = defaults.url ?? existing?.url ?? defaultUrlFor(runtime.id);
		const urlInput = await ask(
			rl,
			support.group === "local-http" ? "Connection URL" : "Base URL override (blank for runtime default)",
			urlDefault,
		);
		if (urlInput === null) return 0;
		const problem = urlInput.length > 0 ? targetUrlProblem(urlInput) : null;
		if (problem !== null) {
			printError(problem);
			return 2;
		}
		if (urlInput.length > 0) url = normalizeUrl(urlInput, runtime.id);
	} else if (defaults.url) {
		url = normalizeUrl(defaults.url, runtime.id);
	}

	if (url) {
		const steered = await maybeSteerToNativeRuntime(rl, runtime, url);
		if (steered.id !== runtime.id) {
			runtime = steered;
			support = buildProviderSupportEntry(runtime);
		}
		if (runtime.id === "lmstudio") {
			const greeting = await greetLmStudio(
				{ id: targetId, runtime: runtime.id, url },
				{ credentialsPresent: new Set(), httpTimeoutMs: 750 },
			);
			if (!greeting.ok) {
				printError(`refusing to save LM Studio connection '${targetId}': ${url} did not return the LM Studio greeting`);
				return 2;
			}
		}
	}

	let apiKeyEnv: string | undefined;
	let apiKeyLiteral: string | undefined;
	let apiKeyRef: string | undefined = existing?.auth?.apiKeyRef;
	let oauthProfile: string | undefined =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const authStatus = auth.statusForTarget(
		existing ? resolveAuthTarget(existing, runtime) : resolveRuntimeAuthTarget(runtime),
		{ includeFallback: false },
	);
	if (runtime.auth === "api-key") {
		// Default to the env-var path, which keeps the key off disk. A target that
		// needs no key at all defaults to skip instead: a local llama.cpp server
		// wants no credential, and offering `env` sent the user to an unexplained
		// `Env var name:` with nothing correct to type into it.
		const needsCredential = targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime);
		const defaultSource =
			existing?.auth?.apiKeyRef || authStatus.source === "stored-api-key"
				? "keep"
				: authStatus.source === "environment" || existing?.auth?.apiKeyEnvVar || needsCredential
					? "env"
					: "skip";
		process.stdout.write(
			"\nCredential source: env reads a key from an environment variable, stored writes one to\n" +
				"credentials.yaml, keep leaves the current one alone, skip uses no key at all.\n",
		);
		const choice = await ask(rl, "Credential source [env|stored|keep|skip]", defaultSource);
		if (choice === null) return 0;
		const normalized = choice.trim().toLowerCase();
		if (normalized === "stored") {
			const literal = await rl.text(
				`API key literal (stored in credentials.yaml, ${credentialFileProtection()})`,
				"",
				true,
			);
			if (literal !== null && literal.length > 0) {
				apiKeyLiteral = literal;
				apiKeyRef = targetApiKeyRef(targetId, settings.connections);
			}
		} else if (normalized === "env") {
			const envDefault = defaults.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar ?? "";
			const envAnswer = await ask(rl, "Env var name (blank for no key)", envDefault);
			if (envAnswer === null) return 0;
			if (envAnswer.length > 0) apiKeyEnv = envAnswer;
			apiKeyRef = undefined;
		} else if (normalized === "keep") {
			apiKeyEnv =
				existing?.auth?.apiKeyEnvVar ?? (authStatus.source === "environment" ? runtime.credentialsEnvVar : undefined);
			apiKeyRef = existing?.auth?.apiKeyRef ?? (authStatus.source === "stored-api-key" ? runtime.id : undefined);
		} else {
			apiKeyEnv = undefined;
			apiKeyRef = undefined;
		}
	}
	if (runtime.auth === "oauth") {
		const connectNow = authStatus.available
			? await askYesNo(rl, `Reconnect ${runtime.displayName}?`, false)
			: await askYesNo(rl, `Connect ${runtime.displayName} now?`, true);
		if (connectNow) {
			const connected = await loginOAuthRuntime(rl, runtime);
			if (!connected) return 1;
		}
		oauthProfile = existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id;
	}

	let model: string | undefined = defaults.model;
	let inventory: WireModelInventory = { models: [], source: "none" };
	const tentative = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: defaults.gateway,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
		...(existing?.ollama ? { ollama: existing.ollama } : {}),
	});

	if (existing?.auth?.headers) tentative.auth = { ...tentative.auth, headers: existing.auth.headers };
	if (runtime.kind === "http" || runtime.externalAgentLoop?.modelCatalog === "live-authoritative") {
		inventory = await resolveSupportedWireModels(runtime, tentative, existing ?? undefined, apiKeyLiteral);
	}
	const wireModels = chatPickerModels(inventory);
	// The wizard shows the whole list, so a catalog-ordered runtime does not need
	// --model here the way the non-interactive path does. It does need to stop
	// offering the alphabetically first id as though it were the recommended one.
	const catalogOrdered = support.modelSource === "catalog";
	model = model ?? existing?.defaultModel ?? preferredModelFor(inventory, support);
	if (wireModels.length > 0) {
		process.stdout.write("\nSelectable models:\n");
		for (const [index, wireModel] of wireModels.entries()) {
			const label = inventory.labels?.[wireModel];
			process.stdout.write(
				`  ${index + 1}. ${wireModel}${label && label !== wireModel ? ` — ${label}` : ""}${wireModel === model ? "  [default]" : ""}\n`,
			);
		}
		const note = inventoryNote(runtime, inventory);
		if (note) process.stdout.write(`  ${note}\n`);
		if (!model && catalogOrdered) {
			process.stdout.write(`  listed in provider catalog order, which recommends none of them; pick one.\n`);
		}
		for (;;) {
			const pickedModel = await askModelChoice(rl, "Default connection model", wireModels, model);
			if (pickedModel === null) return 0;
			if (pickedModel.length > 0) model = pickedModel;
			if (!model) {
				process.stdout.write("  a model is required: enter a number from the list or a model id.\n");
				continue;
			}
			if (validateResolvedModel(runtime, tentative, model, defaults.force, inventory)) break;
		}
	} else {
		for (;;) {
			if (model && validateResolvedModel(runtime, tentative, model, defaults.force, inventory)) break;
			const manual = await ask(rl, "Default model id (blank to leave empty)", model ?? "");
			if (manual === null) return 0;
			model = manual.length > 0 ? manual : undefined;
			if (!model) break;
		}
	}
	let contextWindowChoice = defaults.contextWindow;
	let reasoningChoice = defaults.reasoning;
	// Generic OpenAI/Anthropic-compatible endpoints have no cloud catalog and
	// their /v1/models rarely reports a context window or reasoning support, so
	// ask for the two capabilities that cannot be probed reliably. Output budget
	// is intentionally not asked: defaults.maxTokens applies globally and is
	// clamped down to the model at request time.
	if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) {
		if (contextWindowChoice === undefined) {
			const cwDefault = existing?.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
			const cwAnswer = await ask(
				rl,
				"Context window in tokens (blank for runtime default)",
				cwDefault > 0 ? String(cwDefault) : "",
			);
			if (cwAnswer === null) return 0;
			if (cwAnswer.length > 0) {
				const parsed = Number(cwAnswer);
				if (Number.isInteger(parsed) && parsed > 0) contextWindowChoice = parsed;
				else process.stderr.write(`ignoring invalid context window: ${cwAnswer}\n`);
			}
		}
		if (reasoningChoice === undefined) {
			const reasoningDefault = existing?.capabilities?.reasoning ?? runtime.defaultCapabilities.reasoning === true;
			reasoningChoice = await askYesNo(rl, "Does this model support reasoning / thinking?", reasoningDefault);
		}
	}
	if (!validateContextWindowOverride(runtime, model, contextWindowChoice, defaults.force)) return 2;

	const gatewayDefault = defaults.gateway || existing?.gateway === true;
	const gatewayAnswer = gatewayDefault ? true : await askYesNo(rl, "Mark as gateway?", false);

	const configured = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(model !== undefined ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: gatewayAnswer,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(contextWindowChoice !== undefined ? { contextWindow: contextWindowChoice } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(reasoningChoice !== undefined ? { reasoning: reasoningChoice } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
		...(existing?.ollama ? { ollama: existing.ollama } : {}),
	});
	const descriptor: TargetDescriptor = {
		...existing,
		...configured,
		capabilities: { ...existing?.capabilities, ...configured.capabilities },
	};
	if (existing?.auth?.headers) descriptor.auth = { ...configured.auth, headers: existing.auth.headers };
	else if (!configured.auth) delete descriptor.auth;
	// The guided path can land on another runtime than the one it started with, so the tier is checked here.
	const tierProblem = contextTierProblem(runtime, defaults.contextTier);
	if (tierProblem !== null) {
		printError(tierProblem);
		return 2;
	}
	applyContextTier(descriptor, defaults.contextTier);
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const probe = await runtimeProbe(runtime, descriptor, apiKeyLiteral);
	if (probe) recordProbedModelSnapshot(descriptor, runtime, probe);
	if (probe) {
		process.stdout.write("\n");
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`${line}\n`);
		if (!probe.ok) {
			const keepAnyway = await askYesNo(rl, "save this connection anyway, without a reply from it?", true);
			if (!keepAnyway) {
				printError("aborted; settings not changed");
				return 0;
			}
		}
	}

	const setOrchestrator = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setOrchestrator
			? true
			: await askYesNo(rl, "use as orchestrator (chat) connection?", !settings.chat.connection);
	const setWorkerDefault = defaults.setWorkerDefault
		? true
		: await askYesNo(rl, "use as fleet default?", !settings.fleet.default.connection);
	const setBackground = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setBackground
			? true
			: await askYesNo(rl, "use as background memory connection?", false);
	const orchestratorModel = setOrchestrator
		? (defaults.orchestratorModel ??
			(await askModelChoice(
				rl,
				"Orchestrator model",
				wireModels,
				settings.chat.connection === targetId ? (settings.chat.model ?? model) : model,
			)))
		: undefined;
	if (orchestratorModel === null) return 0;
	const workerModel = setWorkerDefault
		? (defaults.workerModel ??
			(await askModelChoice(
				rl,
				"Fleet model",
				wireModels,
				settings.fleet.default.connection === targetId ? (settings.fleet.default.model ?? model) : model,
			)))
		: undefined;
	if (workerModel === null) return 0;
	const backgroundModel = setBackground
		? (defaults.backgroundModel ??
			(await askModelChoice(
				rl,
				"Background memory model",
				wireModels,
				settings.context.memory.connection === targetId ? (settings.context.memory.model ?? model) : model,
			)))
		: undefined;
	if (backgroundModel === null) return 0;

	if (apiKeyLiteral && apiKeyRef) {
		auth.setApiKey(apiKeyRef, apiKeyLiteral);
		// As in the non-interactive path: the settings write is still ahead of us,
		// so refusing here leaves the whole wizard run without an effect.
		if (
			credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; connection '${descriptor.id}' not saved`)
		)
			return 1;
		printPlaintextCredentialWarning();
	}

	const applyWizardChoice = (target: PancodeSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator) setOrchestratorPointer(target, descriptor, orchestratorModel);
		if (setBackground) setBackgroundPointer(target, descriptor, backgroundModel);
		if (setWorkerDefault) setWorkerDefaultPointer(target, descriptor, workerModel);
	};
	applyWizardChoice(settings);
	updateSettings(applyWizardChoice);

	printSummary(settings, descriptor, probe);
	printOk(`connection ${targetId} saved`);
	await runInteropReview({ rl });
	return 0;
}

export function runTargetRemove(id: string): number {
	const removed = readSettings().connections.find((e) => e.id === id);
	if (!removed) {
		printError(`no connection with id ${id}`);
		return 1;
	}
	updateSettings((settings) => {
		removeTargetFromSettings(settings, id);
	});
	// Once the target is gone no command can name the key it owned, so it goes now.
	ensureRegistryPopulated();
	const auth = openAuthStorage();
	const credential = applyTargetCredentialPlan(
		planTargetCredentialRemoval(removed, readSettings().connections, getRuntimeRegistry().list()),
		{
			isStored: (key) => auth.get(key) !== undefined,
			remove: (key) => auth.remove(key),
			damageReason: () => auth.damageReason(),
		},
	);
	printOk(`removed connection ${id}${credential ? `; ${credential}` : ""}`);
	return 0;
}

export function runTargetRename(oldId: string, newId: string): number {
	if (oldId === newId) {
		printError("old and new id are identical");
		return 2;
	}
	const current = readSettings();
	if (current.connections.some((e) => e.id === newId)) {
		printError(`connection id already exists: ${newId}`);
		return 2;
	}
	if (!current.connections.some((e) => e.id === oldId)) {
		printError(`no connection with id ${oldId}`);
		return 1;
	}
	updateSettings((settings) => {
		const target = settings.connections.find((e) => e.id === oldId);
		if (!target) return;
		target.id = newId;
		if (settings.chat.connection === oldId) settings.chat.connection = newId;
		if (settings.context.memory.connection === oldId) settings.context.memory.connection = newId;
		if (settings.fleet.default.connection === oldId) settings.fleet.default.connection = newId;
		for (const profile of Object.values(settings.fleet.profiles)) {
			if (profile.connection === oldId) profile.connection = newId;
		}
		for (const roster of Object.values(settings.fleet.rosters)) {
			for (const member of roster.members) if (member.connection === oldId) member.connection = newId;
		}
		const renameRef = (entry: string): string => {
			const [head, ...rest] = entry.split("/");
			if (head !== oldId) return entry;
			return rest.length === 0 ? newId : `${newId}/${rest.join("/")}`;
		};
		settings.chat.modelPicker.cycleSet = settings.chat.modelPicker.cycleSet.map(renameRef);
		settings.chat.modelPicker.favorites = settings.chat.modelPicker.favorites.map(renameRef);
	});
	printOk(`renamed ${oldId} to ${newId}`);
	return 0;
}
