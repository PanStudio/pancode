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
 * The project settings file that redeclared a target the user layer gives a credential, keyed by the project's entry.
 * Arrays replace on layer merge and project layers keep no stored-credential reference, so that entry reaches auth
 * with no credential at all; without this record it read as a target that needs none and got the local placeholder.
 */
const redeclaredUserTargets = new Map<string, string>();

function entryKey(id: string, url: string): string {
	return `${id}\u0000${url}`;
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

/** The way out of a redeclared target's refusal; `pancode configure` writes user settings, which the project still replaces. */
export const REDECLARED_TARGET_FIX = "Remove targets from that file, or give the target auth.apiKeyEnvVar there.";

/** Why a target a project redeclared gets none of the credential the user's own entry for it names. */
export function redeclaredTargetSentence(targetId: string, projectFile: string): string {
	return `Target ${targetId} is redeclared in ${projectFile}; stored credentials attach only to targets in your user settings. ${REDECLARED_TARGET_FIX}`;
}

/**
 * Record the targets list a project layer supplied. `replaced` names the project settings file that set it and the ids
 * the user layer declares with auth, whose entries this list replaced.
 */
export function noteProjectTargets(
	targets: ReadonlyArray<{ id: string; url?: string; auth?: { apiKeyEnvVar?: string } }>,
	replaced: { file: string; userCredentialIds: ReadonlySet<string> } = { file: "", userCredentialIds: new Set() },
): void {
	const { file, userCredentialIds } = replaced;
	for (const target of targets) {
		const url = target.url?.trim();
		const variable = target.auth?.apiKeyEnvVar?.trim();
		const keyName = variable !== undefined && isProjectKeyVariableName(variable) ? variable : undefined;
		if (userCredentialIds.has(target.id) && keyName === undefined)
			redeclaredUserTargets.set(entryKey(target.id, url ?? ""), file);
		else redeclaredUserTargets.delete(entryKey(target.id, url ?? ""));
		if (!url) continue;
		projectTargets.add(entryKey(target.id, url));
		if (keyName !== undefined) projectKeyVariables.set(entryKey(target.id, url), keyName);
		else projectKeyVariables.delete(entryKey(target.id, url));
	}
}

/**
 * The project settings file when this entry is a project's redeclaration of a target the user layer gives a credential,
 * else null. An entry that carries any auth reference of its own did not come from that redeclaration.
 */
export function redeclaredUserTargetFile(target: {
	id: string;
	url?: string;
	auth?: { apiKeyEnvVar?: string; apiKeyRef?: string; oauthProfile?: string };
}): string | null {
	if (target.auth?.apiKeyEnvVar?.trim() || target.auth?.apiKeyRef?.trim() || target.auth?.oauthProfile?.trim())
		return null;
	return redeclaredUserTargets.get(entryKey(target.id, target.url?.trim() ?? "")) ?? null;
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
