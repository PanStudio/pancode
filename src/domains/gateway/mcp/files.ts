// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The experimental MCP files extension (`io.modelcontextprotocol/files`,
 * specification draft of 2026-11-09): every wire name it defines lives here,
 * so a revision of the draft is one edit. This module reads and checks what
 * a server sends (settings, `x-mcp-file` schemas, upload requests, download
 * targets) and builds what PanCode sends (settings, file inputs, multipart
 * bodies). It moves no bytes; the gateway performs each transfer.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { isRecord } from "../../../core/type-guards.js";

export const MCP_FILES_EXTENSION = "io.modelcontextprotocol/files";
const FILE_KEYWORD = "x-mcp-file";
const UPLOAD_REQUIRED = "upload_required";
const DIGEST_ALGORITHM = "sha-256";

/** PanCode's bounds, from Claude's published profile where it gives one. */
export const MCP_FILE_LIMITS = Object.freeze({
	filesPerCall: 10,
	downloadsPerResult: 10,
	uploadBytesPerCall: 100 * 1024 * 1024,
	downloadBytesPerResult: 256 * 1024 * 1024,
	urlBytes: 8192,
	headers: 16,
	headerNameBytes: 128,
	headerValueBytes: 4096,
	formFields: 32,
	formNameBytes: 128,
	formValueBytes: 8192,
	formBytes: 65536,
	requestStateChars: 32000,
	idChars: 128,
});

/** A server's settings from its `server/discover` capabilities. */
export interface McpFilesSettings {
	/** The server takes out-of-band uploads and may answer `upload_required`. */
	upload: boolean;
	/** The total inline bytes one request may carry; 0 means none. */
	maxInlineBytes: number;
}

/**
 * The server's files settings, or null when it does not advertise the
 * extension or advertises a `revision` this client does not know.
 */
export function mcpFilesOffered(capabilities: Record<string, unknown>): McpFilesSettings | null {
	const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
	const settings = extensions === null ? undefined : extensions[MCP_FILES_EXTENSION];
	if (!isRecord(settings) || settings.revision !== undefined) return null;
	const inline = settings.maxInlineBytes;
	return {
		upload: isRecord(settings.upload),
		maxInlineBytes: typeof inline === "number" && Number.isSafeInteger(inline) && inline > 0 ? inline : 0,
	};
}

/** The client settings PanCode declares: transfers when it may make them, else inline only. */
export function mcpFilesDeclaration(transfers: boolean): Record<string, unknown> {
	return transfers ? { upload: {}, download: {} } : {};
}

// ---------------------------------------------------------------------------
// File arguments

/** One top-level argument a tool marks with `x-mcp-file`. */
export interface McpFileArgument {
	name: string;
	/** One file, one file or null, or a list of files. */
	kind: "single" | "nullable" | "array";
	accept: string[] | null;
	maxSize: number | null;
	/** Listed in the schema's `required`; a nullable one the model leaves out is sent as null. */
	required: boolean;
}

export type McpFileSchema =
	| { kind: "none" }
	| { kind: "files"; arguments: McpFileArgument[] }
	| { kind: "unsupported"; reason: string };

function containsFileKeyword(value: unknown, depth = 0): boolean {
	if (depth > 64) return true;
	if (Array.isArray(value)) return value.some((entry) => containsFileKeyword(entry, depth + 1));
	if (!isRecord(value)) return false;
	if (Object.hasOwn(value, FILE_KEYWORD)) return true;
	return Object.values(value).some((entry) => containsFileKeyword(entry, depth + 1));
}

function fileDescriptor(schema: Record<string, unknown>): Pick<McpFileArgument, "accept" | "maxSize"> | null {
	const descriptor = schema[FILE_KEYWORD];
	if (!isRecord(descriptor)) return null;
	const { accept, maxSize } = descriptor;
	if (accept !== undefined && (!Array.isArray(accept) || !accept.every((entry) => typeof entry === "string")))
		return null;
	if (maxSize !== undefined && (typeof maxSize !== "number" || !Number.isSafeInteger(maxSize) || maxSize < 0))
		return null;
	return { accept: accept === undefined ? null : [...(accept as string[])], maxSize: maxSize ?? null };
}

/** The file schema itself, holding the keyword, with nothing below it marked again. */
function markedFile(schema: unknown): Pick<McpFileArgument, "accept" | "maxSize"> | null {
	if (!isRecord(schema) || !Object.hasOwn(schema, FILE_KEYWORD)) return null;
	const { [FILE_KEYWORD]: _marker, ...rest } = schema;
	return containsFileKeyword(rest) ? null : fileDescriptor(schema);
}

function fileArgumentOf(name: string, schema: unknown, required: boolean): McpFileArgument | null {
	const single = markedFile(schema);
	if (single !== null) return { name, kind: "single", required, ...single };
	if (!isRecord(schema)) return null;
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
	if (branches !== null && branches.length === 2) {
		const file = branches.map(markedFile);
		const nullIndex = branches.findIndex((branch) => isRecord(branch) && branch.type === "null");
		const fileIndex = file.findIndex((entry) => entry !== null);
		const marked = file[fileIndex];
		if (marked != null && nullIndex !== -1 && nullIndex !== fileIndex) {
			return { name, kind: "nullable", required, ...marked };
		}
	}
	if (schema.type === "array") {
		const item = markedFile(schema.items);
		if (item !== null) return { name, kind: "array", required, ...item };
	}
	return null;
}

/**
 * The tool's file arguments. PanCode fills `x-mcp-file` only on a top-level
 * property: one file, one file or null (`anyOf` with `{"type": "null"}`), or
 * an array of files. A root that combines schemas or is itself marked, and a
 * mark anywhere else, leaves the tool's file handling unsupported; the tool
 * still lists under the schema the server gave.
 */
export function mcpFileSchema(inputSchema: unknown): McpFileSchema {
	if (!containsFileKeyword(inputSchema) || !isRecord(inputSchema)) return { kind: "none" };
	if (["allOf", "anyOf", "oneOf", FILE_KEYWORD].some((key) => Object.hasOwn(inputSchema, key))) {
		return { kind: "unsupported", reason: `its input schema combines schemas or marks a file at the root` };
	}
	const { properties, ...rest } = inputSchema;
	if (containsFileKeyword(rest)) {
		return { kind: "unsupported", reason: "it marks a file outside its top-level properties" };
	}
	const found: McpFileArgument[] = [];
	const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
	for (const [name, schema] of Object.entries(isRecord(properties) ? properties : {})) {
		if (!containsFileKeyword(schema)) continue;
		const argument = fileArgumentOf(name, schema, required.has(name));
		if (argument === null) {
			return { kind: "unsupported", reason: `argument '${name}' marks a file in a shape PanCode does not fill` };
		}
		found.push(argument);
	}
	return found.length === 0 ? { kind: "none" } : { kind: "files", arguments: found };
}

function fileArgumentDescription(argument: McpFileArgument, original: unknown): string {
	const lead = typeof original === "string" && original.trim().length > 0 ? `${original.trim()} ` : "";
	const what =
		argument.kind === "array"
			? "Workspace file paths, or store references store:<tag>:<blob>"
			: "A workspace file path, or a store reference store:<tag>:<blob>";
	const accept =
		argument.accept !== null && argument.accept.length > 0 ? ` Accepted: ${argument.accept.join(", ")}.` : "";
	const size = argument.maxSize !== null ? ` At most ${argument.maxSize} bytes each.` : "";
	return `${lead}${what}; PanCode reads the file and sends it to the server (experimental MCP files extension).${accept}${size}`;
}

/** The schema the model sees: each file argument as a path string, or a list of them. */
export function mcpFileModelSchema(
	inputSchema: Record<string, unknown>,
	fileArguments: ReadonlyArray<McpFileArgument>,
): Record<string, unknown> {
	const properties = { ...(isRecord(inputSchema.properties) ? inputSchema.properties : {}) };
	for (const argument of fileArguments) {
		const original = properties[argument.name];
		const source = isRecord(original) ? original : {};
		const description = fileArgumentDescription(argument, source.description);
		if (argument.kind === "array") {
			properties[argument.name] = {
				type: "array",
				items: { type: "string" },
				description,
				...(typeof source.minItems === "number" ? { minItems: source.minItems } : {}),
				...(typeof source.maxItems === "number" ? { maxItems: source.maxItems } : {}),
			};
		} else {
			properties[argument.name] = { type: "string", description };
		}
	}
	const nullable = new Set(fileArguments.filter((entry) => entry.kind === "nullable").map((entry) => entry.name));
	const required = Array.isArray(inputSchema.required)
		? inputSchema.required.filter((name) => typeof name === "string" && !nullable.has(name))
		: undefined;
	return { ...inputSchema, properties, ...(required !== undefined ? { required } : {}) };
}

/** One file a call names, by argument and position. */
export interface McpNamedFile {
	argument: string;
	/** Position in an array argument; null for a single file. */
	index: number | null;
	/** The path or store reference the model gave. */
	value: string;
}

/** The files a call names, in argument order, or why the arguments cannot name them. */
export function mcpNamedFiles(
	fileArguments: ReadonlyArray<McpFileArgument>,
	args: Readonly<Record<string, unknown>>,
): McpNamedFile[] | string {
	const named: McpNamedFile[] = [];
	for (const argument of fileArguments) {
		const value = Object.hasOwn(args, argument.name) ? args[argument.name] : undefined;
		if (value === undefined || (value === null && argument.kind === "nullable")) continue;
		if (argument.kind === "array") {
			if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
				return `file argument '${argument.name}' must be a list of workspace paths`;
			}
			named.push(...value.map((entry, index) => ({ argument: argument.name, index, value: entry as string })));
		} else {
			if (typeof value !== "string" || value.length === 0) {
				return `file argument '${argument.name}' must be a workspace path`;
			}
			named.push({ argument: argument.name, index: null, value });
		}
	}
	if (named.length > MCP_FILE_LIMITS.filesPerCall) {
		return `the call names ${named.length} files; PanCode sends at most ${MCP_FILE_LIMITS.filesPerCall} in one call`;
	}
	return named;
}

/** The `FileInput` object of the draft. */
export interface McpFileInput {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	digest: { algorithm: typeof DIGEST_ALGORITHM; value: string };
	data?: string;
}

/** SHA-256 as the draft spells it: base64url without padding. */
function mcpFileDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("base64url");
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	".csv": "text/csv",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".gz": "application/gzip",
	".htm": "text/html",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".pdf": "application/pdf",
	".png": "image/png",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".svg": "image/svg+xml",
	".tar": "application/x-tar",
	".tsv": "text/tab-separated-values",
	".txt": "text/plain",
	".wav": "audio/wav",
	".webp": "image/webp",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".zip": "application/zip",
};

/** The media type a file name suggests, or `application/octet-stream`. */
function mcpFileMimeType(name: string): string {
	return MIME_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A file's metadata, without `data`; the caller adds `data` when the file goes inline. */
export function mcpFileInput(id: string, name: string, bytes: Uint8Array): McpFileInput {
	return {
		id,
		name,
		mimeType: mcpFileMimeType(name),
		size: bytes.byteLength,
		digest: { algorithm: DIGEST_ALGORITHM, value: mcpFileDigest(bytes) },
	};
}

/** The call's arguments with each named file replaced by its `FileInput`. */
export function withMcpFileInputs(
	args: Readonly<Record<string, unknown>>,
	files: ReadonlyArray<{ named: McpNamedFile; input: McpFileInput }>,
	fileArguments: ReadonlyArray<McpFileArgument>,
): Record<string, unknown> {
	const rebuilt: Record<string, unknown> = { ...args };
	for (const argument of fileArguments) {
		const mine = files.filter((file) => file.named.argument === argument.name);
		if (argument.kind === "array") {
			if (Array.isArray(args[argument.name])) rebuilt[argument.name] = mine.map((file) => file.input);
		} else if (mine[0] !== undefined) {
			rebuilt[argument.name] = mine[0].input;
		} else if (argument.kind === "nullable" && (Object.hasOwn(args, argument.name) || argument.required)) {
			rebuilt[argument.name] = null;
		}
	}
	return rebuilt;
}

/** Whether `accept` admits a file of this name and media type; no list admits every file. */
export function mcpFileAccepted(accept: ReadonlyArray<string> | null, name: string, mimeType: string): boolean {
	if (accept === null || accept.length === 0) return true;
	const extension = path.extname(name).toLowerCase();
	const type = mimeType.toLowerCase();
	return accept.some((entry) => {
		const wanted = entry.trim().toLowerCase();
		if (wanted.startsWith(".")) return wanted === extension;
		if (wanted.endsWith("/*")) return type.startsWith(wanted.slice(0, -1));
		return wanted === type || wanted === "*/*";
	});
}

// ---------------------------------------------------------------------------
// Targets

export type McpTargetLocation = { url: string } | { path: string };

interface McpTargetBase {
	location: McpTargetLocation;
	/** Header name and value, in the order the server gave them. */
	headers: Array<[string, string]>;
	credentials: "omit" | "include";
	/** Epoch milliseconds, or null when the target names no expiry. */
	expiresAt: number | null;
}

export interface McpUploadTarget extends McpTargetBase {
	fileId: string;
	method: "PUT" | "POST";
	form: { fields: Array<{ name: string; value: string }>; fileField: string } | null;
}

export interface McpDownloadTarget extends McpTargetBase {
	name: string | null;
	mimeType: string;
	size: number;
	digest: string | null;
}

export interface McpUploadRequest {
	uploads: McpUploadTarget[];
	requestState: string;
}

/** The strings of a target that may carry a capability: its url (whole and from the path on), path, header and form values. */
export function mcpTargetSecrets(target: McpUploadTarget | McpDownloadTarget): string[] {
	const values = target.headers.map(([, value]) => value);
	if ("path" in target.location) values.push(target.location.path);
	else {
		values.push(target.location.url);
		const url = URL.parse(target.location.url);
		if (url !== null) values.push(`${url.pathname}${url.search}`);
	}
	if ("form" in target && target.form !== null) values.push(...target.form.fields.map((field) => field.value));
	return values;
}

const UPLOAD_TARGET_MEMBERS = new Set([
	"fileId",
	"url",
	"path",
	"method",
	"form",
	"headers",
	"credentials",
	"expiresAt",
	"_meta",
]);
const DOWNLOAD_TARGET_MEMBERS = new Set([
	"name",
	"mimeType",
	"size",
	"digest",
	"url",
	"path",
	"headers",
	"credentials",
	"expiresAt",
	"_meta",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
// A field value: visible characters and obs-text, single spaces or tabs inside, none at either end.
const HEADER_VALUE = /^(?:[\x21-\x7e\x80-\xff](?:[\t \x21-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?)?$/u;
const FORBIDDEN_HEADERS = new Set([
	"accept-charset",
	"accept-encoding",
	"access-control-request-headers",
	"access-control-request-method",
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"date",
	"dnt",
	"expect",
	"host",
	"keep-alive",
	"origin",
	"referer",
	"set-cookie",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"via",
]);
const METHOD_OVERRIDE_HEADERS = new Set(["x-http-method", "x-http-method-override", "x-method-override"]);
const ROUTING_HEADERS = new Set(["forwarded", "x-original-url", "x-rewrite-url", ...METHOD_OVERRIDE_HEADERS]);
const FORM_EXCLUDED_HEADERS = new Set([
	"content-type",
	"content-encoding",
	"content-range",
	"content-digest",
	"repr-digest",
]);
const PATH_TARGET = /^(?:\/[A-Za-z0-9\-_~.]+)+$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const DIGEST_VALUE = /^[A-Za-z0-9_-]{43}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a form part name cannot carry a control character.
const FORM_NAME_FORBIDDEN = /[\x00-\x1f\x7f"\\]/u;
const FORM_VALUE_FORBIDDEN = /[\r\n\0]/u;

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** A member the draft reads as absent when its value is null. */
function member(record: Record<string, unknown>, key: string): unknown {
	const value = record[key];
	return value === null ? undefined : value;
}

function unknownMember(record: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
	return Object.keys(record).find((key) => !allowed.has(key) && record[key] !== null) ?? null;
}

function forbiddenHeader(name: string, value: string): boolean {
	const lower = name.toLowerCase();
	if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) return true;
	if (!METHOD_OVERRIDE_HEADERS.has(lower)) return false;
	return value.split(",").some((method) => ["CONNECT", "TRACE", "TRACK"].includes(method.trim().toUpperCase()));
}

/** Rules 1 to 4 of the draft's Targets on the members uploads and downloads share. */
function targetBase(record: Record<string, unknown>): McpTargetBase | string {
	const url = member(record, "url");
	const pathValue = member(record, "path");
	if ((url === undefined) === (pathValue === undefined)) return "it names neither or both of url and path";
	let location: McpTargetLocation;
	if (url !== undefined) {
		if (typeof url !== "string" || bytes(url) > MCP_FILE_LIMITS.urlBytes)
			return "its url is not a string within 8192 bytes";
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return "its url is not an absolute URL";
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "its url is not https";
		if (parsed.username !== "" || parsed.password !== "") return "its url carries userinfo";
		location = { url };
	} else {
		if (typeof pathValue !== "string" || bytes(pathValue) > MCP_FILE_LIMITS.urlBytes || !PATH_TARGET.test(pathValue)) {
			return "its path is not a sequence of /segment";
		}
		if (pathValue.split("/").some((segment) => segment === "." || segment === ".."))
			return "its path has a . or .. segment";
		location = { path: pathValue };
	}
	const credentials = member(record, "credentials");
	if (credentials !== "omit" && credentials !== "include") return "its credentials is not omit or include";
	const expires = member(record, "expiresAt");
	let expiresAt: number | null = null;
	if (expires !== undefined) {
		const time = typeof expires === "string" && RFC3339.test(expires) ? Date.parse(expires) : Number.NaN;
		if (!Number.isFinite(time)) return "its expiresAt is not an RFC 3339 time";
		expiresAt = time;
	}
	const declared = member(record, "headers");
	const headers: Array<[string, string]> = [];
	if (declared !== undefined) {
		if (!isRecord(declared)) return "its headers is not an object";
		const seen = new Set<string>();
		for (const [name, value] of Object.entries(declared)) {
			if (value === null) continue;
			if (typeof value !== "string") return "a header value is not a string";
			if (!HEADER_NAME.test(name) || bytes(name) > MCP_FILE_LIMITS.headerNameBytes) return "a header name is not valid";
			if (!HEADER_VALUE.test(value) || bytes(value) > MCP_FILE_LIMITS.headerValueBytes)
				return "a header value is not valid";
			const lower = name.toLowerCase();
			if (seen.has(lower)) return "it names one header twice";
			seen.add(lower);
			if (forbiddenHeader(name, value)) return `it sets header ${name}, which a client must not send`;
			const routed = "path" in location || credentials === "include";
			if (routed && (ROUTING_HEADERS.has(lower) || lower.startsWith("x-forwarded-"))) {
				return `it sets header ${name} on a path or include target`;
			}
			headers.push([name, value]);
		}
		if (headers.length > MCP_FILE_LIMITS.headers) return `it sets more than ${MCP_FILE_LIMITS.headers} headers`;
	}
	return { location, headers, credentials, expiresAt };
}

function digestOf(value: unknown): string | null | undefined {
	if (value === undefined) return null;
	if (!isRecord(value) || unknownMember(value, new Set(["algorithm", "value"])) !== null) return undefined;
	if (value.algorithm !== DIGEST_ALGORITHM || typeof value.value !== "string" || !DIGEST_VALUE.test(value.value))
		return undefined;
	return value.value;
}

function uploadTarget(value: unknown): McpUploadTarget | string {
	if (!isRecord(value)) return "an upload target is not an object";
	const stray = unknownMember(value, UPLOAD_TARGET_MEMBERS);
	if (stray !== null) return `an upload target has unknown member ${JSON.stringify(stray.slice(0, 64))}`;
	const fileId = member(value, "fileId");
	if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MCP_FILE_LIMITS.idChars) {
		return "an upload target has no fileId";
	}
	const base = targetBase(value);
	if (typeof base === "string") return `upload target for ${JSON.stringify(fileId)}: ${base}`;
	const reject = (reason: string): string => `upload target for ${JSON.stringify(fileId)}: ${reason}`;
	const method = member(value, "method") ?? "PUT";
	if (method !== "PUT" && method !== "POST") return reject("its method is not PUT or POST");
	const declared = member(value, "form");
	let form: McpUploadTarget["form"] = null;
	if (declared !== undefined) {
		if (!isRecord(declared) || unknownMember(declared, new Set(["fields", "fileField"])) !== null) {
			return reject("its form is not {fields, fileField}");
		}
		if (method !== "POST") return reject("it has a form but its method is not POST");
		const excluded = base.headers.find(([name]) => FORM_EXCLUDED_HEADERS.has(name.toLowerCase()));
		if (excluded !== undefined) return reject(`it has a form and sets header ${excluded[0]}`);
		const fileField = member(declared, "fileField");
		if (typeof fileField !== "string" || fileField.length === 0 || FORM_NAME_FORBIDDEN.test(fileField)) {
			return reject("its form fileField is empty or has a control character, quote or backslash");
		}
		if (bytes(fileField) > MCP_FILE_LIMITS.formNameBytes) {
			return reject("its form fileField is over PanCode's size bound");
		}
		const fields = member(declared, "fields");
		if (!Array.isArray(fields) || fields.length > MCP_FILE_LIMITS.formFields) {
			return reject(`its form fields is not a list of at most ${MCP_FILE_LIMITS.formFields}`);
		}
		const parsed: Array<{ name: string; value: string }> = [];
		let total = bytes(fileField);
		for (const field of fields) {
			if (!isRecord(field) || unknownMember(field, new Set(["name", "value"])) !== null) {
				return reject("a form field is not {name, value}");
			}
			const name = member(field, "name");
			const text = member(field, "value");
			if (typeof name !== "string" || name.length === 0 || FORM_NAME_FORBIDDEN.test(name)) {
				return reject("a form field name is empty or has a control character, quote or backslash");
			}
			if (name === fileField) return reject("a form field has the fileField's name");
			if (typeof text !== "string" || FORM_VALUE_FORBIDDEN.test(text)) {
				return reject("a form field value has a CR, LF or NUL");
			}
			if (bytes(name) > MCP_FILE_LIMITS.formNameBytes || bytes(text) > MCP_FILE_LIMITS.formValueBytes) {
				return reject("a form field is over PanCode's size bound");
			}
			total += bytes(name) + bytes(text);
			parsed.push({ name, value: text });
		}
		if (total > MCP_FILE_LIMITS.formBytes) return reject(`its form is over ${MCP_FILE_LIMITS.formBytes} bytes`);
		form = { fields: parsed, fileField };
	}
	return { ...base, fileId, method, form };
}

/**
 * Read an `upload_required` result against the files the call left without
 * `data`. Any target that breaks the draft's rules rejects the whole request:
 * the reason is returned and nothing may be transferred.
 */
export function parseMcpUploadRequest(
	result: Record<string, unknown>,
	pending: ReadonlySet<string>,
): McpUploadRequest | string {
	const requestState = result.requestState;
	if (typeof requestState !== "string") return "its requestState is absent or not a string";
	if (requestState.length > MCP_FILE_LIMITS.requestStateChars) {
		return `its requestState is over ${MCP_FILE_LIMITS.requestStateChars} characters`;
	}
	if (!Array.isArray(result.uploads)) return "its uploads is not a list";
	if (result.uploads.length > MCP_FILE_LIMITS.filesPerCall) return "it lists more targets than the call has files";
	const uploads: McpUploadTarget[] = [];
	const seen = new Set<string>();
	for (const entry of result.uploads) {
		const target = uploadTarget(entry);
		if (typeof target === "string") return target;
		if (!pending.has(target.fileId))
			return `it names fileId ${JSON.stringify(target.fileId)}, which the call did not leave to upload`;
		if (seen.has(target.fileId)) return `it names fileId ${JSON.stringify(target.fileId)} twice`;
		seen.add(target.fileId);
		uploads.push(target);
	}
	const missing = [...pending].find((id) => !seen.has(id));
	if (missing !== undefined) return `it gives no target for fileId ${JSON.stringify(missing)}`;
	return { uploads, requestState };
}

/** Whether a modern result is the draft's `upload_required`. */
export function isMcpUploadRequired(result: Record<string, unknown>): boolean {
	return result.resultType === UPLOAD_REQUIRED;
}

function downloadTarget(value: unknown): McpDownloadTarget | string {
	if (!isRecord(value)) return "it is not an object";
	const stray = unknownMember(value, DOWNLOAD_TARGET_MEMBERS);
	if (stray !== null) return `it has unknown member ${JSON.stringify(stray.slice(0, 64))}`;
	const mimeType = member(value, "mimeType");
	if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 255) return "it has no mimeType";
	const size = member(value, "size");
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
		return "its size is not a non-negative integer";
	const digest = digestOf(member(value, "digest"));
	if (digest === undefined) return "its digest is not a sha-256 base64url value";
	const name = member(value, "name");
	if (name !== undefined && typeof name !== "string") return "its name is not a string";
	const base = targetBase(value);
	if (typeof base === "string") return base;
	return { ...base, name: name ?? null, mimeType, size, digest };
}

/**
 * The download targets in a result's `_meta`, each checked on its own: a
 * target that breaks a rule is left out with its reason, and targets past
 * PanCode's per-result bound are left out too.
 */
export function parseMcpDownloads(meta: unknown): { targets: McpDownloadTarget[]; dropped: string[] } {
	const files = isRecord(meta) ? meta[MCP_FILES_EXTENSION] : undefined;
	const listed = isRecord(files) ? files.downloads : undefined;
	if (!Array.isArray(listed)) return { targets: [], dropped: [] };
	const targets: McpDownloadTarget[] = [];
	const dropped: string[] = [];
	for (const [index, entry] of listed.entries()) {
		if (targets.length >= MCP_FILE_LIMITS.downloadsPerResult) {
			dropped.push(`download ${index + 1}: past PanCode's bound of ${MCP_FILE_LIMITS.downloadsPerResult} per result`);
			continue;
		}
		const target = downloadTarget(entry);
		if (typeof target === "string") dropped.push(`download ${index + 1}: ${target}`);
		else targets.push(target);
	}
	return { targets, dropped };
}

/** What a transfer needs from the MCP connection the target came over. */
export interface McpFileConnection {
	/** The MCP address after any redirect the client followed; null on stdio. */
	address: URL | null;
	/** The origin an `include` url target must have: the canonical server URI's; null on stdio. */
	credentialOrigin: string | null;
	/** The Authorization value the next MCP request would carry, or null when it carries none. */
	authorization(signal: AbortSignal | undefined): Promise<string | null>;
}

export interface McpFileTransferContext extends McpFileConnection {
	/** Exact origins the operator lists in this server's user `fileTargets`. */
	fileTargets: ReadonlyArray<string>;
}

export interface McpResolvedTarget {
	url: URL;
	/** The target attaches the MCP requests' Authorization. */
	include: boolean;
	/** On the operator's `fileTargets`, so the address rules are the operator's. */
	listed: boolean;
	/** A path target, or a url on the MCP address's own origin: storage the server itself answers for. */
	serverOrigin: boolean;
	/** A path target under an https or loopback MCP address, which skips the address check. */
	underAddress: boolean;
}

/** Hosts that name the loopback interface. */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

function resolvePath(address: URL, target: string): URL {
	const resolved = new URL(address.href);
	resolved.hash = "";
	resolved.pathname = `${address.pathname.replace(/\/+$/u, "")}${target}`;
	return resolved;
}

/**
 * The URL a target is sent to, or why the target is rejected: the stdio
 * rule, `path` resolution, scheme and port, and the `include` origin. The
 * address the name resolves to is checked when the transfer connects.
 */
export function resolveMcpTarget(target: McpTargetBase, context: McpFileTransferContext): McpResolvedTarget | string {
	const { address } = context;
	if (address === null && ("path" in target.location || target.credentials === "include")) {
		return "a stdio server may issue only url targets with credentials omit";
	}
	let url: URL;
	let underAddress = false;
	if ("path" in target.location) {
		url = resolvePath(address as URL, target.location.path);
		underAddress = url.protocol === "https:" || isLoopbackHost(url.hostname);
	} else {
		url = new URL(target.location.url);
	}
	const listed = context.fileTargets.includes(url.origin);
	const serverOrigin = "path" in target.location || (address !== null && url.origin === address.origin);
	if (url.protocol === "http:" && !listed && !("path" in target.location && isLoopbackHost(url.hostname))) {
		return "its url is http, which only a loopback fileTargets entry permits";
	}
	if ("url" in target.location && !listed && url.port !== "") return "its url names a port other than 443";
	const include = target.credentials === "include";
	if (include && !("path" in target.location) && url.origin !== context.credentialOrigin) {
		return "it asks for credentials on a url outside the MCP server's origin";
	}
	return { url, include, listed, serverOrigin, underAddress };
}

// ---------------------------------------------------------------------------
// Multipart

const MEDIA_TYPE =
	/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:\s*;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+|"[^"\r\n]*"))*$/u;

function escapeQuoted(text: string): string {
	return text.replace(/"/gu, "%22").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

/** The form's `filename`: the base name after both separators, or `file`. */
function mcpFormFilename(name: string | undefined): string {
	const base = (name ?? "").split(/[/\\]/u).at(-1) ?? "";
	return base === "" || base === "." || base === ".." ? "file" : base;
}

/**
 * A `multipart/form-data` body (RFC 7578): each field in order, then the
 * file named `fileField`, under a boundary of 192 random bits.
 */
export function mcpMultipartBody(
	form: NonNullable<McpUploadTarget["form"]>,
	file: Pick<McpFileInput, "name" | "mimeType">,
	content: Uint8Array,
): { body: Buffer<ArrayBuffer>; contentType: string } {
	const boundary = `----pancode${randomBytes(24).toString("hex")}`;
	const parts: Buffer[] = [];
	for (const field of form.fields) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(field.name)}"\r\n\r\n${field.value}\r\n`,
				"utf8",
			),
		);
	}
	const type = MEDIA_TYPE.test(file.mimeType) ? file.mimeType : "application/octet-stream";
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(form.fileField)}"; filename="${escapeQuoted(mcpFormFilename(file.name))}"\r\nContent-Type: ${type}\r\n\r\n`,
			"utf8",
		),
		Buffer.from(content),
		Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
	);
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
