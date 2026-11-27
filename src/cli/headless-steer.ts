// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ReloadReport, ReloadTarget } from "../session-control/reload-report.js";
import { parseSlashCommand } from "../session-control/slash-commands.js";
import { noteSteerV2 } from "./run-failure.js";
import { createSteerIntake, type SteerLineStatus, type SteerTarget, setupSteerChannel } from "./steer-channel.js";

type SteerLine = (line: string, lineNumber: number) => void;

/** Read a run's `--steer-channel`; the returned close also refuses the lines still held. */
export function openSteerChannel(
	filePath: string,
	chat: SteerTarget,
	reload: ((target: ReloadTarget) => Promise<ReloadReport>) | undefined,
): () => void {
	// A line written before the first turn streams waits for that turn instead of being refused.
	const intake = createSteerIntake(chat, noteSteerV2);
	const closeChannel = setupSteerChannel(filePath, reloadSteerLines(intake.take, reload, noteSteerV2));
	return () => {
		closeChannel();
		intake.close();
	};
}

/**
 * A `--steer-channel` line that reads `/reload [target]` runs that reload and writes its report to stderr; every
 * other line steers the run. A slash line of any other command steers as text, as it always has.
 */
function reloadSteerLines(
	steer: SteerLine,
	reload: ((target: ReloadTarget) => Promise<ReloadReport>) | undefined,
	note: (lineNumber: number, status: SteerLineStatus, reason?: string) => void,
): SteerLine {
	if (reload === undefined) return steer;
	return (line, lineNumber) => {
		if (!/^\/reload(?:\s|$)/u.test(line)) return steer(line, lineNumber);
		const command = parseSlashCommand(line);
		if (command.kind !== "reload") {
			note(lineNumber, "refused", command.kind === "usage-error" ? command.reason : "not a reload command");
			return;
		}
		note(lineNumber, "accepted");
		reload(command.target).then(
			(report) => process.stderr.write(`${report.text}\n`),
			(error: unknown) =>
				process.stderr.write(`pancode run: reload failed: ${error instanceof Error ? error.message : String(error)}\n`),
		);
	};
}
