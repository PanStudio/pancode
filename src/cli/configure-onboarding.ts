// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The first screen a new user sees.
 *
 * `pancode configure` on an unconfigured home used to be a column of
 * readline questions: a numbered category menu, a numbered runtime menu, four
 * typed values, a paragraph explaining four credential words before asking for
 * one of them, and a run of `[y/N]` questions with no way back. The settings
 * menus had already moved to the arrow-key picker and the lifecycle rail; this
 * is the same treatment for the path that comes before them.
 *
 * The flow is a list of steps with a cursor. Each step draws its prompt, erases
 * it once answered, and leaves one row on the rail saying what was chosen, so
 * the screen is the answers so far plus the question at hand. Escape moves the
 * cursor back one step and rewinds the rail to that step's row, which is what
 * keeps target edits in a draft until Save. Browser sign-in stores credentials
 * when it succeeds; optional peer review has its own save after target setup.
 *
 * Steps that do not apply are stepped over in whichever direction the cursor is
 * moving, so a runtime with no URL and no credential is three questions and a
 * model, and backing out of the model step lands on the runtime rather than on
 * a prompt that was never shown.
 */

import type { PancodeSettings } from "../core/config.js";
import { readSettings, settingsPath, updateSettings } from "../core/config.js";
import { initializePancodeHome } from "../core/init.js";
import { SettingsValidationError } from "../core/settings-issues.js";
import { validateSettings } from "../core/settings-validate.js";
import { openAuthStorage, resolveAuthTarget } from "../domains/providers/auth/index.js";
import { isOrchestratorEligibleRuntime, recordTargetCheck } from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { SendChatTest } from "./chat-test.js";
import { sendChatTest } from "./chat-test.js";
import type { ConfigureWizardHost } from "./configure-host.js";
import {
	CATEGORY_STEP,
	COPILOT_STEP,
	DETECTED_RUNTIME_STEP,
	FILE_STEP,
	HAVE_STEP,
	KEY_STEP,
	OFFERED_STEP,
	RUNTIME_STEP,
	SDK_STEP,
	URL_STEP,
} from "./configure-onboarding-connection.js";
import { CREDENTIAL_STEP, CREDENTIAL_VALUE_STEP } from "./configure-onboarding-credential.js";
import { CONTEXT_STEP, MODEL_STEP, THINKING_STEP } from "./configure-onboarding-model.js";
import { REVIEW_STEP } from "./configure-onboarding-review.js";
import {
	type Answers,
	draftDescriptor,
	guidedFlow,
	LABEL_WIDTH,
	type OfferedRoute,
	type OnboardingStreams,
	railWriter,
	type Step,
	type Wizard,
} from "./configure-onboarding-state.js";
import {
	applyTarget,
	assertOrchestratorReplacementEligible,
	contextWindowUndiscovered,
	deriveTargetId,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	railPrefix,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
} from "./configure-target.js";
import type { LifecyclePresenter } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { canSelect, promptSelect, promptText } from "./select.js";
import { credentialFileProtection, credentialWriteFailed } from "./shared.js";
import { truncate } from "./text-layout.js";

/**
 * Whether the wizard can run at all. Without a terminal on both ends there is
 * nothing to read a keypress from, and the caller keeps the numbered readline
 * flow, exactly as the settings menus do.
 */
export function canRunOnboarding(streams: OnboardingStreams): boolean {
	return canSelect(streams.in as NodeJS.ReadStream, streams.out as NodeJS.WriteStream);
}

/** Where "Change the key or address" goes: the key screen, else the credential question, else the address. */
function fixStep(answers: Answers): Step {
	if (KEY_STEP.applies(answers)) return KEY_STEP;
	if (answers.runtime?.auth === "api-key") {
		answers.keyGiven = undefined;
		return CREDENTIAL_STEP;
	}
	return URL_STEP.applies(answers) ? URL_STEP : REVIEW_STEP;
}

// Credential steps come before the URL step: a runtime that needs or may need a
// key (litellm, every cloud runtime, keyed openai-compat) has to have one in
// hand before the URL step probes reachability, or the probe reads as
// unreachable when the gateway is live and only the key was missing. A runtime
// with no credential at all skips both credential steps and keeps this order
// exactly as it was.
const STEPS: ReadonlyArray<Step> = [
	OFFERED_STEP,
	HAVE_STEP,
	FILE_STEP,
	KEY_STEP,
	CATEGORY_STEP,
	RUNTIME_STEP,
	SDK_STEP,
	COPILOT_STEP,
	CREDENTIAL_STEP,
	CREDENTIAL_VALUE_STEP,
	URL_STEP,
	DETECTED_RUNTIME_STEP,
	MODEL_STEP,
	THINKING_STEP,
	CONTEXT_STEP,
	REVIEW_STEP,
];

/** Write everything the wizard collected, in one settings update. */
function applyAnswers(
	settings: PancodeSettings,
	answers: Answers,
	descriptor: TargetDescriptor,
	chatEligible: boolean,
): void {
	const current = settings.targets.find((target) => target.id === descriptor.id);
	if (answers.mode === "edit") {
		if (JSON.stringify(current) !== JSON.stringify(answers.existing))
			throw new Error("This target changed during setup; reopen Edit to keep those changes.");
	} else if (current && JSON.stringify(current) !== JSON.stringify(answers.detectedChatRoute?.target)) {
		throw new Error(`Target '${descriptor.id}' already exists; use Edit a target.`);
	}
	assertOrchestratorReplacementEligible(settings, descriptor);
	applyTarget(settings, descriptor);
	// The first target is the one everything points at. A second target is a
	// choice, and that is what the settings menu is for; asking a new user
	// which of their one target should answer chat is not a question.
	if (answers.mode === "first" && chatEligible) setOrchestratorPointer(settings, descriptor, answers.model ?? null);
	if (answers.mode === "first") setWorkerDefaultPointer(settings, descriptor, answers.model ?? null);
	if (answers.mode === "first" && answers.thinking !== undefined) {
		settings.chat.thinkingLevel = answers.thinking;
		settings.fleet.default.thinkingLevel = answers.thinking;
	}
}

export async function runOnboardingWizard(
	streams: OnboardingStreams,
	options:
		| {
				mode: "first" | "add";
				runtime?: RuntimeDescriptor;
				startsChat?: boolean;
				/** Send one short test request before Save; a function replaces the real request in tests. */
				verify?: boolean | SendChatTest;
		  }
		| { mode: "edit"; target: TargetDescriptor } = {
		mode: "first",
	},
	host?: ConfigureWizardHost,
): Promise<number> {
	const writer = host
		? { stream: streams.out, mark: () => 0, rewindTo: () => host.clearMessages() }
		: railWriter(streams.out);
	const presenter = createLifecyclePresenter({ stream: writer.stream, ...(host ? { plain: true } : {}) });
	const rail = railPrefix(presenter.isPlain());
	const columns = (streams.out as { columns?: number }).columns ?? 80;
	const wizard: Wizard = {
		goingBack: false,
		select: host?.select.bind(host) ?? promptSelect,
		text: host?.text.bind(host) ?? promptText,
		...(host ? { host } : {}),
		streams,
		presenter,
		rail,
		input: streams.in as NodeJS.ReadStream,
		output: streams.out as NodeJS.WriteStream,
		startsChat: options.mode !== "edit" && options.startsChat === true,
		answer: (label, value) => {
			presenter.fields([[label.padEnd(LABEL_WIDTH), truncate(value, Math.max(12, columns - LABEL_WIDTH - 6))]]);
		},
		sendTest:
			options.mode === "edit" || options.verify === undefined || options.verify === false
				? null
				: options.verify === true
					? sendChatTest
					: options.verify,
		refusalShown: false,
	};

	presenter.header(
		options.mode === "edit"
			? `Edit target: ${options.target.id}`
			: options.mode === "first"
				? "Welcome to PanCode"
				: "Add a target",
		"configure",
	);
	// A short terminal keeps the welcome and the line about Esc above the first question: at 15 rows this
	// sentence pushed the header, and the reason setup started, off the top of the screen.
	const rows = (streams.out as { rows?: number }).rows ?? 24;
	if (rows >= 20)
		presenter.note(
			"Choose what you already use. PanCode checks the endpoint and model list when the provider allows it.",
		);
	if (wizard.sendTest)
		presenter.note(
			"Before saving, PanCode sends the model one short test message (a few tokens; paid providers bill it).",
		);
	// "Nothing is saved" read as false to a first-run user who then found the
	// settings.yaml and credentials.yaml templates the home bootstrap writes. Those
	// hold no choice of theirs; the sentence is about the choices.
	// Under 20 rows the selector's own legend names Esc, so this sentence gives its rows to the header above.
	if (rows >= 20)
		presenter.note(
			`Esc goes back a step, and from the first step leaves without saving. Your choices are written to your PanCode settings only ${wizard.sendTest ? "after the test message" : "at the review"}, except a browser sign-in you complete.`,
		);

	const existing = options.mode === "edit" ? options.target : undefined;
	const offered: OfferedRoute[] = [];
	if (options.mode === "first" && !options.runtime) {
		const settings = readSettings();
		const { classifyDefaultTarget } = await import("./default-target.js");
		if (classifyDefaultTarget(settings).kind !== "usable") {
			const { collectSetupCandidates } = await import("./detect-chat-routes.js");
			const registry = getRuntimeRegistry();
			for (const candidate of await collectSetupCandidates(settings)) {
				const runtime = registry.get(candidate.target.runtime);
				if (!runtime) continue;
				offered.push({
					kind: candidate.source,
					source: candidate.label,
					runtime,
					target: candidate.target,
					...(candidate.model !== undefined ? { model: candidate.model } : {}),
					...(candidate.owner !== undefined ? { owner: candidate.owner } : {}),
				});
			}
		}
	}
	const answers: Answers = {
		mode: options.mode,
		offered,
		existing,
		runtime: existing
			? (getRuntimeRegistry().get(existing.runtime) ?? undefined)
			: options.mode !== "edit"
				? options.runtime
				: undefined,
		fixedRuntime: options.mode !== "edit" && options.runtime !== undefined,
		targetId:
			existing?.id ??
			(options.mode !== "edit" && options.runtime
				? deriveTargetId(options.runtime.id, readSettings().targets)
				: undefined),
		url: existing?.url,
		model: existing?.defaultModel,
		credential: existing?.auth?.apiKeyEnvVar ? "env" : existing?.auth?.apiKeyRef ? "keep" : undefined,
		apiKeyEnv: existing?.auth?.apiKeyEnvVar,
		contextWindow: existing?.capabilities?.contextWindow,
		thinking: existing?.capabilities?.reasoning === false ? "off" : undefined,
	};
	if (existing && !answers.runtime) {
		presenter.fail(`Unknown runtime: ${existing.runtime}`);
		return 2;
	}
	const stop = (quit = false): number => cancel(presenter, answers, { quit, advise: host === undefined });
	const marks = new Array<number>(STEPS.length).fill(writer.mark());
	const asked = new Set<number>();
	let cursor = 0;
	let direction = 1;

	while (cursor < STEPS.length) {
		if (host?.cancelled()) return stop(true);
		const step = STEPS[cursor];
		if (step === undefined) break;
		if (!step.applies(answers)) {
			cursor += direction;
			if (cursor < 0) return stop();
			continue;
		}
		marks[cursor] = writer.mark();
		asked.add(cursor);
		wizard.goingBack = direction < 0;
		const outcome = await step.run(wizard, answers);
		if (outcome === "quit" || outcome === "cancel") return stop(outcome === "quit");
		// A hosted wizard keeps its last message up under every later prompt, so an answered refusal
		// read as a failure the new credential had not fixed. The terminal rail keeps it as history.
		if (step === CREDENTIAL_STEP && outcome !== "back" && wizard.refusalShown) {
			wizard.refusalShown = false;
			host?.clearMessages();
		}
		if (outcome === "imported") {
			presenter.done("Done");
			return 0;
		}
		if (outcome === "model") {
			const modelStep = STEPS.indexOf(MODEL_STEP);
			answers.chooseModel = true;
			// The model row is replaced in place when the flow drew one; a found route went straight to the review.
			if (asked.has(modelStep)) writer.rewindTo(marks[modelStep] ?? writer.mark());
			direction = 1;
			cursor = modelStep;
			continue;
		}
		if (outcome === "detected" || (answers.detectedChatRoute && step === MODEL_STEP && outcome === "next")) {
			direction = 1;
			cursor = STEPS.indexOf(answers.model ? REVIEW_STEP : MODEL_STEP);
			continue;
		}
		if (outcome === "credential") {
			direction = 1;
			cursor = STEPS.indexOf(CREDENTIAL_STEP);
			continue;
		}
		if (outcome === "fix") {
			direction = 1;
			cursor = STEPS.indexOf(fixStep(answers));
			continue;
		}
		// Leaving the list "Choose a different model" opened returns to the review with the model unchanged.
		if (outcome === "back" && step === MODEL_STEP && answers.chooseModel && guidedFlow(answers)) {
			answers.chooseModel = undefined;
			if (answers.model !== undefined) wizard.answer("Model", answers.model);
			cursor = STEPS.indexOf(REVIEW_STEP);
			continue;
		}
		if (outcome === "back") {
			if (answers.detectedChatRoute) {
				cursor = 0;
				writer.rewindTo(marks[0] ?? writer.mark());
				continue;
			}
			direction = -1;
			cursor -= 1;
			// Rewind past the row the step we are returning to left behind, so it
			// can ask again in the same place rather than under its own answer.
			while (cursor >= 0 && !(STEPS[cursor]?.applies(answers) ?? false)) cursor -= 1;
			if (cursor < 0) return stop();
			writer.rewindTo(marks[cursor] ?? writer.mark());
			continue;
		}
		direction = 1;
		cursor += 1;
	}

	if (host?.cancelled()) return stop(true);
	return finish(wizard, answers);
}

function cancel(
	presenter: LifecyclePresenter,
	answers: Answers,
	options: { quit?: boolean; advise?: boolean } = {},
): number {
	// A first-run cancel really does leave PanCode unconfigured, which is why this
	// exits 130 where leaving the settings menu exits 0. It is still the user's
	// choice and not a failure, so the rail says it once and nothing follows on
	// stderr; the closing line used to be chased by `error: configuration cancelled`.
	if (answers.signInLater !== undefined && !options.quit) {
		presenter.commandAdvice(
			"Nothing was saved. When you are ready:",
			`pancode auth login ${answers.signInLater}, then pancode`,
		);
		presenter.done("Nothing was saved");
		return answers.mode === "first" ? 130 : 0;
	}
	if (answers.mode === "first" && options.advise !== false)
		presenter.commandAdvice(
			"PanCode cannot start until a model is set up. When you are ready, run:",
			"pancode configure",
		);
	presenter.done("Cancelled; nothing was saved");
	return answers.mode === "first" || options.quit === true ? 130 : 0;
}

async function finish(wizard: Wizard, answers: Answers): Promise<number> {
	const runtime = answers.runtime;
	// The id was derived when the runtime was chosen; another window can have taken it since.
	if (answers.mode !== "edit" && answers.runtime && answers.targetId !== undefined) {
		const taken = readSettings().targets;
		if (taken.some((target) => target.id === answers.targetId))
			answers.targetId = deriveTargetId(answers.runtime.id, taken);
	}
	const targetId = answers.targetId;
	if (!runtime || targetId === undefined)
		return cancel(wizard.presenter, answers, { advise: wizard.host === undefined });
	const presenter = wizard.presenter;

	const reasoning =
		PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id) && answers.thinking !== undefined
			? answers.thinking !== "off"
			: undefined;
	const descriptor = draftDescriptor(answers, runtime, true);
	descriptor.capabilities = { ...descriptor.capabilities };
	if (reasoning !== undefined) descriptor.capabilities.reasoning = reasoning;
	// Clearing the field removes only that capability override.
	if (answers.contextWindow === undefined) delete descriptor.capabilities.contextWindow;
	else descriptor.capabilities.contextWindow = answers.contextWindow;
	const chatEligible = isOrchestratorEligibleRuntime(runtime);

	try {
		const preview = readSettings();
		applyAnswers(preview, answers, descriptor, chatEligible);
		const validated = validateSettings(preview);
		if (validated.issues.length) throw new SettingsValidationError(validated.issues);
		initializePancodeHome();

		if (answers.apiKeyLiteral !== undefined && descriptor.auth?.apiKeyRef) {
			const auth = openAuthStorage();
			auth.setApiKey(descriptor.auth.apiKeyRef, answers.apiKeyLiteral);
			// The settings write is still ahead of us, so refusing here leaves the
			// whole run without an effect rather than half of one.
			if (
				wizard.host
					? auth.damageReason() !== null
					: credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${targetId}' not saved`)
			) {
				if (wizard.host) presenter.fail("Credential not stored", auth.damageReason() ?? "unknown");
				presenter.done("Nothing written");
				return 1;
			}
			// Inside the TUI the flag is not something the operator can type; the credential step's choice is.
			presenter.warn(
				wizard.host
					? `API key stored unencrypted (${credentialFileProtection()}). Any process running as you can read it. Edit the target and choose Environment variable to keep the key off disk.`
					: `API key stored unencrypted (${credentialFileProtection()}). Any process running as you can read it. Use --api-key-env <VAR> to keep the key off disk.`,
			);
		}

		const appKey = answers.storeKeyForApp && answers.apiKeyEnv ? process.env[answers.apiKeyEnv] : undefined;
		const appTarget = resolveAuthTarget(descriptor, runtime);
		if (appKey && appTarget.targetEnvVar) {
			const auth = openAuthStorage();
			// The copy is the variable's own entry, never the runtime's slot that other targets and `auth login` share.
			auth.storeEnvKeyCopy(appTarget, appKey);
			if (
				wizard.host
					? auth.damageReason() !== null
					: credentialWriteFailed(
							auth,
							`${answers.apiKeyEnv} was not stored for the desktop app; target '${targetId}' not saved`,
						)
			) {
				if (wizard.host) presenter.fail("Credential not stored", auth.damageReason() ?? "unknown");
				presenter.done("Nothing written");
				return 1;
			}
			presenter.warn(
				`${answers.apiKeyEnv} stored unencrypted (${credentialFileProtection()}) for the desktop app. Any process running as you can read it. ${targetId} still reads the variable first.`,
			);
		}

		updateSettings((settings) => applyAnswers(settings, answers, descriptor, chatEligible));
		if (typeof answers.tested === "object" && answers.model !== undefined)
			recordTargetCheck(descriptor, answers.model, answers.tested.latencyMs);
		wizard.host?.onTargetSaved?.();
	} catch (error) {
		presenter.fail("settings were not written", error instanceof Error ? error.message : String(error));
		presenter.done("Target settings not saved");
		return 1;
	}

	presenter.completedStep(`target ${targetId} saved, runtime ${runtime.id}`);
	if (answers.mode === "first" && chatEligible)
		presenter.completedStep(`chat runs on ${targetId}${answers.model ? `, model ${answers.model}` : ""}`);
	else if (!chatEligible)
		presenter.completedStep(`${runtime.id} cannot answer chat; ${targetId} is registered for dispatch only`);
	if (answers.mode === "first") presenter.completedStep(`fleet default is ${targetId}`);
	else presenter.note("Use Settings → Chat, Fleet, or Context & Memory to change model defaults.");
	if (answers.mode === "first" && answers.thinking !== undefined)
		presenter.completedStep(`thinking level ${answers.thinking}`);
	presenter.completedStep(`settings written to ${shortenPath(settingsPath())}`);
	if (typeof answers.tested === "object")
		presenter.completedStep(
			answers.mode === "first"
				? "Saved. Chat and workers use this model. Change it any time with /model or /config."
				: "Saved. The model answered its test request.",
		);
	else if (answers.tested === "skipped") presenter.warn(`${targetId} was saved without a passed test request.`);

	if (contextWindowUndiscovered(descriptor, answers.probe ?? null)) {
		presenter.warn(
			wizard.host
				? `${targetId} reported no context window, so PanCode will use the runtime default as a guess. Set the real one in Settings → Connections: select ${targetId} and choose Edit.`
				: `${targetId} reported no context window, so PanCode will use the runtime default as a guess. Set the real one with \`pancode configure --id ${targetId} --runtime ${runtime.id} --context-window <N>\`.`,
		);
	}

	if (!wizard.host) {
		if (!wizard.startsChat) presenter.commandAdvice("Start PanCode:", "pancode");
		presenter.commandAdvice("Change any of this later:", "pancode configure");
	}
	presenter.done("Done");
	return 0;
}
