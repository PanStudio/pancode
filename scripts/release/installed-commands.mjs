// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The installed `pancode` command, run from an npm prefix that holds the `pancode` package:
 * `pancode --version` names the package version.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The name PanCode is published under on npm. */
export const PACKAGE_NAME = "@panstudio/pancode";

/** `[node, <bin target>]` for one command of the installed package, so no shell or `.cmd` shim is involved. */
function binTarget(prefix, command) {
	const packageRoot = join(prefix, "node_modules", PACKAGE_NAME);
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const target = manifest.bin?.[command];
	if (typeof target !== "string") throw new Error(`the installed ${PACKAGE_NAME} package has no ${command} bin`);
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
 * Runs the check against the package installed under `prefix` and returns what it read.
 * `env` must carry a scratch PanCode home.
 */
export function checkInstalledCommands({ prefix, env, version }) {
	const started = Date.now();
	const reported = runCommand(prefix, "pancode", ["--version"], env).trim();
	if (!reported.includes(version)) throw new Error(`pancode --version printed ${reported}; expected ${version}`);
	return { pancodeVersion: reported, ms: Date.now() - started };
}
