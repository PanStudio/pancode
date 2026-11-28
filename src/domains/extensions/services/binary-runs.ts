// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One call to an extension's pinned program, through `ctx.binaries` or `ctx.pane`: who may ask, read on every call,
 * and the record each run or refusal leaves. Only a command, an action or an admitted tool call may start a program,
 * never in a read-only turn.
 */
import type { ExtensionBinaryDeclaration } from "@pancode/sdk/pack";
import { recordPackageActivity } from "../../../core/package-activity.js";
import type { PackageIdentity } from "../../../core/package-identity.js";
import { runCommandVector } from "../../../core/safe-exec.js";
import { ownerTelemetryContext } from "../../../core/telemetry/context.js";
import { telemetryHub } from "../../../core/telemetry/hub.js";
import { isSecretArgKey, redactSecretString } from "../../../lib/secrets/redaction.js";
import { BINARY_RUN_LIMITS, type PackBinaryRunRequest, packBinaryPath, packBinarySha256 } from "./binaries.js";

export interface PackBinaryRunResult {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

function capText(text: string): string {
	return Buffer.byteLength(text) > BINARY_RUN_LIMITS.outputBytes
		? Buffer.from(text).subarray(0, BINARY_RUN_LIMITS.outputBytes).toString("utf8")
		: text;
}

/** The requests that may start a program: what the operator typed or pressed, and a tool call admission passed. */
const BINARY_PARENTS: ReadonlySet<string> = new Set(["command", "action", "tool"]);
const KNOWN_PARENTS = new Set(["command", "action", "tool", "observe", "hook", "interview"] as const);
type BinaryParentKind = "command" | "action" | "tool" | "observe" | "hook" | "interview" | "unknown";
const PARENT_LABELS: Readonly<Record<string, string>> = {
	observe: "an event or timer handler",
	hook: "a hook",
	interview: "an interview step",
	unknown: "an unknown request",
};
const SHOWN_ARGS = 16;
const SHOWN_ARG_CHARS = 200;

function normalizeParent(parent: string): BinaryParentKind {
	return KNOWN_PARENTS.has(parent as Exclude<BinaryParentKind, "unknown">)
		? (parent as Exclude<BinaryParentKind, "unknown">)
		: "unknown";
}

export type PackBinaryRefusalCode = "background-request" | "read-only" | "not-installed";

/** Who asks for a program, read when the call arrives: the request it serves and whether this turn is read-only. */
export interface PackBinaryCaller {
	owner: PackageIdentity;
	sessionId: string | null;
	/** The kind of runtime request the call belongs to. */
	parent: string;
	readOnly: boolean;
}

/** Why `ctx.binaries` or `ctx.pane` may not act for this request, or null. */
function packBinaryRefusal(
	service: "binaries" | "pane",
	caller: Pick<PackBinaryCaller, "parent" | "readOnly">,
): { code: PackBinaryRefusalCode; reason: string } | null {
	const parent = normalizeParent(caller.parent);
	if (!BINARY_PARENTS.has(parent))
		return {
			code: "background-request",
			reason: `ctx.${service} runs only from a command, an action or a tool call, not from ${PARENT_LABELS[parent] ?? `a ${parent} request`}`,
		};
	if (caller.readOnly) return { code: "read-only", reason: `ctx.${service} is refused in a read-only turn` };
	return null;
}

/** Arguments as the activity ledger keeps them: at most 16, each clipped, credentials and a secret flag's value redacted. */
function shownArgs(args: ReadonlyArray<string>): string[] {
	const shown = args.slice(0, SHOWN_ARGS).map((arg, index) => {
		const flag = index > 0 ? args[index - 1] : undefined;
		if (flag !== undefined && /^--?[A-Za-z][\w-]*$/u.test(flag) && isSecretArgKey(flag)) return "[redacted]";
		const clean = redactSecretString(arg);
		return clean.length > SHOWN_ARG_CHARS ? `${clean.slice(0, SHOWN_ARG_CHARS)}…` : clean;
	});
	return args.length > SHOWN_ARGS ? [...shown, `(${args.length - SHOWN_ARGS} more)`] : shown;
}

interface PackBinaryOutcome {
	outcome: "ok" | "failed" | "timeout" | "refused";
	reasonCode?: PackBinaryRefusalCode | undefined;
	reason?: string;
	exitCode?: number | null;
	durationMs?: number;
}

/**
 * Journals one run of a pinned program or its refusal, content-free, and puts its arguments, clipped and redacted,
 * in the extension's activity. Observability never fails the run it describes.
 */
function recordPackBinaryRun(
	caller: PackBinaryCaller,
	binary: ExtensionBinaryDeclaration,
	via: "run" | "pane",
	args: ReadonlyArray<string>,
	result: PackBinaryOutcome,
): void {
	const sha256 = packBinarySha256(binary);
	const parent = normalizeParent(caller.parent);
	const { owner } = caller;
	try {
		telemetryHub().emit(
			"extension.binary_ran",
			{
				extension: {
					id: owner.id,
					version: owner.version,
					scope: owner.scope ?? "user",
					...(owner.digest ? { contentDigest: owner.digest } : {}),
				},
				binary: binary.name,
				version: binary.version,
				...(sha256 !== undefined ? { sha256 } : {}),
				via,
				parent,
				outcome: result.outcome,
				...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
				...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
				argCount: args.length,
				...(result.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(result.durationMs)) } : {}),
			},
			ownerTelemetryContext({ sessionId: caller.sessionId }),
		);
	} catch {
		// The journal has no authority over the run.
	}
	recordPackageActivity({
		owner,
		kind: via === "pane" ? "binary:pane" : "binary:run",
		outcome: result.outcome,
		...(caller.sessionId !== null ? { sessionId: caller.sessionId } : {}),
		details: {
			binary: binary.name,
			version: binary.version,
			parent,
			args: shownArgs(args),
			...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
			...(result.durationMs !== undefined ? { durationMs: Math.round(result.durationMs) } : {}),
			...(result.reason !== undefined ? { reason: result.reason } : {}),
		},
	});
}

/** The pinned copy's path for this caller, or the refusal it journaled and throws. */
function admitPackBinary(
	extensionId: string,
	binary: ExtensionBinaryDeclaration,
	via: "run" | "pane",
	args: ReadonlyArray<string>,
	caller: PackBinaryCaller,
): string {
	const callerRefusal = packBinaryRefusal(via === "pane" ? "pane" : "binaries", caller);
	if (callerRefusal !== null) {
		recordPackBinaryRun(caller, binary, via, args, {
			outcome: "refused",
			reasonCode: callerRefusal.code,
			reason: callerRefusal.reason,
		});
		throw new Error(callerRefusal.reason);
	}
	const resolved = packBinaryPath(extensionId, binary);
	if ("reason" in resolved) {
		recordPackBinaryRun(caller, binary, via, args, {
			outcome: "refused",
			reasonCode: "not-installed",
			reason: resolved.reason,
		});
		throw new Error(resolved.reason);
	}
	return resolved.path;
}

/**
 * Runs a declared binary once, in the extension's store directory, with the
 * host's safe tool environment plus the declared keys. No shell is involved.
 * The caller is checked first, on every call, and the run or its refusal is journaled.
 */
export async function runPackBinary(
	extensionId: string,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
	request: PackBinaryRunRequest,
	storeDir: string,
	caller: PackBinaryCaller,
	signal?: AbortSignal,
): Promise<PackBinaryRunResult> {
	const binary = binaries.find((entry) => entry.name === request.name);
	if (!binary) throw new Error(`binary '${request.name}' is not declared`);
	const binaryPath = admitPackBinary(extensionId, binary, "run", request.args, caller);
	const started = performance.now();
	let result: Awaited<ReturnType<typeof runCommandVector>>;
	try {
		result = await runCommandVector(binaryPath, request.args, {
			cwd: storeDir,
			workspaceRoot: storeDir,
			env: request.env,
			timeoutMs: request.timeoutMs,
			maxOutputBytes: BINARY_RUN_LIMITS.outputBytes * 2,
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		recordPackBinaryRun(caller, binary, "run", request.args, {
			outcome: "failed",
			durationMs: performance.now() - started,
			reason: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
	recordPackBinaryRun(caller, binary, "run", request.args, {
		outcome: result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "failed",
		exitCode: result.exitCode,
		durationMs: performance.now() - started,
	});
	return {
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		stdout: capText(result.stdout),
		stderr: capText(result.stderr),
	};
}

/**
 * One `ctx.pane` call for this caller. Every op is checked against the caller; an `open`, which starts the pinned
 * program in the pane, is journaled with its outcome, as is any refusal.
 */
export async function servePackPane(
	extensionId: string,
	binaries: ReadonlyArray<ExtensionBinaryDeclaration>,
	op: string,
	payload: unknown,
	caller: PackBinaryCaller,
	call: () => Promise<unknown>,
): Promise<unknown> {
	const raw = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
	const binary = op === "open" ? binaries.find((entry) => entry.name === raw.binary) : undefined;
	if (binary === undefined) {
		const refusal = packBinaryRefusal("pane", caller);
		if (refusal) throw new Error(refusal.reason);
		return call();
	}
	const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
	admitPackBinary(extensionId, binary, "pane", args, caller);
	const started = performance.now();
	try {
		const state = await call();
		recordPackBinaryRun(caller, binary, "pane", args, { outcome: "ok", durationMs: performance.now() - started });
		return state;
	} catch (error) {
		recordPackBinaryRun(caller, binary, "pane", args, {
			outcome: "failed",
			durationMs: performance.now() - started,
			reason: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
