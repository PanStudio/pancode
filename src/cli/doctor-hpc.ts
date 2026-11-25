// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommandVector } from "../core/safe-exec.js";
import type { McpBuiltinSource } from "../domains/gateway/mcp/builtin.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { loadValidationContract, type ValidationContract } from "../domains/safety/validation-contract.js";

/** Each `--version` spawn gets this long before it is killed and reported as silent. */
export const HPC_VERSION_TIMEOUT_MS = 2_000;
const HPC_VERSION_MAX_OUTPUT_BYTES = 4096;

export interface HpcToolSpec {
	/** Row name and the name a validation contract uses for the tool. */
	name: string;
	/** Binaries tried in order on PATH; the first found answers for the row. */
	binaries: ReadonlyArray<string>;
}

/** The compilers, MPI launchers, build systems, and schedulers doctor looks for. */
export const HPC_TOOLS: ReadonlyArray<HpcToolSpec> = [
	{ name: "cc", binaries: ["cc", "gcc"] },
	{ name: "c++", binaries: ["c++", "g++"] },
	{ name: "clang", binaries: ["clang"] },
	{ name: "gfortran", binaries: ["gfortran"] },
	{ name: "mpicc", binaries: ["mpicc"] },
	{ name: "mpicxx", binaries: ["mpicxx"] },
	{ name: "mpirun", binaries: ["mpirun"] },
	{ name: "nvcc", binaries: ["nvcc"] },
	{ name: "cmake", binaries: ["cmake"] },
	{ name: "make", binaries: ["make"] },
	{ name: "ninja", binaries: ["ninja"] },
	{ name: "meson", binaries: ["meson"] },
	{ name: "python3", binaries: ["python3"] },
	{ name: "sbatch", binaries: ["sbatch"] },
];

export interface HpcToolchainOptions {
	workspaceRoot?: string;
	timeoutMs?: number;
}

/**
 * Why the workspace needs a tool, or null when nothing asks for it. The
 * contract names a tool when one of its validator commands has a word whose
 * basename is one of the tool's binaries; `runtime.kind: slurm` needs sbatch.
 */
function requiredBy(contract: ValidationContract | null, tool: HpcToolSpec): string | null {
	if (contract === null) return null;
	if (tool.name === "sbatch" && contract.runtime?.kind === "slurm") return "runtime.kind slurm needs it";
	for (const command of contract.validators ?? []) {
		const words = command.split(/[\s;&|()<>`"']+/).filter((word) => word.length > 0);
		if (words.some((word) => tool.binaries.includes(path.basename(word)))) {
			return "the validation contract names it";
		}
	}
	return null;
}

function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

interface VersionProbe {
	/** The first output line carrying a dotted version number, else the first line. */
	line: string;
	/** Set when `--version` failed, which marks an installed tool that does not work. */
	fault?: string;
	timedOut?: boolean;
}

async function versionLine(binary: string, timeoutMs: number): Promise<VersionProbe> {
	// A scratch cwd, as interop's version probe uses: a tool that reads config
	// from its working directory must not pick up the workspace's.
	const cwd = tmpdir();
	const result = await runCommandVector(binary, ["--version"], {
		cwd,
		workspaceRoot: cwd,
		timeoutMs,
		maxOutputBytes: HPC_VERSION_MAX_OUTPUT_BYTES,
	});
	if (result.timedOut)
		return {
			line: `no version line (--version did not answer within ${timeoutMs}ms)`,
			timedOut: true,
		};
	const output = lines(`${result.stdout}\n${result.stderr}`);
	const line = output.find((entry) => /\d+\.\d+/.test(entry)) ?? output[0] ?? "no version line";
	if (result.exitCode !== 0) {
		const slurmUnavailable =
			/resolve_ctls_from_dns_srv|fetch_config: DNS SRV lookup failed|could not establish a configuration source|unable to contact slurm controller|slurm.conf.*(no such file|not found)/i.test(
				output.join("\n"),
			);
		return {
			line,
			fault: slurmUnavailable
				? "host has no Slurm configuration or controller to reach"
				: `--version exited ${result.exitCode ?? "on a signal"}`,
		};
	}
	return { line };
}

async function probeTool(
	tool: HpcToolSpec,
	contract: ValidationContract | null,
	timeoutMs: number,
): Promise<DoctorFinding> {
	const name = `toolchain ${tool.name}`;
	const resolved = resolveOnPath(tool.binaries);
	if (resolved.presence === "present" && resolved.binary !== undefined) {
		const version = await versionLine(resolved.binary, timeoutMs);
		if (tool.name === "sbatch" && version.timedOut) {
			return {
				ok: true,
				name,
				level: "warn",
				detail: `${resolved.binary}: Slurm client version probe timed out: ${version.line}`,
			};
		}
		if (version.fault !== undefined) {
			return { ok: true, name, level: "warn", detail: `${resolved.binary}: ${version.fault}: ${version.line}` };
		}
		return { ok: true, name, level: "ok", detail: `${resolved.binary}: ${version.line}` };
	}
	const where = resolved.presence === "unknown" ? "PATH could not be read" : "not on PATH";
	const reason = requiredBy(contract, tool);
	if (reason !== null) return { ok: true, name, level: "warn", detail: `${where}; ${reason}` };
	return { ok: true, name, level: "info", detail: where };
}

/**
 * One row per HPC tool: where it resolves on PATH and the first line its
 * `--version` prints. Every spawn is bounded and all of them run at once. An
 * absent tool is information, not a fault, because most workspaces need none
 * of these; it becomes a warning only when the workspace's validation
 * contract asks for it. No row ever fails doctor.
 */
export async function hpcToolchainFindings(options: HpcToolchainOptions = {}): Promise<DoctorFinding[]> {
	const loaded = loadValidationContract(options.workspaceRoot ?? process.cwd());
	const contract = loaded.ok ? loaded.contract : null;
	const timeoutMs = options.timeoutMs ?? HPC_VERSION_TIMEOUT_MS;
	return Promise.all(HPC_TOOLS.map((tool) => probeTool(tool, contract, timeoutMs)));
}

/** `pankit doctor --json` gets this long before it is killed and reported as silent. */
export const PANKIT_DOCTOR_TIMEOUT_MS = 15_000;
const PANKIT_DOCTOR_MAX_OUTPUT_BYTES = 1024 * 1024;
const PANKIT_DOCTOR_KILL_GRACE_MS = 500;
const PROBE_FAILED = "the probe failed:";

export interface PankitFindingsOptions {
	workspaceRoot: string;
	/** The manifest and CLI to probe; the installed package's by default. */
	source?: McpBuiltinSource;
	timeoutMs?: number;
}

interface KitDoctorRow {
	id: string;
	available: boolean;
	reason?: string;
	sources?: Array<{ name: string; found: boolean }>;
}

/** The rows of `pankit doctor --json`, or null when the output is not that shape. */
function parseKitDoctor(text: string): KitDoctorRow[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { servers?: unknown }).servers)) {
		return null;
	}
	const rows: KitDoctorRow[] = [];
	for (const entry of (parsed as { servers: unknown[] }).servers) {
		if (entry === null || typeof entry !== "object") return null;
		const { id, available, reason, sources } = entry as Record<string, unknown>;
		if (typeof id !== "string" || typeof available !== "boolean") return null;
		rows.push({
			id,
			available,
			...(typeof reason === "string" ? { reason } : {}),
			...(Array.isArray(sources)
				? {
						sources: sources.flatMap((source) =>
							source !== null &&
							typeof source === "object" &&
							typeof (source as { name?: unknown }).name === "string" &&
							typeof (source as { found?: unknown }).found === "boolean"
								? [{ name: (source as { name: string }).name, found: (source as { found: boolean }).found }]
								: [],
						),
					}
				: {}),
		});
	}
	return rows;
}

/**
 * A launch option the builtin scope passes a server, and the variable its
 * unconfigured probe reads the same path from: `<variable>/<suffix>`.
 * `pankit doctor` never configures a server, so doctor sets the variable,
 * and the server's row names the path as `<label> <path>`.
 */
const LAUNCH_OPTION_VARIABLES: ReadonlyArray<{
	id: string;
	option: string;
	label: string;
	variable: string;
	suffix: string;
}> = [
	{
		id: "catalog",
		option: "--file",
		label: "file",
		variable: "XDG_CONFIG_HOME",
		suffix: path.join("pankit", "catalog.json"),
	},
	{
		id: "scidata",
		option: "--cache",
		label: "cache",
		variable: "XDG_CACHE_HOME",
		suffix: path.join("pankit", "data-readers"),
	},
];

/** The variables that point each probe at the path the builtin launch passes its server, and that path per server. */
function launchOptionPaths(
	ids: ReadonlyArray<string>,
	launchArgs: (id: string, context: Record<string, never>) => string[],
): { env: Record<string, string>; paths: Map<string, string> } {
	const env: Record<string, string> = {};
	const paths = new Map<string, string>();
	for (const { id, option, label, variable, suffix } of LAUNCH_OPTION_VARIABLES) {
		if (!ids.includes(id)) continue;
		const args = launchArgs(id, {});
		const value = args[args.indexOf(option) + 1];
		if (!args.includes(option) || value === undefined || !value.endsWith(`${path.sep}${suffix}`)) continue;
		env[variable] = value.slice(0, -(suffix.length + 1));
		paths.set(id, `${label} ${value}`);
	}
	return { env, paths };
}

function serverFinding(id: string, row: KitDoctorRow | undefined, launchPath: string | undefined): DoctorFinding {
	const name = `pankit ${id}`;
	if (row === undefined) return { ok: true, name, level: "warn", detail: "the kit did not report this server" };
	if (row.reason?.startsWith(PROBE_FAILED) === true) return { ok: true, name, level: "warn", detail: row.reason };
	if (row.available) {
		const found = (row.sources ?? []).filter((source) => source.found).map((source) => source.name);
		const detail = [
			"available",
			...(found.length > 0 ? [`found: ${found.join(", ")}`] : []),
			...(launchPath !== undefined && !found.some((name) => launchPath.endsWith(` ${name}`)) ? [launchPath] : []),
		].join("; ");
		return { ok: true, name, level: "ok", detail };
	}
	// `pankit doctor` never configures a server, and the builtin scope starts
	// `store` with the session's store roots, so a session has what the probe lacks.
	if (id === "store") {
		return { ok: true, name, level: "ok", detail: "available in sessions: PanCode passes this project's store roots" };
	}
	return { ok: true, name, level: "info", detail: row.reason ?? "unavailable" };
}

/**
 * One row per builtin PanKit server: whether this host can serve it, and why
 * not. It runs the shipped kit's `pankit doctor --json` once, as the builtin
 * scope launches a server: this Node, the project root as cwd, and only the
 * variables the manifest declares, so a server is never reported available
 * from a variable a session would not pass. The probes look programs up and
 * run none; this spawn is bounded. No row ever fails doctor.
 */
export async function pankitFindings(options: PankitFindingsOptions): Promise<DoctorFinding[]> {
	const {
		defaultMcpBuiltinSource,
		kitInvocation,
		loadMcpBuiltinServers,
		mcpBuiltinLaunchArgs,
		mcpBuiltinLaunchEnvironment,
	} = await import("../domains/gateway/mcp/builtin.js");
	const source = options.source ?? defaultMcpBuiltinSource();
	const loaded = loadMcpBuiltinServers(options.workspaceRoot, source);
	const findings: DoctorFinding[] = loaded.diagnostics.map((diagnostic) => ({
		ok: true,
		name: "pankit",
		level: "warn",
		detail: `${diagnostic.path}: ${diagnostic.message}`,
	}));
	const servers = loaded.servers;
	if (servers.length === 0) {
		if (findings.length > 0) return findings;
		return [{ ok: true, name: "pankit", level: "info", detail: "this PanCode ships no PanKit servers" }];
	}
	// Each probe reads only its own names, so the union equals each launch.
	const env = mcpBuiltinLaunchEnvironment([...new Set(servers.flatMap((server) => server.builtin?.environment ?? []))]);
	const launch = launchOptionPaths(
		servers.map((server) => server.id),
		mcpBuiltinLaunchArgs,
	);
	Object.assign(env, launch.env);
	const cwd = servers[0]?.cwd ?? options.workspaceRoot;
	const timeoutMs = options.timeoutMs ?? PANKIT_DOCTOR_TIMEOUT_MS;
	const { command, args } = kitInvocation(source, ["doctor", "--json"]);
	const result = await runCommandVector(command, args, {
		cwd,
		workspaceRoot: cwd,
		env,
		timeoutMs,
		killGraceMs: PANKIT_DOCTOR_KILL_GRACE_MS,
		maxOutputBytes: PANKIT_DOCTOR_MAX_OUTPUT_BYTES,
	});
	const stderrLine = lines(result.stderr)[0];
	const fail = (cause: string): DoctorFinding[] => [
		...findings,
		{ ok: true, name: "pankit", level: "warn", detail: stderrLine !== undefined ? `${cause}: ${stderrLine}` : cause },
	];
	if (result.launched === false) return fail("pankit doctor could not start");
	if (result.timedOut) return fail(`pankit doctor did not answer within ${timeoutMs}ms`);
	if (result.outputCapped) return fail(`pankit doctor printed more than ${PANKIT_DOCTOR_MAX_OUTPUT_BYTES} bytes`);
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		return fail(`pankit doctor exited ${result.exitCode ?? `on ${result.signal ?? "a signal"}`}`);
	}
	const rows = parseKitDoctor(result.stdout);
	if (rows === null) return fail("pankit doctor printed no server report");
	const byId = new Map(rows.map((row) => [row.id, row]));
	return [
		...findings,
		...servers.map((server) => serverFinding(server.id, byId.get(server.id), launch.paths.get(server.id))),
	];
}
