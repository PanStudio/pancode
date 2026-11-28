// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The request metadata MCP 2026-07-28 Streamable HTTP mirrors from a JSON-RPC
 * body into HTTP headers (basic/transports/streamable-http, Request Metadata):
 * `Mcp-Method`, `Mcp-Name`, and the `Mcp-Param-{name}` headers a tool's
 * inputSchema designates with `x-mcp-header`. Pure functions, shared by the
 * protocol client (which validates a listing) and the HTTP transport (which
 * builds each request's headers).
 */

import { isRecord } from "../../core/type-guards.js";
import type { McpParamHeader } from "./transport.js";

/** RFC 9110 field-name token (`1*tchar`). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
/** A header value that needs no encoding: visible ASCII with inner spaces or tabs, no edge whitespace. */
const PLAIN_VALUE = /^(?:[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?)?$/u;
const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Schema keywords whose subschemas are reachable only through something other than a `properties` chain. */
const NESTED_SCHEMA_KEYWORDS = [
	"items",
	"prefixItems",
	"additionalItems",
	"contains",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"oneOf",
	"anyOf",
	"allOf",
	"patternProperties",
	"dependentSchemas",
	"$defs",
	"definitions",
] as const;

/** Whether `name` may be an HTTP field name. */
export function isHttpToken(name: string): boolean {
	return TOKEN.test(name);
}

/**
 * Encode a value for a mirrored header (Value Encoding): plain when it is
 * header-safe ASCII, else Base64 of its UTF-8 inside the `=?base64?...?=`
 * sentinel. A plain value that itself looks like the sentinel is encoded too.
 */
export function encodeMcpHeaderValue(value: string): string {
	const looksEncoded = value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX);
	if (PLAIN_VALUE.test(value) && !looksEncoded) return value;
	return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

/** The primitive type an annotated parameter declares, or null when it is not one of string, integer, boolean. */
function primitiveType(schema: Record<string, unknown>): string | null {
	const declared = schema.type;
	const types = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
	const named = types.filter((type) => type !== "null");
	if (named.length !== 1) return null;
	const [type] = named;
	return type === "string" || type === "integer" || type === "boolean" ? type : null;
}

/**
 * The parameters a tool mirrors into `Mcp-Param-*` headers, or the reason its
 * `x-mcp-header` annotations break the Schema Extension constraints: an empty,
 * non-token or case-insensitively repeated name, a type other than string,
 * integer or boolean, or an annotation not reached by a chain of `properties`
 * keys alone. A tool with such a reason is excluded from the listing.
 */
export function mcpParamHeaders(inputSchema: unknown): McpParamHeader[] | string {
	const headers: McpParamHeader[] = [];
	const seen = new Set<string>();
	let problem: string | null = null;
	const visit = (schema: unknown, path: ReadonlyArray<string> | null): void => {
		if (problem !== null || !isRecord(schema)) return;
		if (Object.hasOwn(schema, "x-mcp-header")) {
			const name = schema["x-mcp-header"];
			const at = path === null ? "a schema position" : path.length === 0 ? "the schema root" : path.join(".");
			if (path === null || path.length === 0) {
				problem = `x-mcp-header at ${at} is not reached through properties alone`;
				return;
			}
			if (typeof name !== "string" || name.length === 0) {
				problem = `x-mcp-header on ${at} is not a non-empty string`;
				return;
			}
			if (!isHttpToken(name)) {
				problem = `x-mcp-header ${JSON.stringify(name)} on ${at} is not an HTTP field-name token`;
				return;
			}
			const folded = name.toLowerCase();
			if (seen.has(folded)) {
				problem = `x-mcp-header ${JSON.stringify(name)} on ${at} repeats another parameter's header name`;
				return;
			}
			if (primitiveType(schema) === null) {
				problem = `x-mcp-header ${JSON.stringify(name)} on ${at} annotates a parameter that is not a string, integer or boolean`;
				return;
			}
			seen.add(folded);
			headers.push({ name, path });
		}
		if (isRecord(schema.properties)) {
			for (const [key, child] of Object.entries(schema.properties)) visit(child, path === null ? null : [...path, key]);
		}
		for (const keyword of NESTED_SCHEMA_KEYWORDS) {
			const nested = schema[keyword];
			if (Array.isArray(nested)) for (const child of nested) visit(child, null);
			else if (
				isRecord(nested) &&
				(keyword === "patternProperties" ||
					keyword === "dependentSchemas" ||
					keyword === "$defs" ||
					keyword === "definitions")
			) {
				for (const child of Object.values(nested)) visit(child, null);
			} else visit(nested, null);
		}
	};
	visit(inputSchema, []);
	return problem ?? headers;
}

/** The header text of one argument value under the type conversion rules, or null when nothing is sent. */
function paramText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_SAFE) return String(value);
	return null;
}

/** The `Mcp-Param-*` headers of one call's arguments; a parameter with no value at its path sends no header. */
export function mcpParamHeaderValues(
	args: unknown,
	params: ReadonlyArray<McpParamHeader>,
): Array<[name: string, value: string]> {
	const out: Array<[string, string]> = [];
	for (const param of params) {
		let value: unknown = args;
		for (const key of param.path) value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
		const text = paramText(value);
		if (text !== null) out.push([`Mcp-Param-${param.name}`, encodeMcpHeaderValue(text)]);
	}
	return out;
}

/**
 * The `Mcp-Name` source of a request (Standard Request Headers): the tool or
 * prompt name, the resource URI, or the task id of a Tasks extension request.
 */
export function mcpNameSource(method: string, params: unknown): string | null {
	if (!isRecord(params)) return null;
	const field =
		method === "tools/call" || method === "prompts/get"
			? params.name
			: method === "resources/read"
				? params.uri
				: method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel"
					? params.taskId
					: undefined;
	return typeof field === "string" ? field : null;
}
