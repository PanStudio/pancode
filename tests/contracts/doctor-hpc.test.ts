// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HPC_TOOLS, hpcToolchainFindings, pankitFindings } from "../../src/cli/doctor-hpc.js";
import { pdfAttachmentFinding } from "../../src/cli/doctor-toolchain.js";
import { formatDoctorReport } from "../../src/domains/lifecycle/doctor.js";
import { popplerInstallHint } from "../../src/tools/read-documents/pdf.js";
import { builtinFixtureSource } from "../fixtures/mcp-builtin-server.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

let root: string;
let bin: string;
let workspace: string;
let savedPath: string | undefined;

function fakeTool(name: string, body: string): void {
	const file = path.join(bin, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
}

function contract(yaml: string): void {
	mkdirSync(path.join(workspace, ".pancode"), { recursive: true });
	writeFileSync(path.join(workspace, ".pancode", "validation.yaml"), yaml);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "pancode-doctor-hpc-"));
	bin = path.join(root, "bin");
	workspace = path.join(root, "ws");
	mkdirSync(bin);
	mkdirSync(workspace);
	savedPath = process.env.PATH;
	// Only the fixture directory: no dependence on this host's compilers.
	process.env.PATH = bin;
});

afterEach(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	rmSync(root, { recursive: true, force: true });
});

describe("doctor HPC toolchain probes", () => {
	it("reports path and first version line, falls back cc to gcc, and marks absent tools info", async () => {
		fakeTool("gcc", 'echo "gcc (Fixture) 13.2.0"; echo "Copyright line"');
		fakeTool(
			"nvcc",
			'echo "nvcc: NVIDIA (R) Cuda compiler driver" >&2; echo "" >&2; echo "Cuda compilation tools, release 12.4" >&2',
		);
		fakeTool("sbatch", 'echo "sbatch: error: fetch_config: DNS SRV lookup failed" >&2; exit 1');
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace });
		deepStrictEqual(
			findings.map((f) => f.name),
			HPC_TOOLS.map((tool) => `toolchain ${tool.name}`),
		);
		const byName = new Map(findings.map((f) => [f.name, f]));
		deepStrictEqual(byName.get("toolchain cc"), {
			ok: true,
			name: "toolchain cc",
			level: "ok",
			detail: `${path.join(bin, "gcc")}: gcc (Fixture) 13.2.0`,
		});
		strictEqual(byName.get("toolchain nvcc")?.detail, `${path.join(bin, "nvcc")}: Cuda compilation tools, release 12.4`);
		// Installed but unable to answer, as an unconfigured Slurm client is.
		deepStrictEqual(byName.get("toolchain sbatch"), {
			ok: true,
			name: "toolchain sbatch",
			level: "warn",
			detail: `${path.join(bin, "sbatch")}: host has no Slurm configuration or controller to reach: sbatch: error: fetch_config: DNS SRV lookup failed`,
		});
		deepStrictEqual(byName.get("toolchain mpirun"), {
			ok: true,
			name: "toolchain mpirun",
			level: "info",
			detail: "not on PATH",
		});
		ok(findings.every((f) => f.ok));
		match(formatDoctorReport(findings), /^INFO toolchain meson\s+not on PATH$/m);
	});

	it("bounds a version spawn that never answers and runs the probes in parallel", async () => {
		// PATH is the fixture directory, so the hung fakes name sleep absolutely.
		const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((file) => existsSync(file)) ?? "sleep";
		fakeTool("mpirun", `exec ${sleep} 30`);
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace, timeoutMs: 400 });
		const mpirun = findings.find((f) => f.name === "toolchain mpirun");
		strictEqual(mpirun?.level, "ok");
		match(mpirun?.detail ?? "", /: no version line \(--version did not answer within 400ms\)$/);
		// Each fake answers only once all three are running, so probes in series would leave the first unanswered.
		const barrier = ["mpirun", "cmake", "ninja"].map((name) => path.join(root, `started-${name}`));
		for (const name of ["mpirun", "cmake", "ninja"]) {
			const waits = barrier.map((file) => `[ -e ${file} ]`).join(" && ");
			fakeTool(
				name,
				`: > ${path.join(root, `started-${name}`)}\nuntil ${waits}; do ${sleep} 0.01; done\necho "${name} 1.0"`,
			);
		}
		const parallel = await hpcToolchainFindings({ workspaceRoot: workspace, timeoutMs: 30_000 });
		for (const name of ["mpirun", "cmake", "ninja"]) {
			strictEqual(parallel.find((f) => f.name === `toolchain ${name}`)?.detail, `${path.join(bin, name)}: ${name} 1.0`);
		}
	});

	it("warns for an absent tool the validation contract names or a slurm runtime needs", async () => {
		fakeTool("make", 'echo "GNU Make 4.3"');
		contract(
			[
				"version: 1",
				"runtime:",
				"  kind: slurm",
				"validators:",
				'  - "cmake --build build && make check"',
				'  - "/opt/tools/bin/mpicc -o probe probe.c"',
			].join("\n"),
		);
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace });
		const byName = new Map(findings.map((f) => [f.name, f]));
		deepStrictEqual(byName.get("toolchain sbatch"), {
			ok: true,
			name: "toolchain sbatch",
			level: "warn",
			detail: "not on PATH; runtime.kind slurm needs it",
		});
		strictEqual(byName.get("toolchain cmake")?.level, "warn");
		strictEqual(byName.get("toolchain cmake")?.detail, "not on PATH; the validation contract names it");
		strictEqual(byName.get("toolchain mpicc")?.level, "warn");
		strictEqual(byName.get("toolchain make")?.level, "ok");
		strictEqual(byName.get("toolchain nvcc")?.level, "info");
		ok(findings.every((f) => f.ok));
	});
});

describe("doctor pdf attachments row (#438)", () => {
	it("is INFO naming the install command without poppler, and OK with the pdftotext -v version with it", async () => {
		const missing = await pdfAttachmentFinding();
		strictEqual(missing.level, "info");
		match(missing.detail, /^pdftotext and pdfinfo not on PATH; /);
		ok(missing.detail.includes(popplerInstallHint()));
		fakeTool("pdftotext", 'echo "pdftotext version 24.02.0" >&2');
		fakeTool("pdfinfo", "exit 0");
		deepStrictEqual(await pdfAttachmentFinding(), {
			ok: true,
			name: "pdf attachments",
			level: "ok",
			detail: `${path.join(bin, "pdftotext")}: pdftotext version 24.02.0; pdfinfo ${path.join(bin, "pdfinfo")}`,
		});
	});
});

/** A stand-in for `pankit` whose `doctor --json` runs `body` (an ES module body with `argv` in scope). */
function fakeKit(body: string): string {
	const file = path.join(root, "fake-kit.mjs");
	writeFileSync(file, `const argv = process.argv.slice(2);\n${body}\n`);
	return file;
}

function report(servers: unknown[], exitCode = 0): string {
	return `process.stdout.write(JSON.stringify(${JSON.stringify({ servers })})); process.exitCode = ${exitCode};`;
}

function filesIn(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

describe("doctor PanKit rows", () => {
	it("is one row per manifest server: ok with the sources found, info with the reason verbatim, store available in sessions", async () => {
		const entry = fakeKit(
			report([
				{ id: "store", available: false, reason: "no store root: pass --root" },
				{ id: "slurm", available: false, reason: "needs Slurm: sbatch is not on PATH", sources: [] },
				{
					id: "kitfix",
					available: true,
					sources: [
						{ name: "fix", found: true },
						{ name: "other", found: false },
					],
				},
			]),
		);
		const source = { ...builtinFixtureSource(root, ["kitfix", "slurm", "store"]), entry };
		deepStrictEqual(await pankitFindings({ workspaceRoot: workspace, source }), [
			{ ok: true, name: "pankit kitfix", level: "ok", detail: "available; found: fix" },
			{ ok: true, name: "pankit slurm", level: "info", detail: "needs Slurm: sbatch is not on PATH" },
			{
				ok: true,
				name: "pankit store",
				level: "ok",
				detail: "available in sessions: PanCode passes this project's store roots",
			},
		]);
	});

	it("warns for a server the kit did not report and for a probe that failed, even on exit 1", async () => {
		const entry = fakeKit(
			report([{ id: "slurm", available: false, reason: "the probe failed: EACCES reading /etc/slurm" }], 1),
		);
		const source = { ...builtinFixtureSource(root, ["kitfix", "slurm"]), entry };
		deepStrictEqual(await pankitFindings({ workspaceRoot: workspace, source }), [
			{ ok: true, name: "pankit kitfix", level: "warn", detail: "the kit did not report this server" },
			{ ok: true, name: "pankit slurm", level: "warn", detail: "the probe failed: EACCES reading /etc/slurm" },
		]);
	});

	it("bounds a kit that never answers to one warn row", async () => {
		const entry = fakeKit('process.stderr.write("probing modules\\n"); setInterval(() => {}, 1000);');
		const source = { ...builtinFixtureSource(root, ["kitfix", "slurm"]), entry };
		// The row names the bound that fired; a kit that stalled the probe would never return it.
		const findings = await pankitFindings({ workspaceRoot: workspace, source, timeoutMs: 300 });
		deepStrictEqual(findings, [
			{ ok: true, name: "pankit", level: "warn", detail: "pankit doctor did not answer within 300ms: probing modules" },
		]);
	});

	it("passes the kit a variable the manifest declares and withholds one it does not", async () => {
		const entry = fakeKit(
			`process.stdout.write(JSON.stringify({ servers: [{ id: "kitfix", available: false, reason: \`declared=\${process.env.KITFIX_DECLARED} undeclared=\${process.env.KITFIX_UNDECLARED} argv=\${argv.join(" ")}\` }] }));`,
		);
		const source = {
			...builtinFixtureSource(root, ["kitfix"], (manifest) => {
				(manifest.servers[0] as { environment: string[] }).environment = ["KITFIX_DECLARED"];
			}),
			entry,
		};
		process.env.KITFIX_DECLARED = "yes";
		process.env.KITFIX_UNDECLARED = "leaked";
		try {
			const [row] = await pankitFindings({ workspaceRoot: workspace, source });
			strictEqual(row?.detail, "declared=yes undeclared=undefined argv=doctor --json");
		} finally {
			delete process.env.KITFIX_DECLARED;
			delete process.env.KITFIX_UNDECLARED;
		}
	});

	it("spawns nothing when the manifest ships no server", async () => {
		const marker = path.join(root, "spawned");
		const entry = fakeKit(`(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "");`);
		const source = { ...builtinFixtureSource(root, []), entry };
		deepStrictEqual(await pankitFindings({ workspaceRoot: workspace, source }), [
			{ ok: true, name: "pankit", level: "info", detail: "this PanCode ships no PanKit servers" },
		]);
		ok(!existsSync(marker));
	});

	it("probes the shipped kit on an untouched home: a row per shipped server, catalog and scidata naming PanCode's paths", async () => {
		const env = await isolatePancodeEnv("pancode-doctor-pankit-");
		const savedHome = process.env.HOME;
		process.env.HOME = env.dir;
		try {
			const shipped = JSON.parse(readFileSync(new URL("../../packages/kit/servers.json", import.meta.url), "utf8")) as {
				servers: Array<{ id: string }>;
			};
			const before = filesIn(env.dir);
			const findings = await pankitFindings({ workspaceRoot: workspace });
			deepStrictEqual(
				findings.map((finding) => finding.name),
				shipped.servers.map((server) => `pankit ${server.id}`),
			);
			const byName = new Map(findings.map((finding) => [finding.name, finding]));
			strictEqual(byName.get("pankit node")?.level, "ok");
			const catalogFile = path.join(env.dir, "config", "pankit", "catalog.json");
			const catalog = byName.get("pankit catalog")?.detail ?? "";
			ok(catalog.includes(catalogFile), catalog);
			const scidata = byName.get("pankit scidata")?.detail ?? "";
			ok(scidata.includes(path.join(env.dir, "cache", "pankit", "data-readers")), scidata);
			deepStrictEqual(filesIn(env.dir), before);
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			env.restore();
		}
	});
});
