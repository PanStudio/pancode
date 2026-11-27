#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `pankit` command of the PanCode package. It runs PanKit's own CLI and
 * lends it PanHub, which serves `add`, `remove` and the added rows of `list`.
 * PanHub loads by dynamic import only for those, so the other commands load
 * what PanKit alone loads.
 */
import { existsSync } from "node:fs";
import { constants } from "node:os";
import type { PankitHost, PankitOutcome } from "@pancode/kit";
import { runPankit } from "@pancode/kit";

/** A command that writes the PanCode home keeps a process journal, as `pancode hub` does. */
async function journaled(run: () => Promise<PankitOutcome>): Promise<PankitOutcome> {
	const [{ createProcessJournal }, { pancodeStateDir }, { writeDiagnostic }] = await Promise.all([
		import("../domains/telemetry/process-journal.js"),
		import("../core/xdg.js"),
		import("../core/diagnostics.js"),
	]);
	const journal = createProcessJournal(pancodeStateDir(), () =>
		writeDiagnostic("[pancode:telemetry] process journal unavailable; coverage is incomplete\n"),
	);
	let outcome: PankitOutcome = { code: 1 };
	try {
		outcome = await run();
	} finally {
		if (!(await journal.close(outcome.code)) && outcome.code === 0) outcome = { ...outcome, code: 1 };
	}
	return outcome;
}

const host: PankitHost = {
	async serve(name, options) {
		const { kitServeLaunch } = await import("../domains/resources/kit-items.js");
		const launch = kitServeLaunch(name, process.cwd());
		if (launch === undefined) return undefined;
		if (options.length > 0) {
			process.stderr.write(`pankit serve ${name}: an added server takes no options, not ${options[0]}\n`);
			return 2;
		}
		if (!launch.ok) {
			process.stderr.write(`pankit serve ${name}: ${launch.message}\n`);
			return 1;
		}
		const { runCommandVector } = await import("../core/safe-exec.js");
		const { command, args, cwd, workspaceRoot, env } = launch.value;
		const child = await runCommandVector(command, args, { cwd, workspaceRoot, env, stdio: "inherit", timeoutMs: 0 });
		if (!child.launched || child.failure) {
			process.stderr.write(`pankit serve ${name}: ${child.failure ?? child.stderr}\n`);
			if (!child.launched) return 1;
		}
		return child.exitCode ?? (child.signal ? 128 + constants.signals[child.signal] : 1);
	},
	async added() {
		const { pluginBaseDir } = await import("../domains/plugins/paths.js");
		if (!existsSync(pluginBaseDir("user"))) return [];
		const { addedKitServers } = await import("../domains/resources/kit-items.js");
		return addedKitServers(process.cwd());
	},
	add: (name) =>
		journaled(async () => {
			const { addKitServer } = await import("../domains/resources/kit-items.js");
			const result = addKitServer(name, process.cwd());
			if (!result.ok) return { code: 1, stderr: `pankit add: ${result.message}\n` };
			const facts = result.value;
			const rows: Array<[string, string]> = [
				["publisher", facts.publisher],
				["tier", facts.tier ?? "none"],
				["licence", facts.license ?? "none stated"],
				["version", facts.version],
				["tree", `sha256 ${facts.sha256}`],
				["source", facts.commit ? `${facts.source} at ${facts.commit}` : facts.source],
				["launches", [facts.launch.command, ...facts.launch.args].join(" ")],
			];
			const entry = JSON.stringify({ command: "pankit", args: ["serve", name] });
			return {
				code: 0,
				stdout: [
					`added ${name} at ${facts.destination}`,
					...rows.map(([label, value]) => `  ${label.padEnd(9)} ${value}`),
					`host entry: ${entry}`,
					"",
				].join("\n"),
			};
		}),
	remove: (name) =>
		journaled(async () => {
			const { removeKitServer } = await import("../domains/resources/kit-items.js");
			const result = removeKitServer(name, process.cwd());
			if (!result.ok) return { code: 1, stderr: `pankit remove: ${result.message}\n` };
			return { code: 0, stdout: `removed ${name} from ${result.value.destination}\n` };
		}),
};

runPankit(process.argv.slice(2), host).then((code) => {
	process.exitCode = code;
});
