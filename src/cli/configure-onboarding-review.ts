// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import chalk from "chalk";
import { isLoopbackUrl } from "../core/project-target-urls.js";
import { pancodeStateDir } from "../core/xdg.js";
import { backgroundPackageRoot } from "../domains/install/install-plan.js";
import { authStoragePath } from "../domains/providers/auth/index.js";
import { observeHostCapacityFacts, resolveLocalConcurrency } from "../domains/scheduling/local-capacity.js";
import type { ChatTestOutcome, SendChatTest } from "./chat-test.js";
import { chatTestFix } from "./chat-test.js";
import {
	type Answers,
	draftDescriptor,
	guidedFlow,
	type Step,
	type StepOutcome,
	type Wizard,
} from "./configure-onboarding-state.js";
import { describeAuthStatus } from "./configure-target.js";
import { shortenPath } from "./lifecycle-presenter.js";
import { credentialFileProtection } from "./shared.js";
import { truncate } from "./text-layout.js";

function verificationSummary(answers: Answers): string[] {
	const probe = answers.probe;
	const endpoint = !probe
		? "Endpoint: no passive check available"
		: probe.ok
			? answers.runtime?.id === "alcf"
				? "ALCF catalog reachable; URL untested"
				: "Endpoint: reachable (metadata only)"
			: "Endpoint: did not answer when checked";
	const inventory = answers.inventory;
	const models =
		inventory?.source === "probe"
			? `Models: ${inventory.models.length} listed live`
			: inventory?.source === "catalog"
				? "Models: provider catalog (not live)"
				: inventory?.source === "cache"
					? "Models: earlier cache (not live now)"
					: inventory?.source === "existing"
						? "Models: existing settings (not live)"
						: "Model ID: unverified";
	return [endpoint, models];
}

export const REVIEW_STEP: Step = {
	id: "review",
	applies: () => true,
	run: async (wizard, answers) => {
		// With the test request on, setup ends on the test; the review sits behind "Connection and machine details".
		if (wizard.sendTest && !answers.reviewing) {
			const tested = await testBeforeSave(wizard, answers, wizard.sendTest);
			if (tested !== "details") return tested;
			answers.reviewing = true;
		}
		const facts = observeHostCapacityFacts();
		const capacity = resolveLocalConcurrency("auto", facts);
		// The dock has 16 body rows and may be only 40 columns wide. Keep the
		// summary compact; detailed observations are reachable before Save.
		for (;;) {
			const result = await wizard.select({
				heading: [
					"",
					chalk.bold("Review what PanCode could verify"),
					truncate(`Connection: ${answers.targetId}`, wizard.host ? 36 : 70),
					truncate(`Model: ${answers.model}`, wizard.host ? 36 : 70),
					...verificationSummary(answers),
					wizard.sendTest ? "Save sends one short test message first." : "No generation or quality/tool tests.",
					"GPU/VRAM and model fit not checked.",
					// Local worker capacity only matters when this machine runs the models.
					...(answers.url !== undefined && isLoopbackUrl(answers.url) ? [`Automatic local workers: ${capacity.limit}`] : []),
					answers.mode === "first" ? "Save sets the chat and fleet model." : "Existing routes stay in place.",
				],
				choices: [
					{ value: "save", label: "Save target" },
					...(guidedFlow(answers) ? [{ value: "model", label: "Choose a different model" }] : []),
					{ value: "details", label: "Connection and machine details" },
					{ value: "back", label: "Back" },
					{ value: "cancel", label: "Cancel setup" },
				],
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind !== "selected") return result.kind;
			if (result.value === "model") return "model";
			if (result.value === "save" && wizard.sendTest) {
				const tested = await testBeforeSave(wizard, answers, wizard.sendTest);
				if (tested === "details") continue;
				return tested;
			}
			if (result.value !== "details")
				return result.value === "save" ? "next" : result.value === "back" ? "back" : "cancel";
			const detailPages = [
				["Connection details", answers.runtime?.displayName ?? "", `ID: ${answers.targetId}`, `Model: ${answers.model}`],
				[
					"Connection address",
					answers.url ?? "Provider-managed address",
					answers.probe ? "This was a passive metadata check." : "Endpoint reachability was not checked.",
					"No generation request was sent.",
				],
				[
					"Credential handling",
					...(answers.credential === "stored"
						? [
								"Key written only when you save.",
								`Local storage: ${credentialFileProtection()}.`,
								"Storage is not encrypted.",
							]
						: answers.credential === "env"
							? [
									`Read from $${answers.apiKeyEnv}`,
									answers.apiKeyEnv && process.env[answers.apiKeyEnv] ? "Set in this process." : "Not set in this process.",
								]
							: answers.credential === "keep"
								? ["Keep the saved credential."]
								: answers.runtime?.auth === "oauth"
									? ["Browser sign-in is saved immediately.", describeAuthStatus(answers.runtime, answers.existing)]
									: ["No API key selected.", "SDK/app sessions are not inspected."]),
					"No generation checked key validity.",
				],
				[
					"Machine observations",
					`${facts.cpus} usable CPUs`,
					`${(facts.availableMemoryBytes / 1024 ** 3).toFixed(1)} GiB available memory`,
					...(facts.cgroupAvailableBytes === null
						? []
						: [`${(facts.cgroupAvailableBytes / 1024 ** 3).toFixed(1)} GiB available to this process`]),
					`${capacity.limit} automatic local workers`,
					`Sizing bound: ${capacity.bound}`,
					"GPU/VRAM and model fit not checked.",
					"Answer quality and tool use untested.",
				],
			];
			let page = 0;
			while (page < detailPages.length) {
				const detail = await wizard.select({
					heading: detailPages[page] ?? [],
					choices: [
						{ value: "next", label: page === detailPages.length - 1 ? "Return to review" : "Next" },
						{ value: "previous", label: page === 0 ? "Return to review" : "Previous" },
					],
					railPrefix: wizard.rail,
					backLabel: "review",
					clearOnExit: true,
					input: wizard.input,
					output: wizard.output,
				});
				if (detail.kind === "quit") return "quit";
				if (detail.kind === "back") break;
				if (detail.value === "previous") {
					if (page === 0) break;
					page--;
				} else page++;
			}
		}
	},
};

/**
 * Send the test request and stay on its screen until it answers or the person
 * chooses: try again, change the key or address, save anyway, or open the review.
 */
async function testBeforeSave(wizard: Wizard, answers: Answers, send: SendChatTest): Promise<StepOutcome | "details"> {
	const runtime = answers.runtime;
	const model = answers.model;
	if (!runtime || model === undefined) return "next";
	const label = `${answers.targetId} / ${model}`;
	for (;;) {
		wizard.presenter.note(`Testing ${label} ...`);
		wizard.host?.waiting?.(`Testing ${label}…`);
		const target = draftDescriptor(answers, runtime, true);
		const apiKey =
			answers.apiKeyLiteral ??
			(answers.credential === "env" && answers.apiKeyEnv ? process.env[answers.apiKeyEnv] : undefined);
		const outcome: ChatTestOutcome = await send({
			runtime,
			target,
			model,
			...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
		});
		if (outcome.ok) {
			answers.tested = { latencyMs: outcome.latencyMs };
			wizard.presenter.completedStep(`Testing ${label} ... answered in ${(outcome.latencyMs / 1000).toFixed(1)} s.`);
			return offerKeyForApp(wizard, answers);
		}
		const fix = chatTestFix(outcome, {
			provider: runtime.displayName,
			model,
			...(answers.url !== undefined ? { url: answers.url } : {}),
		});
		wizard.presenter.warn(`${label} did not answer: ${truncate(outcome.message, 200)}`);
		const result = await wizard.select<"retry" | "fix" | "model" | "save" | "details" | "cancel">({
			heading: ["", chalk.bold("The test request failed"), fix],
			choices: [
				{ value: "retry", label: "Try again" },
				{ value: "fix", label: "Change the key or address" },
				...(outcome.httpStatus === 404 ? [{ value: "model" as const, label: "Choose a different model" }] : []),
				{ value: "save", label: "Save anyway", hint: "saved as not checked" },
				{ value: "details", label: "Connection and machine details" },
				{ value: "cancel", label: "Cancel setup" },
			],
			railPrefix: wizard.rail,
			backLabel: "review",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value === "retry") continue;
		if (result.value === "save") {
			answers.tested = "skipped";
			return "next";
		}
		return result.value;
	}
}

/**
 * The desktop app runs as a background service that never sees this shell's environment, so a route that
 * reads its key from a variable would not work there. When the app is installed, the passed test asks once
 * whether to store the key for it too. The target keeps reading the variable first.
 */
async function offerKeyForApp(wizard: Wizard, answers: Answers): Promise<StepOutcome> {
	answers.storeKeyForApp = undefined;
	const variable = answers.credential === "env" ? answers.apiKeyEnv : undefined;
	if (wizard.host?.desktop || !variable || !process.env[variable]) return "next";
	if (backgroundPackageRoot(pancodeStateDir()) === null) return "next";
	const result = await wizard.select<boolean>({
		heading: [
			"",
			chalk.bold("The desktop app cannot see this shell's key. Store it for the app too?"),
			`PanCode would store ${variable} unencrypted in ${shortenPath(authStoragePath())} (${credentialFileProtection()}).`,
		],
		choices: [
			{ value: false, label: "No", hint: "the app asks for the key itself" },
			{ value: true, label: "Yes, store it" },
		],
		railPrefix: wizard.rail,
		backLabel: "back",
		clearOnExit: true,
		input: wizard.input,
		output: wizard.output,
	});
	if (result.kind === "quit") return "quit";
	if (result.kind === "back") return "back";
	answers.storeKeyForApp = result.value;
	return "next";
}
