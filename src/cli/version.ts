// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readBuildProvenance, readPancodeVersionLabel, runningBuildId } from "../core/build-info.js";
import { readPancodeVersion } from "../core/package-root.js";
import { parseCommandFlags } from "./kit/flags.js";
import { helpRequested } from "./kit/help.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";

const HELP = `pancode version [--worker-specs | --build | --sandbox | --json]

Print the PanCode version; pancode --version and -v are the same. --worker-specs
prints the worker spec versions this install's worker reads, space separated. --build
prints the id of this build, or unknown for a source run. --sandbox prints, as one
JSON line, the OS sandbox a worker on this host would start: available, backend,
reason, and network (null when it can also isolate the network, else why not).
--json prints the rest as
one JSON document: version (the document schema, 1), pancodeVersion, label, commit,
dirty, build, workerSpecs and herdr.
`;

const VERSION_PATH = ["version"] as const;

/**
 * `--build` prints the id of the running build, or `unknown`, so fleet
 * preflight can tell two builds of one `-dev` version apart. A build older
 * than the flag rejects it, which preflight reads as an unknown build.
 * `--worker-specs` prints the worker spec versions this install's worker
 * reads, space separated, for fleet preflight. A build older than the flag
 * ignores it and prints its version line, which preflight reads as unreported.
 * Both plain forms are read by older preflights and stay byte-for-byte.
 * `--sandbox` prints this host's worker sandbox probe as one JSON line, so
 * fleet preflight can seal a remote worker's envelope from the node's own
 * answer. A build older than the flag rejects it, which reads as no sandbox.
 */
export async function runVersionCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (helpRequested(args)) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const parsed = parseCommandFlags(args, {
		"worker-specs": { kind: "boolean" },
		build: { kind: "boolean" },
		sandbox: { kind: "boolean" },
		json: { kind: "boolean" },
	});
	if (!parsed.ok) {
		writeCliFailure({ path: VERSION_PATH, slug: parsed.slug, message: parsed.message, json });
		return 2;
	}
	const [extra] = parsed.positional;
	if (extra !== undefined) {
		writeCliFailure({ path: VERSION_PATH, slug: "usage", message: `unexpected argument: ${extra}`, json });
		return 2;
	}
	const { flags } = parsed;
	const chosen = [
		flags.json && "--json",
		flags.build && "--build",
		flags["worker-specs"] && "--worker-specs",
		flags.sandbox && "--sandbox",
	].filter((name): name is string => typeof name === "string");
	if (chosen.length > 1) {
		writeCliFailure({ path: VERSION_PATH, slug: "flag_conflict", message: `choose one of ${chosen.join(", ")}`, json });
		return 2;
	}
	if (flags.build) {
		process.stdout.write(`${runningBuildId ?? "unknown"}\n`);
		return 0;
	}
	if (flags.sandbox) {
		const { hostSandboxReport } = await import("../core/sandbox/status.js");
		const { readSettings } = await import("../core/config.js");
		const { DEFAULT_SETTINGS } = await import("../core/defaults.js");
		let safety = DEFAULT_SETTINGS.safety;
		try {
			safety = readSettings().safety;
		} catch {
			// An unreadable settings file is doctor's to report; the host facts do not depend on it.
		}
		// One line: fleet preflight reads only the first.
		process.stdout.write(`${JSON.stringify(hostSandboxReport(safety))}\n`);
		return 0;
	}
	if (flags["worker-specs"]) {
		const { WORKER_SPEC_VERSIONS } = await import("../worker/spec-contract.js");
		process.stdout.write(`${WORKER_SPEC_VERSIONS.join(" ")}\n`);
		return 0;
	}
	const { findPinnedTool } = await import("../lib/programs/registry.js");
	const herdr = findPinnedTool("herdr");
	if (flags.json) {
		const { WORKER_SPEC_VERSIONS } = await import("../worker/spec-contract.js");
		const build = readBuildProvenance();
		writeJson(
			process.stdout,
			jsonDocument({
				pancodeVersion: readPancodeVersion(),
				label: readPancodeVersionLabel(),
				commit: build?.commit ?? null,
				dirty: build?.dirty ?? null,
				build: runningBuildId ?? null,
				workerSpecs: [...WORKER_SPEC_VERSIONS],
				herdr: herdr === null ? null : { version: herdr.version, license: herdr.license },
			}),
		);
		return 0;
	}
	// The version stays alone on the first line: fleet preflight reads only that one.
	const credit = herdr === null ? "" : `Panes powered by herdr ${herdr.version} (${herdr.license})\n`;
	process.stdout.write(`PanCode ${readPancodeVersionLabel()}\n${credit}`);
	return 0;
}
