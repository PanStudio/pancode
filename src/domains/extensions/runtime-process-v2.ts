// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionCompletion,
	ExtensionCompletionRequest,
	ExtensionEmbeddingRequest,
	ExtensionHookEvent,
	ExtensionHookResult,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionRuntimeSnapshotV2,
	ExtensionToolResult,
	ExtensionUiAction,
	InterviewAnswer,
	InterviewNext,
} from "@pancode/sdk/extension";
import type { ExtensionBlobRequest, ExtensionKeyValueHost, ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import {
	extensionPlainText,
	type OutputOrigin,
	parseExtensionBlobRequest,
	parseExtensionCompletion,
	parseExtensionCompletionRequest,
	parseExtensionHookResult,
	parseExtensionOutputV2,
	parseExtensionToolResult,
	parseInterviewNext,
	RUNTIME_LIMITS,
	RUNTIME_V2_LIMITS,
	resolveExtensionEntrypoint,
} from "@pancode/sdk/pack";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { ensureProjectIgnore } from "../../core/project-root.js";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import type { SandboxMode, UnixSocketMode } from "../../core/sandbox/types.js";
import type { ToolName } from "../../core/tool-names.js";
import { isBuiltinToolName } from "../../core/tool-names.js";
import type { EmbeddingResponse } from "../providers/embedding/types.js";
import { parseExtensionManifest } from "./discovery.js";
import { extensionContentDigestWithCapture } from "./integrity.js";
import type { ResolvedPathGrant } from "./path-grants.js";
import {
	assertPlainProjectDir,
	type ExtensionSandboxReport,
	extensionProjectDir,
	planExtensionLaunch,
	prepareDeclaredWriteRoots,
	prepareProjectDir,
	readOnlyRuntimeDeclaration,
	releaseDeclaredWriteRoots,
} from "./runtime-sandbox.js";
import { type PackBinaryRunRequest, parsePackBinaryRun } from "./services/binaries.js";
import type { PackBinaryRunResult } from "./services/binary-runs.js";
import type { ExtensionWorkHost, ExtensionWorkKind } from "./services/host.js";
import { createExtensionRequestScope, type OwnedExtensionRequestScope } from "./services/scope.js";
import type { LoadableExtension } from "./types.js";

export interface RuntimeProcessV2Options {
	snapshot: ExtensionRuntimeSnapshotV2;
	/** Resolved values of the manifest's config fields. */
	options: Readonly<Record<string, string | number | boolean>>;
	keyValue: ExtensionKeyValueHost;
	/** The directory the `store` write root names. */
	storeDir: string;
	/** A host-owned, consent-gated service; no credentials or route objects cross IPC. */
	embed?: (request: ExtensionEmbeddingRequest, signal: AbortSignal) => Promise<EmbeddingResponse>;
	/** The operator-assigned model, inside the approved budget. Present only when the service is approved. */
	complete?: (request: ExtensionCompletionRequest, signal: AbortSignal) => Promise<ExtensionCompletion>;
	/**
	 * The store, limited to the approved tags. A put's `sourcePath` arrives resolved and confined to a root
	 * this runtime may read. A get answers `{ base64 }` or null.
	 */
	blobs?: (request: ExtensionBlobRequest, signal: AbortSignal) => Promise<unknown>;
	/**
	 * The run, worktree, verify and claims services the operator approved, reached from a command or an action only.
	 * Each call ends with the request that made it.
	 */
	work?: ExtensionWorkHost;
	/** Ends remaining work-service runs and removes transient worktrees when this process exits or disposes. */
	disposeWork?: () => Promise<void>;
	/**
	 * Runs a declared binary; the request is already checked against the declaration. `parent` is the kind of request
	 * the call belongs to, which the host checks on every call.
	 */
	binaries?: (request: PackBinaryRunRequest, signal: AbortSignal, parent: string) => Promise<PackBinaryRunResult>;
	/** One `ctx.pane` call; the pane host checks the payload against the declaration, and the caller as `binaries`. */
	pane?: (op: string, payload: unknown, parent: string) => Promise<unknown>;
	onState?: () => void;
	/** A rejection the runtime's code left unhandled once it was active, once per distinct reason; the runtime keeps serving. */
	onUnhandled?: (error: string) => void;
	/** The operator's `safety.sandboxUnixSockets` when this runtime starts; absent blocks them. */
	unixSockets?: UnixSocketMode;
	/** The operator's `safety.sandbox` when this runtime starts; `required` refuses an unconfined launch. */
	sandboxMode?: SandboxMode;
	/** The session is read-only: the runtime may write its store but no user path (readOnlyRuntimeDeclaration). */
	readOnly?: boolean;
	/** The paths the operator named for a `pancode <verb>`'s declared path flags; write roots already exist. */
	grants?: ReadonlyArray<ResolvedPathGrant>;
}

export interface RuntimeRoots {
	bootstrap: string;
	packageCopy: string;
	workspace: string;
	storeDir: string;
	home: string;
	/** The `runtime.state.project` directory, and whether this session may write it. */
	project?: { dir: string; writable: boolean };
	grants?: ReadonlyArray<ResolvedPathGrant>;
}

/** A request the runtime did not answer in time. The runtime stays up; the caller decides what a miss costs. */
export class ExtensionRequestTimeout extends Error {
	constructor(readonly kind: string) {
		super(`extension ${kind} timed out`);
	}
}

const directory = (root: string): string => (root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/**
 * Node permission flags for one runtime, built from what its manifest
 * declares. This is a seat belt against mistakes in code the operator asked
 * for, not a boundary against a hostile package: a package that may run
 * programs can do anything those programs can. Sockets and writes by such
 * programs are confined only by the OS sandbox `planExtensionLaunch` applies.
 * The store files directory is reachable only when `fs.write` names `store`;
 * the host key/value store is a separate service and needs no file access.
 */
function runtimePermissionArgs(declaration: ExtensionRuntimeDeclarationV2, roots: RuntimeRoots): string[] {
	const storeFiles = declaration.permissions.fs.write.includes("store");
	const read = new Set([
		roots.bootstrap,
		path.join(path.dirname(roots.bootstrap), "runtime-registration.mjs"),
		directory(roots.packageCopy),
		...readableRoots(declaration, roots),
	]);
	const write = new Set<string>(storeFiles ? [directory(roots.storeDir)] : []);
	for (const entry of declaration.permissions.fs.write)
		if (entry !== "store") write.add(directory(path.join(roots.workspace, entry)));
	if (roots.project !== undefined) {
		read.add(directory(roots.project.dir));
		if (roots.project.writable) write.add(directory(roots.project.dir));
	}
	for (const grant of roots.grants ?? []) {
		// A read grant of a file opens that file only; an absent one is opened as named, so reading it fails as missing.
		const isDirectory =
			grant.access === "write" ||
			(grant.exists && statSync(grant.canonical, { throwIfNoEntry: false })?.isDirectory() === true);
		for (const root of new Set([grant.path, grant.canonical])) {
			read.add(isDirectory ? directory(root) : root);
			if (grant.access === "write") write.add(directory(root));
		}
	}
	return [
		"--permission",
		...[...read].map((root) => `--allow-fs-read=${root}`),
		...[...write].map((root) => `--allow-fs-write=${root}`),
		...(declaration.permissions.exec ? ["--allow-child-process"] : []),
	];
}

/** The roots a runtime's own code may read beyond its package, so a store put reaches no further than it. */
function readableRoots(
	declaration: ExtensionRuntimeDeclarationV2,
	roots: Omit<RuntimeRoots, "bootstrap" | "packageCopy">,
) {
	const read = new Set(declaration.permissions.fs.write.includes("store") ? [directory(roots.storeDir)] : []);
	for (const entry of declaration.permissions.fs.read) {
		if (entry === "workspace") read.add(directory(roots.workspace));
		else if (entry === "home") read.add(directory(roots.home));
		else read.add(directory(path.isAbsolute(entry) ? entry : path.join(roots.workspace, entry)));
	}
	return [...read];
}

/** A put's source as a real path inside one of `roots`, else a refusal naming why. */
function confinedSource(sourcePath: string, workspace: string, roots: readonly string[]): string {
	let real: string;
	try {
		real = realpathSync(path.resolve(workspace, sourcePath));
	} catch {
		throw new Error(`store put source ${sourcePath} does not exist`);
	}
	const inside = roots.some((root) => {
		let base: string;
		try {
			base = directory(realpathSync(root));
		} catch {
			return false;
		}
		return real.startsWith(base);
	});
	if (!inside) throw new Error(`store put source ${sourcePath} is outside the paths this extension may read`);
	return real;
}

/** Calls to host services a runtime makes from inside a request, by kind, with the most of each in flight. */
const SERVICE_CALLS = {
	embed: 4,
	complete: RUNTIME_V2_LIMITS.completionConcurrency,
	blobs: 4,
	binaries: 2,
	pane: 2,
	runs: 8,
	worktrees: 4,
	verify: 4,
	claims: 4,
} as const;
type ServiceKind = keyof typeof SERVICE_CALLS;
const SERVICE_LABELS: Record<ServiceKind, string> = {
	embed: "embedding",
	complete: "model",
	blobs: "store",
	binaries: "binary",
	pane: "pane",
	runs: "runs",
	worktrees: "worktrees",
	verify: "verify",
	claims: "claims",
};
/** Services whose work outlives one call, so only something the operator did may reach them. */
const WORK_KINDS: ReadonlySet<string> = new Set<ExtensionWorkKind>(["runs", "worktrees", "verify", "claims"]);

interface Pending {
	kind: string;
	/** A `long` command's progress lines. */
	progress?: (text: string) => void;
	resolve(value: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

/** The most YAML text one `ctx.yaml` call parses; documents a command reads are small configuration files. */
const YAML_TEXT_BYTES = 64 * 1024;

const REPLY_FIELDS: Record<string, readonly string[]> = {
	ready: ["commands", "events", "hooks", "tools", "actions", "interviews", "rss"],
	active: [],
	result: ["id", "output"],
	error: ["id", "error"],
	fatal: ["error"],
	call: ["id", "op", "key", "value", "ifVersion", "request", "parentRequestId"],
	progress: ["id", "text"],
	unhandled: ["error"],
};

function sameNames(value: unknown, expected: readonly string[]): boolean {
	return Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

/** A service call that has not answered when its request ends still frees the child's call slot. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
	const ended = (): Error => new Error(`${label} request cancelled or timed out`);
	if (signal.aborted) {
		work.catch(() => undefined);
		return Promise.reject(ended());
	}
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(ended());
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** One api 2 runtime: a process, a private package copy and the requests in flight. No live host object crosses. */
export type RuntimeProcessState = "staging" | "starting" | "ready" | "failed" | "disposed";

export class ExtensionRuntimeProcessV2 {
	readonly instance = randomUUID();
	readonly declaration: ExtensionRuntimeDeclarationV2;
	readonly copyRoot: string;
	readonly startedAt = performance.now();
	/** What wraps the child beyond the Node flags, for `/extensions`. Set once the launch is planned. */
	readonly sandbox: ExtensionSandboxReport;
	state: RuntimeProcessState = "staging";
	failure: string | undefined;
	readyMs = 0;
	rss = 0;
	actions: readonly string[] = [];
	interviews: readonly string[] = [];
	readonly staged: Promise<void>;
	private child: ChildProcess;
	private pending = new Map<string, Pending>();
	private serviceCalls = new Map<string, { controller: AbortController; parentRequestId: string; kind: ServiceKind }>();
	/** What each command or action owns in the work services: runs and transient worktrees end with it. */
	private scopes = new Map<string, OwnedExtensionRequestScope>();
	/** In-flight scope cleanups so `dispose()` waits for runs and transient worktrees to settle. */
	private endingScopes = new Set<Promise<void>>();
	private workDisposed: Promise<void> | undefined;
	/** Where a store put may take its source from: the roots this runtime may read. */
	private sourceRoots: string[] = [];
	private sourceBase = "";
	private stageResolve!: () => void;
	private stageReject!: (error: Error) => void;
	private activeResolve: (() => void) | undefined;
	private activeReject: ((error: Error) => void) | undefined;
	private startupTimer: ReturnType<typeof setTimeout>;
	private stopPromise: Promise<void> | undefined;
	private exited: Promise<void>;
	private diagnosticBytes = 0;
	private createdRoots: string[] = [];
	private project: { root: string; dir: string; writable: boolean } | undefined;
	private createdProject: string[] = [];
	private messageWindow = Date.now();
	private messages = 0;
	private unhandled = new Set<string>();

	constructor(
		readonly extension: LoadableExtension,
		private readonly options: RuntimeProcessV2Options,
	) {
		if (!extension.runtimeV2) throw new Error("extension has no api 2 runtime");
		this.declaration = extension.runtimeV2;
		const temporary = mkdtempSync(path.join(os.tmpdir(), "pancode-extension-"));
		this.copyRoot = temporary;
		const copy = path.join(temporary, "package");
		let confined = this.declaration;
		try {
			if (options.readOnly === true) confined = readOnlyRuntimeDeclaration(this.declaration);
			// A declared write root may not reach PanCode's own installed resources, state, trust or policy,
			// and exists as a plain directory before launch so the sandbox binds exactly it.
			this.createdRoots = prepareDeclaredWriteRoots(confined, options.snapshot.workspace);
			if (this.declaration.state.project) {
				this.project = { ...extensionProjectDir(options.snapshot.workspace, extension.id), writable: !options.readOnly };
				if (this.project.writable) {
					this.createdProject = prepareProjectDir(this.project);
					// Data the runtime keeps in the project stays out of Git, as every other `.pancode/` state does.
					ensureProjectIgnore(this.project.root);
				} else {
					assertPlainProjectDir(this.project);
				}
			}
			cpSync(extension.provenance.canonicalRoot, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
			const manifestName = path.basename(extension.manifestPath);
			const verified = extensionContentDigestWithCapture(copy, { capture: [manifestName] });
			if (verified.digest !== extension.provenance.contentDigest)
				throw new Error(
					`runtime copy of ${extension.id} does not match the package digest recorded for ${extension.provenance.canonicalRoot} ` +
						`(recorded ${extension.provenance.contentDigest.slice(0, 12)}, copy ${verified.digest.slice(0, 12)}); ` +
						"the package tree changed after it was digested",
				);
			const manifestBytes = verified.captured.get(manifestName);
			if (!manifestBytes) throw new Error("verified runtime manifest bytes are absent");
			const parsed = parseExtensionManifest(
				manifestName.endsWith(".json")
					? JSON.parse(manifestBytes.toString("utf8"))
					: parseYaml(manifestBytes.toString("utf8")),
				path.join(copy, manifestName),
			);
			if (
				!parsed.manifest ||
				parsed.diagnostics.some((diagnostic) => diagnostic.type === "error") ||
				parsed.manifest.id !== extension.id ||
				JSON.stringify(parsed.manifest.runtimeV2) !== JSON.stringify(this.declaration)
			)
				throw new Error("runtime declarations differ from verified manifest bytes");
			resolveExtensionEntrypoint(copy, this.declaration.entrypoint);
			mkdirSync(options.storeDir, { recursive: true });
		} catch (error) {
			rmSync(temporary, { recursive: true, force: true });
			releaseDeclaredWriteRoots(this.createdRoots);
			releaseDeclaredWriteRoots(this.createdProject);
			throw error;
		}
		this.staged = new Promise((resolve, reject) => {
			this.stageResolve = resolve;
			this.stageReject = reject;
		});
		// A rejected stage is reported through `failure`; a caller that never awaits it must not crash the host.
		this.staged.catch(() => {});
		const bootstrap = path.join(resolvePackageRoot(), "src/domains/extensions/runtime-child-v2.mjs");
		let launch: ReturnType<typeof planExtensionLaunch>;
		try {
			launch = planExtensionLaunch({
				declaration: confined,
				roots: {
					workspace: options.snapshot.workspace,
					packageCopy: copy,
					storeDir: options.storeDir,
					bootstrap,
					...(this.project !== undefined ? { project: { dir: this.project.dir, writable: this.project.writable } } : {}),
					...(options.grants !== undefined ? { grants: options.grants } : {}),
				},
				argv: [
					process.execPath,
					...runtimePermissionArgs(confined, {
						bootstrap,
						packageCopy: copy,
						workspace: options.snapshot.workspace,
						storeDir: options.storeDir,
						home: os.homedir(),
						...(this.project !== undefined ? { project: { dir: this.project.dir, writable: this.project.writable } } : {}),
						...(options.grants !== undefined ? { grants: options.grants } : {}),
					}),
					bootstrap,
				],
				...(options.unixSockets !== undefined ? { unixSockets: options.unixSockets } : {}),
				...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
			});
		} catch (error) {
			rmSync(temporary, { recursive: true, force: true });
			releaseDeclaredWriteRoots(this.createdRoots);
			releaseDeclaredWriteRoots(this.createdProject);
			throw error;
		}
		this.sandbox = launch.report;
		this.sourceBase = options.snapshot.workspace;
		this.sourceRoots = readableRoots(confined, {
			workspace: options.snapshot.workspace,
			storeDir: options.storeDir,
			home: os.homedir(),
		});
		// The parent never forwards child stdout/stderr to a terminal or protocol stream.
		this.child = spawn(launch.file, launch.args, {
			cwd: options.snapshot.workspace,
			env: buildSafeToolEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			serialization: "json",
		});
		this.exited = new Promise((resolve) => {
			this.child.once("exit", () => {
				this.kill("SIGKILL"); // Also settle non-detached descendants after a cooperative parent exits.
				if (this.state !== "disposed") this.fail("runtime process exited");
				this.cleanCopy();
				void this.disposeWork();
				resolve();
			});
			this.child.once("error", (error) => {
				this.fail(`runtime process error: ${error.message}`);
				if (!this.child.pid) {
					this.cleanCopy();
					void this.disposeWork();
					resolve();
				}
			});
		});
		this.startupTimer = setTimeout(() => this.fail("runtime startup timed out"), RUNTIME_LIMITS.startupMs);
		this.child.on("message", (message) => this.receive(message));
		const diagnostic = (chunk: Buffer): void => {
			this.diagnosticBytes += chunk.byteLength;
			if (this.diagnosticBytes > RUNTIME_LIMITS.diagnosticsBytes) this.fail("runtime diagnostic output exceeded 64 KiB");
		};
		this.child.stdout?.on("data", diagnostic);
		this.child.stderr?.on("data", diagnostic);
		this.send({
			kind: "init",
			entrypoint: path.join(copy, this.declaration.entrypoint),
			declaration: this.declaration,
			snapshot: options.snapshot,
			options: options.options,
			...(this.declaration.permissions.fs.write.includes("store") ? { storeDir: options.storeDir } : {}),
			...(this.project !== undefined ? { projectDir: this.project.dir } : {}),
			...(options.grants !== undefined && options.grants.length > 0
				? { paths: options.grants.map(({ flag, access, path: granted }) => ({ flag, access, path: granted })) }
				: {}),
			limits: {
				completionMessages: RUNTIME_V2_LIMITS.completionMessages,
				completionRequestChars: RUNTIME_V2_LIMITS.completionRequestChars,
				blobGetBytes: RUNTIME_V2_LIMITS.blobGetBytes,
			},
		});
	}
	/** True when a declared `net: false` is refused by the OS and not merely recorded. */
	get netEnforced(): boolean {
		return this.sandbox.network === "blocked";
	}
	get pid(): number | undefined {
		return this.child.pid;
	}
	/** Settles once the process has exited and its private copy is gone. */
	get ended(): Promise<void> {
		return this.exited;
	}
	get busy(): boolean {
		return this.pending.size > 0;
	}
	private cleanCopy(): void {
		releaseDeclaredWriteRoots(this.createdRoots);
		this.createdRoots = [];
		releaseDeclaredWriteRoots(this.createdProject);
		this.createdProject = [];
		try {
			rmSync(this.copyRoot, { recursive: true, force: true });
		} catch (error) {
			this.failure = `runtime private-copy cleanup failed: ${extensionPlainText(String(error)).slice(0, 400)}`;
			this.notifyState();
		}
	}
	private notifyState(): void {
		try {
			this.options.onState?.();
		} catch {
			/* Observability cannot break process settlement. */
		}
	}
	private send(value: Record<string, unknown>): void {
		if (!this.child.connected) return;
		this.child.send({ protocol: 2, instance: this.instance, ...value }, (error) => {
			if (error) this.fail(`runtime IPC failed: ${error.message}`);
		});
	}
	private kill(signal: NodeJS.Signals): void {
		if (this.child.pid && process.platform !== "win32") {
			try {
				process.kill(-this.child.pid, signal);
				return;
			} catch {
				/* Direct-child fallback. */
			}
		}
		this.child.kill(signal);
	}
	private fail(reason: string): void {
		if (this.state === "disposed" || this.state === "failed") return;
		this.failure = extensionPlainText(reason).slice(0, 512);
		this.state = "failed";
		clearTimeout(this.startupTimer);
		const error = new Error(this.failure);
		this.stageReject(error);
		this.activeReject?.(error);
		this.rejectAll(error);
		this.notifyState();
		this.kill("SIGKILL");
	}
	private endScope(scope: OwnedExtensionRequestScope): Promise<void> {
		const task = scope.end().catch(() => undefined);
		this.endingScopes.add(task);
		void task.finally(() => this.endingScopes.delete(task));
		return task;
	}
	private disposeWork(): Promise<void> {
		this.workDisposed ??= (this.options.disposeWork?.() ?? Promise.resolve()).catch(() => undefined);
		return this.workDisposed;
	}
	private rejectAll(error: Error): void {
		for (const call of this.serviceCalls.values()) call.controller.abort();
		for (const scope of this.scopes.values()) void this.endScope(scope);
		this.scopes.clear();
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) {
			entry.cleanup();
			entry.reject(error);
		}
	}
	private settle(id: unknown): { pending: Pending; cleanup?: Promise<void> } | undefined {
		if (typeof id !== "string") return undefined;
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		pending.cleanup();
		// A service call outliving its request must still answer, or the child's call slot never frees.
		for (const call of this.serviceCalls.values()) if (call.parentRequestId === id) call.controller.abort();
		const scope = this.scopes.get(id);
		if (scope) {
			this.scopes.delete(id);
			return { pending, cleanup: this.endScope(scope) };
		}
		return { pending };
	}
	/**
	 * One call to a consent-gated host service. It needs a live parent request and ends with it, and the
	 * request is checked here again whatever the child checked.
	 */
	private async serveService(
		kind: ServiceKind,
		m: Record<string, unknown>,
		reply: (body: Record<string, unknown>) => void,
	): Promise<void> {
		const label = SERVICE_LABELS[kind];
		if (typeof m.id !== "string" || typeof m.parentRequestId !== "string" || !this.pending.has(m.parentRequestId))
			throw new Error(`${label} call has no active parent request`);
		if (this.serviceCalls.has(m.id)) throw new Error(`duplicate ${label} call id`);
		if ([...this.serviceCalls.values()].filter((call) => call.kind === kind).length >= SERVICE_CALLS[kind])
			throw new Error(`${label} service is busy`);
		const services = this.declaration.services;
		let run: (signal: AbortSignal) => Promise<unknown>;
		let timeoutMs: number | null = 30_000;
		if (WORK_KINDS.has(kind)) {
			const parentRequestId = m.parentRequestId;
			const parent = this.pending.get(parentRequestId);
			if (parent?.kind !== "command" && parent?.kind !== "action")
				throw new Error(`${label} is reachable only from a command or an action`);
			const serve = this.options.work?.[kind as ExtensionWorkKind];
			if (services?.[kind as ExtensionWorkKind] === undefined || !serve)
				throw new Error(`${label} service is not declared or available`);
			const request = m.request;
			if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error(`invalid ${label} request`);
			let scope = this.scopes.get(parentRequestId);
			if (!scope) {
				scope = createExtensionRequestScope();
				this.scopes.set(parentRequestId, scope);
			}
			const owned = scope;
			// A wait or a check takes as long as it takes; the command's own deadline bounds it.
			timeoutMs = null;
			run = () => serve(request as Record<string, unknown>, owned);
		} else if (kind === "embed") {
			const embed = this.options.embed;
			if (!services?.embedding || !embed) throw new Error("embedding service is not declared or available");
			const request = m.request;
			if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid embedding request");
			const typed = request as Record<string, unknown>;
			if (
				(typed.task !== "query" && typed.task !== "document") ||
				!Array.isArray(typed.inputs) ||
				typed.inputs.length < 1 ||
				typed.inputs.length > 8 ||
				(typed.expectedProfileIdentity !== undefined && typeof typed.expectedProfileIdentity !== "string")
			)
				throw new Error("invalid embedding request");
			run = (signal) => embed(typed as unknown as ExtensionEmbeddingRequest, signal);
		} else if (kind === "complete") {
			const complete = this.options.complete;
			if (!services?.model || !complete) throw new Error("model service is not declared or available");
			const request = parseExtensionCompletionRequest(m.request, services.model);
			// A completion ends with its parent request; this only stops one nobody is waiting on.
			timeoutMs = RUNTIME_V2_LIMITS.toolMsMax;
			run = async (signal) => parseExtensionCompletion(await complete(request, signal));
		} else if (kind === "binaries") {
			const binaries = this.options.binaries;
			const declared = this.declaration.binaries ?? [];
			if (declared.length === 0 || !binaries) throw new Error("binaries are not declared or this host does not run them");
			const request = parsePackBinaryRun(m.request, declared);
			const parent = this.pending.get(m.parentRequestId)?.kind ?? "";
			timeoutMs = request.timeoutMs + 1000;
			run = (signal) => binaries(request, signal, parent);
		} else if (kind === "pane") {
			const pane = this.options.pane;
			if (!services?.pane || !pane) throw new Error("pane: this session has no pane host; run PanCode inside herdr");
			const request = m.request;
			if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid pane request");
			const { op, ...payload } = request as Record<string, unknown>;
			if (typeof op !== "string") throw new Error("invalid pane request");
			const parent = this.pending.get(m.parentRequestId)?.kind ?? "";
			run = () => pane(op, payload, parent);
		} else {
			const blobs = this.options.blobs;
			if (!services?.store || !blobs) throw new Error("store service is not declared or available");
			const request = parseExtensionBlobRequest(m.request, services.store);
			const confined =
				request.op === "put"
					? {
							...request,
							sourcePath: confinedSource(request.sourcePath, this.sourceBase, this.sourceRoots),
						}
					: request;
			run = (signal) => blobs(confined, signal);
		}
		const controller = new AbortController();
		this.serviceCalls.set(m.id, { controller, parentRequestId: m.parentRequestId, kind });
		const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
		try {
			const work = run(controller.signal);
			const value = await (WORK_KINDS.has(kind) ? abortable(work, controller.signal, label) : work);
			if (controller.signal.aborted) throw new Error(`${label} request cancelled or timed out`);
			reply({ value });
		} finally {
			clearTimeout(timer);
			this.serviceCalls.delete(m.id);
		}
	}
	/** State and store live here, so a reload swaps the process and loses nothing. */
	private async serveCall(m: Record<string, unknown>): Promise<void> {
		const reply = (body: Record<string, unknown>): void => this.send({ kind: "returned", id: m.id, ...body });
		try {
			if (typeof m.op === "string" && Object.hasOwn(SERVICE_CALLS, m.op)) {
				await this.serveService(m.op as ServiceKind, m, reply);
				return;
			}
			if (m.op === "yaml") {
				const parent = typeof m.parentRequestId === "string" ? this.pending.get(m.parentRequestId)?.kind : undefined;
				if (parent !== "command" && parent !== "action") throw new Error("yaml call has no active command or action");
				if (typeof m.value !== "string") throw new Error("yaml takes text");
				if (Buffer.byteLength(m.value) > YAML_TEXT_BYTES)
					throw new Error(`yaml text exceeds ${YAML_TEXT_BYTES / 1024} KiB`);
				// Plain data only: the reply crosses IPC as JSON, which also drops any anchor aliasing.
				reply({ value: parseYaml(m.value) ?? null });
				return;
			}
			const [scope, verb] = String(m.op).split(".");
			if ((scope !== "state" && scope !== "store") || typeof m.id !== "string") throw new Error("unsupported host call");
			if (!(scope === "state" ? this.declaration.state.session : this.declaration.state.store))
				throw new Error(`runtime did not declare ${scope}`);
			const host = this.options.keyValue;
			if (verb === "keys") {
				reply({ value: host.keys(scope) });
				return;
			}
			if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > 200) throw new Error("invalid key");
			if (verb === "get") reply({ value: host.get(scope, m.key) });
			else if (verb === "delete") {
				host.delete(scope, m.key);
				reply({ value: null });
			} else if (verb === "set") {
				if (m.ifVersion !== undefined && !Number.isInteger(m.ifVersion)) throw new Error("invalid version");
				reply({ value: host.set(scope, m.key, m.value, m.ifVersion as number | undefined) });
			} else throw new Error("unsupported host call");
		} catch (error) {
			reply({ error: extensionPlainText(error instanceof Error ? error.message : String(error)).slice(0, 512) });
		}
	}
	/** A command's answer, which alone may use `commandMessageBytes`, since it reaches only the operator. */
	private answersCommand(value: unknown): boolean {
		const m = value as { kind?: unknown; id?: unknown } | null;
		return m?.kind === "result" && typeof m.id === "string" && this.pending.get(m.id)?.kind === "command";
	}
	private receive(value: unknown): void {
		if (this.state === "disposed" || this.state === "failed") return;
		try {
			if (Date.now() - this.messageWindow > 1000) {
				this.messageWindow = Date.now();
				this.messages = 0;
			}
			if (++this.messages > RUNTIME_V2_LIMITS.messagesPerSecond) throw new Error("runtime IPC rate exceeded");
			const bytes = Buffer.byteLength(JSON.stringify(value));
			if (
				bytes > RUNTIME_V2_LIMITS.messageBytes &&
				!(bytes <= RUNTIME_V2_LIMITS.commandMessageBytes && this.answersCommand(value))
			)
				throw new Error("runtime IPC message too large");
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid runtime IPC message");
			const m = value as Record<string, unknown>;
			const fields = typeof m.kind === "string" ? REPLY_FIELDS[m.kind] : undefined;
			if (!fields || Object.keys(m).some((key) => !["protocol", "instance", "kind", ...fields].includes(key)))
				throw new Error("invalid runtime protocol fields");
			if (m.protocol !== 2 || m.instance !== this.instance) throw new Error("runtime protocol or instance mismatch");
			if (m.kind === "fatal") throw new Error(typeof m.error === "string" ? m.error : "runtime fatal error");
			if (m.kind === "ready" && this.state === "staging") {
				const declared = this.declaration;
				const events = [...declared.events, ...(declared.tickMs !== undefined ? ["tick"] : [])];
				if (
					!sameNames(
						m.commands,
						declared.commands.map((command) => command.name),
					) ||
					!sameNames(m.events, events) ||
					!sameNames(m.hooks, [...new Set(declared.hooks.map((hook) => hook.on))]) ||
					!sameNames(
						m.tools,
						declared.tools.map((tool) => tool.name),
					)
				)
					throw new Error("runtime registration inventory mismatch");
				if (
					!Array.isArray(m.actions) ||
					!Array.isArray(m.interviews) ||
					[...m.actions, ...m.interviews].some((name) => typeof name !== "string")
				)
					throw new Error("invalid runtime registration inventory");
				if (typeof m.rss !== "number" || !Number.isFinite(m.rss) || m.rss < 0)
					throw new Error("invalid runtime memory observation");
				this.actions = m.actions as string[];
				this.interviews = m.interviews as string[];
				this.rss = m.rss;
				this.readyMs = performance.now() - this.startedAt;
				this.state = "starting";
				clearTimeout(this.startupTimer);
				this.stageResolve();
				return;
			}
			if (m.kind === "active" && this.state === "starting" && this.activeResolve) {
				this.state = "ready";
				clearTimeout(this.startupTimer);
				this.activeResolve();
				this.activeResolve = undefined;
				this.activeReject = undefined;
				this.notifyState();
				return;
			}
			if (this.state !== "ready") throw new Error("unexpected runtime IPC message");
			if (m.kind === "call") {
				void this.serveCall(m);
				return;
			}
			if (m.kind === "unhandled") {
				if (typeof m.error !== "string") throw new Error("invalid runtime unhandled report");
				const error = extensionPlainText(m.error).replace(/\s+/gu, " ").trim().slice(0, 512) || "unknown error";
				if (this.unhandled.has(error) || this.unhandled.size >= 32) return;
				this.unhandled.add(error);
				try {
					this.options.onUnhandled?.(error);
				} catch {
					/* A diagnostic sink has no runtime authority. */
				}
				return;
			}
			if (m.kind === "progress") {
				if (typeof m.text !== "string" || m.text.length > 200) throw new Error("invalid runtime progress line");
				// A line for a request that already ended, or one that reports none, is dropped like a late reply.
				if (typeof m.id === "string") this.pending.get(m.id)?.progress?.(extensionPlainText(m.text));
				return;
			}
			if (m.kind !== "result" && m.kind !== "error") throw new Error("unexpected runtime IPC message");
			// A reply without its outstanding request has no authority: it was cancelled or timed out.
			const settled = this.settle(m.id);
			if (!settled) return;
			const finish = (): void => {
				if (m.kind === "error")
					settled.pending.reject(
						new Error(extensionPlainText(typeof m.error === "string" ? m.error : "handler failed").slice(0, 512)),
					);
				else settled.pending.resolve(m.output);
			};
			// Wait for the request's transient worktrees and runs to end before handing the result to the caller.
			if (settled.cleanup) void settled.cleanup.then(finish);
			else finish();
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}
	async activate(): Promise<void> {
		await this.staged;
		if (this.state !== "starting") throw new Error(this.failure ?? "runtime is not staged");
		return new Promise((resolve, reject) => {
			this.activeResolve = resolve;
			this.activeReject = reject;
			this.startupTimer = setTimeout(() => this.fail("runtime activation timed out"), RUNTIME_LIMITS.startupMs);
			this.send({ kind: "activate" });
		});
	}
	/** The active workspace and generation change without a restart; handlers read the latest on their next request. */
	updateSnapshot(snapshot: ExtensionRuntimeSnapshotV2): void {
		if (this.state === "ready") this.send({ kind: "snapshot", snapshot });
	}
	private request<T>(
		message: Record<string, unknown> & { kind: string },
		timeoutMs: number,
		parse: (output: unknown) => T,
		signal?: AbortSignal,
		progress?: (text: string) => void,
		interrupt?: AbortSignal,
	): Promise<T> {
		if (this.state !== "ready") return Promise.reject(new Error(this.failure ?? "runtime not ready"));
		if (this.pending.size >= RUNTIME_V2_LIMITS.concurrentRequests) return Promise.reject(new Error("runtime is busy"));
		if (signal?.aborted) return Promise.reject(new Error(`extension ${message.kind} cancelled`));
		return new Promise<T>((resolve, reject) => {
			const id = randomUUID();
			const abandon = (error: Error): void => {
				const settled = this.settle(id);
				if (!settled) return;
				this.send({ kind: "cancel", id });
				if (settled.cleanup) void settled.cleanup.then(() => reject(error));
				else reject(error);
			};
			const cancel = (): void => abandon(new Error(`extension ${message.kind} cancelled`));
			// An interrupt aborts the handler's `ctx.signal` and waits for the answer it still owes.
			const stop = (): void => {
				if (this.pending.has(id)) this.send({ kind: "interrupt", id });
			};
			const timer = setTimeout(() => abandon(new ExtensionRequestTimeout(message.kind)), timeoutMs);
			this.pending.set(id, {
				kind: message.kind,
				...(progress !== undefined ? { progress } : {}),
				resolve: (output) => {
					// A handler that answers outside its contract fails that answer, not the runtime.
					// The parse error echoes keys and kinds the extension chose, so it is cleaned like the child's own errors.
					try {
						resolve(parse(output));
					} catch (error) {
						reject(new Error(extensionPlainText(error instanceof Error ? error.message : String(error)).slice(0, 512)));
					}
				},
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
					interrupt?.removeEventListener("abort", stop);
				},
			});
			signal?.addEventListener("abort", cancel, { once: true });
			this.send({ ...message, id });
			if (interrupt?.aborted) stop();
			else interrupt?.addEventListener("abort", stop, { once: true });
		});
	}
	private output(origin: OutputOrigin): (value: unknown) => ExtensionOutputV2 {
		return (value) => parseExtensionOutputV2(value, this.declaration, origin);
	}
	/**
	 * `progress` hears a `long` command's `ctx.progress` lines; any other command reports none. `argv` reaches the
	 * handler as `ctx.argv`; `interrupt` aborts its `ctx.signal` while the answer is still awaited.
	 */
	command(
		name: string,
		args: string,
		signal?: AbortSignal,
		progress?: (text: string) => void,
		options: { argv?: ReadonlyArray<string>; interrupt?: AbortSignal } = {},
	): Promise<ExtensionOutputV2> {
		const declared = this.declaration.commands.find((command) => command.name === name);
		if (!declared) return Promise.reject(new Error(`runtime declares no command '${name}'`));
		return this.request(
			{ kind: "command", name, args, ...(options.argv !== undefined ? { argv: [...options.argv] } : {}) },
			declared.timeoutMs,
			this.output("command"),
			signal,
			declared.long ? progress : undefined,
			options.interrupt,
		);
	}
	observe(event: ExtensionObservationV2): Promise<ExtensionOutputV2 | undefined> {
		return this.request({ kind: "observe", event }, RUNTIME_V2_LIMITS.observationMs, (value) =>
			value === null || value === undefined ? undefined : this.output("observation")(value),
		);
	}
	hook(event: ExtensionHookEvent, timeoutMs: number, signal?: AbortSignal): Promise<ExtensionHookResult> {
		return this.request(
			{ kind: "hook", event },
			timeoutMs,
			(value) =>
				parseExtensionHookResult(value, this.declaration, event.point, this.extension.id, {
					isBuiltinTool: (name) => isBuiltinToolName(name as ToolName),
				}),
			signal,
		);
	}
	tool(name: string, input: unknown, signal?: AbortSignal): Promise<ExtensionToolResult> {
		const declared = this.declaration.tools.find((tool) => tool.name === name);
		if (!declared) return Promise.reject(new Error(`runtime declares no tool '${name}'`));
		return this.request(
			{ kind: "tool", name, input },
			declared.timeoutMs,
			(value) => parseExtensionToolResult(value, this.declaration),
			signal,
		);
	}
	action(event: ExtensionUiAction): Promise<ExtensionOutputV2> {
		if (!this.actions.includes(event.id)) return Promise.reject(new Error(`runtime registered no action '${event.id}'`));
		return this.request(
			{ kind: "action", name: event.id, event },
			RUNTIME_V2_LIMITS.observationMs,
			this.output("action"),
		);
	}
	/** One step of an interview this runtime started; the operator may take as long as they need, the handler may not. */
	interview(answer: InterviewAnswer, signal?: AbortSignal): Promise<InterviewNext> {
		if (!this.interviews.includes(answer.id))
			return Promise.reject(new Error(`runtime registered no interview '${answer.id}'`));
		return this.request(
			{ kind: "interview", name: answer.id, event: answer },
			RUNTIME_V2_LIMITS.observationMs,
			(value) => parseInterviewNext(value, this.declaration),
			signal,
		);
	}
	dispose(reason = "disposed"): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.state = "disposed";
		clearTimeout(this.startupTimer);
		const error = new Error(`runtime disposed: ${reason}`);
		this.stageReject(error);
		this.activeReject?.(error);
		this.rejectAll(error);
		this.notifyState();
		this.send({ kind: "dispose", reason });
		this.stopPromise = (async () => {
			const timer = setTimeout(() => this.kill("SIGKILL"), RUNTIME_LIMITS.disposeMs);
			await this.exited;
			clearTimeout(timer);
			await Promise.allSettled([...this.endingScopes]);
			await this.disposeWork();
		})();
		return this.stopPromise;
	}
}
