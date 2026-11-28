// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Loading for user-defined middleware hooks and the production command
 * runner. Hooks live in dedicated, secrets-free files so they stay out of the
 * strict settings schema:
 *
 *   - `<config>/hooks.yaml`           the operator's own hooks (origin "user"),
 *     trusted by authorship like the user `mcp.yaml`,
 *   - `.pancode/hooks.yaml`        committed project hooks (origin "project"),
 *   - `.pancode/hooks.local.yaml`  gitignored local hooks (origin "project.local"),
 *   - `<extensionRoot>/hooks.yaml`  hooks shipped by an installed extension.
 *
 * Project files are read from disk here. Extension declarations are never
 * read here: they arrive already parsed as a captured source set that the
 * composition root adapts from the extension snapshot, which captured the
 * bytes during install-digest verification, so a hooks.yaml rewritten after
 * verification cannot be admitted until the next generation re-verifies the
 * tree. Middleware never sees extension-domain types.
 *
 * Reads are best-effort: a missing file is skipped silently, and a malformed
 * file is reported as an issue without aborting anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
	gitCommitAttributionEnabled,
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "../../core/git-commit-attribution.js";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import { type HostLaunchLabel, hostAuthorityLabel } from "../../core/sandbox/host-launch.js";
import { settleHostLaunch } from "../../core/sandbox/host-launch-record.js";
import {
	confinedIntegrationPolicy,
	type MainSandboxPolicy,
	optInLaunch,
	planMainSandboxSpawn,
} from "../../core/sandbox/main-session.js";
import { layeredConfineList } from "../../core/settings-layers.js";
import {
	captureProjectSurface,
	type ProjectSurfaceSnapshot,
	projectSurfaceTrustNotice,
} from "../../core/workspace-trust.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { effectiveScratchRoots } from "../../lib/scratch-roots/scratch-roots.js";
import {
	type HookReceiptSink,
	loadUserHooks,
	type UserHookCommandResult,
	type UserHookCommandRunner,
	type UserHookDeclarationBatch,
	type UserHookLoadResult,
	type UserHookOrigin,
	type UserHookPackageProvenance,
	type UserHookSource,
	userHookToRegistration,
} from "./hooks.js";
import type { MiddlewareHookRegistration } from "./runtime.js";

const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;
/** The operator's own hooks file in PanCode's config directory. */
export const USER_HOOKS_FILENAME = "hooks.yaml";

export interface HookFileIssue {
	source: UserHookSource;
	message: string;
	/** The file is present but not trusted; a standing condition, not a parse fault. */
	trust?: true;
}

export interface ReadHookSourcesResult {
	batches: UserHookDeclarationBatch[];
	fileIssues: HookFileIssue[];
	projectSurface: ProjectSurfaceSnapshot;
}

/** One package's hook declarations, captured by the supplier from verified bytes. */
export interface CapturedHookDeclarations {
	provenance: UserHookPackageProvenance;
	/** SHA-256 of the captured hooks.yaml bytes. */
	declarationsDigest: string;
	/** Parsed declarations, or an empty list when parsing failed. */
	declarations: unknown;
	parseError?: string;
}

/** The captured declarations of one supplier generation. */
export interface CapturedHookSourceSet {
	/** 0 for an ephemeral (uncommitted) build. */
	generation: number;
	sources: ReadonlyArray<CapturedHookDeclarations>;
}

export interface ReadHookSourcesOptions {
	cwd: string;
	/** Captured extension declarations; absent means no extension hooks. */
	capturedSources?: CapturedHookSourceSet;
	/** Directory holding the user `hooks.yaml`; PanCode's config directory when unset. */
	configDir?: string;
}

function readBatch(
	source: UserHookSource,
	filePath: string,
	text: string,
	fileIssues: HookFileIssue[],
): UserHookDeclarationBatch | null {
	try {
		const parsed = parseYaml(text) as unknown;
		return { source, declarations: parsed ?? [] };
	} catch (err) {
		fileIssues.push({
			source,
			message: `failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		});
		return null;
	}
}

/**
 * Gather hook declaration batches from extensions and the project, in
 * precedence order. The returned batches feed {@link loadUserHooks}.
 */
export function readHookSources(options: ReadHookSourcesOptions): ReadHookSourcesResult {
	const fileIssues: HookFileIssue[] = [];
	const batches: UserHookDeclarationBatch[] = [];

	const captured = options.capturedSources;
	for (const entry of captured?.sources ?? []) {
		const source: UserHookSource = {
			origin: "extension",
			sourcePath: `${entry.provenance.id}:hooks.yaml`,
			sourceId: entry.provenance.id,
			extension: {
				provenance: entry.provenance,
				generation: captured?.generation ?? 0,
				declarationsDigest: entry.declarationsDigest,
			},
		};
		if (entry.parseError !== undefined) {
			fileIssues.push({ source, message: `failed to parse ${source.sourcePath}: ${entry.parseError}` });
			continue;
		}
		batches.push({ source, declarations: entry.declarations });
	}

	const userFile = path.join(options.configDir ?? pancodeConfigDir(), USER_HOOKS_FILENAME);
	let userText: string | null = null;
	try {
		userText = readFileSync(userFile, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			fileIssues.push({
				source: { origin: "user", sourcePath: userFile },
				message: `failed to read ${userFile}: ${err instanceof Error ? err.message : String(err)}`,
			});
	}
	if (userText !== null) {
		const batch = readBatch({ origin: "user", sourcePath: userFile }, userFile, userText, fileIssues);
		if (batch) batches.push(batch);
	}

	const projectSurface = captureProjectSurface(options.cwd, "hooks");
	for (const [index, file] of projectSurface.files.entries()) {
		const source: UserHookSource = {
			origin: index === 0 ? "project" : "project.local",
			sourcePath: index === 0 ? ".pancode/hooks.yaml" : ".pancode/hooks.local.yaml",
		};
		if (file.error !== undefined) fileIssues.push({ source, message: file.error });
		if (file.text === null) continue;
		if (projectSurface.verdict !== "trusted") {
			fileIssues.push({ source, message: projectSurfaceTrustNotice(projectSurface, file.path), trust: true });
			continue;
		}
		const batch = readBatch(source, file.path, file.text, fileIssues);
		if (batch) batches.push(batch);
	}
	return { batches, fileIssues, projectSurface };
}

export interface BuildUserHookRegistrationsOptions {
	cwd: string;
	/** Absolute workspace root a command `cwd` must resolve under; defaults to `cwd`. */
	workspaceRoot?: string;
	capturedSources?: CapturedHookSourceSet;
	recordReceipt: HookReceiptSink;
	/** Injected for tests; defaults to the spawnSync runner. */
	runCommand?: UserHookCommandRunner;
	now?: () => number;
	/** Operator notice when an already published project's trust changes. */
	report?: (line: string) => void;
}

export interface BuildUserHookRegistrationsResult extends UserHookLoadResult {
	fileIssues: HookFileIssue[];
	/** One registration per admitted hook, in merged precedence order. Nothing is registered here. */
	registrations: MiddlewareHookRegistration[];
}

/**
 * Read project files, merge them with the captured extension declarations,
 * normalize, and build one registration per admitted hook. Pure with respect
 * to the middleware contract: the caller decides when the set is published,
 * which is what lets extension and hook state publish on one stack. The
 * returned hooks and issues feed `pancode config inspect`. Best-effort
 * throughout: a malformed file or hook is reported, never thrown.
 */
export function buildUserHookRegistrations(
	options: BuildUserHookRegistrationsOptions,
): BuildUserHookRegistrationsResult {
	const workspaceRoot = options.workspaceRoot ?? options.cwd;
	const readOptions: ReadHookSourcesOptions = { cwd: options.cwd };
	if (options.capturedSources !== undefined) readOptions.capturedSources = options.capturedSources;
	const { batches, fileIssues, projectSurface } = readHookSources(readOptions);
	const loaded = loadUserHooks(batches, { workspaceRoot });
	const runCommand = options.runCommand ?? spawnSyncCommandRunner(workspaceRoot);
	let reportedUntrusted = false;
	const projectStillTrusted = (): boolean => {
		const current = captureProjectSurface(options.cwd, "hooks");
		if (current.verdict === "trusted" && current.contentHash === projectSurface.contentHash) return true;
		if (!reportedUntrusted) {
			reportedUntrusted = true;
			options.report?.(
				`[pancode:hooks] project hooks changed or trust was revoked; hooks skipped. Review with pancode config trust hooks, then reload extensions.`,
			);
		}
		return false;
	};
	const registrations = loaded.hooks.map((hook) =>
		userHookToRegistration(hook, {
			recordReceipt: options.recordReceipt,
			runCommand,
			...(hook.source.origin === "project" || hook.source.origin === "project.local"
				? { isTrusted: projectStillTrusted }
				: {}),
			...(options.now !== undefined ? { now: options.now } : {}),
		}),
	);
	return { ...loaded, fileIssues, registrations };
}

/** Where one command hook runs (P8): its label, and the policy when it runs in the sandbox; or why it may not start. */
export type HookLaunch = { label: HostLaunchLabel; policy?: MainSandboxPolicy } | { refused: string };

/**
 * Where a command hook runs. The operator's own hooks.yaml is operator
 * authority and runs on the host. Project and extension hooks run in the
 * main-session sandbox, network off, when `safety.confine` names `hooks`;
 * otherwise on the host, as before, and labelled so.
 */
export function hookLaunch(
	origin: UserHookOrigin | undefined,
	workspaceRoot: string,
	confine: ReadonlyArray<string>,
): HookLaunch {
	if (origin === "user") return { label: hostAuthorityLabel("yaml-hook") };
	const decided = optInLaunch("yaml-hook", "hooks", confine);
	if ("refused" in decided || !decided.confined) return "refused" in decided ? decided : { label: decided.label };
	return {
		label: decided.label,
		policy: confinedIntegrationPolicy({
			workspace: workspaceRoot,
			scratchRoots: effectiveScratchRoots([], workspaceRoot),
			stateDirs: [],
			network: "off",
		}),
	};
}

/**
 * Production command runner. Runs the argv with no shell (so there is no string
 * to inject into), a wall-clock timeout, and a bounded output buffer, where
 * {@link hookLaunch} says; `confine` is read on each run.
 */
export function spawnSyncCommandRunner(
	workspaceRoot: string = process.cwd(),
	confine: () => ReadonlyArray<string> = () => layeredConfineList(workspaceRoot),
): UserHookCommandRunner {
	return (argv, options): UserHookCommandResult => {
		const launch = hookLaunch(options.origin, workspaceRoot, options.origin === "user" ? [] : confine());
		if ("refused" in launch) return { code: null, timedOut: false, stdout: "", stderr: launch.refused };
		const cwd = options.cwd ?? process.cwd();
		const planned = launch.policy !== undefined ? planMainSandboxSpawn(launch.policy, { argv }, cwd) : undefined;
		if (planned?.kind === "refused") {
			const record = settleHostLaunch(launch.label, { outcome: "refused" }, planned.launch);
			return { code: null, timedOut: false, stdout: "", stderr: planned.message, launch: record };
		}
		const [command, ...args] = planned !== undefined ? [planned.file, ...planned.args] : argv;
		// A user hook is operator automation, not PanCode work: the environment is
		// normalized so a nested seam sees consistent state, but no role is claimed.
		const attribution = withManagedGitCommitAttributionEnvironment(buildSafeToolEnv(), {
			cwd,
			enabled: gitCommitAttributionEnabled(process.env),
			evidence: {},
			author: "human",
		});
		reportCommitAttributionDiagnostic(attribution.diagnostic);
		const result = spawnSync(command ?? "", args, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			timeout: options.timeoutMs,
			...(options.input !== undefined ? { input: options.input } : {}),
			maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
			encoding: "utf8",
			shell: false,
			env: attribution.env,
		});
		planned?.afterExit();
		const record = settleHostLaunch(
			launch.label,
			{ outcome: result.pid === undefined || result.pid === 0 ? "launch-failed" : "ran", exitCode: result.status },
			planned?.launch,
		);
		const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		return {
			code: result.status,
			timedOut,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
			stderr: typeof result.stderr === "string" ? result.stderr : "",
			launch: record,
		};
	};
}
