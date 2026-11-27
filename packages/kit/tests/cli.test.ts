// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../hub/packs/plugins/hpc/src/exec.js";
import {
	configureServer,
	loadServer,
	SERVERS,
	type ServerModule,
	ServerUsageError,
	serverIds,
} from "../src/registry.js";

/**
 * The `pankit` command on the registry as it ships, and `runCommand`, the one
 * way a PanKit server runs a site command.
 */

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cli = join(root, "packages/kit/src/cli.ts");

function pankit(...args: string[]) {
	const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("pankit lists, probes and prints the manifest of the registry, and refuses an unknown server", async () => {
	const ids = serverIds();
	const loaded = await Promise.all(SERVERS.map((entry) => loadServer(entry)));
	const rows = loaded.map(({ server }) => ({
		id: server.id,
		title: server.title ?? server.id,
		version: server.version,
		tools: server.tools.length,
	}));
	const list = pankit("list", "--json");
	assert.equal(list.code, 0, list.stderr);
	assert.deepEqual(JSON.parse(list.stdout), { servers: rows });
	const width = Math.max(...ids.map((id) => id.length));
	assert.equal(
		pankit("list").stdout,
		rows
			.map((row) => `${row.id.padEnd(width)}  ${row.title} (${row.tools} tool${row.tools === 1 ? "" : "s"})\n`)
			.join(""),
	);
	assert.equal(rows.find((row) => row.id === "node")?.title, "Node facts");

	const doctor = pankit("doctor", "--json");
	assert.equal(doctor.code, 0, doctor.stderr);
	const probed = JSON.parse(doctor.stdout).servers as Array<{ id: string; available: boolean; sources?: unknown[] }>;
	assert.deepEqual(
		probed.map((row) => row.id),
		ids,
	);
	for (const row of probed) assert.equal(typeof row.available, "boolean", row.id);
	const node = probed.find((row) => row.id === "node");
	assert.equal(node?.available, true);
	assert.deepEqual(
		node?.sources?.map((source) => (source as { name: string }).name),
		["/proc", "lscpu", "nvidia-smi", "ps"],
	);

	const manifest = pankit("manifest");
	assert.equal(manifest.code, 0, manifest.stderr);
	const entries = JSON.parse(manifest.stdout).servers as Array<{ id: string; environment: string[] }>;
	assert.deepEqual(
		entries.map((entry) => entry.id),
		ids,
	);
	assert.deepEqual(
		entries.map((entry) => entry.environment),
		loaded.map((module) => [...(module.environment ?? [])].sort()),
	);

	const serve = pankit("serve", "unknown");
	assert.equal(serve.code, 2);
	assert.equal(serve.stdout, "", "serve writes nothing but protocol frames on stdout");
	assert.match(serve.stderr, new RegExp(`unknown server unknown\nservers: ${ids.join(", ")}`));

	assert.equal(pankit("list", "--bogus").code, 2);
	assert.equal(pankit("bogus").code, 2);
	assert.equal(pankit().code, 2);
	const help = pankit("--help");
	assert.equal(help.code, 0);
	assert.match(help.stdout, /pankit serve <server> \[options\.\.\.\]/);
	const version = pankit("--version");
	assert.equal(version.code, 0);
	assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});

test("pankit serve refuses options for a server without configure, before it serves", () => {
	const serve = pankit("serve", "node", "--bogus");
	assert.equal(serve.code, 2);
	assert.equal(serve.stdout, "");
	assert.match(serve.stderr, /server node takes no options, got --bogus/);
});

test("configureServer hands the options over once and turns a ServerUsageError into usage text", () => {
	const fixture = (configure?: ServerModule["configure"], usage?: string): ServerModule => ({
		server: { id: "fixture", version: "0.0.0", tools: [] },
		probe: async () => ({ available: true }),
		...(configure !== undefined ? { configure } : {}),
		...(usage !== undefined ? { usage } : {}),
	});
	assert.equal(configureServer("fixture", fixture(), []), null);
	assert.equal(configureServer("fixture", fixture(), ["--x"]), "server fixture takes no options, got --x");

	const calls: string[][] = [];
	const taking = fixture((argv) => {
		calls.push([...argv]);
	});
	assert.equal(configureServer("fixture", taking, ["--root", "/data"]), null);
	assert.deepEqual(calls, [["--root", "/data"]]);

	const refusing = fixture((argv) => {
		throw new ServerUsageError(`unknown option ${argv[0]}`);
	}, "options: --root <dir>\n");
	assert.equal(configureServer("fixture", refusing, ["--bad"]), "unknown option --bad\noptions: --root <dir>");
	const broken = fixture(() => {
		throw new Error("not a usage error");
	});
	assert.throws(() => configureServer("fixture", broken, []), /not a usage error/);
});

const node = process.execPath;

test("runCommand reports a program missing from PATH without spawning it", async () => {
	const missing = await runCommand("pankit-no-such-program", [], { timeoutMs: 5_000 });
	assert.equal(missing.kind, "not-found");
	assert.equal(missing.spawned, false);
	assert.equal(missing.path, null);
	assert.match(missing.message ?? "", /not on PATH/);

	// The PATH the command gets is the one searched, so `node` is not found on an empty directory.
	const empty = mkdtempSync(join(tmpdir(), "pankit-path-"));
	const shadowed = await runCommand("node", ["--version"], { timeoutMs: 5_000, env: { PATH: empty } });
	assert.equal(shadowed.kind, "not-found");
	assert.equal(shadowed.spawned, false);
});

test("runCommand passes argv without a shell and tells a non-zero exit from success", async () => {
	const literal = "$(echo injected); echo also";
	const echoed = await runCommand(node, ["-e", "process.stdout.write(process.argv[1])", literal], {
		timeoutMs: 10_000,
	});
	assert.equal(echoed.kind, "ok");
	assert.equal(echoed.spawned, true);
	assert.equal(echoed.stdout, literal);

	const failed = await runCommand(node, ["-e", "process.stderr.write('bad'); process.exit(3)"], { timeoutMs: 10_000 });
	assert.equal(failed.kind, "exit");
	assert.equal(failed.code, 3);
	assert.equal(failed.stderr, "bad");
});

test("runCommand stops a command at its timeout", async () => {
	const result = await runCommand(node, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 300 });
	assert.equal(result.kind, "timeout");
	assert.equal(result.spawned, true);
	assert.ok(result.durationMs < 10_000, `stopped after ${result.durationMs} ms`);
	assert.match(result.message ?? "", /did not finish within 300 ms/);
});

test("runCommand keeps at most maxOutputBytes of each stream", async () => {
	const result = await runCommand(node, ["-e", "process.stdout.write('x'.repeat(200_000))"], {
		timeoutMs: 10_000,
		maxOutputBytes: 1_000,
	});
	assert.equal(result.kind, "ok");
	assert.equal(result.stdout, "x".repeat(1_000));
	assert.equal(result.truncated, true);
});

test("runCommand stops a command when its signal aborts, and never starts one already aborted", async () => {
	const controller = new AbortController();
	const running = runCommand(node, ["-e", "setTimeout(() => {}, 60_000)"], {
		timeoutMs: 60_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 200);
	const result = await running;
	assert.equal(result.kind, "aborted");
	assert.equal(result.spawned, true);

	const before = await runCommand(node, ["--version"], { timeoutMs: 5_000, signal: AbortSignal.abort() });
	assert.equal(before.kind, "aborted");
	assert.equal(before.spawned, false);
});

test("runCommand builds the environment from an allowlist instead of inheriting it", async (t) => {
	const name = "PANKIT_TEST_PARENT_ONLY";
	process.env[name] = "from-the-parent";
	t.after(() => {
		delete process.env[name];
	});
	const dump = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
	const plain = JSON.parse((await runCommand(node, dump, { timeoutMs: 10_000 })).stdout) as Record<string, string>;
	assert.equal(plain[name], undefined);
	assert.equal(plain.PATH, process.env.PATH);

	const allowed = JSON.parse(
		(await runCommand(node, dump, { timeoutMs: 10_000, envAllowlist: [name], env: { PANKIT_EXPLICIT: "set" } })).stdout,
	) as Record<string, string>;
	assert.equal(allowed[name], "from-the-parent");
	assert.equal(allowed.PANKIT_EXPLICIT, "set");
});
