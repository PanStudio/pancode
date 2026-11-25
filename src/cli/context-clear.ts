// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { formatContextOperationResult } from "../core/context-operation.js";
import { runContextClear } from "../domains/context/index.js";
import { clearOperationFacts } from "../domains/context/operation-result.js";
import { createContextCliOperation } from "./context-progress.js";

const HELP = `Usage:
  pancode context reset [--all] [--yes]

Clear accumulated project context owned by the context engine:
.pancode/codemap.json, .pancode/state.json, .pancode/handoffs/, and .pancode/proposals/.

Preserves by default: PANCODE.md, PANCODE.override.md, .pancode/agents/, .pancode/skills/, and .pancode/wiki/.

Options:
  --all       also remove the local PANCODE.md after a second confirmation; overrides stay human-owned
  --yes, -y   answer every confirmation, required when stdin is not a terminal
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

async function confirm(question: string): Promise<boolean> {
	if (!input.isTTY) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(question);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

export async function runContextClearCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	for (const arg of args) {
		if (arg !== "--all" && arg !== "--yes" && arg !== "-y") {
			process.stderr.write(`pancode context reset: unknown flag: ${arg}\n`);
			process.stderr.write(HELP);
			return 2;
		}
	}
	const all = hasFlag(args, "--all");
	const assumeYes = hasFlag(args, "--yes") || hasFlag(args, "-y");
	// Without a terminal there is nobody to answer, and the prompt resolves
	// false, so the reset reports a cancellation the caller never asked for.
	// Say which flag turns that into an answer instead of leaving it to be
	// discovered.
	if (!assumeYes && !input.isTTY) {
		process.stderr.write("pancode context reset: stdin is not a terminal; pass --yes to confirm non-interactively\n");
	}
	const operation = createContextCliOperation("context-clear");
	const answer = (question: string): Promise<boolean> => (assumeYes ? Promise.resolve(true) : confirm(question));
	try {
		const result = await runContextClear({
			cwd: process.cwd(),
			all,
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			confirmContext: () =>
				answer("Clear .pancode/codemap.json, .pancode/state.json, .pancode/handoffs/, and .pancode/proposals/? [y/N] "),
			confirmAll: () => answer("Also remove PANCODE.md? [y/N] "),
		});
		process.stdout.write(
			`${formatContextOperationResult(operation.finish(result.action === "cancelled" ? "cancelled" : "completed", result.action === "cancelled" ? "Reset cancelled" : "Context reset finished", { facts: clearOperationFacts(result) }))}\n`,
		);
		return 0;
	} catch (err) {
		operation.finish("failed", err instanceof Error ? err.message : String(err));
		process.stderr.write(`pancode context reset failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
