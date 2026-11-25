// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CommandResult } from "../../contracts/steering.js";
import { StatusMark } from "../design/status.js";
import { Keycaps } from "../interaction/Keycaps.js";
import { PancodePulse, PULSE_SIZE } from "../shell/PancodeMark.js";
import { type ContextCommandPresentation, commandResultTone } from "./context-command-model.js";
import type { SlashLine } from "./slash-model.js";

/** What a typed slash line will run, or why it cannot run yet. */
export function SlashLineHint({
	line,
	slashError,
	enterSends,
}: {
	line: SlashLine;
	slashError: string | null;
	enterSends: boolean;
}) {
	return (
		<div className="slash-palette slash-palette--line" role="status">
			<p className="slash-palette__line">
				<code>{line.hint}</code>
				<span>{line.command.summary}</span>
			</p>
			{slashError ? (
				<p className="slash-palette__error">{slashError}</p>
			) : (
				<p className="slash-palette__keys">
					<Keycaps chord={enterSends ? "Enter" : "Ctrl/Cmd + Enter"} /> runs{" "}
					{line.kind === "command" ? <code>{line.plan.description}</code> : "it once the arguments are complete"}
				</p>
			)}
		</div>
	);
}

/** A catalog command's progress, failure and output under the field. */
export function CommandOutcome({
	command,
	cardRunsCommand,
	commandShown,
}: {
	command: {
		readonly isPending: boolean;
		readonly error: Error | null;
		readonly data: { readonly result: CommandResult } | undefined;
		readonly variables: { readonly description: string } | undefined;
		reset(): void;
	};
	/** A context operation card reports this command, so the line does not repeat its progress. */
	cardRunsCommand: boolean;
	commandShown: ContextCommandPresentation | null;
}) {
	return (
		<>
			{command.isPending && !cardRunsCommand ? (
				<p className="composer__notice" role="status">
					<PancodePulse size={PULSE_SIZE.row} />
					Running <code>{command.variables?.description}</code>…
				</p>
			) : null}
			{command.error ? (
				<p className="composer__notice" role="alert">
					<StatusMark tone="fail" label="Command failed" />
					{command.error.message}
				</p>
			) : null}
			{command.data &&
			commandShown &&
			(commandShown.status || (commandShown.lines && command.data.result.lines.length > 0)) ? (
				<div className="slash-result" role="status">
					<p className="slash-result__head">
						{commandShown.status ? (
							<StatusMark tone={commandResultTone(command.data.result.level)} label={`Command ${command.data.result.level}`} />
						) : null}
						<code>{command.variables?.description}</code>
						<button type="button" className="composer__secondary" onClick={() => command.reset()}>
							Dismiss
						</button>
					</p>
					{command.data.result.lines.length ? (
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded result can scroll with keyboard arrows.
						<pre tabIndex={0}>{command.data.result.lines.join("\n")}</pre>
					) : (
						<p>PanCode returned no lines. Check the conversation for any ongoing work.</p>
					)}
				</div>
			) : null}
		</>
	);
}
