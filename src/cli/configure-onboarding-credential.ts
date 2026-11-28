// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { canOpenBrowser } from "../core/open-browser.js";
import { authStoragePath, openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { resolveRuntimeAuthTarget } from "../domains/providers/index.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import {
	type Answers,
	type CredentialSource,
	guidedFlow,
	type Step,
	type Wizard,
} from "./configure-onboarding-state.js";
import { describeAuthStatus, LOCAL_APP_RUNTIME_IDS } from "./configure-target.js";
import { shortenPath } from "./install-presenter.js";
import { credentialFileProtection } from "./shared.js";

/** The credential source the screen opens on, which is the one that is usually right. */
function defaultCredentialSource(runtime: RuntimeDescriptor, targetId: string): CredentialSource {
	const status = openAuthStorage().statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (status.source === "stored-api-key") return "keep";
	if (status.source === "environment") return "env";
	if (runtime.id === "litellm") return "stored";
	// New users can paste the credential they were given without first learning
	// shell environment variables. The screen states the storage properties and
	// keeps the environment-variable option available for managed deployments.
	// A local server that needs no key still opens on No key.
	return targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime) ? "stored" : "skip";
}

/**
 * Run the browser sign-in on a readline interface that exists only for it.
 *
 * A readline interface left open across the wizard echoes every keypress the
 * pickers read, which puts a stray line under each menu and throws off the
 * erase that replaces it with the answer row. So the wizard owns no readline,
 * and the one flow that needs one opens and closes it around the call.
 */
async function connectOAuth(wizard: Wizard, runtime: RuntimeDescriptor): Promise<"connected" | "failed" | "stopped"> {
	if (wizard.host) {
		const outcome = { stopped: false };
		const connected = await loginOAuthRuntime(null, runtime, wizard.host, outcome);
		return connected ? "connected" : outcome.stopped ? "stopped" : "failed";
	}
	const rl = createInterface({ input: wizard.streams.in, output: wizard.streams.out });
	try {
		return (await loginOAuthRuntime(rl, runtime)) ? "connected" : "failed";
	} finally {
		rl.close();
	}
}

/** Only some runtimes flag a refused credential; the rest report the bare status of the shared HTTP probe. */
export const REFUSED_CREDENTIAL = /\bHTTP (?:401|403)\b/u;

export function refusedCredential(probe: ProbeResult): boolean {
	return probe.authFailed === true || REFUSED_CREDENTIAL.test(probe.error ?? "");
}

/** Says which credential the server turned down, because the screen after it asks for one again. */
function refusedCredentialLine(answers: Answers): string {
	const line = (why: string): string => `Authentication failed: ${why}. Choose a credential before selecting a model.`;
	if (answers.credential === "env") {
		const name = answers.apiKeyEnv ?? "";
		return line(
			process.env[name] ? `the server refused the key in $${name}` : `$${name} is not set here, so the server saw no key`,
		);
	}
	if (answers.credential === "stored") return line("the server refused that key");
	if (answers.credential === "keep") return line("the server refused the saved key");
	return line("this server wants a key");
}

/** Say the credential was refused, and remember it so the next credential answer can take it down. */
export function warnRefused(wizard: Wizard, answers: Answers): void {
	wizard.refusalShown = true;
	wizard.presenter.warn(refusedCredentialLine(answers));
}

/**
 * An app on this computer (LM Studio, Lemonade) takes no key unless its owner turned one on, and asking
 * before the address reads as a question about something the user never set up. The address step routes
 * back to the credential step when the app refuses the request, and the missing-list screen offers it, so
 * the question waits for either. A server or gateway stays asked first: those are often shared and keyed.
 */
export function keyWaitsForRefusal(answers: Answers, runtime: RuntimeDescriptor): boolean {
	return (
		answers.mode !== "edit" &&
		runtime.auth === "api-key" &&
		(LOCAL_APP_RUNTIME_IDS.has(runtime.id) || (guidedFlow(answers) && answers.have === "server")) &&
		answers.keyRequested !== true
	);
}

/**
 * What Connect now does for this runtime's sign-in, as a phrase that follows the choice's name. A device-code flow
 * shows its own code; every other flow asks for the code its sign-in page shows, so it never promises one.
 */
function connectHint(runtime: RuntimeDescriptor, browser: boolean): string {
	const flow = runtime.oauthSignIn ?? "paste-code";
	if (flow === "paste-only")
		return browser
			? "opens your browser, then asks for the code the sign-in page shows"
			: "shows a sign-in link for any device, then asks for the code that page shows";
	if (browser) return "opens your browser and waits for the sign-in";
	return flow === "device-code"
		? "shows a link and a code to enter on any device"
		: "shows a sign-in link for any device, then asks for the code that page shows";
}

export const CREDENTIAL_STEP: Step = {
	id: "credential",
	applies: (answers) =>
		(answers.runtime?.auth === "api-key" && !answers.keyGiven && !keyWaitsForRefusal(answers, answers.runtime)) ||
		answers.runtime?.auth === "oauth",
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const stored = describeAuthStatus(runtime, answers.existing);
		const hasStored = stored !== "none stored";
		// A sign-in the operator stops with Esc asks this question again, so the loop.
		while (runtime.auth === "oauth") {
			const choices = [
				{
					value: "oauth-connect" as CredentialSource,
					label: "Connect now",
					// Worded per flow: only a device-code flow shows a code of its own; the others ask for the one the page shows.
					hint: connectHint(runtime, canOpenBrowser()),
				},
				...(hasStored ? [{ value: "keep" as CredentialSource, label: "Keep what is there", hint: stored }] : []),
				{
					value: "oauth-skip" as CredentialSource,
					label: "Later",
					hint: wizard.host
						? "connect it from Settings → Connections before the first turn"
						: `ends setup with nothing saved; run \`pancode auth login ${runtime.id}\` later`,
				},
			];
			const current = answers.credential ?? (hasStored ? "keep" : "oauth-connect");
			const result = await wizard.select<CredentialSource>({
				heading: [
					"",
					chalk.bold(`Sign in to ${runtime.displayName}`),
					chalk.dim(`credential: ${stored}`),
					"Sign-in stores credentials immediately; target settings wait for Save.",
				],
				choices,
				initialIndex: Math.max(
					0,
					choices.findIndex((choice) => choice.value === current),
				),
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back") return "back";
			answers.credential = result.value;
			if (result.value === "keep") {
				wizard.answer("Credential", stored);
				return "next";
			}
			if (result.value === "oauth-connect") {
				const connected = await connectOAuth(wizard, runtime);
				if (connected === "stopped") continue;
				if (connected === "failed") {
					wizard.presenter.warn(
						wizard.host
							? "sign-in did not complete; connect it from Settings → Connections when ready"
							: "sign-in did not complete",
					);
				} else {
					wizard.answer("Credential", `connected to ${runtime.id}`);
					return "next";
				}
			}
			// A target saved without its credential opens as a home that looks configured and fails its first turn.
			if (!wizard.host) {
				answers.signInLater = runtime.id;
				return "cancel";
			}
			wizard.answer("Credential", "not connected yet");
			return "next";
		}

		const hasKey = answers.existing?.auth?.apiKeyRef !== undefined || hasStored;
		const choices = [
			{
				value: "env" as CredentialSource,
				label: "Environment variable",
				hint: "read at call time; nothing is written to disk",
			},
			{
				value: "stored" as CredentialSource,
				label: "Store the key",
				hint: `written to credentials.yaml, ${credentialFileProtection()}, not encrypted`,
			},
			...(hasKey ? [{ value: "keep" as CredentialSource, label: "Keep what is there", hint: stored }] : []),
			{
				value: "skip" as CredentialSource,
				label: "No key",
				hint: "only for servers that accept unauthenticated requests",
			},
		];
		const fallback = defaultCredentialSource(runtime, answers.targetId ?? runtime.id);
		// The server just refused a request without a key, so No key is the one answer known to be wrong.
		const current = answers.credential ?? (answers.keyRequested && fallback === "skip" ? "stored" : fallback);
		const initial = Math.max(
			0,
			choices.findIndex((choice) => choice.value === current),
		);
		const result = await wizard.select<CredentialSource>({
			heading: ["", chalk.bold("How should PanCode get the API key?"), chalk.dim(`currently: ${stored}`)],
			choices,
			initialIndex: initial,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		answers.credential = result.value;
		if (result.value !== "env") answers.apiKeyEnv = undefined;
		answers.inventoryKey = undefined;
		if (result.value !== "stored") answers.apiKeyLiteral = undefined;
		if (result.value === "keep") wizard.answer("Credential", stored);
		if (result.value === "skip") wizard.answer("Credential", "none");
		return "next";
	},
};

export const CREDENTIAL_VALUE_STEP: Step = {
	id: "credential-value",
	applies: (answers) => !answers.keyGiven && (answers.credential === "env" || answers.credential === "stored"),
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const wantsEnv = answers.credential === "env";
		const result = await wizard.text({
			heading: ["", chalk.bold(wantsEnv ? "Which environment variable?" : "Paste the API key")],
			initial: wantsEnv ? (answers.apiKeyEnv ?? runtime.credentialsEnvVar ?? "") : "",
			hint: wantsEnv
				? "PanCode reads it every time it calls the provider, so the key never lands on disk"
				: `stored at ${shortenPath(authStoragePath())} (${credentialFileProtection()}, not encrypted)`,
			...(wantsEnv ? {} : { mask: true }),
			validate: (value) =>
				value.length === 0
					? `Enter ${wantsEnv ? "an environment variable" : "a key"}, or press Escape to choose No key.`
					: wantsEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
						? "A variable name holds only letters, digits and underscores. Paste a key under Store the key instead."
						: null,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (wantsEnv) {
			answers.apiKeyEnv = result.value.length > 0 ? result.value : undefined;
			answers.inventoryKey = undefined;
			wizard.answer("Credential", result.value.length > 0 ? `$${result.value}` : "none");
			return "next";
		}
		answers.apiKeyLiteral = result.value.length > 0 ? result.value : undefined;
		answers.inventoryKey = undefined;
		// Nothing is on disk until Save, and a cancelled wizard must not read as having stored a key.
		wizard.answer("Credential", result.value.length > 0 ? "key, written to credentials.yaml on Save" : "none");
		return "next";
	},
};
