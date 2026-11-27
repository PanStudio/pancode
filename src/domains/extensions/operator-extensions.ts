// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	ExtensionEmbeddingRequest,
	ExtensionHookEvent,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionSkin,
	ExtensionToolResult,
	ExtensionUiAction,
	InterviewAnswer,
	InterviewNext,
} from "@pancode/sdk/extension";
import type { UnixSocketMode } from "../../core/sandbox/types.js";
import type { EmbeddingResponse } from "../providers/embedding/types.js";
import type { ExtensionServiceHost } from "./host-services.js";
import type { ExtensionCommandRow, PromptRef } from "./operator-commands.js";
import {
	type ExtensionHookOutcome,
	OperatorExtensionRuntimeV2,
	type OperatorReloadResult,
	type OperatorRuntimeEntry,
	type OperatorRuntimeV2Options,
} from "./operator-runtime-v2.js";
import type { ExtensionSurfaceModel } from "./surface-model.js";

export type OperatorExtensionsOptions = Pick<
	OperatorRuntimeV2Options,
	| "context"
	| "isIdle"
	| "list"
	| "onChange"
	| "onReload"
	| "onDiagnostic"
	| "onlyId"
	| "readOnly"
	| "frozenTools"
	| "commitHooks"
	| "stateDir"
	| "surface"
	| "pruneOrphanedSessionState"
> & {
	embed?: (request: ExtensionEmbeddingRequest, signal: AbortSignal, workspace: string) => Promise<EmbeddingResponse>;
	/** See `OperatorRuntimeV2Options.services`. */
	services?: ExtensionServiceHost;
	/** See `OperatorRuntimeV2Options.sandboxUnixSockets`. */
	sandboxUnixSockets?: () => UnixSocketMode;
	/** False for an extension the operator muted; see `OperatorRuntimeV2Options.admits`. */
	admits?: (extensionId: string) => boolean;
};

type ReloadReason = "startup" | "reload" | "session-change";

/**
 * The operator-extension surface over the runtime manager. It adds one fence:
 * a reload asked for while the session or an operator command is busy waits for
 * idle, keeping the reason it was asked for.
 */
export class OperatorExtensions {
	readonly v2: OperatorExtensionRuntimeV2;
	/**
	 * The reload waiting for an idle session, by the reason it was asked for. A
	 * replay that forgot the reason announced a startup or session-change reload
	 * as one the operator asked for, so a plain session saw "Extensions reloaded"
	 * after work that never touched an extension. An operator's reload wins.
	 */
	private queuedReload: ReloadReason | null = null;
	private disposed = false;

	constructor(private readonly options: OperatorExtensionsOptions) {
		this.v2 = new OperatorExtensionRuntimeV2(options);
	}

	get surface(): ExtensionSurfaceModel {
		return this.v2.surface;
	}
	get busy(): boolean {
		return this.v2.busy;
	}
	/** Whether a reload would start now; when false it queues until the session and operator commands are idle. */
	get canReloadNow(): boolean {
		return !this.busy && this.options.isIdle();
	}
	get maintenanceDelayMs(): number | null {
		if (this.disposed) return null;
		if (this.queuedReload) return 250;
		return this.v2.maintenanceDelayMs;
	}
	maintenance(): void {
		if (this.disposed) return;
		if (this.queuedReload && !this.busy && this.options.isIdle()) {
			void this.reload(this.queuedReload);
			return;
		}
		this.v2.maintenance();
	}
	invalidateContext(restoreWorkspace = false): void {
		this.v2.invalidateContext(restoreWorkspace);
	}

	/** The manager reports its own result through `onReload`; a deferred reload reports nothing until it runs. */
	reload(reason: ReloadReason = "reload"): Promise<OperatorReloadResult> {
		if (this.disposed)
			return Promise.resolve({
				status: "rejected",
				generation: this.v2.activeGeneration,
				message: "operator runtime is disposed",
			});
		// Do not commit hooks while an operator command still owns its generation.
		if (!this.canReloadNow) {
			this.queuedReload = this.queuedReload === "reload" || reason === "reload" ? "reload" : reason;
			this.options.onChange?.();
			return Promise.resolve({
				status: "deferred",
				generation: this.v2.activeGeneration,
				message: "extension reload deferred until the session and operator commands are idle",
			});
		}
		this.queuedReload = null;
		return this.v2.reload(reason);
	}

	commands(promptNames: ReadonlyArray<string | PromptRef> = []): ExtensionCommandRow[] {
		return this.v2.commands(promptNames);
	}
	/** One row per installed package. */
	entries(): OperatorRuntimeEntry[] {
		return this.v2.entries();
	}
	invoke(
		invocation: string,
		args: string,
		promptNames: ReadonlyArray<string | PromptRef> = [],
		signal?: AbortSignal,
	): Promise<ExtensionOutputV2> {
		return this.v2.invoke(invocation, args, promptNames, signal);
	}
	observeV2(observation: ExtensionObservationV2): void {
		this.v2.observe(observation);
	}
	action(extensionId: string, event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		return this.v2.action(extensionId, event);
	}
	interview(extensionId: string, answer: InterviewAnswer, signal?: AbortSignal): Promise<InterviewNext> {
		return this.v2.interview(extensionId, answer, signal);
	}
	saveWorkspace(): void {
		this.v2.saveWorkspace();
	}
	leaveWorkspace(): boolean {
		return this.v2.leaveWorkspace();
	}
	closePanel(extensionId: string): void {
		this.v2.closePanel(extensionId);
	}
	hook(
		extensionId: string,
		event: ExtensionHookEvent,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExtensionHookOutcome> {
		return this.v2.hook(extensionId, event, timeoutMs, signal);
	}
	tool(extensionId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ExtensionToolResult> {
		return this.v2.tool(extensionId, name, input, signal);
	}
	skinFor(extensionId: string, workspaceId: string): ExtensionSkin | null {
		return this.v2.skinFor(extensionId, workspaceId);
	}
	cancel(): void {
		this.v2.cancel();
	}
	dispose(): Promise<void> {
		this.disposed = true;
		this.queuedReload = null;
		return this.v2.dispose();
	}
}
