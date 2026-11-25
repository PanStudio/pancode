// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Tool definitions for an MCP tool server.
 *
 * `defineTool` describes one tool: its name, its JSON Schema input, the action
 * class a host may assume for it, which arguments name files, and the function
 * that runs it. `defineServer` groups tools under a server id, and
 * `policyManifest` derives a plain JSON description of the server that a host
 * can ship alongside it. `pancode/sdk/mcp-server` serves a defined server
 * over MCP stdio.
 *
 * What a server says about itself is a hint to any host. PanCode decides a
 * tool's class from the operator's approval or from policy it ships, never
 * from what a running server reports.
 *
 * Every definition is checked when it is made, and a bad one throws an Error
 * naming the field, so a broken server fails as it starts rather than when a
 * tool is first called.
 */

/**
 * The effect a tool may have. `read` observes, `execute` runs or changes
 * something that can be redone, `destructive` changes something that cannot be
 * undone. There is no `write` class: a tool that writes files is `execute` or
 * `destructive` and names its write paths in `pathArguments`.
 */
export type ToolActionClass = "read" | "execute" | "destructive";

/** How a tool uses the file path an argument names. */
export type ToolPathAccess = "read" | "write";

/** A JSON Schema; only the keywords the SDK reads are typed. */
export interface JsonSchema {
	readonly type?: string | ReadonlyArray<string>;
	readonly [keyword: string]: unknown;
}

/** A tool's input: a JSON Schema object whose type is `"object"`. */
export interface ToolInputSchema {
	readonly type: "object";
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: ReadonlyArray<string>;
	readonly [keyword: string]: unknown;
}

export interface ToolContext {
	/** Aborts when the client cancels the call. */
	readonly signal: AbortSignal;
	/** Writes one diagnostic line to the server's stderr. Never use stdout, which carries only protocol frames. */
	log(message: string): void;
}

/** What `run` returns: text, a JSON value, or a failure message the client sees as a tool error. */
export type ToolResult = { readonly text: string } | { readonly json: unknown } | { readonly error: string };

export interface ToolSpec<TArgs = Record<string, unknown>> {
	/** Matches /^[a-z][a-z0-9_]*$/, at most 64 characters. */
	readonly name: string;
	readonly description: string;
	readonly input: ToolInputSchema;
	readonly actionClass: ToolActionClass;
	/** Defaults to `actionClass === "read"`; may be true only for a `read` tool. */
	readonly readOnly?: boolean;
	/** Whether calling twice with the same arguments has no further effect. Defaults to false. */
	readonly idempotent?: boolean;
	/** Arguments that name file paths, each a string property of `input`, with how the tool uses the path. */
	readonly pathArguments?: Readonly<Record<string, ToolPathAccess>>;
	run(args: TArgs, context: ToolContext): ToolResult | Promise<ToolResult>;
}

/** A checked tool definition with every default filled in. */
export interface Tool<TArgs = Record<string, unknown>> extends ToolSpec<TArgs> {
	readonly readOnly: boolean;
	readonly idempotent: boolean;
	readonly pathArguments: Readonly<Record<string, ToolPathAccess>>;
}

/** A tool of any argument type, as a server holds it. */
export type AnyTool = Tool<never>;

export interface ServerSpec {
	/** Matches /^[a-z0-9][a-z0-9_-]*$/, at most 32 characters. */
	readonly id: string;
	readonly version: string;
	readonly title?: string;
	readonly tools: ReadonlyArray<AnyTool | ToolSpec<never>>;
}

/** A checked server definition. */
export interface ToolServer {
	readonly id: string;
	readonly version: string;
	readonly title?: string;
	readonly tools: ReadonlyArray<AnyTool>;
}

export interface PolicyManifestTool {
	name: string;
	actionClass: ToolActionClass;
	readOnly: boolean;
	idempotent: boolean;
	pathArguments: Record<string, ToolPathAccess>;
}

export interface PolicyManifest {
	id: string;
	version: string;
	tools: PolicyManifestTool[];
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOOL_NAME_MAX = 64;
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SERVER_ID_MAX = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaTypes(schema: unknown): string[] {
	if (!isRecord(schema)) return [];
	if (typeof schema.type === "string") return [schema.type];
	return Array.isArray(schema.type) ? schema.type.filter((entry): entry is string => typeof entry === "string") : [];
}

function checkInput(where: string, input: unknown): ToolInputSchema {
	if (!isRecord(input)) throw new Error(`${where}.input must be a JSON Schema object`);
	if (input.type !== "object") throw new Error(`${where}.input.type must be "object"`);
	if (input.properties !== undefined) {
		if (!isRecord(input.properties)) throw new Error(`${where}.input.properties must be an object`);
		for (const [key, schema] of Object.entries(input.properties)) {
			if (!isRecord(schema)) throw new Error(`${where}.input.properties.${key} must be a JSON Schema object`);
		}
	}
	if (input.required !== undefined) {
		if (!Array.isArray(input.required) || input.required.some((entry) => typeof entry !== "string")) {
			throw new Error(`${where}.input.required must be an array of strings`);
		}
	}
	return input as unknown as ToolInputSchema;
}

function checkPathArguments(
	where: string,
	value: unknown,
	input: ToolInputSchema,
): Readonly<Record<string, ToolPathAccess>> {
	if (value === undefined) return Object.freeze({});
	if (!isRecord(value)) throw new Error(`${where}.pathArguments must be an object`);
	const properties = input.properties ?? {};
	const out: Record<string, ToolPathAccess> = {};
	for (const key of Object.keys(value).sort()) {
		const access = value[key];
		if (access !== "read" && access !== "write") {
			throw new Error(`${where}.pathArguments.${key} must be "read" or "write"`);
		}
		if (!Object.hasOwn(properties, key)) {
			throw new Error(`${where}.pathArguments.${key} names no property of input`);
		}
		if (!schemaTypes(properties[key]).includes("string")) {
			throw new Error(`${where}.pathArguments.${key} names input property ${key}, which is not a string`);
		}
		out[key] = access;
	}
	return Object.freeze(out);
}

/** Check a tool definition and fill its defaults. Throws an Error naming the first bad field. */
export function defineTool<TArgs = Record<string, unknown>>(spec: ToolSpec<TArgs>): Tool<TArgs> {
	if (!isRecord(spec)) throw new Error("defineTool expects a tool definition object");
	const label = typeof spec.name === "string" && spec.name.length > 0 ? spec.name : "?";
	const where = `tool ${label}`;
	if (typeof spec.name !== "string" || !TOOL_NAME_PATTERN.test(spec.name)) {
		throw new Error(`${where}: name must match /^[a-z][a-z0-9_]*$/`);
	}
	if (spec.name.length > TOOL_NAME_MAX) throw new Error(`${where}: name exceeds ${TOOL_NAME_MAX} characters`);
	if (typeof spec.description !== "string" || spec.description.trim().length === 0) {
		throw new Error(`${where}: description must be a non-empty string`);
	}
	const input = checkInput(where, spec.input);
	const actionClass: unknown = spec.actionClass;
	if (actionClass === "write") {
		throw new Error(
			`${where}: actionClass "write" does not exist; a tool that writes files is "execute" or "destructive" and names its write paths in pathArguments`,
		);
	}
	if (actionClass !== "read" && actionClass !== "execute" && actionClass !== "destructive") {
		throw new Error(`${where}: actionClass must be "read", "execute" or "destructive"`);
	}
	if (spec.readOnly !== undefined && typeof spec.readOnly !== "boolean") {
		throw new Error(`${where}: readOnly must be a boolean`);
	}
	if (spec.readOnly === true && actionClass !== "read") {
		throw new Error(`${where}: readOnly may be true only for a "read" tool, not "${actionClass}"`);
	}
	if (spec.idempotent !== undefined && typeof spec.idempotent !== "boolean") {
		throw new Error(`${where}: idempotent must be a boolean`);
	}
	const pathArguments = checkPathArguments(where, spec.pathArguments, input);
	if (typeof spec.run !== "function") throw new Error(`${where}: run must be a function`);
	const run = spec.run;
	return Object.freeze({
		name: spec.name,
		description: spec.description,
		input,
		actionClass,
		readOnly: spec.readOnly ?? actionClass === "read",
		idempotent: spec.idempotent ?? false,
		pathArguments,
		run(args: TArgs, context: ToolContext) {
			return run.call(spec, args, context);
		},
	});
}

/** Check a server definition: its id, version, and tools with unique names. Throws an Error naming the bad field. */
export function defineServer(spec: ServerSpec): ToolServer {
	if (!isRecord(spec)) throw new Error("defineServer expects a server definition object");
	if (typeof spec.id !== "string" || !SERVER_ID_PATTERN.test(spec.id)) {
		throw new Error("server id must match /^[a-z0-9][a-z0-9_-]*$/");
	}
	if (spec.id.length > SERVER_ID_MAX) throw new Error(`server id exceeds ${SERVER_ID_MAX} characters`);
	const where = `server ${spec.id}`;
	if (typeof spec.version !== "string" || spec.version.trim().length === 0) {
		throw new Error(`${where}: version must be a non-empty string`);
	}
	if (spec.title !== undefined && typeof spec.title !== "string") throw new Error(`${where}: title must be a string`);
	if (!Array.isArray(spec.tools)) throw new Error(`${where}: tools must be an array`);
	const seen = new Set<string>();
	const tools: AnyTool[] = [];
	for (const entry of spec.tools as ReadonlyArray<ToolSpec<never>>) {
		const tool = defineTool(entry);
		if (seen.has(tool.name)) throw new Error(`${where}: tools has two tools named ${tool.name}`);
		seen.add(tool.name);
		tools.push(tool);
	}
	return Object.freeze({
		id: spec.id,
		version: spec.version,
		...(spec.title !== undefined ? { title: spec.title } : {}),
		tools: Object.freeze(tools),
	});
}

/**
 * The server's policy as plain JSON, tools sorted by name and path arguments by
 * key, so the same server always yields the same bytes. A host that ships this
 * manifest treats it as its own policy; the server reporting it at runtime
 * changes nothing.
 */
export function policyManifest(server: ToolServer): PolicyManifest {
	const tools = [...server.tools]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((tool) => {
			const pathArguments: Record<string, ToolPathAccess> = {};
			for (const key of Object.keys(tool.pathArguments).sort()) {
				const access = tool.pathArguments[key];
				if (access !== undefined) pathArguments[key] = access;
			}
			return {
				name: tool.name,
				actionClass: tool.actionClass,
				readOnly: tool.readOnly,
				idempotent: tool.idempotent,
				pathArguments,
			};
		});
	return { id: server.id, version: server.version, tools };
}
