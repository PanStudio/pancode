// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Lazy loader for the optional `@anthropic-ai/claude-agent-sdk` package.
 *
 * The SDK's platform package ships a 224MB proprietary binary, so it is provisioned
 * separately and is a development dependency for types only.
 * Nothing may import it at module scope: boot,
 * `doctor`, and every non-Claude runtime have to work on an install that never
 * fetched it. The values the runtime needs (`query`, `createSdkMcpServer`) are reached through the
 * dynamic import below, at the moment a `claude-sdk` run actually starts, and a
 * missing package surfaces as a typed error naming the package and the install
 * command instead of an ESM resolution stack.
 */
import { pathToFileURL } from "node:url";
import type { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import {
	ClaudeAgentSdkUnavailableError,
	resolveClaudeAgentSdkEntry,
} from "../../domains/lifecycle/claude-sdk-install.js";

/** The slice of the SDK surface the worker runtime calls. */
interface ClaudeAgentSdkModule {
	query: typeof query;
	/** Carries PanCode's own tools to the worker (./pancode-tool-bridge.ts). */
	createSdkMcpServer?: typeof createSdkMcpServer;
}

/** The component location is resolved before import; dependency/link/evaluation failures propagate. */
export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
	const entry = resolveClaudeAgentSdkEntry();
	if (!entry) throw new ClaudeAgentSdkUnavailableError();
	const sdk: ClaudeAgentSdkModule = await import(pathToFileURL(entry).href);
	if (typeof sdk.query !== "function") throw new Error(`Claude SDK at ${entry} does not export query.`);
	return sdk;
}
