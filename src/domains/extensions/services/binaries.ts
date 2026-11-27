// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pinned programs an extension declares, the host half.
 *
 * A declared binary is downloaded and verified at install, after the operator
 * approved the envelope that names it, and run by the host outside the
 * runtime's sandbox: a program such as cliamp is controlled over a Unix socket,
 * which the sandbox refuses. The runtime never gets a path to exec. It asks the
 * host to run a binary it declared, with arguments and only the environment keys
 * it declared, and the host answers with the exit code and bounded output.
 */
import { existsSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExtensionBinaryDeclaration } from "@pancode/sdk/pack";
import { runCommandVector } from "../../../core/safe-exec.js";
import {
	describeResolution,
	installPinnedTool,
	type PinnedTool,
	type PinnedToolDownload,
	resolveEntryBinary,
	type ToolFetcher,
	type ToolInstallResult,
	type ToolPlatform,
	type ToolResolution,
	toolchainRoot,
	toolStatus,
} from "../../toolchain/index.js";

/** A call's arguments, environment and output stay small: this is a control channel, not a shell. */
export const BINARY_RUN_LIMITS = Object.freeze({
	args: 64,
	argBytes: 4096,
	envValueBytes: 4096,
	outputBytes: 64 * 1024,
	timeoutMsMax: 10_000,
	timeoutMsDefault: 5_000,
});

/** Where an extension's vendored binaries live: `<data>/tools/ext/<id>/`. */
function packBinaryRoot(extensionId: string, root: string = toolchainRoot()): string {
	return path.join(root, "ext", extensionId);
}

/** The toolchain row a declaration stands for, so install and the resolution ladder are the ones `pancode tools` uses. */
function packBinaryTool(extensionId: string, binary: ExtensionBinaryDeclaration): PinnedTool {
	const downloads: Partial<Record<ToolPlatform, PinnedToolDownload>> = {};
	for (const [platform, asset] of Object.entries(binary.downloads)) {
		if (!asset) continue;
		downloads[platform as ToolPlatform] = {
			url: asset.url,
			sha256: asset.sha256,
			archive: asset.archive,
			binaryMembers: { [binary.name]: asset.member ?? "" },
			documentMembers: [],
		};
	}
	return {
		id: path.posix.join("ext", extensionId, binary.name),
		version: binary.version,
		summary: `${binary.name} for the ${extensionId} extension`,
		homepage: binary.homepage,
		license: binary.license,
		binaries: [binary.name],
		primaryBinary: binary.name,
		minimumVersion: binary.minimumVersion,
		versionArgs: binary.versionArgs,
		downloads,
		documents: binary.documents,
	};
}

export interface PackBinaryInstallOptions {
	root?: string;
	fetch?: ToolFetcher;
	mirror?: string | null;
	onProgress?: (message: string) => void;
}

/**
 * Download and verify every binary the package declares. Each lands in its own
 * version directory and a pin bump prunes the old one. Runs after the envelope
 * was approved, never before.
 */
export async function installPackBinaries(
	extensionId: string,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
	options: PackBinaryInstallOptions = {},
): Promise<ToolInstallResult[]> {
	const results: ToolInstallResult[] = [];
	for (const binary of binaries)
		results.push(
			await installPinnedTool(packBinaryTool(extensionId, binary), {
				...(options.root !== undefined ? { root: options.root } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
				...(options.mirror !== undefined ? { mirror: options.mirror } : {}),
				...(options.onProgress ? { onProgress: options.onProgress } : {}),
			}),
		);
	return results;
}

/** Delete every vendored binary of an extension. Nothing installed is success. */
export function removePackBinaries(extensionId: string, root: string = toolchainRoot()): void {
	const dir = packBinaryRoot(extensionId, root);
	if (!existsSync(dir)) return;
	rmSync(dir, { recursive: true, force: true });
	try {
		rmdirSync(path.dirname(dir));
	} catch {
		// Another extension still holds binaries under `ext/`.
	}
}

/** Where a declared binary resolves: a PATH copy at or above the floor, else the vendored pin. */
export function resolvePackBinary(extensionId: string, binary: ExtensionBinaryDeclaration): ToolResolution {
	return resolveEntryBinary(packBinaryTool(extensionId, binary), binary.name);
}

/** The binary's path, or one sentence on why it has none, naming what fixes it. */
export function packBinaryPath(
	extensionId: string,
	binary: ExtensionBinaryDeclaration,
): { path: string } | { reason: string } {
	const resolution = resolvePackBinary(extensionId, binary);
	if (resolution.binaryPath !== null) return { path: resolution.binaryPath };
	// The toolchain's remedy names `pancode tools install <id>`, which has no row for a pack binary.
	const found = describeResolution(toolStatus(packBinaryTool(extensionId, binary))).replace(
		/\s*\(update with `[^`]*`\)$/u,
		"",
	);
	return {
		reason: `${binary.name} ${found}; reinstall the extension (pancode hub install extension:${extensionId}) or put ${binary.name} ${binary.minimumVersion} or newer on PATH`,
	};
}

/** Keys a call may never set, whatever the manifest declares: they steer the loader, the shell or PanCode itself. */
const RESERVED_ENV = /^(?:PANCODE_|LD_|DYLD_|NODE_|npm_)|^(?:PATH|HOME|SHELL|ENV|BASH_ENV|IFS|PS4|TMPDIR)$/u;

function reservedBinaryEnvKey(key: string): boolean {
	return RESERVED_ENV.test(key);
}

export interface PackBinaryRunRequest {
	name: string;
	args: string[];
	env: Record<string, string>;
	timeoutMs: number;
}

/** Checks one `ctx.binaries.run` request against the declaration; throws the operator-readable reason. */
export function parsePackBinaryRun(
	value: unknown,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
): PackBinaryRunRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid binary request");
	const raw = value as Record<string, unknown>;
	const binary = binaries.find((entry) => entry.name === raw.name);
	if (!binary) throw new Error(`binary '${String(raw.name)}' is not declared`);
	return {
		name: binary.name,
		args: parseBinaryArgs(raw.args),
		env: parseBinaryEnv(raw.env, binary),
		timeoutMs: parseTimeout(raw.timeoutMs),
	};
}

export function parseBinaryArgs(value: unknown): string[] {
	const args = value ?? [];
	if (!Array.isArray(args) || args.length > BINARY_RUN_LIMITS.args)
		throw new Error(`binary arguments must be a list of at most ${BINARY_RUN_LIMITS.args} strings`);
	for (const arg of args)
		if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > BINARY_RUN_LIMITS.argBytes)
			throw new Error(`each binary argument must be text of at most ${BINARY_RUN_LIMITS.argBytes} bytes`);
	return args as string[];
}

export function parseBinaryEnv(value: unknown, binary: ExtensionBinaryDeclaration): Record<string, string> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("binary environment must be an object");
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!binary.env.includes(key) || reservedBinaryEnvKey(key))
			throw new Error(`${binary.name} does not declare the environment key ${key}`);
		if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > BINARY_RUN_LIMITS.envValueBytes)
			throw new Error(`environment value ${key} must be text of at most ${BINARY_RUN_LIMITS.envValueBytes} bytes`);
		env[key] = entry;
	}
	return env;
}

function parseTimeout(value: unknown): number {
	if (value === undefined) return BINARY_RUN_LIMITS.timeoutMsDefault;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > BINARY_RUN_LIMITS.timeoutMsMax)
		throw new Error(`binary timeoutMs must be a whole number from 1 to ${BINARY_RUN_LIMITS.timeoutMsMax}`);
	return value;
}

export interface PackBinaryRunResult {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

function capText(text: string): string {
	return Buffer.byteLength(text) > BINARY_RUN_LIMITS.outputBytes
		? Buffer.from(text).subarray(0, BINARY_RUN_LIMITS.outputBytes).toString("utf8")
		: text;
}

/**
 * Runs a declared binary once, in the extension's store directory, with the
 * host's safe tool environment plus the declared keys. No shell is involved.
 */
export async function runPackBinary(
	extensionId: string,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
	request: PackBinaryRunRequest,
	storeDir: string,
	signal?: AbortSignal,
): Promise<PackBinaryRunResult> {
	const binary = binaries.find((entry) => entry.name === request.name);
	if (!binary) throw new Error(`binary '${request.name}' is not declared`);
	const resolved = packBinaryPath(extensionId, binary);
	if ("reason" in resolved) throw new Error(resolved.reason);
	const result = await runCommandVector(resolved.path, request.args, {
		cwd: storeDir,
		workspaceRoot: storeDir,
		env: request.env,
		timeoutMs: request.timeoutMs,
		maxOutputBytes: BINARY_RUN_LIMITS.outputBytes * 2,
		...(signal ? { signal } : {}),
	});
	return {
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		stdout: capText(result.stdout),
		stderr: capText(result.stderr),
	};
}
