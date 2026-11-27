// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Finding Spack, reading its version without running it, running it, checking
 * the values that reach its argv, and telling whether a package repository
 * still has to be fetched.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveProgram, runCommand } from "../exec.js";
import {
	parseRepoListJson,
	parseRepoListText,
	parseSpackVersionFile,
	type SpackRepository,
	spackErrorMessage,
	spackMajorVersion,
} from "./parse.js";

/** The variables Spack reads that a host passes through to the server and the server passes to `spack`. */
export const SPACK_ENVIRONMENT: ReadonlyArray<string> = [
	"SPACK_ROOT",
	"SPACK_ENV",
	"SPACK_USER_CONFIG_PATH",
	"SPACK_SYSTEM_CONFIG_PATH",
	"SPACK_USER_CACHE_PATH",
	"SPACK_DISABLE_LOCAL_CONFIG",
	"SPACK_PYTHON",
];

/** Wall-clock limits. `spec` can bootstrap Spack's solver on first use. Mutable so tests can shorten them. */
export const SPACK_TIMEOUTS = { readMs: 60_000, specMs: 300_000 };

/** Bytes kept of each stream; `find --json --deps` over a large store is the biggest output. */
export const LARGE_OUTPUT_BYTES = 32 * 1024 * 1024;
export const OUTPUT_BYTES = 4 * 1024 * 1024;

export const SPACK_MISSING =
	"spack was not found: it is not on PATH and SPACK_ROOT names no bin/spack. The spack server needs Spack's bin directory on PATH or SPACK_ROOT set to a Spack checkout; a shell function named spack, which Spack's setup script defines, is not visible to it";

/** The spack program this server runs, and how it was found; or why there is none. */
export function locateSpack(): { path: string; via: "PATH" | "SPACK_ROOT" } | { path: null; reason: string } {
	const onPath = resolveProgram("spack", process.env.PATH, process.cwd());
	if (onPath !== null) return { path: onPath, via: "PATH" };
	const root = process.env.SPACK_ROOT;
	if (root !== undefined && path.isAbsolute(root)) {
		const inRoot = resolveProgram(path.join(root, "bin", "spack"), undefined, process.cwd());
		if (inRoot !== null) return { path: inRoot, via: "SPACK_ROOT" };
	}
	return { path: null, reason: SPACK_MISSING };
}

/**
 * The version the Spack checkout holding `program` declares, read from
 * `lib/spack/spack/__init__.py` beside its `bin/`: no command runs and no lock
 * is taken. The reason when it cannot be read.
 */
export async function readSpackVersion(program: string): Promise<{ version: string | null; reason: string }> {
	let file = "";
	try {
		file = path.join(path.dirname(path.dirname(await realpath(program))), "lib", "spack", "spack", "__init__.py");
		const version = parseSpackVersionFile(await readFile(file, "utf8"));
		return { version, reason: version === null ? `${file} declares no version the server can read` : "" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { version: null, reason: `the Spack version could not be read from ${file || program}: ${detail}` };
	}
}

export type SpackRun =
	| { ok: true; stdout: string; stderr: string }
	| { ok: false; exited: boolean; stdout: string; stderr: string; reason: string };

/** Run spack with `--color=never` first, `LC_ALL=C`, and only the allowlisted environment. */
export async function runSpack(
	program: string,
	args: ReadonlyArray<string>,
	options: { timeoutMs: number; maxOutputBytes: number; signal: AbortSignal },
): Promise<SpackRun> {
	const result = await runCommand(program, ["--color=never", ...args], {
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
		signal: options.signal,
		envAllowlist: SPACK_ENVIRONMENT,
		env: { LC_ALL: "C" },
	});
	const command = `spack ${args.slice(0, 3).join(" ")}`;
	const failed = (exited: boolean, reason: string): SpackRun => ({
		ok: false,
		exited,
		stdout: result.stdout,
		stderr: result.stderr,
		reason,
	});
	if (result.truncated) return failed(false, `${command} printed more than ${options.maxOutputBytes} bytes`);
	if (result.kind === "ok") return { ok: true, stdout: result.stdout, stderr: result.stderr };
	if (result.kind === "exit") {
		const detail = spackErrorMessage(result.stderr) ?? spackErrorMessage(result.stdout);
		const status = result.code ?? result.signal;
		return failed(true, `${command} exited with ${status}${detail !== null ? `: ${detail}` : ""}`);
	}
	if (result.kind === "timeout") return failed(false, `${command} timed out after ${options.timeoutMs / 1000} seconds`);
	return failed(false, result.message ?? `${command} did not run (${result.kind})`);
}

const SPEC_MAX_LENGTH = 256;

/**
 * A spec: Spack spec syntax over the characters it uses, at most 256 of them,
 * entries separated by spaces. No entry begins with `-` or `.`, a `/` only
 * starts a hash at the end of an entry, and no entry names a `.json` or
 * `.yaml` file, so a spec never reaches a file Spack would read.
 */
export const SPEC_PATTERN = "^(?=.*[^ ])(?! *[-.])(?!.* [-.])(?:[A-Za-z0-9@:,.=+~^%_\\[\\] -]|/[a-z0-9]+(?![^ ]))+$";
export const ENVIRONMENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";
export const PACKAGE_PATTERN = "^[a-z0-9][a-z0-9_-]*$";

const SPEC = new RegExp(SPEC_PATTERN, "u");
const SPEC_FILE = /\.(?:json|ya?ml)$/iu;

/** The argv entries of a spec, or why it is refused. */
export function specTokens(spec: unknown): { tokens: string[] } | { refused: string } {
	if (typeof spec !== "string") return { refused: "spec must be a string" };
	if (spec.length > SPEC_MAX_LENGTH) return { refused: `spec is longer than ${SPEC_MAX_LENGTH} characters` };
	const forbidden = /["'`\\;|&$<>(){}*?!#\n\r\t]/u.exec(spec)?.[0];
	if (forbidden !== undefined) return { refused: `spec holds ${JSON.stringify(forbidden)}, which a spec never needs` };
	const tokens = spec.split(" ").filter((token) => token.length > 0);
	const dashed = tokens.find((token) => token.startsWith("-"));
	if (dashed !== undefined)
		return { refused: `spec entry ${JSON.stringify(dashed)} begins with -; write a disabled variant as ~name` };
	if (!SPEC.test(spec) || tokens.some((token) => SPEC_FILE.test(token)))
		return { refused: `spec must match ${SPEC_PATTERN} and name no spec file` };
	return { tokens };
}

export function checkName(kind: "environment" | "package", value: unknown): string | null {
	const pattern = kind === "environment" ? ENVIRONMENT_PATTERN : PACKAGE_PATTERN;
	if (typeof value !== "string") return `${kind} must be a string`;
	return new RegExp(pattern, "u").test(value) && value.length <= 128 ? null : `${kind} must match ${pattern}`;
}

/** Whether a spec names anything beyond installed hashes, which Spack looks up in its package repositories. */
export function specNeedsRepos(tokens: ReadonlyArray<string>): boolean {
	return tokens.some((token) => !/^\/[a-z0-9]+$/u.test(token));
}

/** Whether Spack's `repo list` printed a repository list in JSON (1.2 and later) or only as text. */
function hasRepoListJson(version: string | null): boolean {
	const [major = 0, minor = 0] = (version ?? "").split(".").map((part) => Number.parseInt(part, 10));
	return version === null || major > 1 || (major === 1 && minor >= 2);
}

/**
 * Null when every package repository Spack is configured with is on disk, so
 * a read command will not fetch one; else the reason to return instead of
 * running it. Spack 1.0 and later keep their packages in git repositories
 * that a command clones on first use; `spack repo list` reports them without
 * cloning. Before 1.0 packages ship inside Spack and nothing is fetched.
 */
export async function packageReposMissing(
	program: string,
	version: string | null,
	signal: AbortSignal,
): Promise<string | null> {
	const major = spackMajorVersion(version);
	if (major !== null && major < 1) return null;
	const options = { timeoutMs: SPACK_TIMEOUTS.readMs, maxOutputBytes: OUTPUT_BYTES, signal };
	let repositories: SpackRepository[] | null = null;
	let reason = "";
	if (hasRepoListJson(version)) {
		const run = await runSpack(program, ["-E", "repo", "list", "--json"], options);
		repositories = run.ok ? parseRepoListJson(run.stdout) : null;
		reason = run.ok ? "spack repo list --json printed no repository list the server could read" : run.reason;
	}
	if (repositories === null) {
		const run = await runSpack(program, ["-E", "repo", "list"], options);
		repositories = run.ok ? parseRepoListText(run.stdout) : null;
		if (repositories === null)
			reason = run.ok ? "spack repo list printed no repository list the server could read" : run.reason;
	}
	if (repositories === null)
		return `the server could not tell whether Spack's package repositories are on disk, and a read tool never fetches one (${reason})`;
	const absent = repositories.filter((repository) => repository.status === "uninitialized").map((repo) => repo.name);
	if (absent.length === 0) return null;
	const names = absent.join(" ");
	return `Spack's package repository ${names} has not been fetched yet; this command would clone it from the network on first use, and a read tool never fetches. Run \`spack repo update ${names}\` once to fetch it, then call again`;
}
