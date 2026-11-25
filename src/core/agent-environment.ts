// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Generic child-process attribution used by agent-aware developer tools. */
export const AI_AGENT_NAME = "pancode";

/** Add PanCode's attribution without admitting any other environment variables. */
export function withPancodeAgentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...source, AI_AGENT: AI_AGENT_NAME };
}

let inherited: { value: string | undefined } | undefined;

/**
 * Marks this process as PanCode for every child it spawns. The value it
 * inherited is kept first, because PanCode marks itself unconditionally and the
 * marker would otherwise say the model ran every command.
 */
export function markPancodeAgentProcess(env: NodeJS.ProcessEnv = process.env): void {
	inherited ??= { value: env.AI_AGENT };
	env.AI_AGENT = AI_AGENT_NAME;
}

/** True when the environment this process started in already named PanCode, which means a PanCode session ran the command. */
export function startedUnderPancodeAgent(env: NodeJS.ProcessEnv = process.env): boolean {
	return (inherited ? inherited.value : env.AI_AGENT) === AI_AGENT_NAME;
}
