// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join } from "node:path";
import type { PancodeSettings } from "../core/config.js";
import { readSettings } from "../core/config.js";
import { projectChosenTargetUrl, projectTargetKeyVariable } from "../core/project-target-urls.js";
import { readSettingsDocument } from "../core/settings-document.js";
import { resolvePancodeDirs } from "../core/xdg.js";
import {
	describeMissing,
	type Missing,
	type SetupFacts,
	type SetupTargetFacts,
	setupStatus,
} from "../domains/install/setup-status.js";
import { bootAuthStatus } from "../domains/providers/auth/boot-status.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";

/**
 * Why the configured chat target cannot be used, in the operator's terms
 * rather than as one boolean.
 *
 * This stays a cheap credential-presence check. Only an unusable verdict
 * loads route discovery; a configured user never pays for local probes.
 */
export type DefaultTargetVerdict =
	| { kind: "usable" }
	| { kind: "no-target" }
	| { kind: "no-model"; targetId: string }
	| { kind: "ineligible-runtime"; targetId: string; runtime: string }
	| { kind: "missing-credential"; targetId: string; store: string };

/**
 * Whether a user has made a route choice in this home before the current launch.
 *
 * The file's existence cannot say so: the installer's post-install step,
 * `doctor --fix` and a non-TTY first boot all write the scaffold. A choice
 * leaves a target or a chat route behind, so the raw file is read for either;
 * adopting a detected route adds a target, so a home that adopted once stays
 * returning. Call this before `initializePancodeHome()`, which writes the file.
 */
export function homeIsReturning(): boolean {
	const read = readSettingsDocument(join(resolvePancodeDirs().config, "settings.yaml"));
	if (read.kind !== "parsed") return false;
	const raw = read.document as { connections?: unknown; chat?: { connection?: unknown } } | null;
	if (!raw || typeof raw !== "object") return false;
	return (Array.isArray(raw.connections) && raw.connections.length > 0) || (raw.chat?.connection ?? null) !== null;
}

/**
 * The facts `setupStatus` reads for the saved chat route, gathered cheaply: the runtime's metadata and
 * credential presence, never a probe. Only an unusable answer loads route discovery.
 */
function setupFactsFor(settings: Readonly<PancodeSettings>): SetupFacts {
	const targetId = settings.chat.connection;
	// A chat target naming an id that is not in `connections` cannot arrive here: the schema normalizes dangling
	// routing references to null, so deleting a target reaches `setupStatus` as an unchosen route.
	const target = targetId ? settings.connections.find((entry) => entry.id === targetId) : undefined;
	if (!target) return { chat: settings.chat };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	const facts: SetupTargetFacts = {
		id: target.id,
		runtime: target.runtime,
		...(target.url !== undefined ? { url: target.url } : {}),
		...(target.defaultModel !== undefined ? { defaultModel: target.defaultModel } : {}),
		drivesChat: runtime?.kind === "http",
	};
	if (runtime?.kind !== "http") return { chat: settings.chat, target: facts };
	const auth = bootAuthStatus(target, runtime);
	const envVariable = target.auth?.apiKeyEnvVar?.trim();
	if (auth.required) {
		const projectKeyNamed = runtime.auth !== "oauth" && projectTargetKeyVariable(target) !== null;
		const projectUrl = projectKeyNamed ? null : projectChosenTargetUrl(target, true);
		facts.credential = {
			available: auth.available,
			provider: auth.providerId,
			...(envVariable ? { envVariable } : {}),
			...(projectUrl !== null ? { projectUrl } : {}),
			...(auth.redeclared !== undefined ? { redeclared: auth.redeclared } : {}),
		};
	}
	return { chat: settings.chat, target: facts };
}

export function classifyDefaultTarget(settings: Readonly<PancodeSettings> = readSettings()): DefaultTargetVerdict {
	const facts = setupFactsFor(settings);
	const status = setupStatus(facts);
	if (status.stage === "choose") return { kind: "no-target" };
	if (status.stage === "ready") return { kind: "usable" };
	const first = status.missing[0];
	switch (first?.kind) {
		case "runtime":
			return { kind: "ineligible-runtime", targetId: first.target, runtime: first.runtime };
		case "model":
			return { kind: "no-model", targetId: first.target };
		default:
			return {
				kind: "missing-credential",
				targetId: status.route.target,
				store: facts.target?.credential?.provider ?? status.route.target,
			};
	}
}

/** The first thing the saved chat route lacks, for a verdict that is not usable and names a target. */
export function firstMissing(settings: Readonly<PancodeSettings>): Missing | null {
	const status = setupStatus(setupFactsFor(settings));
	return status.stage === "needs" ? (status.missing[0] ?? null) : null;
}

/** The key or sign-in a saved target still needs from this shell, or null when it has what it needs. */
export function credentialMissing(settings: Readonly<PancodeSettings>, targetId: string): Missing | null {
	const status = setupStatus(setupFactsFor({ ...settings, chat: { ...settings.chat, connection: targetId } }));
	if (status.stage !== "needs") return null;
	return status.missing.find((missing) => missing.kind === "credential" || missing.kind === "env") ?? null;
}

/** One sentence naming what is wrong, for the causes target selection can fix. */
export function describeVerdict(verdict: DefaultTargetVerdict): string {
	switch (verdict.kind) {
		case "no-target":
			return "No model connection is configured.";
		case "ineligible-runtime":
			return describeMissing({ kind: "runtime", target: verdict.targetId, runtime: verdict.runtime }).sentence;
		case "no-model":
			return describeMissing({ kind: "model", target: verdict.targetId }).sentence;
		default:
			return "No usable default connection is configured.";
	}
}

/**
 * The startup line for a saved chat route whose credential is missing.
 *
 * The route is the user's explicit choice, so startup keeps it and says what
 * is wrong with it. Discovery used to replace it for the session with the first
 * reachable target, which could be the endpoint dedicated to background memory.
 * Only names are printed: the target, its model, and where a credential is read.
 */
export function describeKeptChatRoute(
	settings: Readonly<PancodeSettings>,
	verdict: Extract<DefaultTargetVerdict, { kind: "missing-credential" }>,
): string {
	const target = settings.connections.find((entry) => entry.id === verdict.targetId);
	const model = settings.chat.model ?? target?.defaultModel;
	const missing = firstMissing(settings) ?? { kind: "credential", target: verdict.targetId, provider: verdict.store };
	return `Chat: ${verdict.targetId}${model ? ` / ${model}` : ""} is unavailable. ${describeMissing(missing).sentence} Your saved chat route is kept.`;
}
