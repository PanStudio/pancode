// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readSettings } from "../core/config.js";
import type { ThinkingLevel } from "../core/defaults.js";
import type { Candidate } from "../domains/install/setup-status.js";
import type { ProviderSupportEntry } from "../domains/providers/index.js";
import { buildProviderSupportEntry, listProviderSupportEntries } from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { SendChatTest } from "./chat-test.js";
import type { ConfigureWizardHost } from "./configure-host.js";
import type { ConfigureCategory } from "./configure-layout.js";
import type { WireModelInventory } from "./configure-target.js";
import { buildDescriptor, targetApiKeyRef } from "./configure-target.js";
import type { DetectedChatRoute } from "./detect-chat-routes.js";
import type { LifecyclePresenter } from "./lifecycle-presenter.js";

export interface OnboardingStreams {
	in: NodeJS.ReadableStream;
	out: NodeJS.WritableStream;
}

/** Every answer row uses this label column, so the values line up down the rail. */
export const LABEL_WIDTH = 11;

export type CredentialSource = "env" | "stored" | "keep" | "skip" | "oauth-connect" | "oauth-skip";

// Every field is `| undefined` on purpose, not decoratively: the repo compiles
// with exactOptionalPropertyTypes, and going back a step clears the answers
// that depended on the one being changed by assigning undefined to them.
export interface Answers {
	mode: "first" | "add" | "edit";
	/** Routes PanCode found before the first question, best first; only the first-run flow offers them. */
	offered: ReadonlyArray<OfferedRoute>;
	detectedChatRoute?: DetectedChatRoute | undefined;
	/** The first-run flow's "What do you have?" answer. */
	have?: Have | undefined;
	/** The key screen supplied the credential, so the credential screens are not asked. */
	keyGiven?: boolean | undefined;
	/** The provider the key itself named, by its prefix or its variable, so the provider list is not asked. */
	keyProvider?: string | undefined;
	/** The setup file's path or address, kept so Back from its review shows it again. */
	setupSource?: string | undefined;
	/** The review's "Choose a different model" asked for the list the flow otherwise skips. */
	chooseModel?: boolean | undefined;
	fixedRuntime?: boolean;
	existing?: TargetDescriptor | undefined;
	contextWindow?: number | undefined;
	category?: ConfigureCategory | undefined;
	runtime?: RuntimeDescriptor | undefined;
	targetId?: string | undefined;
	url?: string | undefined;
	/** Native runtime the URL turned out to be serving, when it is not the chosen one. */
	detected?: { runtimeId: string; displayName: string } | undefined;
	credential?: CredentialSource | undefined;
	/** A local server answered 401 or 403, so the credential question it skipped is now asked. */
	keyRequested?: boolean | undefined;
	/** The address step sent the operator to the credential step; its address is checked again, not asked again. */
	recheckUrl?: boolean | undefined;
	apiKeyEnv?: string | undefined;
	apiKeyLiteral?: string | undefined;
	inventory?: WireModelInventory | undefined;
	/** The inputs the cached inventory was read for, so a changed URL re-reads it. */
	inventoryKey?: string | undefined;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	probe?: ProbeResult | null | undefined;
	/** The address step's failure, when it already told the operator why the model list will not come. */
	unreachable?: string | undefined;
	/** The sign-in was put off or failed, so the wizard ends with nothing saved and names the login command. */
	signInLater?: string | undefined;
	/** The test request before Save: how long the model took to answer, or "skipped" when saved anyway. */
	tested?: { latencyMs: number } | "skipped" | undefined;
	/** The review was opened from the test screen, so the review step shows it instead of testing at once. */
	reviewing?: boolean | undefined;
	/** The desktop app cannot read this shell's environment, so the key in `apiKeyEnv` is stored for it as well. */
	storeKeyForApp?: boolean | undefined;
}

export type StepOutcome =
	| "next"
	| "back"
	| "quit"
	| "cancel"
	| "credential"
	| "detected"
	| "model"
	| "imported"
	| "fix";

export type Have = "key" | "subscription" | "server" | "file" | "list";

/** A route `collectSetupCandidates` found, with the runtime it runs on. */
export interface OfferedRoute extends DetectedChatRoute {
	kind: Candidate<TargetDescriptor>["source"];
	owner?: string;
}

/** `configure` and Add a target with no preset runtime: both open on what the user has (first run also on what PanCode found). */
export function asksWhatTheyHave(answers: Answers): boolean {
	return answers.mode !== "edit" && !answers.fixedRuntime;
}

/** The flow that asks what the user has, unless Add a target's "Every provider and app" row left it for the category list. */
export function guidedFlow(answers: Answers): boolean {
	return asksWhatTheyHave(answers) && answers.have !== "list";
}

export interface Wizard {
	/** The loop is stepping back, so a step that would answer itself hands the cursor on instead. */
	goingBack: boolean;
	select: ConfigureWizardHost["select"];
	text: ConfigureWizardHost["text"];
	host?: ConfigureWizardHost;
	streams: OnboardingStreams;
	presenter: LifecyclePresenter;
	rail: string;
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	/** The caller starts the chat session as soon as this returns, so the wizard does not tell the user how to. */
	startsChat: boolean;
	/** Row on the rail, at the wizard's shared label column. */
	answer: (label: string, value: string) => void;
	/** Save first sends one short test request; null when this run saves without one. */
	sendTest: SendChatTest | null;
	/** A refused-credential warning is up and asks for a credential; answering that question retires it. */
	refusalShown: boolean;
}

export interface Step {
	id: string;
	applies: (answers: Answers) => boolean;
	run: (wizard: Wizard, answers: Answers) => Promise<StepOutcome>;
}

/**
 * The presenter's stream, counting the lines that went through it.
 *
 * Going back a step has to erase the row the step left behind, and the only
 * honest way to know how many lines that is, is to count what was written. The
 * pickers are not counted because they erase their own frame before returning.
 */
interface RailWriter {
	stream: NodeJS.WritableStream;
	mark: () => number;
	rewindTo: (mark: number) => void;
}

export function railWriter(out: NodeJS.WritableStream): RailWriter {
	let lines = 0;
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			for (const char of text) if (char === "\n") lines += 1;
			return out.write(chunk);
		},
		isTTY: (out as { isTTY?: boolean }).isTTY,
		columns: (out as { columns?: number }).columns,
	} as unknown as NodeJS.WritableStream;
	return {
		stream,
		mark: () => lines,
		rewindTo(mark) {
			const back = lines - mark;
			if (back > 0) out.write(`\u001B[${back}A\u001B[0J`);
			lines = mark;
		},
	};
}

export function supportFor(runtime: RuntimeDescriptor): ProviderSupportEntry {
	return buildProviderSupportEntry(runtime);
}

export function allEntries(): ProviderSupportEntry[] {
	return listProviderSupportEntries(getRuntimeRegistry().list());
}

/** The descriptor as it stands mid-wizard, for a probe or a model read. */
export function draftDescriptor(answers: Answers, runtime: RuntimeDescriptor, withModel: boolean): TargetDescriptor {
	if (answers.detectedChatRoute) {
		const target = structuredClone(answers.detectedChatRoute.target);
		if (withModel && answers.model) target.defaultModel = answers.model;
		else delete target.defaultModel;
		return target;
	}
	const apiKeyRef =
		answers.credential === "stored"
			? targetApiKeyRef(answers.targetId ?? runtime.id, readSettings().targets)
			: answers.credential === "keep" && runtime.auth === "api-key"
				? (answers.existing?.auth?.apiKeyRef ?? runtime.id)
				: undefined;
	const configured = buildDescriptor(runtime, answers.targetId ?? runtime.id, {
		...(answers.url !== undefined ? { url: answers.url } : {}),
		...(withModel && answers.model !== undefined ? { model: answers.model } : {}),
		...(answers.apiKeyEnv !== undefined ? { apiKeyEnv: answers.apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(runtime.auth === "oauth"
			? { oauthProfile: answers.existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id }
			: {}),
	});
	const sameRuntime = answers.existing?.runtime === runtime.id;
	const descriptor = { ...(sameRuntime ? answers.existing : {}), ...configured };
	if (!supportFor(runtime).supportsCustomUrl) delete descriptor.url;
	if (!withModel) delete descriptor.defaultModel;
	if ((sameRuntime && answers.existing?.auth) || configured.auth) {
		descriptor.auth = { ...(sameRuntime ? answers.existing?.auth : {}), ...configured.auth };
		if (runtime.auth === "api-key") {
			if (answers.credential !== "env") delete descriptor.auth.apiKeyEnvVar;
			if (answers.credential !== "stored" && answers.credential !== "keep") delete descriptor.auth.apiKeyRef;
		}
		if (Object.keys(descriptor.auth).length === 0) delete descriptor.auth;
	}
	return descriptor;
}

/** Rows of the first-run list, saying where each route came from in the user's words. */
export function offeredRow(route: OfferedRoute): { label: string; hint: string } {
	const name = route.runtime.displayName;
	const label =
		route.kind === "env-key"
			? `${name}, with the key in ${route.source}`
			: route.kind === "stored-login"
				? `${name}, ${route.runtime.auth === "api-key" ? "stored key" : "signed in"}`
				: route.kind === "configured-target"
					? `${name}, saved in your settings`
					: route.kind === "project"
						? `${name}, from this project's settings`
						: `A model server at ${route.target.url ?? route.source} (${name})`;
	const model =
		route.model === undefined
			? "choose a model next"
			: route.model === supportFor(route.runtime).defaultModel
				? `model ${route.model} (recommended)`
				: `model ${route.model}`;
	return { label, hint: route.owner ? `${model}, run by user ${route.owner}` : model };
}

/** Forget every connection answer, for a first-run choice that starts a different path. */
export function clearConnection(answers: Answers): void {
	answers.detectedChatRoute = undefined;
	answers.category = undefined;
	answers.runtime = undefined;
	answers.targetId = undefined;
	answers.url = undefined;
	answers.detected = undefined;
	answers.credential = undefined;
	answers.keyRequested = undefined;
	answers.keyGiven = undefined;
	answers.keyProvider = undefined;
	answers.apiKeyEnv = undefined;
	answers.apiKeyLiteral = undefined;
	answers.model = undefined;
	answers.chooseModel = undefined;
	answers.thinking = undefined;
	answers.contextWindow = undefined;
	answers.probe = undefined;
	answers.inventory = undefined;
	answers.inventoryKey = undefined;
	answers.unreachable = undefined;
}
