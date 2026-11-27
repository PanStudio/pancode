// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The variables a local MCP server may take from the environment PanCode runs
 * in, beyond the fixed tool allowlist: a plugin's `envVars`. An entry is a
 * variable name, or a prefix of at
 * least four characters followed by `*` for every variable starting with it,
 * so a server can read families such as `LMOD_*` that no fixed list names. A
 * name PanCode keeps for itself, one that changes how a program starts, or one
 * that reads as a credential is refused in a declaration and never passed.
 */
import { isSecretArgKey } from "../../safety/redaction.js";

const MAX_ENTRIES = 32;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX_MIN_CHARS = 4;
const RESERVED_PREFIX = "PANCODE_";
/** Variables that change how a program or its runtime starts, never passed to a server. */
const DENIED = ["NODE_OPTIONS", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_AUDIT"];

/** Why a variable name is never passed to a server, or null when it may be. */
function refusedVariable(name: string): string | null {
	const upper = name.toUpperCase();
	if (upper.startsWith(RESERVED_PREFIX)) return `${RESERVED_PREFIX} variables are PanCode's own`;
	if (DENIED.includes(upper)) return "it changes how a program starts";
	if (isSecretArgKey(name)) return "it reads as a credential";
	return null;
}

/**
 * The problem with one entry, or null. A prefix is refused when a name it
 * would pass is: one that `PANCODE_` or a denied name starts with.
 */
function entryProblem(entry: unknown, location: string): string | null {
	if (typeof entry !== "string") return `${location} must be a string`;
	const prefix = entry.endsWith("*");
	const name = prefix ? entry.slice(0, -1) : entry;
	if (!NAME.test(name) || (prefix && name.length < PREFIX_MIN_CHARS)) {
		return `${location} must be a variable name, or a prefix of at least ${PREFIX_MIN_CHARS} characters followed by *`;
	}
	const refused = refusedVariable(name);
	if (refused !== null) return `${location} names ${entry}, which is never passed: ${refused}`;
	if (prefix) {
		const upper = name.toUpperCase();
		const covered = [RESERVED_PREFIX, ...DENIED].find((reserved) => reserved.startsWith(upper));
		if (covered !== undefined) return `${location} names ${entry}, which would pass ${covered}`;
	}
	return null;
}

/** The declared entries, sorted, or the problem with them. */
export function parsePassedVariables(value: unknown, location: string): string[] | string {
	if (!Array.isArray(value)) return `${location} must be an array`;
	if (value.length > MAX_ENTRIES) return `${location} lists more than ${MAX_ENTRIES} entries`;
	for (const [index, entry] of value.entries()) {
		const problem = entryProblem(entry, `${location}[${index}]`);
		if (problem !== null) return problem;
	}
	if (new Set(value).size !== value.length) return `${location} lists an entry twice`;
	return [...(value as string[])].sort();
}

/**
 * The values a server is launched with: each declared name set in `source`,
 * and each variable a declared prefix matches. A matched name that could not
 * be declared (a credential, `PANCODE_*`) is not passed. These go to
 * `buildSafeToolEnv` as extras, so its controls still apply last.
 */
export function mcpPassedEnvironment(
	entries: ReadonlyArray<string>,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of entries) {
		if (!entry.endsWith("*")) {
			const value = source[entry];
			if (value !== undefined && refusedVariable(entry) === null) env[entry] = value;
			continue;
		}
		const prefix = entry.slice(0, -1);
		for (const [name, value] of Object.entries(source)) {
			if (value !== undefined && name.startsWith(prefix) && refusedVariable(name) === null) env[name] = value;
		}
	}
	return env;
}
