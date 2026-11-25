// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The commands one code step executed, argv and cwd in run order, kept beside the step's output log under the
 * root's code-steps directory. The root journal's `code_step.settled` is content-free and carries each command's exit
 * code and duration only (#434); this file is the one place the executed argv is recorded, and `fleet code-steps`
 * joins the two by position. A loop that reruns a step overwrites it, so a reader asks for the run it expects.
 */

import { join } from "node:path";
import { readJsonObjectFile } from "../../core/json-file.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

export interface CodeStepCommand {
	readonly argv: ReadonlyArray<string>;
	readonly cwd: string;
}

interface CodeStepCommandsFile {
	readonly version: 1;
	readonly runId: string;
	readonly commands: ReadonlyArray<CodeStepCommand>;
}

function codeStepCommandsPath(artifactDir: string, stepId: string): string {
	return join(artifactDir, `${stepId}.commands.json`);
}

export function writeCodeStepCommands(
	artifactDir: string,
	stepId: string,
	runId: string,
	commands: ReadonlyArray<CodeStepCommand>,
): void {
	const file: CodeStepCommandsFile = {
		version: 1,
		runId,
		commands: commands.map(({ argv, cwd }) => ({ argv: [...argv], cwd })),
	};
	safeResourceWrite(codeStepCommandsPath(artifactDir, stepId), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** The commands `runId` executed as step `stepId`; null when the file is gone, unreadable or names another run. */
export function readCodeStepCommands(
	artifactDir: string,
	stepId: string,
	runId: string,
): ReadonlyArray<CodeStepCommand> | null {
	const file = readJsonObjectFile(codeStepCommandsPath(artifactDir, stepId)) as Partial<CodeStepCommandsFile> | null;
	if (file?.version !== 1 || file.runId !== runId || !Array.isArray(file.commands)) return null;
	const commands = file.commands.filter(
		(command): command is CodeStepCommand =>
			Array.isArray(command?.argv) &&
			command.argv.every((part: unknown) => typeof part === "string") &&
			typeof command.cwd === "string",
	);
	return commands.length === file.commands.length ? commands : null;
}
