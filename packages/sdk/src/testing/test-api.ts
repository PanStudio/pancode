// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	ExtensionBlobs,
	ExtensionCompletion,
	ExtensionCompletionRequest,
	ExtensionHookEvent,
	ExtensionHookResult,
	ExtensionKeyValue,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionRuntimeSnapshotV2,
	ExtensionToolResult,
	InterviewAnswer,
	InterviewNext,
} from "../extension/public-api-v2.js";
import type { ExtensionKeyValueHost } from "../pack/key-value.js";
import type { ExtensionRuntimeDeclarationV2 } from "../pack/manifest-v2.js";
import type { RuntimeRegistration } from "./registration.js";

export interface ExtensionTestHost {
	command(name: string, args?: string): Promise<ExtensionOutputV2>;
	observe(event: ExtensionObservationV2): Promise<ExtensionOutputV2 | undefined>;
	hook(event: ExtensionHookEvent, options?: { timeoutMs?: number }): Promise<ExtensionHookResult>;
	tool(name: string, input: unknown): Promise<ExtensionToolResult>;
	action(id: string, key?: string): Promise<ExtensionOutputV2>;
	interview(answer: InterviewAnswer): Promise<InterviewNext>;
	/** Leaves the active workspace as the operator does: the snapshot clears, then `workspace_leave` is delivered. */
	leave(): Promise<ExtensionOutputV2 | undefined>;
	tick(): Promise<ExtensionOutputV2 | undefined>;
	readonly state: ExtensionKeyValue;
	readonly store: ExtensionKeyValue;
	readonly now: number;
	/** Advances Date in this host's handlers and delivers every due declared tick. Deadlines use real timers. */
	advance(ms: number): Promise<Array<ExtensionOutputV2 | undefined>>;
	dispose(): Promise<void>;
}

export interface ExtensionTestOptions {
	plugin?: ExtensionRuntimeSnapshotV2["plugin"];
	options?: Record<string, string | number | boolean>;
	sessionId?: string | null;
	workspace?: string;
	/**
	 * Answers `ctx.complete` when the manifest declares `runtime.services.model`. It receives the request as
	 * PanCode validates it, and its answer is validated as PanCode validates a provider's. Absent, a call rejects.
	 */
	complete?(request: ExtensionCompletionRequest): ExtensionCompletion | Promise<ExtensionCompletion>;
	/**
	 * Stands in for the store behind `ctx.blobs` when the manifest declares `runtime.services.store`. Each call is
	 * first checked against the declared tags, as PanCode checks it. Absent, a call rejects.
	 */
	blobs?: ExtensionBlobs;
}

/** The manifest facts the test host runs on. */
export interface ExtensionTestManifest {
	id: string;
	runtime: ExtensionRuntimeDeclarationV2;
}

/**
 * What the test host takes from the PanCode it stands in for. Each one has a
 * portable default, so a package tests with this module alone; the install's
 * kit supplies PanCode's own so a test sees exactly what the harness would.
 */
export interface ExtensionTestServices {
	/** Reads and validates the package manifest. The default reads `pancode-extension.json`. */
	loadManifest?(root: string): ExtensionTestManifest;
	/** A fresh state and store for one host. The default holds them in memory with the runtime's limits. */
	keyValue?(): ExtensionKeyValueHost;
	/** Builds the registration API the factory receives and the handler tables it fills. */
	register?(declaration: ExtensionRuntimeDeclarationV2): RuntimeRegistration;
	/** The error a request that outlived its deadline rejects with. */
	timeoutError?(kind: string): Error;
	/** Whether a bare tool name is one of the host's builtins. The default knows none. */
	isBuiltinTool?(name: string): boolean;
}
