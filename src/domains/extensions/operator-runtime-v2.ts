// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionEffect,
	ExtensionEmbeddingRequest,
	ExtensionHookEvent,
	ExtensionObservationEventV2,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionRuntimeSnapshot,
	ExtensionRuntimeSnapshotV2,
	ExtensionSkin,
	ExtensionStatus,
	ExtensionToolResult,
	ExtensionUiAction,
	InterviewAnswer,
	InterviewNext,
} from "@pancode/sdk/extension";
import type { ExtensionKeyValueHost, OutputOrigin } from "@pancode/sdk/pack";
import { RUNTIME_LIMITS, RUNTIME_V2_LIMITS } from "@pancode/sdk/pack";
import { recordPackageActivity } from "../../core/package-activity.js";
import type { SandboxMode, UnixSocketMode } from "../../core/sandbox/types.js";
import { readLayeredSettings } from "../../core/settings-layers.js";
import { pancodeStateDir } from "../../core/xdg.js";
import type { EmbeddingResponse } from "../providers/embedding/types.js";
import { extensionIdentity } from "./activity.js";
import type { ExtensionServiceBinding, ExtensionServiceHost } from "./host-services.js";
import {
	type ExtensionCommandRow,
	extensionInvocation,
	type PromptRef,
	promptRefName,
	resolveExtensionAliases,
	resolveExtensionCommands,
} from "./operator-commands.js";
import { extensionOwnerLabel } from "./owner-label.js";
import { ExtensionRequestTimeout, ExtensionRuntimeProcessV2, type RuntimeProcessState } from "./runtime-process-v2.js";
import type { ExtensionSandboxReport } from "./runtime-sandbox.js";
import { createExtensionKeyValueHost, extensionDataPaths } from "./runtime-state.js";
import { type ExtensionGlobWatch, watchExtensionGlobs } from "./runtime-watch.js";
import { runPackBinary } from "./services/binaries.js";
import type { ExtensionKeyClaims } from "./services/keys.js";
import type { ExtensionPaneHost } from "./services/pane.js";
import { createExtensionWork, type ExtensionWorkOptions } from "./services/work.js";
import { pruneOrphanedExtensionSessionState } from "./session-state.js";
import { validateSkin } from "./skin-schema.js";
import { listInstalledExtensions } from "./state.js";
import { type ActiveExtensionWorkspace, ExtensionSurfaceModel } from "./surface-model.js";
import {
	type ExtensionLoadScope,
	type ExtensionProvenance,
	type InstalledExtension,
	isLoadableExtension,
	type LoadableExtension,
} from "./types.js";
import { readSessionWorkspace, writeSessionWorkspace } from "./workspace-session.js";

type RuntimeContext = Omit<ExtensionRuntimeSnapshot, "generation">;

/** How one awaited hook ended. The registration that asked decides what a miss or a failure costs. */
export type ExtensionHookOutcome =
	| { kind: "ok"; effects: ExtensionEffect[] }
	| { kind: "timeout" }
	| { kind: "error"; message: string };
type ReloadReason = "startup" | "reload" | "session-change";

export interface OperatorRuntimeEntry {
	id: string;
	scope: ExtensionLoadScope;
	generation: number;
	state: RuntimeProcessState | "inactive";
	/** Verified owner of this instance, not a subsequent installed-inventory observation. */
	provenance?: ExtensionProvenance;
	reason?: string;
	status?: ExtensionStatus;
	/** What confines this runtime beyond its Node flags; present while the runtime is running. */
	sandbox?: ExtensionSandboxReport;
	/** Actual schema admission is still owned by the session/worker registry. */
	newSessionReasons: string[];
	toolEvidence: "frozen-registry" | "runtime-startup-observation";
}
export interface OperatorReloadResult {
	status: "committed" | "deferred" | "rejected";
	generation: number;
	message: string;
	degraded?: number;
}
/** The runtime closed while a reload ran: a shutdown race, not a failed reload, so it is never reported. */
export class ClosedDuringReload extends Error {
	constructor() {
		super("operator runtime is disposed");
	}
}

export interface OperatorRuntimeV2Options {
	context(): RuntimeContext;
	/** Read as each runtime starts: a read-only session's runtimes may write their store but no user path. */
	readOnly?: () => boolean;
	isIdle(): boolean;
	list?: (cwd: string) => InstalledExtension[];
	/** Root of per-extension state, store and files. */
	stateDir?: () => string;
	embed?: (request: ExtensionEmbeddingRequest, signal: AbortSignal, workspace: string) => Promise<EmbeddingResponse>;
	/** The consent-gated host services; its `embed` wins over the option above. */
	services?: ExtensionServiceHost;
	/** The dock pane `ctx.pane` drives, disposed with the runtime; absent outside an interactive session in herdr. */
	pane?: ExtensionPaneHost;
	/**
	 * Every built-in slash name and alias. A package's bare alias is offered
	 * only in a host that passes these, so it can never shadow a built-in.
	 */
	builtinCommandNames?: () => ReadonlySet<string>;
	/**
	 * The operator's `safety.sandboxUnixSockets`, read as each runtime starts so
	 * a change reaches the next one. Absent blocks them.
	 */
	sandboxUnixSockets?: () => UnixSocketMode;
	/**
	 * The operator's `safety.sandbox` for a workspace, read as each runtime starts.
	 * Absent reads the layered settings, so no caller can leave `required` unenforced.
	 */
	sandboxMode?: (workspace: string) => SandboxMode;
	surface?: ExtensionSurfaceModel;
	/** Captured from the existing registry, never inferred from runtime activation. */
	frozenTools?: ReadonlyArray<ExtensionProvenance>;
	/** Synchronous paired snapshot/hook commit, skipped on startup, which pairs with the boot generation. Runtimes have a separate readiness clock. */
	commitHooks?: () => { status: string; generation: number; reason?: string };
	onChange?: () => void;
	onDiagnostic?: (message: string) => void;
	onReload?: (result: OperatorReloadResult, reason: ReloadReason) => void;
	/** Explicit headless invocation starts only its selected owner. */
	onlyId?: string;
	/**
	 * False in a host that serves no session of its own, the worker hook host: only a main session's host removes the
	 * state of deleted sessions at startup (C-35).
	 */
	pruneOrphanedSessionState?: boolean;
	/**
	 * False for an extension the operator muted. Checked at every entry point,
	 * so a mute takes effect at once while the reload that unloads it waits for
	 * idle: commands, actions, interviews and tools refuse, observations are
	 * dropped, and a hook answers with no effects, since an unloaded gate is
	 * gone rather than failing.
	 */
	admits?: (extensionId: string) => boolean;
	/** How the run and verify services start PanCode; this process's own entry and environment by default. */
	work?: ExtensionWorkOptions;
}

/** Observations a slow runtime may fall behind by before the oldest is dropped. */
export const OBSERVATION_BACKLOG = 64;
/** How long a closing session waits for runtimes to take session_close, so a stuck handler cannot hold a reload or the exit. */
const SESSION_CLOSE_MS = 1000;

function identity(entry: InstalledExtension): string {
	return `${entry.id}:${entry.scope}:${entry.provenance?.canonicalRoot}:${entry.provenance?.contentDigest}`;
}
function servedPlugin(entry: InstalledExtension): ExtensionRuntimeSnapshotV2["plugin"] {
	return entry.plugin && entry.pluginSource ? { id: entry.plugin, prompts: entry.pluginPrompts ?? [] } : null;
}
function contextKey(context: RuntimeContext): string {
	return JSON.stringify(context);
}
class SessionBusyWhileStaging extends Error {
	constructor() {
		super("session became busy while staging; reload queued until idle");
	}
}
/**
 * The TUI has no session id until its first turn. That id arriving does not
 * revoke a running generation: its tools, hooks and commands keep answering,
 * and the generation is replaced at the next idle boundary, which moves what it
 * kept in memory under the new session. Revoking it at once tore every runtime
 * down in the middle of the first turn, so a gate that fails closed refused the
 * model's writes and the turn's first runtime tool call failed.
 */
function adoptsSession(previous: string, now: RuntimeContext): boolean {
	try {
		const before = JSON.parse(previous) as Partial<RuntimeContext>;
		return (
			before.sessionId === null && now.sessionId !== null && before.workspace === now.workspace && before.mode === now.mode
		);
	} catch {
		// An unreadable key is a different context.
		return false;
	}
}
function sameContext(key: string, now: RuntimeContext): boolean {
	return key === contextKey(now) || adoptsSession(key, now);
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
type ApiV2Extension = LoadableExtension & { runtimeV2: NonNullable<LoadableExtension["runtimeV2"]> };
function isApiV2(entry: InstalledExtension): entry is ApiV2Extension {
	return isLoadableExtension(entry) && entry.runtimeV2 !== undefined;
}
/** Why a listed package is not running, from its own flags, with the command that changes it. */
function inactiveReason(entry: InstalledExtension): string | undefined {
	if (entry.muted) return `muted for this session; /extensions unmute ${entry.id} restores it`;
	if (entry.consentPending) return "waiting for your approval of its capability envelope; /extensions dev asks again";
	if (entry.overriddenBy) return `shadowed by the ${entry.overriddenBy} copy`;
	// A trusted surface can still block one record, so name the record rather than the surface.
	if (entry.trustBlocked)
		return `project extension ${entry.id} is not approved for this workspace; pancode config trust extensions reviews it`;
	if (!entry.valid)
		return entry.diagnostics.find((diagnostic) => diagnostic.type === "error")?.message ?? "invalid package";
	if (!entry.compatible) return "not compatible with this PanCode version";
	if (!entry.enabled) return "disabled";
	return undefined;
}

/** A package that only answers commands has nothing to do until the operator asks. */
function startsOnDemand(entry: ApiV2Extension): boolean {
	const declared = entry.runtimeV2;
	return (
		declared.events.length === 0 &&
		declared.tickMs === undefined &&
		declared.hooks.length === 0 &&
		declared.tools.length === 0 &&
		declared.watch.length === 0 &&
		declared.workspaces.length === 0
	);
}
function subscribes(process: ExtensionRuntimeProcessV2, event: ExtensionObservationEventV2): boolean {
	return event === "tick"
		? process.declaration.tickMs !== undefined
		: (process.declaration.events as readonly string[]).includes(event);
}

/**
 * The observation as one extension may see it: content fields cross only for
 * the access classes its manifest declares. Metadata always crosses.
 */
function visibleTo(event: ExtensionObservationV2, access: ReadonlyArray<string>): ExtensionObservationV2 {
	if (event.event === "turn_start" && event.text !== undefined && !access.includes("prompt")) {
		const { text: _text, ...rest } = event;
		return rest;
	}
	if (event.event === "turn_end" && event.text !== undefined && !access.includes("assistant-text")) {
		const { text: _text, ...rest } = event;
		return rest;
	}
	return event;
}

/** Waits for the tasks, at most SESSION_CLOSE_MS. */
async function withinSessionClose(tasks: ReadonlyArray<Promise<unknown>>): Promise<void> {
	if (tasks.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(tasks),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, SESSION_CLOSE_MS);
		}),
	]);
	clearTimeout(timer);
}

/** Missed observations in a row before a slow runtime is worth a notice. */
const SLOW_OBSERVATIONS_REPORTED_AFTER = 3;

interface ObservationQueue {
	events: ExtensionObservationV2[];
	draining: boolean;
	/** Observations in a row the runtime did not answer in time. */
	missed?: number;
	/** Settles when the running drain ends. */
	drained?: Promise<void>;
}

/**
 * Owns api 2 runtimes for the operator surfaces. State, store and the picture
 * live in the host, so a reload restarts every process and loses nothing but
 * in-flight requests. A result is applied only while the process that produced it is
 * still the current one for the same session and installation. Never used by
 * native workers or model tool bootstrap.
 */
function layeredSandboxMode(workspace: string): SandboxMode {
	return readLayeredSettings(workspace).settings.safety.sandbox;
}

export class OperatorExtensionRuntimeV2 {
	private activity(entry: InstalledExtension, kind: string, outcome?: string, details?: Record<string, unknown>): void {
		recordPackageActivity({
			owner: extensionIdentity(entry),
			kind,
			...(outcome ? { outcome } : {}),
			...(details ? { details } : {}),
		});
	}
	readonly surface: ExtensionSurfaceModel;
	private processes = new Map<string, ExtensionRuntimeProcessV2>();
	/** Eligible this generation and not yet started. */
	private deferred = new Map<string, ApiV2Extension>();
	private starting = new Map<string, Promise<ExtensionRuntimeProcessV2>>();
	private inventory: InstalledExtension[] = [];
	private workspaceEntry: InstalledExtension | undefined;
	private failures = new Map<string, string>();
	private queues = new Map<ExtensionRuntimeProcessV2, ObservationQueue>();
	/** Observations that arrived while a session change awaited its generation; the generation hears them after session_open. */
	private held: ExtensionObservationV2[] = [];
	/** Host-driven schedules; a runtime never keeps its own timers or watches. */
	private ticks = new Map<ExtensionRuntimeProcessV2, ReturnType<typeof setInterval>>();
	private watches = new Map<ExtensionRuntimeProcessV2, ExtensionGlobWatch>();
	/** The last state host per extension, so state kept before a session existed follows into the first one. */
	private stateHosts = new Map<string, { sessionId: string | null; host: ExtensionKeyValueHost }>();
	private operatorRequests = new Set<AbortController>();
	private retired = new Set<Promise<void>>();
	private generation = 0;
	private lifetime = 0;
	private activeContext: string | undefined;
	/** Session the committed generation belongs to; a workspace survives a reload only within it. */
	private sessionId: string | null | undefined;
	private restoreWorkspace = false;
	private closed = false;
	/** True between a delivered session_open and its session_close, so every open is paired once. */
	private opened = false;
	private reloading = false;
	private queued = false;
	private reloadTask: Promise<OperatorReloadResult> | undefined;
	private lastScanMs = 0;
	private lastIssue: string | undefined;
	/** The command-tool packages the session's tool registry holds, by id; see `entries`. */
	private initialTools: Map<string, string> | undefined;

	constructor(private readonly options: OperatorRuntimeV2Options) {
		this.surface = options.surface ?? new ExtensionSurfaceModel();
		if (options.frozenTools)
			this.initialTools = new Map(
				options.frozenTools.map((provenance) => [
					provenance.id,
					`${provenance.id}:${provenance.scope}:${provenance.canonicalRoot}:${provenance.contentDigest}`,
				]),
			);
	}

	get activeGeneration(): number {
		return this.generation;
	}
	/** Operator requests and reloads only. Background observations never make the session look busy. */
	get busy(): boolean {
		return this.reloading || this.operatorRequests.size > 0 || this.starting.size > 0;
	}
	/** Eligible packages that start on their first command. */
	get onDemandCount(): number {
		return this.deferred.size;
	}
	/** Live processes, counted against the runtime cap. */
	get processCount(): number {
		const live = [...this.processes.values()].filter(
			(process) => process.state !== "failed" && process.state !== "disposed",
		);
		return live.length + this.starting.size;
	}
	get maintenanceDelayMs(): number | null {
		if (this.closed || this.reloading) return null;
		if (this.queued) return 250;
		return [...this.processes.values()].some((process) => process.state === "ready")
			? Math.max(30000, Math.ceil(this.lastScanMs * 100))
			: null;
	}
	maintenance(): void {
		if (this.closed || this.reloading) return;
		if (this.queued) {
			if (!this.busy && this.options.isIdle()) void this.reload("session-change");
			return;
		}
		if (this.maintenanceDelayMs !== null) this.reconcile();
	}

	private report(text: string): void {
		const line = text.slice(0, 512);
		if (line === this.lastIssue) return;
		this.lastIssue = line;
		try {
			this.options.onDiagnostic?.(line);
		} catch {
			/* A diagnostic sink has no runtime authority. */
		}
	}
	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* Presentation cannot change runtime authority. */
		}
	}
	private context(): RuntimeContext {
		const context = this.options.context();
		return { ...context, workspace: realpathSync(context.workspace) };
	}
	private list(): InstalledExtension[] {
		const start = performance.now();
		try {
			return (this.options.list ?? ((cwd) => listInstalledExtensions(cwd, { all: true })))(this.context().workspace);
		} finally {
			this.lastScanMs = performance.now() - start;
		}
	}
	private capacity(): number {
		return RUNTIME_V2_LIMITS.processes - this.processCount;
	}
	private limitReason(): string {
		return `operator runtime limit is ${RUNTIME_V2_LIMITS.processes}; disable another runtime and reload`;
	}
	/** `after` holds the disposal until it settles; the process is out of the generation at once. */
	private retire(process: ExtensionRuntimeProcessV2, reason: string, after?: Promise<void>): void {
		this.activity(process.extension, "runtime_retire", reason, { generation: this.generation });
		this.disarm(process);
		this.queues.delete(process);
		const task = after ? after.then(() => process.dispose(reason)) : process.dispose(reason);
		this.retired.add(task);
		void task.finally(() => this.retired.delete(task));
	}
	private retireAll(reason: string, after?: Promise<void>): void {
		for (const process of this.processes.values()) this.retire(process, reason, after);
		this.processes.clear();
		this.deferred.clear();
	}
	private workspaceFor(extensionId: string): string | null {
		const active = this.surface.activeWorkspace;
		return active?.extensionId === extensionId ? active.workspaceId : null;
	}
	private spawn(entry: ApiV2Extension, context: RuntimeContext, generation: number): ExtensionRuntimeProcessV2 {
		const paths = extensionDataPaths((this.options.stateDir ?? pancodeStateDir)(), entry.id, context.sessionId);
		const inheritsWorkspace =
			!this.restoreWorkspace &&
			(this.sessionId === context.sessionId || (this.sessionId === null && context.sessionId !== null));
		// The TUI has no session id until its first turn. What an extension kept
		// in memory before then survives a reload in the meantime, and belongs to
		// the session that turn creates.
		const previous = this.stateHosts.get(entry.id);
		const keyValue =
			previous !== undefined && previous.sessionId === null && context.sessionId === null
				? previous.host
				: createExtensionKeyValueHost(paths);
		if (previous?.sessionId === null && context.sessionId !== null && inheritsWorkspace)
			for (const key of previous.host.keys("state"))
				if (keyValue.get("state", key).version === 0) keyValue.set("state", key, previous.host.get("state", key).value);
		this.stateHosts.set(entry.id, { sessionId: context.sessionId, host: keyValue });
		const saved =
			!inheritsWorkspace && context.sessionId !== null
				? readSessionWorkspace((this.options.stateDir ?? pancodeStateDir)(), context.sessionId)
				: null;
		const activeWorkspace = inheritsWorkspace
			? this.workspaceFor(entry.id)
			: saved?.extensionId === entry.id &&
					entry.runtimeV2.workspaces.some((workspace) => workspace.id === saved.workspaceId)
				? saved.workspaceId
				: null;
		const created: { process?: ExtensionRuntimeProcessV2 } = {};
		let reportedState = "";
		const services = this.options.services;
		const embed = services?.embed ?? this.options.embed;
		const binding: ExtensionServiceBinding = {
			extensionId: entry.id,
			scope: entry.scope,
			sessionId: context.sessionId,
			workspace: context.workspace,
			declaration: entry.runtimeV2,
			readOnly: () => this.options.readOnly?.() === true,
		};
		const complete = entry.runtimeV2.services?.model ? services?.complete : undefined;
		const blobs = entry.runtimeV2.services?.store ? services?.blobs : undefined;
		const readOnly = this.options.readOnly?.() === true;
		const binaries = readOnly ? [] : (entry.runtimeV2.binaries ?? []);
		const pane = !readOnly && entry.runtimeV2.services?.pane ? this.options.pane : undefined;
		const unixSockets = this.options.sandboxUnixSockets?.();
		const sandboxMode = (this.options.sandboxMode ?? layeredSandboxMode)(context.workspace);
		const work = createExtensionWork(
			{
				extensionId: entry.id,
				workspace: context.workspace,
				sessionId: context.sessionId,
				declaration: entry.runtimeV2,
				readOnly: binding.readOnly,
			},
			this.options.work,
		);
		created.process = new ExtensionRuntimeProcessV2(entry, {
			snapshot: { ...context, generation, activeWorkspace, plugin: servedPlugin(entry) },
			options: Object.fromEntries(entry.runtimeV2.config.map((field) => [field.key, field.default])),
			keyValue,
			storeDir: paths.storeDir,
			...(embed ? { embed: (request, signal) => embed(request, signal, context.workspace) } : {}),
			...(complete ? { complete: (request, signal) => complete(binding, request, signal) } : {}),
			...(blobs ? { blobs: (request, signal) => blobs(binding, request, signal) } : {}),
			...(work ? { work: work.host, disposeWork: () => work.dispose() } : {}),
			...(binaries.length > 0
				? { binaries: (request, signal) => runPackBinary(entry.id, binaries, request, paths.storeDir, signal) }
				: {}),
			...(pane
				? {
						pane: (op, payload) =>
							pane.call({ extensionId: entry.id, declaration: entry.runtimeV2, storeDir: paths.storeDir }, op, payload),
					}
				: {}),
			...(unixSockets !== undefined ? { unixSockets } : {}),
			sandboxMode,
			...(this.options.readOnly?.() === true ? { readOnly: true } : {}),
			onState: () => {
				const runtime = created.process;
				if (runtime && runtime.state !== reportedState) {
					reportedState = runtime.state;
					if (runtime.state === "ready") this.activity(entry, "runtime_start", "ready", { generation });
					if (runtime.failure) this.activity(entry, "runtime_failure", "error", { generation, reason: runtime.failure });
				}
				if (created.process && this.processes.get(entry.id) === created.process) this.changed();
			},
		});
		return created.process;
	}
	private current(process: ExtensionRuntimeProcessV2): boolean {
		return !this.closed && this.processes.get(process.extension.id) === process && process.state === "ready";
	}

	/** Synchronous fence for resume, fork and branch switch, including same-session leaf changes. */
	invalidateContext(restoreWorkspace = false): void {
		if (restoreWorkspace) this.restoreWorkspace = true;
		if (this.closed || (!this.processes.size && !this.deferred.size && !this.reloading && !this.queued)) return;
		this.lifetime++;
		// The session these runtimes served ends here, so each hears session_close
		// before it is disposed, as on a reload. The send leaves before the fence
		// clears the generation; nothing reaches the old runtimes after it.
		this.retireAll("session-change", this.closeSession("session-change"));
		// What waited for the generation this change replaces belongs to a session no runtime served.
		this.held = [];
		// The reload that follows decides whether the workspace survives; a leaf switch keeps it.
		this.surface.reset(() => true);
		this.queued = true;
		this.changed();
	}

	/** True from a session change that retired every runtime until the next generation commits; also during startup. */
	get awaitingGeneration(): boolean {
		return !this.closed && (this.queued || this.reloading) && this.processes.size === 0 && this.deferred.size === 0;
	}

	/**
	 * Waits for the generation a session change queued. The queued reload runs
	 * only at an idle boundary, so a turn that starts right after ACP's
	 * session/new or a resume would otherwise run with no runtime: gates
	 * declared onError block refuse everything and runtime tools fail. A session
	 * host calls this before each hook and tool call, and its `isIdle` admits
	 * the reload while `awaitingGeneration` holds, since nothing runs to swap out.
	 */
	async whenLive(): Promise<void> {
		for (;;) {
			if (this.awaitingGeneration && this.queued) void this.reload("session-change");
			if (!this.reloading) return;
			// A session change during that reload, or one before this call while it
			// ran, rejected it and queued the next generation; wait for that one too,
			// whichever waiter starts it.
			await this.reloadTask;
		}
	}

	/** Reverify at command boundaries and on the slow lifecycle tick, never during paint. */
	reconcile(): void {
		if (this.closed || (!this.queued && !this.reloading && this.processes.size === 0 && this.deferred.size === 0)) return;
		let context: string;
		let adopts = false;
		let list: InstalledExtension[];
		try {
			const now = this.context();
			context = contextKey(now);
			adopts = this.activeContext !== undefined && adoptsSession(this.activeContext, now);
			list = this.list();
		} catch {
			context = "unavailable";
			list = [];
		}
		const previous = this.inventory;
		this.inventory = list;
		if (adopts) {
			this.queued = true;
			// A workspace entered before the session existed belongs to it from now on.
			this.persistWorkspace();
		} else if (this.activeContext !== undefined && context !== this.activeContext) {
			this.invalidateContext();
			this.activeContext = context;
		}
		const admitted = new Set(list.filter(isApiV2).map(identity));
		for (const [id, process] of this.processes) {
			if (admitted.has(identity(process.extension))) {
				const entry = list.find((candidate) => candidate.id === id && isApiV2(candidate));
				const before = previous.find((candidate) => candidate.id === id && isApiV2(candidate));
				if (entry && JSON.stringify(servedPlugin(entry)) !== JSON.stringify(before ? servedPlugin(before) : null)) {
					process.updateSnapshot({
						...this.context(),
						generation: this.generation,
						activeWorkspace: this.workspaceFor(id),
						plugin: servedPlugin(entry),
					});
					this.changed();
				}
				continue;
			}
			this.processes.delete(id);
			this.failures.set(id, "installation disabled, removed, replaced, or changed; reload after reviewed installation");
			this.retire(process, "installation-revoked");
			void this.options.pane?.release(id);
			if (this.surface.activeWorkspace?.extensionId === id) this.leaveWorkspace();
			this.changed();
		}
		for (const [id, entry] of this.deferred) {
			if (!admitted.has(identity(entry))) this.deferred.delete(id);
			else {
				const current = list.find((candidate): candidate is ApiV2Extension => candidate.id === id && isApiV2(candidate));
				if (current) this.deferred.set(id, current);
			}
		}
		if (this.queued && !this.busy && this.options.isIdle()) void this.reload("session-change");
	}

	reload(reason: ReloadReason = "reload"): Promise<OperatorReloadResult> {
		if (this.closed)
			return Promise.resolve({ status: "rejected", generation: this.generation, message: "operator runtime is disposed" });
		if (this.busy || !this.options.isIdle()) {
			this.queued = true;
			this.changed();
			return Promise.resolve({
				status: "deferred",
				generation: this.generation,
				message: "extension reload queued until the session and extension commands are idle",
			});
		}
		this.queued = false;
		this.reloading = true;
		this.reloadTask = this.performReload(reason).finally(() => {
			this.reloading = false;
			// A commit delivered them; a failed reload with no queued successor has no generation to hand them to.
			if (!this.awaitingGeneration) this.held = [];
			this.changed();
		});
		return this.reloadTask;
	}

	private async performReload(reason: ReloadReason): Promise<OperatorReloadResult> {
		const staged = new Map<string, ExtensionRuntimeProcessV2>();
		const deferred = new Map<string, ApiV2Extension>();
		const failures = new Map<string, string>();
		const lifetime = this.lifetime;
		const next = this.generation + 1;
		let result: OperatorReloadResult;
		try {
			const context = this.context();
			const key = contextKey(context);
			const list = this.list();
			this.inventory = list;
			this.initialTools ??= new Map(
				list
					.filter((entry) => entry.loadable && entry.capabilities?.tools.length)
					.map((entry) => [entry.id, identity(entry)]),
			);
			// A session host starts once per process: state its deleted sessions left behind goes then (C-35).
			if (reason === "startup" && this.options.onlyId === undefined && this.options.pruneOrphanedSessionState !== false)
				pruneOrphanedExtensionSessionState((this.options.stateDir ?? pancodeStateDir)(), context.sessionId);
			if (reason !== "startup") await this.closeSession(reason);
			const prior = [...this.processes.keys(), ...this.deferred.keys()];
			// Every instance restarts; state and the picture are host-held, so nothing is lost but in-flight work.
			this.retireAll(reason);
			await Promise.all(this.retired);
			const eligible = list.filter(
				(entry): entry is ApiV2Extension => isApiV2(entry) && (!this.options.onlyId || entry.id === this.options.onlyId),
			);
			// A pane keeps playing across a reload; it closes once its package can no longer drive it.
			const paneOwner = this.options.pane?.owner() ?? null;
			for (const id of new Set([...prior, ...(paneOwner ? [paneOwner] : [])]))
				if (
					this.options.pane?.owns(id) &&
					!eligible.some((entry) => entry.id === id && entry.runtimeV2.services?.pane === true)
				)
					await this.options.pane.release(id);
			let room = this.capacity();
			for (const entry of eligible) {
				if (!this.options.onlyId && startsOnDemand(entry)) {
					deferred.set(entry.id, entry);
					continue;
				}
				if (room <= 0) {
					failures.set(entry.id, this.limitReason());
					continue;
				}
				room--;
				try {
					staged.set(entry.id, this.spawn(entry, context, next));
				} catch (error) {
					failures.set(entry.id, message(error));
				}
			}
			await Promise.all(
				[...staged].map(async ([id, process]) => {
					try {
						await process.staged;
					} catch (error) {
						failures.set(id, message(error));
					}
				}),
			);
			if (this.closed) throw new ClosedDuringReload();
			if (lifetime !== this.lifetime || !sameContext(key, this.context()))
				throw new Error("session or workspace changed while staging runtimes");
			const current = this.list();
			if (
				JSON.stringify(list.map(identity)) !== JSON.stringify(current.map(identity)) ||
				list.some((entry, index) => entry.loadable !== current[index]?.loadable)
			)
				throw new Error("extension installations changed while staging; reload again");
			if (!this.options.isIdle()) {
				this.queued = true;
				throw new SessionBusyWhileStaging();
			}
			// Boot already published the hook generation this startup pairs with (applyBoot), and committing it again
			// only republished the same snapshot and reloaded unchanged plugin resources a second time (C-34).
			const hooks = reason === "startup" ? undefined : this.options.commitHooks?.();
			if (hooks && hooks.status !== "committed")
				throw new Error(`hook generation rejected: ${hooks.reason ?? hooks.status}`);
			// The TUI has no session id until its first turn, and that turn's session
			// inherits what was open before it, as its state does (spawn).
			const sameSession =
				!this.restoreWorkspace &&
				(this.sessionId === context.sessionId || (this.sessionId === null && context.sessionId !== null));
			this.generation = next;
			this.sessionId = context.sessionId;
			this.activeContext = key;
			this.processes = staged;
			this.deferred = deferred;
			this.failures = failures;
			// The picture is rebuilt by the new generation; a workspace stays only while its owner can still hold it.
			const beforeWorkspace = this.surface.activeWorkspace;
			this.surface.reset(
				(active) =>
					sameSession &&
					eligible.some(
						(entry) =>
							entry.id === active.extensionId &&
							entry.runtimeV2.workspaces.some((workspace) => workspace.id === active.workspaceId),
					),
			);
			if (!sameSession && context.sessionId !== null) {
				const saved = readSessionWorkspace((this.options.stateDir ?? pancodeStateDir)(), context.sessionId);
				const owner = eligible.find((entry) => entry.id === saved?.extensionId);
				if (saved && owner?.runtimeV2.workspaces.some((workspace) => workspace.id === saved.workspaceId))
					this.surface.apply(owner.id, { workspace: { enter: saved.workspaceId } }, "command", owner.runtimeV2.workspaces);
			}
			if (beforeWorkspace !== this.surface.activeWorkspace)
				this.recordWorkspaceChange(beforeWorkspace, this.surface.activeWorkspace);
			if (sameSession) this.persistWorkspace();
			this.restoreWorkspace = false;
			await Promise.all(
				[...staged].map(async ([id, process]) => {
					if (failures.has(id)) return;
					try {
						await process.activate();
					} catch (error) {
						failures.set(id, message(error));
					}
				}),
			);
			if (this.closed) throw new ClosedDuringReload();
			if (lifetime !== this.lifetime || !sameContext(key, this.context()))
				throw new Error("session or workspace changed during runtime activation");
			// Every session host (the terminal, a headless run, ACP) arms ticks and
			// watches and opens the session; the one-shot `extensions run` answers
			// its command and exits.
			if (this.options.onlyId === undefined) {
				for (const [id, process] of staged)
					process.updateSnapshot({
						...context,
						generation: next,
						activeWorkspace: this.workspaceFor(id),
						plugin: servedPlugin(current.find((entry) => entry.id === id && isApiV2(entry)) ?? process.extension),
					});
				for (const process of staged.values()) if (this.current(process)) this.arm(process, context.workspace);
				this.opened = true;
				this.deliver({ event: "session_open", reason });
				const active = this.surface.activeWorkspace;
				if (active) this.observeOne(active.extensionId, { event: "workspace_enter", workspace: active.workspaceId });
				const held = this.held;
				this.held = [];
				for (const event of held) this.deliver(event);
			}
			const ready = [...staged.values()].filter((process) => process.state === "ready").length;
			const degraded = eligible.length - deferred.size - ready;
			const waiting = deferred.size > 0 ? `; ${deferred.size} start on first use` : "";
			result = {
				status: "committed",
				generation: next,
				degraded,
				message:
					degraded > 0
						? `Extensions: ${degraded} failed to start; ${ready} ready${waiting}. Open /extensions to inspect.`
						: ready + deferred.size > 0
							? `Extensions reloaded: ${ready} ready${waiting}.`
							: "Extensions reloaded. No runtime extensions enabled.",
			};
		} catch (error) {
			for (const process of new Set([...this.processes.values(), ...staged.values()]))
				this.retire(process, "reload-rejected");
			this.processes.clear();
			this.deferred.clear();
			result =
				error instanceof SessionBusyWhileStaging
					? // A turn began while the new generation staged. Nothing failed: the reload is queued and runs at the next idle boundary.
						{ status: "deferred", generation: this.generation, message: error.message }
					: error instanceof ClosedDuringReload
						? { status: "rejected", generation: this.generation, message: error.message }
						: {
								status: this.generation === next ? "committed" : "rejected",
								generation: this.generation,
								message: `${this.generation === next ? "Extensions reloaded with errors: " : "Extension reload failed: "}${message(error)}`,
							};
		}
		this.changed();
		try {
			if (!this.closed) this.options.onReload?.(result, reason);
		} catch {
			/* Reporting follows settlement. */
		}
		for (const entry of this.inventory.filter(isApiV2)) {
			if (failures.has(entry.id))
				this.activity(entry, "runtime_failure", "error", { generation: result.generation, reason: failures.get(entry.id) });
			this.activity(entry, "runtime_reload", result.status, { generation: result.generation, reason });
		}
		return result;
	}

	/** Start a deferred package on its first use, once, counted against the shared cap. */
	private ensure(entry: ApiV2Extension): Promise<ExtensionRuntimeProcessV2> {
		const running = this.processes.get(entry.id);
		if (running) return Promise.resolve(running);
		const pending = this.starting.get(entry.id);
		if (pending) return pending;
		if (!this.deferred.has(entry.id)) return Promise.reject(new Error("extension runtime is not available"));
		if (this.capacity() <= 0) return Promise.reject(new Error(this.limitReason()));
		const generation = this.generation;
		const lifetime = this.lifetime;
		const task = (async () => {
			const process = this.spawn(entry, this.context(), generation);
			try {
				await process.staged;
				await process.activate();
			} catch (error) {
				this.retire(process, "start-failed");
				if (generation === this.generation) this.failures.set(entry.id, message(error));
				throw error;
			}
			if (this.closed || lifetime !== this.lifetime || generation !== this.generation || !this.deferred.has(entry.id)) {
				this.retire(process, "superseded");
				throw new Error("extensions reloaded while this runtime started");
			}
			this.deferred.delete(entry.id);
			this.processes.set(entry.id, process);
			return process;
		})().finally(() => {
			this.starting.delete(entry.id);
			this.changed();
		});
		this.starting.set(entry.id, task);
		this.changed();
		return task;
	}

	commands(promptNames: ReadonlyArray<string | PromptRef> = []): ExtensionCommandRow[] {
		const builtins = this.options.builtinCommandNames?.();
		const rows = this.inventory
			.filter((entry) => entry.effective && entry.runtimeV2)
			.flatMap((entry) =>
				(entry.runtimeV2?.commands ?? []).flatMap((command) => {
					const process = this.processes.get(entry.id);
					const failure = this.failures.get(entry.id) ?? process?.failure;
					const muted = this.fenced(entry.id);
					const settling = this.reloading || this.queued;
					const available =
						!muted &&
						entry.loadable &&
						!this.reloading &&
						failure === undefined &&
						(process ? process.state === "ready" : this.deferred.has(entry.id));
					const reason = available
						? undefined
						: (failure ??
							(muted
								? `muted for this session; /extensions unmute ${entry.id} restores it`
								: !entry.loadable
									? "installation is not enabled and eligible"
									: settling
										? "runtime reload in progress"
										: "runtime not ready; reload extensions"));
					const row: ExtensionCommandRow = {
						origin: "extension" as const,
						invocation: extensionInvocation(entry.id, command.name),
						extensionId: entry.id,
						scope: entry.scope,
						description: command.description,
						generation: this.generation,
						available,
						...(command.long ? { long: true as const } : {}),
						...(reason ? { reason } : {}),
						...(!available && settling && failure === undefined && !muted && entry.loadable
							? { transient: true as const }
							: {}),
					};
					// A takeover needs the served plugin in effect and the prompt that wins the name to
					// be that plugin's own. An operator or project prompt of the same name keeps the
					// name, and a bare name carries no owner to compare.
					const alias = entry.plugin ? `${entry.plugin}:${command.name}` : undefined;
					const winner =
						alias === undefined
							? undefined
							: promptNames.find((ref) => promptRefName(ref).toLowerCase() === alias.toLowerCase());
					const bare =
						command.alias !== undefined && builtins
							? [{ ...row, invocation: command.alias, alias: { command: command.name } }]
							: [];
					return alias &&
						command.replaces === "prompt" &&
						entry.pluginPrompts?.includes(alias) &&
						typeof winner === "object" &&
						winner.source !== undefined &&
						winner.source === entry.pluginSource
						? [row, { ...row, invocation: alias, replaces: "prompt" as const }]
						: [row, ...bare];
				}),
			);
		const resolved = resolveExtensionCommands(rows, promptNames);
		return builtins ? resolveExtensionAliases(resolved, builtins, promptNames) : resolved;
	}

	/** One row per installed package, so a command-tool package reports when its tools need a new session. */
	entries(): OperatorRuntimeEntry[] {
		return this.inventory.map((entry) => {
			const process = this.processes.get(entry.id);
			const current = process && identity(process.extension) === identity(entry) ? process : undefined;
			const deferred = this.deferred.get(entry.id);
			const isDeferred = deferred !== undefined && identity(deferred) === identity(entry);
			const reason = !entry.runtimeV2
				? undefined
				: ((entry.effective ? this.failures.get(entry.id) : undefined) ??
					current?.failure ??
					(!current && isDeferred ? "starts on first command" : undefined) ??
					(current ? undefined : inactiveReason(entry)));
			const status = current?.state === "ready" ? this.surface.entry(entry.id)?.status : undefined;
			const initial = this.initialTools?.get(entry.id);
			const tracksToolDrift =
				entry.effective ||
				(initial !== undefined && !this.inventory.some((other) => other.id === entry.id && other.effective));
			const newSessionReasons =
				tracksToolDrift && (entry.capabilities?.tools.length || initial) && initial !== identity(entry)
					? [
							this.options.frozenTools
								? "installed package differs from the frozen tool registry (or was not admitted there); a new session is required for tool admission"
								: "package differs from the runtime-startup observation; actual frozen tool binding is unknown here, inspect the registry or start a new session",
						]
					: [];
			return {
				id: entry.id,
				scope: entry.scope,
				generation: this.generation,
				state: current?.state ?? "inactive",
				...(current ? { provenance: current.extension.provenance, sandbox: current.sandbox } : {}),
				...(reason ? { reason } : {}),
				...(status ? { status } : {}),
				newSessionReasons,
				toolEvidence: this.options.frozenTools ? "frozen-registry" : "runtime-startup-observation",
			};
		});
	}

	/**
	 * Run something the operator did against one runtime, and apply what it
	 * returns only while that runtime is still current for the same session.
	 */
	private async operator<T>(
		entry: ApiV2Extension,
		run: (process: ExtensionRuntimeProcessV2, signal: AbortSignal) => Promise<T>,
		apply: (process: ExtensionRuntimeProcessV2, value: T) => void,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		if (signal?.aborted) controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		this.operatorRequests.add(controller);
		this.changed();
		try {
			const process = await this.ensure(entry);
			const key = contextKey(this.context());
			const lifetime = this.lifetime;
			const value = await run(process, controller.signal);
			this.reconcile();
			if (
				controller.signal.aborted ||
				lifetime !== this.lifetime ||
				!sameContext(key, this.context()) ||
				!this.current(process)
			)
				throw new Error("extension result belongs to a revoked runtime or session");
			apply(process, value);
			return value;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.operatorRequests.delete(controller);
			this.changed();
		}
	}

	/**
	 * `progress` hears a `long` command's lines; without it they replace the extension's status line when it
	 * declares one.
	 */
	async invoke(
		invocation: string,
		args: string,
		promptNames: ReadonlyArray<string | PromptRef> = [],
		signal?: AbortSignal,
		progress?: (text: string) => void,
	): Promise<ExtensionOutputV2> {
		this.reconcile();
		// The first command after a turn that created the session is what starts
		// the reload adopting it; refusing over that reload failed a command the
		// operator typed at an idle prompt, so it waits for the generation instead.
		while (this.reloading && this.reloadTask && !this.closed) await this.reloadTask;
		if (this.closed) throw new Error("extension runtimes have shut down");
		if (!this.options.isIdle()) throw new Error("PanCode is busy; run it again once the current turn finishes");
		if (Buffer.byteLength(args) > RUNTIME_LIMITS.argumentBytes) throw new Error("extension arguments exceed 16 KiB");
		const row = this.commands(promptNames).find((candidate) => candidate.invocation === invocation);
		if (!row?.available) throw new Error(row?.reason ?? `/${invocation} is not an available extension command`);
		this.refuseFenced(row.extensionId);
		const entry = this.inventory.find(
			(candidate): candidate is ApiV2Extension => isApiV2(candidate) && candidate.id === row.extensionId,
		);
		if (!entry) throw new Error("extension command unavailable");
		const name = row.alias?.command ?? invocation.slice(invocation.lastIndexOf(":") + 1);
		const details = { invocation, plugin: entry.plugin ?? null, takeover: row.replaces === "prompt" };
		this.activity(entry, "command", "started", details);
		try {
			const output = await this.operator(
				entry,
				(process, abort) => process.command(name, args, abort, progress ?? this.statusProgress(process)),
				(process, output) => this.apply(process, output, "command"),
				signal,
			);
			this.activity(entry, "command", "ok", details);
			return output;
		} catch (error) {
			this.activity(entry, "command", "error", { ...details, reason: message(error) });
			throw error;
		}
	}

	private statusProgress(process: ExtensionRuntimeProcessV2): ((text: string) => void) | undefined {
		if (!process.declaration.ui.includes("status")) return undefined;
		return (text) => {
			if (this.current(process)) this.apply(process, { status: { text } }, "observation");
		};
	}

	/** A press on something this extension drew, or one of its global keys (which may start a deferred runtime). */
	async action(extensionId: string, event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		if (event.source === "key") {
			while (this.reloading && this.reloadTask && !this.closed) await this.reloadTask;
		}
		this.refuseFenced(extensionId);
		const entry = (event.source === "key" ? this.deferred.get(extensionId) : undefined) ?? this.runningEntry(extensionId);
		return this.operator(
			entry,
			(process) => process.action(event),
			(process, output) => this.apply(process, output, "action"),
		);
	}

	/**
	 * One answered step of an interview this extension started. The signal
	 * reaches the handler as its own, so a parked tool call that is cancelled
	 * while the handler runs is seen there too.
	 */
	async interview(extensionId: string, answer: InterviewAnswer, signal?: AbortSignal): Promise<InterviewNext> {
		const entry = this.runningEntry(extensionId);
		return this.operator(
			entry,
			(process, abort) => process.interview(answer, abort),
			(process, next) => {
				if (!("done" in next)) return;
				const { done: _done, ...output } = next;
				this.apply(process, output, "action");
			},
			signal,
		);
	}

	/**
	 * One call to a gateway tool this extension serves. It runs during a turn,
	 * so unlike a command it needs no idle session, only the current runtime;
	 * a card it returns is drawn for the operator, and an interview it asks for
	 * goes back to the caller, which parks the call on it.
	 */
	async tool(extensionId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ExtensionToolResult> {
		this.refuseFenced(extensionId);
		const process = this.processes.get(extensionId);
		if (!process || !this.current(process)) throw new Error(`extension ${extensionId} has no running runtime`);
		const result = await process.tool(name, input, signal);
		if (result.card) this.apply(process, { card: result.card }, "tool");
		return result;
	}

	private fenced(extensionId: string): boolean {
		return this.options.admits?.(extensionId) === false;
	}
	private refuseFenced(extensionId: string): void {
		if (this.fenced(extensionId)) throw new Error(`extension ${extensionId} is muted for this session`);
	}

	private runningEntry(extensionId: string): ApiV2Extension {
		this.refuseFenced(extensionId);
		const process = this.processes.get(extensionId);
		if (!process || !this.current(process)) throw new Error(`extension ${extensionId} has no running runtime`);
		return process.extension as ApiV2Extension;
	}

	/**
	 * One awaited hook. Its `ui` is applied like an observation's; its effects
	 * go back to the middleware registration that asked. A runtime that is not
	 * running is an error outcome, so a gate declared `onError: block` stays shut.
	 */
	async hook(
		extensionId: string,
		event: ExtensionHookEvent,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExtensionHookOutcome> {
		if (this.fenced(extensionId)) return { kind: "ok", effects: [] };
		const process = this.processes.get(extensionId);
		if (!process || !this.current(process)) return { kind: "error", message: "runtime is not running" };
		const lifetime = this.lifetime;
		try {
			const result = await process.hook(event, timeoutMs, signal);
			if (result.ui && lifetime === this.lifetime) this.apply(process, result.ui, "observation");
			return { kind: "ok", effects: result.effects ?? [] };
		} catch (error) {
			if (error instanceof ExtensionRequestTimeout) return { kind: "timeout" };
			return { kind: "error", message: message(error) };
		}
	}

	/** The operator left the workspace (`/extensions leave`, the leader key). */
	leaveWorkspace(): boolean {
		const before = this.surface.activeWorkspace;
		if (!before) return false;
		this.surface.leaveWorkspace();
		this.workspaceMoved(before, null);
		this.changed();
		return true;
	}
	closePanel(extensionId: string): void {
		this.surface.closePanel(extensionId);
	}

	/**
	 * The validated skin of a workspace, read from the runtime's digest-checked
	 * private copy rather than the installed root, so a file changed after
	 * install never paints. Null when the workspace has none or it no longer
	 * validates.
	 */
	skinFor(extensionId: string, workspaceId: string): ExtensionSkin | null {
		const process = this.processes.get(extensionId);
		const file = process?.declaration.workspaces.find((workspace) => workspace.id === workspaceId)?.skin;
		if (!process || !this.current(process) || file === undefined) return null;
		try {
			const checked = validateSkin(JSON.parse(readFileSync(path.join(process.copyRoot, "package", file), "utf8")));
			if (checked.ok) return checked.skin;
			this.report(`extension ${extensionId}: skin ${file} refused: ${checked.path} ${checked.reason}`);
		} catch (error) {
			this.report(`extension ${extensionId}: skin ${file} unreadable: ${message(error)}`);
		}
		return null;
	}

	private apply(
		process: ExtensionRuntimeProcessV2,
		output: Omit<ExtensionOutputV2, "text">,
		origin: OutputOrigin,
	): void {
		if (!this.current(process)) return;
		const before = this.surface.activeWorkspace;
		this.surface.apply(process.extension.id, output, origin, process.declaration.workspaces);
		const after = this.surface.activeWorkspace;
		if (before !== after) this.workspaceMoved(before, after);
		this.changed();
	}
	/** Tell the runtimes involved; each reads `activeWorkspace` from its next snapshot. */
	private workspaceMoved(before: ActiveExtensionWorkspace | null, after: ActiveExtensionWorkspace | null): void {
		this.persistWorkspace();
		const context = this.context();
		for (const id of new Set([before?.extensionId, after?.extensionId])) {
			if (id === undefined) continue;
			const process = this.processes.get(id);
			if (process)
				process.updateSnapshot({
					...context,
					generation: this.generation,
					activeWorkspace: this.workspaceFor(id),
					plugin: servedPlugin(this.inventory.find((entry) => entry.id === id && isApiV2(entry)) ?? process.extension),
				});
		}
		if (before) this.observeOne(before.extensionId, { event: "workspace_leave", workspace: before.workspaceId });
		if (after) this.observeOne(after.extensionId, { event: "workspace_enter", workspace: after.workspaceId });
		this.recordWorkspaceChange(before, after);
	}
	private recordWorkspaceChange(before: ActiveExtensionWorkspace | null, after: ActiveExtensionWorkspace | null): void {
		const previous = this.workspaceEntry ?? this.inventory.find((entry) => entry.id === before?.extensionId);
		if (before && previous) this.activity(previous, "workspace_leave", "ok", { workspace: before.workspaceId });
		this.workspaceEntry = this.inventory.find((entry) => entry.id === after?.extensionId);
		if (after && this.workspaceEntry)
			this.activity(this.workspaceEntry, "workspace_enter", "ok", { workspace: after.workspaceId });
	}

	/** Save which workspace is open under the session, for a restart that must come back to it. */
	saveWorkspace(): void {
		if (!this.closed) this.persistWorkspace();
	}

	private persistWorkspace(): void {
		const sessionId = this.context().sessionId;
		if (sessionId === null) return;
		const active = this.surface.activeWorkspace;
		try {
			writeSessionWorkspace(
				(this.options.stateDir ?? pancodeStateDir)(),
				sessionId,
				active ? { extensionId: active.extensionId, workspaceId: active.workspaceId } : null,
			);
		} catch (error) {
			this.report(`Workspace selection could not be saved: ${message(error)}`);
		}
	}

	/**
	 * Passive delivery to every ready runtime that declared the event, in order
	 * per runtime. Nothing is coalesced, because usage and file
	 * changes carry data; a runtime that falls far behind loses the oldest.
	 */
	observe(event: ExtensionObservationV2): void {
		if (this.closed) return;
		// A turn that starts right after a session change runs before the
		// queued generation commits; its turn_start would reach no runtime.
		if (this.awaitingGeneration && this.options.onlyId === undefined) {
			if (this.held.length >= OBSERVATION_BACKLOG) this.held.shift();
			this.held.push(event);
			return;
		}
		this.deliver(event);
	}
	/** The global keys of every package that can answer one now. */
	keyClaims(): ExtensionKeyClaims[] {
		return this.inventory.flatMap((entry) =>
			entry.effective && entry.loadable && entry.runtimeV2?.keys?.length && !this.fenced(entry.id)
				? [{ extensionId: entry.id, keys: entry.runtimeV2.keys }]
				: [],
		);
	}
	/** An observation only one runtime may see, such as the change of its own pane. */
	observeExtension(extensionId: string, event: ExtensionObservationV2): void {
		if (!this.closed) this.observeOne(extensionId, event);
	}
	private deliver(event: ExtensionObservationV2): void {
		for (const process of this.processes.values()) this.enqueue(process, event);
	}
	private observeOne(extensionId: string, event: ExtensionObservationV2): void {
		const process = this.processes.get(extensionId);
		if (process) this.enqueue(process, event);
	}
	/**
	 * Ticks and file watches are driven here. A tick is skipped while the
	 * runtime is still working through earlier observations, so a slow handler
	 * sees at most one pending tick rather than a backlog.
	 */
	private arm(process: ExtensionRuntimeProcessV2, workspace: string): void {
		const declared = process.declaration;
		if (declared.tickMs !== undefined && !this.ticks.has(process)) {
			const intervalMs = declared.tickMs;
			const timer = setInterval(() => {
				if (!this.current(process)) return;
				const queue = this.queues.get(process);
				if (queue && (queue.draining || queue.events.some((event) => event.event === "tick"))) return;
				this.enqueue(process, { event: "tick", intervalMs });
			}, intervalMs);
			timer.unref();
			this.ticks.set(process, timer);
		}
		if (declared.watch.length > 0 && declared.events.includes("fs_changed") && !this.watches.has(process))
			this.watches.set(
				process,
				watchExtensionGlobs(workspace, declared.watch, (paths) => this.enqueue(process, { event: "fs_changed", paths })),
			);
	}
	private disarm(process: ExtensionRuntimeProcessV2): void {
		const timer = this.ticks.get(process);
		if (timer) clearInterval(timer);
		this.ticks.delete(process);
		this.watches.get(process)?.close();
		this.watches.delete(process);
	}

	private enqueue(process: ExtensionRuntimeProcessV2, observed: ExtensionObservationV2): void {
		if (process.state !== "ready" || !subscribes(process, observed.event) || this.fenced(process.extension.id)) return;
		const event = visibleTo(observed, process.declaration.access);
		let queue = this.queues.get(process);
		if (!queue) {
			queue = { events: [], draining: false };
			this.queues.set(process, queue);
		}
		if (queue.events.length >= OBSERVATION_BACKLOG) {
			queue.events.shift();
			this.report(`extension ${process.extension.id} is behind on observations; the oldest was dropped`);
		}
		queue.events.push(event);
		if (!queue.draining) queue.drained = this.drain(process, queue);
	}
	private async drain(process: ExtensionRuntimeProcessV2, queue: ObservationQueue): Promise<void> {
		queue.draining = true;
		try {
			while (queue.events.length > 0 && this.current(process) && this.queues.get(process) === queue) {
				const event = queue.events.shift() as ExtensionObservationV2;
				const lifetime = this.lifetime;
				try {
					const output = await process.observe(event);
					queue.missed = 0;
					if (output && lifetime === this.lifetime) this.apply(process, output, "observation");
				} catch (error) {
					const name = extensionOwnerLabel(process.extension.id);
					// One late answer under load is not a fault the operator can act on, and the runtime stays up; a
					// `session_open handler skipped` warning beside `● running` read as a contradiction. A runtime that
					// keeps missing is said once, plainly.
					if (error instanceof ExtensionRequestTimeout) {
						queue.missed = (queue.missed ?? 0) + 1;
						if (queue.missed === SLOW_OBSERVATIONS_REPORTED_AFTER)
							this.report(`${name} is answering slowly and missed its last ${queue.missed} updates; /extensions shows it`);
						continue;
					}
					this.report(`${name} could not handle the ${event.event.replaceAll("_", " ")} update: ${message(error)}`);
				}
			}
		} finally {
			queue.draining = false;
		}
	}

	/**
	 * Tells the runtimes that declared session_close the session they served is
	 * ending, before their processes are retired. Delivery skips the queue so
	 * retirement cannot drop it, and its answer is not applied. What the queue
	 * still holds for that session, such as the last turn's turn_end, goes
	 * first: a session change retires the queue at once.
	 */
	private async closeSession(reason: "exit" | "reload" | "session-change"): Promise<void> {
		if (!this.opened) return;
		this.opened = false;
		const event: ExtensionObservationV2 = { event: "session_close", reason };
		const sends = [...this.processes.values()]
			.filter((process) => process.state === "ready" && !this.fenced(process.extension.id))
			.map(async (process) => {
				const queue = this.queues.get(process);
				const pending = queue?.events.splice(0) ?? [];
				await queue?.drained?.catch(() => undefined);
				for (const observed of pending) await process.observe(observed).catch(() => undefined);
				if (subscribes(process, event.event)) await process.observe(event).catch(() => undefined);
			});
		await withinSessionClose(sends);
	}

	/** Operator cancel aborts operator requests; the runtimes keep serving. */
	cancel(): void {
		for (const controller of this.operatorRequests) controller.abort();
	}

	async dispose(): Promise<void> {
		// A session host disposes right after its last turn, while that turn's
		// turn_end is still queued or in flight; it reaches each runtime before
		// session_close, within the same bound, instead of being cut off.
		if (!this.closed)
			await withinSessionClose([...this.queues.values()].flatMap((queue) => (queue.drained ? [queue.drained] : [])));
		this.closed = true;
		this.lifetime++;
		this.cancel();
		await this.closeSession("exit");
		this.retireAll("session-closed");
		await this.reloadTask;
		await Promise.allSettled([...this.starting.values()]);
		await Promise.all(this.retired);
		if (this.surface.activeWorkspace) this.recordWorkspaceChange(this.surface.activeWorkspace, null);
		this.surface.reset(() => false);
		await this.options.pane?.dispose();
	}
}
