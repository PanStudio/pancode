// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode setup --next` (hidden): the next step for this home in plain text, for the installers' closing
 * message. It reads the setup status and what PanCode would offer on first launch (environment variable names, a
 * local server's address, never a secret) and writes no settings, so running it does not make the home "returning".
 */
import { readSettings } from "../core/config.js";
import { readPancodeVersion } from "../core/package-root.js";
import type { Candidate } from "../domains/install/setup-status.js";
import { describeMissing } from "../domains/install/setup-status.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";

const INDENT = "       ";

function foundName(candidate: Candidate<TargetDescriptor>): string {
	switch (candidate.source) {
		case "env-key":
			return candidate.label;
		case "local-server":
			return `a model server at ${candidate.label}`;
		case "stored-login":
			return `a stored sign-in for ${candidate.target.runtime}`;
		default:
			return `connection ${candidate.target.id}`;
	}
}

/** The closing lines for the current state; the installer adds the PATH lines after them. */
export async function nextStepLines(
	probe: { readJson?: (url: string, signal: AbortSignal) => Promise<unknown> } = {},
): Promise<string[]> {
	const lines = [`PanCode ${readPancodeVersion()} is installed.`, "Next:  cd <your project> && pancode"];
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		lines.push(`${INDENT}Your settings need a repair first. Run: pancode doctor`);
		return lines;
	}
	const { classifyDefaultTarget, firstMissing } = await import("./default-target.js");
	if (classifyDefaultTarget(settings).kind === "usable") {
		lines.push(`${INDENT}Chat uses ${settings.chat.target}${settings.chat.model ? ` / ${settings.chat.model}` : ""}.`);
		return lines;
	}
	const missing = firstMissing(settings);
	if (missing !== null) {
		const described = describeMissing(missing);
		lines.push(`${INDENT}${described.sentence}`);
		if (described.command) lines.push(`${INDENT}Run: ${described.command}`);
		return lines;
	}
	const { getRuntimeRegistry } = await import("../domains/providers/registry.js");
	const { registerBuiltinRuntimes } = await import("../domains/providers/runtimes/builtins.js");
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const { collectSetupCandidates } = await import("./detect-chat-routes.js");
	const found = (await collectSetupCandidates(settings, probe)).map(foundName);
	lines.push(
		`${INDENT}The first launch sets up a model.${found.length > 0 ? ` Found: ${[...new Set(found)].join(", ")}.` : ""}`,
	);
	return lines;
}

const SETUP_USAGE =
	"usage: pancode setup --next\n  print the first-launch next steps (the installers' closing message)\n";

export async function runSetupCommand(args: ReadonlyArray<string>): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write(SETUP_USAGE);
		return 0;
	}
	if (args.length !== 1 || args[0] !== "--next") {
		process.stderr.write("usage: pancode setup --next\n");
		return 2;
	}
	process.stdout.write(`${(await nextStepLines()).join("\n")}\n`);
	return 0;
}
