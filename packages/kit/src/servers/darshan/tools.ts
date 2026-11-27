// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The darshan server's four tools. Each reads one Darshan log through
 * `darshan-parser` (and `darshan-dxt-parser` for DXT traces) and changes
 * nothing. Summaries come from the parser's aggregate modes; only
 * `darshan_files` and `darshan_timeline` read the full record output, kept to
 * the lines they need and capped, and say when it was cut. A counter Darshan
 * did not record is null with its reason under `unavailable`, never -1 or 0.
 */
import path from "node:path";
import { defineTool } from "@pancode/sdk/tool";
import { type RunCommandResult, runCommand } from "../../exec.js";
import {
	type Counter,
	type DarshanHeader,
	type DxtSegment,
	type FileRecord,
	isDxtSegmentLine,
	isRecordLine,
	moduleKey,
	parseDxtSegments,
	parseFileCounts,
	parseHeader,
	parseHeatmap,
	parseIncomplete,
	parseMounts,
	parsePerf,
	parseRecords,
	parseTotals,
	parseVersion,
} from "./parse.js";

export const PARSER = "darshan-parser";
export const DXT_PARSER = "darshan-dxt-parser";
export const MAX_MOUNTS = 64;
export const MAX_FILES = 100;
const DEFAULT_FILES = 20;
export const MAX_COUNTERS = 600;
export const MAX_BINS = 500;
const AGGREGATE_TIMEOUT_MS = 120_000;
const RECORD_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
const AGGREGATE_OUTPUT_BYTES = 8 * 1024 * 1024;
/** The record output `darshan_files` and `darshan_timeline` keep, after dropping the lines they do not need. */
export const RECORD_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;

/** A log path: not empty, no control character, and not beginning with `-`, so it can never be read as an option. */
const PATH_PATTERN = "^[^-\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$";
const PATH_REGEX = new RegExp(PATH_PATTERN, "u");
const MODULE_PATTERN = "^[A-Z][A-Z0-9_]{0,31}$";
const MODULE_REGEX = new RegExp(MODULE_PATTERN, "u");

/** Modules whose file records carry the counters `darshan_files` ranks by. */
const FILE_MODULES = ["POSIX", "MPIIO", "STDIO"] as const;
type FileModule = (typeof FILE_MODULES)[number];
const METRICS = ["bytesRead", "bytesWritten", "readTime", "writeTime", "metaTime", "opens"] as const;
type Metric = (typeof METRICS)[number];

const MISSING_PROGRAM = (program: string) =>
	`${program} is not on PATH; the darshan server needs ${program} from darshan-util to read Darshan logs`;

const pathSchema = {
	type: "string",
	minLength: 1,
	maxLength: MAX_PATH_LENGTH,
	pattern: PATH_PATTERN,
	description: "The Darshan log file (.darshan), relative to the server's working directory. Must not begin with '-'.",
} as const;

const fileModuleSchema = {
	type: "string",
	enum: [...FILE_MODULES],
	description: "The Darshan module: POSIX, MPIIO (Darshan's MPI-IO) or STDIO. Default POSIX.",
} as const;

/** The log path to pass on argv, absolute, or the reason it is refused. Nothing is spawned for a refused path. */
function checkPath(value: unknown): { ok: true; path: string } | { ok: false; reason: string } {
	if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "path must be a non-empty string" };
	if (value.length > MAX_PATH_LENGTH) return { ok: false, reason: `path is longer than ${MAX_PATH_LENGTH} characters` };
	if (value.startsWith("-")) return { ok: false, reason: "path must not begin with '-'" };
	if (!PATH_REGEX.test(value)) return { ok: false, reason: "path must not contain control characters" };
	return { ok: true, path: path.resolve(value) };
}

type Output = { ok: true; stdout: string; truncated: boolean } | { ok: false; error: string; missing: boolean };

function firstLine(result: RunCommandResult): string {
	return (result.stderr.trim() || result.stdout.trim()).split("\n")[0]?.trim() ?? "";
}

/** A Darshan program's stdout through exec.ts with `LC_ALL=C`, or the error the tool reports. */
async function run(
	program: string,
	args: ReadonlyArray<string>,
	options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number; keepLine?: (line: string) => boolean },
): Promise<Output> {
	const result = await runCommand(program, args, {
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
		signal: options.signal,
		env: { LC_ALL: "C" },
		...(options.keepLine !== undefined ? { keepLine: options.keepLine } : {}),
	});
	switch (result.kind) {
		case "ok":
			return { ok: true, stdout: result.stdout, truncated: result.truncated };
		case "not-found":
			return { ok: false, error: MISSING_PROGRAM(program), missing: true };
		case "timeout":
			return {
				ok: false,
				error: `${program} timed out: it did not finish within ${options.timeoutMs / 1000} seconds`,
				missing: false,
			};
		case "exit": {
			const detail = firstLine(result);
			return {
				ok: false,
				error: detail.length > 0 ? `${program}: ${detail}` : `${program} exited with ${result.code ?? result.signal}`,
				missing: false,
			};
		}
		default:
			return { ok: false, error: result.message ?? `${program} did not run (${result.kind})`, missing: false };
	}
}

/** `<program> --version`, or null with the reason. A missing program is the caller's error. */
async function version(
	program: string,
	signal: AbortSignal,
): Promise<{ ok: true; version: string | null; reason?: string } | { ok: false; error: string }> {
	const output = await run(program, ["--version"], {
		signal,
		timeoutMs: VERSION_TIMEOUT_MS,
		maxOutputBytes: 64 * 1024,
	});
	if (!output.ok) {
		if (output.missing) return { ok: false, error: output.error };
		return { ok: true, version: null, reason: output.error };
	}
	const parsed = parseVersion(output.stdout);
	return parsed === null
		? { ok: true, version: null, reason: `${program} --version printed no version number` }
		: { ok: true, version: parsed };
}

const CUT_NOTE = (program: string, bytes: number) =>
	`${program} printed more than ${Math.round(bytes / (1024 * 1024))} MiB of the lines this tool reads, so the figures cover only part of the log.`;
const LOWER_BOUND_NOTE = (name: string) =>
	`Darshan ran out of memory for ${name} records while the job ran, so the ${name} figures are lower bounds.`;

/** Darshan's own name for the module `key`, as the log's region table lists it, or null when the log has none. */
function logModuleName(header: DarshanHeader, key: string): string | null {
	return header.modules.find((module) => moduleKey(module.name) === key)?.name ?? null;
}

function absentModule(header: DarshanHeader, key: string): string {
	const present = header.modules.map((module) => module.name);
	return `the log has no ${key} module data; it has ${present.length > 0 ? present.join(", ") : "no modules"}`;
}

/** The counters behind each per-file and per-module figure, for a module whose counters are prefixed `key`. */
function figureCounters(key: string): Record<Metric, string[]> {
	return {
		bytesRead: [`${key}_BYTES_READ`],
		bytesWritten: [`${key}_BYTES_WRITTEN`],
		readTime: [`${key}_F_READ_TIME`],
		writeTime: [`${key}_F_WRITE_TIME`],
		metaTime: [`${key}_F_META_TIME`],
		opens: key === "MPIIO" ? ["MPIIO_INDEP_OPENS", "MPIIO_COLL_OPENS"] : [`${key}_OPENS`],
	};
}

const FIGURE_FIELDS: Record<Metric, string> = {
	bytesRead: "bytesRead",
	bytesWritten: "bytesWritten",
	readTime: "readTimeSeconds",
	writeTime: "writeTimeSeconds",
	metaTime: "metaTimeSeconds",
	opens: "opens",
};

/** The sum of `names` in `lookup`, or null with the reason when one was not printed or not recorded. */
function sumCounters(
	names: ReadonlyArray<string>,
	lookup: (name: string) => number | null | undefined,
	source: string,
): { value: number | null; reason?: string } {
	let sum = 0;
	for (const name of names) {
		const value = lookup(name);
		if (value === undefined) return { value: null, reason: `${source} prints no ${name} counter` };
		if (value === null) return { value: null, reason: `Darshan did not record ${name} (-1)` };
		sum += value;
	}
	return { value: sum };
}

/** Figures and unavailable reasons for one set of counters. */
function figures(
	key: string,
	lookup: (name: string) => number | null | undefined,
	source: string,
): { values: Record<string, number | null>; unavailable: Record<string, string> } {
	const values: Record<string, number | null> = {};
	const unavailable: Record<string, string> = {};
	const counters = figureCounters(key);
	for (const metric of METRICS) {
		const field = FIGURE_FIELDS[metric];
		const { value, reason } = sumCounters(counters[metric], lookup, source);
		values[field] = value;
		if (reason !== undefined) unavailable[field] = reason;
	}
	return { values, unavailable };
}

export interface DarshanLimits {
	/** Bytes of kept record output `darshan_files` and `darshan_timeline` read. */
	recordOutputBytes: number;
}

/** The four tools; `limits` exists so a test can reach the output cap without printing 64 MiB. */
export function createDarshanTools(limits: Partial<DarshanLimits> = {}) {
	const recordOutputBytes = limits.recordOutputBytes ?? RECORD_OUTPUT_BYTES;

	const darshanSummary = defineTool({
		name: "darshan_summary",
		title: "Darshan log summary",
		description: `Returns what one Darshan log says about a job's I/O: log format version, executable path (never its arguments), uid, job id, start and end time in epoch seconds, process count and run time; the mounted file systems (at most ${MAX_MOUNTS}); the modules present and which ran out of record memory; and per module the bytes read and written, read, write and metadata seconds, opens, files accessed and the aggregate rate darshan-parser --perf estimates in bytes per second. Prefer it over running darshan-parser in a shell: it reads only the parser's small summary modes, never the full record output, and every figure is a number with its unit in the field name.`,
		input: { type: "object", properties: { path: pathSchema }, required: ["path"] },
		actionClass: "read",
		idempotent: true,
		pathArguments: { path: "read" },
		async run(args: { path: string }, context) {
			const checked = checkPath(args.path);
			if (!checked.ok) return { error: `darshan_summary: ${checked.reason}` };
			const programVersion = await version(PARSER, context.signal);
			if (!programVersion.ok) return { error: `darshan_summary: ${programVersion.error}` };
			const aggregate = (mode: string) =>
				run(PARSER, ["--show-incomplete", mode, checked.path], {
					signal: context.signal,
					timeoutMs: AGGREGATE_TIMEOUT_MS,
					maxOutputBytes: AGGREGATE_OUTPUT_BYTES,
				});
			const [total, perf, file] = await Promise.all([aggregate("--total"), aggregate("--perf"), aggregate("--file")]);
			if (!total.ok) return { error: `darshan_summary: ${total.error}` };
			if (!perf.ok) return { error: `darshan_summary: ${perf.error}` };
			if (!file.ok) return { error: `darshan_summary: ${file.error}` };
			const header = parseHeader(total.stdout);
			if (header === null) return { error: `darshan_summary: ${PARSER} printed no Darshan log header` };

			const unavailable: Record<string, string> = {};
			const notes: string[] = [];
			if (programVersion.version === null && programVersion.reason !== undefined)
				unavailable.programVersion = programVersion.reason;
			const job = {
				executable: header.executable,
				uid: header.uid,
				jobId: header.jobId,
				startTime: header.startTime,
				endTime: header.endTime,
				processCount: header.processCount,
				runTimeSeconds: header.runTimeSeconds,
			};
			const headerLines: Record<string, string> = {
				executable: "exe",
				uid: "uid",
				jobId: "jobid",
				startTime: "start_time",
				endTime: "end_time",
				processCount: "nprocs",
				runTimeSeconds: "run time",
			};
			for (const [field, value] of Object.entries(job))
				if (value === null) unavailable[`job.${field}`] = `the log header has no readable ${headerLines[field]} line`;
			if (header.logFormatVersion === null) unavailable.logFormatVersion = "the log header names no format version";
			if (header.libraryVersion === null)
				unavailable.libraryVersion = "the log header names no Darshan runtime version (metadata lib_ver)";

			const mounts = parseMounts(total.stdout);
			const incomplete = [
				...new Set([...parseIncomplete(total.stdout), ...parseIncomplete(perf.stdout), ...parseIncomplete(file.stdout)]),
			];
			for (const name of incomplete) notes.push(LOWER_BOUND_NOTE(name));
			const totals = parseTotals(total.stdout);
			const perfs = parsePerf(perf.stdout);
			const fileCounts = parseFileCounts(file.stdout);
			const modules = [...totals.modules].map(([name, counters]) => {
				const key = moduleKey(name);
				const byName = new Map(counters.map((counter) => [counter.name, counter.value]));
				const { values, unavailable: missing } = figures(key, (counter) => byName.get(counter), `${PARSER} --total`);
				const files = fileCounts.get(name);
				if (files === undefined || files === null)
					missing.filesAccessed = `${PARSER} --file prints no file count for ${name}`;
				const estimate = perfs.get(name);
				const rate = estimate?.aggregateRateBytesPerSecond ?? null;
				if (rate === null)
					missing.aggregateRateBytesPerSecond = estimate?.rateReason ?? `${PARSER} --perf prints no estimate for ${name}`;
				return {
					name,
					incomplete: incomplete.includes(name),
					...values,
					filesAccessed: files ?? null,
					aggregateRateBytesPerSecond: rate,
					unavailable: missing,
				};
			});
			return {
				json: {
					path: checked.path,
					program: PARSER,
					programVersion: programVersion.version,
					logFormatVersion: header.logFormatVersion,
					libraryVersion: header.libraryVersion,
					job,
					mounts: mounts.slice(0, MAX_MOUNTS),
					mountCount: mounts.length,
					mountCap: MAX_MOUNTS,
					mountsTruncated: mounts.length > MAX_MOUNTS,
					modulesPresent: header.modules.map((module) => module.name),
					incompleteModules: incomplete,
					modules,
					complete: !(total.truncated || perf.truncated || file.truncated),
					...(total.truncated || perf.truncated || file.truncated
						? { notes: [...notes, CUT_NOTE(PARSER, AGGREGATE_OUTPUT_BYTES)] }
						: { notes }),
					malformedLines: totals.malformedLines,
					unavailable,
				},
			};
		},
	});

	const darshanFiles = defineTool({
		name: "darshan_files",
		title: "Darshan per-file I/O",
		description: `Returns the top files of one Darshan module (POSIX by default, MPIIO or STDIO) in one log, ranked by bytes read, bytes written, read, write or metadata seconds, or opens (limit, default ${DEFAULT_FILES}, at most ${MAX_FILES}), each with its path, mount point, file system type and those counters summed over ranks. Prefer it over running darshan-parser --base in a shell: that output can be hundreds of megabytes, while this reads only the module's lines, caps what it keeps, and says when the figures cover only part of the log.`,
		input: {
			type: "object",
			properties: {
				path: pathSchema,
				module: fileModuleSchema,
				metric: {
					type: "string",
					enum: [...METRICS],
					description: "Rank files by bytesRead, bytesWritten, readTime, writeTime, metaTime or opens. Default bytesRead.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_FILES,
					description: `How many files to return, 1 to ${MAX_FILES}. Default ${DEFAULT_FILES}.`,
				},
			},
			required: ["path"],
		},
		actionClass: "read",
		idempotent: true,
		pathArguments: { path: "read" },
		async run(args: { path: string; module?: string; metric?: string; limit?: number }, context) {
			const checked = checkPath(args.path);
			if (!checked.ok) return { error: `darshan_files: ${checked.reason}` };
			const key = (args.module ?? "POSIX") as FileModule;
			if (!FILE_MODULES.includes(key)) return { error: "darshan_files: module must be POSIX, MPIIO or STDIO" };
			const metric = (args.metric ?? "bytesRead") as Metric;
			if (!METRICS.includes(metric)) return { error: `darshan_files: metric must be one of ${METRICS.join(", ")}` };
			if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isFinite(args.limit)))
				return { error: "darshan_files: limit must be an integer" };
			const limit = Math.min(MAX_FILES, Math.max(1, Math.floor(args.limit ?? DEFAULT_FILES)));
			const programVersion = await version(PARSER, context.signal);
			if (!programVersion.ok) return { error: `darshan_files: ${programVersion.error}` };
			const output = await run(PARSER, ["--show-incomplete", "--base", checked.path], {
				signal: context.signal,
				timeoutMs: RECORD_TIMEOUT_MS,
				maxOutputBytes: recordOutputBytes,
				keepLine: (line) => line.startsWith("#") || isRecordLine(line, key),
			});
			if (!output.ok) return { error: `darshan_files: ${output.error}` };
			const header = parseHeader(output.stdout);
			if (header === null) return { error: `darshan_files: ${PARSER} printed no Darshan log header` };
			const unavailable: Record<string, string> = {};
			if (programVersion.version === null && programVersion.reason !== undefined)
				unavailable.programVersion = programVersion.reason;
			const notes: string[] = [];
			if (output.truncated) notes.push(CUT_NOTE(PARSER, recordOutputBytes));
			const name = logModuleName(header, key);
			const incomplete = name !== null && parseIncomplete(output.stdout).includes(name);
			if (incomplete && name !== null) notes.push(LOWER_BOUND_NOTE(name));
			const base = {
				path: checked.path,
				program: PARSER,
				programVersion: programVersion.version,
				module: name ?? key,
				metric,
				limit,
				cap: MAX_FILES,
			};
			if (name === null) {
				unavailable.files = absentModule(header, key);
				return {
					json: { ...base, files: null, total: null, truncated: false, complete: !output.truncated, notes, unavailable },
				};
			}
			const { records, malformedLines } = parseRecords(output.stdout, key);
			if (records.length === 0 && output.truncated) {
				unavailable.files = `${PARSER}'s output was cut before any ${name} record`;
				return { json: { ...base, files: null, total: null, truncated: false, complete: false, notes, unavailable } };
			}
			const rows = fileRows(records, key);
			const field = FIGURE_FIELDS[metric];
			rows.sort((a, b) => {
				const left = a[field] as number | null;
				const right = b[field] as number | null;
				if (left === right) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
				if (left === null) return 1;
				if (right === null) return -1;
				return right - left;
			});
			return {
				json: {
					...base,
					files: rows.slice(0, limit),
					total: rows.length,
					truncated: rows.length > limit,
					complete: !output.truncated,
					incomplete,
					notes,
					malformedLines,
					unavailable,
				},
			};
		},
	});

	const darshanModules = defineTool({
		name: "darshan_modules",
		title: "Darshan module counters",
		description: `Returns every counter of one Darshan module in one log as darshan-parser --total prints it, summed over files and ranks: the counter's own name and its number, null where Darshan did not record it (at most ${MAX_COUNTERS} counters). Prefer it over running darshan-parser --total in a shell: it reads only the totals, returns numbers instead of text, and says when the module ran out of record memory.`,
		input: {
			type: "object",
			properties: {
				path: pathSchema,
				module: {
					type: "string",
					pattern: MODULE_PATTERN,
					description:
						"The Darshan module, upper case without punctuation: POSIX, MPIIO, STDIO, H5F, H5D, PNETCDF_FILE and so on. Default POSIX.",
				},
			},
			required: ["path"],
		},
		actionClass: "read",
		idempotent: true,
		pathArguments: { path: "read" },
		async run(args: { path: string; module?: string }, context) {
			const checked = checkPath(args.path);
			if (!checked.ok) return { error: `darshan_modules: ${checked.reason}` };
			const key = args.module ?? "POSIX";
			if (typeof key !== "string" || !MODULE_REGEX.test(key))
				return { error: `darshan_modules: module must match ${MODULE_PATTERN}` };
			const programVersion = await version(PARSER, context.signal);
			if (!programVersion.ok) return { error: `darshan_modules: ${programVersion.error}` };
			const output = await run(PARSER, ["--show-incomplete", "--total", checked.path], {
				signal: context.signal,
				timeoutMs: AGGREGATE_TIMEOUT_MS,
				maxOutputBytes: AGGREGATE_OUTPUT_BYTES,
			});
			if (!output.ok) return { error: `darshan_modules: ${output.error}` };
			const header = parseHeader(output.stdout);
			if (header === null) return { error: `darshan_modules: ${PARSER} printed no Darshan log header` };
			const unavailable: Record<string, string> = {};
			if (programVersion.version === null && programVersion.reason !== undefined)
				unavailable.programVersion = programVersion.reason;
			const notes: string[] = [];
			if (output.truncated) notes.push(CUT_NOTE(PARSER, AGGREGATE_OUTPUT_BYTES));
			const name = logModuleName(header, key);
			const base = { path: checked.path, program: PARSER, programVersion: programVersion.version, cap: MAX_COUNTERS };
			const totals = parseTotals(output.stdout);
			const entry = [...totals.modules].find(([section]) => moduleKey(section) === key);
			if (entry === undefined) {
				unavailable.counters =
					name === null ? absentModule(header, key) : `${PARSER} --total prints no totals for the ${name} module`;
				return {
					json: {
						...base,
						module: name ?? key,
						counters: null,
						total: null,
						truncated: false,
						complete: !output.truncated,
						notes,
						unavailable,
					},
				};
			}
			const [section, counters] = entry;
			const incomplete = parseIncomplete(output.stdout).includes(section);
			if (incomplete) notes.push(LOWER_BOUND_NOTE(section));
			return {
				json: {
					...base,
					module: section,
					counters: counters.slice(0, MAX_COUNTERS) satisfies Counter[],
					total: counters.length,
					truncated: counters.length > MAX_COUNTERS,
					complete: !output.truncated,
					incomplete,
					notes,
					malformedLines: totals.malformedLines,
					unavailable,
				},
			};
		},
	});

	const darshanTimeline = defineTool({
		name: "darshan_timeline",
		title: "Darshan I/O timeline",
		description: `Returns the bytes one Darshan module (POSIX by default, MPIIO or STDIO) read and wrote in each time bin of a job (at most ${MAX_BINS} bins, with the bin width in seconds and each bin's offset from the job start), from the log's heatmap records when it has them and otherwise from its DXT trace through darshan-dxt-parser; a log with neither returns available false and the reason. Prefer it over reading darshan-parser or darshan-dxt-parser output in a shell: it keeps only the lines it needs, merges bins to fit the cap, and says when the output was cut.`,
		input: {
			type: "object",
			properties: { path: pathSchema, module: fileModuleSchema },
			required: ["path"],
		},
		actionClass: "read",
		idempotent: true,
		pathArguments: { path: "read" },
		async run(args: { path: string; module?: string }, context) {
			const checked = checkPath(args.path);
			if (!checked.ok) return { error: `darshan_timeline: ${checked.reason}` };
			const key = (args.module ?? "POSIX") as FileModule;
			if (!FILE_MODULES.includes(key)) return { error: "darshan_timeline: module must be POSIX, MPIIO or STDIO" };
			const programVersion = await version(PARSER, context.signal);
			if (!programVersion.ok) return { error: `darshan_timeline: ${programVersion.error}` };
			const output = await run(PARSER, ["--show-incomplete", "--base", checked.path], {
				signal: context.signal,
				timeoutMs: RECORD_TIMEOUT_MS,
				maxOutputBytes: recordOutputBytes,
				keepLine: (line) => line.startsWith("#") || line.startsWith("HEATMAP\t"),
			});
			if (!output.ok) return { error: `darshan_timeline: ${output.error}` };
			const header = parseHeader(output.stdout);
			if (header === null) return { error: `darshan_timeline: ${PARSER} printed no Darshan log header` };
			const name = logModuleName(header, key) ?? key;
			const reasons: string[] = [];
			const { heatmap, reason } = parseHeatmap(output.stdout, key);
			if (heatmap !== null) {
				const timeline = coarsen(heatmap.binWidthSeconds, heatmap.readBytes, heatmap.writeBytes);
				const unavailable: Record<string, string> = {};
				if (programVersion.version === null && programVersion.reason !== undefined)
					unavailable.programVersion = programVersion.reason;
				return {
					json: {
						available: true,
						path: checked.path,
						program: PARSER,
						programVersion: programVersion.version,
						module: name,
						source: "heatmap",
						jobStartTime: header.startTime,
						...timeline,
						complete: !output.truncated,
						notes: output.truncated ? [CUT_NOTE(PARSER, recordOutputBytes)] : [],
						unavailable,
					},
				};
			}
			if (reason !== undefined) reasons.push(reason);
			else if (logModuleName(header, "HEATMAP") === null) reasons.push("the log has no HEATMAP module data");
			else if (output.truncated)
				reasons.push(`${PARSER}'s output was cut at ${recordOutputBytes} bytes before the heatmap records`);
			else reasons.push(`the log's heatmap has no records for ${name}`);

			const dxtName = key === "STDIO" ? null : logModuleName(header, `DXT_${key}`);
			if (dxtName === null) {
				reasons.push(key === "STDIO" ? "Darshan keeps no DXT trace of STDIO" : `the log has no DXT_${key} trace`);
				return {
					json: {
						available: false,
						reason: `${reasons.join("; ")}. A timeline needs a log recorded with Darshan's HEATMAP module or with DXT tracing enabled.`,
						path: checked.path,
						module: name,
					},
				};
			}
			context.progress(1, 2, `no heatmap for ${name}; reading the DXT trace with ${DXT_PARSER}`);
			const dxtVersion = await version(DXT_PARSER, context.signal);
			if (!dxtVersion.ok)
				return {
					json: { available: false, reason: `${reasons.join("; ")}; ${dxtVersion.error}`, path: checked.path, module: name },
				};
			const dxt = await run(DXT_PARSER, ["--show-incomplete", checked.path], {
				signal: context.signal,
				timeoutMs: RECORD_TIMEOUT_MS,
				maxOutputBytes: recordOutputBytes,
				keepLine: isDxtSegmentLine,
			});
			if (!dxt.ok) return { error: `darshan_timeline: ${dxt.error}` };
			const { segments, malformedLines } = parseDxtSegments(dxt.stdout);
			const mine = segments.filter((segment) => segment.module === key);
			if (mine.length === 0) {
				return {
					json: {
						available: false,
						reason: `${reasons.join("; ")}; ${DXT_PARSER} printed no ${dxtName} segment${dxt.truncated ? " before its output was cut" : ""}`,
						path: checked.path,
						module: name,
					},
				};
			}
			const unavailable: Record<string, string> = {};
			if (dxtVersion.version === null && dxtVersion.reason !== undefined) unavailable.programVersion = dxtVersion.reason;
			const notes = ["Each DXT segment's bytes count in the bin where the segment started."];
			if (dxt.truncated) notes.push(CUT_NOTE(DXT_PARSER, recordOutputBytes));
			return {
				json: {
					available: true,
					path: checked.path,
					program: DXT_PARSER,
					programVersion: dxtVersion.version,
					module: name,
					source: "dxt",
					jobStartTime: header.startTime,
					...binSegments(mine, header.runTimeSeconds),
					complete: !dxt.truncated,
					notes,
					malformedLines,
					unavailable,
				},
			};
		},
	});

	return [darshanSummary, darshanFiles, darshanModules, darshanTimeline];
}

interface FileRow {
	path: string;
	mountPoint: string;
	fsType: string;
	/** True when Darshan recorded the file as shared by every rank (rank -1). */
	shared: boolean;
	/** How many rank records were summed. */
	records: number;
	[figure: string]: unknown;
}

/** One row per file, its counters summed over the rank records; a counter one record lacks makes the sum null. */
function fileRows(records: ReadonlyArray<FileRecord>, key: string): FileRow[] {
	const byFile = new Map<string, FileRecord[]>();
	for (const record of records) {
		const group = byFile.get(record.recordId) ?? [];
		group.push(record);
		byFile.set(record.recordId, group);
	}
	return [...byFile.values()].map((group) => {
		const first = group[0] as FileRecord;
		const values: Record<string, number | null> = {};
		const unavailable: Record<string, string> = {};
		for (const record of group) {
			const part = figures(key, (name) => record.counters.get(name), "the record");
			for (const [field, value] of Object.entries(part.values)) {
				const before = Object.hasOwn(values, field) ? values[field] : 0;
				values[field] = before === null || before === undefined || value === null ? null : before + value;
			}
			for (const [field, reason] of Object.entries(part.unavailable)) unavailable[field] ??= reason;
		}
		return {
			path: first.path,
			mountPoint: first.mountPoint,
			fsType: first.fsType,
			shared: group.some((record) => record.rank === -1),
			records: group.length,
			...values,
			...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
		};
	});
}

interface Timeline {
	binWidthSeconds: number;
	sourceBinWidthSeconds: number;
	bins: Array<{ offsetSeconds: number; readBytes: number; writeBytes: number }>;
	binCount: number;
	binCap: number;
	/** True when adjacent bins were merged to fit `binCap`. */
	coarsened: boolean;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Merge adjacent bins by a whole factor until at most `MAX_BINS` remain. */
function coarsen(width: number, read: ReadonlyArray<number>, write: ReadonlyArray<number>): Timeline {
	const factor = Math.max(1, Math.ceil(read.length / MAX_BINS));
	const bins: Timeline["bins"] = [];
	for (let start = 0; start < read.length; start += factor) {
		let readBytes = 0;
		let writeBytes = 0;
		for (let index = start; index < Math.min(read.length, start + factor); index++) {
			readBytes += read[index] ?? 0;
			writeBytes += write[index] ?? 0;
		}
		bins.push({ offsetSeconds: round((start / factor) * width * factor), readBytes, writeBytes });
	}
	return {
		binWidthSeconds: round(width * factor),
		sourceBinWidthSeconds: width,
		bins,
		binCount: bins.length,
		binCap: MAX_BINS,
		coarsened: factor > 1,
	};
}

const WIDTH_STEPS = [1, 2, 5];

/** The smallest width of the form {1,2,5}×10^n seconds that covers `span` in at most `MAX_BINS` bins. */
function binWidth(span: number): number {
	for (let exponent = -4; exponent < 12; exponent++) {
		for (const step of WIDTH_STEPS) {
			const width = step * 10 ** exponent;
			if (Math.ceil(span / width) <= MAX_BINS) return Number(width.toPrecision(1));
		}
	}
	return span;
}

/** DXT segments summed into time bins, each segment in the bin where it started. */
function binSegments(segments: ReadonlyArray<DxtSegment>, runTimeSeconds: number | null): Timeline {
	const span = Math.max(runTimeSeconds ?? 0, ...segments.map((segment) => segment.endSeconds));
	const width = binWidth(span > 0 ? span : 1);
	const count = Math.max(1, Math.min(MAX_BINS, Math.ceil(span / width)));
	const read = new Array<number>(count).fill(0);
	const write = new Array<number>(count).fill(0);
	for (const segment of segments) {
		const index = Math.min(count - 1, Math.floor(segment.startSeconds / width));
		const target = segment.operation === "read" ? read : write;
		target[index] = (target[index] ?? 0) + segment.lengthBytes;
	}
	return coarsen(width, read, write);
}

export const DARSHAN_TOOLS = createDarshanTools();
