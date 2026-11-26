// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { resolvePancodeDirs } from "../../core/xdg.js";

/**
 * The operator's components directory, set by `campaign run` for each entry. A component is an installation
 * artifact, not session data, so an entry whose own data root is empty and thrown away resolves the operator's
 * installed components from here, read-only: nothing installs into it.
 */
export const OPERATOR_COMPONENTS_ENV = "PANCODE_OPERATOR_COMPONENTS_DIR";

function borrowedComponentsDir(): string | null {
	const dir = process.env[OPERATOR_COMPONENTS_ENV];
	return dir && isAbsolute(dir) ? dir : null;
}

/** True when this process runs on the operator's behalf and reads their components instead of installing its own. */
export function usesOperatorComponents(): boolean {
	return borrowedComponentsDir() !== null;
}

/** The components directory the operator's `pancode tools install` fills. */
export function operatorComponentsDir(): string {
	return borrowedComponentsDir() ?? join(resolvePancodeDirs().data, "components");
}

/** Where this process's own `tools install` puts a component version. */
export function componentInstallDir(id: string, version: string): string {
	return join(resolvePancodeDirs().data, "components", id, version);
}

/** Where the operator installs a component version, the path an install hint names. */
export function operatorComponentDir(id: string, version: string): string {
	return join(operatorComponentsDir(), id, version);
}

/** Every prefix a component version may already be installed in: this process's own, then the operator's. */
export function componentSearchDirs(id: string, version: string): string[] {
	const own = componentInstallDir(id, version);
	const operator = operatorComponentDir(id, version);
	return operator === own ? [own] : [own, operator];
}

/**
 * The environment a component's npm install runs in: `node`'s directory first on PATH, and npm's cache and logs
 * under PanCode's cache root instead of the operator's ~/.npm. The operator's npm configuration is still read,
 * because it names the registry, proxy and certificates this machine installs through.
 */
export function componentNpmEnv(node: string): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
		npm_config_cache: join(resolvePancodeDirs().cache, "component-npm"),
		npm_config_update_notifier: "false",
		npm_config_fund: "false",
		npm_config_audit: "false",
	};
}

/** The separately installed runtime components `pancode tools install` provides. */
export type RuntimeComponentId = "copilot-sdk" | "claude-sdk";

/** CopilotSdkUnavailableError and ClaudeAgentSdkUnavailableError wording, which names the install command. */
const MISSING_COMPONENT =
	/\bthe (?:copilot-sdk|claude sdk) runtime needs \S+\. run: pancode tools install (copilot-sdk|claude-sdk)\b/iu;

/**
 * The component a failure text says is not installed, or null. A surface that may not copy provider prose
 * (ACP) still names the cause and the install command from this host-authored id.
 */
export function missingRuntimeComponent(text: string | null | undefined): RuntimeComponentId | null {
	const match = typeof text === "string" ? MISSING_COMPONENT.exec(text) : null;
	return match === null ? null : (match[1]?.toLowerCase() as RuntimeComponentId);
}
