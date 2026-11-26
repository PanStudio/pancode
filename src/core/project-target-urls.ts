// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Targets a project settings layer pointed at a URL. Such a target never
 * receives the operator's stored or environment credential (review
 * R1-safety-secrets-05): trusting a repository for its rules is not consent to
 * send provider keys wherever its settings say. A loopback URL is no
 * exception for a target that sends a credential, since another user on a
 * shared host can own the port (R2-safety-secrets-17). The layered settings
 * reader records them; auth resolution reads them. Entries accumulate per
 * process, so a host reading several workspaces never forgets one it has seen.
 */
const projectTargets = new Set<string>();
/** The key variable a trusted project named for one of its own target URLs (`auth.apiKeyEnvVar`). */
const projectKeyVariables = new Map<string, string>();
/**
 * Where a project's targets list came from, carried on each entry of the effective settings snapshot that list
 * supplied. A symbol key survives the spreads that copy a target and stays out of JSON, validation and saved files.
 */
const PROJECT_TARGET_ORIGIN = Symbol("pancode.projectTargetOrigin");

/** The project settings file whose `targets` list supplied an entry, and what the user's own entry for that id named. */
export interface ProjectTargetOrigin {
	file: string;
	/** "stored": the user's entry names `auth.apiKeyRef` or `auth.oauthProfile`; "key-variable": only `auth.apiKeyEnvVar`. */
	userCredential?: "stored" | "key-variable";
}

/**
 * Redeclarations of credentialed user targets seen by this process, for a copy of a target that lost its origin
 * (`structuredClone` drops symbol keys). It only ever refuses: an entry lost from the snapshot must not read as one
 * that needs no credential and get the local placeholder. Keyed by id, URL and the project's key variable.
 */
const redeclaredEntries = new Set<string>();

function entryKey(id: string, url: string): string {
	return `${id}\u0000${url}`;
}

function redeclaredKey(
	target: { id: string; url?: string; auth?: { apiKeyEnvVar?: string } },
	userCredential: "stored" | "key-variable",
): string {
	return `${entryKey(target.id, target.url?.trim() ?? "")}\u0000${target.auth?.apiKeyEnvVar?.trim() ?? ""}\u0000${userCredential}`;
}

/** A name a project may give for its target's key: an environment variable name, never a value. */
export function isProjectKeyVariableName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name);
}

/**
 * The one sentence every surface prints for a target whose key variable is unset: run, the TUI and doctor. With
 * `projectFile`, the project settings file that declares the target, it also names the two fixes: the shell, or
 * that file's `auth.apiKeyEnvVar`, since `pancode configure` edits only the user's settings.
 */
export function unsetKeyVariableSentence(targetId: string, variable: string, projectFile?: string): string {
	const unset = `target ${targetId} reads its key from $${variable}, which is not set in this shell`;
	return projectFile === undefined
		? `${unset}.`
		: `${unset}; set it with \`export ${variable}=<key>\`, or fix auth.apiKeyEnvVar on target ${targetId} in ${projectFile}.`;
}

export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		host === "0.0.0.0" ||
		/^127(\.\d{1,3}){3}$/u.test(host)
	);
}

/** How every redeclared-target refusal's fix begins; doctor keys on it to drop its generic `pancode configure` hint. */
export const REDECLARED_TARGET_FIX_LEAD = "Remove targets from that file";

/**
 * Why a target a project redeclared gets none of the credential the user's own entry for it names. `projectFile` is
 * null when the entry reached auth without its origin. An OAuth runtime ignores a key variable and a project cannot
 * name a stored sign-in, so its only fix is the file's targets list.
 */
export function redeclaredTargetSentence(targetId: string, projectFile: string | null, signIn = false): string {
	const where = projectFile ?? "a project settings file";
	return signIn
		? `Target ${targetId} is redeclared in ${where}; the stored credential your user settings name for it attaches only to the target there. ${REDECLARED_TARGET_FIX_LEAD}; a project cannot name a stored sign-in.`
		: `Target ${targetId} is redeclared in ${where}; stored credentials attach only to targets in your user settings. ${REDECLARED_TARGET_FIX_LEAD}, or give the target auth.apiKeyEnvVar there.`;
}

/** Record the targets list a project layer supplied, for the URL rules below. */
export function noteProjectTargets(
	targets: ReadonlyArray<{ id: string; url?: string; auth?: { apiKeyEnvVar?: string } }>,
): void {
	for (const target of targets) {
		const url = target.url?.trim();
		if (!url) continue;
		projectTargets.add(entryKey(target.id, url));
		const variable = target.auth?.apiKeyEnvVar?.trim();
		if (variable !== undefined && isProjectKeyVariableName(variable))
			projectKeyVariables.set(entryKey(target.id, url), variable);
		else projectKeyVariables.delete(entryKey(target.id, url));
	}
}

/** Mark an entry of the effective snapshot as supplied by a project's targets list. */
export function markProjectTarget(
	target: { id: string; url?: string; auth?: { apiKeyEnvVar?: string } },
	origin: ProjectTargetOrigin,
): void {
	(target as Record<symbol, unknown>)[PROJECT_TARGET_ORIGIN] = origin;
	if (origin.userCredential !== undefined) redeclaredEntries.add(redeclaredKey(target, origin.userCredential));
}

/** The origin `markProjectTarget` gave this entry, else null. */
export function projectTargetOrigin(target: object): ProjectTargetOrigin | null {
	return ((target as Record<symbol, unknown>)[PROJECT_TARGET_ORIGIN] as ProjectTargetOrigin | undefined) ?? null;
}

/** Copy the project origins of `from`'s targets onto a structured clone of them, matched by position and id. */
export function keepProjectTargetOrigins(from: ReadonlyArray<{ id: string }>, to: ReadonlyArray<{ id: string }>): void {
	for (const [index, target] of to.entries()) {
		const source = from[index];
		const origin = source?.id === target.id ? projectTargetOrigin(source) : null;
		if (origin !== null) (target as Record<symbol, unknown>)[PROJECT_TARGET_ORIGIN] = origin;
	}
}

/**
 * When this entry is a project's redeclaration of a target whose user entry names a credential this runtime would
 * read, the refusal: the project file (null when the entry lost its origin) and whether the runtime signs in (OAuth).
 * Else null. An API-key runtime accepts the project's own key variable instead; an OAuth runtime reads none.
 */
export function redeclaredUserTarget(
	target: { id: string; url?: string; auth?: { apiKeyEnvVar?: string; apiKeyRef?: string; oauthProfile?: string } },
	runtimeAuth: string,
): { file: string | null; signIn: boolean } | null {
	// A project layer keeps no stored-credential reference, so an entry naming one is the user's own.
	if (target.auth?.apiKeyRef?.trim() || target.auth?.oauthProfile?.trim()) return null;
	const signIn = runtimeAuth === "oauth";
	if (!signIn && runtimeAuth !== "api-key") return null;
	const variable = target.auth?.apiKeyEnvVar?.trim();
	if (!signIn && variable !== undefined && isProjectKeyVariableName(variable)) return null;
	const refuses = (credential: "stored" | "key-variable" | undefined) =>
		credential === "stored" || (credential === "key-variable" && !signIn);
	const origin = projectTargetOrigin(target);
	if (origin !== null) return refuses(origin.userCredential) ? { file: origin.file, signIn } : null;
	const seen = (["stored", "key-variable"] as const).some(
		(credential) => refuses(credential) && redeclaredEntries.has(redeclaredKey(target, credential)),
	);
	return seen ? { file: null, signIn } : null;
}

/**
 * The variable a trusted project named for this target's URL, when the target still names it: the one credential
 * PanCode sends to an address a project chose, because the trust card said "sends $NAME to <url>". Else null.
 */
export function projectTargetKeyVariable(target: {
	id: string;
	url?: string;
	auth?: { apiKeyEnvVar?: string };
}): string | null {
	const url = target.url?.trim();
	if (!url) return null;
	const variable = projectKeyVariables.get(entryKey(target.id, url));
	return variable !== undefined && target.auth?.apiKeyEnvVar?.trim() === variable ? variable : null;
}

/**
 * The URL when this target came from a project layer and the operator's
 * credential must not follow it, else null. Only a loopback URL for a target
 * that sends no credential is exempt.
 */
export function projectChosenTargetUrl(target: { id: string; url?: string }, sendsCredential: boolean): string | null {
	const url = target.url?.trim();
	if (!url || !projectTargets.has(entryKey(target.id, url))) return null;
	return sendsCredential || !isLoopbackUrl(url) ? url : null;
}
