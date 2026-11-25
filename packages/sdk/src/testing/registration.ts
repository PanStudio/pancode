// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionApiV2 } from "../extension/public-api-v2.js";
import type { ExtensionRuntimeDeclarationV2 } from "../pack/manifest-v2.js";

/** The handler tables a factory fills through the API it is given. */
export interface RuntimeRegistration {
	api: ExtensionApiV2;
	commands: Map<string, Parameters<ExtensionApiV2["handle"]>[1]>;
	observers: Map<string, Parameters<ExtensionApiV2["on"]>[1]>;
	hooks: Map<string, Parameters<ExtensionApiV2["hook"]>[1]>;
	tools: Map<string, Parameters<ExtensionApiV2["tool"]>[1]>;
	actions: Map<string, Parameters<ExtensionApiV2["action"]>[1]>;
	interviews: Map<string, Parameters<ExtensionApiV2["interview"]>[1]>;
	disposers: Array<Parameters<ExtensionApiV2["onDispose"]>[0]>;
	/** Closes registration and refuses a runtime that left a declared handler unregistered. */
	finish(): void;
}

const MAX_ACTIONS = 64;
const MAX_INTERVIEWS = 16;
const MAX_DISPOSERS = 8;
const FREE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The registration rules PanCode's runtime child applies, for a host that runs the factory in process. */
export function createRuntimeRegistration(declaration: ExtensionRuntimeDeclarationV2): RuntimeRegistration {
	const commands: RuntimeRegistration["commands"] = new Map();
	const observers: RuntimeRegistration["observers"] = new Map();
	const hooks: RuntimeRegistration["hooks"] = new Map();
	const tools: RuntimeRegistration["tools"] = new Map();
	const actions: RuntimeRegistration["actions"] = new Map();
	const interviews: RuntimeRegistration["interviews"] = new Map();
	const disposers: RuntimeRegistration["disposers"] = [];
	let registering = true;
	const declared = {
		commands: declaration.commands.map((command) => command.name),
		events: [...declaration.events, ...(declaration.tickMs !== undefined ? ["tick"] : [])] as string[],
		hooks: [...new Set(declaration.hooks.map((hook) => hook.on))] as string[],
		tools: declaration.tools.map((tool) => tool.name),
	};
	const register = <H>(map: Map<string, H>, name: unknown, handler: unknown, allowed: readonly string[]): void => {
		if (!registering || typeof name !== "string" || typeof handler !== "function" || map.has(name))
			throw new Error(`duplicate, late, or invalid registration: ${String(name)}`);
		if (!allowed.includes(name)) throw new Error(`undeclared registration: ${name}`);
		map.set(name, handler as H);
	};
	/** Action and interview ids are named by view data, not by the manifest, so only their form and count are bounded. */
	const registerFree = <H>(map: Map<string, H>, name: unknown, handler: unknown, limit: number): void => {
		if (!registering || typeof name !== "string" || typeof handler !== "function" || map.has(name))
			throw new Error(`duplicate, late, or invalid registration: ${String(name)}`);
		if (!FREE_NAME.test(name) || map.size >= limit) throw new Error(`registration refused: ${name}`);
		map.set(name, handler as H);
	};
	const sameNames = (map: Map<string, unknown>, expected: readonly string[]): boolean =>
		map.size === expected.length && expected.every((name) => map.has(name));

	const api: ExtensionApiV2 = Object.freeze({
		apiVersion: 2 as const,
		handle: (name, handler) => register(commands, name, handler, declared.commands),
		on: (event, handler) => register(observers, event, handler, declared.events),
		hook: (point, handler) => register(hooks, point, handler, declared.hooks),
		tool: (name, handler) => register(tools, name, handler, declared.tools),
		action: (id, handler) => registerFree(actions, id, handler, MAX_ACTIONS),
		interview: (id, handler) => registerFree(interviews, id, handler, MAX_INTERVIEWS),
		onDispose: (handler) => {
			if (!registering || typeof handler !== "function" || disposers.length >= MAX_DISPOSERS)
				throw new Error("invalid or late disposer registration");
			disposers.push(handler);
		},
	} satisfies ExtensionApiV2);
	return {
		api,
		commands,
		observers,
		hooks,
		tools,
		actions,
		interviews,
		disposers,
		finish() {
			registering = false;
			if (
				!sameNames(commands, declared.commands) ||
				!sameNames(observers, declared.events) ||
				!sameNames(hooks, declared.hooks) ||
				!sameNames(tools, declared.tools)
			)
				throw new Error("missing declared runtime handlers");
			// A leader key bound to an action nobody registered would press into nothing.
			for (const workspace of declaration.workspaces)
				for (const binding of workspace.keys ?? [])
					if (!actions.has(binding.action)) throw new Error(`workspace key names an unregistered action: ${binding.action}`);
		},
	};
}
