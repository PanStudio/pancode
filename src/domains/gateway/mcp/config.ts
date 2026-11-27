// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Declared local MCP servers. Two optional YAML files name them: the user's
 * `<config>/mcp.yaml`, trusted by authorship, and the project's
 * `.pancode/mcp.yaml`, which needs an explicit trust record (see trust.ts)
 * before anything in it is launched. An installed, enabled plugin's root
 * `mcp.json` adds plugin-scope declarations under that same explicit trust,
 * bound to the plugin's content digest; installing a plugin launches nothing.
 * The loader is strict in the same way the verifier catalog is: unknown
 * fields, shell strings, escaping paths, and oversized files are diagnostics
 * that contribute no server, never a guess.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { readSettings } from "../../../core/config.js";
import { sha256Hex } from "../../../core/hash.js";
import { isStrictDescendant } from "../../../core/path-containment.js";
import { pancodeProjectRoot } from "../../../core/project-root.js";
import { resolveSafeCwd } from "../../../core/safe-exec.js";
import { isRecord } from "../../../core/type-guards.js";
import { pancodeConfigDir } from "../../../core/xdg.js";
import { bundledPluginCatalog, listInstalledPlugins, pluginDataDir } from "../../plugins/index.js";
import {
	defaultMcpBuiltinSource,
	loadMcpBuiltinServers,
	type McpBuiltinPolicy,
	type McpBuiltinSource,
} from "./builtin.js";
import { isLoopbackHost } from "./files.js";
import { mcpCredentialKeyRefusal, mcpDeclaredHeaderRefusal, mcpRemoteEndpoint } from "./remote.js";

export const MCP_CONFIG_VERSION = 1;
export const MCP_USER_CONFIG_FILENAME = "mcp.yaml";
export const MCP_PROJECT_CONFIG_RELATIVE_PATH = ".pancode/mcp.yaml";

/** Public schema limits; diagnostics cite these values. */
export const MCP_CONFIG_CAPS = Object.freeze({
	fileBytes: 256 * 1024,
	servers: 32,
	idChars: 32,
	commandBytes: 512,
	args: 64,
	argBytes: 4096,
	envEntries: 64,
	envValueBytes: 4096,
	cwdBytes: 512,
	urlBytes: 2048,
	headers: 16,
	timeoutMs: 900_000,
	toolActionClasses: 128,
	toolPathArguments: 128,
	pathArgumentsPerTool: 16,
	fileTargets: 32,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ROOT_FIELDS = new Set(["version", "servers"]);
const SERVER_FIELDS = new Set([
	"id",
	"command",
	"args",
	"cwd",
	"env",
	"url",
	"headers",
	"oauth",
	"timeoutMs",
	"actionClass",
	"toolActionClasses",
	"toolPathArguments",
	"network",
	"fileTargets",
]);
/** The Agent Plugins `mcp.json` file at a plugin root. */
export const MCP_PLUGIN_CONFIG_FILENAME = "mcp.json";
const PLUGIN_ROOT_FIELDS = new Set(["$schema", "mcpServers"]);
const PLUGIN_SERVER_FIELDS = new Set([
	"type",
	"command",
	"args",
	"cwd",
	"env",
	"url",
	"headers",
	"timeoutMs",
	"toolActionClasses",
	"toolPathArguments",
	"network",
	"fileTargets",
]);
const SHELL_EXECUTABLES = new Set([
	"bash",
	"cmd",
	"command.com",
	"dash",
	"fish",
	"ksh",
	"powershell",
	"pwsh",
	"sh",
	"tcsh",
	"zsh",
]);

export type McpServerScope = "user" | "project" | "plugin" | "builtin";

/**
 * How PanCode signs in to a remote server that declares no headers, all
 * optional: a client the operator registered with one authorization server
 * (its secret, if any, kept in the credential store for that issuer), the
 * scopes to request along with the server's challenge, and the loopback port the
 * browser returns to.
 */
export interface McpOAuthSettings {
	issuer?: string;
	clientId?: string;
	scopes?: string[];
	redirectPort?: number;
}

const OAUTH_FIELDS = new Set(["issuer", "clientId", "scopes", "redirectPort"]);

/**
 * How a tool uses a top-level call argument that names a path. PanCode
 * resolves the path as the server would and judges it like a builtin read or
 * write of it. This judges the paths a call names; it does not confine what a
 * server process running outside a sandbox then reads or writes.
 */
export type McpPathArgumentAccess = "read" | "write";

/** Per tool, the arguments that name a path and how the tool uses each. */
export type McpToolPathArguments = Record<string, Record<string, McpPathArgumentAccess>>;

/**
 * The first declared write path argument on a tool whose class is read, or
 * null. A read tool writes nothing, so the declaration contradicts itself.
 */
export function mcpWritePathOnReadTool(
	server: { toolActionClasses: Readonly<Record<string, string>>; toolPathArguments?: McpToolPathArguments },
	serverClass: string,
): { tool: string; argument: string } | null {
	for (const [tool, args] of Object.entries(server.toolPathArguments ?? {})) {
		const cls = Object.hasOwn(server.toolActionClasses, tool) ? server.toolActionClasses[tool] : serverClass;
		if (cls !== "read") continue;
		const argument = Object.keys(args).find((name) => args[name] === "write");
		if (argument !== undefined) return { tool, argument };
	}
	return null;
}

/** The installed plugin that ships a plugin-scope declaration. */
export interface McpServerPlugin {
	id: string;
	/** Where the plugin is installed, which is not the declaration's own scope. */
	scope: "user" | "project";
	/** The plugin tree's recorded SHA-256; the declaration digest covers it. */
	contentDigest: string;
	/** The plugin's writable data directory, `${PLUGIN_DATA}`; created before each launch. */
	dataDir: string;
	/** Installed from PanCode's shipped index at tier core, its tree still the pinned one: trusted without a record. */
	core?: true;
}

interface McpServerDeclarationBase {
	id: string;
	scope: McpServerScope;
	/** The config file that declares the server. */
	path: string;
	/** Absolute working directory the server starts in; a remote server's path arguments resolve against it. */
	cwd: string;
	/** Containment root for `cwd`; the client refuses a cwd outside it. */
	cwdRoot: string;
	timeoutMs: number | null;
	/** Operator-declared effect class; project servers use the separate trust record. */
	actionClass: "read" | "execute" | "destructive" | "unknown";
	toolActionClasses: Record<string, "read" | "execute" | "destructive" | "unknown">;
	/** Declared path arguments per tool; absent when none are declared. */
	toolPathArguments?: McpToolPathArguments;
	/** Whether the user explicitly supplied a server-wide class, including unknown. */
	actionClassExplicit?: boolean;
	/** sha256 of the canonical declaration; a trust record binds to it. */
	digest: string;
	/** Set with `entryScripts`: the digest without them, so a record trusted before entry binding gets a specific stale reason. */
	digestWithoutEntryScript?: string;
	/**
	 * The operator's network grant for this server's sandboxed process, read
	 * only from user config. A project or plugin server takes it from its
	 * trust record instead, so a repository can never grant itself egress.
	 * Outside the digest: the grant changes the sandbox, not what runs.
	 */
	network?: true;
	/**
	 * Exact origins this server's file targets (experimental MCP files
	 * extension) may name although they are private, http on loopback, or on
	 * another port: an operator allowlist for private storage and testing,
	 * read only from user config. Outside the digest.
	 */
	fileTargets?: string[];
	/** Set for a plugin-scope declaration: the plugin whose `mcp.json` declares it. */
	plugin?: McpServerPlugin;
	/** Set for a project-scope declaration whose command or any file argument is a file in, or linked from, the project; never empty. */
	entryScripts?: McpServerEntryScript[];
	/** Set for a builtin-scope declaration: the policy this PanCode ships for the server. */
	builtin?: McpBuiltinPolicy;
}

/** A server PanCode starts as a local process and speaks to over its stdio. */
export interface McpStdioServerDeclaration extends McpServerDeclarationBase {
	command: string;
	args: string[];
	env: Record<string, string>;
	url?: never;
	headers?: never;
}

/** A server PanCode reaches over Streamable HTTP at `url`. */
export interface McpRemoteServerDeclaration extends McpServerDeclarationBase {
	url: string;
	/**
	 * Header name to the key of a credential PanCode stores for this url's
	 * origin; the value itself never appears in a config file.
	 */
	headers: Record<string, string>;
	/** Set only when declared; a server with headers never has it. */
	oauth?: McpOAuthSettings;
	command?: never;
	args?: never;
	env?: never;
	entryScripts?: never;
}

export type McpServerDeclaration = McpStdioServerDeclaration | McpRemoteServerDeclaration;

/**
 * A project file a project server runs, with its content hash, or the
 * reason it could not be hashed. Only bound files count; whatever they import
 * can still change under an existing trust record. `realPath` is set when the
 * spelled path resolves through a symlink, so repointing the link makes the
 * record stale; a target outside the project is bound by path only.
 */
export type McpServerEntryScript =
	| { /** Relative to the project root. */ path: string; realPath?: string; sha256: string }
	| { path: string; realPath: string }
	| { path: string; realPath?: string; error: string };

export interface McpConfigDiagnostic {
	scope: McpServerScope;
	path: string;
	message: string;
	/**
	 * Advisory: the file still loaded and nothing it declares runs differently
	 * from what was reviewed, so `mcp list` reports it without failing.
	 */
	severity?: "warning";
}

export interface McpConfigLoadResult {
	servers: McpServerDeclaration[];
	diagnostics: McpConfigDiagnostic[];
}

export interface McpConfigLoadOptions {
	cwd: string;
	/** Override for the user config directory; defaults to pancodeConfigDir(). */
	configDir?: string;
	/** Override for the builtin server manifest and the CLI that serves it; defaults to the installed package's. */
	builtin?: McpBuiltinSource;
}

type DeclaredServerFields = (
	| { command: string; args: string[]; env: Record<string, string>; cwd: string | null }
	| { url: string; headers: Record<string, string>; oauth?: McpOAuthSettings }
) & {
	id: string;
	timeoutMs: number | null;
	actionClass: "read" | "execute" | "destructive" | "unknown";
	toolActionClasses: Record<string, "read" | "execute" | "destructive" | "unknown">;
	toolPathArguments: McpToolPathArguments;
};

/** A declaration cannot widen where its own server's file targets may point; only the operator's user config can. */
function fileTargetsIgnoredMessage(location: string): string {
	return `${location} is ignored: only the operator's user mcp.yaml lists a server's file targets`;
}

/** Each entry is an exact http(s) origin; http only on loopback. */
function validateFileTargets(value: unknown, location: string): string[] | Error {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return new Error(`${location} must be a list of origins`);
	if (value.length > MCP_CONFIG_CAPS.fileTargets) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.fileTargets}-entry cap`);
	}
	const origins: string[] = [];
	for (const [index, entry] of value.entries()) {
		const at = `${location}[${index}]`;
		let url: URL | null = null;
		try {
			url = typeof entry === "string" ? new URL(entry) : null;
		} catch {
			url = null;
		}
		if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== entry) {
			return new Error(`${at} must be an exact origin such as https://storage.example.com or http://127.0.0.1:9000`);
		}
		if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
			return new Error(`${at} is http, which only a loopback host may use`);
		}
		origins.push(url.origin);
	}
	return origins;
}

/** A declaration cannot grant its own server network; only the operator's trust record can. */
function networkIgnoredMessage(location: string, id: string): string {
	return `${location} is ignored: only the operator grants a project or plugin server network, with pancode mcp trust ${id} --network`;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.has(key))
		.sort();
}

/**
 * The digest a trust record binds to: every field that changes what runs, in
 * canonical order. A remote server's digest covers its url and the credential
 * keys it sends, so trust is bound to the endpoint the credentials go to.
 */
export function mcpServerDigest(
	fields: (
		| {
				command: string;
				args: ReadonlyArray<string>;
				cwd: string | null;
				env: Readonly<Record<string, string>>;
		  }
		| { url: string; headers: Readonly<Record<string, string>>; oauth?: Readonly<McpOAuthSettings> }
	) & {
		id: string;
		timeoutMs: number | null;
		toolActionClasses?: Readonly<Record<string, "read" | "execute" | "destructive" | "unknown">>;
		toolPathArguments?: Readonly<McpToolPathArguments>;
		/** A plugin server's plugin tree digest, so any change to the plugin needs a new trust decision. */
		pluginContentDigest?: string;
		/** A project server's bound entry files, so a pulled commit cannot swap the code that runs under trust. */
		entryScripts?: ReadonlyArray<McpServerEntryScript>;
	},
): string {
	const sorted = (record: Readonly<Record<string, string>>): Record<string, string | undefined> =>
		Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, record[key]]),
		);
	const canonical = JSON.stringify({
		id: fields.id,
		...("url" in fields
			? {
					url: fields.url,
					headers: sorted(fields.headers),
					// Absent when undeclared, so a remote server trusted before OAuth keeps its digest.
					...(fields.oauth !== undefined
						? {
								oauth: {
									issuer: fields.oauth.issuer ?? null,
									clientId: fields.oauth.clientId ?? null,
									scopes: fields.oauth.scopes ?? null,
									redirectPort: fields.oauth.redirectPort ?? null,
								},
							}
						: {}),
				}
			: { command: fields.command, args: [...fields.args], cwd: fields.cwd, env: sorted(fields.env) }),
		timeoutMs: fields.timeoutMs,
		...(fields.toolActionClasses !== undefined && Object.keys(fields.toolActionClasses).length > 0
			? {
					toolActionClasses: Object.fromEntries(
						Object.keys(fields.toolActionClasses)
							.sort()
							.map((name) => [name, fields.toolActionClasses?.[name]]),
					),
				}
			: {}),
		// Absent when empty, so a declaration without path arguments keeps the digest it was trusted at.
		...(fields.toolPathArguments !== undefined && Object.keys(fields.toolPathArguments).length > 0
			? {
					toolPathArguments: Object.fromEntries(
						Object.keys(fields.toolPathArguments)
							.sort()
							.map((name) => {
								const args = fields.toolPathArguments?.[name] ?? {};
								return [
									name,
									Object.fromEntries(
										Object.keys(args)
											.sort()
											.map((arg) => [arg, args[arg]]),
									),
								];
							}),
					),
				}
			: {}),
		...(fields.pluginContentDigest !== undefined ? { pluginContentDigest: fields.pluginContentDigest } : {}),
		...(fields.entryScripts !== undefined && fields.entryScripts.length > 0
			? {
					entryScripts: fields.entryScripts.map((entry) => ({
						path: entry.path,
						sha256: "sha256" in entry ? entry.sha256 : null,
						...(entry.realPath !== undefined ? { realPath: entry.realPath } : {}),
					})),
				}
			: {}),
	});
	return sha256Hex(canonical);
}

/** The directory whose `.pancode/mcp.yaml` applies at `cwd`; project-relative server paths resolve from it. */
export function mcpProjectRoot(cwd: string): string {
	return pancodeProjectRoot(cwd, "mcp.yaml");
}

export function mcpConfigPaths(options: McpConfigLoadOptions): { user: string; project: string } {
	return {
		user: path.join(options.configDir ?? pancodeConfigDir(), MCP_USER_CONFIG_FILENAME),
		project: path.join(mcpProjectRoot(options.cwd), MCP_PROJECT_CONFIG_RELATIVE_PATH),
	};
}

function validateId(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.length > MCP_CONFIG_CAPS.idChars) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.idChars}-character cap`);
	}
	if (!ID_PATTERN.test(value)) return new Error(`${location} must match /^[a-z0-9][a-z0-9_-]*$/`);
	return value;
}

function validateCommand(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
	if (/\s/u.test(value)) return new Error(`${location} must be one executable token, not a shell command string`);
	if (utf8Bytes(value) > MCP_CONFIG_CAPS.commandBytes) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.commandBytes}-byte cap`);
	}
	const hasSeparator = value.includes("/") || value.includes("\\");
	if (hasSeparator && !(path.isAbsolute(value) || path.win32.isAbsolute(value))) {
		return new Error(
			`${location} must be an executable name resolved on PATH or an absolute path; relative path '${value}' is not allowed`,
		);
	}
	const executable = path
		.basename(value)
		.toLowerCase()
		.replace(/\.exe$/u, "");
	if (SHELL_EXECUTABLES.has(executable)) {
		return new Error(`${location} may not invoke shell executable '${value}'`);
	}
	return value;
}

function validateArgs(value: unknown, location: string): string[] | Error {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return new Error(`${location} must be an array of strings`);
	if (value.length > MCP_CONFIG_CAPS.args) return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.args}-entry cap`);
	const args: string[] = [];
	for (const [index, entry] of value.entries()) {
		const entryLocation = `${location}[${index}]`;
		if (typeof entry !== "string") return new Error(`${entryLocation} must be a string`);
		if (entry.includes("\0")) return new Error(`${entryLocation} must not contain a NUL byte`);
		if (utf8Bytes(entry) > MCP_CONFIG_CAPS.argBytes) {
			return new Error(`${entryLocation} exceeds the ${MCP_CONFIG_CAPS.argBytes}-byte cap`);
		}
		args.push(entry);
	}
	return args;
}

function validateEnv(value: unknown, location: string): Record<string, string> | Error {
	if (value === undefined) return {};
	if (!isRecord(value)) return new Error(`${location} must be an object of string values`);
	const keys = Object.keys(value);
	if (keys.length > MCP_CONFIG_CAPS.envEntries) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.envEntries}-entry cap`);
	}
	const env: Record<string, string> = {};
	for (const key of keys.sort()) {
		if (!ENV_KEY_PATTERN.test(key)) return new Error(`${location}.${key} is not a valid environment variable name`);
		const entry = value[key];
		if (typeof entry !== "string") return new Error(`${location}.${key} must be a string`);
		if (entry.includes("\0")) return new Error(`${location}.${key} must not contain a NUL byte`);
		if (utf8Bytes(entry) > MCP_CONFIG_CAPS.envValueBytes) {
			return new Error(`${location}.${key} exceeds the ${MCP_CONFIG_CAPS.envValueBytes}-byte cap`);
		}
		env[key] = entry;
	}
	return env;
}

function validateTimeout(value: unknown, location: string): number | null | Error {
	if (value === undefined) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return new Error(`${location} must be a positive integer number of milliseconds`);
	}
	if (value > MCP_CONFIG_CAPS.timeoutMs) return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.timeoutMs}ms cap`);
	return value;
}

interface ResolvedCwd {
	cwd: string;
	cwdRoot: string;
}

function realDirectory(candidate: string, location: string): string | Error {
	try {
		if (!statSync(candidate).isDirectory()) return new Error(`${location} is not a directory: '${candidate}'`);
		return realpathSync(candidate);
	} catch (error) {
		return new Error(
			`${location} cannot be resolved as a directory: '${candidate}' (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

function cwdTextRefusal(raw: string | null, location: string): Error | null {
	if (raw === null) return null;
	if (raw.length === 0) return new Error(`${location} must be a non-empty path when given`);
	if (raw.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
	if (utf8Bytes(raw) > MCP_CONFIG_CAPS.cwdBytes) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.cwdBytes}-byte cap`);
	}
	return null;
}

/**
 * A project server's cwd is repository-relative and must stay inside the
 * repository, symlinks included. A user server's cwd is absolute or relative
 * to the config directory; an absolute directory is its own containment root.
 */
function resolveCwd(raw: string | null, scope: McpServerScope, root: string, location: string): ResolvedCwd | Error {
	const refused = cwdTextRefusal(raw, location);
	if (refused !== null) return refused;
	const absolute = raw !== null && (path.isAbsolute(raw) || path.win32.isAbsolute(raw));
	if (scope !== "user" && absolute) {
		return new Error(
			`${location} must be ${scope === "plugin" ? "relative to its plugin root" : "repository-relative"}; absolute cwd '${raw}' is not allowed`,
		);
	}
	const realRoot = realDirectory(root, `${location} root`);
	if (realRoot instanceof Error) return realRoot;
	if (scope === "user" && absolute && raw !== null) {
		const real = realDirectory(raw, location);
		if (real instanceof Error) return real;
		return { cwd: real, cwdRoot: real };
	}
	let resolved: string;
	try {
		resolved = resolveSafeCwd(raw ?? undefined, realRoot);
	} catch {
		return new Error(`${location} escapes its root: '${raw}'`);
	}
	const real = realDirectory(resolved, location);
	if (real instanceof Error) return real;
	try {
		resolveSafeCwd(real, realRoot);
	} catch {
		return new Error(`${location} escapes its root through a symbolic link: '${raw}'`);
	}
	return { cwd: real, cwdRoot: realRoot };
}

const PLUGIN_VARIABLE = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu;
const PLUGIN_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const NAMES_PLUGIN_VARIABLE = /\$\{PLUGIN_(?:ROOT|DATA)\}/u;
const ANCHORED_PLUGIN_CWD = /^\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}(?:\/(.*))?$/su;

/** `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` replaced in one pass; any other `${...}` text stays as written. */
function expandPluginVariables(value: string, root: string, dataDir: string): string {
	return value.replace(PLUGIN_VARIABLE, (_match, name: string) => (name === "PLUGIN_ROOT" ? root : dataDir));
}

/**
 * A plugin server's cwd: relative to the plugin root, or `${PLUGIN_ROOT}` or
 * `${PLUGIN_DATA}` alone or followed by a relative path that stays inside that
 * directory. The data directory is created at launch, so a cwd under it is
 * resolved here only by its text; the spawn checks the real path.
 */
function resolvePluginCwd(raw: string | null, root: string, dataDir: string, location: string): ResolvedCwd | Error {
	const refused = cwdTextRefusal(raw, location);
	if (refused !== null) return refused;
	const anchored = raw === null ? null : ANCHORED_PLUGIN_CWD.exec(raw);
	const rest = anchored === null ? raw : anchored[2] !== undefined && anchored[2].length > 0 ? anchored[2] : null;
	if (rest !== null && NAMES_PLUGIN_VARIABLE.test(rest)) {
		return new Error(`${location} may name \${PLUGIN_ROOT} or \${PLUGIN_DATA} only at its start: '${raw}'`);
	}
	if (anchored?.[1] !== "PLUGIN_DATA") return resolveCwd(rest, "plugin", root, location);
	if (rest !== null && (path.isAbsolute(rest) || path.win32.isAbsolute(rest))) {
		return new Error(`${location} escapes the plugin data directory: '${raw}'`);
	}
	try {
		return { cwd: resolveSafeCwd(rest ?? undefined, dataDir), cwdRoot: dataDir };
	} catch {
		return new Error(`${location} escapes the plugin data directory: '${raw}'`);
	}
}

function sha256OfRegularFile(filePath: string): string | Error {
	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	try {
		if (!fstatSync(fd).isFile()) return new Error("not a regular file");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
		return hash.digest("hex");
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	} finally {
		closeSync(fd);
	}
}

/** The first symlink on the way from `root` to `target` that does not resolve, relative to `root`. */
function danglingLinkOn(root: string, target: string): string | undefined {
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		current = path.join(current, part);
		try {
			if (!lstatSync(current).isSymbolicLink()) continue;
		} catch {
			// The component itself is missing, so the path is simply absent.
			return undefined;
		}
		if (!existsSync(current)) return path.relative(root, current);
	}
	return undefined;
}

/**
 * The paths a server's launch names as files: an absolute command, then every
 * argument not shaped like a flag and every value a flag carries after `=`
 * (`--require=./a.cjs`, `-r=./a.cjs`), resolved against the server's cwd. A
 * flag itself is never a file, so a planted `tools/--inspect` cannot stand in
 * for the script. Every argument after a bare `--` is a value, since the
 * program no longer reads it as a flag. A bare command resolves through PATH
 * and is not listed.
 */
export function mcpServerFileArguments(command: string, args: ReadonlyArray<string>, cwd: string): string[] {
	const files = path.isAbsolute(command) ? [command] : [];
	let flags = true;
	for (const arg of args) {
		if (flags && arg === "--") {
			flags = false;
			continue;
		}
		const value = flags && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1 || arg.length) : arg;
		if (value.length === 0) continue;
		files.push(path.resolve(cwd, value));
	}
	return files;
}

/**
 * The files a project server runs when a pulled commit can change them:
 * every path from mcpServerFileArguments that names an existing file in the
 * project, so `node --require ./a.cjs ./s.mjs` binds both files and an
 * outside file before the script (`--env-file /etc/os-release`) does not end
 * the scan. A path spelled inside the project binds where it resolves, since
 * the commit controls any symlink on the way; a dangling link there is an
 * error. A file both spelled and resolved outside the project root is the
 * operator's own and is not bound. Imports of a bound file are not followed.
 */
function projectEntryScripts(
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	root: string,
): McpServerEntryScript[] {
	const candidate = (target: string): McpServerEntryScript | "absent" | "outside" => {
		const spelledInside = isStrictDescendant(target, root);
		let real: string;
		try {
			if (!statSync(target).isFile()) return "absent";
			real = realpathSync(target);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG" || code === "ELOOP") {
				const dangling = spelledInside ? danglingLinkOn(root, target) : undefined;
				if (dangling === undefined) return "absent";
				return { path: path.relative(root, target), error: `dangling symlink '${dangling}'` };
			}
			// Present but unstatable, e.g. a directory without search permission: fail closed if it sits in the project.
			if (!spelledInside) return "outside";
			return { path: path.relative(root, target), error: error instanceof Error ? error.message : String(error) };
		}
		const realInside = isStrictDescendant(real, root);
		if (!realInside && !spelledInside) return "outside";
		if (!realInside) return { path: path.relative(root, target), realPath: real };
		const relative = path.relative(root, real);
		const spelled = spelledInside ? path.relative(root, target) : relative;
		const linked = spelled !== relative ? { realPath: relative } : {};
		const digest = sha256OfRegularFile(real);
		return digest instanceof Error
			? { path: spelled, ...linked, error: digest.message }
			: { path: spelled, ...linked, sha256: digest };
	};
	const bound = new Map<string, McpServerEntryScript>();
	for (const target of mcpServerFileArguments(command, args, cwd)) {
		const entry = candidate(target);
		if (typeof entry === "string" || bound.has(entry.path)) continue;
		bound.set(entry.path, entry);
	}
	return [...bound.values()];
}

function validateToolPathArguments(value: unknown, location: string): McpToolPathArguments | Error {
	const declared = Object.create(null) as McpToolPathArguments;
	if (value === undefined) return declared;
	if (!isRecord(value)) return new Error(`${location} must be a mapping`);
	const tools = Object.entries(value);
	if (tools.length > MCP_CONFIG_CAPS.toolPathArguments) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.toolPathArguments}-entry cap`);
	}
	for (const [tool, args] of tools) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(tool)) return new Error(`${location} has invalid tool name '${tool}'`);
		if (!isRecord(args)) return new Error(`${location}.${tool} must be a mapping of argument names to read or write`);
		const entries = Object.entries(args);
		if (entries.length > MCP_CONFIG_CAPS.pathArgumentsPerTool) {
			return new Error(`${location}.${tool} exceeds the ${MCP_CONFIG_CAPS.pathArgumentsPerTool}-entry cap`);
		}
		const accesses = Object.create(null) as Record<string, McpPathArgumentAccess>;
		for (const [argument, access] of entries) {
			if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(argument)) {
				return new Error(`${location}.${tool} has invalid argument name '${argument}'`);
			}
			if (access !== "read" && access !== "write")
				return new Error(`${location}.${tool}.${argument} must be read or write`);
			accesses[argument] = access;
		}
		if (entries.length > 0) declared[tool] = accesses;
	}
	return declared;
}

/** A remote server's sign-in settings; see McpOAuthSettings. */
function validateOAuth(value: unknown, location: string): McpOAuthSettings | Error {
	if (!isRecord(value)) return new Error(`${location} must be a mapping`);
	const unknown = unknownFields(value, OAUTH_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	const settings: McpOAuthSettings = {};
	if (value.issuer !== undefined) {
		if (typeof value.issuer !== "string" || utf8Bytes(value.issuer) > MCP_CONFIG_CAPS.urlBytes) {
			return new Error(`${location}.issuer must be the authorization server's issuer URL`);
		}
		const endpoint = mcpRemoteEndpoint(value.issuer);
		if (typeof endpoint === "string" || endpoint.search !== "") {
			return new Error(`${location}.issuer ${typeof endpoint === "string" ? endpoint : "must not carry a query"}`);
		}
		settings.issuer = value.issuer;
	}
	if (value.clientId !== undefined) {
		if (typeof value.clientId !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(value.clientId)) {
			return new Error(`${location}.clientId must be 1 to 256 visible ASCII characters`);
		}
		if (settings.issuer === undefined) {
			return new Error(
				`${location}.clientId needs ${location}.issuer: a registered client belongs to one authorization server`,
			);
		}
		settings.clientId = value.clientId;
	}
	if (value.scopes !== undefined) {
		if (
			!Array.isArray(value.scopes) ||
			value.scopes.length > 64 ||
			!value.scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u.test(scope))
		) {
			return new Error(`${location}.scopes must be a list of at most 64 OAuth scope tokens`);
		}
		settings.scopes = [...new Set(value.scopes as string[])];
	}
	if (value.redirectPort !== undefined) {
		if (
			typeof value.redirectPort !== "number" ||
			!Number.isInteger(value.redirectPort) ||
			value.redirectPort < 1024 ||
			value.redirectPort > 65535
		) {
			return new Error(`${location}.redirectPort must be a port from 1024 to 65535`);
		}
		settings.redirectPort = value.redirectPort;
	}
	return settings;
}

/** A remote server's endpoint and the credential each header it sends is read from. */
function validateEndpoint(
	url: unknown,
	headers: unknown,
	location: string,
	oauth?: unknown,
): { url: string; headers: Record<string, string>; oauth?: McpOAuthSettings } | Error {
	if (typeof url !== "string" || url.length === 0) return new Error(`${location}.url must be a non-empty string`);
	if (utf8Bytes(url) > MCP_CONFIG_CAPS.urlBytes) {
		return new Error(`${location}.url exceeds the ${MCP_CONFIG_CAPS.urlBytes}-byte cap`);
	}
	const endpoint = mcpRemoteEndpoint(url);
	if (typeof endpoint === "string") return new Error(`${location}.url ${endpoint}`);
	const declared = Object.create(null) as Record<string, string>;
	if (headers !== undefined) {
		if (!isRecord(headers)) return new Error(`${location}.headers must map header names to credential keys`);
		const entries = Object.entries(headers);
		if (entries.length > MCP_CONFIG_CAPS.headers) {
			return new Error(`${location}.headers exceeds the ${MCP_CONFIG_CAPS.headers}-entry cap`);
		}
		const seen = new Set<string>();
		for (const [name, key] of entries) {
			const refused = mcpDeclaredHeaderRefusal(name);
			if (refused !== null) return new Error(`${location}.headers: '${name}' ${refused}`);
			if (seen.has(name.toLowerCase())) return new Error(`${location}.headers names '${name}' twice`);
			seen.add(name.toLowerCase());
			if (typeof key !== "string") {
				return new Error(`${location}.headers.${name} must name a stored credential key`);
			}
			const keyRefused = mcpCredentialKeyRefusal(key);
			if (keyRefused !== null) {
				return new Error(
					`${location}.headers.${name} names a credential key, which ${keyRefused}; the value itself is stored with pancode mcp login, never written here`,
				);
			}
			declared[name] = key;
		}
	}
	if (oauth === undefined) return { url: endpoint.href, headers: declared };
	if (Object.keys(declared).length > 0) {
		return new Error(`${location}.oauth cannot apply: a server that sends headers never signs in with OAuth`);
	}
	const settings = validateOAuth(oauth, `${location}.oauth`);
	if (settings instanceof Error) return settings;
	return { url: endpoint.href, headers: declared, oauth: settings };
}

function validateServer(
	value: unknown,
	location: string,
	scope: McpServerScope,
):
	| {
			fields: DeclaredServerFields;
			declaredCwd: string | null;
			network: boolean;
			networkIgnored: boolean;
			fileTargets: string[];
			fileTargetsIgnored: boolean;
	  }
	| Error {
	if (!isRecord(value)) return new Error(`${location} must be an object`);
	const unknown = unknownFields(value, SERVER_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	const remote = Object.hasOwn(value, "url");
	if (!Object.hasOwn(value, "id")) return new Error(`${location}.id is required`);
	if (!remote && !Object.hasOwn(value, "command")) return new Error(`${location} needs a command or a url`);
	const id = validateId(value.id, `${location}.id`);
	if (id instanceof Error) return id;
	let launch: { command: string; args: string[]; env: Record<string, string> } | null = null;
	let endpoint: { url: string; headers: Record<string, string>; oauth?: McpOAuthSettings } | null = null;
	if (remote) {
		const local = ["command", "args", "cwd", "env"].filter((field) => Object.hasOwn(value, field));
		if (local.length > 0) {
			return new Error(`${location} names a url, so ${local.join(", ")} cannot apply; a remote server is not started`);
		}
		const validated = validateEndpoint(value.url, value.headers, location, value.oauth);
		if (validated instanceof Error) return validated;
		endpoint = validated;
	} else {
		if (Object.hasOwn(value, "headers")) return new Error(`${location}.headers applies only to a server with a url`);
		if (Object.hasOwn(value, "oauth")) return new Error(`${location}.oauth applies only to a server with a url`);
		const command = validateCommand(value.command, `${location}.command`);
		if (command instanceof Error) return command;
		const args = validateArgs(value.args, `${location}.args`);
		if (args instanceof Error) return args;
		const env = validateEnv(value.env, `${location}.env`);
		if (env instanceof Error) return env;
		launch = { command, args, env };
	}
	const timeoutMs = validateTimeout(value.timeoutMs, `${location}.timeoutMs`);
	if (timeoutMs instanceof Error) return timeoutMs;
	if (scope !== "user" && value.actionClass !== undefined) {
		return new Error(`${location}.actionClass is only allowed in user config; use the project trust record`);
	}
	if (
		value.actionClass !== undefined &&
		value.actionClass !== "read" &&
		value.actionClass !== "execute" &&
		value.actionClass !== "destructive" &&
		value.actionClass !== "unknown"
	) {
		return new Error(`${location}.actionClass must be read, execute, destructive, or unknown`);
	}
	const actionClass = (value.actionClass ?? "unknown") as "read" | "execute" | "destructive" | "unknown";
	const toolActionClasses = Object.create(null) as Record<string, "read" | "execute" | "destructive" | "unknown">;
	if (value.toolActionClasses !== undefined) {
		if (!isRecord(value.toolActionClasses)) return new Error(`${location}.toolActionClasses must be a mapping`);
		const entries = Object.entries(value.toolActionClasses);
		if (entries.length > MCP_CONFIG_CAPS.toolActionClasses) {
			return new Error(`${location}.toolActionClasses exceeds the ${MCP_CONFIG_CAPS.toolActionClasses}-entry cap`);
		}
		for (const [name, cls] of entries) {
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) {
				return new Error(`${location}.toolActionClasses has invalid tool name '${name}'`);
			}
			if (cls !== "read" && cls !== "execute" && cls !== "destructive" && cls !== "unknown") {
				return new Error(`${location}.toolActionClasses.${name} must be read, execute, destructive, or unknown`);
			}
			toolActionClasses[name] = cls;
		}
	}
	const toolPathArguments = validateToolPathArguments(value.toolPathArguments, `${location}.toolPathArguments`);
	if (toolPathArguments instanceof Error) return toolPathArguments;
	const contradiction = mcpWritePathOnReadTool(
		{ toolActionClasses, toolPathArguments },
		scope === "user" ? actionClass : "unknown",
	);
	if (contradiction !== null) {
		return new Error(
			`${location}.toolPathArguments.${contradiction.tool}.${contradiction.argument} is write, but tool ${contradiction.tool} is classed read; a read tool writes nothing`,
		);
	}
	let declaredCwd: string | null = null;
	if (value.cwd !== undefined) {
		if (typeof value.cwd !== "string") return new Error(`${location}.cwd must be a string`);
		declaredCwd = value.cwd;
	}
	if (value.network !== undefined && typeof value.network !== "boolean") {
		return new Error(`${location}.network must be true or false`);
	}
	const fileTargets = validateFileTargets(value.fileTargets, `${location}.fileTargets`);
	if (fileTargets instanceof Error) return fileTargets;
	const shared = { id, timeoutMs, actionClass, toolActionClasses, toolPathArguments };
	return {
		fields:
			endpoint !== null
				? { ...endpoint, ...shared }
				: { ...(launch as NonNullable<typeof launch>), cwd: declaredCwd, ...shared },
		declaredCwd,
		network: scope === "user" && value.network === true,
		networkIgnored: scope !== "user" && value.network !== undefined,
		fileTargets: scope === "user" ? fileTargets : [],
		fileTargetsIgnored: scope !== "user" && value.fileTargets !== undefined,
	};
}

export interface McpConfigTextInput {
	scope: McpServerScope;
	/** The config file path, for diagnostics and declarations. */
	path: string;
	/** Root that relative cwd values resolve against: the project root or the config directory. */
	root: string;
}

/** Parse one config file's text through the strict schema. Exported for tests and the CLI. */
export function parseMcpConfigText(text: string, input: McpConfigTextInput): McpConfigLoadResult {
	const diagnostic = (message: string): McpConfigLoadResult => ({
		servers: [],
		diagnostics: [{ scope: input.scope, path: input.path, message }],
	});
	if (utf8Bytes(text) > MCP_CONFIG_CAPS.fileBytes) {
		return diagnostic(`file exceeds the ${MCP_CONFIG_CAPS.fileBytes}-byte cap`);
	}
	const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) {
		return diagnostic(`invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	let parsed: unknown;
	try {
		parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
	} catch (error) {
		return diagnostic(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) return diagnostic("root must be an object with version and servers fields");
	const rootUnknown = unknownFields(parsed, ROOT_FIELDS);
	if (rootUnknown.length > 0) return diagnostic(`root has unknown field(s): ${rootUnknown.join(", ")}`);
	if (!Object.hasOwn(parsed, "version")) return diagnostic("root.version is required");
	if (parsed.version !== MCP_CONFIG_VERSION) {
		return diagnostic(
			`unsupported version ${JSON.stringify(parsed.version)}; supported version is ${MCP_CONFIG_VERSION}`,
		);
	}
	if (!Object.hasOwn(parsed, "servers")) return diagnostic("root.servers is required");
	if (!Array.isArray(parsed.servers)) return diagnostic("root.servers must be an array");
	if (parsed.servers.length > MCP_CONFIG_CAPS.servers) {
		return diagnostic(`root.servers exceeds the ${MCP_CONFIG_CAPS.servers}-server cap`);
	}
	const servers: McpServerDeclaration[] = [];
	const notes: McpConfigDiagnostic[] = [];
	const ids = new Map<string, number>();
	for (const [index, value] of parsed.servers.entries()) {
		const location = `servers[${index}]`;
		const validated = validateServer(value, location, input.scope);
		if (validated instanceof Error) return diagnostic(validated.message);
		const { fields, declaredCwd } = validated;
		if (validated.networkIgnored) {
			notes.push({
				scope: input.scope,
				path: input.path,
				message: networkIgnoredMessage(`${location}.network`, fields.id),
				severity: "warning",
			});
		}
		if (validated.fileTargetsIgnored) {
			notes.push({
				scope: input.scope,
				path: input.path,
				message: fileTargetsIgnoredMessage(`${location}.fileTargets`),
				severity: "warning",
			});
		}
		const duplicateIndex = ids.get(fields.id);
		if (duplicateIndex !== undefined) {
			return diagnostic(`${location}.id duplicates '${fields.id}' from servers[${duplicateIndex}].id`);
		}
		const resolved = resolveCwd(declaredCwd, input.scope, input.root, `${location}.cwd`);
		if (resolved instanceof Error) return diagnostic(resolved.message);
		ids.set(fields.id, index);
		const shared = {
			id: fields.id,
			scope: input.scope,
			path: input.path,
			cwd: resolved.cwd,
			cwdRoot: resolved.cwdRoot,
			timeoutMs: fields.timeoutMs,
			actionClass: fields.actionClass,
			actionClassExplicit: Object.hasOwn(value, "actionClass"),
			toolActionClasses: fields.toolActionClasses,
			...(Object.keys(fields.toolPathArguments).length > 0 ? { toolPathArguments: fields.toolPathArguments } : {}),
			...(validated.network ? { network: true as const } : {}),
			...(validated.fileTargets.length > 0 ? { fileTargets: validated.fileTargets } : {}),
		};
		if ("url" in fields) {
			servers.push({
				...shared,
				url: fields.url,
				headers: fields.headers,
				...(fields.oauth !== undefined ? { oauth: fields.oauth } : {}),
				digest: mcpServerDigest(fields),
			});
			continue;
		}
		const entryScripts =
			input.scope === "project" ? projectEntryScripts(fields.command, fields.args, resolved.cwd, resolved.cwdRoot) : [];
		servers.push({
			...shared,
			command: fields.command,
			args: fields.args,
			env: fields.env,
			digest: mcpServerDigest({ ...fields, entryScripts }),
			...(entryScripts.length > 0 ? { digestWithoutEntryScript: mcpServerDigest(fields) } : {}),
			...(entryScripts.length > 0 ? { entryScripts } : {}),
		});
	}
	return { servers, diagnostics: notes };
}

type BoundedFileRead =
	| { ok: true; text: string }
	| { ok: false; reason: "missing" | "oversized" | "unreadable"; message: string };

/**
 * Read a regular file of at most `maxBytes` as UTF-8. The read stops one byte
 * past the cap, so a file that is (or grows) larger than the cap never lands
 * in memory whole; a FIFO or directory at the path is refused without
 * blocking on it. Shared by the config and trust loaders.
 */
export function readBoundedFileText(filePath: string, maxBytes: number): BoundedFileRead {
	const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, reason: "missing", message: "file does not exist" };
		}
		return { ok: false, reason: "unreadable", message: `cannot read (${describe(error)})` };
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) return { ok: false, reason: "unreadable", message: "path must be a regular file" };
		let buffer = Buffer.allocUnsafe(Math.min(Math.max(stats.size, 0), maxBytes) + 1);
		let total = 0;
		for (;;) {
			if (total === buffer.length) {
				if (total > maxBytes) break;
				// The file grew past its stat size; one growth to the cap settles whether it fits.
				buffer = Buffer.concat([buffer], maxBytes + 1);
			}
			const read = readSync(fd, buffer, total, buffer.length - total, null);
			if (read === 0) break;
			total += read;
		}
		if (total > maxBytes) return { ok: false, reason: "oversized", message: `file exceeds the ${maxBytes}-byte cap` };
		return { ok: true, text: buffer.toString("utf8", 0, total) };
	} catch (error) {
		return { ok: false, reason: "unreadable", message: `cannot read (${describe(error)})` };
	} finally {
		closeSync(fd);
	}
}

function loadFile(filePath: string, scope: McpServerScope, root: string): McpConfigLoadResult {
	const read = readBoundedFileText(filePath, MCP_CONFIG_CAPS.fileBytes);
	if (!read.ok) {
		if (read.reason === "missing") return { servers: [], diagnostics: [] };
		return { servers: [], diagnostics: [{ scope, path: filePath, message: read.message }] };
	}
	return parseMcpConfigText(read.text, { scope, path: filePath, root });
}

/**
 * One plugin's `mcp.json`, in the Agent Plugins shape
 * `{"mcpServers": {"<id>": {"type": "stdio", "command", "args", "env"}}}`.
 * A server may add PanCode's `toolActionClasses` and `toolPathArguments`; the
 * declaration digest covers them, so the operator's trust names what it approved.
 * Each server keeps the id it declares and runs in the plugin root unless its
 * cwd names another directory there or in the plugin's data directory.
 * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in args, env values and cwd,
 * never in command, and the process gets both as environment variables; the
 * digest covers the text as written, so it does not depend on where the
 * plugin is installed. A server of type `http` (or `streamable-http`) is reached at its `url`, and its
 * `headers` name stored credential keys as in mcp.yaml. The 2024 HTTP+SSE
 * transport (`sse`) and any other type are reported and skipped; a malformed
 * file contributes nothing (fail closed).
 */
export function loadPluginMcpFile(plugin: {
	id: string;
	scope: "user" | "project";
	rootPath: string;
	contentDigest: string;
	core?: boolean;
}): McpConfigLoadResult {
	const filePath = path.join(plugin.rootPath, MCP_PLUGIN_CONFIG_FILENAME);
	const dataDir = pluginDataDir(plugin.scope, plugin.rootPath);
	const diagnostic = (message: string): McpConfigDiagnostic => ({ scope: "plugin", path: filePath, message });
	const read = readBoundedFileText(filePath, MCP_CONFIG_CAPS.fileBytes);
	if (!read.ok) return { servers: [], diagnostics: read.reason === "missing" ? [] : [diagnostic(read.message)] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text) as unknown;
	} catch (error) {
		return {
			servers: [],
			diagnostics: [diagnostic(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)],
		};
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers))
		return { servers: [], diagnostics: [diagnostic("root must be an object with an mcpServers mapping")] };
	const rootUnknown = unknownFields(parsed, PLUGIN_ROOT_FIELDS);
	if (rootUnknown.length > 0)
		return { servers: [], diagnostics: [diagnostic(`root has unknown field(s): ${rootUnknown.join(", ")}`)] };
	const entries = Object.entries(parsed.mcpServers);
	if (entries.length > MCP_CONFIG_CAPS.servers)
		return { servers: [], diagnostics: [diagnostic(`mcpServers exceeds the ${MCP_CONFIG_CAPS.servers}-server cap`)] };
	const servers: McpServerDeclaration[] = [];
	const diagnostics: McpConfigDiagnostic[] = [];
	for (const [id, value] of entries) {
		const location = `mcpServers.${id}`;
		if (!isRecord(value)) return { servers: [], diagnostics: [diagnostic(`${location} must be an object`)] };
		if (value.type === "sse") {
			diagnostics.push(
				diagnostic(
					`${location} uses transport "sse", the 2024 HTTP+SSE transport PanCode does not speak; a remote server must offer Streamable HTTP (type "http")`,
				),
			);
			continue;
		}
		const httpType = value.type === "http" || value.type === "streamable-http";
		if (value.type !== undefined && value.type !== "stdio" && !httpType) {
			diagnostics.push(
				diagnostic(
					`${location} uses transport ${JSON.stringify(value.type)}; PanCode speaks stdio and Streamable HTTP (type "http")`,
				),
			);
			continue;
		}
		if (httpType !== Object.hasOwn(value, "url")) {
			return {
				servers: [],
				diagnostics: [
					diagnostic(httpType ? `${location} is type ${value.type} but names no url` : `${location}.url needs type "http"`),
				],
			};
		}
		const unknown = unknownFields(value, PLUGIN_SERVER_FIELDS);
		if (unknown.length > 0)
			return { servers: [], diagnostics: [diagnostic(`${location} has unknown field(s): ${unknown.join(", ")}`)] };
		const { type: _type, ...declared } = value;
		const validated = validateServer({ id, ...declared }, location, "plugin");
		if (validated instanceof Error) return { servers: [], diagnostics: [diagnostic(validated.message)] };
		const { fields, declaredCwd } = validated;
		if (validated.networkIgnored) {
			diagnostics.push({ ...diagnostic(networkIgnoredMessage(`${location}.network`, fields.id)), severity: "warning" });
		}
		if (validated.fileTargetsIgnored) {
			diagnostics.push({ ...diagnostic(fileTargetsIgnoredMessage(`${location}.fileTargets`)), severity: "warning" });
		}
		const reserved = "env" in fields ? Object.keys(fields.env).find((key) => PLUGIN_ENV_KEYS.has(key)) : undefined;
		if (reserved !== undefined)
			return {
				servers: [],
				diagnostics: [diagnostic(`${location}.env.${reserved} is set by PanCode for every plugin server; remove it`)],
			};
		const resolved = resolvePluginCwd(declaredCwd, plugin.rootPath, dataDir, `${location}.cwd`);
		if (resolved instanceof Error) return { servers: [], diagnostics: [diagnostic(resolved.message)] };
		const shared = {
			id: fields.id,
			scope: "plugin" as const,
			path: filePath,
			cwd: resolved.cwd,
			cwdRoot: resolved.cwdRoot,
			timeoutMs: fields.timeoutMs,
			actionClass: fields.actionClass,
			actionClassExplicit: false,
			toolActionClasses: fields.toolActionClasses,
			...(Object.keys(fields.toolPathArguments).length > 0 ? { toolPathArguments: fields.toolPathArguments } : {}),
			digest: mcpServerDigest({ ...fields, pluginContentDigest: plugin.contentDigest }),
			plugin: {
				id: plugin.id,
				scope: plugin.scope,
				contentDigest: plugin.contentDigest,
				dataDir,
				...(plugin.core === true ? { core: true as const } : {}),
			},
		};
		const expand = (value: string): string => expandPluginVariables(value, plugin.rootPath, dataDir);
		servers.push(
			"url" in fields
				? { ...shared, url: fields.url, headers: fields.headers }
				: {
						...shared,
						command: fields.command,
						args: fields.args.map(expand),
						env: {
							...Object.fromEntries(Object.entries(fields.env).map(([key, value]) => [key, expand(value)])),
							PLUGIN_ROOT: plugin.rootPath,
							PLUGIN_DATA: dataDir,
						},
					},
		);
	}
	return { servers, diagnostics };
}

function trustProjectImports(): boolean {
	try {
		return readSettings().integrations.projectResources.trustProjectImports;
	} catch {
		// Unreadable settings leave foreign packages untrusted, as every other resource loader does.
		return false;
	}
}

function foreignPluginMessage(id: string): string {
	return `foreign package ${id} declares no MCP servers until integrations.projectResources.trustProjectImports is on`;
}

/**
 * Why a plugin-scope declaration resolved earlier in this session no longer
 * stands, or null while its plugin still loads the content it was declared
 * from. A session snapshots its declarations, so the launcher asks this before
 * every launch and call: a plugin disabled, removed or changed mid-session
 * must stop serving then, not at the next restart.
 */
export function pluginServerRevocation(plugin: McpServerPlugin, cwd: string): string | null {
	let installed: ReturnType<typeof listInstalledPlugins>;
	try {
		// A full listing would hash every installed plugin tree on every call.
		installed = listInstalledPlugins(cwd, { id: plugin.id });
	} catch (error) {
		return `installed plugins cannot be read: ${error instanceof Error ? error.message : String(error)}`;
	}
	const item = installed.find((entry) => entry.id === plugin.id && entry.scope === plugin.scope);
	if (item === undefined) return `plugin ${plugin.id} is no longer installed in ${plugin.scope} scope`;
	if (!item.enabled) return `plugin ${plugin.id} is disabled`;
	if (!item.loadable || item.provenance === undefined) return `plugin ${plugin.id} no longer loads`;
	if (item.provenance.contentDigest !== plugin.contentDigest)
		return `plugin ${plugin.id} changed since this session declared its servers; restart the session to review it`;
	if (item.trust === "foreign" && !trustProjectImports()) return foreignPluginMessage(item.id);
	return null;
}

/**
 * Declarations from every installed plugin that would load its content: valid,
 * unchanged since install, enabled, effective, for a project copy in a
 * workspace whose plugins the operator trusted, and for a foreign package only
 * while trustProjectImports is on, as for its other resources.
 */
function loadPluginServers(cwd: string): McpConfigLoadResult {
	const servers: McpServerDeclaration[] = [];
	const diagnostics: McpConfigDiagnostic[] = [];
	let installed: ReturnType<typeof listInstalledPlugins>;
	try {
		installed = listInstalledPlugins(cwd);
	} catch (error) {
		return {
			servers,
			diagnostics: [
				{
					scope: "plugin",
					path: cwd,
					message: `installed plugins cannot be read: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
	const trustImports = trustProjectImports();
	let corePins: Map<string, string> | undefined;
	// Read the shipped index only for a copy that could match one of its rows.
	const corePin = (name: string): string | undefined => {
		corePins ??= new Map(
			bundledPluginCatalog([])
				.filter((row) => row.kind === "plugin" && row.tier === "core" && row.sha256 !== undefined)
				.map((row) => [row.name, row.sha256 as string]),
		);
		return corePins.get(name);
	};
	for (const item of installed) {
		if (!item.loadable || item.provenance === undefined) continue;
		if (item.trust === "foreign" && !trustImports) {
			// Only a package that ships an mcp.json has a server to skip; a note for
			// every other foreign package would fail `mcp list` on nothing.
			const filePath = path.join(item.provenance.canonicalRoot, MCP_PLUGIN_CONFIG_FILENAME);
			if (existsSync(filePath))
				diagnostics.push({ scope: "plugin", path: filePath, message: foreignPluginMessage(item.id) });
			continue;
		}
		const loaded = loadPluginMcpFile({
			id: item.id,
			scope: item.scope,
			rootPath: item.provenance.canonicalRoot,
			contentDigest: item.provenance.contentDigest,
			core:
				item.kind === "plugin" &&
				item.trust === "trusted" &&
				typeof item.origin === "object" &&
				item.origin.kind === "catalog" &&
				corePin(item.id) === item.provenance.contentDigest,
		});
		servers.push(...loaded.servers);
		diagnostics.push(...loaded.diagnostics);
	}
	return { servers, diagnostics };
}

/**
 * Load every scope. A user declaration wins an id collision, then a builtin
 * server PanCode ships, then a project declaration, then the first plugin by
 * id; the loser is dropped with a diagnostic so nobody wonders why its command
 * never runs. The operator may prefer their own server to a builtin one, so
 * that diagnostic is a warning; a repository may not take a builtin id. A
 * malformed file contributes nothing (fail closed).
 */
export function loadMcpServerConfig(options: McpConfigLoadOptions): McpConfigLoadResult {
	const paths = mcpConfigPaths(options);
	const configDir = options.configDir ?? pancodeConfigDir();
	const user = loadFile(paths.user, "user", configDir);
	const source = options.builtin ?? defaultMcpBuiltinSource();
	const builtin = loadMcpBuiltinServers(options.cwd, source);
	const project = loadFile(paths.project, "project", mcpProjectRoot(options.cwd));
	const servers = [...user.servers];
	const diagnostics = [...user.diagnostics, ...builtin.diagnostics, ...project.diagnostics];
	const userIds = new Set(user.servers.map((server) => server.id));
	const builtinIds = new Set<string>();
	for (const server of builtin.servers) {
		if (userIds.has(server.id)) {
			diagnostics.push({
				scope: "builtin",
				path: server.path,
				message: `builtin server '${server.id}' that PanCode ships in ${server.path} is overridden by the user declaration in ${paths.user}`,
				severity: "warning",
			});
			continue;
		}
		builtinIds.add(server.id);
		servers.push(server);
	}
	for (const server of project.servers) {
		if (builtinIds.has(server.id)) {
			diagnostics.push({
				scope: "project",
				path: server.path,
				message: `server '${server.id}' is shadowed by the builtin server PanCode ships in ${source.manifestPath}; a project cannot take a builtin server's id`,
			});
			continue;
		}
		if (userIds.has(server.id)) {
			diagnostics.push({
				scope: "project",
				path: server.path,
				message: `server '${server.id}' is shadowed by the user declaration in ${paths.user}`,
			});
			continue;
		}
		servers.push(server);
	}
	const plugins = loadPluginServers(options.cwd);
	diagnostics.push(...plugins.diagnostics);
	const taken = new Map(servers.map((server) => [server.id, server.path]));
	for (const server of plugins.servers) {
		const winner = taken.get(server.id);
		if (winner !== undefined) {
			diagnostics.push({
				scope: "plugin",
				path: server.path,
				message: builtinIds.has(server.id)
					? `server '${server.id}' from plugin ${server.plugin?.id ?? "?"} is shadowed by the builtin server PanCode ships in ${winner}; a plugin cannot take a builtin server's id`
					: `server '${server.id}' from plugin ${server.plugin?.id ?? "?"} is shadowed by the declaration in ${winner}`,
			});
			continue;
		}
		taken.set(server.id, server.path);
		servers.push(server);
	}
	return { servers, diagnostics };
}
