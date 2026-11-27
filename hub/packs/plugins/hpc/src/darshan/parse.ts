// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure parsers for the text `darshan-parser` and `darshan-dxt-parser` print:
 * the header block and mount table every mode starts with, the `--total`,
 * `--perf` and `--file` summaries, the per-record lines of `--base`, and DXT
 * trace segments. Each takes text and returns data, never throws, and gives
 * null or skips a line rather than guess a value it cannot read. A counter
 * Darshan prints as -1 was not recorded and becomes null.
 */

/** A module name as the tools take it: `MPIIO` for Darshan's `MPI-IO`, `BGQ` for `BG/Q`. */
export function moduleKey(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/gu, "").toUpperCase();
}

/** A counter value, null for Darshan's "not recorded" (-1) or a value that is not a number. */
export function counterValue(text: string | undefined): number | null {
	if (text === undefined) return null;
	const trimmed = text.trim();
	if (!/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/u.test(trimmed)) return null;
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value === -1) return null;
	return value;
}

function wholeNumber(text: string | undefined): number | null {
	if (text === undefined || !/^\d+$/u.test(text.trim())) return null;
	const value = Number(text.trim());
	return Number.isSafeInteger(value) ? value : null;
}

function decimal(text: string | undefined): number | null {
	if (text === undefined || !/^\d+(?:\.\d+)?$/u.test(text.trim())) return null;
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : null;
}

/** One module the log's region table lists, with the version of its record format. */
export interface LogModule {
	/** Darshan's own name: `POSIX`, `MPI-IO`, `STDIO`, `HEATMAP`, `DXT_POSIX`. */
	name: string;
	formatVersion: number | null;
}

/** The job as the header block every darshan-parser mode prints describes it. Null where the line is missing. */
export interface DarshanHeader {
	logFormatVersion: string | null;
	compression: string | null;
	/** The executable path only: the first word of the recorded command line, never its arguments. */
	executable: string | null;
	uid: number | null;
	jobId: string | null;
	startTime: number | null;
	endTime: number | null;
	processCount: number | null;
	runTimeSeconds: number | null;
	/** The Darshan runtime version that wrote the log, from `metadata: lib_ver = ...`. */
	libraryVersion: string | null;
	modules: LogModule[];
}

/** The header block of any darshan-parser or darshan-dxt-parser output, or null when the text has none. */
export function parseHeader(text: string): DarshanHeader | null {
	const header: DarshanHeader = {
		logFormatVersion: null,
		compression: null,
		executable: null,
		uid: null,
		jobId: null,
		startTime: null,
		endTime: null,
		processCount: null,
		runTimeSeconds: null,
		libraryVersion: null,
		modules: [],
	};
	let seen = false;
	for (const line of text.split("\n")) {
		if (!line.startsWith("#")) {
			if (seen && line.trim().length > 0) break;
			continue;
		}
		if (seen && /^# \*{8,}\s*$/u.test(line)) break;
		const region = /^# (\S+) module: .*\bver=(\d+)\s*$/u.exec(line);
		if (region?.[1] !== undefined) {
			header.modules.push({ name: region[1], formatVersion: wholeNumber(region[2]) });
			continue;
		}
		const match = /^# ([a-z_ ]+): ?(.*)$/u.exec(line);
		if (match === null) continue;
		const [, key, rawValue = ""] = match;
		const value = rawValue.trim();
		switch (key) {
			case "darshan log version":
				header.logFormatVersion = value.length > 0 ? value : null;
				seen = true;
				break;
			case "compression method":
				header.compression = value.length > 0 ? value : null;
				break;
			case "exe":
				header.executable = value.split(/\s+/u)[0] || null;
				break;
			case "uid":
				header.uid = wholeNumber(value);
				break;
			case "jobid":
				header.jobId = /^\S+$/u.test(value) ? value : null;
				break;
			case "start_time":
				header.startTime = wholeNumber(value);
				break;
			case "end_time":
				header.endTime = wholeNumber(value);
				break;
			case "nprocs":
				header.processCount = wholeNumber(value);
				break;
			case "run time":
				header.runTimeSeconds = decimal(value);
				break;
			case "metadata": {
				const version = /^lib_ver\s*=\s*(\S+)$/u.exec(value)?.[1];
				if (version !== undefined) header.libraryVersion = version;
				break;
			}
		}
	}
	return seen ? header : null;
}

/** One mounted file system the log recorded. */
export interface MountEntry {
	mountPoint: string;
	fsType: string;
}

/** The mount table in darshan-parser output, in the order printed. A line without a mount point and type is skipped. */
export function parseMounts(text: string): MountEntry[] {
	const mounts: MountEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("# mount entry:")) {
			if (line.length > 0 && !line.startsWith("#")) break;
			continue;
		}
		// Older logs print a device id before the mount point; the last two fields are always point and type.
		const fields = line
			.slice("# mount entry:".length)
			.split("\t")
			.map((field) => field.trim())
			.filter((field) => field.length > 0);
		const mountPoint = fields.at(-2);
		const fsType = fields.at(-1);
		if (fields.length < 2 || mountPoint === undefined || fsType === undefined || !mountPoint.startsWith("/")) continue;
		mounts.push({ mountPoint, fsType });
	}
	return mounts;
}

const SECTION = /^# (\S+) module data\s*$/u;
const INCOMPLETE = /^# \*(?:WARNING|ERROR)\*: The (\S+) module contains incomplete data!/u;

/** The modules a darshan-parser output marks as having run out of memory for records, by Darshan's name. */
export function parseIncomplete(text: string): string[] {
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		const name = INCOMPLETE.exec(line)?.[1];
		if (name !== undefined) names.add(name);
	}
	return [...names];
}

/** Split darshan-parser output into its `# <module> module data` sections, keyed by Darshan's module name. */
function sections(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of text.split("\n")) {
		const name = SECTION.exec(line)?.[1];
		if (name !== undefined) {
			current = out.get(name) ?? [];
			out.set(name, current);
			continue;
		}
		current?.push(line);
	}
	return out;
}

/** One counter as `--total` prints it, its name without the `total_` prefix. */
export interface Counter {
	name: string;
	value: number | null;
}

/** The counters of each module in `darshan-parser --total` output, keyed by Darshan's module name. */
export function parseTotals(text: string): { modules: Map<string, Counter[]>; malformedLines: number } {
	const modules = new Map<string, Counter[]>();
	let malformedLines = 0;
	for (const [name, lines] of sections(text)) {
		const counters: Counter[] = [];
		for (const line of lines) {
			if (line.startsWith("#") || line.trim().length === 0) continue;
			const match = /^total_([A-Z][A-Z0-9_]*):\s+(\S+)\s*$/u.exec(line);
			if (match?.[1] === undefined) {
				malformedLines++;
				continue;
			}
			counters.push({ name: match[1], value: counterValue(match[2]) });
		}
		modules.set(name, counters);
	}
	return { modules, malformedLines };
}

/** What `--perf` estimates for one module. */
export interface ModulePerf {
	totalBytes: number | null;
	/** `agg_perf_by_slowest`, converted to bytes per second; null when absent or in a unit the server does not know. */
	aggregateRateBytesPerSecond: number | null;
	/** Why the rate is null. */
	rateReason?: string;
}

const RATE_UNITS: Readonly<Record<string, number>> = {
	"B/s": 1,
	"KiB/s": 1024,
	"MiB/s": 1024 ** 2,
	"GiB/s": 1024 ** 3,
	"KB/s": 1e3,
	"MB/s": 1e6,
	"GB/s": 1e9,
};

/** The `--perf` estimates of each module, keyed by Darshan's module name. */
export function parsePerf(text: string): Map<string, ModulePerf> {
	const out = new Map<string, ModulePerf>();
	for (const [name, lines] of sections(text)) {
		let totalBytes: number | null = null;
		let rate: number | null = null;
		let rateReason: string | undefined = "darshan-parser --perf printed no agg_perf_by_slowest";
		// Older releases name the unit once, in the heading above the estimates.
		let headingUnit: string | null = null;
		for (const line of lines) {
			const total = /^# total_bytes:\s*(\S+)\s*$/u.exec(line);
			if (total !== null) totalBytes = counterValue(total[1]);
			const heading = /^# Aggregate performance.*\(([A-Za-z]+\/s)\)/u.exec(line);
			if (heading?.[1] !== undefined) headingUnit = heading[1];
			const estimate = /^# agg_perf_by_slowest:\s*(\S+)(?:\s*#\s*(\S+))?\s*$/u.exec(line);
			if (estimate === null) continue;
			const value = counterValue(estimate[1]);
			const unit = estimate[2] ?? headingUnit;
			const scale = unit === null ? undefined : RATE_UNITS[unit];
			if (value === null) {
				rate = null;
				rateReason = "darshan-parser --perf printed agg_perf_by_slowest as not recorded";
			} else if (scale === undefined) {
				rate = null;
				rateReason =
					unit === null
						? "darshan-parser --perf printed agg_perf_by_slowest without a unit"
						: `darshan-parser --perf printed agg_perf_by_slowest in ${unit}, a unit the server does not convert`;
			} else {
				rate = value * scale;
				rateReason = undefined;
			}
		}
		out.set(name, {
			totalBytes,
			aggregateRateBytesPerSecond: rate,
			...(rateReason !== undefined ? { rateReason } : {}),
		});
	}
	return out;
}

/** The number of files each module accessed, from the `# total:` row of `--file` output; null when it has none. */
export function parseFileCounts(text: string): Map<string, number | null> {
	const out = new Map<string, number | null>();
	for (const [name, lines] of sections(text)) {
		let files: number | null = null;
		for (const line of lines) {
			const match = /^# total:\s+(\S+)\s+\S+\s+\S+\s*$/u.exec(line);
			if (match !== null) files = counterValue(match[1]);
		}
		out.set(name, files);
	}
	return out;
}

/** One file record of `--base` output: every counter one rank (or -1, shared) recorded for one file. */
export interface FileRecord {
	module: string;
	rank: number;
	recordId: string;
	path: string;
	mountPoint: string;
	fsType: string;
	counters: Map<string, number | null>;
}

/** Whether a `--base` line is a record of the module `key` (as `moduleKey` gives it). */
export function isRecordLine(line: string, key: string): boolean {
	const tab = line.indexOf("\t");
	return tab > 0 && !line.startsWith("#") && moduleKey(line.slice(0, tab)) === key;
}

/**
 * The file records of `darshan-parser --base` output for the module `key`
 * (as `moduleKey` gives it), in the order printed. Lines of other modules are
 * ignored; a line of this module that is not the eight tab-separated columns
 * is skipped and counted.
 */
export function parseRecords(text: string, key: string): { records: FileRecord[]; malformedLines: number } {
	const byId = new Map<string, FileRecord>();
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (!isRecordLine(line, key)) continue;
		const fields = line.split("\t");
		const [module = "", rankText = "", recordId, counter, value, path, mountPoint, fsType] = fields;
		const rank = /^-?\d+$/u.test(rankText) ? Number(rankText) : null;
		if (
			fields.length !== 8 ||
			rank === null ||
			recordId === undefined ||
			!/^\d+$/u.test(recordId) ||
			counter === undefined ||
			!/^[A-Z][A-Z0-9_]*$/u.test(counter) ||
			path === undefined ||
			mountPoint === undefined ||
			fsType === undefined
		) {
			malformedLines++;
			continue;
		}
		const id = `${rank}:${recordId}`;
		let record = byId.get(id);
		if (record === undefined) {
			record = { module, rank, recordId, path, mountPoint, fsType, counters: new Map() };
			byId.set(id, record);
		}
		record.counters.set(counter, counterValue(value));
	}
	return { records: [...byId.values()], malformedLines };
}

/** Bytes moved in each time bin of one module's heatmap, summed over ranks. */
export interface Heatmap {
	binWidthSeconds: number;
	readBytes: number[];
	writeBytes: number[];
}

/** The largest bin index the server accepts from a heatmap record; Darshan keeps far fewer. */
const MAX_HEATMAP_BIN = 100_000;

/**
 * The heatmap of one module (`key` as `moduleKey` gives it) from `--base`
 * output: the `HEATMAP` records named `heatmap:<module>`, summed over ranks by
 * bin. Null when there is no such record, or when the records disagree on the
 * bin width or carry none (`reason` says which).
 */
export function parseHeatmap(text: string, key: string): { heatmap: Heatmap | null; reason?: string } {
	let width: number | null = null;
	let mismatch = false;
	const read: number[] = [];
	const write: number[] = [];
	let seen = false;
	for (const line of text.split("\n")) {
		if (!line.startsWith("HEATMAP\t")) continue;
		const fields = line.split("\t");
		const name = fields[5] ?? "";
		if (!name.startsWith("heatmap:") || moduleKey(name.slice("heatmap:".length)) !== key) continue;
		const counter = fields[3] ?? "";
		const value = counterValue(fields[4]);
		if (counter === "HEATMAP_F_BIN_WIDTH_SECONDS") {
			seen = true;
			if (value === null || value <= 0) continue;
			if (width !== null && Math.abs(width - value) > 1e-9) mismatch = true;
			width = width ?? value;
			continue;
		}
		const bin = /^HEATMAP_(READ|WRITE)_BIN_(\d+)$/u.exec(counter);
		if (bin === null) continue;
		const index = Number(bin[2]);
		if (index > MAX_HEATMAP_BIN) continue;
		const target = bin[1] === "READ" ? read : write;
		while (target.length <= index) target.push(0);
		target[index] = (target[index] ?? 0) + (value ?? 0);
		seen = true;
	}
	if (!seen) return { heatmap: null };
	if (mismatch) return { heatmap: null, reason: "the heatmap records of different ranks have different bin widths" };
	if (width === null) return { heatmap: null, reason: "the heatmap records carry no bin width" };
	const bins = Math.max(read.length, write.length);
	while (read.length < bins) read.push(0);
	while (write.length < bins) write.push(0);
	return { heatmap: { binWidthSeconds: width, readBytes: read, writeBytes: write } };
}

/** One DXT trace segment: an access, its size and when it ran, in seconds from the job start. */
export interface DxtSegment {
	module: "POSIX" | "MPIIO";
	rank: number;
	operation: "read" | "write";
	offset: number;
	lengthBytes: number;
	startSeconds: number;
	endSeconds: number;
}

/** Whether a darshan-dxt-parser line is a trace segment. */
export function isDxtSegmentLine(line: string): boolean {
	return /^\s*X_(?:POSIX|MPIIO)\s/u.test(line);
}

/**
 * The segments in darshan-dxt-parser output. A line beginning `X_POSIX` or
 * `X_MPIIO` that does not have module, rank, operation, segment, offset,
 * length, start and end is skipped and counted.
 */
export function parseDxtSegments(text: string): { segments: DxtSegment[]; malformedLines: number } {
	const segments: DxtSegment[] = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (!isDxtSegmentLine(line)) continue;
		const [module, rankText, operation, segmentText, offsetText, lengthText, startText, endText] = line
			.trim()
			.split(/\s+/u);
		const rank = /^-?\d+$/u.test(rankText ?? "") ? Number(rankText) : null;
		const offset = wholeNumber(offsetText);
		const lengthBytes = wholeNumber(lengthText);
		const startSeconds = decimal(startText);
		const endSeconds = decimal(endText);
		if (
			rank === null ||
			(operation !== "read" && operation !== "write") ||
			wholeNumber(segmentText) === null ||
			offset === null ||
			lengthBytes === null ||
			startSeconds === null ||
			endSeconds === null
		) {
			malformedLines++;
			continue;
		}
		segments.push({
			module: module === "X_POSIX" ? "POSIX" : "MPIIO",
			rank,
			operation,
			offset,
			lengthBytes,
			startSeconds,
			endSeconds: Math.max(startSeconds, endSeconds),
		});
	}
	return { segments, malformedLines };
}

/** The first line of `darshan-parser --version` when it is a version number, else null. */
export function parseVersion(text: string): string | null {
	const first = text.trim().split("\n")[0]?.trim() ?? "";
	return /^\d+(?:\.\d+)+(?:[-.]?[A-Za-z0-9]+)*$/u.test(first) ? first : null;
}
