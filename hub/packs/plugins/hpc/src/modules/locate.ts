// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Finding the module tool and running it. `module` is a shell function, so
 * there is no program of that name: the login shell's initialisation names
 * the real one in `LMOD_CMD` (Lmod) or `MODULES_CMD` (Environment Modules 4
 * or later), and older Environment Modules puts `modulecmd` on `PATH`. Each
 * is run as `<tool> bash <subcommand> ...`, which prints text for people on
 * stderr and shell code on stdout; the server reads the text and never
 * evaluates the shell code.
 */
import { type ProbeSource, type RunCommandResult, resolveProgram, runCommand } from "../exec.js";
import { type ModuleToolKind, parseLmodVersion, parseModulesVersion } from "./parse.js";

/** The variables the module tools read, which the login shell set; `*` ends a prefix. */
export const MODULES_ENVIRONMENT: ReadonlyArray<string> = [
	"MODULEPATH",
	"MODULESHOME",
	"LOADEDMODULES",
	"_LMFILES_",
	"LMOD_*",
	"MODULES_*",
	"_ModuleTable*",
	"__LMOD_*",
	"__MODULES_*",
];

export interface ModuleTool {
	kind: ModuleToolKind;
	/** The absolute path of the program that runs. */
	program: string;
	/** How it was found. */
	via: "LMOD_CMD" | "MODULES_CMD" | "PATH";
}

export type Located =
	| { ok: true; tool: ModuleTool; sources: ProbeSource[] }
	| { ok: false; reason: string; sources: ProbeSource[] };

const SHELL_NOTE =
	"module is a shell function, and these variables come from the login shell PanCode or the MCP host was started from: start it from a shell where `module avail` works";

/** Find the module tool from `env`, looking programs up without running any. */
export function findModuleTool(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Located {
	const sources: ProbeSource[] = [];
	const fromVariable = (variable: "LMOD_CMD" | "MODULES_CMD"): string | null => {
		const value = env[variable];
		if (value === undefined || value.length === 0) {
			sources.push({ name: variable, found: false, detail: "not set" });
			return null;
		}
		const path = value.includes("/") ? resolveProgram(value, env.PATH, cwd) : null;
		sources.push(
			path === null
				? { name: variable, found: false, detail: `set to ${value}, which is not an executable file` }
				: { name: variable, found: true, detail: path },
		);
		return path;
	};
	const lmod = fromVariable("LMOD_CMD");
	const modules = lmod === null ? fromVariable("MODULES_CMD") : null;
	const modulecmd = lmod === null && modules === null ? resolveProgram("modulecmd", env.PATH, cwd) : null;
	if (lmod === null && modules === null)
		sources.push(
			modulecmd === null
				? { name: "modulecmd", found: false, detail: "not on PATH" }
				: { name: "modulecmd", found: true, detail: modulecmd },
		);
	if (lmod !== null) return { ok: true, tool: { kind: "lmod", program: lmod, via: "LMOD_CMD" }, sources };
	if (modules !== null)
		return { ok: true, tool: { kind: "environment-modules", program: modules, via: "MODULES_CMD" }, sources };
	if (modulecmd !== null)
		return { ok: true, tool: { kind: "environment-modules", program: modulecmd, via: "PATH" }, sources };
	const found = sources
		.filter((source) => source.detail !== "not set" && source.detail !== "not on PATH")
		.map((source) => `${source.name} is ${source.detail}`);
	return {
		ok: false,
		reason: `No module tool found: LMOD_CMD (Lmod) and MODULES_CMD (Environment Modules 4 or later) name no executable and modulecmd (Environment Modules) is not on PATH${found.length > 0 ? ` (${found.join("; ")})` : ""}. ${SHELL_NOTE}.`,
		sources,
	};
}

/** The variable names in `env` that `MODULES_ENVIRONMENT` passes through to the tool. */
export function passedVariables(env: NodeJS.ProcessEnv = process.env): string[] {
	const names = Object.keys(env).filter((name) =>
		MODULES_ENVIRONMENT.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry)),
	);
	return names.sort();
}

/**
 * The values every call sets: the C locale, and the pager, colour and
 * decoration settings off, so no site default, format variable or terminal
 * changes what the tool prints, and its text goes to stderr.
 */
export function fixedEnvironment(kind: ModuleToolKind): Record<string, string> {
	return kind === "lmod"
		? { LC_ALL: "C", LMOD_PAGER: "none", LMOD_COLORIZE: "no", LMOD_REDIRECT: "no", LMOD_TERSE_DECORATIONS: "no" }
		: { LC_ALL: "C", MODULES_PAGER: "", MODULES_COLOR: "never" };
}

export const COMMAND_TIMEOUT_MS = 30_000;
/** Spider walks the whole hierarchy, and a site without a spider cache takes longer. */
export const SPIDER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ToolText = { ok: true; text: string; warnings: string[] } | { ok: false; error: string };

const firstLines = (text: string, count: number): string =>
	text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, count)
		.join(" ");

/** The error the tool printed, if any: Lmod's "Lmod has detected the following error" or Environment Modules' "ERROR:". */
function printedError(kind: ModuleToolKind, text: string): string | null {
	const marker =
		kind === "lmod" ? /^\s*Lmod has detected the following error:.*$/mu.exec(text) : /^ERROR: .*$/mu.exec(text);
	if (marker === null) return null;
	return firstLines(text.slice(marker.index), kind === "lmod" ? 2 : 1);
}

function printedWarnings(kind: ModuleToolKind, text: string): string[] {
	const pattern = kind === "lmod" ? /^\s*Lmod Warning:.*$/gmu : /^WARNING: .*$/gmu;
	return [...text.matchAll(pattern)].map((match) => match[0].trim());
}

/** What a failed run says, naming the program and the subcommand, never the environment. */
function failure(tool: ModuleTool, args: ReadonlyArray<string>, result: RunCommandResult, timeoutMs: number): string {
	const command = `${tool.program} bash ${args.join(" ")}`;
	if (result.kind === "timeout") return `${command} timed out: it did not finish within ${timeoutMs / 1000} seconds`;
	if (result.kind === "not-found") return `${command}: the program is no longer there (${tool.via})`;
	if (result.kind === "exit") {
		const detail = printedError(tool.kind, result.stderr) ?? firstLines(result.stderr, 2);
		return `${command} exited with ${result.code ?? result.signal}${detail.length > 0 ? `: ${detail}` : ""}`;
	}
	return `${command}: ${result.message ?? result.kind}`;
}

/** Run `<tool> bash <args>` and return its stderr text, or the tool error the call reports. */
export async function runModuleTool(
	tool: ModuleTool,
	args: ReadonlyArray<string>,
	options: { signal: AbortSignal; timeoutMs?: number; env?: Record<string, string> },
): Promise<ToolText> {
	const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
	const result = await runCommand(tool.program, ["bash", ...args], {
		timeoutMs,
		maxOutputBytes: MAX_OUTPUT_BYTES,
		signal: options.signal,
		envAllowlist: passedVariables(),
		env: { ...fixedEnvironment(tool.kind), ...(options.env ?? {}) },
	});
	if (result.kind !== "ok" && result.kind !== "exit")
		return { ok: false, error: failure(tool, args, result, timeoutMs) };
	if (result.truncated)
		return { ok: false, error: `${tool.program} bash ${args.join(" ")} printed more than the server reads` };
	const printed = printedError(tool.kind, result.stderr);
	if (result.kind === "exit" || printed !== null)
		return {
			ok: false,
			error:
				result.kind === "exit"
					? failure(tool, args, result, timeoutMs)
					: `${tool.program} bash ${args.join(" ")} reported: ${printed}`,
		};
	return { ok: true, text: result.stderr, warnings: printedWarnings(tool.kind, result.stderr) };
}

export type ToolVersion = { version: string; reason?: undefined } | { version: null; reason: string };

/** The release the tool reports with `--version`, or why there is none. */
export async function moduleToolVersion(tool: ModuleTool, signal: AbortSignal): Promise<ToolVersion> {
	const output = await runModuleTool(tool, ["--version"], { signal });
	if (!output.ok) return { version: null, reason: output.error };
	const version = tool.kind === "lmod" ? parseLmodVersion(output.text) : parseModulesVersion(output.text);
	return version === null
		? { version: null, reason: `${tool.program} bash --version printed no release the server could read` }
		: { version };
}
