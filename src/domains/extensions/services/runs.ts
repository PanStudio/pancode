// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `services.runs`: headless `pancode run` children an extension starts, watches and ends. The host builds the argv and
 * the environment, clamps every request to the manifest's ceilings, keeps a bounded window of each run's stream-json
 * frames for the extension to page through, and ends every run the request that started it no longer waits on.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionRunEnd,
	ExtensionRunFrames,
	ExtensionRunRequest,
	ExtensionWorkPlace,
} from "@pancode/sdk/extension";
import { runCommandVector, type SafeCommandResult } from "../../../core/safe-exec.js";
import {
	EXTENSION_RUN_DEPTH_ENV,
	MAX_EXTENSION_RUN_DEPTH,
	parseExtensionRunDepth,
} from "../../../core/tool-env-controls.js";
import { withContainedYoloPin } from "../../../lib/autonomy/autonomy.js";
import { type PancodeLaunch, type RunEnvPolicy, runEnv } from "./run-env.js";
import type { ExtensionRequestScope } from "./scope.js";

export interface ExtensionRunCeilings {
	maxConcurrent: number;
	autonomy: ReadonlyArray<"default" | "yolo">;
	maxCostUsd: number | null;
	maxTimeoutSeconds: number;
}

export interface ExtensionRunPlace {
	cwd: string;
	workspaceRoot: string;
}

export interface ExtensionRunServiceDeps {
	ceilings: ExtensionRunCeilings;
	launch: PancodeLaunch;
	sourceEnv: Readonly<Record<string, string>>;
	envPolicy: RunEnvPolicy;
	/** Why a yolo run may not start here, or null when it may. */
	yoloRefusal(): string | null;
	resolvePlace(place: ExtensionWorkPlace): ExtensionRunPlace | Promise<ExtensionRunPlace>;
	/** Where answer files live while their run does. */
	tempRoot: string;
	readOnly?: () => boolean;
	spawn?: typeof runCommandVector;
}

export interface ExtensionRunService {
	/** The run belongs to `scope`: it is ended when the scope ends, which waits for it to settle. */
	start(request: ExtensionRunRequest, scope?: ExtensionRequestScope): Promise<{ id: string }>;
	frames(
		id: string,
		options?: { cursor?: number; limit?: number; waitMs?: number },
		scope?: ExtensionRequestScope,
	): Promise<ExtensionRunFrames>;
	wait(id: string): Promise<ExtensionRunEnd>;
	cancel(id: string): Promise<void>;
	/** Why `start` would refuse runs with these settings before any starts, or null. */
	refusal(options?: { autonomy?: "default" | "yolo"; readOnly?: boolean }): Promise<string | null>;
	/** End every run and drop every record. */
	dispose(): Promise<void>;
}

export class ExtensionRunError extends Error {
	constructor(
		readonly code: "invalid" | "refused" | "busy" | "unknown_run",
		message: string,
	) {
		super(message);
		this.name = "ExtensionRunError";
	}
}

/** Seconds past the run's own `--timeout` before the host stops it, so the run can settle and write `run_end`. */
const TIMEOUT_GRACE_SECONDS = 30;
const MAX_WINDOW_FRAMES = 4096;
const MAX_WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_ANSWERS_BYTES = 64 * 1024;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;
const MAX_WAIT_MS = 30_000;
/** Finished runs kept for `frames` and `wait` before the oldest is forgotten. */
const MAX_FINISHED = 64;
const ROUTE_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;

interface Frame {
	value: Readonly<Record<string, unknown>>;
	bytes: number;
}

interface RunRecord {
	id: string;
	frames: Frame[];
	/** Absolute index of `frames[0]`. */
	first: number;
	windowBytes: number;
	pending: Buffer[];
	pendingBytes: number;
	overlong: boolean;
	end: ExtensionRunEnd | null;
	settled: Promise<ExtensionRunEnd>;
	controller: AbortController;
	waiters: Set<() => void>;
}

function routeWord(field: string, value: unknown): string {
	if (typeof value !== "string" || !ROUTE_WORD.test(value))
		throw new ExtensionRunError("invalid", `runs.start: ${field} must be a route word`);
	return value;
}

function clampRequest(request: ExtensionRunRequest, ceilings: ExtensionRunCeilings) {
	if (typeof request !== "object" || request === null) throw new ExtensionRunError("invalid", "runs.start: request");
	if (typeof request.prompt !== "string" || request.prompt.trim().length === 0)
		throw new ExtensionRunError("invalid", "runs.start: prompt must be non-empty text");
	if (Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES)
		throw new ExtensionRunError("invalid", "runs.start: prompt exceeds 1 MiB");
	const routed = request.target !== undefined || request.model !== undefined;
	if (routed && (request.target === undefined || request.model === undefined))
		throw new ExtensionRunError("invalid", "runs.start: target and model go together, or neither");
	const target = routed ? routeWord("target", request.target) : null;
	const model = routed ? routeWord("model", request.model) : null;
	if (request.delegate !== undefined && request.delegate !== false)
		throw new ExtensionRunError("invalid", "runs.start: delegate may only be false");
	const thinking = request.thinking === undefined ? null : routeWord("thinking", request.thinking);
	const autonomy = request.autonomy ?? "default";
	if (autonomy !== "default" && autonomy !== "yolo")
		throw new ExtensionRunError("invalid", "runs.start: autonomy must be default or yolo");
	if (!ceilings.autonomy.includes(autonomy))
		throw new ExtensionRunError("refused", `runs.start: the manifest does not allow autonomy ${autonomy}`);
	const timeout = request.timeoutSeconds;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > ceilings.maxTimeoutSeconds)
		throw new ExtensionRunError(
			"invalid",
			`runs.start: timeoutSeconds must be an integer from 1 to ${ceilings.maxTimeoutSeconds}`,
		);
	let maxCostUsd = request.maxCostUsd ?? ceilings.maxCostUsd;
	if (maxCostUsd !== null && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0))
		throw new ExtensionRunError("invalid", "runs.start: maxCostUsd must be a positive number");
	if (maxCostUsd !== null && ceilings.maxCostUsd !== null && maxCostUsd > ceilings.maxCostUsd)
		maxCostUsd = ceilings.maxCostUsd;
	if (request.answers !== undefined) {
		if (typeof request.answers !== "string") throw new ExtensionRunError("invalid", "runs.start: answers");
		if (Buffer.byteLength(request.answers) > MAX_ANSWERS_BYTES)
			throw new ExtensionRunError("invalid", "runs.start: answers exceed 64 KiB");
	}
	return {
		prompt: request.prompt,
		target,
		model,
		thinking,
		autonomy,
		readOnly: request.readOnly === true,
		delegate: request.delegate !== false,
		answers: request.answers ?? null,
		timeout,
		maxCostUsd,
	};
}

function endOf(record: RunRecord, result: SafeCommandResult | null, error: string | null): ExtensionRunEnd {
	let end: Readonly<Record<string, unknown>> | null = null;
	for (let index = record.frames.length - 1; index >= 0; index -= 1) {
		const frame = record.frames[index] as Frame;
		if (frame.value.type === "run_end") {
			end = frame.value;
			break;
		}
	}
	const outcome =
		typeof end?.outcome === "string"
			? end.outcome
			: result?.aborted === true
				? "canceled"
				: result?.timedOut === true
					? "timed_out"
					: "error";
	return {
		exitCode: result?.exitCode ?? null,
		outcome,
		end,
		stderrTail: (result?.stderr ?? "").slice(-4096),
		...(error !== null ? { error } : {}),
	};
}

export function createExtensionRunService(deps: ExtensionRunServiceDeps): ExtensionRunService {
	const spawn = deps.spawn ?? runCommandVector;
	const runs = new Map<string, RunRecord>();
	const finished: string[] = [];
	let active = 0;

	const wake = (record: RunRecord): void => {
		for (const waiter of record.waiters) waiter();
		record.waiters.clear();
	};

	const push = (record: RunRecord, line: Buffer): void => {
		const text = line.toString("utf8").trim();
		if (!text.startsWith("{")) return;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		record.frames.push({ value: value as Record<string, unknown>, bytes: line.byteLength });
		record.windowBytes += line.byteLength;
		while (
			record.frames.length > MAX_WINDOW_FRAMES ||
			(record.windowBytes > MAX_WINDOW_BYTES && record.frames.length > 1)
		) {
			const dropped = record.frames.shift() as Frame;
			record.windowBytes -= dropped.bytes;
			record.first += 1;
		}
		wake(record);
	};

	const onStdout = (record: RunRecord, chunk: Buffer): void => {
		let rest = chunk;
		for (;;) {
			const newline = rest.indexOf(10);
			if (newline < 0) break;
			const piece = rest.subarray(0, newline);
			rest = rest.subarray(newline + 1);
			if (!record.overlong) push(record, Buffer.concat([...record.pending, piece]));
			record.pending = [];
			record.pendingBytes = 0;
			record.overlong = false;
		}
		if (rest.byteLength === 0 || record.overlong) return;
		record.pendingBytes += rest.byteLength;
		if (record.pendingBytes > MAX_LINE_BYTES) {
			record.pending = [];
			record.pendingBytes = 0;
			record.overlong = true;
			return;
		}
		record.pending.push(Buffer.from(rest));
	};

	const forget = (id: string): void => {
		finished.push(id);
		while (finished.length > MAX_FINISHED) runs.delete(finished.shift() as string);
	};

	const lookup = (id: unknown): RunRecord => {
		const record = typeof id === "string" ? runs.get(id) : undefined;
		if (record === undefined) throw new ExtensionRunError("unknown_run", `no run ${String(id)}`);
		return record;
	};

	/** The refusals that hold whatever the run's place and the live run count: `start` and `refusal` share them. */
	const standingRefusal = (run: { autonomy: "default" | "yolo"; readOnly: boolean }): string | null => {
		const depth = parseExtensionRunDepth(deps.sourceEnv[EXTENSION_RUN_DEPTH_ENV]);
		if (depth === "invalid")
			return `runs.start: invalid ${EXTENSION_RUN_DEPTH_ENV}; runs nest at most ${MAX_EXTENSION_RUN_DEPTH} deep`;
		if (depth >= MAX_EXTENSION_RUN_DEPTH)
			return `runs.start: this process is already ${depth} extension runs deep; runs nest at most ${MAX_EXTENSION_RUN_DEPTH} deep`;
		if (deps.readOnly?.() === true && (!run.readOnly || run.autonomy === "yolo"))
			return "runs.start: writable or yolo runs are refused in a read-only session";
		return null;
	};

	return {
		async refusal(options = {}) {
			const autonomy = options.autonomy ?? "default";
			if (autonomy !== "default" && autonomy !== "yolo")
				throw new ExtensionRunError("invalid", "runs.refusal: autonomy must be default or yolo");
			if (!deps.ceilings.autonomy.includes(autonomy))
				return `runs.start: the manifest does not allow autonomy ${autonomy}`;
			const standing = standingRefusal({ autonomy, readOnly: options.readOnly === true });
			if (standing !== null) return standing;
			return autonomy === "yolo" ? deps.yoloRefusal() : null;
		},
		async start(request, scope) {
			const signal = scope?.signal;
			const run = clampRequest(request, deps.ceilings);
			const standing = standingRefusal(run);
			if (standing !== null) throw new ExtensionRunError("refused", standing);
			const place = await deps.resolvePlace(request.cwd ?? "workspace");
			if (active >= deps.ceilings.maxConcurrent)
				throw new ExtensionRunError("busy", `runs.start: ${deps.ceilings.maxConcurrent} runs are already running`);
			if (run.autonomy === "yolo") {
				const refusal = deps.yoloRefusal();
				if (refusal !== null) throw new ExtensionRunError("refused", refusal);
			}
			if (signal?.aborted === true) throw new ExtensionRunError("refused", "runs.start: the request has ended");
			const id = randomUUID();
			let answersDir: string | null = null;
			let answersPath: string | null = null;
			if (run.answers !== null) {
				answersDir = mkdtempSync(join(deps.tempRoot, "run-answers-"));
				answersPath = join(answersDir, "answers.txt");
				writeFileSync(answersPath, run.answers, { encoding: "utf8", mode: 0o600 });
			}
			const args = [
				...deps.launch.args,
				"run",
				"--cwd",
				place.cwd,
				...(run.delegate ? [] : ["--no-delegate"]),
				...(run.target !== null && run.model !== null ? ["--target", run.target, "--model", run.model] : []),
				...(run.thinking !== null ? ["--thinking", run.thinking] : []),
				...(answersPath !== null ? ["--answers", answersPath] : []),
				"--timeout",
				String(run.timeout),
				...(run.maxCostUsd !== null ? ["--max-cost-usd", String(run.maxCostUsd)] : []),
				...(run.readOnly ? ["--read-only"] : []),
				...(run.autonomy === "yolo" ? ["--autonomy", "yolo"] : []),
				"--output-format",
				"stream-json",
				"--",
				run.prompt,
			];
			const env = {
				...runEnv(deps.sourceEnv, deps.envPolicy, run.target ?? deps.envPolicy.defaultTarget ?? null),
				...deps.launch.env,
				// standingRefusal already refused an invalid or too-deep value.
				[EXTENSION_RUN_DEPTH_ENV]: String((parseExtensionRunDepth(deps.sourceEnv[EXTENSION_RUN_DEPTH_ENV]) as number) + 1),
			};
			const controller = new AbortController();
			const stop = (): void => controller.abort();
			signal?.addEventListener("abort", stop, { once: true });
			const record: RunRecord = {
				id,
				frames: [],
				first: 0,
				windowBytes: 0,
				pending: [],
				pendingBytes: 0,
				overlong: false,
				end: null,
				settled: Promise.resolve(null as unknown as ExtensionRunEnd),
				controller,
				waiters: new Set(),
			};
			runs.set(id, record);
			active += 1;
			record.settled = (async () => {
				let result: SafeCommandResult | null = null;
				let error: string | null = null;
				try {
					result = await spawn(deps.launch.file, args, {
						cwd: place.cwd,
						workspaceRoot: place.workspaceRoot,
						env: run.autonomy === "yolo" ? withContainedYoloPin(env) : env,
						timeoutMs: (run.timeout + TIMEOUT_GRACE_SECONDS) * 1000,
						signal: controller.signal,
						output: { onStdout: (chunk) => onStdout(record, chunk), retainTailBytes: 4096 },
					});
				} catch (caught) {
					error = caught instanceof Error ? caught.message : String(caught);
				} finally {
					signal?.removeEventListener("abort", stop);
					if (answersDir !== null) rmSync(answersDir, { recursive: true, force: true });
				}
				if (!record.overlong && record.pendingBytes > 0) push(record, Buffer.concat(record.pending));
				record.pending = [];
				record.end = endOf(record, result, error);
				active -= 1;
				forget(id);
				wake(record);
				return record.end;
			})();
			scope?.defer(() => record.settled);
			return { id };
		},

		async frames(id, options = {}, scope) {
			const record = lookup(id);
			const rawCursor = options.cursor;
			const rawLimit = options.limit;
			const rawWait = options.waitMs;
			const cursor = Math.max(0, Math.trunc(typeof rawCursor === "number" && Number.isFinite(rawCursor) ? rawCursor : 0));
			const limit = Math.min(
				MAX_PAGE,
				Math.max(1, Math.trunc(typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PAGE)),
			);
			const waitMs = Math.min(
				MAX_WAIT_MS,
				Math.max(0, Math.trunc(typeof rawWait === "number" && Number.isFinite(rawWait) ? rawWait : 0)),
			);
			const signal = scope?.signal;
			if (waitMs > 0 && record.end === null && signal?.aborted !== true && cursor >= record.first + record.frames.length) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, waitMs);
					function done(): void {
						clearTimeout(timer);
						signal?.removeEventListener("abort", done);
						record.waiters.delete(done);
						resolve();
					}
					record.waiters.add(done);
					signal?.addEventListener("abort", done, { once: true });
				});
			}
			const from = Math.max(cursor, record.first);
			const page = record.frames.slice(from - record.first, from - record.first + limit).map((frame) => frame.value);
			const next = from + page.length;
			return {
				frames: page,
				next,
				dropped: from - cursor,
				done: record.end !== null && next >= record.first + record.frames.length,
			};
		},

		wait(id) {
			return lookup(id).settled;
		},

		async cancel(id) {
			const record = lookup(id);
			record.controller.abort();
			await record.settled;
		},

		async dispose() {
			const pending = [...runs.values()].filter((record) => record.end === null);
			for (const record of pending) record.controller.abort();
			await Promise.all(pending.map((record) => record.settled));
			runs.clear();
			finished.length = 0;
		},
	};
}
