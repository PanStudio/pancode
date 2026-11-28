// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { detectPancodeRepo } from "../../core/pancode-repo.js";
import { runningBuildIsStale, runningPackageRoot } from "../../core/running-build.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

const STALE_BUILD_REMINDER_REGISTRATION_ID = "observer.stale-build-reminder";

export const STALE_BUILD_REMINDER =
	"[Build] The build this session runs was replaced on disk. Code you edited is not what is running. Ask the operator to /restart before verifying behaviour in this session.";

const NONE: ReadonlyArray<MiddlewareEffect> = [];

/**
 * Once per process, when PanCode works on the tree it runs from and that tree's
 * build was replaced on disk, tells the model that what it edited is not what
 * runs. Other workspaces never see it: there a rebuild is not the model's.
 */
export function createStaleBuildReminderRegistration(
	deps: { isStale?: () => boolean; runsFromWorkspace?: (cwd: string) => boolean; getCwd?: () => string } = {},
): MiddlewareHookRegistration {
	const isStale = deps.isStale ?? (() => runningBuildIsStale().stale);
	const runsFromWorkspace =
		deps.runsFromWorkspace ??
		((cwd: string) => {
			const repo = detectPancodeRepo(cwd).repoRoot;
			return repo !== null && resolve(repo) === resolve(runningPackageRoot());
		});
	let spent = false;
	return {
		id: STALE_BUILD_REMINDER_REGISTRATION_ID,
		description: "once, when this session's own build was replaced on disk, says edited code is not what runs",
		hooks: ["turn_start"],
		evidence: "build:replaced@self-repository",
		evaluate(): ReadonlyArray<MiddlewareEffect> {
			if (spent || !isStale() || !runsFromWorkspace((deps.getCwd ?? process.cwd)())) return NONE;
			spent = true;
			return [{ kind: "inject_reminder", severity: "warn", message: STALE_BUILD_REMINDER }];
		},
	};
}
