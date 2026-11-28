// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pinned programs an extension declares, the host half.
 *
 * A declared binary is downloaded and verified at install, after the operator
 * approved the envelope that names it, and run by the host outside the
 * runtime's sandbox: a program such as a music player is controlled over a Unix socket,
 * which the sandbox refuses. The runtime never gets a path to exec. It asks the
 * host to run a binary it declared, with arguments and only the environment keys
 * it declared, and the host answers with the exit code and bounded output.
 * Only the vendored copy at the pin runs, never a same-named program on PATH;
 * binary-runs.ts admits and journals each call.
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { type ExtensionBinaryDeclaration, RESERVED_BINARY_ENV } from "@pancode/sdk/pack";
import {
	currentToolPlatform,
	installPinnedTool,
	type PinnedTool,
	type PinnedToolDownload,
	resolvePinnedEntryBinary,
	type ToolFetcher,
	type ToolInstallResult,
	type ToolPlatform,
	type ToolResolution,
	toolchainRoot,
} from "../../../lib/programs/index.js";
import { listInstalledExtensions } from "../state.js";

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

/** The toolchain row a declaration stands for, so install and the resolution ladder are the ones `pancode programs` uses. */
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
		// Nothing probes a pack binary's version: only the pin runs.
		minimumVersion: binary.version,
		versionArgs: [],
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

/**
 * Brings one extension's vendored binaries in line with its installed copies
 * once an install, update or removal has committed: the enabled copy's pins
 * are downloaded and verified, a superseded pin is pruned, and everything goes
 * once no copy declares a binary. Answers one line per failure.
 */
export async function syncPackBinaries(
	extensionId: string,
	cwd: string,
	options: PackBinaryInstallOptions = {},
): Promise<string[]> {
	const copies = listInstalledExtensions(cwd, { all: true }).filter(
		(entry) =>
			entry.id === extensionId &&
			entry.valid &&
			entry.compatible &&
			entry.enabled &&
			!entry.trustBlocked &&
			(entry.runtimeV2?.binaries?.length ?? 0) > 0,
	);
	const binaries = (copies.find((entry) => entry.effective) ?? copies[0])?.runtimeV2?.binaries ?? [];
	try {
		if (binaries.length === 0) {
			removePackBinaries(extensionId, options.root);
			return [];
		}
		const keep = new Set(binaries.map((binary) => binary.name));
		const dir = packBinaryRoot(extensionId, options.root);
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!keep.has(entry.name)) rmSync(path.join(dir, entry.name), { recursive: true, force: true });
			}
		}
		const results = await installPackBinaries(extensionId, binaries, options);
		return results.filter((result) => !result.ok).map((result) => `${extensionId}: ${result.message}`);
	} catch (error) {
		return [`${extensionId}: ${error instanceof Error ? error.message : String(error)}`];
	}
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

/** Where a declared binary resolves: the vendored copy at its pin, never a program on PATH. */
export function resolvePackBinary(extensionId: string, binary: ExtensionBinaryDeclaration): ToolResolution {
	return resolvePinnedEntryBinary(packBinaryTool(extensionId, binary), binary.name);
}

/** The pinned copy's expected sha256 for the current platform, or undefined if this platform has no pin. */
export function packBinarySha256(binary: ExtensionBinaryDeclaration): string | undefined {
	const platform = currentToolPlatform();
	return platform === null ? undefined : binary.downloads[platform]?.sha256;
}

/** The binary's path, or one sentence on why it has none, naming what fixes it. */
export function packBinaryPath(
	extensionId: string,
	binary: ExtensionBinaryDeclaration,
): { path: string } | { reason: string } {
	const resolution = resolvePackBinary(extensionId, binary);
	if (resolution.binaryPath !== null) return { path: resolution.binaryPath };
	const platform = currentToolPlatform();
	if (platform === null || binary.downloads[platform] === undefined)
		return {
			reason: `${binary.name} has no pinned build for ${platform ?? `${process.platform}-${process.arch}`}`,
		};
	return {
		reason: `${binary.name} ${binary.version} is not installed; reinstall the extension (pancode hub install extension:${extensionId})`,
	};
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
		if (!binary.env.includes(key) || RESERVED_BINARY_ENV.test(key))
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
