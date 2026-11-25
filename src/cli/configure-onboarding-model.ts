// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import chalk from "chalk";
import type { ThinkingLevel } from "../core/defaults.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import { recordProbedModelSnapshot, runtimeListsModelsLive } from "../domains/providers/index.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { keyWaitsForRefusal, REFUSED_CREDENTIAL, warnRefused } from "./configure-onboarding-credential.js";
import {
	type Answers,
	draftDescriptor,
	guidedFlow,
	type Step,
	supportFor,
	type Wizard,
} from "./configure-onboarding-state.js";
import type { WireModelInventory } from "./configure-target.js";
import {
	chatPickerModels,
	inventoryGap,
	inventoryNote,
	modelChoiceRefusal,
	modelSupportsThinking,
	preferredModelFor,
	resolveSupportedWireModels,
	runtimeProbe,
} from "./configure-target.js";

/** Read the model list once per distinct set of connection answers. */
async function modelInventory(
	wizard: Wizard,
	answers: Answers,
	runtime: RuntimeDescriptor,
): Promise<WireModelInventory> {
	const key = [
		runtime.id,
		answers.targetId,
		answers.url,
		answers.apiKeyEnv,
		answers.apiKeyLiteral ? "literal" : "",
	].join("|");
	if (answers.inventoryKey === key && answers.inventory) return answers.inventory;
	wizard.host?.waiting?.("Reading the model list…");
	const inventory = await resolveSupportedWireModels(
		runtime,
		draftDescriptor(answers, runtime, false),
		undefined,
		answers.apiKeyLiteral,
	);
	answers.inventory = inventory;
	answers.inventoryKey = key;
	return inventory;
}

export const MODEL_STEP: Step = {
	id: "model",
	applies: () => true,
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const support = supportFor(runtime);
		const inventory = await modelInventory(wizard, answers, runtime);
		// A catalog-ordered list has no head worth recommending: openai's first of
		// 38 ids is `gpt-4` because g sorts early.
		const preferred = answers.model ?? preferredModelFor(inventory, support);

		if (
			inventory.models.length === 0 &&
			keyWaitsForRefusal(answers, runtime) &&
			REFUSED_CREDENTIAL.test(inventory.probeError ?? "")
		) {
			// A keyed llama.cpp or vLLM answers its health check and refuses only the model list.
			answers.keyRequested = true;
			answers.inventoryKey = undefined;
			warnRefused(wizard, answers);
			return "credential";
		}
		if (inventory.models.length === 0) {
			// The address step just said why, in these words; the list failing for the same reason adds nothing.
			if (answers.unreachable === undefined || answers.unreachable !== inventory.probeError)
				wizard.presenter.warn(inventoryGap(runtime, { url: answers.url }, inventory.probeError));
			answers.unreachable = undefined;
			const canDetect = runtimeListsModelsLive(runtime);
			const result = await wizard.select<"retry" | "back" | "manual" | "key">({
				heading: [
					"",
					chalk.bold("PanCode could not read a model list"),
					chalk.dim(
						canDetect
							? "Start the app or server and load a model, then retry. No generation request is sent."
							: "This provider has no discovery API PanCode can use.",
					),
				],
				choices: [
					...(canDetect
						? [{ value: "retry" as const, label: "Check again", hint: "probe the endpoint and read its model list" }]
						: []),
					// A keyed server answers its health check and refuses only the list, which no probe can tell from an
					// empty one, so the key question the setup skipped stays one choice away.
					...(keyWaitsForRefusal(answers, runtime)
						? [
								{
									value: "key" as const,
									label: "This server needs an API key",
									hint: "choose a credential, then read the model list again",
								},
							]
						: []),
					{ value: "back", label: "Change the connection", hint: "go back without saving" },
					{
						value: "manual",
						label: "Enter an unverified model ID",
						hint: "advanced: PanCode cannot verify it before saving",
					},
				],
				initialIndex: 0,
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back" || result.value === "back") return "back";
			if (result.value === "key") {
				answers.keyRequested = true;
				answers.inventoryKey = undefined;
				return "credential";
			}
			if (result.value === "retry") {
				answers.inventoryKey = undefined;
				wizard.presenter.step("checking the endpoint and model list again");
				return MODEL_STEP.run(wizard, answers);
			}
			const manual = await wizard.text({
				heading: [
					"",
					chalk.bold("Unverified model id"),
					chalk.dim("PanCode will send this exact text. The endpoint and capabilities remain unverified."),
				],
				initial: preferred ?? "",
				hint: "use only the exact wire id from the provider or server documentation",
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				validate: (value) => (value.length === 0 ? "a model id is required" : null),
				input: wizard.input,
				output: wizard.output,
			});
			if (manual.kind !== "value") return manual.kind;
			answers.model = manual.value;
			wizard.answer("Model", `${manual.value}  ${chalk.dim("(unverified)")}`);
			await readModelCapabilities(answers, runtime);
			return "next";
		}

		// The curated default leads the list, marked, so a long catalog does not rest on whatever sorts first.
		const offered = chatPickerModels(inventory);
		const recommended =
			support.defaultModel !== undefined && offered.includes(support.defaultModel) ? support.defaultModel : undefined;
		const models =
			recommended !== undefined ? [recommended, ...offered.filter((model) => model !== recommended)] : offered;
		// The guided flow takes the recommended model, or the only one a server lists; the review offers the list.
		const automatic =
			guidedFlow(answers) && !answers.chooseModel
				? (recommended ?? (offered.length === 1 ? offered[0] : undefined))
				: undefined;
		if (
			automatic !== undefined &&
			modelChoiceRefusal(runtime, { id: answers.targetId ?? runtime.id, url: answers.url }, automatic, inventory) === null
		) {
			if (wizard.goingBack) return "back";
			answers.model = automatic;
			wizard.answer(
				"Model",
				`${automatic}  ${chalk.dim(automatic === recommended ? "(recommended)" : "(the only one listed)")}`,
			);
			await readModelCapabilities(answers, runtime);
			return "next";
		}
		const selected = models.indexOf(preferred ?? "");
		const result = await wizard.select<string>({
			heading: [
				"",
				chalk.bold("Which model?"),
				chalk.dim(inventoryNote(runtime, inventory) ?? "read live from the target just now"),
			],
			choices: models.map((model) => {
				const state = inventory.modelStates?.[model]?.state;
				const hint =
					model === preferred && model !== recommended
						? "default"
						: state !== undefined && state !== "unknown"
							? state
							: undefined;
				const label = inventory.labels?.[model];
				const named = label && label !== model ? `${model} — ${label}` : model;
				return {
					value: model,
					label: model === recommended ? `${named} (recommended)` : named,
					...(hint === undefined ? {} : { hint }),
				};
			}),
			initialIndex: selected >= 0 ? selected : 0,
			searchable: models.length > 8,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const refusal = modelChoiceRefusal(
			runtime,
			{ id: answers.targetId ?? runtime.id, url: answers.url },
			result.value,
			inventory,
		);
		if (refusal !== null) {
			wizard.presenter.warn(refusal);
			return "back";
		}
		answers.model = result.value;
		wizard.answer("Model", result.value);
		await readModelCapabilities(answers, runtime);
		return "next";
	},
};

/**
 * Probe once more with the chosen model set, because a model's context window
 * and whether it reasons are per-model facts and the earlier probe ran before
 * there was a model to ask about.
 */
export async function readModelCapabilities(answers: Answers, runtime: RuntimeDescriptor): Promise<void> {
	const descriptor = draftDescriptor(answers, runtime, true);
	const probe = await runtimeProbe(runtime, descriptor, answers.apiKeyLiteral);
	answers.probe = probe;
	if (probe) recordProbedModelSnapshot(descriptor, runtime, probe);
}

const THINKING_HINTS: Readonly<Record<ThinkingLevel, string>> = {
	off: "never ask this model to think before answering",
	minimal: "a sentence of reasoning",
	low: "short reasoning, the usual choice",
	medium: "more reasoning on hard turns",
	high: "long reasoning, slower and more expensive",
	xhigh: "longer still, where the model offers it",
	max: "everything the model will spend",
};

export const THINKING_STEP: Step = {
	id: "thinking",
	applies: (answers) => {
		if (answers.mode !== "edit") return false;
		const runtime = answers.runtime;
		if (!runtime || answers.model === undefined) return false;
		return modelSupportsThinking(runtime, draftDescriptor(answers, runtime, true), answers.probe ?? null);
	},
	run: async (wizard, answers) => {
		const current = THINKING_LEVELS.indexOf(answers.thinking ?? "low");
		const result = await wizard.select<ThinkingLevel>({
			heading: [
				"",
				chalk.bold("How hard should it think?"),
				chalk.dim(
					answers.mode === "first"
						? "changeable any time in `pancode configure`"
						: "off disables reasoning for this target; chat and fleet thinking defaults stay unchanged",
				),
			],
			choices: THINKING_LEVELS.map((level) => ({ value: level, label: level, hint: THINKING_HINTS[level] })),
			initialIndex: current >= 0 ? current : 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		answers.thinking = result.value;
		wizard.answer("Thinking", result.value);
		return "next";
	},
};

export const CONTEXT_STEP: Step = {
	id: "context-window",
	applies: (answers) => answers.mode === "edit",
	run: async (wizard, answers) => {
		const result = await wizard.text({
			heading: ["", chalk.bold("Context window in tokens")],
			initial: answers.contextWindow === undefined ? "" : String(answers.contextWindow),
			hint: "optional override; blank uses detected capabilities or the runtime default",
			validate: (value) =>
				value === "" || (Number.isSafeInteger(Number(value)) && Number(value) > 0)
					? null
					: "enter a positive whole number, or leave blank",
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind !== "value") return result.kind;
		answers.contextWindow = result.value ? Number(result.value) : undefined;
		wizard.answer("Context", result.value || "detected / runtime default");
		return "next";
	},
};
