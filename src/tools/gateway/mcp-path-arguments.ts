// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { McpPathArgumentAccess, McpTrustActionClass } from "../../domains/mcp/index.js";
import { resolveToCwd } from "../path-utils.js";
import type { HostEffectCall, ToolInvokeOptions } from "../registry-contract.js";
import { isStoreReference } from "./mcp-store-references.js";

/** One declared path argument a call names, with each spelling of the path the server could reach. */
interface NamedPathArgument {
	argument: string;
	access: McpPathArgumentAccess;
	paths: string[];
}

/**
 * The declared path arguments a call names, resolved against the server's
 * launch cwd the way a builtin tool resolves its `path`, or why the call is
 * refused. An argument the call leaves out names nothing; one the declaration
 * does not name is never read. This judges the paths a call names; it does not
 * confine what a server process running outside a sandbox then reads or writes.
 */
export function namedPathArguments(
	declared: Readonly<Record<string, McpPathArgumentAccess>>,
	args: Readonly<Record<string, unknown>>,
	cwd: string,
): NamedPathArgument[] | string {
	const named: NamedPathArgument[] = [];
	for (const [argument, access] of Object.entries(declared)) {
		if (!Object.hasOwn(args, argument) || args[argument] === undefined) continue;
		const value = args[argument];
		// A store reference names a blob, not a file; mcp-store-references judges it.
		if (isStoreReference(value)) continue;
		if (typeof value !== "string") return `argument '${argument}' is a declared ${access} path and must be a string`;
		// A server does not expand `~`, so its literal spelling is judged beside the expanded one.
		named.push({ argument, access, paths: [...new Set([resolveToCwd(value, cwd), path.resolve(cwd, value)])] });
	}
	return named;
}

/** Each named path as the direct read or write call it stands for, so admission judges it as that call. */
export function pathArgumentEffects(named: ReadonlyArray<NamedPathArgument>): HostEffectCall[] {
	return named.flatMap((entry) =>
		entry.paths.map((target) => ({
			label: `${entry.access} path argument '${entry.argument}' (${target})`,
			call: { tool: entry.access === "read" ? ToolNames.Read : ToolNames.Write, args: { path: target } },
		})),
	);
}

/**
 * Why a call's declared path arguments refuse it right before it reaches the
 * server, or null: the same read-scope filter and write-root check a builtin
 * read or write repeats in its body.
 */
export function pathArgumentRefusal(
	name: string,
	declared: Readonly<Record<string, McpPathArgumentAccess>>,
	trustClass: McpTrustActionClass,
	args: Readonly<Record<string, unknown>>,
	cwd: string,
	invokeOptions: ToolInvokeOptions | undefined,
): string | null {
	const written = Object.keys(declared).find((argument) => declared[argument] === "write");
	if (trustClass === "read" && written !== undefined) {
		return `${name}: write path argument '${written}' is declared on a tool classed read; a read tool writes nothing, so fix the declaration's toolPathArguments or the tool's class`;
	}
	const named = namedPathArguments(declared, args, cwd);
	if (typeof named === "string") return `${name}: ${named}`;
	for (const entry of named) {
		for (const target of entry.paths) {
			if (entry.access === "read" && invokeOptions?.allowsObservationPath?.(target) === false) {
				return `${name}: read path argument '${entry.argument}' names ${target}, which this run may not read`;
			}
			const violation = entry.access === "write" ? invokeOptions?.writeTargetViolation?.(target) : null;
			if (violation) return `${name}: write path argument '${entry.argument}' names ${target}: ${violation}`;
		}
	}
	return null;
}
