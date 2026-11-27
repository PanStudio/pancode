// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The scidata server's three tools, each one call into `@pancode/scidata`
 * with the `data` tool's argument names. A result is the library's object
 * with its notes in this server's words; a refusal is a tool error in those
 * words too (kitWords); a result
 * over MAX_RESULT_BYTES of JSON is a tool error naming the argument that
 * narrows it, never a cut result.
 */
import path from "node:path";
import { DATA_FORMATS, type DataRefusal, type InspectDataOptions, isDataRefusal } from "@pancode/scidata";
import { defineTool, type JsonSchema, type ToolResult } from "@pancode/sdk/tool";
import { scidata } from "./runtime.js";

export const MAX_RESULT_BYTES = 256 * 1024;

/** SQLite needs a reader this server does not supply; a SQLite file still gets the library's own refusal. */
export const SCIDATA_FORMATS = DATA_FORMATS.filter((format) => format !== "sqlite");

const SCIENTIFIC = new Set(["hdf5", "netcdf", "parquet", "zarr", "adios2"]);

type Args = Record<string, unknown>;

/** One argument: its schema as listed, and the same rule checked again in `run`. */
interface Argument {
	schema: JsonSchema;
	check(value: unknown): string | null;
}

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function stringArgument(description: string, minLength = 0): Argument {
	return {
		schema: { type: "string", ...(minLength > 0 ? { minLength } : {}), description },
		check: (value) =>
			typeof value !== "string"
				? "must be a string"
				: value.length < minLength
					? `must be at least ${minLength} character long`
					: null,
	};
}

function integerArgument(description: string, minimum: number, nullable = false): Argument {
	return {
		schema: { type: nullable ? ["integer", "null"] : "integer", minimum, description },
		check: (value) =>
			nullable && value === null
				? null
				: isInteger(value) && value >= minimum
					? null
					: `must be an integer >= ${minimum}${nullable ? " or null" : ""}`,
	};
}

function integerListArgument(description: string, minimum: number): Argument {
	return {
		schema: { type: "array", items: { type: "integer", minimum }, minItems: 1, description },
		check: (value) =>
			Array.isArray(value) && value.length > 0 && value.every((item) => isInteger(item) && item >= minimum)
				? null
				: `must be a non-empty array of integers >= ${minimum}`,
	};
}

const ARGUMENTS = {
	path: stringArgument(
		"The data file, Zarr store or ADIOS2 .bp directory; relative to the server's working directory or absolute.",
		1,
	),
	format: {
		schema: {
			type: "string",
			enum: SCIDATA_FORMATS,
			description: `The format when the extension or content does not say: ${SCIDATA_FORMATS.join(", ")}.`,
		},
		check: (value) =>
			typeof value === "string" && (SCIDATA_FORMATS as ReadonlyArray<string>).includes(value)
				? null
				: `must be one of ${SCIDATA_FORMATS.join(", ")}`,
	},
	variable: stringArgument(
		"HDF5, NetCDF and Zarr: the variable or group path; ADIOS2: the variable name; Parquet stats: the column.",
	),
	delimiter: stringArgument("CSV and TSV: the one delimiter character, or \\t."),
	header: {
		schema: {
			type: ["boolean", "string"],
			enum: [true, false, "auto"],
			description: 'CSV and TSV: "auto" (default) detects a header row; true or false forces it.',
		},
		check: (value) => (typeof value === "boolean" || value === "auto" ? null : 'must be true, false or "auto"'),
	},
	sample_rows: integerArgument("Rows or top-level members kept as the sample: default 10, at most 1000.", 0),
	max_rows: integerArgument(
		"Rows scanned before the view becomes sampled: default 100000; null scans the whole file.",
		1,
		true,
	),
	offset: integerArgument("The 0-based first row, record or array element; Parquet stats: the first row.", 0),
	limit: integerArgument("Rows returned: default 50, at most 1000; Parquet stats: rows summarized (default all).", 1),
	columns: {
		schema: {
			type: "array",
			items: { type: ["string", "integer"] },
			minItems: 1,
			description: "CSV and TSV: header names or 0-based indices to project; Parquet: column names.",
		},
		check: (value) =>
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((item) => typeof item === "string" || (isInteger(item) && item >= 0))
				? null
				: "must be a non-empty array of column names or non-negative indices",
	},
	pointer: stringArgument('JSON: an RFC 6901 pointer to the value to return; "" is the whole document.'),
	start: integerListArgument("HDF5, NetCDF and Zarr: the 0-based first index per dimension (default 0).", 0),
	count: integerListArgument("HDF5, NetCDF and Zarr: elements per dimension (default: the rest of each dimension).", 1),
	stride: integerListArgument("HDF5, NetCDF and Zarr: the step per dimension (default 1).", 1),
	max_bytes: integerArgument(
		"Raw bytes read before the pass stops and reports itself partial: default 268435456, at most 8 GiB.",
		1,
	),
} satisfies Record<string, Argument>;

type ArgumentName = keyof typeof ARGUMENTS;

function inputSchema(names: ReadonlyArray<ArgumentName>) {
	return {
		type: "object" as const,
		properties: Object.fromEntries(names.map((name) => [name, ARGUMENTS[name].schema])),
		required: ["path"],
		additionalProperties: false,
	};
}

/** The schema's rules again, so a host that skips validation still cannot reach the library with a bad value. */
function checkArguments(tool: string, names: ReadonlyArray<ArgumentName>, args: Args): string | null {
	for (const key of Object.keys(args)) {
		if (!(names as ReadonlyArray<string>).includes(key)) return `${tool}: unknown argument ${key}`;
	}
	if (args.path === undefined) return `${tool}: path is required`;
	for (const name of names) {
		if (args[name] === undefined) continue;
		const problem = ARGUMENTS[name].check(args[name]);
		if (problem !== null) return `${tool}: ${name} ${problem}`;
	}
	return null;
}

/** The library options the `data` tool passes for the same arguments. */
function libraryOptions(args: Args, signal: AbortSignal) {
	const pick = <T>(name: ArgumentName) => args[name] as T | undefined;
	const when = <K extends string, T>(key: K, value: T | undefined) =>
		(value !== undefined ? { [key]: value } : {}) as Partial<Record<K, T>>;
	return {
		...when("format", pick<string>("format")),
		...when("variable", pick<string>("variable")),
		...when("delimiter", pick<string>("delimiter")),
		...when("header", pick<InspectDataOptions["header"]>("header")),
		...when("sampleRows", pick<number>("sample_rows")),
		...when("maxRows", pick<number | null>("max_rows")),
		...when("offset", pick<number>("offset")),
		...when("limit", pick<number>("limit")),
		...when("columns", pick<Array<string | number>>("columns")),
		...when("pointer", pick<string>("pointer")),
		...when("start", pick<number[]>("start")),
		...when("count", pick<number[]>("count")),
		...when("stride", pick<number[]>("stride")),
		...when("maxBytes", pick<number>("max_bytes")),
		signal,
	};
}

type Operation = "inspect" | "select" | "stats";

/** The argument that makes a result of this operation and format smaller. */
function narrowingArgument(operation: Operation, format: unknown, args: Args): string {
	const scientific = typeof format === "string" && SCIENTIFIC.has(format);
	if (operation === "inspect") return scientific ? "variable (inspect one variable or group)" : "sample_rows";
	if (operation === "stats") return "variable";
	if (format === "parquet") return "limit or columns";
	if (scientific) return "count (or stride)";
	if (format === "csv" || format === "tsv") return "limit or columns";
	if (format === "json") return args.pointer !== undefined ? "pointer or limit" : "limit or pointer";
	return "limit";
}

/**
 * The library's refusals and notes speak to PanCode's `data` tool (`op=select`,
 * `run_script`), which this server does not have. Its own words replace them;
 * only refusal text and `notes` are rewritten, never a value read from a file.
 */
const PANCODE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
	// This server serves no SQLite, so the SQL route is dropped rather than renamed.
	[/, or op=select with sql on SQLite/gu, ""],
	[/\bop=(inspect|select|stats)\b/gu, "scidata_$1"],
	[/\brun_script with\b/gu, "a script with"],
	[/\bthe data tool\b/gu, "this server"],
	[/^PanCode reads\b/u, "This server reads"],
];

export function kitWords(text: string): string {
	return PANCODE_WORDS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function withKitNotes(result: unknown): unknown {
	if (result === null || typeof result !== "object" || !("notes" in result)) return result;
	const { notes } = result as { notes: unknown };
	if (!Array.isArray(notes)) return result;
	return { ...result, notes: notes.map((note) => (typeof note === "string" ? kitWords(note) : note)) };
}

function refused(operation: Operation, refusal: DataRefusal): ToolResult {
	return { error: `${operation} refused (${refusal.reason}): ${kitWords(refusal.message)}` };
}

function returned(tool: string, operation: Operation, raw: unknown, args: Args): ToolResult {
	if (isDataRefusal(raw)) return refused(operation, raw);
	const result = withKitNotes(raw);
	const bytes = Buffer.byteLength(JSON.stringify(result) ?? "null", "utf8");
	if (bytes > MAX_RESULT_BYTES) {
		const format = (result as { format?: unknown }).format;
		return {
			error: `${tool}: the result is ${bytes} bytes of JSON, over the ${MAX_RESULT_BYTES} bytes (256 KiB) this server returns; narrow it with ${narrowingArgument(operation, format, args)}`,
		};
	}
	return { json: result };
}

const INSPECT_ARGUMENTS: ReadonlyArray<ArgumentName> = [
	"path",
	"format",
	"variable",
	"delimiter",
	"header",
	"sample_rows",
	"max_rows",
];
const SELECT_ARGUMENTS: ReadonlyArray<ArgumentName> = [
	"path",
	"format",
	"variable",
	"start",
	"count",
	"stride",
	"offset",
	"limit",
	"columns",
	"pointer",
	"delimiter",
	"header",
];
const STATS_ARGUMENTS: ReadonlyArray<ArgumentName> = [
	"path",
	"format",
	"variable",
	"start",
	"count",
	"stride",
	"offset",
	"limit",
	"max_bytes",
];

const FORMATS_TEXT =
	"CSV, TSV, JSON, JSON Lines, HDF5, NetCDF-4, classic NetCDF, Parquet, Zarr v2 and v3, and ADIOS2 BP4 and BP5 metadata";
const RESULT_CAP_TEXT = `A result over ${MAX_RESULT_BYTES} bytes (256 KiB) of JSON is refused with the argument that narrows it.`;
const READERS_TEXT =
	"HDF5, NetCDF-4 and Parquet readers are fetched once from the npm registry on first use, pinned by sha256 and cached.";

const scidataInspect = defineTool({
	name: "scidata_inspect",
	title: "Inspect a data file",
	description: `Returns the structure of one data file or store (${FORMATS_TEXT}): its format, groups, variables or columns with types, shapes and attributes, and a bounded sample (sample_rows, at most 1000), with a view that says whether the scan was exact or sampled. Prefer it over opening the file with h5dump, ncdump, head or a script: it streams without loading the file, reports large integers and sentinels instead of rounding or converting them, and refuses what it cannot read with a reason. ${READERS_TEXT} ${RESULT_CAP_TEXT}`,
	input: inputSchema(INSPECT_ARGUMENTS),
	actionClass: "read",
	pathArguments: { path: "read" },
	idempotent: true,
	async run(args: Args, context) {
		const problem = checkArguments("scidata_inspect", INSPECT_ARGUMENTS, args);
		if (problem !== null) return { error: problem };
		const result = await scidata().inspectData(path.resolve(args.path as string), libraryOptions(args, context.signal));
		return returned("scidata_inspect", "inspect", result, args);
	},
});

const scidataSelect = defineTool({
	name: "scidata_select",
	title: "Select data values",
	description: `Returns rows of a CSV, TSV, JSON Lines or Parquet file (offset and limit, at most 1000 rows; columns projects), a value of a JSON document (pointer), or a hyperslab of one HDF5, NetCDF or Zarr variable (start, count, stride; without count the first 200 elements, an explicit count over 2000 elements is refused), values raw as stored. Prefer it over printing the file in a shell: the window is bounded by its arguments, the result says whether there is more, and nothing is converted or guessed. ${READERS_TEXT} ${RESULT_CAP_TEXT}`,
	input: inputSchema(SELECT_ARGUMENTS),
	actionClass: "read",
	pathArguments: { path: "read" },
	idempotent: true,
	async run(args: Args, context) {
		const problem = checkArguments("scidata_select", SELECT_ARGUMENTS, args);
		if (problem !== null) return { error: problem };
		const result = await scidata().selectData(path.resolve(args.path as string), libraryOptions(args, context.signal));
		return returned("scidata_select", "select", result, args);
	},
});

const scidataStats = defineTool({
	name: "scidata_stats",
	title: "Data statistics",
	description: `Returns count, minimum, maximum, their indices, mean, population standard deviation and NaN, infinity, fill-value and missing-value counts for one HDF5, NetCDF or Zarr variable (over start, count, stride) or one Parquet column (variable, over offset and limit), with whether the pass was exact or stopped early at max_bytes or 60 seconds. Prefer it over a script that loads the variable: it streams in slabs under a byte cap and reports fill and missing values from the variable's own attributes. ${READERS_TEXT}`,
	input: inputSchema(STATS_ARGUMENTS),
	actionClass: "read",
	pathArguments: { path: "read" },
	idempotent: true,
	async run(args: Args, context) {
		const problem = checkArguments("scidata_stats", STATS_ARGUMENTS, args);
		if (problem !== null) return { error: problem };
		const result = await scidata().statsData(path.resolve(args.path as string), {
			...libraryOptions(args, context.signal),
			onProgress: (values) => context.progress(values, undefined, `${values} values read`),
		});
		return returned("scidata_stats", "stats", result, args);
	},
});

export const SCIDATA_TOOLS = [scidataInspect, scidataSelect, scidataStats];
