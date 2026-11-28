// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionTestHost, ExtensionTestOptions, ExtensionTestServices } from "@pancode/sdk/testing";
import { createExtensionTestHost as createSdkTestHost } from "@pancode/sdk/testing";
import type { ToolName } from "../../../core/tool-names.js";
import { isBuiltinToolName } from "../../../core/tool-names.js";
import { loadManifestFromRoot } from "../discovery.js";
import { ExtensionRequestTimeout } from "../runtime-process-v2.js";
import { createRuntimeRegistration } from "../runtime-registration.mjs";

export type { ExtensionTestHost, ExtensionTestOptions, ExtensionTestServices } from "@pancode/sdk/testing";

/** The install's own manifest check, registration and timeout, so a test sees what the harness would. */
const hostServices: ExtensionTestServices = {
	loadManifest(root) {
		const candidate = loadManifestFromRoot(root);
		if (!candidate.valid) throw new Error(candidate.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
		const manifest = candidate.manifest;
		if (!manifest?.runtimeV2) throw new Error("extension test host requires runtime.api: 2");
		return { id: manifest.id, runtime: manifest.runtimeV2 };
	},
	register: createRuntimeRegistration,
	timeoutError: (kind) => new ExtensionRequestTimeout(kind),
	isBuiltinTool: (name) => isBuiltinToolName(name as ToolName),
};

export function createExtensionTestHost(
	root: string,
	options: ExtensionTestOptions = {},
	services: ExtensionTestServices = {},
): Promise<ExtensionTestHost> {
	return createSdkTestHost(root, options, { ...hostServices, ...services });
}
