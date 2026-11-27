// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `services.verify`: the project's declared checks, listed and run for an extension as `verify` runs them, in the
 * workspace or in one of the extension's worktrees, always under the sandbox host verification uses. Each result is
 * kept host-side behind a receipt, so `services.claims` records only what PanCode itself judged.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExtensionCheck, ExtensionCheckResult, ExtensionWorkPlace } from "@pancode/sdk/extension";
import type { PancodeSettings } from "../../../core/config.js";
import { runCommandVector } from "../../../core/safe-exec.js";
import type { ToolResult } from "../../../tools/tool-spec.js";
import {
	type DeclaredCheck,
	loadProjectVerifierCatalog,
	resolveProjectVerifierExecutionCwd,
} from "../../../tools/verify/catalog.js";
import { extractNumericPayloadText, parseNumericPayload } from "../../../tools/verify/numeric.js";
import { resolveVerifyCall, sweepRunNames } from "../../../tools/verify/resolve.js";
import { JUDGED_CHECK_MAX_OUTPUT_BYTES, runProjectCheck } from "../../../tools/verify/scripts.js";
import { hostVerificationSandbox } from "../../dispatch/host-verification.js";
import { type PancodeLaunch, type RunEnvPolicy, runEnv } from "./run-env.js";
import type { ExtensionRequestScope } from "./scope.js";

/** A check result the host keeps for `services.claims`. */
export interface ExtensionCheckReceipt {
	check: string;
	result: ToolResult;
	/** The checkout the check ran in; claim paths are relative to it. */
	checkout: string;
	at: string;
}

export interface ExtensionCheckReceipts {
	put(receipt: ExtensionCheckReceipt): string;
	get(id: string): ExtensionCheckReceipt | undefined;
}

/** The newest `max` receipts; an older one is forgotten. */
export function createExtensionCheckReceipts(max = 256): ExtensionCheckReceipts {
	const receipts = new Map<string, ExtensionCheckReceipt>();
	return {
		put(receipt) {
			const id = randomUUID();
			receipts.set(id, receipt);
			while (receipts.size > max) receipts.delete(receipts.keys().next().value as string);
			return id;
		},
		get: (id) => receipts.get(id),
	};
}

export interface ExtensionVerifyServiceDeps {
	settings(): Readonly<Pick<PancodeSettings, "safety" | "targets">> | undefined;
	resolvePlace(place: ExtensionWorkPlace): Promise<{ cwd: string; root: string }>;
	receipts: ExtensionCheckReceipts;
	/** For a derived check, which runs through `pancode verifiers dry-run` in the place. */
	launch: PancodeLaunch;
	sourceEnv: Readonly<Record<string, string>>;
	envPolicy: RunEnvPolicy;
}

export interface ExtensionVerifyService {
	list(place?: ExtensionWorkPlace): Promise<ExtensionCheck[]>;
	check(id: string, place?: ExtensionWorkPlace, scope?: ExtensionRequestScope): Promise<ExtensionCheckResult>;
	measure(
		id: string,
		metric: string,
		place?: ExtensionWorkPlace,
		scope?: ExtensionRequestScope,
	): Promise<{ ok: true; value: number } | { ok: false; reason: string }>;
}

const TEXT_TAIL_CHARS = 64 * 1024;
/** A derived check through `verifiers dry-run`: its own timeout plus the CLI's start. */
const DRY_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Paths a declared check names, relative to the project: each argv entry (from the check's cwd, and as written), the
 * reference and baseline files, and a reproduce check's pinned inputs. A sweep run's directory is on the argv.
 */
export function pathsNamedByCheck(check: DeclaredCheck): string[] {
	const base = check.cwd === "." ? "" : check.cwd;
	const named = new Set<string>();
	const add = (path: string): void => {
		const normalized = posix.normalize(path);
		if (normalized === "." || normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) return;
		named.add(normalized);
	};
	for (const arg of check.command) {
		if (arg.length === 0 || arg.startsWith("-") || arg.includes("\0")) continue;
		add(posix.join(base, arg));
		add(arg);
	}
	if (check.numeric?.reference !== undefined) add(check.numeric.reference);
	for (const input of check.numeric?.inputs ?? []) add(input);
	if (check.perf?.baseline !== undefined) add(check.perf.baseline);
	for (const pin of check.reproduce?.inputs ?? []) add(pin.path);
	if (check.reproduce?.compare.mode === "reference") add(check.reproduce.compare.reference);
	return [...named].sort();
}

function judgementOf(result: ToolResult): { execution: string; validation: string | null } {
	const judgement = (result.details as { judgement?: { execution?: unknown; validation?: unknown } } | undefined)
		?.judgement;
	return {
		execution:
			typeof judgement?.execution === "string" ? judgement.execution : result.kind === "ok" ? "succeeded" : "failed",
		validation: typeof judgement?.validation === "string" ? judgement.validation : null,
	};
}

function resultText(result: ToolResult): string {
	const text = result.kind === "ok" ? result.output : result.message;
	return text.length > TEXT_TAIL_CHARS ? text.slice(-TEXT_TAIL_CHARS) : text;
}

function exitCodeOf(result: ToolResult): number | null {
	const code = (result.details as { exitCode?: unknown } | undefined)?.exitCode;
	if (typeof code === "number" || code === null) return code;
	return result.kind === "ok" ? 0 : null;
}

function checkId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("-"))
		throw new Error("verify: a check id is a non-empty name");
	return value;
}

/** Read `metric` from a check's stdout; a perf-budget check's `wall_ms` falls back to the measured duration. */
function objectiveFromOutput(
	check: Pick<DeclaredCheck, "kind">,
	metric: string,
	stdout: string,
	durationMs: number,
): { ok: true; value: number } | { ok: false; reason: string } {
	const payload = parseNumericPayload(extractNumericPayloadText(stdout), "objective output");
	if (!(payload instanceof Error)) {
		const value = payload[metric];
		if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
		if (value !== undefined) return { ok: false, reason: `'${metric}' is not one finite number` };
	}
	if (check.kind === "perf-budget" && metric === "wall_ms") return { ok: true, value: durationMs };
	return {
		ok: false,
		reason:
			payload instanceof Error
				? payload.message
				: `the payload has no '${metric}' key (${Object.keys(payload).join(", ")})`,
	};
}

function lastJsonLine(stdout: string): { ok?: unknown; output?: unknown; error?: unknown } | null {
	try {
		const value: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
		return typeof value === "object" && value !== null ? value : null;
	} catch {
		return null;
	}
}

export function createExtensionVerifyService(deps: ExtensionVerifyServiceDeps): ExtensionVerifyService {
	const sandbox = (root: string) => hostVerificationSandbox(deps.settings(), root);

	const dryRun = async (id: string, cwd: string, signal?: AbortSignal): Promise<ToolResult> => {
		const result = await runCommandVector(deps.launch.file, [...deps.launch.args, "verifiers", "dry-run", id, "--json"], {
			cwd,
			workspaceRoot: cwd,
			env: { ...runEnv(deps.sourceEnv, deps.envPolicy, null), ...deps.launch.env },
			timeoutMs: DRY_RUN_TIMEOUT_MS,
			...(signal !== undefined ? { signal } : {}),
		});
		const parsed = lastJsonLine(result.stdout);
		if (parsed?.ok === true && typeof parsed.output === "string")
			return { kind: "ok", output: parsed.output, details: { exitCode: result.exitCode } };
		const message =
			typeof parsed?.error === "string"
				? parsed.error
				: `${result.stdout}${result.stderr}`.trim() || `dry-run exited with ${result.exitCode ?? "a signal"}`;
		return {
			kind: "error",
			message,
			details: {
				exitCode: result.exitCode,
				...(result.timedOut ? { judgement: { execution: "timed-out", validation: "not-run" } } : {}),
			},
		};
	};

	return {
		async list(place = "workspace") {
			const { cwd } = await deps.resolvePlace(place);
			const loaded = loadProjectVerifierCatalog(cwd);
			if (!loaded.ok) throw new Error(`verify: ${loaded.reason}`);
			return (loaded.source?.checks ?? []).map((check) => {
				const runs = check.runs === undefined ? undefined : sweepRunNames(cwd, check);
				return {
					id: check.id,
					kind: check.kind,
					command: [...check.command],
					cwd: check.cwd,
					timeoutMs: check.timeoutMs,
					...(runs !== undefined ? { runs } : {}),
					inputs: pathsNamedByCheck(check),
				};
			});
		},

		async check(id, place = "workspace", scope) {
			const name = checkId(id);
			const { cwd, root } = await deps.resolvePlace(place);
			const signal = scope?.signal;
			const started = Date.now();
			const resolution = resolveVerifyCall(cwd, { check: name });
			let result: ToolResult;
			switch (resolution.kind) {
				case "catalog": {
					const shellSandbox = sandbox(cwd);
					result = await runProjectCheck(resolution.check, {
						workspaceRoot: cwd,
						...(signal !== undefined ? { signal } : {}),
						...(shellSandbox !== undefined ? { shellSandbox } : {}),
					});
					result = {
						...result,
						details: {
							...result.details,
							checkKind: resolution.check.kind,
							...(resolution.run !== undefined ? { run: resolution.run } : {}),
						},
					};
					break;
				}
				case "package":
				case "toolchain":
				case "task":
				case "unavailable":
					result = await dryRun(name, cwd, signal);
					break;
				case "unresolved":
					result = {
						kind: "error",
						message: `verify: ${resolution.message}`,
						details: { unresolved: true, judgement: { execution: "not-run", validation: "not-run" } },
					};
					break;
				default:
					result = {
						kind: "error",
						message: `verify: '${name}' names no check`,
						details: { unresolved: true, judgement: { execution: "not-run", validation: "not-run" } },
					};
			}
			const judgement = judgementOf(result);
			const receipt = deps.receipts.put({ check: name, result, checkout: root, at: new Date().toISOString() });
			return {
				ok: result.kind === "ok",
				execution: judgement.execution,
				validation: judgement.validation,
				exitCode: exitCodeOf(result),
				text: resultText(result),
				durationMs: Date.now() - started,
				receipt,
			};
		},

		async measure(id, metric, place = "workspace", scope) {
			const name = checkId(id);
			if (typeof metric !== "string" || metric.length === 0 || metric.length > 200)
				return { ok: false, reason: "a metric is a non-empty key" };
			const { cwd } = await deps.resolvePlace(place);
			const resolution = resolveVerifyCall(cwd, { check: name });
			if (resolution.kind !== "catalog")
				return {
					ok: false,
					reason: resolution.kind === "unresolved" ? resolution.message : `'${name}' is not a check the project declares`,
				};
			const check = resolution.check;
			const [file, ...args] = check.command;
			if (file === undefined) return { ok: false, reason: `check '${check.id}' has an empty argv` };
			const at = resolveProjectVerifierExecutionCwd(check.cwd, cwd);
			if (at instanceof Error) return { ok: false, reason: at.message };
			const shellSandbox = sandbox(cwd);
			const result = await runCommandVector(file, args, {
				cwd: at,
				workspaceRoot: cwd,
				timeoutMs: check.timeoutMs,
				maxOutputBytes: JUDGED_CHECK_MAX_OUTPUT_BYTES,
				...(scope !== undefined ? { signal: scope.signal } : {}),
				...(shellSandbox !== undefined ? { shellSandbox } : {}),
			});
			if (result.aborted) return { ok: false, reason: "aborted" };
			if (result.timedOut) return { ok: false, reason: `timed out after ${check.timeoutMs}ms` };
			if (result.outputCapped) return { ok: false, reason: "output exceeded the judged-check ceiling" };
			if (result.exitCode !== 0) {
				const tail = `${result.stdout}${result.stderr}`.trim().slice(-400);
				return {
					ok: false,
					reason: `exited with code ${result.exitCode ?? "?"}${tail.length > 0 ? `: ${tail}` : ""}`,
				};
			}
			return objectiveFromOutput(check, metric, result.stdout, result.durationMs);
		},
	};
}
