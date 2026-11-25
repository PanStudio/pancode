// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The installed `panstore` and `pankit` commands, run from an npm prefix that holds the `pancode` package:
 * `panstore --version` prints the package version, `pankit list` lists exactly the PanKit servers, and
 * `pankit serve node` answers one MCP `initialize` over stdio and exits 0 once stdin closes.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The servers the `pancode` package ships, as `pankit list` prints them. */
export const KIT_SERVERS = ["node", "modules", "spack", "darshan", "scidata", "catalog", "store"];
/** The MCP handshake must finish, and the server exit, within this. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The server ids in `pankit list` output: the first word of each line. */
export function listedServers(stdout) {
	return stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/u)[0])
		.filter(Boolean);
}

/** Problems with a `pankit list` result: a non-zero exit, or any server missing, extra or repeated. */
export function kitListProblems(listed, expected = KIT_SERVERS) {
	const want = [...expected].sort();
	const got = [...listed].sort();
	return JSON.stringify(got) === JSON.stringify(want)
		? []
		: [`pankit list printed ${got.join(", ") || "no servers"}; expected exactly ${want.join(", ")}`];
}

/** `[node, <bin target>]` for one command of the installed package, so no shell or `.cmd` shim is involved. */
function binTarget(prefix, command) {
	const packageRoot = join(prefix, "node_modules", "pancode");
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const target = manifest.bin?.[command];
	if (typeof target !== "string") throw new Error(`the installed pancode package has no ${command} bin`);
	return join(packageRoot, target);
}

function runCommand(prefix, command, args, env) {
	const result = spawnSync(process.execPath, [binTarget(prefix, command), ...args], {
		cwd: prefix,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error(`could not start ${command}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}${result.stderr}`);
	return result.stdout;
}

/**
 * Sends `initialize`, reads the response with `serverInfo`, sends `notifications/initialized`, closes stdin and
 * waits for exit 0. Everything within `timeoutMs`; the server is killed past it.
 */
export function mcpHandshake(command, args, { cwd, env, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let serverInfo = null;
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				child.kill("SIGKILL");
				reject(new Error(`${error}${stderr ? `\nstderr: ${stderr.trim()}` : ""}`));
			} else resolve(value);
		};
		const timer = setTimeout(
			() =>
				finish(`the MCP handshake did not finish within ${timeoutMs} ms (serverInfo ${serverInfo ? "read" : "unread"})`),
			timeoutMs,
		);
		child.once("error", (error) => finish(`could not start the server: ${error.message}`));
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			for (let newline = stdout.indexOf("\n"); newline >= 0 && !serverInfo; newline = stdout.indexOf("\n")) {
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (!line) continue;
				let frame;
				try {
					frame = JSON.parse(line);
				} catch {
					finish(`the server wrote a line that is not JSON: ${line.slice(0, 200)}`);
					return;
				}
				if (frame.id !== 1) continue;
				if (!frame.result?.serverInfo?.name) {
					finish(`initialize returned no serverInfo: ${line.slice(0, 200)}`);
					return;
				}
				serverInfo = frame.result.serverInfo;
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
				child.stdin.end();
			}
		});
		child.once("close", (code, signal) => {
			if (!serverInfo) finish(`the server exited (${signal ?? code}) before answering initialize`);
			else if (code !== 0) finish(`the server exited ${signal ?? code} after the handshake; expected 0`);
			else
				finish(null, {
					serverInfo: { name: serverInfo.name, version: serverInfo.version },
					ms: Date.now() - started,
				});
		});
		child.stdin.on("error", () => {
			// A server that exits early closes the pipe; its exit is reported by "close".
		});
		const initialize = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pancode-release-check", version: "1" },
			},
		};
		child.stdin.write(`${JSON.stringify(initialize)}\n`);
	});
}

/**
 * Runs the three checks against the `pancode` package installed under `prefix` and returns what they read.
 * `env` must carry a scratch PanCode home.
 */
export async function checkInstalledCommands({ prefix, env, version }) {
	const started = Date.now();
	const panstore = runCommand(prefix, "panstore", ["--version"], env).trim();
	if (panstore !== version) throw new Error(`panstore --version printed ${panstore}; expected ${version}`);
	const servers = listedServers(runCommand(prefix, "pankit", ["list"], env));
	const problems = kitListProblems(servers);
	if (problems.length > 0) throw new Error(problems.join("\n"));
	const handshake = await mcpHandshake(process.execPath, [binTarget(prefix, "pankit"), "serve", "node"], {
		cwd: prefix,
		env,
	});
	return { panstoreVersion: panstore, pankitServers: servers, pankitServeNode: handshake, ms: Date.now() - started };
}
