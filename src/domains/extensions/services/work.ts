// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The run, worktree, verify and claims services one extension runtime is given, built from what its manifest declares
 * and the operator approved. They live as long as the runtime: retiring it ends every run and removes every worktree
 * nobody kept.
 */
import os from "node:os";
import type { ExtensionWorkPlace } from "@pancode/sdk/extension";
import type { ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { readLayeredSettings } from "../../../core/settings-layers.js";
import { containedYoloRefusal } from "../../safety/contained-yolo.js";
import { createExtensionClaimsService } from "./claims.js";
import { createExtensionWorkHost, type ExtensionWorkHost } from "./host.js";
import { type PancodeLaunch, selfPancodeLaunch } from "./run-env.js";
import { createExtensionRunService, type ExtensionRunService } from "./runs.js";
import { createExtensionCheckReceipts, createExtensionVerifyService } from "./verify.js";
import { createExtensionWorktreeService, type ExtensionWorktreeService } from "./worktrees.js";

export interface ExtensionWorkBinding {
	extensionId: string;
	/** The session's workspace, a real path. */
	workspace: string;
	sessionId: string | null;
	/** The extension's store files directory, where its worktrees live. */
	storeDir: string;
	declaration: ExtensionRuntimeDeclarationV2;
}

export interface ExtensionWorkOptions {
	/** How a run or a derived check starts PanCode; this process's own entry by default. */
	launch?: PancodeLaunch;
	/** The environment a run's allowlist picks from; this process's by default. */
	env?: Readonly<Record<string, string>>;
}

export interface ExtensionWork {
	host: ExtensionWorkHost;
	/** End every run, then remove every worktree nobody kept. */
	dispose(): Promise<void>;
}

function processEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return env;
}

function ownLaunch(): PancodeLaunch {
	const entry = process.argv[1];
	if (entry === undefined) throw new Error("cannot locate the pancode entry point to start a run");
	return selfPancodeLaunch(entry);
}

/** Null when the declaration asks for none of these services. */
export function createExtensionWork(
	binding: ExtensionWorkBinding,
	options: ExtensionWorkOptions = {},
): ExtensionWork | null {
	const declared = binding.declaration.services;
	if (!declared?.runs && !declared?.worktrees && !declared?.verify && !declared?.claims) return null;
	const settings = () => readLayeredSettings(binding.workspace).settings;
	const envPolicy = () => {
		const current = settings();
		return { targets: current.targets, passEnv: current.safety.sandboxPassEnv };
	};
	let launch: PancodeLaunch | undefined = options.launch;
	const pancode = (): PancodeLaunch => {
		launch ??= ownLaunch();
		return launch;
	};
	const worktrees: ExtensionWorktreeService | undefined = declared.worktrees
		? createExtensionWorktreeService({
				extensionId: binding.extensionId,
				workspace: binding.workspace,
				storeDir: binding.storeDir,
			})
		: undefined;
	const resolvePlace = async (place: ExtensionWorkPlace): Promise<{ cwd: string; root: string }> => {
		if (place === "workspace") return { cwd: binding.workspace, root: binding.workspace };
		if (!worktrees) throw new Error("this extension declares no runtime.services.worktrees");
		return worktrees.resolvePlace(place);
	};
	const sourceEnv = options.env ?? processEnv();
	const runs: ExtensionRunService | undefined = declared.runs
		? createExtensionRunService({
				ceilings: declared.runs,
				get launch() {
					return pancode();
				},
				sourceEnv,
				get envPolicy() {
					return envPolicy();
				},
				yoloRefusal: () => containedYoloRefusal("an extension's runs"),
				resolvePlace: async (place) => {
					const { cwd, root } = await resolvePlace(place);
					return { cwd, workspaceRoot: root };
				},
				tempRoot: os.tmpdir(),
			})
		: undefined;
	const receipts = createExtensionCheckReceipts(256);
	const verify = declared.verify
		? createExtensionVerifyService({
				settings,
				resolvePlace,
				receipts,
				get launch() {
					return pancode();
				},
				sourceEnv,
				get envPolicy() {
					return envPolicy();
				},
			})
		: undefined;
	const claims = declared.claims
		? createExtensionClaimsService({
				extensionId: binding.extensionId,
				workspace: binding.workspace,
				sessionId: binding.sessionId,
				receipts,
			})
		: undefined;
	return {
		host: createExtensionWorkHost({
			...(runs ? { runs } : {}),
			...(worktrees ? { worktrees } : {}),
			...(verify ? { verify } : {}),
			...(claims ? { claims } : {}),
		}),
		async dispose() {
			await runs?.dispose().catch(() => undefined);
			await worktrees?.dispose().catch(() => undefined);
		},
	};
}
