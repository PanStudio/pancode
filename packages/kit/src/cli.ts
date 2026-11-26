// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The entry PanCode runs its built-in MCP servers through: `serve <server>
 * [options...]` for a session's builtin scope, and `doctor [<options>]` for
 * `pancode doctor`, where `<options>` is a JSON object from server id to the
 * options it starts with. Nothing installs it as a command; people run
 * `pancode mcp serve`.
 */
import { probeServers, serveServer } from "./host.js";

const USAGE = "usage: cli.js serve <server> [options...] | cli.js doctor [<options json>]\n";

function launchOptions(text: string | undefined): Record<string, string[]> | null {
	if (text === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const entries = Object.entries(parsed);
	const valid = entries.every(([, value]) => Array.isArray(value) && value.every((arg) => typeof arg === "string"));
	return valid ? Object.fromEntries(entries) : null;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "serve") return serveServer(rest);
	const options = command === "doctor" && rest.length <= 1 ? launchOptions(rest[0]) : null;
	if (options === null) {
		process.stderr.write(USAGE);
		return 2;
	}
	const { code, servers } = await probeServers(options);
	process.stdout.write(`${JSON.stringify({ servers }, null, 2)}\n`);
	return code;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
