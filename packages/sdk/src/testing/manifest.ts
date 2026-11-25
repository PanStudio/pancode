// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ManifestKeyPolicy, parseIgnorable } from "../pack/ignorable.js";
import { parseExtensionRuntimeV2 } from "../pack/runtime-schema-v2.js";
import type { ExtensionTestManifest } from "./test-api.js";

const JSON_MANIFEST = "pancode-extension.json";
const YAML_MANIFESTS = ["pancode-extension.yaml", "pancode-extension.yml"];

/**
 * Reads a JSON manifest's identity and its api 2 runtime block with the
 * runtime's own validator. PanCode's full manifest check, YAML included, runs
 * in `pancode extensions validate` and in the install's kit.
 */
export function loadJsonManifest(root: string): ExtensionTestManifest {
	const file = path.join(root, JSON_MANIFEST);
	if (!existsSync(file)) {
		const yaml = YAML_MANIFESTS.find((name) => existsSync(path.join(root, name)));
		throw new Error(
			yaml
				? `${yaml} needs a manifest loader; run the test through pancode extensions test or pass services.loadManifest`
				: "extension manifest not found",
		);
	}
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("extension manifest must be an object");
	const manifest = value as Record<string, unknown>;
	for (const key of ["id", "version", "description"])
		if (typeof manifest[key] !== "string" || (manifest[key] as string).trim() === "")
			throw new Error(`${key} is required`);
	if ((manifest.runtime as { api?: unknown } | null | undefined)?.api !== 2)
		throw new Error("extension test host requires runtime.api: 2");
	const policy = new ManifestKeyPolicy(parseIgnorable(manifest.ignorable));
	return { id: (manifest.id as string).trim(), runtime: parseExtensionRuntimeV2(manifest.runtime, policy) };
}
