// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Read-only credential presence check for the pre-TUI target preflight. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	projectChosenTargetUrl,
	projectTargetKeyVariable,
	redeclaredTargetSentence,
	redeclaredUserTarget,
} from "../../../core/project-target-urls.js";
import { asRecord } from "../../../core/type-guards.js";
import { pancodeConfigDir } from "../../../core/xdg.js";
import { findEngineEnvKeys, getEngineEnvApiKey } from "../../../engine/env-api-keys.js";
import type { TargetDescriptor } from "../types/target-descriptor.js";
import type { RuntimeAuthMetadata } from "./storage.js";

function storedCredentialPresent(providerId: string): boolean {
	const path = join(pancodeConfigDir(), "credentials.yaml");
	if (!existsSync(path)) return false;
	try {
		const root = asRecord(parseYaml(readFileSync(path, "utf8")));
		const entry = asRecord(asRecord(root?.entries)?.[providerId]);
		if (!entry) return false;
		if (entry.type === "api_key") return typeof entry.key === "string" && entry.key.trim().length > 0;
		if (entry.type === "oauth") {
			return typeof entry.access === "string" && typeof entry.refresh === "string" && typeof entry.expires === "number";
		}
		// Version 1 (and the historical version-less form).
		return typeof entry.key === "string" && entry.key.trim().length > 0;
	} catch {
		return false;
	}
}

function environmentCredentialPresent(providerId: string, explicitEnvVar?: string): boolean {
	if (explicitEnvVar && process.env[explicitEnvVar]?.trim()) return true;
	for (const name of findEngineEnvKeys(providerId) ?? []) {
		if (process.env[name]?.trim()) return true;
	}
	return Boolean(getEngineEnvApiKey(providerId)?.trim());
}

export interface BootAuthStatus {
	providerId: string;
	required: boolean;
	available: boolean;
	/** Why a project's redeclaration of this credentialed user target withholds every credential, naming its file. */
	redeclared?: string;
}

export function bootAuthStatus(target: TargetDescriptor, runtime: RuntimeAuthMetadata): BootAuthStatus {
	const required =
		runtime.auth === "oauth" ||
		(runtime.auth === "api-key" &&
			(Boolean(target.auth?.apiKeyEnvVar || target.auth?.apiKeyRef || target.auth?.oauthProfile) ||
				runtime.tier === "cloud" ||
				Boolean(runtime.credentialsEnvVar)));
	const providerId =
		target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || runtime.oauthProviderId || runtime.id;
	const redeclared = redeclaredUserTarget(target, runtime.auth);
	if (redeclared !== null)
		return {
			providerId,
			required: true,
			available: false,
			redeclared: redeclaredTargetSentence(target.id, redeclared.file, redeclared.signIn),
		};
	if (!required) return { providerId, required: false, available: true };
	const projectKey = runtime.auth === "oauth" ? null : projectTargetKeyVariable(target);
	if (projectChosenTargetUrl(target, true)) {
		// A trusted project's URL gets the variable it named on the trust card, and nothing else.
		return { providerId, required: true, available: projectKey !== null && Boolean(process.env[projectKey]?.trim()) };
	}
	const explicitEnvVar = (runtime.auth === "oauth" ? undefined : target.auth?.apiKeyEnvVar) ?? runtime.credentialsEnvVar;
	return {
		providerId,
		required: true,
		available: storedCredentialPresent(providerId) || environmentCredentialPresent(providerId, explicitEnvVar),
	};
}
