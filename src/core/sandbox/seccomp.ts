// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, readFileSync } from "node:fs";
import { endianness } from "node:os";
import path from "node:path";
import { sha256Hex } from "../hash.js";
import { safeResourceWrite } from "../safe-resource-write.js";
import { pancodeStateDir } from "../xdg.js";

/**
 * The seccomp program every bubblewrap launch loads. bwrap applies it to the
 * command after building the namespaces, so the rules hold for the command and
 * everything it starts, and bwrap's own setup is untouched.
 *
 * The baseline holds whatever `safety.sandboxUnixSockets` says. A vsock socket
 * (AF_VSOCK) reaches the hypervisor host, which on WSL2 runs Windows commands;
 * io_uring creates sockets the socket rules never see; ptrace and
 * process_vm_readv/writev read and patch any process of the operator's uid
 * that shares the sandbox's view, PanCode's own parent included when no pid
 * namespace stands between them; a new user, mount or other namespace, or
 * joining one, rebuilds the filesystem view bwrap set up. clone3 passes its
 * flags in a struct a filter cannot read, so it fails with ENOSYS, which libc
 * and the language runtimes take as "this kernel has no clone3" and retry with
 * clone, whose flags are checked.
 *
 * Under `block` the program also refuses `socket(AF_UNIX, ...)` (socketpair
 * stays allowed, so pipes between a command's own processes keep working),
 * i386 socketcall(SYS_SOCKET), whose arguments sit behind a pointer the filter
 * cannot read, and the keyring calls add_key, request_key and keyctl. A
 * sandboxed process keeps the session keyring of the login that started
 * PanCode, so without these it reads, adds and clears the operator's Kerberos
 * tickets and AFS tokens there; the kernel still uses the keyring on the
 * process's behalf, so NFS, CIFS and AFS file access keeps working.
 *
 * An i386 process that reaches socket(2) through socketcall is not checked for
 * AF_VSOCK outside `block`: the domain sits behind the same pointer.
 */

// seccomp_data layout: int nr, u32 arch, u64 instruction_pointer, u64 args[6].
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
/** Low word of args[0] on a little-endian host: the socket domain, and every namespace flag. */
const SECCOMP_DATA_ARG0_LOW = 16;

const BPF_LD_W_ABS = 0x20;
const BPF_ALU_AND_K = 0x54;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const AF_UNIX = 1;
const AF_VSOCK = 40;
/** socketcall(2) call number for socket(2). */
const SYS_SOCKET = 1;

/**
 * CLONE_NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID and NEWNET. clone(2)
 * keeps its exit signal in the low byte, so CLONE_NEWTIME (0x80) is not a
 * flag there.
 */
const CLONE_NAMESPACE_FLAGS = 0x7e020000;
/** The clone namespace flags plus CLONE_NEWTIME and Linux 7.1's UNSHARE_EMPTY_MNTNS. */
const UNSHARE_NAMESPACE_FLAGS = CLONE_NAMESPACE_FLAGS | 0x00000080 | 0x00100000;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_I386 = 0x40000003;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_ARM = 0x40000028;
/** x32 syscalls carry this bit in `nr` under AUDIT_ARCH_X86_64. */
const X32_SYSCALL_BIT = 0x40000000;

/**
 * Per ABI syscall numbers. A 64-bit process can still enter the 32-bit ABI
 * (int 0x80 on x86_64), so each family's compat ABI is filtered too. x32
 * shares the x86_64 numbers once its bit is masked, except the calls it has
 * its own entries for (`denied` lists both). `keys` are add_key, request_key
 * and keyctl.
 */
const ABIS = [
	{
		label: "x86_64",
		arch: AUDIT_ARCH_X86_64,
		socket: 41,
		keys: [248, 249, 250],
		// io_uring_setup, ptrace, process_vm_readv, process_vm_writev, setns; x32 ptrace and process_vm_readv/writev.
		denied: [425, 101, 310, 311, 308, 521, 539, 540],
		clone: 56,
		clone3: 435,
		unshare: 272,
		x32: true,
	},
	{
		label: "aarch64",
		arch: AUDIT_ARCH_AARCH64,
		socket: 198,
		keys: [217, 218, 219],
		denied: [425, 117, 270, 271, 268],
		clone: 220,
		clone3: 435,
		unshare: 97,
	},
	{
		label: "i386",
		arch: AUDIT_ARCH_I386,
		socket: 359,
		socketcall: 102,
		keys: [286, 287, 288],
		denied: [425, 26, 347, 348, 346],
		clone: 120,
		clone3: 435,
		unshare: 310,
	},
	{
		label: "arm",
		arch: AUDIT_ARCH_ARM,
		socket: 281,
		keys: [309, 310, 311],
		denied: [425, 26, 376, 377, 375],
		clone: 120,
		clone3: 435,
		unshare: 337,
	},
] as const;

/** Kernel machines whose native and compat ABIs the program covers. */
export const SECCOMP_COVERED_MACHINES: ReadonlySet<string> = new Set([
	"x86_64",
	"aarch64",
	"arm64",
	"i386",
	"i686",
	"armv7l",
	"armv8l",
]);

interface Step {
	code: number;
	k: number;
	/** Label jumped to when the comparison holds; absent falls through. */
	jt?: string;
	/** Label jumped to when it does not; absent falls through. */
	jf?: string;
	label?: string;
}

/** Classic BPF jumps are forward offsets of at most 255 instructions. */
function assemble(steps: ReadonlyArray<Step>): Buffer {
	const at = new Map<string, number>();
	steps.forEach((step, index) => {
		if (step.label !== undefined) at.set(step.label, index);
	});
	const out = Buffer.alloc(steps.length * 8);
	steps.forEach((step, index) => {
		const offset = (label: string | undefined): number => {
			if (label === undefined) return 0;
			const target = at.get(label);
			if (target === undefined || target <= index || target - index - 1 > 255) {
				throw new Error(`seccomp program: bad jump to ${label}`);
			}
			return target - index - 1;
		};
		out.writeUInt16LE(step.code, index * 8);
		out.writeUInt8(offset(step.jt), index * 8 + 2);
		out.writeUInt8(offset(step.jf), index * 8 + 3);
		out.writeUInt32LE(step.k >>> 0, index * 8 + 4);
	});
	return out;
}

/**
 * Pure: the seccomp program bwrap loads, as the raw `struct sock_filter`
 * array in host byte order, covering the x86_64, x32, i386, aarch64 and arm
 * ABIs; any other ABI is allowed whole. `unixSockets` adds the `block` rules.
 * `namespaces` is the isolated worker's outer variant: `clone` and `unshare`
 * may create namespaces, so the worker's own children start under their own
 * bwrap, which loads the full baseline; everything else stays denied.
 * Null on a big-endian host, where the offsets differ and no covered ABI runs.
 */
export function sandboxFilterProgram(
	rules: { unixSockets: boolean; namespaces?: boolean },
	byteOrder: "BE" | "LE" = endianness(),
): Buffer | null {
	if (byteOrder !== "LE") return null;
	const ld = (offset: number, label?: string): Step => ({
		code: BPF_LD_W_ABS,
		k: offset,
		...(label !== undefined ? { label } : {}),
	});
	const jeq = (k: number, jt?: string, jf?: string): Step => ({
		code: BPF_JMP_JEQ_K,
		k,
		...(jt !== undefined ? { jt } : {}),
		...(jf !== undefined ? { jf } : {}),
	});
	const steps: Step[] = [ld(SECCOMP_DATA_ARCH)];
	ABIS.forEach((abi, index) => {
		const last = index === ABIS.length - 1;
		steps.push(jeq(abi.arch, abi.label, last ? "allow" : undefined));
	});
	for (const abi of ABIS) {
		steps.push(ld(SECCOMP_DATA_NR, abi.label));
		// An x32 call is the x86_64 number with the x32 bit set; masking it
		// sends both through the same comparisons.
		if ("x32" in abi) steps.push({ code: BPF_ALU_AND_K, k: ~X32_SYSCALL_BIT >>> 0 });
		steps.push(jeq(abi.socket, "domain"));
		if (rules.unixSockets) {
			if ("socketcall" in abi) steps.push(jeq(abi.socketcall, "socketcall"));
			for (const key of abi.keys) steps.push(jeq(key, "deny"));
		}
		for (const nr of abi.denied) steps.push(jeq(nr, "deny"));
		steps.push(jeq(abi.clone3, "enosys"), jeq(abi.clone, "clone"), jeq(abi.unshare, "unshare", "allow"));
	}
	steps.push(ld(SECCOMP_DATA_ARG0_LOW, "domain"));
	if (rules.unixSockets) steps.push(jeq(AF_UNIX, "deny"));
	steps.push(jeq(AF_VSOCK, "deny", "allow"));
	if (rules.unixSockets) steps.push(ld(SECCOMP_DATA_ARG0_LOW, "socketcall"), jeq(SYS_SOCKET, "deny", "allow"));
	steps.push(
		ld(SECCOMP_DATA_ARG0_LOW, "clone"),
		{ code: BPF_JMP_JSET_K, k: rules.namespaces === true ? 0 : CLONE_NAMESPACE_FLAGS, jt: "deny", jf: "allow" },
		ld(SECCOMP_DATA_ARG0_LOW, "unshare"),
		{ code: BPF_JMP_JSET_K, k: rules.namespaces === true ? 0 : UNSHARE_NAMESPACE_FLAGS, jt: "deny" },
		{ code: BPF_RET_K, k: SECCOMP_RET_ALLOW, label: "allow" },
		{ code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EPERM, label: "deny" },
		{ code: BPF_RET_K, k: SECCOMP_RET_ERRNO | ENOSYS, label: "enosys" },
	);
	return assemble(steps);
}

/**
 * Impure: the program file under PanCode's state directory, named by its
 * content digest and rewritten whenever it is missing or holds other bytes,
 * so a stale or altered file never reaches bwrap. It is read again on every
 * launch, which costs one small read.
 */
export function sandboxFilterFile(program: Buffer): string {
	const file = path.join(pancodeStateDir(), "sandbox", `seccomp-${sha256Hex(program).slice(0, 16)}.bpf`);
	let current: Buffer | null = null;
	try {
		if (lstatSync(file).isFile()) current = readFileSync(file);
	} catch {
		// Absent: written below.
	}
	if (current === null || !current.equals(program)) safeResourceWrite(file, program, { mode: 0o444 });
	return file;
}

/** What a launch without the baseline program leaves open, for doctor, receipts and worker diagnostics. */
export function missingBaselineLine(reason: string): string {
	return `seccomp baseline: not loaded (${reason}), so commands can open vsock sockets to the VM host, use io_uring, trace or patch processes and create namespaces`;
}
