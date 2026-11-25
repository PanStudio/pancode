// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { shellStatusMasked } from "../domains/safety/check-command-shape.js";
import { withoutDataHeredocBodies } from "../domains/safety/heredoc-scan.js";
import { joinLineContinuations } from "../domains/safety/protected-artifacts.js";

/**
 * Whether a bash command's exit status speaks for the whole command. The bash
 * tool runs under `pipefail`, so a pipeline's status covers every stage and an
 * `&&` chain stops at its first failure. After `;`, `||`, `&`, a newline, a `!`
 * inversion, or a step switching `pipefail` off in any quoting, the status is not
 * the command's own: a live run read `exitCode:0` for
 * `node check.mjs; echo "exit=$?"` as the suite's; the status that echo printed is read apart, as the bash result's
 * `checkExitCode` (`echoedCheckStatus` in protected-artifacts.ts). A backslash-newline continues the line, so it separates
 * nothing (x7-4). A here-document body copied into a file is data, not lines of commands (SF-5).
 */
export function shellExitSpeaksForCommand(command: string): boolean {
	const bare = joinLineContinuations(withoutDataHeredocBodies(command).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ""))
		.replace(/&&|\|&|\d?>&\d|&>/g, " ")
		.replace(/;\s*$/, "");
	if (shellStatusMasked(command)) return false;
	return !/[;&\n]|\|\|/.test(bare.trim());
}
