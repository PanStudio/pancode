// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The node server's six tools. Each reads facts about this machine and
 * changes nothing: `node:os` always, `/proc`, `lscpu`, `nvidia-smi` and `ps`
 * when present. A fact the platform does not offer is null with its reason
 * under `unavailable`, never zero or a guess, and every list says its cap and
 * whether it was cut.
 */
import { readFile, realpath, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@pancode/sdk/tool";
import { runCommand } from "../../exec.js";
import {
	type CpuinfoFacts,
	type LscpuFacts,
	type MountEntry,
	NVIDIA_SMI_QUERY,
	PS_ARGS,
	parseCpuinfo,
	parseLscpuJson,
	parseMeminfo,
	parseMounts,
	parseNvidiaSmiCsv,
	parsePsOutput,
} from "./parse.js";

export const MAX_MOUNTS = 100;
export const MAX_INTERFACES = 64;
export const MAX_ADDRESSES_PER_INTERFACE = 16;
export const MAX_GPUS = 64;
export const MAX_PROCESSES = 50;
const DEFAULT_PROCESSES = 10;
const COMMAND_TIMEOUT_MS = 10_000;
const STATFS_TIMEOUT_MS = 3_000;

/** File systems that hold no data a disk question is about; `includePseudo` lists them too. */
const PSEUDO_FILE_SYSTEMS = new Set([
	"autofs",
	"binfmt_misc",
	"bpf",
	"cgroup",
	"cgroup2",
	"configfs",
	"debugfs",
	"devpts",
	"devtmpfs",
	"efivarfs",
	"fusectl",
	"hugetlbfs",
	"mqueue",
	"nsfs",
	"proc",
	"pstore",
	"rootfs",
	"rpc_pipefs",
	"securityfs",
	"selinuxfs",
	"sysfs",
	"tracefs",
]);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const PROC_ABSENT = "/proc is not available on this platform";

async function readProc(file: string, signal: AbortSignal): Promise<Read<string>> {
	if (process.platform !== "linux") return { ok: false, reason: PROC_ABSENT };
	try {
		return { ok: true, value: await readFile(file, { encoding: "utf8", signal }) };
	} catch (error) {
		return { ok: false, reason: `${file} could not be read: ${message(error)}` };
	}
}

/** A program's stdout through exec.ts, or why it gave none. `LC_ALL=C` keeps field names and numbers unlocalized. */
async function commandOutput(program: string, args: ReadonlyArray<string>, signal: AbortSignal): Promise<Read<string>> {
	const result = await runCommand(program, args, {
		timeoutMs: COMMAND_TIMEOUT_MS,
		maxOutputBytes: 8 * 1024 * 1024,
		signal,
		env: { LC_ALL: "C" },
	});
	if (result.kind === "ok") {
		if (result.truncated) return { ok: false, reason: `${program} printed more output than the server reads` };
		return { ok: true, value: result.stdout };
	}
	if (result.kind === "exit") {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
		return {
			ok: false,
			reason: `${program} exited with ${result.code ?? result.signal}${detail.length > 0 ? `: ${detail}` : ""}`,
		};
	}
	return { ok: false, reason: result.message ?? `${program} did not run (${result.kind})` };
}

function cpuTopology(
	lscpu: Read<LscpuFacts>,
	cpuinfo: Read<CpuinfoFacts>,
): { sockets: number | null; cores: number | null; reason: string } {
	const fromLscpu = lscpu.ok ? lscpu.value : null;
	const fromProc = cpuinfo.ok ? cpuinfo.value : null;
	const sockets = fromLscpu?.sockets ?? fromProc?.sockets ?? null;
	const lscpuCores =
		fromLscpu?.sockets != null && fromLscpu.coresPerSocket != null ? fromLscpu.sockets * fromLscpu.coresPerSocket : null;
	const cores = lscpuCores ?? fromProc?.cores ?? null;
	const reasons = [
		lscpu.ok ? "lscpu reports no socket or core count" : lscpu.reason,
		cpuinfo.ok ? "/proc/cpuinfo names no physical id or core id" : cpuinfo.reason,
	];
	return { sockets, cores, reason: reasons.join("; ") };
}

const nodeCpu = defineTool({
	name: "node_cpu",
	description:
		"Returns this machine's CPU model, architecture, socket, core and thread counts, the threads this process may use, and the 1, 5 and 15 minute load averages. Prefer it over running lscpu, nproc or uptime: one call answers in structured fields, and a count the platform does not report is null with its reason.",
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: false,
	async run(_args, context) {
		const unavailable: Record<string, string> = {};
		const sources = ["node:os"];
		const lscpuText = await commandOutput("lscpu", ["-J"], context.signal);
		let lscpu: Read<LscpuFacts>;
		if (lscpuText.ok) {
			const parsed = parseLscpuJson(lscpuText.value);
			lscpu =
				parsed === null
					? { ok: false, reason: "lscpu -J printed output that is not its JSON" }
					: { ok: true, value: parsed };
		} else lscpu = lscpuText;
		if (lscpu.ok) sources.push("lscpu");
		const cpuinfoText = await readProc("/proc/cpuinfo", context.signal);
		let cpuinfo: Read<CpuinfoFacts>;
		if (cpuinfoText.ok) {
			const parsed = parseCpuinfo(cpuinfoText.value);
			cpuinfo = parsed === null ? { ok: false, reason: "/proc/cpuinfo lists no processor" } : { ok: true, value: parsed };
		} else cpuinfo = cpuinfoText;
		if (cpuinfo.ok) sources.push("/proc/cpuinfo");

		const cpus = os.cpus();
		const model =
			(lscpu.ok ? lscpu.value.model : null) ?? (cpuinfo.ok ? cpuinfo.value.model : null) ?? cpus[0]?.model ?? null;
		if (model === null) unavailable.model = "neither node:os, lscpu nor /proc/cpuinfo names the CPU model";
		const topology = cpuTopology(lscpu, cpuinfo);
		if (topology.sockets === null) unavailable.sockets = topology.reason;
		if (topology.cores === null) unavailable.cores = topology.reason;
		const threads =
			cpus.length > 0
				? cpus.length
				: ((lscpu.ok ? lscpu.value.cpus : null) ?? (cpuinfo.ok ? cpuinfo.value.threads : null));
		if (threads === null) unavailable.threads = "node:os lists no CPU, and neither lscpu nor /proc/cpuinfo answered";
		let loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number } | null = null;
		if (process.platform === "win32") unavailable.loadAverage = "Windows reports no load average";
		else {
			const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = os.loadavg();
			loadAverage = { oneMinute, fiveMinutes, fifteenMinutes };
		}
		return {
			json: {
				model,
				architecture: os.arch(),
				machine: os.machine(),
				sockets: topology.sockets,
				cores: topology.cores,
				threads,
				availableThreads: os.availableParallelism(),
				loadAverage,
				sources,
				unavailable,
			},
		};
	},
});

const nodeMemory = defineTool({
	name: "node_memory",
	description:
		"Returns this machine's physical memory (total, available, used, free) and swap (total, free, used), all in bytes. Prefer it over running free or reading /proc/meminfo: the fields are bytes, and a figure the platform does not report is null with its reason.",
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: false,
	async run(_args, context) {
		const unavailable: Record<string, string> = {};
		const text = await readProc("/proc/meminfo", context.signal);
		const meminfo = text.ok ? parseMeminfo(text.value) : null;
		const procReason = text.ok ? "/proc/meminfo has no MemTotal" : text.reason;
		const totalBytes = meminfo?.totalBytes ?? os.totalmem();
		const freeBytes = meminfo?.freeBytes ?? os.freemem();
		const availableBytes = meminfo?.availableBytes ?? null;
		if (availableBytes === null) {
			unavailable.availableBytes =
				meminfo === null
					? `${procReason}; freeBytes is the operating system's free figure, which leaves out reclaimable cache`
					: "/proc/meminfo has no MemAvailable on this kernel";
			unavailable.usedBytes = unavailable.availableBytes;
		}
		const swapTotalBytes = meminfo?.swapTotalBytes ?? null;
		const swapFreeBytes = meminfo?.swapFreeBytes ?? null;
		if (swapTotalBytes === null || swapFreeBytes === null) {
			const reason = meminfo === null ? procReason : "/proc/meminfo has no SwapTotal or SwapFree";
			unavailable.swapTotalBytes = reason;
			unavailable.swapFreeBytes = reason;
			unavailable.swapUsedBytes = reason;
		}
		return {
			json: {
				totalBytes,
				availableBytes,
				usedBytes: availableBytes === null ? null : totalBytes - availableBytes,
				freeBytes,
				swapTotalBytes,
				swapFreeBytes,
				swapUsedBytes: swapTotalBytes === null || swapFreeBytes === null ? null : swapTotalBytes - swapFreeBytes,
				sources: meminfo === null ? ["node:os"] : ["/proc/meminfo"],
				unavailable,
			},
		};
	},
});

interface DiskFacts {
	sizeBytes: number | null;
	freeBytes: number | null;
	availableBytes: number | null;
	usedBytes: number | null;
	inodes: number | null;
	inodesFree: number | null;
	reason?: string;
}

/** statfs of one path, bounded in time: a hung network mount answers with a reason instead of hanging the call. */
async function diskFacts(target: string): Promise<DiskFacts> {
	const none = (reason: string): DiskFacts => ({
		sizeBytes: null,
		freeBytes: null,
		availableBytes: null,
		usedBytes: null,
		inodes: null,
		inodesFree: null,
		reason,
	});
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<DiskFacts>((settle) => {
		timer = setTimeout(() => settle(none(`statfs did not answer within ${STATFS_TIMEOUT_MS} ms`)), STATFS_TIMEOUT_MS);
		timer.unref();
	});
	const measured = statfs(target).then(
		(stats): DiskFacts => {
			const sizeBytes = stats.blocks * stats.bsize;
			const freeBytes = stats.bfree * stats.bsize;
			return {
				sizeBytes,
				freeBytes,
				availableBytes: stats.bavail * stats.bsize,
				usedBytes: sizeBytes - freeBytes,
				inodes: stats.files,
				inodesFree: stats.ffree,
			};
		},
		(error: unknown) => none(`statfs failed: ${message(error)}`),
	);
	try {
		return await Promise.race([measured, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function within(mountPoint: string, target: string): boolean {
	if (mountPoint === "/") return target.startsWith("/");
	return target === mountPoint || target.startsWith(`${mountPoint}/`);
}

/** The mount holding `target`: the longest mount point containing it, the later of equal ones, as the kernel shadows. */
function owningMount(mounts: ReadonlyArray<MountEntry>, target: string): MountEntry | undefined {
	let best: MountEntry | undefined;
	for (const mount of mounts) {
		if (!within(mount.mountPoint, target)) continue;
		if (best === undefined || mount.mountPoint.length >= best.mountPoint.length) best = mount;
	}
	return best;
}

const nodeDisks = defineTool({
	name: "node_disks",
	description: `Returns each mounted file system (at most ${MAX_MOUNTS}, pseudo file systems such as proc and sysfs left out unless includePseudo is true), or the one that holds path, with its type, size, free and available bytes and inode counts. Prefer it over running df or mount: sizes are bytes, a hung network mount is reported instead of blocking, and the result says when the list was cut.`,
	input: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Report only the file system that holds this path; relative to the server's working directory.",
			},
			includePseudo: {
				type: "boolean",
				description: "Also list pseudo file systems such as proc, sysfs and cgroup. Default false.",
			},
		},
	},
	actionClass: "read",
	idempotent: false,
	async run(args: { path?: string; includePseudo?: boolean }, context) {
		const mountsText = await readProc("/proc/mounts", context.signal);
		const mounts = mountsText.ok ? parseMounts(mountsText.value) : [];
		const mountsReason = mountsText.ok ? "/proc/mounts lists no mount that could be read" : mountsText.reason;
		const sources = mountsText.ok && mounts.length > 0 ? ["/proc/mounts", "statfs"] : ["statfs"];

		if (args.path !== undefined) {
			if (args.path.length === 0) return { error: "node_disks: path must not be empty" };
			const resolvedPath = path.resolve(args.path);
			let target = resolvedPath;
			try {
				target = await realpath(resolvedPath);
			} catch (error) {
				return { error: `node_disks: ${resolvedPath} cannot be resolved: ${message(error)}` };
			}
			const mount = owningMount(mounts, target);
			const unavailable: Record<string, string> = {};
			if (mount === undefined) {
				unavailable.mountPoint = mountsReason;
				unavailable.type = mountsReason;
			}
			const facts = await diskFacts(target);
			const { reason, ...sizes } = facts;
			if (reason !== undefined) for (const key of Object.keys(sizes)) unavailable[key] = reason;
			return {
				json: {
					path: resolvedPath,
					resolvedPath: target,
					mountPoint: mount?.mountPoint ?? null,
					device: mount?.device ?? null,
					type: mount?.type ?? null,
					...sizes,
					sources,
					unavailable,
				},
			};
		}

		const unavailable: Record<string, string> = {};
		let candidates: MountEntry[];
		if (mounts.length > 0) candidates = mounts;
		else {
			// Without a mount list, the file system of the filesystem root is still a fact statfs can give.
			unavailable.mountList = `${mountsReason}; only the root file system is reported`;
			candidates = [{ device: "", mountPoint: path.parse(process.cwd()).root, type: "" }];
		}
		const listed = args.includePseudo === true ? candidates : candidates.filter((m) => !PSEUDO_FILE_SYSTEMS.has(m.type));
		const kept = listed.slice(0, MAX_MOUNTS);
		const measured = await Promise.all(
			kept.map(async (mount) => {
				const { reason, ...sizes } = await diskFacts(mount.mountPoint);
				return {
					mountPoint: mount.mountPoint,
					device: mount.device.length > 0 ? mount.device : null,
					type: mount.type.length > 0 ? mount.type : null,
					...sizes,
					...(reason !== undefined ? { reason } : {}),
				};
			}),
		);
		return {
			json: {
				mounts: measured,
				total: listed.length,
				pseudoSkipped: candidates.length - listed.length,
				cap: MAX_MOUNTS,
				truncated: listed.length > kept.length,
				sources,
				unavailable,
			},
		};
	},
});

const nodeNetwork = defineTool({
	name: "node_network",
	description: `Returns this machine's hostname and its network interfaces (at most ${MAX_INTERFACES}, each with at most ${MAX_ADDRESSES_PER_INTERFACE} addresses) with each address's family, CIDR and whether it is internal; no hardware addresses. Prefer it over running ip addr or ifconfig: the result is structured, and it says when a list was cut.`,
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: false,
	run() {
		const all = Object.entries(os.networkInterfaces());
		const interfaces = all.slice(0, MAX_INTERFACES).map(([name, entries = []]) => ({
			name,
			internal: entries.length > 0 && entries.every((entry) => entry.internal),
			addresses: entries.slice(0, MAX_ADDRESSES_PER_INTERFACE).map((entry) => ({
				address: entry.address,
				family: entry.family,
				cidr: entry.cidr,
				internal: entry.internal,
			})),
			addressCount: entries.length,
			addressesTruncated: entries.length > MAX_ADDRESSES_PER_INTERFACE,
		}));
		return {
			json: {
				hostname: os.hostname(),
				interfaces,
				total: all.length,
				cap: MAX_INTERFACES,
				truncated: all.length > interfaces.length,
				sources: ["node:os"],
			},
		};
	},
});

const nodeGpus = defineTool({
	name: "node_gpus",
	description: `Returns each NVIDIA GPU on this machine (at most ${MAX_GPUS}) with its index, name, total and used memory in bytes and utilization percent, read through nvidia-smi; without nvidia-smi it returns available false and the reason. Prefer it over running nvidia-smi: memory comes as bytes, values the driver does not report are null, and the result says when the list was cut.`,
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: false,
	async run(_args, context) {
		const output = await commandOutput(
			"nvidia-smi",
			[`--query-gpu=${NVIDIA_SMI_QUERY}`, "--format=csv,noheader,nounits"],
			context.signal,
		);
		if (!output.ok) return { json: { available: false, reason: output.reason } };
		const { gpus, malformedLines } = parseNvidiaSmiCsv(output.value);
		if (gpus.length === 0) {
			const reason = malformedLines > 0 ? "nvidia-smi printed no line the server could read" : "nvidia-smi lists no GPU";
			return { json: { available: false, reason } };
		}
		return {
			json: {
				available: true,
				gpus: gpus.slice(0, MAX_GPUS),
				total: gpus.length,
				cap: MAX_GPUS,
				truncated: gpus.length > MAX_GPUS,
				malformedLines,
				sources: ["nvidia-smi"],
			},
		};
	},
});

const nodeProcesses = defineTool({
	name: "node_processes",
	description: `Returns the top processes on this machine by CPU or memory (limit, at most ${MAX_PROCESSES}, default ${DEFAULT_PROCESSES}) with pid, user, CPU and memory percent, resident bytes, elapsed seconds and the command name, never its arguments. Prefer it over running ps or top: arguments that can carry tokens are never returned, and the result says how many processes there were.`,
	input: {
		type: "object",
		properties: {
			sort: { type: "string", enum: ["cpu", "memory"], description: "Rank by CPU percent or memory. Default cpu." },
			limit: {
				type: "integer",
				minimum: 1,
				maximum: MAX_PROCESSES,
				description: `How many processes to return, 1 to ${MAX_PROCESSES}. Default ${DEFAULT_PROCESSES}.`,
			},
		},
	},
	actionClass: "read",
	idempotent: false,
	async run(args: { sort?: string; limit?: number }, context) {
		const sort = args.sort ?? "cpu";
		if (sort !== "cpu" && sort !== "memory") return { error: "node_processes: sort must be cpu or memory" };
		const limit = Math.min(MAX_PROCESSES, Math.max(1, Math.floor(args.limit ?? DEFAULT_PROCESSES)));
		const output = await commandOutput("ps", PS_ARGS, context.signal);
		if (!output.ok) return { json: { available: false, reason: output.reason } };
		const { processes, malformedLines } = parsePsOutput(output.value);
		if (processes.length === 0) return { json: { available: false, reason: "ps printed no line the server could read" } };
		const key = sort === "cpu" ? "cpuPercent" : "memoryPercent";
		const ranked = [...processes].sort((a, b) => b[key] - a[key] || b.rssBytes - a.rssBytes || a.pid - b.pid);
		return {
			json: {
				available: true,
				sort,
				limit,
				processes: ranked.slice(0, limit),
				total: processes.length,
				cap: MAX_PROCESSES,
				truncated: processes.length > limit,
				malformedLines,
				sources: ["ps"],
			},
		};
	},
});

export const NODE_TOOLS = [nodeCpu, nodeMemory, nodeDisks, nodeNetwork, nodeGpus, nodeProcesses];
