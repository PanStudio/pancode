// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The blast-radius ladder, lowest rung first.
 *
 * Rungs are written as what the call does to the world rather than as severity
 * words, because "medium risk" means nothing to an operator deciding about one
 * specific command and "changes state version control cannot restore" does.
 *
 * The top rung names changing remote state, not reaching a remote host: a
 * plain `curl` GET is not irreversible, and a card that called it so would cry
 * wolf on every download.
 */
export const TOOL_CALL_RUNGS = [
	{
		label: "contained",
		criteria:
			"Only reads: lists, inspects, searches, or downloads for display, and changes nothing on this machine or any other.",
	},
	{
		label: "local",
		criteria:
			"Creates, changes or deletes files inside the workspace, including downloads, installed dependencies and build output, in a way version control, a reinstall or a rebuild can restore.",
	},
	{
		label: "broad",
		criteria:
			"Changes state outside the workspace on this machine, or throws away uncommitted changes, untracked files or history inside it that version control cannot bring back.",
	},
	{
		label: "irreversible",
		criteria:
			"Deletes or overwrites data outside the workspace for good, or changes state on another machine or a published service: pushes, publishes, deploys, uploads, or remote writes and deletes.",
	},
] as const;
