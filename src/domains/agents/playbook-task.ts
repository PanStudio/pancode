// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The task a playbook run is started with fills the playbook's `{{task}}`.
 * `pancode fleet run <name> "<task>"` and `/fleet run <name> <task words>`
 * bind it through these two checks, so both surfaces refuse the same mistakes
 * in the same words.
 */
import { playbookPromptVariables } from "./playbook.js";

/** The task bound into the variables, or the refusal when `--var task=` gave it too. */
export function bindPlaybookTask(
	vars: Readonly<Record<string, string>>,
	task: string | undefined,
): { vars: Record<string, string> } | { error: string } {
	if (task === undefined) return { vars: { ...vars } };
	if (vars.task !== undefined) {
		return {
			error: "the task is given twice: pass it as the argument after the playbook or as --var task=..., not both",
		};
	}
	return { vars: { ...vars, task } };
}

/**
 * Why a task cannot start this playbook (its prompt has no `{{task}}`), or null when it can. `varsVia` names
 * where the surface takes variables: `--var` for the command line and the slash command, `playbook.vars` for dispatch.
 */
export function playbookTaskRefusal(
	playbook: { name: string; body: string },
	task: string | undefined,
	varsVia = "--var",
): string | null {
	if (task === undefined) return null;
	const variables = playbookPromptVariables(playbook.body);
	if (variables.includes("task")) return null;
	const names = variables.length > 0 ? ` (${variables.join(", ")})` : "";
	return `playbook '${playbook.name}' takes no task: its prompt has no {{task}}; pass its variables${names} with ${varsVia}`;
}
