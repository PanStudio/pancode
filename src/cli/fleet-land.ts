// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readSettings } from "../core/config.js";
import { configureGitCommitAttribution } from "../core/git-commit-attribution.js";
import {
	discardTaskLand,
	executeTaskLand,
	listLandableTasks,
	planTaskLand,
	type TaskLandMode,
} from "../tools/task-land.js";
import { allowedWorktreeParents } from "../tools/worktree-root.js";

const HELP = `pancode fleet land [<run id or pancode/task/<run id> branch>] [options]

  (no run)                 list task branches finished runs left to land
  <run>                    preview: commits, changes, destination and conflicts
  --yes                    land it, then remove its branch, worktree and claim
  --squash                 land one commit instead of the branch's history
  --message <text>         message for the landing commit
  --keep                   keep the branch and worktree after landing
  --discard                preview deleting the run's branch, worktree and claim
                           unlanded; with --yes, delete them
  --plan <id>              refuse unless the landing still matches that preview
  --json                   print the plan or the list as JSON

The run lands on the branch it was dispatched from, which must be checked out.
The preview changes no ref, index or worktree; it may write dangling Git
objects, which git gc removes. Conflicts are found before anything changes. The only step that touches the
checkout is a fast-forward, which Git refuses when it would overwrite a local
change. Uncommitted work in a kept worktree is committed onto its task branch
first, and only with --yes.
`;

export function parentsFor(root: string): string[] | undefined {
	try {
		return allowedWorktreeParents(readSettings().fleet.worktrees.root, root);
	} catch {
		// Unreadable settings fall back to the project-root location, which always holds the claims.
		return undefined;
	}
}

export async function runFleetLand(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (["--yes", "--squash", "--keep", "--json", "--discard"].includes(arg)) flags.add(arg);
		else if (arg === "--message" || arg === "--plan") {
			const value = args[++i];
			if (value === undefined || value.startsWith("--")) return usage(`${arg} needs a value`);
			values.set(arg, value);
		} else if (arg.startsWith("-")) return usage(`unknown flag: ${arg}`);
		else positional.push(arg);
	}
	if (positional.length > 1) return usage("land takes one run id");
	if (flags.has("--discard")) {
		const landing = ["--squash", "--keep", "--json", "--message"].find((flag) => flags.has(flag) || values.has(flag));
		if (landing !== undefined) return usage(`--discard does not take ${landing}`);
		if (positional[0] === undefined) return usage("--discard needs a run id");
		return discard(positional[0], flags.has("--yes"), values.get("--plan"));
	}
	const cwd = process.cwd();
	try {
		const ref = positional[0];
		if (ref === undefined) {
			const tasks = listLandableTasks(cwd, parentsFor(cwd));
			if (flags.has("--json")) process.stdout.write(`${JSON.stringify({ tasks }, null, 2)}\n`);
			else if (tasks.length === 0) process.stdout.write("No task branches to land.\n");
			else {
				for (const task of tasks)
					process.stdout.write(
						`${task.runId}  ${task.state}  ${task.commits ?? "?"} commit(s)  worktree ${task.worktreePresent ? "present" : "gone"}  ${task.reason}\n`,
					);
				process.stdout.write("Preview one: pancode fleet land <run id>; drop one: pancode fleet land <run id> --discard\n");
			}
			return 0;
		}
		const mode: TaskLandMode = flags.has("--squash") ? "squash" : "merge";
		const root = cwd;
		const plan = planTaskLand({ root, ref, mode, ...withParents(parentsFor(root)) });
		if (flags.has("--json")) {
			const { worktree, leftOut, ...rest } = plan;
			process.stdout.write(
				`${JSON.stringify({ ...rest, worktree: worktree?.path ?? null, leftOut: [...leftOut.keys()] }, null, 2)}\n`,
			);
		} else {
			const how = plan.alreadyLanded
				? "already landed"
				: plan.mode === "squash"
					? "squash into one commit"
					: plan.fastForward
						? "fast-forward"
						: "merge commit";
			process.stdout.write(`${plan.branch} onto ${plan.destination} (${how}), plan ${plan.planId}\n`);
			for (const line of plan.commits) process.stdout.write(`  ${line}\n`);
			if (plan.uncommitted > 0)
				process.stdout.write(`  plus ${plan.uncommitted} uncommitted path(s) in ${plan.worktree?.path}\n`);
			if (plan.leftOut.size > 0)
				process.stdout.write(
					`  ${plan.leftOut.size} file(s) the run's commit left out do not land and go with the worktree\n`,
				);
			process.stdout.write(`  changes: ${plan.changed}\n`);
			if (plan.refusal !== null) process.stdout.write(`  cannot land: ${plan.refusal}\n`);
		}
		if (plan.refusal !== null) return 1;
		const expected = values.get("--plan");
		if (expected !== undefined && expected !== plan.planId) {
			process.stderr.write(
				`pancode fleet land: the landing changed since plan ${expected} (now ${plan.planId}); preview it again\n`,
			);
			return 1;
		}
		// With --json, stdout holds only the plan so a caller can parse it.
		const notes = flags.has("--json") ? process.stderr : process.stdout;
		if (!flags.has("--yes")) {
			notes.write(
				`Land it: pancode fleet land ${plan.runId} --yes --plan ${plan.planId}${mode === "squash" ? " --squash" : ""}\n`,
			);
			return 0;
		}
		const message = values.get("--message");
		// No session installed `integrations.git` in this process, and the landing commit's author follows it.
		configureGitCommitAttribution(readSettings().integrations.git);
		const result = executeTaskLand(plan, {
			...(message !== undefined ? { message } : {}),
			keep: flags.has("--keep"),
		});
		notes.write(
			`${result.landed !== null ? `Landed ${result.landed.slice(0, 9)} on ${plan.destination}` : `Nothing new to land on ${plan.destination}`}; ${result.detail}.\n`,
		);
		return 0;
	} catch (error) {
		process.stderr.write(`pancode fleet land: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function discard(ref: string, confirmed: boolean, expected: string | undefined): number {
	try {
		const root = process.cwd();
		const plan = planTaskLand({ root, ref, mode: "merge", ...withParents(parentsFor(root)) });
		if (!confirmed) {
			process.stdout.write(`discard ${plan.branch} without landing it, plan ${plan.planId}\n`);
			for (const line of plan.commits) process.stdout.write(`  ${line}\n`);
			if (plan.worktree !== null) {
				process.stdout.write(
					`  worktree ${plan.worktree.path}${plan.uncommitted > 0 ? ` with ${plan.uncommitted} uncommitted path(s)` : ""}\n`,
				);
			}
			process.stdout.write(`Discard it: pancode fleet land ${plan.runId} --discard --yes --plan ${plan.planId}\n`);
			return 0;
		}
		if (expected !== undefined && expected !== plan.planId) {
			process.stderr.write(
				`pancode fleet land: the task changed since plan ${expected} (now ${plan.planId}); preview it again\n`,
			);
			return 1;
		}
		process.stdout.write(`Discarded ${plan.runId}: ${discardTaskLand(plan)}.\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`pancode fleet land: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function withParents(parents: string[] | undefined): { allowedParents?: string[] } {
	return parents !== undefined ? { allowedParents: parents } : {};
}

function usage(message: string): number {
	process.stderr.write(`pancode fleet land: ${message}\n${HELP}`);
	return 2;
}
