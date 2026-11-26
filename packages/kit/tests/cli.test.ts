// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/exec.js";
import { configureServer, type ServerModule, ServerUsageError, serverIds } from "../src/registry.js";

/**
 * The kit entry PanCode serves and probes its built-in MCP servers through,
 * and `runCommand`, the one way a built-in server runs a site command.
 */

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cli = join(root, "packages/kit/src/cli.ts");

function kit(...args: string[]) {
	const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the kit entry probes each server with the options it is given, and refuses an unknown server", async () => {
	const ids = serverIds();
	const scratch = mkdtempSync(join(tmpdir(), "kit-doctor-"));
	const catalogFile = join(scratch, "catalog.json");
	const doctor = kit(
		"doctor",
		JSON.stringify({ catalog: ["--file", catalogFile], scidata: ["--cache", join(scratch, "readers")] }),
	);
	assert.equal(doctor.code, 0, doctor.stderr);
	const probed = JSON.parse(doctor.stdout).servers as Array<{
		id: string;
		available: boolean;
		reason?: string;
		sources?: unknown[];
	}>;
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
	assert.deepEqual(probed.find((row) => row.id === "catalog")?.sources, [{ name: catalogFile, found: false }]);

	// A server that refuses its options, here scidata and catalog without the paths they require, is a failed probe.
	const bare = kit("doctor");
	assert.equal(bare.code, 1);
	const refused = JSON.parse(bare.stdout).servers as Array<{ id: string; available: boolean; reason?: string }>;
	assert.match(
		refused.find((row) => row.id === "catalog")?.reason ?? "",
		/^the probe failed: --file <path> is required/,
	);
	assert.match(
		refused.find((row) => row.id === "scidata")?.reason ?? "",
		/^the probe failed: --cache <dir> is required/,
	);

	const serve = kit("serve", "unknown");
	assert.equal(serve.code, 2);
	assert.equal(serve.stdout, "", "serve writes nothing but protocol frames on stdout");
	assert.match(serve.stderr, new RegExp(`unknown server unknown\nservers: ${ids.join(", ")}`));

	assert.equal(kit("doctor", "not json").code, 2);
	assert.equal(kit("doctor", "{}", "extra").code, 2);
	assert.equal(kit("list").code, 2);
	assert.equal(kit().code, 2);
});

test("serve refuses options for a server without configure, before it serves", () => {
	const serve = kit("serve", "node", "--bogus");
	assert.equal(serve.code, 2);
	assert.equal(serve.stdout, "");
	assert.match(serve.stderr, /server node takes no options, got --bogus/);
});

test("serve <server> --help prints the server's options and, for catalog, a file the catalog parser takes", async () => {
	const help = kit("serve", "catalog", "--help");
	assert.equal(help.code, 0, help.stderr);
	assert.match(help.stdout, /^Usage: pancode mcp serve catalog \[options\.\.\.\]/);
	assert.match(help.stdout, /--file <path> {2}the catalog file to read \(required\)/);
	const { parseCatalogFile } = await import("../src/servers/catalog/parse.js");
	const example = help.stdout.slice(help.stdout.indexOf("\n{") + 1);
	assert.ok(parseCatalogFile(example).ok, example);
	const node = kit("serve", "node", "--help");
	assert.equal(node.code, 0);
	assert.match(node.stdout, /This server takes no options\./);
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
	const missing = await runCommand("kit-no-such-program", [], { timeoutMs: 5_000 });
	assert.equal(missing.kind, "not-found");
	assert.equal(missing.spawned, false);
	assert.equal(missing.path, null);
	assert.match(missing.message ?? "", /not on PATH/);

	// The PATH the command gets is the one searched, so `node` is not found on an empty directory.
	const empty = mkdtempSync(join(tmpdir(), "kit-path-"));
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
	const name = "KIT_TEST_PARENT_ONLY";
	process.env[name] = "from-the-parent";
	t.after(() => {
		delete process.env[name];
	});
	const dump = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
	const plain = JSON.parse((await runCommand(node, dump, { timeoutMs: 10_000 })).stdout) as Record<string, string>;
	assert.equal(plain[name], undefined);
	assert.equal(plain.PATH, process.env.PATH);

	const allowed = JSON.parse(
		(await runCommand(node, dump, { timeoutMs: 10_000, envAllowlist: [name], env: { KIT_EXPLICIT: "set" } })).stdout,
	) as Record<string, string>;
	assert.equal(allowed[name], "from-the-parent");
	assert.equal(allowed.KIT_EXPLICIT, "set");
});
