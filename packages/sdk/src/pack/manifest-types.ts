// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionRuntimeDeclarationV2 } from "./manifest-v2.js";

export interface ExtensionCommandTool {
	name: string;
	description: string;
	runtime: "node" | "python3";
	entrypoint: string;
	inputSchema: Record<string, unknown>;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface ExtensionCapabilities {
	tools: ExtensionCommandTool[];
}

/**
 * The harness extension contract. An extension contributes executable runtime
 * capability to PanCode: command tools declared here and hook declarations
 * captured from `hooks.yaml` at the package root. Prompts, skills, agents,
 * playbooks, and reference files are plugin content and have no manifest key.
 */
export interface PancodeExtensionManifest {
	/** The manifest's `runtime` block, which must declare `api: 2`. */
	runtimeV2?: ExtensionRuntimeDeclarationV2;
	id: string;
	name: string;
	version: string;
	description: string;
	/** Absent for a package whose only capability is its `hooks.yaml`. */
	capabilities?: ExtensionCapabilities;
	compatibility?: { pancode?: string };
	/**
	 * The one plugin this extension serves. Plugin and extension stay separate
	 * packages; the link only lets a `replaces: prompt` command take over that
	 * plugin's prompt of the same name while the plugin is in effect.
	 */
	plugin?: string;
	/** SPDX licence expression, at most 128 characters. */
	license?: string;
}

export interface ExtensionDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}
