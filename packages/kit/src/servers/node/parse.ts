// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure parsers for the text the node server reads: `lscpu -J`,
 * `/proc/cpuinfo`, `/proc/meminfo`, `/proc/mounts`, `nvidia-smi` CSV and
 * `ps`. Each takes text and returns data, never throws, and gives null or
 * skips a line rather than guess a value it cannot read.
 */

/** CPU topology as `lscpu -J` reports it. A field lscpu does not report, or reports as `-`, is null. */
export interface LscpuFacts {
	architecture: string | null;
	model: string | null;
	sockets: number | null;
	coresPerSocket: number | null;
	threadsPerCore: number | null;
	/** Logical CPUs, `CPU(s)`. */
	cpus: number | null;
}

interface LscpuEntry {
	field: string;
	data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wholeNumber(text: string | undefined): number | null {
	if (text === undefined || !/^\d+$/u.test(text.trim())) return null;
	const value = Number(text.trim());
	return Number.isSafeInteger(value) ? value : null;
}

function positiveInteger(text: string | undefined): number | null {
	const value = wholeNumber(text);
	return value !== null && value > 0 ? value : null;
}

function nonNegativeNumber(text: string | undefined): number | null {
	if (text === undefined || !/^\d+(?:\.\d+)?$/u.test(text.trim())) return null;
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : null;
}

/** lscpu nests entries under `children` in newer releases and lists them flat in older ones. */
function flattenLscpu(entries: unknown, out: LscpuEntry[]): boolean {
	if (!Array.isArray(entries)) return false;
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.field !== "string") return false;
		out.push({ field: entry.field.replace(/:$/u, "").trim(), data: typeof entry.data === "string" ? entry.data : "" });
		if (entry.children !== undefined && !flattenLscpu(entry.children, out)) return false;
	}
	return true;
}

/** The topology in `lscpu -J` output, or null when the text is not that JSON shape. */
export function parseLscpuJson(text: string): LscpuFacts | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const entries: LscpuEntry[] = [];
	if (!flattenLscpu(parsed.lscpu, entries) || entries.length === 0) return null;
	const field = (name: string): string | undefined => entries.find((entry) => entry.field === name)?.data;
	const fieldText = (name: string): string | null => {
		const value = field(name)?.trim();
		return value === undefined || value.length === 0 || value === "-" ? null : value;
	};
	return {
		architecture: fieldText("Architecture"),
		model: fieldText("Model name"),
		sockets: positiveInteger(field("Socket(s)")),
		coresPerSocket: positiveInteger(field("Core(s) per socket")),
		threadsPerCore: positiveInteger(field("Thread(s) per core")),
		cpus: positiveInteger(field("CPU(s)")),
	};
}

/** CPU facts from `/proc/cpuinfo`. Sockets and cores are null when the file names no `physical id` (most non-x86). */
export interface CpuinfoFacts {
	model: string | null;
	sockets: number | null;
	cores: number | null;
	/** Logical CPUs: the number of `processor` blocks. */
	threads: number;
}

/** The CPU facts in `/proc/cpuinfo` text, or null when it lists no processor. */
export function parseCpuinfo(text: string): CpuinfoFacts | null {
	const blocks = text
		.split(/\n\s*\n/u)
		.map((block) => {
			const fields = new Map<string, string>();
			for (const line of block.split("\n")) {
				const colon = line.indexOf(":");
				if (colon <= 0) continue;
				fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
			}
			return fields;
		})
		.filter((fields) => wholeNumber(fields.get("processor")) !== null);
	if (blocks.length === 0) return null;
	const first = blocks[0];
	const model =
		[first?.get("model name"), first?.get("Model"), first?.get("cpu"), first?.get("Processor")].find(
			(value): value is string => value !== undefined && value.length > 0,
		) ?? null;
	const cores = new Set<string>();
	const sockets = new Set<string>();
	let topology = true;
	for (const block of blocks) {
		const socket = block.get("physical id");
		const core = block.get("core id");
		if (socket === undefined || core === undefined) {
			topology = false;
			break;
		}
		sockets.add(socket);
		cores.add(`${socket}:${core}`);
	}
	return {
		model,
		sockets: topology ? sockets.size : null,
		cores: topology ? cores.size : null,
		threads: blocks.length,
	};
}

/** Memory from `/proc/meminfo`, in bytes. `availableBytes` is null on a kernel without `MemAvailable`. */
export interface MeminfoFacts {
	totalBytes: number;
	freeBytes: number | null;
	availableBytes: number | null;
	swapTotalBytes: number | null;
	swapFreeBytes: number | null;
}

/** The memory facts in `/proc/meminfo` text, or null when it has no `MemTotal`. */
export function parseMeminfo(text: string): MeminfoFacts | null {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+(kB))?\s*$/u.exec(line);
		if (match === null) continue;
		const [, key, amount, unit] = match;
		if (key === undefined || amount === undefined) continue;
		const value = Number(amount) * (unit === "kB" ? 1024 : 1);
		if (Number.isSafeInteger(value)) values.set(key, value);
	}
	const totalBytes = values.get("MemTotal");
	if (totalBytes === undefined || totalBytes <= 0) return null;
	return {
		totalBytes,
		freeBytes: values.get("MemFree") ?? null,
		availableBytes: values.get("MemAvailable") ?? null,
		swapTotalBytes: values.get("SwapTotal") ?? null,
		swapFreeBytes: values.get("SwapFree") ?? null,
	};
}

/** One line of `/proc/mounts`. */
export interface MountEntry {
	device: string;
	mountPoint: string;
	type: string;
}

/** `/proc/mounts` escapes space, tab, newline and backslash as three-digit octal. */
function unescapeMountField(field: string): string {
	return field.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The mounts in `/proc/mounts` text, in mount order. A line without device, mount point and type is skipped. */
export function parseMounts(text: string): MountEntry[] {
	const mounts: MountEntry[] = [];
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/u);
		if (fields.length < 4) continue;
		const [device, mountPoint, type] = fields;
		if (device === undefined || mountPoint === undefined || type === undefined || !mountPoint.startsWith("/")) continue;
		mounts.push({ device: unescapeMountField(device), mountPoint: unescapeMountField(mountPoint), type });
	}
	return mounts;
}

/** The query `node_gpus` sends; `parseNvidiaSmiCsv` reads its columns in this order. */
export const NVIDIA_SMI_QUERY = "index,name,memory.total,memory.used,utilization.gpu";

/** One GPU. A value nvidia-smi reports as `[N/A]` or `[Not Supported]` is null. */
export interface GpuFacts {
	index: number;
	name: string;
	memoryTotalBytes: number | null;
	memoryUsedBytes: number | null;
	utilizationPercent: number | null;
}

const MIB = 1024 * 1024;

/**
 * The GPUs in `nvidia-smi --query-gpu=<NVIDIA_SMI_QUERY> --format=csv,noheader,nounits`
 * output, memory converted from MiB to bytes. A line that does not have the
 * five columns is skipped and counted.
 */
export function parseNvidiaSmiCsv(text: string): { gpus: GpuFacts[]; malformedLines: number } {
	const gpus: GpuFacts[] = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const fields = line.split(",").map((field) => field.trim());
		const index = wholeNumber(fields[0]);
		const name = fields.slice(1, -3).join(", ");
		if (fields.length < 5 || index === null || name.length === 0) {
			malformedLines++;
			continue;
		}
		const [memoryTotal, memoryUsed, utilization] = fields.slice(-3).map(nonNegativeNumber);
		gpus.push({
			index,
			name,
			memoryTotalBytes: memoryTotal === null || memoryTotal === undefined ? null : Math.round(memoryTotal * MIB),
			memoryUsedBytes: memoryUsed === null || memoryUsed === undefined ? null : Math.round(memoryUsed * MIB),
			utilizationPercent: utilization ?? null,
		});
	}
	return { gpus, malformedLines };
}

/** The `ps` arguments `node_processes` runs: every process, its command name and never its arguments. */
export const PS_ARGS: ReadonlyArray<string> = [
	"-A",
	"-o",
	"pid=",
	"-o",
	"user=",
	"-o",
	"pcpu=",
	"-o",
	"pmem=",
	"-o",
	"rss=",
	"-o",
	"etime=",
	"-o",
	"comm=",
];

/** One process from `ps`. */
export interface ProcessFacts {
	pid: number;
	user: string;
	cpuPercent: number;
	memoryPercent: number;
	rssBytes: number;
	elapsedSeconds: number;
	/** The command name; where `comm` is the executable's path (macOS), only its file name. */
	command: string;
}

/** Seconds in a `ps` `etime` value, `[[dd-]hh:]mm:ss`, or null. */
export function parseElapsed(text: string): number | null {
	const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(text.trim());
	if (match === null) return null;
	const [, days, hours, minutes, seconds] = match;
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/** The processes in the output of `ps` run with `PS_ARGS`. A line that does not parse is skipped and counted. */
export function parsePsOutput(text: string): { processes: ProcessFacts[]; malformedLines: number } {
	const processes: ProcessFacts[] = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
		const pid = positiveInteger(match?.[1]);
		const user = match?.[2];
		const cpuPercent = nonNegativeNumber(match?.[3]);
		const memoryPercent = nonNegativeNumber(match?.[4]);
		const rssKib = wholeNumber(match?.[5]);
		const elapsedSeconds = parseElapsed(match?.[6] ?? "");
		const comm = match?.[7];
		if (
			pid === null ||
			user === undefined ||
			cpuPercent === null ||
			memoryPercent === null ||
			rssKib === null ||
			elapsedSeconds === null ||
			comm === undefined
		) {
			malformedLines++;
			continue;
		}
		const command = comm.startsWith("/") ? (comm.split("/").pop() ?? comm) : comm;
		processes.push({ pid, user, cpuPercent, memoryPercent, rssBytes: rssKib * 1024, elapsedSeconds, command });
	}
	return { processes, malformedLines };
}
