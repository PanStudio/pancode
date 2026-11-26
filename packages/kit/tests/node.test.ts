// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import { probe, server } from "../src/servers/node/index.js";
import {
	parseCpuinfo,
	parseElapsed,
	parseLscpuJson,
	parseMeminfo,
	parseMounts,
	parseNvidiaSmiCsv,
	parsePsOutput,
} from "../src/servers/node/parse.js";
import {
	MAX_ADDRESSES_PER_INTERFACE,
	MAX_GPUS,
	MAX_INTERFACES,
	MAX_MOUNTS,
	MAX_PROCESSES,
} from "../src/servers/node/tools.js";

/**
 * The node server: its parsers against output captured on a Linux x86_64
 * host and trimmed (user names replaced by placeholders), and its tools run
 * in process against this machine.
 */

const LSCPU_JSON = `{
   "lscpu": [
      {"field": "Architecture:", "data": "x86_64"},
      {"field": "CPU op-mode(s):", "data": "32-bit, 64-bit"},
      {"field": "CPU(s):", "data": "24"},
      {"field": "On-line CPU(s) list:", "data": "0-23"},
      {"field": "Vendor ID:", "data": "AuthenticAMD"},
      {"field": "Model name:", "data": "AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S"},
      {"field": "CPU family:", "data": "26"},
      {"field": "Thread(s) per core:", "data": "2"},
      {"field": "Core(s) per socket:", "data": "12"},
      {"field": "Socket(s):", "data": "1"},
      {"field": "L3 cache:", "data": "32 MiB (1 instance)"},
      {"field": "NUMA node(s):", "data": "1"}
   ]
}`;

const CPUINFO = `processor	: 0
vendor_id	: AuthenticAMD
model name	: AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S
physical id	: 0
siblings	: 24
core id		: 0
cpu cores	: 12

processor	: 1
vendor_id	: AuthenticAMD
model name	: AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S
physical id	: 0
siblings	: 24
core id		: 0
cpu cores	: 12

processor	: 2
vendor_id	: AuthenticAMD
model name	: AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S
physical id	: 0
siblings	: 24
core id		: 1
cpu cores	: 12

processor	: 3
vendor_id	: AuthenticAMD
model name	: AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S
physical id	: 0
siblings	: 24
core id		: 1
cpu cores	: 12
`;

const MEMINFO = `MemTotal:       49212344 kB
MemFree:        27739812 kB
MemAvailable:   41805512 kB
Buffers:         1964760 kB
Cached:         11774396 kB
SwapCached:       359020 kB
Active(anon):     114108 kB
SwapTotal:      50213888 kB
SwapFree:       49381044 kB
HugePages_Total:       0
`;

const MOUNTS = `/dev/sdd / ext4 rw,noatime,discard,errors=remount-ro,data=ordered 0 0
none /mnt/wslg tmpfs rw,relatime 0 0
/dev/sdd /mnt/wslg/distro ext4 ro,relatime,discard,errors=remount-ro,data=ordered 0 0
sysfs /sys sysfs rw,nosuid,nodev,noexec,noatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,noatime 0 0
tmpfs /tmp tmpfs rw,nosuid,noatime,size=4194304k 0 0
C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000,cache=0x5,access=client 0 0
`;

// This host has no NVIDIA GPU, so this is the documented shape of
// `nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits`.
const NVIDIA_SMI = `0, NVIDIA A100-SXM4-40GB, 40960, 1024, 37
1, NVIDIA A100-SXM4-40GB, 40960, [N/A], [Not Supported]
`;

const PS = `      1 root      0.0  0.0  7564  1-13:49:13 systemd
    215 _rpc      0.0  0.0   264  1-13:49:12 rpcbind
    219 systemd+  0.0  0.0  2728  1-13:49:12 systemd-resolve
    231 message+  0.0  0.0  2600  1-13:49:12 dbus-daemon
 233571 user1    48.5  1.3 650456       00:10 MainThread
 234477 user1     576  1.8 904968       00:01 esbuild
  70966 user1    36.4  1.1 584152       45:32 Web Content
`;

test("parseLscpuJson reads flat and nested lscpu JSON and refuses anything else", () => {
	assert.deepEqual(parseLscpuJson(LSCPU_JSON), {
		architecture: "x86_64",
		model: "AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S",
		sockets: 1,
		coresPerSocket: 12,
		threadsPerCore: 2,
		cpus: 24,
	});
	// Newer util-linux nests entries under children; an ARM part reports no socket count as "-".
	const nested = parseLscpuJson(
		JSON.stringify({
			lscpu: [
				{ field: "Architecture:", data: "aarch64", children: [{ field: "CPU(s):", data: "4" }] },
				{ field: "Vendor ID:", data: "ARM", children: [{ field: "Socket(s):", data: "-" }] },
			],
		}),
	);
	assert.equal(nested?.architecture, "aarch64");
	assert.equal(nested?.cpus, 4);
	assert.equal(nested?.sockets, null);
	for (const malformed of ["", "lscpu: failed", "[]", '{"lscpu": "x"}', '{"lscpu": [{"data": "x"}]}'])
		assert.equal(parseLscpuJson(malformed), null, malformed);
});

test("parseCpuinfo counts sockets, cores and threads and gives no topology it cannot see", () => {
	assert.deepEqual(parseCpuinfo(CPUINFO), {
		model: "AMD RYZEN AI MAX+ PRO 395 w/ Radeon 8060S",
		sockets: 1,
		cores: 2,
		threads: 4,
	});
	const noTopology = parseCpuinfo(CPUINFO.replace(/physical id\t: 0\n/gu, ""));
	assert.equal(noTopology?.sockets, null);
	assert.equal(noTopology?.cores, null);
	assert.equal(noTopology?.threads, 4);
	assert.equal(parseCpuinfo("garbage\nwithout: processors\n"), null);
});

test("parseMeminfo converts kB to bytes and leaves out what the file does not say", () => {
	assert.deepEqual(parseMeminfo(MEMINFO), {
		totalBytes: 49212344 * 1024,
		freeBytes: 27739812 * 1024,
		availableBytes: 41805512 * 1024,
		swapTotalBytes: 50213888 * 1024,
		swapFreeBytes: 49381044 * 1024,
	});
	assert.equal(parseMeminfo(MEMINFO.replace(/MemAvailable.*\n/u, ""))?.availableBytes, null);
	assert.equal(parseMeminfo("MemTotal: lots\nMemFree: 12 kB\n"), null);
});

test("parseMounts reads device, mount point and type and undoes octal escapes", () => {
	const mounts = parseMounts(MOUNTS);
	assert.equal(mounts.length, 7);
	assert.deepEqual(mounts[0], { device: "/dev/sdd", mountPoint: "/", type: "ext4" });
	assert.deepEqual(mounts[6], { device: "C:\\", mountPoint: "/mnt/c", type: "9p" });
	assert.deepEqual(parseMounts(`${MOUNTS}half a line\nnot/a/mount relative ext4 rw 0 0\n`).length, 7);
	assert.deepEqual(parseMounts("\x00\x01 garbage"), []);
});

test("parseNvidiaSmiCsv converts MiB to bytes, keeps unreported values null and counts bad lines", () => {
	const { gpus, malformedLines } = parseNvidiaSmiCsv(NVIDIA_SMI);
	assert.equal(malformedLines, 0);
	assert.deepEqual(gpus, [
		{
			index: 0,
			name: "NVIDIA A100-SXM4-40GB",
			memoryTotalBytes: 40960 * 1024 * 1024,
			memoryUsedBytes: 1024 * 1024 * 1024,
			utilizationPercent: 37,
		},
		{
			index: 1,
			name: "NVIDIA A100-SXM4-40GB",
			memoryTotalBytes: 40960 * 1024 * 1024,
			memoryUsedBytes: null,
			utilizationPercent: null,
		},
	]);
	const bad = parseNvidiaSmiCsv("NVIDIA-SMI has failed because it couldn't communicate with the driver\nx, y\n");
	assert.deepEqual(bad, { gpus: [], malformedLines: 2 });
});

test("parsePsOutput reads ps columns, keeps command names with spaces, and skips bad lines", () => {
	const { processes, malformedLines } = parsePsOutput(`${PS}header line\n  12 root 0.0\n`);
	assert.equal(malformedLines, 2);
	assert.equal(processes.length, 7);
	assert.deepEqual(processes[0], {
		pid: 1,
		user: "root",
		cpuPercent: 0,
		memoryPercent: 0,
		rssBytes: 7564 * 1024,
		elapsedSeconds: 86_400 + 13 * 3_600 + 49 * 60 + 13,
		command: "systemd",
	});
	assert.equal(processes[5]?.cpuPercent, 576);
	assert.equal(processes[6]?.command, "Web Content");
	assert.equal(parsePsOutput("  42 user1 1.0 0.5 100 00:05 /usr/sbin/sshd").processes[0]?.command, "sshd");
	assert.equal(parseElapsed("05"), null);
	assert.equal(parseElapsed("02:03:04"), 7_384);
	assert.deepEqual(parsePsOutput("ps: unknown option -- o\n"), { processes: [], malformedLines: 1 });
});

const context = { signal: new AbortController().signal, log: () => {} };

function tool(name: string): AnyTool {
	const found = server.tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const result = await tool(name).run(args as never, context);
	assert.ok("json" in result, JSON.stringify(result));
	return result.json as Record<string, unknown>;
}

/** Run `body` with `PATH` set to `dir` alone. */
async function withPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env.PATH;
	process.env.PATH = dir;
	try {
		return await body();
	} finally {
		process.env.PATH = saved;
	}
}

test("node_gpus without nvidia-smi says so and returns no list", async () => {
	const empty = mkdtempSync(join(tmpdir(), "kit-node-path-"));
	const result = await withPath(empty, () => call("node_gpus"));
	assert.deepEqual(result, { available: false, reason: "nvidia-smi is not on PATH" });
});

test("node_gpus keeps at most its cap of GPUs and says it cut the list", {
	skip: process.platform === "win32",
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-node-gpus-"));
	const lines = Array.from({ length: MAX_GPUS + 6 }, (_, index) => `${index}, NVIDIA H100 80GB HBM3, 81559, 0, 0`);
	writeFileSync(join(dir, "gpus.csv"), `${lines.join("\n")}\n`);
	const fake = join(dir, "nvidia-smi");
	writeFileSync(fake, `#!/bin/sh\nexec cat ${JSON.stringify(join(dir, "gpus.csv"))}\n`);
	chmodSync(fake, 0o755);
	const result = await withPath(`${dir}:/bin:/usr/bin`, () => call("node_gpus"));
	assert.equal(result.available, true);
	assert.equal((result.gpus as unknown[]).length, MAX_GPUS);
	assert.equal(result.total, MAX_GPUS + 6);
	assert.equal(result.truncated, true);
});

test("node_processes returns command names and never a process's arguments", {
	skip: process.platform === "win32",
}, async () => {
	const secret = "kit-secret-token-5f2a";
	const busy = spawn(process.execPath, ["-e", "const end = Date.now() + 20000; while (Date.now() < end);", secret], {
		stdio: "ignore",
	});
	try {
		await new Promise((settle) => setTimeout(settle, 1_500));
		const result = await call("node_processes", { sort: "cpu", limit: MAX_PROCESSES });
		assert.equal(result.available, true);
		const processes = result.processes as Array<Record<string, unknown>>;
		const mine = processes.find((entry) => entry.pid === busy.pid);
		assert.ok(mine, "the busy child ranks in the top processes by CPU");
		assert.deepEqual(Object.keys(mine).sort(), [
			"command",
			"cpuPercent",
			"elapsedSeconds",
			"memoryPercent",
			"pid",
			"rssBytes",
			"user",
		]);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
	} finally {
		busy.kill("SIGKILL");
	}
});

test("every list respects its cap and says whether it was cut", async () => {
	const processes = await call("node_processes", { sort: "memory", limit: 500 });
	if (processes.available === true) {
		assert.equal(processes.limit, MAX_PROCESSES);
		const listed = processes.processes as Array<{ memoryPercent: number }>;
		assert.ok(listed.length <= MAX_PROCESSES);
		assert.equal(processes.truncated, (processes.total as number) > listed.length);
		for (let index = 1; index < listed.length; index++)
			assert.ok((listed[index - 1]?.memoryPercent ?? 0) >= (listed[index]?.memoryPercent ?? 0));
	}
	const one = await call("node_processes", { limit: 0 });
	if (one.available === true) assert.equal(one.limit, 1);
	assert.match(JSON.stringify(await tool("node_processes").run({ sort: "pid" } as never, context)), /cpu or memory/);

	const disks = await call("node_disks", { includePseudo: true });
	const mounts = disks.mounts as Array<Record<string, unknown>>;
	assert.ok(mounts.length > 0 && mounts.length <= MAX_MOUNTS);
	assert.equal(disks.truncated, (disks.total as number) > mounts.length);
	const filtered = await call("node_disks");
	if (process.platform === "linux") assert.ok((filtered.pseudoSkipped as number) > 0, "proc and sysfs are left out");
	assert.ok((filtered.mounts as unknown[]).every((mount) => (mount as { type: string }).type !== "proc"));

	const network = await call("node_network");
	const interfaces = network.interfaces as Array<{ addresses: unknown[] }>;
	assert.ok(interfaces.length <= MAX_INTERFACES);
	assert.ok(interfaces.every((entry) => entry.addresses.length <= MAX_ADDRESSES_PER_INTERFACE));
	assert.equal(network.truncated, (network.total as number) > interfaces.length);
	assert.doesNotMatch(JSON.stringify(network), /"mac"|([0-9a-f]{2}:){5}[0-9a-f]{2}/iu);
});

test("node_cpu, node_memory and node_disks answer in numbers and give a reason for every null", async () => {
	for (const name of ["node_cpu", "node_memory"]) {
		const facts = await call(name);
		const unavailable = facts.unavailable as Record<string, string>;
		for (const [key, value] of Object.entries(facts)) {
			if (value === null) assert.ok(unavailable[key], `${name}.${key} is null without a reason`);
		}
	}
	const memory = await call("node_memory");
	assert.ok((memory.totalBytes as number) > 0);
	const cpu = await call("node_cpu");
	assert.ok((cpu.threads as number) > 0);
	const disk = await call("node_disks", { path: "." });
	assert.ok((disk.sizeBytes as number) > 0);
	if (process.platform === "linux") assert.equal(typeof disk.type, "string");
});

test("the probe reports available and names the optional sources it found", async () => {
	const probed = await probe();
	assert.equal(probed.available, true);
	assert.deepEqual(
		probed.sources?.map((source) => source.name),
		["/proc", "lscpu", "nvidia-smi", "ps"],
	);
});
