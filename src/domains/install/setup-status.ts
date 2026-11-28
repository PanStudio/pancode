// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { unsetKeyVariableSentence } from "../../core/project-target-urls.js";

/**
 * One answer to "can this home chat, and if not, what is the one missing thing?".
 *
 * Every surface that tells a user what to do next (first launch, `run`, `doctor`, the terminal's model
 * banner, a failed prompt and the desktop app's setup screen) reads this value and prints the fix through
 * `describeMissing`, so one condition has one sentence everywhere. Pure: callers gather the facts (settings,
 * credential presence, environment names, probe results) and pass them in, so it does no I/O and runs in
 * the desktop app's worker too.
 */

/** The chat route a home has chosen: the settings name a chat target. */
export interface RouteFact {
	target: string;
	runtime: string;
	model?: string;
	url?: string;
}

export type Missing =
	/**
	 * No stored key or sign-in for the provider the target authenticates as. With `projectUrl` the target points at
	 * an address a project chose, which never receives the operator's keys, so only defining it in user settings helps.
	 * No key variable is suggested for it: the project picked the address, so naming the variable its settings or the
	 * runtime read would steer the operator's real key there. `redeclared` is the refusal for a project's redeclaration
	 * of a target the user settings give a credential, naming that project file. With `sendsNone` the target declares
	 * no credential, so its endpoint got PanCode's local placeholder key and refused it; `projectFile` is the project
	 * settings file that declares the target, which user settings cannot change.
	 */
	| {
			kind: "credential";
			target: string;
			provider: string;
			projectUrl?: string;
			redeclared?: string;
			sendsNone?: true;
			projectFile?: string;
			keyless?: true;
	  }
	/**
	 * The target names the environment variable its key comes from, and it is not set. `projectFile` is the project
	 * settings file that declares the target, when a caller that read the layers knows it.
	 */
	| { kind: "env"; target: string; variable: string; projectFile?: string }
	| { kind: "unreachable"; target: string; url: string; detail: string }
	/** With `model` the endpoint does not offer it; without one the target has no chat model at all. */
	| { kind: "model"; target: string; model?: string }
	/** The target's runtime cannot drive a chat session. */
	| { kind: "runtime"; target: string; runtime: string }
	| { kind: "untested"; target: string };

/** A route PanCode found that the user has not chosen yet. `target` is the draft entry choosing it would save. */
export interface Candidate<TargetDraft = unknown> {
	source: "env-key" | "stored-login" | "configured-target" | "local-server" | "project";
	label: string;
	target: TargetDraft;
	model?: string;
	/** Who runs the listener behind a local-server candidate, when it can be read. */
	owner?: string;
}

export type SetupStatus<TargetDraft = unknown> =
	| { stage: "ready"; route: RouteFact }
	| { stage: "needs"; route: RouteFact; missing: Missing[] }
	| { stage: "choose"; candidates: Candidate<TargetDraft>[] };

/** What the caller knows about the chat target, gathered without sending a prompt. */
export interface SetupTargetFacts {
	id: string;
	runtime: string;
	url?: string;
	defaultModel?: string;
	/** False when the runtime is unknown or cannot drive the main agent. */
	drivesChat: boolean;
	/** Absent when the target needs no credential. */
	credential?: {
		available: boolean;
		provider: string;
		envVariable?: string;
		projectUrl?: string;
		redeclared?: string;
	};
	/** The last reachability check, when one ran. */
	probe?: { ok: true } | { ok: false; detail: string };
	/** False when a check showed the endpoint does not offer the chat model. */
	modelOffered?: boolean;
	/** False when the route is known to have never answered a request. Absent means unknown, which is not a gap. */
	answered?: boolean;
}

export interface SetupFacts<TargetDraft = unknown> {
	chat: { target?: string | null; model?: string | null };
	/** Facts for the target `chat.target` names; absent when it names none. */
	target?: SetupTargetFacts;
	candidates?: ReadonlyArray<Candidate<TargetDraft>>;
}

/**
 * A route is chosen when the settings name a chat target (S-42's rule); the home's existence means nothing.
 * Missing items come in the order a user has to fix them: a route that cannot drive chat, then the model,
 * the credential, the address and finally the first answer.
 */
export function setupStatus<TargetDraft = unknown>(facts: SetupFacts<TargetDraft>): SetupStatus<TargetDraft> {
	const chosen = facts.chat.target?.trim();
	const target = facts.target;
	if (!chosen || target === undefined || target.id !== chosen) {
		return { stage: "choose", candidates: [...(facts.candidates ?? [])] };
	}
	const model = facts.chat.model?.trim() || target.defaultModel?.trim() || undefined;
	const route: RouteFact = {
		target: target.id,
		runtime: target.runtime,
		...(model !== undefined ? { model } : {}),
		...(target.url !== undefined ? { url: target.url } : {}),
	};
	const missing: Missing[] = [];
	if (!target.drivesChat) {
		missing.push({ kind: "runtime", target: target.id, runtime: target.runtime });
	} else {
		if (model === undefined) missing.push({ kind: "model", target: target.id });
		const credential = target.credential;
		if (credential !== undefined && !credential.available) {
			missing.push(
				credential.redeclared !== undefined
					? {
							kind: "credential",
							target: target.id,
							provider: credential.provider,
							redeclared: credential.redeclared,
						}
					: credential.projectUrl !== undefined
						? {
								kind: "credential",
								target: target.id,
								provider: credential.provider,
								projectUrl: credential.projectUrl,
							}
						: credential.envVariable !== undefined
							? { kind: "env", target: target.id, variable: credential.envVariable }
							: { kind: "credential", target: target.id, provider: credential.provider },
			);
		}
		if (target.probe !== undefined && !target.probe.ok && target.url !== undefined) {
			missing.push({ kind: "unreachable", target: target.id, url: target.url, detail: target.probe.detail });
		}
		if (target.modelOffered === false && model !== undefined) {
			missing.push({ kind: "model", target: target.id, model });
		}
		if (missing.length === 0 && target.answered === false) missing.push({ kind: "untested", target: target.id });
	}
	return missing.length > 0 ? { stage: "needs", route, missing } : { stage: "ready", route };
}

/**
 * The one sentence every surface prints for a missing item, and the command in it when there is one.
 * The sentences name the thing to fix and the way to fix it; no surface rewords them.
 */
export function describeMissing(
	missing: Missing,
	/**
	 * Inside the TUI: a missing sign-in also names /config, where Enter on the connection signs in, and an endpoint
	 * that did not answer is re-addressed there; a shell caller gets the `pancode configure` command instead.
	 */
	options: { inSession?: boolean } = {},
): { sentence: string; command?: string } {
	switch (missing.kind) {
		case "credential": {
			if (missing.sendsNone === true) {
				const cause = `${missing.target} declares no credential, so PanCode sent none, and its endpoint asks for one.`;
				if (missing.keyless === true)
					return {
						sentence: `${missing.target}'s runtime sends no credential, and its endpoint asks for one. ${
							options.inSession
								? "Switch to a route that sends one with /model."
								: "Run: pancode configure to choose a target that sends one"
						}`,
						...(options.inSession ? {} : { command: "pancode configure" }),
					};
				// The project's list replaces the user's, so configure cannot reach this entry.
				if (missing.projectFile !== undefined)
					return { sentence: `${cause} Give ${missing.target} auth.apiKeyEnvVar in ${missing.projectFile}.` };
				const command = `pancode configure --id ${missing.target}`;
				return { sentence: `${cause} Run: ${command}`, command };
			}
			if (missing.redeclared !== undefined) return { sentence: missing.redeclared };
			if (missing.projectUrl !== undefined)
				return {
					sentence: `${missing.target} points at ${missing.projectUrl}, an address this project chose, so PanCode sends it none of your keys. To use it, define ${missing.target} in your user settings with its own key variable (auth.apiKeyEnvVar).`,
				};
			const command = `pancode auth login ${missing.provider}`;
			const sentence = `${missing.provider} has no key or sign-in stored. Run: ${command}`;
			return { sentence: options.inSession ? `${sentence} (or press Enter on /config)` : sentence, command };
		}
		case "env":
			return { sentence: unsetKeyVariableSentence(missing.target, missing.variable, missing.projectFile) };
		case "unreachable": {
			const unanswered = `${missing.target} at ${missing.url} did not answer (${missing.detail}). Start the server, or change the address`;
			if (options.inSession) return { sentence: `${unanswered} with /config.` };
			const command = "pancode configure";
			return { sentence: `${unanswered}. Run: ${command}`, command };
		}
		case "model": {
			if (missing.model !== undefined)
				return { sentence: `${missing.model} is not available on ${missing.target}. Pick another with /model.` };
			const command = `pancode targets use ${missing.target} --model <model>`;
			return { sentence: `Target '${missing.target}' has no chat model. Run: ${command}`, command };
		}
		case "runtime":
			return { sentence: `Target '${missing.target}' runs on '${missing.runtime}', which cannot drive the main agent.` };
		case "untested":
			return { sentence: `${missing.target} has not answered a request yet.` };
	}
}

/**
 * The first missing item for a target the providers domain has already checked, for the terminal's model banner.
 * Reads only the status fields: `reason` is the domain's `missing auth (ENV or store:PROVIDER)` text.
 */
export function missingFromTargetStatus(status: {
	target: { id: string; url?: string; auth?: { apiKeyEnvVar?: string } };
	available: boolean;
	reason: string;
	health: { status: string; lastError: string | null };
}): Missing | null {
	const target = status.target;
	if (!status.available) {
		const provider = /^missing auth \((?:\S+ or )?store:([^)\s]+)\)$/u.exec(status.reason.trim())?.[1];
		if (provider === undefined) return null;
		const variable = target.auth?.apiKeyEnvVar?.trim();
		return variable ? { kind: "env", target: target.id, variable } : { kind: "credential", target: target.id, provider };
	}
	if (status.health.status === "down" && target.url !== undefined) {
		return { kind: "unreachable", target: target.id, url: target.url, detail: status.health.lastError ?? "no reply" };
	}
	return null;
}

/**
 * A request that never reached the endpoint, or reached it with no credential, from the route record a failed call
 * carries. A connection that dropped after the reply began is not an unreachable endpoint and gives null.
 */
export function missingFromFailedCall(route: {
	targetId: string;
	url?: string;
	stage?: string;
	errorClass?: string;
	partialReply?: boolean;
	noCredential?: boolean;
	projectFile?: string;
	keyless?: boolean;
}): Missing | null {
	if (route.stage === "auth" && route.noCredential === true && /^http_\d{3}$/u.test(route.errorClass ?? ""))
		return {
			kind: "credential",
			target: route.targetId,
			provider: route.targetId,
			sendsNone: true,
			...(route.keyless === true
				? { keyless: true }
				: route.projectFile !== undefined
					? { projectFile: route.projectFile }
					: {}),
		};
	if (route.stage !== "transport" || route.url === undefined || route.partialReply === true) return null;
	if (route.errorClass !== "network_error" && route.errorClass !== "timeout") return null;
	const detail = route.errorClass === "timeout" ? "timed out" : "connection failed";
	return { kind: "unreachable", target: route.targetId, url: route.url, detail };
}
