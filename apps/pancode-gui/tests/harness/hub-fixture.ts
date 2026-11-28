// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * A hang guard for one source CLI, not a performance budget. With the run's tsx
 * cache shared (tests/harness/tmp-root.ts) the slowest oracle CLI took 2.5 s and
 * the seed 0.4 s at load ~19; on a cold cache, as on a fresh CI host, 7.6 s and
 * 0.8 s. Before the cache was shared every run paid the cold cost. 30 s is 4x the
 * cold worst case and 12x the warm one.
 */
const CLI_HANG_GUARD_MS = 30_000;
/** Runs `fixtures/<name>-seed.ts` from source with `args` and returns what it prints. */
async function runSeed(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	const seed = fileURLToPath(new URL(`../fixtures/${name}-seed.ts`, import.meta.url));
	const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), seed, ...args], {
		env,
		timeout: CLI_HANG_GUARD_MS,
		maxBuffer: 1024 * 1024,
	});
	return result.stdout;
}

export async function seedHub(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	await runSeed("hub", [cwd], env);
}

export async function seedReports(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	await runSeed("reports", [cwd], env);
}

export async function seedEvidence(cwd: string, env: NodeJS.ProcessEnv) {
	return JSON.parse(await runSeed("evidence", [cwd], env)) as { count: number; runId: string };
}

export async function seedFleet(cwd: string, env: NodeJS.ProcessEnv) {
	return JSON.parse(await runSeed("fleet", [cwd], env)) as { count: number; gateId: string };
}

export async function seedSettings(cwd: string, env: NodeJS.ProcessEnv, targetId = "fixture-target") {
	return JSON.parse(await runSeed("settings", [cwd, targetId], env)) as {
		settingsKeys: string[];
		controlPaths: string[];
		categories: string[];
	};
}

/**
 * The CLI both sides of a PanHub comparison run: the server through `PANCODE_WEB_CLI`, the oracle directly.
 * It is the checkout's source, so a missing or stale `dist/` cannot make the server answer with a problem or
 * agree with old code.
 */
export const sourceCli = fileURLToPath(new URL("../fixtures/source-cli.mjs", import.meta.url));
export const sourceCliEnv = { PANCODE_WEB_CLI: sourceCli } as const;

export async function hubOracle(cwd: string, env: NodeJS.ProcessEnv) {
	const cli = sourceCli;
	const run = async (argv: string[]) =>
		JSON.parse(
			(
				await promisify(execFile)(process.execPath, [cli, ...argv], {
					cwd,
					env,
					timeout: CLI_HANG_GUARD_MS,
					maxBuffer: 8 * 1024 * 1024,
				})
			).stdout,
		);
	const [recipes, packages, agents, extensions, verifiers] = await Promise.all([
		run(["hub", "components", "--json"]),
		run(["hub", "list", "--json"]),
		run(["agents", "--json"]),
		run(["extensions", "list", "--all", "--json"]),
		run(["verifiers", "inspect", "--json"]),
	]);
	return { recipes, packages, agents, extensions, verifiers };
}
