// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { readSettings } from "../../src/core/config.js";
import { runCommandVector } from "../../src/core/safe-exec.js";
import { sandboxAvailability, untrustedBwrapReason, wslKind } from "../../src/core/sandbox/availability.js";
import { buildBwrapInvocation } from "../../src/core/sandbox/bwrap.js";
import { mainSandboxPolicy, planMainSandboxSpawn } from "../../src/core/sandbox/main-session.js";
import {
	busSocketPaths,
	capabilityFromProbe,
	hostResourceStatus,
	planResourceScope,
	resourceLimitRefusal,
	resourceStatus,
	resourceStatusLine,
	resourceStatusRefuses,
	scopeArgs,
	scopeLaunchFailure,
	settleResourceScope,
} from "../../src/core/sandbox/resource-limits.js";
import { buildSeatbeltInvocation } from "../../src/core/sandbox/seatbelt.js";
import { sandboxFilterProgram } from "../../src/core/sandbox/seccomp.js";
import { sandboxStatus, sandboxStatusLine } from "../../src/core/sandbox/status.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { sandboxLaunchFilters } from "../../src/core/sandbox/unix-sockets.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import { composeWorkerSandboxInvocation } from "../../src/core/sandbox/worker-process.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { settingsChangeKind } from "../../src/domains/config/classify.js";
import { planExtensionLaunch } from "../../src/domains/extensions/runtime-sandbox.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

// Kernel ABI constants, written out here rather than imported so the program is checked against them.
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_I386 = 0x40000003;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_ARM = 0x40000028;
const AUDIT_ARCH_RISCV64 = 0xc00000f3;
const X32 = 0x40000000;
const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;

interface Insn {
	code: number;
	jt: number;
	jf: number;
	k: number;
}

function decode(program: Buffer): Insn[] {
	assert.equal(program.length % 8, 0);
	return Array.from({ length: program.length / 8 }, (_, index) => ({
		code: program.readUInt16LE(index * 8),
		jt: program.readUInt8(index * 8 + 2),
		jf: program.readUInt8(index * 8 + 3),
		k: program.readUInt32LE(index * 8 + 4),
	}));
}

/** The classic BPF subset the program uses, run over one `struct seccomp_data`. */
function run(insns: Insn[], arch: number, nr: number, arg0: bigint): number {
	const data = Buffer.alloc(64);
	data.writeInt32LE(nr | 0, 0);
	data.writeUInt32LE(arch, 4);
	data.writeBigUInt64LE(arg0, 16);
	let a = 0;
	for (let pc = 0; pc < insns.length; pc++) {
		const insn = insns[pc] as Insn;
		if (insn.code === 0x20) a = data.readUInt32LE(insn.k);
		else if (insn.code === 0x54) a = (a & insn.k) >>> 0;
		else if (insn.code === 0x15) pc += a === insn.k ? insn.jt : insn.jf;
		else if (insn.code === 0x45) pc += (a & insn.k) !== 0 ? insn.jt : insn.jf;
		else if (insn.code === 0x06) return insn.k;
		else throw new Error(`unexpected opcode ${insn.code}`);
	}
	throw new Error("program fell off the end");
}

test("the seccomp program holds the baseline on every covered ABI and adds the unix-socket rules under block", () => {
	const block = sandboxFilterProgram({ unixSockets: true }, "LE");
	const baseline = sandboxFilterProgram({ unixSockets: false }, "LE");
	assert.ok(block !== null && baseline !== null);
	const insns = decode(block);
	const base = decode(baseline);
	// Load the arch, dispatch on each covered ABI, and end on ALLOW, ERRNO(EPERM) and ERRNO(ENOSYS).
	assert.deepEqual(insns[0], { code: 0x20, jt: 0, jf: 0, k: 4 });
	assert.deepEqual(
		insns.slice(1, 5).map((insn) => insn.k),
		[AUDIT_ARCH_X86_64, AUDIT_ARCH_AARCH64, AUDIT_ARCH_I386, AUDIT_ARCH_ARM],
	);
	assert.deepEqual(
		insns.slice(-3).map(({ code, k }) => [code, k]),
		[
			[0x06, ALLOW],
			[0x06, EPERM],
			[0x06, ENOSYS],
		],
	);
	// x86_64 loads nr, clears the x32 bit, then compares with socket (41).
	const x86 = insns.findIndex((insn, index) => insn.code === 0x20 && insn.k === 0 && insns[index + 1]?.code === 0x54);
	assert.deepEqual(
		insns.slice(x86, x86 + 3).map(({ code, k }) => [code, k]),
		[
			[0x20, 0],
			[0x54, 0xbfffffff],
			[0x15, 41],
		],
	);
	assert.equal(sandboxFilterProgram({ unixSockets: true }, "BE"), null);

	const CLONE_NEWUSER = 0x10000000n;
	const CLONE_NEWNS = 0x00020000n;
	const CLONE_NEWNET = 0x40000000n;
	const CLONE_NEWTIME = 0x80n;
	const THREAD = 0x003d0f00n;
	const FORK = 17n; // SIGCHLD in the exit-signal byte
	// [name, arch, nr, arg0, under block, baseline only]
	const cases: Array<[string, number, number, bigint, number, number]> = [
		["x86_64 socket(AF_UNIX)", AUDIT_ARCH_X86_64, 41, 1n, EPERM, ALLOW],
		["x86_64 socket(AF_UNIX) with a high word", AUDIT_ARCH_X86_64, 41, 1n | (1n << 32n), EPERM, ALLOW],
		["x86_64 socket(AF_INET)", AUDIT_ARCH_X86_64, 41, 2n, ALLOW, ALLOW],
		["x86_64 socket(AF_VSOCK)", AUDIT_ARCH_X86_64, 41, 40n, EPERM, EPERM],
		["x86_64 socketpair(AF_UNIX)", AUDIT_ARCH_X86_64, 53, 1n, ALLOW, ALLOW],
		["x86_64 connect", AUDIT_ARCH_X86_64, 42, 1n, ALLOW, ALLOW],
		["x32 socket(AF_UNIX)", AUDIT_ARCH_X86_64, X32 | 41, 1n, EPERM, ALLOW],
		["x32 socket(AF_VSOCK)", AUDIT_ARCH_X86_64, X32 | 41, 40n, EPERM, EPERM],
		["x86_64 io_uring_setup", AUDIT_ARCH_X86_64, 425, 1n, EPERM, EPERM],
		["x86_64 ptrace", AUDIT_ARCH_X86_64, 101, 16n, EPERM, EPERM],
		["x32 ptrace", AUDIT_ARCH_X86_64, X32 | 521, 16n, EPERM, EPERM],
		["x86_64 process_vm_readv", AUDIT_ARCH_X86_64, 310, 1n, EPERM, EPERM],
		["x86_64 process_vm_writev", AUDIT_ARCH_X86_64, 311, 1n, EPERM, EPERM],
		["x32 process_vm_writev", AUDIT_ARCH_X86_64, X32 | 540, 1n, EPERM, EPERM],
		["x86_64 setns", AUDIT_ARCH_X86_64, 308, 3n, EPERM, EPERM],
		["x86_64 clone(fork)", AUDIT_ARCH_X86_64, 56, FORK, ALLOW, ALLOW],
		["x86_64 clone(thread)", AUDIT_ARCH_X86_64, 56, THREAD, ALLOW, ALLOW],
		["x86_64 clone(NEWUSER)", AUDIT_ARCH_X86_64, 56, CLONE_NEWUSER | FORK, EPERM, EPERM],
		["x86_64 clone(NEWNET)", AUDIT_ARCH_X86_64, 56, CLONE_NEWNET, EPERM, EPERM],
		["x86_64 clone3", AUDIT_ARCH_X86_64, 435, 0n, ENOSYS, ENOSYS],
		["x86_64 unshare(NEWNS)", AUDIT_ARCH_X86_64, 272, CLONE_NEWNS, EPERM, EPERM],
		["x86_64 unshare(NEWTIME)", AUDIT_ARCH_X86_64, 272, CLONE_NEWTIME, EPERM, EPERM],
		["x86_64 unshare(CLONE_FILES)", AUDIT_ARCH_X86_64, 272, 0x400n, ALLOW, ALLOW],
		["i386 socket(AF_UNIX)", AUDIT_ARCH_I386, 359, 1n, EPERM, ALLOW],
		["i386 socket(AF_VSOCK)", AUDIT_ARCH_I386, 359, 40n, EPERM, EPERM],
		["i386 socket(AF_INET)", AUDIT_ARCH_I386, 359, 2n, ALLOW, ALLOW],
		["i386 socketcall(SYS_SOCKET)", AUDIT_ARCH_I386, 102, 1n, EPERM, ALLOW],
		["i386 socketcall(SYS_SOCKETPAIR)", AUDIT_ARCH_I386, 102, 8n, ALLOW, ALLOW],
		["i386 ptrace", AUDIT_ARCH_I386, 26, 16n, EPERM, EPERM],
		["i386 clone(NEWUSER)", AUDIT_ARCH_I386, 120, CLONE_NEWUSER, EPERM, EPERM],
		["i386 unshare(NEWUSER)", AUDIT_ARCH_I386, 310, CLONE_NEWUSER, EPERM, EPERM],
		["aarch64 socket(AF_UNIX)", AUDIT_ARCH_AARCH64, 198, 1n, EPERM, ALLOW],
		["aarch64 socket(AF_INET6)", AUDIT_ARCH_AARCH64, 198, 10n, ALLOW, ALLOW],
		["aarch64 socket(AF_VSOCK)", AUDIT_ARCH_AARCH64, 198, 40n, EPERM, EPERM],
		["aarch64 socketpair(AF_UNIX)", AUDIT_ARCH_AARCH64, 199, 1n, ALLOW, ALLOW],
		["aarch64 io_uring_setup", AUDIT_ARCH_AARCH64, 425, 1n, EPERM, EPERM],
		["aarch64 ptrace", AUDIT_ARCH_AARCH64, 117, 16n, EPERM, EPERM],
		["aarch64 unshare(NEWUSER)", AUDIT_ARCH_AARCH64, 97, CLONE_NEWUSER, EPERM, EPERM],
		["aarch64 clone3", AUDIT_ARCH_AARCH64, 435, 0n, ENOSYS, ENOSYS],
		["arm socket(AF_UNIX)", AUDIT_ARCH_ARM, 281, 1n, EPERM, ALLOW],
		["arm socketpair(AF_UNIX)", AUDIT_ARCH_ARM, 288, 1n, ALLOW, ALLOW],
		["arm process_vm_readv", AUDIT_ARCH_ARM, 376, 1n, EPERM, EPERM],
		["x86_64 keyctl", AUDIT_ARCH_X86_64, 250, 11n, EPERM, ALLOW],
		["x86_64 add_key", AUDIT_ARCH_X86_64, 248, 0n, EPERM, ALLOW],
		["aarch64 keyctl", AUDIT_ARCH_AARCH64, 219, 11n, EPERM, ALLOW],
		["i386 request_key", AUDIT_ARCH_I386, 287, 0n, EPERM, ALLOW],
		["arm keyctl", AUDIT_ARCH_ARM, 311, 11n, EPERM, ALLOW],
		["an uncovered arch", AUDIT_ARCH_RISCV64, 198, 1n, ALLOW, ALLOW],
	];
	for (const [name, arch, nr, arg0, underBlock, baselineOnly] of cases) {
		assert.equal(run(insns, arch, nr, arg0), underBlock, `${name} under block`);
		assert.equal(run(base, arch, nr, arg0), baselineOnly, `${name} under owned or allow`);
	}
});

test("a bwrap the operator's uid could replace is not trusted; a root-owned one outside writable roots is", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "bwrap-trust-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fake = join(dir, "bwrap");
	writeFileSync(fake, "#!/bin/sh\nexit 0\n");
	chmodSync(fake, 0o755);
	assert.match(untrustedBwrapReason(fake) ?? "", /owned by uid \d+, not root/u);
	assert.match(untrustedBwrapReason(join(dir, "absent")) ?? "", /cannot be resolved/u);
	if (!existsSync("/usr/bin/bwrap")) return t.skip("no /usr/bin/bwrap on this host");
	assert.equal(untrustedBwrapReason("/usr/bin/bwrap"), null);
	assert.equal(untrustedBwrapReason("/usr/bin/bwrap", 0), null);
	// A symlink in a writable PATH dir resolves to the canonical root-owned binary so it cannot be swapped before launch.
	const linkDir = mkdtempSync(join(tmpdir(), "bwrap-link-"));
	t.after(() => rmSync(linkDir, { recursive: true, force: true }));
	symlinkSync("/usr/bin/bwrap", join(linkDir, "bwrap"));
	const resolved = sandboxAvailability("linux", { PATH: linkDir });
	if (resolved.available) {
		assert.equal(resolved.executable, realpathSync("/usr/bin/bwrap"));
	} else {
		assert.equal(resolved.found, realpathSync("/usr/bin/bwrap"));
	}
});

test("WSL1 has no sandbox and names the fix; a WSL2 or plain kernel is probed as usual", () => {
	assert.equal(wslKind("4.4.0-19041-Microsoft"), "wsl1");
	assert.equal(wslKind("5.15.167.4-microsoft-standard-WSL2"), "wsl2");
	assert.equal(wslKind("6.8.0-45-generic"), null);
	const wsl1 = sandboxAvailability("linux", { PATH: "/usr/bin" }, "4.4.0-19041-Microsoft");
	assert.equal(wsl1.available, false);
	assert.match(wsl1.reason ?? "", /WSL1 is unsupported.*convert the distribution to WSL2/u);
});

test("the sandbox status says what the main shell and a local worker get for each setting and probe", () => {
	const full = { available: true, backend: "bwrap" as const, executable: "/usr/bin/bwrap", reason: null };
	const partial = { ...full, degraded: "bubblewrap did not load the seccomp filter: EINVAL" };
	const lost = {
		available: false,
		backend: null,
		executable: null,
		reason: "pivot_root: EPERM",
		found: "/usr/bin/bwrap",
	};
	const missing = { available: false, backend: null, executable: null, reason: "bubblewrap (bwrap) is not installed" };
	const status = (
		setting: "auto" | "required" | "off",
		availability: Parameters<typeof sandboxStatus>[0]["availability"],
		more: Partial<Parameters<typeof sandboxStatus>[0]> = {},
	) =>
		sandboxStatus({
			setting,
			availability,
			networkIsolation: null,
			unixSockets: "block",
			wsl: null,
			unconfinedLocalWorkers: false,
			workerNetwork: false,
			...more,
		});
	const pick = (s: ReturnType<typeof sandboxStatus>) => [s.outcome, s.seccomp, s.main, s.localWorker];
	assert.deepEqual(pick(status("auto", full)), ["available", "loaded", "contained", "contained"]);
	assert.deepEqual(pick(status("auto", partial)), ["partial", "degraded", "contained", "contained"]);
	assert.deepEqual(pick(status("required", partial)), ["partial", "degraded", "rails", "refused"]);
	assert.deepEqual(pick(status("auto", lost)), ["lost", "none", "rails", "refused"]);
	assert.deepEqual(pick(status("auto", missing, { unconfinedLocalWorkers: true })), [
		"missing",
		"none",
		"rails",
		"unconfined",
	]);
	assert.deepEqual(pick(status("required", missing, { unconfinedLocalWorkers: true })), [
		"missing",
		"none",
		"rails",
		"refused",
	]);
	assert.deepEqual(pick(status("off", full)), ["off", "loaded", "off", "off"]);
	// A worker command keeps no network unless safety.egress.workers.mode is open, so a bwrap that cannot isolate it refuses workers.
	const netless = status("auto", full, { networkIsolation: "cannot unshare net" });
	assert.deepEqual(pick(netless), ["available", "loaded", "contained", "refused"]);
	assert.equal(status("auto", full, { networkIsolation: "x", workerNetwork: true }).localWorker, "contained");
	assert.equal(status("auto", lost).executable, "/usr/bin/bwrap");
	assert.match(
		sandboxStatusLine(status("auto", lost)),
		/backend lost: \/usr\/bin\/bwrap cannot build a sandbox here \(pivot_root: EPERM\)/u,
	);
	assert.match(
		sandboxStatusLine(status("auto", partial, { wsl: "wsl2" })),
		/partial: seccomp baseline not loaded \(.*EINVAL\); WSL2;/u,
	);
	assert.match(
		sandboxStatusLine(status("auto", missing)),
		/main shell not sandboxed \(approval rails only\); local native workers refused$/u,
	);
});

test("the seatbelt temp-directory write grant keeps read-only paths protected", () => {
	const profile = buildSeatbeltInvocation({
		command: { argv: ["/usr/bin/true"] },
		cwd: "/private/tmp/w",
		writableRoots: ["/private/tmp/w"],
		readOnlyPaths: ["/private/tmp/w/.git"],
		maskedPaths: [],
		network: false,
	}).args[1] as string;
	const temp = profile.split("\n").find((line) => line.includes('(subpath "/private/tmp")'));
	assert.match(temp ?? "", /require-not \(require-any \(subpath \(param "READ_ONLY_PATH_0"\)\)\)/u);
});

test("the seatbelt profile denies unix-socket connects and binds when blocking, keeping DNS only with network", () => {
	const profile = (spec: { network: boolean; denyUnixSockets?: boolean }): string =>
		buildSeatbeltInvocation({
			command: { argv: ["/usr/bin/true"] },
			cwd: "/w",
			writableRoots: [],
			maskedPaths: [],
			...spec,
		}).args[1] as string;
	const networked = profile({ network: true, denyUnixSockets: true }).split("\n");
	const allowNetwork = networked.indexOf("(allow network*)");
	const deny = networked.indexOf("(deny network-outbound (remote unix-socket))");
	assert.ok(allowNetwork >= 0 && deny > allowNetwork, "the deny follows the network grant, so it wins");
	assert.ok(networked.includes("(deny network-bind (local unix-socket))"));
	assert.ok(networked.some((line) => line.includes("/private/var/run/mDNSResponder")));
	const offline = profile({ network: false, denyUnixSockets: true });
	assert.match(offline, /\(deny network-outbound \(remote unix-socket\)\)/u);
	assert.doesNotMatch(offline, /mDNSResponder/u);
	assert.doesNotMatch(profile({ network: true }), /unix-socket/u);

	// The worker compose path asks Seatbelt for the rules unless the operator allowed sockets.
	const seatbelt = { available: true, backend: "seatbelt" as const, executable: "/usr/bin/sandbox-exec", reason: null };
	const policy: WorkerSandboxSpec = {
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: "auto",
		writableRoots: [],
		readOnlyPaths: [],
		gitWritablePaths: [],
		readableRoots: [],
		network: true,
	};
	const composed = (spec: WorkerSandboxSpec): string =>
		composeWorkerSandboxInvocation(spec, { argv: ["/usr/bin/true"] }, "/", seatbelt, [])?.args[1] ?? "";
	assert.match(composed(policy), /\(deny network-bind \(local unix-socket\)\)/u);
	assert.doesNotMatch(composed({ ...policy, unixSockets: "allow" }), /unix-socket/u);
});

test("the extension runtime launch blocks unix sockets by default and honors the operator's allow", async (t) => {
	const home = await isolatePancodeEnv("pancode-unix-socket-extension-");
	t.after(() => home.restore());
	const roots = {
		workspace: join(home.dir, "workspace"),
		packageCopy: join(home.dir, "runtime", "package"),
		storeDir: join(home.dir, "store"),
		bootstrap: join(home.dir, "bootstrap", "runtime-child-v2.mjs"),
	};
	for (const directory of [roots.workspace, roots.packageCopy, roots.storeDir, join(home.dir, "bootstrap")])
		mkdirSync(directory, { recursive: true });
	const declaration = {
		permissions: { fs: { read: [], write: [] }, exec: false, net: false },
	} as unknown as ExtensionRuntimeDeclarationV2;
	const seatbelt = { available: true, backend: "seatbelt" as const, executable: "/usr/bin/sandbox-exec", reason: null };
	const profile = (unixSockets?: "block" | "allow"): string => {
		const launch = planExtensionLaunch({
			declaration,
			roots,
			argv: [process.execPath, roots.bootstrap],
			availability: seatbelt,
			...(unixSockets !== undefined ? { unixSockets } : {}),
		});
		assert.equal(launch.report.backend, "seatbelt", launch.report.reason);
		return launch.args[1] ?? "";
	};
	assert.match(profile(), /\(deny network-bind \(local unix-socket\)\)/u);
	assert.match(profile("block"), /\(deny network-bind \(local unix-socket\)\)/u);
	assert.doesNotMatch(profile("allow"), /unix-socket/u);
});

test("the extension runtime launch masks PanCode's config directory, or its settings files when the directory holds a root", async (t) => {
	const home = await isolatePancodeEnv("pancode-extension-settings-mask-");
	t.after(() => home.restore());
	const roots = {
		workspace: join(home.dir, "workspace"),
		packageCopy: join(home.dir, "runtime", "package"),
		storeDir: join(home.dir, "store"),
		bootstrap: join(home.dir, "bootstrap", "runtime-child-v2.mjs"),
	};
	for (const directory of [roots.workspace, roots.packageCopy, roots.storeDir, join(home.dir, "bootstrap")])
		mkdirSync(directory, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const settingsFiles = ["settings.yaml", "settings.yaml.bak"].map((name) => join(home.dir, "config", name));
	for (const file of settingsFiles) writeFileSync(file, "targets:\n  - auth: { headers: { x-api-key: secret } }\n");
	const plan = (launchRoots: typeof roots) =>
		planExtensionLaunch({
			declaration: {
				permissions: { fs: { read: [], write: [] }, exec: false, net: false },
			} as unknown as ExtensionRuntimeDeclarationV2,
			roots: launchRoots,
			argv: [process.execPath, launchRoots.bootstrap],
			availability: { available: true, backend: "seatbelt", executable: "/usr/bin/sandbox-exec", reason: null },
		});
	const launch = plan(roots);
	assert.equal(launch.report.backend, "seatbelt", launch.report.reason);
	const configDir = realpathSync(join(home.dir, "config"));
	const maskedDirs = (args: ReadonlyArray<string>) =>
		args.filter((arg) => /^MASKED_DIR_\d+=/u.test(arg)).map((arg) => arg.slice(arg.indexOf("=") + 1));
	assert.ok(maskedDirs(launch.args).includes(configDir), "the config directory is not masked");
	// A config directory that holds the child's own workspace cannot be hidden whole, so its settings files are.
	const nested = { ...roots, workspace: join(home.dir, "config", "workspace") };
	mkdirSync(nested.workspace);
	const fallbackArgs = plan(nested).args;
	assert.ok(!maskedDirs(fallbackArgs).includes(configDir), "a config directory holding the workspace is masked whole");
	const fallback = fallbackArgs.join("\n");
	for (const file of settingsFiles) assert.ok(fallback.includes(realpathSync(file)), `${file} is not masked`);
});

test("the extension runtime launch masks secret files in the workspace, declared read roots and granted directories", async (t) => {
	const home = await isolatePancodeEnv("pancode-extension-secret-mask-");
	t.after(() => home.restore());
	const roots = {
		workspace: join(home.dir, "workspace"),
		packageCopy: join(home.dir, "runtime", "package"),
		storeDir: join(home.dir, "store"),
		bootstrap: join(home.dir, "bootstrap", "runtime-child-v2.mjs"),
	};
	const shared = join(home.dir, "shared");
	const granted = join(home.dir, "fixture");
	const out = join(home.dir, "out");
	for (const directory of [
		roots.workspace,
		roots.packageCopy,
		roots.storeDir,
		shared,
		granted,
		out,
		join(home.dir, "bootstrap"),
	])
		mkdirSync(directory, { recursive: true });
	writeFileSync(join(roots.workspace, ".env"), "SUPER_SECRET_KEY=hunter2\n");
	writeFileSync(join(shared, ".env"), "SHARED_SECRET_KEY=hunter3\n");
	writeFileSync(join(granted, ".env"), "FIXTURE_SECRET_KEY=hunter4\n");
	writeFileSync(join(out, ".env"), "OUT_SECRET_KEY=hunter5\n");
	const grant = (flag: string, access: "read" | "write", path: string) => ({
		flag,
		access,
		path,
		canonical: realpathSync(path),
		exists: true,
	});
	const launch = planExtensionLaunch({
		declaration: {
			permissions: { fs: { read: ["workspace", shared], write: [] }, exec: false, net: false },
		} as unknown as ExtensionRuntimeDeclarationV2,
		roots: {
			...roots,
			grants: [
				grant("--fixture", "read", granted),
				grant("--roster", "read", join(shared, ".env")),
				grant("--out", "write", out),
			],
		},
		argv: [process.execPath, roots.bootstrap],
		availability: { available: true, backend: "seatbelt", executable: "/usr/bin/sandbox-exec", reason: null },
	});
	assert.equal(launch.report.backend, "seatbelt", launch.report.reason);
	const args = launch.args.join("\n");
	for (const file of [join(roots.workspace, ".env"), join(shared, ".env"), join(granted, ".env"), join(out, ".env")])
		assert.ok(args.includes(realpathSync(file)), `${file} is not masked`);
});

test("an extension runtime no OS sandbox confines does not start under safety.sandbox required", () => {
	const roots = { workspace: "/w", packageCopy: "/r/package", storeDir: "/s", bootstrap: "/b/runtime-child-v2.mjs" };
	const plan = (sandboxMode?: "auto" | "required") =>
		planExtensionLaunch({
			declaration: {
				permissions: { fs: { read: ["workspace"], write: [] }, exec: false, net: false },
			} as unknown as ExtensionRuntimeDeclarationV2,
			roots,
			argv: [process.execPath, roots.bootstrap],
			availability: { available: false, backend: null, executable: null, reason: "bwrap missing" },
			...(sandboxMode !== undefined ? { sandboxMode } : {}),
		});
	// auto keeps the reported unconfined fallback.
	for (const mode of [undefined, "auto"] as const) {
		const launch = plan(mode);
		assert.equal(launch.report.backend, null);
		assert.equal(launch.report.network, "unenforced");
	}
	assert.throws(() => plan("required"), /safety\.sandbox is "required".*bwrap missing.*not started/u);
});

test("under bwrap the extension runtime's settings mask survives a save by rename and covers later backups", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const home = await isolatePancodeEnv("pancode-extension-settings-rename-");
	t.after(() => home.restore());
	const workspace = join(realpathSync(home.dir), "workspace");
	// Inside the workspace, so the child would see it through its readable root even under a private /tmp.
	const config = join(workspace, "pancode-config");
	mkdirSync(config, { recursive: true });
	process.env.PANCODE_CONFIG_DIR = config;
	resetXdgCache();
	writeFileSync(join(workspace, "visible.txt"), "visible\n");
	writeFileSync(join(config, "settings.yaml"), "x-api-key: launch-secret\n");
	const roots = {
		workspace,
		packageCopy: join(home.dir, "runtime", "package"),
		storeDir: join(home.dir, "store"),
		bootstrap: join(home.dir, "bootstrap", "runtime-child-v2.mjs"),
	};
	for (const directory of [roots.packageCopy, roots.storeDir, join(home.dir, "bootstrap")])
		mkdirSync(directory, { recursive: true });
	const script = 'sleep 1; cat "$1/visible.txt" "$2/settings.yaml" "$2/settings.yaml.bak-later" 2>&1; true';
	const launch = planExtensionLaunch({
		declaration: {
			permissions: { fs: { read: [], write: [] }, exec: false, net: false },
		} as unknown as ExtensionRuntimeDeclarationV2,
		roots,
		argv: ["/bin/sh", "-c", script, "sh", workspace, config],
		availability,
	});
	assert.equal(launch.report.backend, "bwrap", launch.report.reason);
	const output = new Promise<string>((resolve) => {
		execFile(launch.file, launch.args, { timeout: 15_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
	});
	// Settings saves write a temporary file and rename it over settings.yaml; a backup can appear at any time.
	await new Promise((resolve) => setTimeout(resolve, 400));
	writeFileSync(join(config, ".settings.yaml.tmp-1"), "x-api-key: saved-secret\n");
	renameSync(join(config, ".settings.yaml.tmp-1"), join(config, "settings.yaml"));
	writeFileSync(join(config, "settings.yaml.bak-later"), "x-api-key: backup-secret\n");
	const seen = await output;
	assert.match(seen, /visible/u, seen);
	assert.doesNotMatch(seen, /secret/u, seen);
});

test("safety.sandboxUnixSockets defaults to block, is user-layer only, applies live and reaches the worker spec", async (t) => {
	const home = await isolatePancodeEnv("pancode-unix-socket-settings-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".pancode"), { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const userFile = join(home.dir, "config", "settings.yaml");
	writeFileSync(userFile, "version: 2\n");
	assert.equal(readSettings().safety.sandboxUnixSockets, "block");
	writeFileSync(userFile, "version: 2\nsafety:\n  sandboxUnixSockets: allow\n");
	assert.equal(readSettings().safety.sandboxUnixSockets, "allow");
	writeFileSync(userFile, "version: 2\nsafety:\n  sandboxUnixSockets: owned\n");
	assert.equal(readSettings().safety.sandboxUnixSockets, "owned");
	writeFileSync(userFile, "version: 2\nsafety:\n  sandboxUnixSockets: maybe\n");
	assert.throws(() => readSettings(), /safety\.sandboxUnixSockets/u);

	// A repository cannot reopen the sockets for its own commands.
	writeFileSync(userFile, "version: 2\n");
	writeFileSync(join(workspace, ".pancode", "settings.local.yaml"), "safety:\n  sandboxUnixSockets: allow\n");
	const layered = readLayeredSettings(workspace);
	assert.equal(layered.settings.safety.sandboxUnixSockets, "block");
	const issue = layered.issues.find((item) => item.path === "safety.sandboxUnixSockets");
	assert.match(issue?.message ?? "", /user settings/u);

	assert.equal(settingsChangeKind("safety.sandboxUnixSockets"), "hotReload");
	const spec = (unixSockets: "block" | "owned" | "allow") =>
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: workspace,
			writeBoundaries: [],
			network: false,
			unixSockets,
		});
	assert.equal(spec("allow")?.unixSockets, "allow");
	assert.equal(spec("owned")?.unixSockets, "owned");
	assert.equal(spec("block")?.unixSockets, undefined);
});

const PROBE = [
	"import socket, sys",
	"path, port = sys.argv[1], int(sys.argv[2])",
	"def attempt(f):",
	"    try: return f()",
	"    except OSError as e: return f'{type(e).__name__}:{e.errno}'",
	"def unix():",
	"    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(path); s.close(); return 'connected'",
	"def tcp():",
	"    s = socket.create_connection(('127.0.0.1', port), timeout=5); s.close(); return 'connected'",
	"def pair():",
	"    a, b = socket.socketpair(); a.sendall(b'x'); return 'pair-' + b.recv(1).decode()",
	"def vsock():",
	"    s = socket.socket(40, socket.SOCK_STREAM); s.close(); return 'opened'",
	"def userns():",
	"    import ctypes, os",
	"    libc = ctypes.CDLL(None, use_errno=True)",
	"    if libc.unshare(0x10000000) == 0: return 'created'",
	"    raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))",
	"print(f'unix={attempt(unix)} tcp={attempt(tcp)} socketpair={attempt(pair)} vsock={attempt(vsock)} userns={attempt(userns)}')",
].join("\n");

function runProbe(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
	});
}

async function listen(server: Server, target: string | { host: string; port: number }): Promise<void> {
	await new Promise<void>((resolve) => server.listen(target, resolve));
}

/** Linux `sun_path` holds 108 bytes with its terminating NUL. */
const UNIX_SOCKET_PATH_BYTES = 107;

/**
 * Listen on a unix socket this test makes itself, or skip the row naming why this process cannot: a run inside a
 * contained command inherits that sandbox's AF_UNIX filter (EPERM), and a path past `sun_path` cannot be bound at all.
 * Either is the environment, not the sandbox under test, so the row is counted as skipped with its reason.
 */
async function listenUnixOrSkip(t: TestContext, server: Server, path: string): Promise<boolean> {
	const bytes = Buffer.byteLength(path, "utf8");
	if (bytes > UNIX_SOCKET_PATH_BYTES) {
		t.skip(
			`the fixture socket path is ${bytes} bytes, past the ${UNIX_SOCKET_PATH_BYTES}-byte unix socket limit; run with a shorter TMPDIR`,
		);
		return false;
	}
	const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
		server.once("error", resolve);
		server.listen(path, () => resolve(null));
	});
	if (failure === null) return true;
	if (failure.code !== "EPERM") throw failure;
	t.skip(
		"this test process cannot bind a unix socket (EPERM): it runs inside a sandbox, such as a contained PanCode command, whose filter refuses AF_UNIX; run the file from an unsandboxed shell",
	);
	return false;
}

test("under bwrap a contained command cannot open a unix socket but keeps socketpair and TCP; allow reopens it", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	if (spawnSync("python3", ["-c", "pass"]).status !== 0) {
		t.skip("python3 is not installed");
		return;
	}
	const python = "python3";
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-unix-")));
	const workspace = join(scratch, "ws");
	const socketDir = join(scratch, "sock");
	mkdirSync(workspace);
	mkdirSync(socketDir);
	// Sockets this test made itself: a unix listener in the scratch tree and a TCP one on loopback.
	const socketPath = join(socketDir, "l.sock");
	const unixServer = createServer((socket) => socket.end());
	const tcpServer = createServer((socket) => socket.end());
	t.after(() => {
		unixServer.close();
		tcpServer.close();
	});
	if (!(await listenUnixOrSkip(t, unixServer, socketPath))) return;
	await listen(tcpServer, { host: "127.0.0.1", port: 0 });
	const address = tcpServer.address();
	assert.ok(address !== null && typeof address === "object");
	const argv = [python, "-c", PROBE, socketPath, String(address.port)];

	const contained = async (unixSockets: "block" | "allow"): Promise<string> => {
		const policy = mainSandboxPolicy({ workspace, scratchRoots: [scratch], unixSockets });
		const plan = planMainSandboxSpawn(policy, { argv }, workspace, availability);
		assert.equal(plan.kind, "sandboxed");
		if (plan.kind !== "sandboxed") return "";
		return runProbe(plan.file, plan.args);
	};
	const blocked = await contained("block");
	assert.match(blocked, /unix=PermissionError:1 tcp=connected socketpair=pair-x/u, blocked);
	// The baseline holds under every unix-socket mode: no vsock to the VM host, no new user namespace.
	assert.match(blocked, /vsock=PermissionError:1 userns=PermissionError:1/u, blocked);
	const allowed = await contained("allow");
	assert.match(
		allowed,
		/unix=connected tcp=connected socketpair=pair-x vsock=PermissionError:1 userns=PermissionError:1/u,
		allowed,
	);

	// A worker's sandbox loads the same filter, network or not: a socket on disk is not network.
	const worker = composeWorkerSandboxInvocation(
		{
			version: WORKER_SANDBOX_SPEC_VERSION,
			mode: "required",
			writableRoots: [workspace],
			readOnlyPaths: [],
			gitWritablePaths: [],
			readableRoots: [workspace],
			network: false,
		},
		{ argv },
		workspace,
		availability,
		[],
	);
	assert.ok(worker !== null);
	assert.match(await runProbe(worker.file, worker.args), /unix=PermissionError:1 /u);

	// Without a filter the launch masks the sockets it finds, so the listener is gone while sockets still open.
	const fallback = sandboxLaunchFilters(
		"block",
		{ ...availability, degraded: "forced by the test" },
		{ workspaceRoots: [workspace], scratchRoots: [scratch], privateTmp: false, home: workspace },
		[],
	);
	assert.equal(fallback.state.kind, "masks");
	assert.equal(fallback.missingBaseline, "forced by the test");
	assert.deepEqual(fallback.fields, {});
	assert.ok(fallback.masks.some((mask) => mask.path === socketPath && mask.kind === "file"));
	const masked = buildBwrapInvocation(
		{
			command: { argv },
			cwd: workspace,
			writableRoots: [workspace],
			network: true,
			maskedPaths: fallback.masks,
			privateTmp: false,
		},
		availability.executable ?? undefined,
	);
	const output = await runProbe(masked.file, masked.args);
	assert.match(output, /unix=ConnectionRefusedError:111 tcp=connected/u, output);
});

test("under bwrap a contained command can neither read nor add to the login's session keyring", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	if (spawnSync("keyctl", ["--version"]).error !== undefined) {
		t.skip("keyctl is not installed");
		return;
	}
	// The row needs a session keyring of its own; a sandbox whose filter refuses keyctl (a contained command) has none.
	const joined = spawnSync("keyctl", ["session", "-", "true"], { encoding: "utf8" });
	if (joined.status !== 0 && /Operation not permitted/u.test(joined.stderr)) {
		t.skip(
			"this test process cannot join a session keyring (EPERM): it runs inside a sandbox, such as a contained PanCode command, whose filter refuses keyctl; run the file from an unsandboxed shell",
		);
		return;
	}
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pancode-keyring-")));
	// A fresh session keyring for this test holds a key, as pam_keyinit leaves a login's.
	const keyed = (file: string, args: string[]): Promise<string> =>
		runProbe("keyctl", [
			"session",
			"-",
			"sh",
			"-c",
			'k=$(keyctl add user pancode-test stand-in-secret @s) || exit 9; "$@" "$k"; echo "after=$(keyctl rlist @s | wc -w)"',
			"sh",
			file,
			...args,
		]);
	const argv = [
		"sh",
		"-c",
		'keyctl print "$1" 2>&1 | sed "s/^/print=/"; keyctl add user pancode-planted x @s >/dev/null 2>&1 && echo added=yes || echo added=no',
		"sh",
	];
	const plan = planMainSandboxSpawn(
		mainSandboxPolicy({ workspace, scratchRoots: [] }),
		{ argv },
		workspace,
		availability,
	);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const output = await keyed(plan.file, plan.args);
	assert.doesNotMatch(output, /stand-in-secret/u, output);
	assert.match(output, /added=no/u, output);
	assert.match(output, /after=1\b/u, output);
});

test("under bwrap owned masks the operator's own sockets and leaves a system daemon's reachable", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	if (spawnSync("python3", ["-c", "pass"]).status !== 0) {
		t.skip("python3 is not installed");
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-unix-owned-")));
	const workspace = join(scratch, "ws");
	mkdirSync(workspace);
	const own = join(scratch, "own.sock");
	const server = createServer((socket) => socket.end());
	const tcpServer = createServer((socket) => socket.end());
	t.after(() => {
		server.close();
		tcpServer.close();
	});
	if (!(await listenUnixOrSkip(t, server, own))) return;
	await listen(tcpServer, { host: "127.0.0.1", port: 0 });
	const address = tcpServer.address();
	assert.ok(address !== null && typeof address === "object");
	const policy = mainSandboxPolicy({ workspace, scratchRoots: [scratch], unixSockets: "owned" });
	const probe = async (socketPath: string): Promise<string> => {
		const plan = planMainSandboxSpawn(
			policy,
			{ argv: ["python3", "-c", PROBE, socketPath, String(address.port)] },
			workspace,
			availability,
		);
		assert.equal(plan.kind, "sandboxed");
		return plan.kind === "sandboxed" ? runProbe(plan.file, plan.args) : "";
	};
	// The socket call itself works; the operator's listener is masked.
	const mine = await probe(own);
	assert.match(mine, /unix=ConnectionRefusedError:111 .*socketpair=pair-x/u, mine);
	// The system bus stands in for MUNGE or SSSD: a daemon socket another user owns.
	const daemon = "/run/dbus/system_bus_socket";
	let foreign = false;
	try {
		foreign = lstatSync(daemon).isSocket() && lstatSync(daemon).uid !== process.getuid?.();
	} catch {
		// No system bus on this host.
	}
	if (foreign) {
		const theirs = await probe(daemon);
		assert.match(theirs, /unix=connected /u, theirs);
	}
});

test("socket discovery finds the pane host's socket and a home daemon's past a large data tree", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-unix-walk-")));
	const home = join(scratch, "home");
	const workspace = join(home, "ws");
	const daemonDir = join(home, ".config", "herdr");
	const data = join(home, "data");
	const elsewhere = join(scratch, "elsewhere", "a", "b", "c");
	for (const dir of [workspace, daemonDir, data, elsewhere]) mkdirSync(dir, { recursive: true });
	// More entries than one discovery may visit, in a tree that holds no socket.
	for (let i = 0; i <= 40_000; i++) writeFileSync(join(data, String(i)), "");
	const daemon = join(daemonDir, "herdr.sock");
	const paneHost = join(elsewhere, "host.sock");
	const servers = [createServer(), createServer()];
	t.after(() => {
		for (const server of servers) server.close();
	});
	if (!(await listenUnixOrSkip(t, servers[0] as Server, daemon))) return;
	if (!(await listenUnixOrSkip(t, servers[1] as Server, paneHost))) return;
	const launch = sandboxLaunchFilters(
		"owned",
		availability,
		{ workspaceRoots: [workspace], privateTmp: true, home, env: { HERDR_SOCKET_PATH: paneHost } },
		[],
	);
	const masked = launch.masks.map((mask) => mask.path);
	assert.ok(masked.includes(paneHost), masked.join(", "));
	assert.ok(masked.includes(daemon), masked.join(", "));
	const tmux = sandboxLaunchFilters(
		"block",
		{ ...availability, degraded: "forced by the test" },
		{ workspaceRoots: [workspace], privateTmp: true, home: workspace, env: { TMUX: `${paneHost},4242,0` } },
		[],
	);
	assert.ok(
		tmux.masks.some((mask) => mask.path === paneHost),
		tmux.masks.map((mask) => mask.path).join(", "),
	);
});

test("resource ceilings: the probe, the refusal, the scope arguments, a launch failure and the status line", () => {
	const delegated = "memory.max=268435456\nmemory.swap.max=0\npids.max=64\ncpu.max=100000 100000\n";
	const probe = (stdout: string, more: Partial<Parameters<typeof capabilityFromProbe>[0]> = {}) => ({
		status: 0,
		stdout,
		stderr: "",
		timedOut: false,
		...more,
	});
	const states = (capability: ReturnType<typeof capabilityFromProbe>) => [
		capability.memoryMiB.state,
		capability.tasks.state,
		capability.cpuPercent.state,
	];
	assert.deepEqual(states(capabilityFromProbe(probe(delegated), true)), ["enforced", "enforced", "enforced"]);
	// Swap not accounted to cgroups lets a memory ceiling page out; with no swap there is nowhere to go.
	const swapless = delegated.replace("memory.swap.max=0", "memory.swap.max=missing");
	assert.deepEqual(states(capabilityFromProbe(probe(swapless), false)), ["enforced", "enforced", "enforced"]);
	const spilled = capabilityFromProbe(probe(swapless), true);
	assert.match("reason" in spilled.memoryMiB ? spilled.memoryMiB.reason : "enforced", /spill into swap/u);
	const pidless = capabilityFromProbe(probe(delegated.replace("pids.max=64", "pids.max=missing")), false);
	assert.deepEqual(states(pidless), ["enforced", "unavailable", "enforced"]);
	const busless = capabilityFromProbe(
		probe("", { status: 1, stderr: "Failed to connect to bus: No medium found\n" }),
		false,
	);
	assert.deepEqual(states(busless), ["unavailable", "unavailable", "unavailable"]);

	assert.equal(resourceLimitRefusal({ memoryMiB: 64, cpuPercent: 50 }, "main", pidless), null);
	assert.match(
		resourceLimitRefusal({ memoryMiB: 64, tasks: 8 }, "workers", pidless) ?? "",
		/^safety\.resources\.workers\.tasks is set but this host cannot enforce it \(.*pids\.max reads missing\)\); the command was not run/u,
	);
	assert.deepEqual(scopeArgs({ memoryMiB: 64, tasks: 8, cpuPercent: 50 }, "pancode-cmd-1.scope"), [
		"--user",
		"--scope",
		"--quiet",
		"--unit=pancode-cmd-1.scope",
		"-p",
		"OOMPolicy=stop",
		"-p",
		"MemoryMax=64M",
		"-p",
		"MemorySwapMax=0",
		"-p",
		"TasksMax=8",
		"-p",
		"CPUQuota=50%",
		"--",
	]);

	// Only exit 1 with no output and nothing but systemd-run's own lines reads as a scope that never started.
	const busFailure = "Failed to connect to bus: No medium found\n";
	assert.equal(scopeLaunchFailure({ exitCode: 1, stdoutBytes: 0, stderr: busFailure }), busFailure.trim());
	const bus256Failure = "Failed to connect to user scope bus via local transport: Connection refused\n";
	assert.equal(scopeLaunchFailure({ exitCode: 1, stdoutBytes: 0, stderr: bus256Failure }), bus256Failure.trim());
	assert.equal(
		scopeLaunchFailure({ exitCode: 1, stdoutBytes: 0, stderr: "Failed to get D-Bus connection: No such file\n" }),
		"Failed to get D-Bus connection: No such file",
	);
	assert.equal(scopeLaunchFailure({ exitCode: 1, stdoutBytes: 3, stderr: busFailure }), null);
	assert.equal(scopeLaunchFailure({ exitCode: 2, stdoutBytes: 0, stderr: busFailure }), null);
	assert.equal(scopeLaunchFailure({ exitCode: 1, stdoutBytes: 0, stderr: `${busFailure}make: *** Error 1\n` }), null);
	assert.equal(scopeLaunchFailure({ exitCode: 1, stdoutBytes: 0, stderr: "Failed to start: x\n" }), null);

	// Bus socket extraction observes filesystem paths and flags abstract/non-file D-Bus transports as unobservable.
	assert.deepEqual(
		busSocketPaths({
			XDG_RUNTIME_DIR: "/run/user/1000",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=abc",
		}),
		{ paths: ["/run/user/1000/bus", "/run/user/1000/systemd/private"], observable: true },
	);
	assert.equal(busSocketPaths({ DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-xyz" }).observable, false);

	const refused = resourceStatus(pidless, { main: { tasks: 8 }, workers: undefined });
	assert.equal(resourceStatusRefuses(refused), true);
	assert.match(
		resourceStatusLine(refused),
		/^memory, cpu enforceable per command \(systemd user scope\); tasks unavailable \(.*\); main: tasks 8; workers: none set; a set limit this host cannot enforce refuses its commands; disk quota not enforced; per-process limits not offered$/u,
	);
	const unset = resourceStatus(busless, { main: undefined, workers: undefined });
	assert.equal(resourceStatusRefuses(unset), false);
	assert.equal(unset.disk, "not enforced");
});

test("under a systemd user scope a command's ceilings hold and nothing of it outlives the run", async (t) => {
	const status = hostResourceStatus({
		main: { memoryMiB: 64, tasks: 8, cpuPercent: 50 },
		workers: { memoryMiB: null, tasks: null, cpuPercent: null },
	});
	if (resourceStatusRefuses(status)) {
		t.skip(`resource ceilings not enforceable here: ${status.reason}`);
		return;
	}
	const memory = await runCommandVector("awk", ['BEGIN { s = "x"; while (1) s = s s }'], {
		resourceLimits: { memoryMiB: 64 },
		timeoutMs: 30_000,
	});
	assert.notEqual(memory.exitCode, 0);
	assert.match(memory.resourceNote ?? "", /memory ceiling 64 MiB \(safety\.resources\.main\.memoryMiB\) reached/u);
	const tasks = await runCommandVector("sh", ["-c", "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 2 & done; wait"], {
		resourceLimits: { tasks: 4 },
		timeoutMs: 30_000,
	});
	assert.match(tasks.stderr, /fork|Resource temporarily unavailable/iu);
	// A process the command left running is ended with its scope rather than outliving the run.
	const started = performance.now();
	const left = await runCommandVector("sh", ["-c", "sleep 30 & echo left"], { resourceLimits: { cpuPercent: 50 } });
	assert.equal(left.stdout.trim(), "left");
	assert.ok(performance.now() - started < 10_000);
	const units = spawnSync(
		"systemctl",
		["--user", "list-units", `pancode-cmd-${process.pid}-*`, "--all", "--no-legend"],
		{
			encoding: "utf8",
		},
	);
	assert.equal(units.stdout.trim(), "");

	// A command overriding bus env vars does not break systemd-run and still receives its own env values.
	const customEnv = await runCommandVector(
		"sh",
		["-c", 'printf "xdg=%s dbus=%s" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS"'],
		{
			env: { XDG_RUNTIME_DIR: "/nonexistent/custom-xdg", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus" },
			resourceLimits: { cpuPercent: 50 },
		},
	);
	assert.equal(customEnv.exitCode, 0, customEnv.stderr);
	assert.equal(customEnv.stdout, "xdg=/nonexistent/custom-xdg dbus=unix:path=/nonexistent/bus");

	// When systemctl cannot reach the user bus at settlement, the launch stays unconfirmed so bus errors refuse.
	const planned = planResourceScope(
		{ limits: { cpuPercent: 50 }, scope: "main" },
		{ file: "/bin/true", args: [], env: {} },
	);
	assert.equal(planned.kind, "scoped");
	if (planned.kind === "scoped") {
		const deadSettlement = await settleResourceScope({
			...planned.scope,
			systemctlEnv: { XDG_RUNTIME_DIR: "/nonexistent/dead-bus", LC_ALL: "C" },
		});
		assert.equal(deadSettlement.launchUnconfirmed, true);
	}

	// Losing the user bus after a passing probe invalidates the cache and refuses before launch (exit 126).
	const prevXdg = process.env.XDG_RUNTIME_DIR;
	const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
	const emptyRuntime = mkdtempSync(join(tmpdir(), "pancode-nobus-"));
	t.after(() => {
		if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = prevXdg;
		if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
		else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
		rmSync(emptyRuntime, { recursive: true, force: true });
	});
	process.env.XDG_RUNTIME_DIR = emptyRuntime;
	delete process.env.DBUS_SESSION_BUS_ADDRESS;
	const refusedAfterLoss = await runCommandVector("sh", ["-c", "echo should-not-run"], {
		resourceLimits: { memoryMiB: 64 },
	});
	assert.equal(refusedAfterLoss.launched, false);
	assert.equal(refusedAfterLoss.exitCode, 126);
	assert.match(refusedAfterLoss.stderr, /safety\.resources\.main\.memoryMiB/u);
});
