// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * V8 compile cache for the dynamically imported command graphs: about 227 ms of compile per cold interactive boot,
 * about 70 ms cached. Enabling is optional and never fails a command. Operator controls win: NODE_DISABLE_COMPILE_CACHE
 * turns it off and NODE_COMPILE_CACHE names the directory. Native workers get the cache only through an injected
 * NODE_COMPILE_CACHE, which the worker entry deletes from its own env so no descendant writes into PanCode's cache.
 */

import { existsSync } from "node:fs";
import { enableCompileCache, flushCompileCache } from "node:module";
import { join } from "node:path";
import { resolvePancodeDirs } from "./xdg.js";

/** Its value is the injected directory, which tells PanCode's injection from an operator NODE_COMPILE_CACHE. */
export const INJECTED_COMPILE_CACHE_ENV = "PANCODE_INJECTED_COMPILE_CACHE";

let settled: string | null | undefined;

/**
 * Enable the cache for this process. Only modules loaded after the call are cached, so the CLI calls it before its
 * per-command dynamic import. The first call settles the directory or null for the process: a run that started disabled
 * or failed must not enable itself on a retry with a different environment.
 */
export function enablePancodeCompileCache(): string | null {
	if (settled !== undefined) return settled;
	const env = process.env;
	// Settling null also keeps the cache out of dispatched workers, since the spawn path injects only what this returns.
	if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
		settled = null;
		return settled;
	}
	try {
		if (env.NODE_COMPILE_CACHE !== undefined) {
			// Presence, even as an empty string, is the operator speaking; with no argument Node reads it itself.
			settled = enableCompileCache().directory ?? null;
			return settled;
		}
		// Enabling creates the directory, and `paths` and bare `doctor` must write nothing to a home PanCode never set
		// up. An existing cache root proves the install was set up.
		const root = resolvePancodeDirs().cache;
		if (!existsSync(root)) {
			settled = null;
			return settled;
		}
		settled = enableCompileCache(join(root, "v8-compile-cache")).directory ?? null;
	} catch {
		settled = null;
	}
	return settled;
}

/**
 * The environment a native worker spawn hands its child. A preexisting marker never survives: a stale or spoofed one
 * equal to the operator's NODE_COMPILE_CACHE would make the worker-entry scrub delete that operator setting.
 */
export function workerCompileCacheEnvironment(env: NodeJS.ProcessEnv, directory: string | null): NodeJS.ProcessEnv {
	const operatorControlled = env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined;
	if (operatorControlled || directory === null) {
		if (env[INJECTED_COMPILE_CACHE_ENV] === undefined) return env;
		const cleaned = { ...env };
		Reflect.deleteProperty(cleaned, INJECTED_COMPILE_CACHE_ENV);
		return cleaned;
	}
	return { ...env, NODE_COMPILE_CACHE: directory, [INJECTED_COMPILE_CACHE_ENV]: directory };
}

/**
 * Consume a PanCode-injected pair from an env in place, after Node's bootstrap read it. NODE_COMPILE_CACHE is deleted
 * only while it still equals the marker, so a stale marker beside an operator value removes only itself.
 */
export function deleteInjectedCompileCacheFrom(env: NodeJS.ProcessEnv): void {
	const injected = env[INJECTED_COMPILE_CACHE_ENV];
	if (injected === undefined) return;
	if (env.NODE_COMPILE_CACHE === injected) {
		Reflect.deleteProperty(env, "NODE_COMPILE_CACHE");
	}
	Reflect.deleteProperty(env, INJECTED_COMPILE_CACHE_ENV);
}

/** Publish compiled modules while the parent is alive, before a worker needs them. */
export function publishPancodeCompileCache(): void {
	if (settled === undefined || settled === null) return;
	try {
		flushCompileCache();
	} catch {
		// Bytecode reuse is optional; never change dispatch or shutdown behavior.
	}
}
