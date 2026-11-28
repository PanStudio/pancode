// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What a headless run left in its own PanCode home (`runs.start({ home })`), folded after it exited: its main session's
 * ledger, its journal and its token attribution. The runs service reads it for `runs.digest`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionRunDigest } from "@pancode/sdk/extension";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { resetXdgCache } from "../../core/xdg.js";
import { isSessionJsonlHeader, readSessionFileEntries } from "../../engine/session.js";
import { loadSessionTelemetrySource } from "../telemetry/index.js";
import { collectSessionEntries } from "./compaction/session-entries.js";
import type { SessionEntry } from "./entries.js";
import { payloadObject } from "./message-projection.js";
import { loadTokenSourcesReport, type TokenSourcesReportV1 } from "./token-sources.js";

/** The loop guard's middleware registration id (`LOOP_GUARD_REGISTRATION_ID` in src/engine/loop-guard.ts). */
const LOOP_GUARD_RULE_ID = "guard.loop";
const EXTENSION_TOOL_PREFIX = "extension_";

function record(value: unknown): Record<string, unknown> | null {
	return payloadObject(value);
}

/** A result an extension tool returned: the ledger stamps the extension as the call's owner, gateway or not. */
function isExtensionResult(payload: Record<string, unknown> | null, details: Record<string, unknown> | null): boolean {
	if (record(payload?.owner)?.kind === "extension") return true;
	const toolName = payload?.toolName;
	if (typeof toolName === "string" && toolName.startsWith(EXTENSION_TOOL_PREFIX)) return true;
	const capability = details?.capability;
	return typeof capability === "string" && capability.startsWith(EXTENSION_TOOL_PREFIX);
}

/** Pure fold over what a run persisted; `loadRunDigest` reads those inputs from the run's own state root. */
export function foldRunDigest(
	sessionId: string | null,
	entries: ReadonlyArray<SessionEntry>,
	records: ReadonlyArray<TelemetryRecord>,
	tokens: TokenSourcesReportV1 | null,
): ExtensionRunDigest {
	const gates: ExtensionRunDigest["gates"] = { reached: [], interviews: 0, answered: 0, unscripted: 0, unanswered: 0 };
	const refusals: ExtensionRunDigest["refusals"] = { hookBlocks: 0, toolRefusals: 0 };
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "tool_result") continue;
		const payload = record(entry.payload);
		const result = record(payload?.result);
		const details = record(result?.details);
		if (!isExtensionResult(payload, details)) continue;
		const interview = record(details?.interview);
		if (interview === null) {
			if (payload?.isError === true) refusals.toolRefusals += 1;
			continue;
		}
		gates.interviews += 1;
		if (interview.outcome === "done") gates.answered += 1;
		else if (interview.reason === "unscripted") gates.unscripted += 1;
		else gates.unanswered += 1;
		const checkpoints = Array.isArray(interview.checkpoints) ? interview.checkpoints : [];
		for (const checkpoint of checkpoints)
			if (typeof checkpoint === "string" && !gates.reached.includes(checkpoint)) gates.reached.push(checkpoint);
	}
	let loopGuardBlocks = 0;
	for (const row of records) {
		const owner = row.ctx.sessionId;
		if (sessionId !== null && owner !== undefined && owner !== null && owner !== sessionId) continue;
		if (row.k === "hook.ran") {
			if (row.data.origin === "extension" && row.data.effectKinds?.includes("block_tool") === true)
				refusals.hookBlocks += 1;
		} else if (row.k === "middleware.fired") {
			if (row.data.ruleId === LOOP_GUARD_RULE_ID && row.data.effects.includes("block_tool")) loopGuardBlocks += 1;
		}
	}
	return {
		sessionId,
		gates,
		refusals,
		loopGuardBlocks,
		tokens:
			tokens === null
				? null
				: {
						usage: tokens.basis.usage,
						calls: tokens.totals.calls,
						unmeasuredCalls: tokens.totals.unmeasuredCalls,
						fresh: tokens.totals.input.fresh,
						cached: tokens.totals.input.cached,
						input: tokens.totals.input.total,
						output: tokens.totals.output,
						...(tokens.totals.input.unsplitCalls ? { unsplitCalls: tokens.totals.input.unsplitCalls } : {}),
					},
	};
}

/** The roots of a run home, as `runs.start` laid them out. */
function homeRoots(home: string): Record<string, string> {
	return {
		PANCODE_DATA_DIR: join(home, "data"),
		PANCODE_STATE_DIR: join(home, "state"),
		PANCODE_CACHE_DIR: join(home, "cache"),
	};
}

/**
 * Run `read` with this process's PanCode roots pointed at a run home's, then put them back. The session readers resolve
 * the state root from the environment, so the swap is what lets one process read every run; `read` must be
 * synchronous, so nothing else runs while the roots are swapped.
 */
function withHomeRoots<T>(home: string, read: () => T): T {
	const env = homeRoots(home);
	const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetXdgCache();
	try {
		return read();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		resetXdgCache();
	}
}

interface SessionDir {
	id: string;
	dir: string;
	cwd: string | null;
	createdAt: string;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The run's main session: the earliest one opened in its directory, else the earliest in the state root. */
function mainSession(stateDir: string, projectDir: string): SessionDir | null {
	const root = join(stateDir, "sessions");
	if (!existsSync(root)) return null;
	const found: SessionDir[] = [];
	for (const bucket of readdirSync(root, { withFileTypes: true })) {
		if (!bucket.isDirectory()) continue;
		for (const session of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			const dir = join(root, bucket.name, session.name);
			let meta: Record<string, unknown> | null = null;
			try {
				meta = record(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
			} catch {
				continue;
			}
			if (meta === null || typeof meta.id !== "string") continue;
			found.push({
				id: meta.id,
				dir,
				cwd: typeof meta.cwd === "string" ? canonical(meta.cwd) : null,
				createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
			});
		}
	}
	found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const project = canonical(projectDir);
	return found.find((session) => session.cwd === project) ?? found[0] ?? null;
}

/** Fold what the run in `home` persisted after it exited; its main session is the one opened in `cwd`. */
export function loadRunDigest(home: string, cwd: string): ExtensionRunDigest {
	const stateDir = join(home, "state");
	const session = mainSession(stateDir, cwd);
	if (session === null) return foldRunDigest(null, [], [], null);
	return withHomeRoots(home, () => {
		const path = join(session.dir, "current.jsonl");
		const raw = existsSync(path) ? readSessionFileEntries(path).filter((entry) => !isSessionJsonlHeader(entry)) : [];
		const entries = collectSessionEntries(raw, path);
		const records = loadSessionTelemetrySource(stateDir, session.id)?.journal.records ?? [];
		const tokens = loadTokenSourcesReport(stateDir, session.id);
		return foldRunDigest(session.id, entries, records, tokens);
	});
}
