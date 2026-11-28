// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { sandboxCommandArgv } from "./bwrap.js";
import type { SandboxInvocation, SandboxInvocationSpec } from "./types.js";

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

/**
 * UNVERIFIED: no macOS host was available when this was written. The profile
 * follows the shape of Codex CLI's workspace-write seatbelt policy, and
 * `sandboxAvailability()` only selects it after `sandbox-exec` accepts it on a
 * trivial command, so a profile the kernel rejects degrades `auto` to
 * unsandboxed instead of breaking every worker command. Nothing here has been
 * exercised against a real build, test run, or network probe on macOS.
 *
 * Semantics mirror the bubblewrap builder: read everything except masked
 * secrets, write only the writable roots, the Git paths the run may write and
 * the temporary directories, keep re-protected paths read-only, and allow
 * network only when the run was granted it. Paths travel as `-D` parameters
 * so no path is spliced into the profile text.
 */
const SEATBELT_BASE_POLICY = [
	"(version 1)",
	"(deny default)",
	"(allow process-exec)",
	"(allow process-fork)",
	"(allow signal (target same-sandbox))",
	"(allow process-info* (target same-sandbox))",
	"(allow sysctl-read)",
	"(allow mach-lookup)",
	"(allow ipc-posix-shm)",
	"(allow pseudo-tty)",
	'(allow file-ioctl (literal "/dev/tty"))',
	"(allow file-read*)",
	'(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
];

/**
 * UNVERIFIED like the rest of this profile. A granted network otherwise lets
 * a contained command connect to any Unix-domain socket it can see, such as a
 * terminal multiplexer's or a daemon's control socket, which runs commands
 * outside the sandbox. They come after `(allow network*)` because a later
 * matching rule wins. With the network on, macOS resolves host names through
 * mDNSResponder's socket, so that one socket stays reachable; without a grant
 * nothing is re-allowed.
 */
function seatbeltUnixSocketRules(network: boolean): string[] {
	return [
		"(deny network-outbound (remote unix-socket))",
		...(network ? ['(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'] : []),
		"(deny network-bind (local unix-socket))",
	];
}

function paramRule(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `(subpath (param "${prefix}_${index}"))`).join(" ");
}

function literalRule(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `(literal (param "${prefix}_${index}"))`).join(" ");
}

function buildSeatbeltProfile(spec: SandboxInvocationSpec): { profile: string; params: string[] } {
	const params: string[] = [];
	const define = (prefix: string, values: ReadonlyArray<string>): number => {
		values.forEach((value, index) => {
			params.push("-D", `${prefix}_${index}=${value.length > 1 ? value.replace(/\/+$/u, "") : value}`);
		});
		return values.length;
	};
	const writable = define("WRITABLE_ROOT", spec.writableRoots);
	const readOnly = define("READ_ONLY_PATH", spec.readOnlyPaths ?? []);
	const gitWritable = define("GIT_WRITABLE_PATH", spec.gitWritablePaths ?? []);
	const maskedDirs = define(
		"MASKED_DIR",
		spec.maskedPaths.filter((mask) => mask.kind === "directory").map((mask) => mask.path),
	);
	const revealedRead = define(
		"REVEAL_READ",
		spec.maskedPaths.flatMap((mask) => (mask.kind === "directory" ? (mask.reveal ?? []).map((r) => r.target) : [])),
	);
	const revealedWrite = define(
		"REVEAL_WRITE",
		spec.maskedPaths.flatMap((mask) =>
			mask.kind === "directory" ? (mask.reveal ?? []).filter((r) => r.writable).map((r) => r.target) : [],
		),
	);
	const maskedFiles = define(
		"MASKED_FILE",
		spec.maskedPaths.filter((mask) => mask.kind === "file").map((mask) => mask.path),
	);
	const restriction = spec.readRestriction;
	const shownRoots = restriction === undefined ? [] : seatbeltShownRoots(spec);
	const hidden = define("HIDDEN_DIR", restriction?.hidden ?? []);
	const shown = define("SHOWN_ROOT", shownRoots);
	const shownLinkPaths = (restriction?.links ?? []).map((link) => link.path);
	const shownLinks = define("SHOWN_LINK", shownLinkPaths);
	const shownAncestors = define(
		"SHOWN_ANCESTOR",
		restriction === undefined ? [] : ancestorsUnder([...shownRoots, ...shownLinkPaths], restriction.hidden),
	);
	const lines = [...SEATBELT_BASE_POLICY];
	// Temporary directories: macOS resolves /tmp to /private/tmp and gives each
	// user a per-session TMPDIR under /private/var/folders.
	// A read-only path under them (a workspace's `.git` in a temp checkout) stays protected, as under the roots below.
	const protectedPaths = paramRule("READ_ONLY_PATH", readOnly);
	const temp = '(subpath "/private/tmp") (subpath "/private/var/folders")';
	lines.push(
		readOnly > 0
			? `(allow file-write* (require-all (require-any ${temp}) (require-not (require-any ${protectedPaths}))))`
			: `(allow file-write* ${temp})`,
	);
	if (writable > 0) {
		const roots = paramRule("WRITABLE_ROOT", writable);
		lines.push(
			readOnly > 0
				? `(allow file-write* (require-all (require-any ${roots}) (require-not (require-any ${protectedPaths}))))`
				: `(allow file-write* ${roots})`,
		);
	}
	if (gitWritable > 0) lines.push(`(allow file-write* ${paramRule("GIT_WRITABLE_PATH", gitWritable)})`);
	// UNVERIFIED: a read restriction denies the hidden trees, then re-allows what shows back and lets path lookup
	// stat the directories on the way to it. The masks below still win over both.
	if (hidden > 0) {
		lines.push(`(deny file-read* ${paramRule("HIDDEN_DIR", hidden)})`);
		if (shown > 0) lines.push(`(allow file-read* ${paramRule("SHOWN_ROOT", shown)})`);
		if (shownLinks > 0) lines.push(`(allow file-read* ${literalRule("SHOWN_LINK", shownLinks)})`);
		if (shownAncestors > 0) lines.push(`(allow file-read-metadata ${literalRule("SHOWN_ANCESTOR", shownAncestors)})`);
	}
	// A later matching rule takes precedence in SBPL, so masks come last, with revealed subtrees re-opened before file masks.
	if (maskedDirs > 0) lines.push(`(deny file-read* file-write* ${paramRule("MASKED_DIR", maskedDirs)})`);
	if (revealedRead > 0) lines.push(`(allow file-read* ${paramRule("REVEAL_READ", revealedRead)})`);
	if (revealedWrite > 0) lines.push(`(allow file-write* ${paramRule("REVEAL_WRITE", revealedWrite)})`);
	if (maskedFiles > 0) lines.push(`(deny file-read* file-write* ${literalRule("MASKED_FILE", maskedFiles)})`);
	// Without a network grant, `(deny default)` already refuses every socket,
	// Unix-domain ones included.
	if (spec.network) lines.push("(allow network*)", "(allow system-socket)");
	if (spec.denyUnixSockets === true) lines.push(...seatbeltUnixSocketRules(spec.network));
	return { profile: lines.join("\n"), params };
}

/** Every root a restricted command still reads: what the restriction shows back and the roots the run was given. */
function seatbeltShownRoots(spec: SandboxInvocationSpec): string[] {
	return [
		...new Set(
			[
				spec.cwd,
				...(spec.readRestriction?.exposed ?? []),
				...spec.writableRoots,
				...(spec.gitWritablePaths ?? []),
				...(spec.readableRoots ?? []),
				...spec.maskedPaths.flatMap((mask) => (mask.reveal ?? []).map((entry) => entry.target)),
			].map((entry) => (entry.length > 1 ? entry.replace(/\/+$/u, "") : entry)),
		),
	];
}

/** The directories between each hidden root and a root shown inside it, the hidden root included. */
function ancestorsUnder(roots: ReadonlyArray<string>, hidden: ReadonlyArray<string>): string[] {
	const out = new Set<string>();
	for (const root of roots) {
		const dir = hidden.find((entry) => root !== entry && root.startsWith(`${entry}/`));
		if (dir === undefined) continue;
		for (let parent = path.posix.dirname(root); parent.length >= dir.length; parent = path.posix.dirname(parent)) {
			out.add(parent);
			if (parent === dir) break;
		}
	}
	return [...out];
}

/** Pure `sandbox-exec` argv. Environment changes ride the caller's spawn env. */
export function buildSeatbeltInvocation(
	spec: SandboxInvocationSpec,
	executable: string = SEATBELT_EXECUTABLE,
): SandboxInvocation {
	const { profile, params } = buildSeatbeltProfile(spec);
	const argv = sandboxCommandArgv(spec.command);
	const envPrefix: string[] = [];
	const setEnv = Object.entries(spec.setEnv ?? {});
	if (setEnv.length > 0 || (spec.unsetEnv ?? []).length > 0) {
		envPrefix.push("/usr/bin/env");
		for (const key of spec.unsetEnv ?? []) envPrefix.push("-u", key);
		for (const [key, value] of setEnv) envPrefix.push(`${key}=${value}`);
	}
	return { file: executable, args: ["-p", profile, ...params, ...envPrefix, ...argv] };
}
