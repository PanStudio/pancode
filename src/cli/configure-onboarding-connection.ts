// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import chalk from "chalk";
import { readSettings } from "../core/config.js";
import { ensureClaudeAgentSdk } from "../domains/lifecycle/claude-sdk-install.js";
import { authStoragePath } from "../domains/providers/auth/index.js";
import { prepareCopilotSdk } from "../domains/providers/copilot-setup.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { greetLmStudio } from "../domains/providers/runtimes/common/lmstudio-http.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { commitImport, describeImport, importChangesNothing, prepareImport } from "./configure-import.js";
import type { ConfigureCategory } from "./configure-layout.js";
import { CONFIGURE_CATEGORY_CHOICES } from "./configure-layout.js";
import { refusedCredential, warnRefused } from "./configure-onboarding-credential.js";
import { readModelCapabilities } from "./configure-onboarding-model.js";
import {
	type Answers,
	allEntries,
	asksWhatTheyHave,
	clearConnection,
	draftDescriptor,
	guidedFlow,
	type Have,
	type OfferedRoute,
	offeredRow,
	type Step,
	supportFor,
	type Wizard,
} from "./configure-onboarding-state.js";
import {
	deriveTargetId,
	gatewayUrlGuidance,
	isUntrustedCertificate,
	normalizeUrl,
	offeredUrlFor,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	plainConnectionProblem,
	probeReadings,
	runtimeProbe,
	runtimesForCategory,
	targetUrlProblem,
} from "./configure-target.js";
import { offerCopilotSignIn } from "./copilot-sign-in.js";
import { inferKeyProvider } from "./key-prefix.js";
import { shortenPath } from "./lifecycle-presenter.js";
import { credentialFileProtection } from "./shared.js";

/** Screen 1 when PanCode found something: each route it found, best first, and a way out to the rest. */
export const OFFERED_STEP: Step = {
	id: "offered",
	applies: (answers) => asksWhatTheyHave(answers) && answers.offered.length > 0,
	run: async (wizard, answers) => {
		const chosen = answers.detectedChatRoute;
		const previous = chosen ? answers.offered.findIndex((route) => route.target === chosen.target) : -1;
		const result = await wizard.select<OfferedRoute | "other">({
			heading: ["", chalk.bold("PanCode found a way to reach a model:")],
			choices: [
				...answers.offered.map((route) => ({ value: route, ...offeredRow(route) })),
				{ value: "other" as const, label: "Set up something else", hint: "an API key, a subscription, or a server" },
			],
			// The row says where the route came from in full; the hint is only the model.
			maxLabelWidth: 56,
			initialIndex: previous >= 0 ? previous : answers.detectedChatRoute || answers.have ? answers.offered.length : 0,
			railPrefix: wizard.rail,
			backLabel: "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value === "other") {
			if (answers.detectedChatRoute) clearConnection(answers);
			return "next";
		}
		const route = result.value;
		clearConnection(answers);
		answers.have = undefined;
		answers.detectedChatRoute = route;
		answers.runtime = route.runtime;
		answers.targetId = route.target.id;
		answers.url = route.target.url;
		answers.model = route.model;
		answers.apiKeyEnv = route.target.auth?.apiKeyEnvVar;
		answers.credential = answers.apiKeyEnv ? "env" : route.target.auth?.apiKeyRef ? "keep" : undefined;
		answers.contextWindow = route.target.capabilities?.contextWindow;
		answers.inventory = {
			models: route.model ? [route.model] : [],
			source: route.kind === "local-server" ? "probe" : "catalog",
		};
		wizard.answer("Using", offeredRow(route).label);
		// Detection read only the model list; the window the server publishes comes from the probe a typed address gets.
		if (route.kind === "local-server") await readModelCapabilities(answers, route.runtime);
		// A detected Copilot login is re-read here, so the line naming the account it uses is shown.
		if (route.runtime.id === "copilot-sdk") {
			const ready = await COPILOT_STEP.run(wizard, answers);
			if (ready !== "next") return ready;
		}
		return "detected";
	},
};

const HAVE_CHOICES: ReadonlyArray<{ value: Have; label: string; hint: string }> = [
	{
		value: "key",
		label: "An API key",
		hint: "Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, and others",
	},
	{ value: "subscription", label: "A subscription", hint: "ChatGPT Plus or Pro, Claude Pro or Max, GitHub Copilot" },
	{
		value: "server",
		label: "A model server or gateway",
		hint: "Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or any OpenAI-compatible address",
	},
	{ value: "file", label: "A setup file from my lab or team", hint: "a path or https address someone gave you" },
];

/** Add a target only: the category list and every provider in it, including an installed coding agent as a worker. */
const LIST_CHOICE: { value: Have; label: string; hint: string } = {
	value: "list",
	label: "Every provider and app",
	hint: "choose by category, including an installed coding agent as a worker",
};

/** Screen 1 when PanCode found nothing, or the user wants something else: what they have, in their words. */
export const HAVE_STEP: Step = {
	id: "have",
	applies: (answers) => asksWhatTheyHave(answers) && answers.detectedChatRoute === undefined,
	run: async (wizard, answers) => {
		const choices = answers.mode === "add" ? [...HAVE_CHOICES, LIST_CHOICE] : HAVE_CHOICES;
		const previous = choices.findIndex((choice) => choice.value === answers.have);
		const result = await wizard.select<Have>({
			heading: ["", chalk.bold("What do you have?")],
			choices: choices.map((choice) => ({ ...choice })),
			initialIndex: Math.max(0, previous),
			railPrefix: wizard.rail,
			backLabel: answers.offered.length > 0 ? "back" : "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (answers.have !== result.value) {
			clearConnection(answers);
			answers.have = result.value;
		}
		const registry = getRuntimeRegistry();
		if (result.value === "subscription") answers.category = "subscription";
		if (result.value === "server") {
			const runtime = registry.get("openai-compat") ?? undefined;
			if (runtime && answers.runtime === undefined) {
				answers.runtime = runtime;
				answers.targetId = deriveTargetId(runtime.id, readSettings().targets);
			}
		}
		wizard.answer("You have", choices.find((choice) => choice.value === result.value)?.label ?? result.value);
		return "next";
	},
};

const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u;

/** The API-key path: one masked field; a known prefix names the provider, `$NAME` reads an environment variable. */
export const KEY_STEP: Step = {
	id: "key",
	applies: (answers) => guidedFlow(answers) && answers.have === "key",
	run: async (wizard, answers) => {
		const result = await wizard.text({
			heading: [
				"",
				chalk.bold("Paste your API key"),
				chalk.dim(
					`Saved to ${shortenPath(authStoragePath())} (${credentialFileProtection()}, not encrypted) when you save.`,
				),
			],
			initial: answers.apiKeyEnv !== undefined ? `$${answers.apiKeyEnv}` : "",
			hint: "or type $NAME to read the key from that environment variable instead",
			mask: true,
			validate: (value) =>
				value.trim().length === 0
					? "Paste a key, or type $NAME to use an environment variable."
					: value.startsWith("$") && !ENV_REFERENCE.test(value.trim())
						? "After $, an environment variable name holds only letters, digits and underscores."
						: null,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const value = result.value.trim();
		const variable = ENV_REFERENCE.exec(value)?.[1];
		const registry = getRuntimeRegistry();
		let provider: string | undefined;
		if (variable !== undefined) {
			answers.credential = "env";
			answers.apiKeyEnv = variable;
			answers.apiKeyLiteral = undefined;
			provider =
				inferKeyProvider(process.env[variable] ?? "") ??
				registry.list().find((runtime) => runtime.auth === "api-key" && runtime.credentialsEnvVar === variable)?.id;
			wizard.answer("Key", `$${variable}${process.env[variable] ? "" : chalk.dim("  (not set in this shell)")}`);
		} else {
			answers.credential = "stored";
			answers.apiKeyEnv = undefined;
			answers.apiKeyLiteral = value;
			provider = inferKeyProvider(value);
			wizard.answer("Key", "pasted, written on Save");
		}
		answers.keyGiven = true;
		answers.inventoryKey = undefined;
		const runtime = provider !== undefined ? (registry.get(provider) ?? undefined) : undefined;
		if (runtime && answers.runtime?.id !== runtime.id) {
			answers.model = undefined;
			answers.probe = undefined;
			answers.inventory = undefined;
		}
		answers.runtime = runtime;
		answers.keyProvider = runtime?.id;
		answers.targetId = runtime ? deriveTargetId(runtime.id, readSettings().targets) : undefined;
		if (runtime) wizard.answer("Provider", `${runtime.displayName}  ${chalk.dim("(from the key)")}`);
		return "next";
	},
};

/** The setup-file path: the same import as `configure --import`, shown and confirmed on the rail. */
export const FILE_STEP: Step = {
	id: "setup-file",
	applies: (answers) => guidedFlow(answers) && answers.have === "file",
	run: async (wizard, answers) => {
		let problem: string | undefined;
		for (;;) {
			const result = await wizard.text({
				heading: [
					"",
					chalk.bold("Where is the setup file?"),
					...(problem ? problem.split("\n").map((line) => chalk.red(line)) : []),
				],
				initial: answers.setupSource ?? "",
				hint: "a path on this machine or an https:// address",
				validate: (value) => (value.trim().length === 0 ? "Type a path or an https:// address." : null),
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back") return "back";
			const source = result.value.trim();
			answers.setupSource = source;
			const prepared = await prepareImport(source, false);
			if (!prepared.ok) {
				problem = prepared.error;
				continue;
			}
			problem = undefined;
			if (importChangesNothing(prepared.plan)) {
				wizard.answer("Setup file", `${source}  ${chalk.dim("(already imported)")}`);
				return "imported";
			}
			const confirm = await wizard.select<"apply" | "back">({
				heading: ["", chalk.bold("This setup file will:"), ...describeImport(prepared)],
				choices: [
					{ value: "apply", label: "Apply", hint: "save these targets to your PanCode settings" },
					{ value: "back", label: "Back", hint: "choose another file" },
				],
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (confirm.kind === "quit") return "quit";
			if (confirm.kind === "back" || confirm.value === "back") continue;
			try {
				const status = commitImport(prepared.file);
				wizard.answer("Setup file", source);
				for (const line of status) wizard.presenter.note(line.trim());
			} catch (err) {
				problem = err instanceof Error ? err.message : String(err);
				continue;
			}
			return "imported";
		}
	},
};

/** Add a target's "Every provider and app": the source categories, then the providers in the one chosen. */
export const CATEGORY_STEP: Step = {
	id: "category",
	applies: (answers) => answers.mode === "add" && !answers.fixedRuntime && answers.have === "list",
	run: async (wizard, answers) => {
		const available = CONFIGURE_CATEGORY_CHOICES.filter(
			(choice) => runtimesForCategory(allEntries(), choice.category).length > 0,
		);
		const current = available.findIndex((choice) => choice.category === answers.category);
		const result = await wizard.select<ConfigureCategory>({
			heading: [
				"",
				chalk.bold("Where does your model come from?"),
				chalk.dim("Choose the description you recognize; PanCode shows the exact providers next."),
			],
			choices: available.map((choice) => ({
				value: choice.category,
				label: choice.label,
				hint: choice.summary,
			})),
			initialIndex: Math.max(0, current),
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (answers.category !== result.value) {
			answers.runtime = undefined;
			answers.detected = undefined;
		}
		answers.category = result.value;
		const choice = available.find((entry) => entry.category === result.value);
		wizard.answer("Source", choice?.label ?? result.value);
		return "next";
	},
};

export const RUNTIME_STEP: Step = {
	id: "runtime",
	applies: (answers) =>
		!answers.fixedRuntime &&
		!(
			guidedFlow(answers) &&
			(answers.have === "server" || (answers.have === "key" && answers.keyProvider !== undefined))
		),
	run: async (wizard, answers) => {
		const registry = getRuntimeRegistry();
		const chatEntries = allEntries().filter((entry) => {
			const runtime = registry.get(entry.runtimeId);
			return runtime !== null && (answers.mode !== "first" || isOrchestratorEligibleRuntime(runtime));
		});
		// A key the prefix table did not place: the providers that take one.
		const entries =
			guidedFlow(answers) && answers.have === "key"
				? runtimesForCategory(chatEntries, "cloud-api").filter((entry) => registry.get(entry.runtimeId)?.auth === "api-key")
				: answers.category
					? runtimesForCategory(chatEntries, answers.category)
					: chatEntries;
		const usable = entries.length > 0 ? entries : chatEntries;
		const previous = usable.findIndex((entry) => entry.runtimeId === answers.runtime?.id);
		const featured = usable.findIndex((entry) => entry.featured);
		const result = await wizard.select<string>({
			heading: ["", chalk.bold("Which provider or app do you use?")],
			choices: usable.map((entry) => ({
				value: entry.runtimeId,
				label: entry.label,
				// A summary that only repeats the label says nothing the row does not already say, and the runtime's
				// internal id is a name for settings.yaml, not for this choice.
				...(entry.summary === entry.label ? {} : { hint: entry.summary }),
			})),
			initialIndex: previous >= 0 ? previous : featured >= 0 ? featured : 0,
			searchable: usable.length > 8,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const runtime = registry.get(result.value);
		if (!runtime) return "back";
		if (answers.runtime?.id !== runtime.id) {
			answers.targetId =
				answers.mode === "edit" ? answers.existing?.id : deriveTargetId(runtime.id, readSettings().targets);
			answers.url = undefined;
			answers.detected = undefined;
			// A key pasted on the first-run key screen belongs to whichever provider is picked for it.
			if (!answers.keyGiven) {
				answers.credential = undefined;
				answers.keyRequested = undefined;
				answers.apiKeyEnv = undefined;
				answers.apiKeyLiteral = undefined;
			}
			answers.model = undefined;
			answers.thinking = undefined;
			answers.contextWindow = undefined;
			answers.probe = undefined;
			answers.inventory = undefined;
			answers.inventoryKey = undefined;
		}
		answers.runtime = runtime;
		answers.targetId ??= deriveTargetId(runtime.id, readSettings().targets);
		wizard.answer("Provider", `${runtime.displayName}  ${chalk.dim(`(${runtime.id})`)}`);
		return "next";
	},
};

export const SDK_STEP: Step = {
	id: "claude-sdk",
	applies: (answers) => answers.runtime?.id === "claude-sdk",
	run: async (wizard) => {
		try {
			await ensureClaudeAgentSdk({
				confirm: async (question) => {
					const result = await wizard.select<boolean>({
						heading: ["", question],
						choices: [
							{ value: true, label: "Install now" },
							{ value: false, label: "Not now" },
						],
						initialIndex: 1,
						railPrefix: wizard.rail,
						backLabel: "back",
						clearOnExit: true,
						input: wizard.input,
						output: wizard.output,
					});
					return result.kind === "selected" && result.value;
				},
			});
			return "next";
		} catch (error) {
			wizard.presenter.fail(error instanceof Error ? error.message : String(error));
			return "cancel";
		}
	},
};

/** Copilot: the SDK component and the `copilot login` check; the signed-in account is the authorization. */
export const COPILOT_STEP: Step = {
	id: "copilot-sdk",
	applies: (answers) => answers.runtime?.id === "copilot-sdk",
	run: async (wizard) => {
		const ask = async (question: string, yes = false) => {
			const result = await wizard.select<boolean>({
				heading: ["", question],
				choices: [
					{ value: true, label: "Yes" },
					{ value: false, label: "No" },
				],
				initialIndex: yes ? 0 : 1,
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			return result.kind === "selected" && result.value;
		};
		const print = (text: string) => wizard.output.write(`${text}\n`);
		const ready = await prepareCopilotSdk({
			confirm: (question) => ask(question),
			// A terminal can run the official sign-in in place; a hosted wizard (the GUI) has no terminal for it.
			...(!wizard.host && wizard.input.isTTY
				? { signIn: () => offerCopilotSignIn({ confirm: (q) => ask(q, true), print }) }
				: {}),
			print,
		});
		if (ready.ok) return "next";
		wizard.presenter.fail(ready.message);
		return "cancel";
	},
};

export const URL_STEP: Step = {
	id: "url",
	applies: (answers) => answers.runtime !== undefined && supportFor(answers.runtime).supportsCustomUrl,
	run: async (wizard, answers) => {
		const serverPath = guidedFlow(answers) && answers.have === "server";
		// The guided server path asks on the generic runtime and moves to the native one the address turns out to be.
		if (serverPath && answers.runtime?.id !== "openai-compat") {
			answers.runtime = getRuntimeRegistry().get("openai-compat") ?? answers.runtime;
			answers.detected = undefined;
		}
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const local = supportFor(runtime).group === "local-http";
		const gateway = runtime.gatewayUrl;
		const offered = serverPath ? undefined : offeredUrlFor(runtime);
		const found = serverPath ? answers.offered.filter((route) => route.kind === "local-server") : [];
		const recheck = answers.recheckUrl === true && !wizard.goingBack && answers.url !== undefined;
		answers.recheckUrl = undefined;
		const result: Awaited<ReturnType<Wizard["text"]>> = recheck
			? { kind: "value", value: answers.url ?? "" }
			: await wizard.text({
					heading: [
						"",
						chalk.bold(
							serverPath ? "What is the server's address?" : (gateway?.label ?? (local ? "Where is the server?" : "Base URL")),
						),
						...(serverPath ? [] : gatewayUrlGuidance(runtime).map((line) => chalk.dim(line))),
						...found.map((route) => chalk.dim(`found: ${route.target.url ?? route.source} (${route.runtime.displayName})`)),
					],
					// An offered address is a placeholder, so a typed one replaces it instead of being appended to it.
					...(answers.url !== undefined
						? { initial: answers.url }
						: offered !== undefined
							? wizard.host
								? { initial: offered }
								: { placeholder: offered }
							: {}),
					hint: gateway
						? "paste the whole URL, scheme and path included"
						: "host:port is enough; PanCode fills in the scheme and the port it knows",
					railPrefix: wizard.rail,
					backLabel: "back",
					clearOnExit: true,
					validate: (value) =>
						value.length === 0
							? gateway
								? `the ${gateway.label} is required`
								: "a URL is required for this runtime"
							: targetUrlProblem(value),
					input: wizard.input,
					output: wizard.output,
				});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const url = normalizeUrl(result.value, runtime.id);
		const bareHost = !/^[a-z][a-z0-9+.-]*:\/\//iu.test(result.value.trim());
		if (answers.url !== url) {
			answers.inventoryKey = undefined;
			answers.detected = undefined;
		}
		answers.url = url;
		if (!recheck) wizard.answer("URL", url);
		const authenticated = await reportReachability(wizard, answers, runtime, url, bareHost);
		if (!authenticated && runtime.auth === "api-key") {
			answers.keyRequested = true;
			answers.recheckUrl = true;
			answers.inventoryKey = undefined;
			if (answers.credential === "skip") answers.credential = undefined;
			return "credential";
		}
		return "next";
	},
};

/**
 * Keep offline setup possible, but repair rejected authentication before discovery.
 *
 * The readline wizard treated an unreachable endpoint as a question ("save this
 * target anyway?") and an LM Studio URL that did not greet back as a hard
 * refusal. Neither belongs in a first run: the server is frequently not started
 * yet, and the fix is one `pancode configure --url` away.
 */
async function reportReachability(
	wizard: Wizard,
	answers: Answers,
	runtime: RuntimeDescriptor,
	url: string,
	bareHost = false,
): Promise<boolean> {
	wizard.host?.waiting?.(`Checking ${url}…`);
	const draft = draftDescriptor(answers, runtime, false);
	// A freshly typed "store the key" answer is not on disk yet (that write
	// happens at the end of the wizard), so it has to ride along as an explicit
	// token the same way the model step already does; env and stored-from-before
	// credentials resolve on their own through the descriptor's auth fields.
	let probe = await runtimeProbe(runtime, draft, answers.apiKeyLiteral);
	answers.unreachable = undefined;
	// A bare host was read as http only because normalizeUrl had to pick. An https-only host must not read as down.
	if (probe !== null && !probe.ok && !refusedCredential(probe) && bareHost && url.startsWith("http://")) {
		const secure = url.replace(/^http:/u, "https:");
		wizard.host?.waiting?.(`Checking ${secure}…`);
		const retried = await runtimeProbe(runtime, { ...draft, url: secure }, answers.apiKeyLiteral);
		if (retried !== null && (retried.ok || refusedCredential(retried) || isUntrustedCertificate(retried.error))) {
			probe = retried;
			answers.url = secure;
			answers.inventoryKey = undefined;
			wizard.presenter.step(`${url} did not answer and https did, so PanCode uses ${secure}`);
		}
	}
	if (probe !== null) {
		if (probe.ok) {
			const readings = probeReadings(probe);
			wizard.presenter.step(
				`${runtime.id === "alcf" ? "ALCF catalog reachable; inference URL not checked" : "reachable"}, ${readings.length > 0 ? readings.join(", ") : "no model list offered"}`,
			);
		} else if (refusedCredential(probe)) {
			warnRefused(wizard, answers);
			return false;
		} else if (isUntrustedCertificate(probe.error)) {
			wizard.presenter.warn(
				`The server answered, but PanCode does not trust its certificate: ${probe.error}. Point NODE_EXTRA_CA_CERTS at its CA, or change the address.`,
			);
			answers.unreachable = probe.error;
		} else {
			const problem = plainConnectionProblem(probe.error ?? "no reply");
			wizard.presenter.warn(`not reachable: ${problem}`);
			answers.unreachable = probe.error ?? "no reply";
		}
	}
	if (probe?.ok && runtime.id === "lmstudio") {
		const greeting = await greetLmStudio(draft, { credentialsPresent: new Set(), httpTimeoutMs: 750 });
		if (!greeting.ok) wizard.presenter.warn(`${url} answered, but not with the LM Studio greeting`);
	}
	if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint && getRuntimeRegistry().get(fingerprint.runtimeId)) {
			answers.detected = { runtimeId: fingerprint.runtimeId, displayName: fingerprint.displayName };
		}
	}
	return true;
}

export const DETECTED_RUNTIME_STEP: Step = {
	id: "detected-runtime",
	applies: (answers) => answers.mode !== "edit" && answers.detected !== undefined && answers.runtime !== undefined,
	run: async (wizard, answers) => {
		const detected = answers.detected;
		const runtime = answers.runtime;
		if (!detected || !runtime) return "next";
		const native = getRuntimeRegistry().get(detected.runtimeId);
		if (!native) return "next";
		// The guided server path takes what the address is serving; the generic runtime stays a configure choice.
		if (guidedFlow(answers)) {
			if (wizard.goingBack) return "back";
			answers.runtime = native;
			answers.inventoryKey = undefined;
			wizard.answer("Server", detected.displayName);
			return "next";
		}
		const result = await wizard.select<boolean>({
			heading: ["", chalk.bold(`That URL is serving ${detected.displayName}.`)],
			choices: [
				{
					value: true,
					label: `Use ${native.id}`,
					hint: "its own runtime, with resident-model lifecycle and its real capabilities",
				},
				{ value: false, label: `Keep ${runtime.id}`, hint: "the generic protocol runtime you picked" },
			],
			initialIndex: 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value) {
			answers.runtime = native;
			answers.inventoryKey = undefined;
			wizard.answer("Detected", `${detected.displayName}, using runtime ${native.id}`);
		} else {
			wizard.answer("Detected", `${detected.displayName}, keeping runtime ${runtime.id}`);
		}
		return "next";
	},
};
