// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { validateSettingsFile } from "../core/config.js";
import { pancodeProjectRoot } from "../core/project-root.js";
import { resolvePancodeDirs } from "../core/xdg.js";
import {
	defaultInstallRoot,
	inactiveInstallerRecord,
	inspectInstallation,
	launcherPathFor,
} from "../domains/install/install-method.js";
import { describeTracking } from "../domains/install/install-plan.js";
import { nativeAutoUpdatePolicy } from "../domains/install/native-update.js";
import { writeCliFailure } from "./kit/json-out.js";

const HELP = `pancode paths [--json]

Print where PanCode lives, from this directory. Read-only: nothing is created.
This is the single source of truth for scripts; parse the --json form instead
of re-implementing the resolution rules.

  config, data, state, cache   the four per-user roots
  install    the installer root, and whether this binary runs from it
  tracking   what this installation follows or is pinned to
  launcher   the pancode launcher that belongs to this installation
  project    where a new project .pancode/ entry goes from here. Each existing
             entry comes from the nearest .pancode/ that has it, up to the
             repository root.

Resolution order per root: PANCODE_CONFIG_DIR / PANCODE_DATA_DIR /
PANCODE_STATE_DIR / PANCODE_CACHE_DIR beat PANCODE_HOME, which beats the platform
defaults (XDG base dirs on Linux).
`;

function launcherNote(path: string): string {
	try {
		if (lstatSync(path).isSymbolicLink()) return `  -> ${readlinkSync(path)}`;
		return "";
	} catch {
		return "  (absent)";
	}
}

export function runPathsCommand(args: ReadonlyArray<string> = []): number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) {
		// One diagnostic and a pointer at the help (C3); under --json the failure
		// document goes to stdout (C6). The success document keeps its v1 shape.
		writeCliFailure({
			path: ["paths"],
			slug: unknown.startsWith("-") ? "unknown_flag" : "usage",
			message: unknown.startsWith("-") ? `unknown flag: ${unknown}` : `unexpected argument: ${unknown}`,
			json,
		});
		return 2;
	}
	const dirs = resolvePancodeDirs();
	const installation = inspectInstallation();
	const install = installation.installer?.root ?? inactiveInstallerRecord(installation)?.root ?? defaultInstallRoot();
	const installActive = installation.installer !== undefined;
	const launcher = launcherPathFor(installation);
	let setting = true;
	try {
		setting = validateSettingsFile().settings.interface.autoUpdate;
	} catch {
		// doctor reports an unreadable settings file; the default applies here.
	}
	const tracking = describeTracking(installation, { autoUpdate: nativeAutoUpdatePolicy(installation, setting) });
	const project = pancodeProjectRoot(process.cwd());
	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					config: dirs.config,
					data: dirs.data,
					state: dirs.state,
					cache: dirs.cache,
					install,
					installActive,
					launcher,
					project,
					tracking,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}
	const absent = (path: string): string => (existsSync(path) ? "" : "  (absent)");
	const installNote = !existsSync(install)
		? "  (absent)"
		: installActive
			? "  (running from here)"
			: "  (not running from here; pancode uninstall --inactive removes it)";
	const rows: ReadonlyArray<readonly [string, string]> = [
		["config", `${dirs.config}${absent(dirs.config)}`],
		["data", `${dirs.data}${absent(dirs.data)}`],
		["state", `${dirs.state}${absent(dirs.state)}`],
		["cache", `${dirs.cache}${absent(dirs.cache)}`],
		["install", `${install}${installNote}`],
		["tracking", tracking],
		["launcher", `${launcher}${launcherNote(launcher)}`],
		["project", `${project}${existsSync(join(project, ".pancode")) ? "" : "  (no .pancode/ yet)"}`],
	];
	for (const [label, value] of rows) process.stdout.write(`${label.padEnd(8)} ${value}\n`);
	return 0;
}
