// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Session, provider, memory and middleware vocabularies the telemetry schemas share with the code that produces them.
 * Free of schema imports, so domains, the engine and the worker value-import them without loading typebox.
 */

/** What a Codex transport recovery did for the call that triggered it. */
export const CACHE_RECOVERY_OUTCOMES = ["eligible", "recovered", "failed", "unknown"] as const;
export type CacheRecoveryOutcome = (typeof CACHE_RECOVERY_OUTCOMES)[number];

/**
 * The copilot-sdk session a step's request went to, as PanCode's own pool knows it: `new` (createSession for this
 * step), `spare` (a PV-2 pooled session holding nothing), `continued` (an open one holding the transcript), `resumed`
 * (resumeSession on one an earlier process left).
 */
export const COPILOT_SESSION_ORIGINS = ["new", "spare", "continued", "resumed"] as const;
export type CopilotSessionOrigin = (typeof COPILOT_SESSION_ORIGINS)[number];

/** How one context split was counted. */
export const CONTEXT_SPLIT_SOURCES = ["estimated", "exact", "reconciled"] as const;
export type ContextSplitSource = (typeof CONTEXT_SPLIT_SOURCES)[number];

/** How a context total was counted: a split's sources, or a running count while the response streams. */
export const CONTEXT_TOTAL_SOURCES = [...CONTEXT_SPLIT_SOURCES, "streaming"] as const;
export type ContextTotalSource = (typeof CONTEXT_TOTAL_SOURCES)[number];

/** How one OAuth credential refresh under the storage lock ended; `adopted` took another process's fresh credential. */
export const AUTH_REFRESH_OUTCOMES = ["refreshed", "adopted", "failed", "cancelled"] as const;
export type AuthRefreshOutcome = (typeof AUTH_REFRESH_OUTCOMES)[number];

/** Outcome of one provider usage read, including the reasons a read produced no data. */
export const QUOTA_STATUSES = ["ok", "no_credentials", "expired", "error", "loading"] as const;
export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

/** The memory guardian's state, which operator surfaces project from `memory.guardian_changed`. */
export const MEMORY_GUARDIAN_STATES = ["off", "idle", "reviewing", "waiting-capacity", "unavailable"] as const;
export type MemoryGuardianState = (typeof MEMORY_GUARDIAN_STATES)[number];

/**
 * The five lifecycle events of the unified middleware layer (w3 cutover).
 * Every event has a live producer: the registry fires before_tool/after_tool
 * in runSpec, the chat-loop fires turn_start on prompt acceptance, turn_end
 * when the final assistant message of a run lands, and on_compaction
 * (observe-only) before each compaction stage.
 */
export const MIDDLEWARE_HOOKS = ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"] as const;
export type MiddlewareHook = (typeof MIDDLEWARE_HOOKS)[number];

/** The hooks an extension can register: the middleware hooks plus `prompt_submit`, before a prompt is accepted. */
export const EXTENSION_HOOKS = [...MIDDLEWARE_HOOKS, "prompt_submit"] as const;
export type ExtensionHook = (typeof EXTENSION_HOOKS)[number];

/** Every effect a middleware firing can carry. `rewrite_tool_input` is the runtime's own: no rule can declare it. */
export const MIDDLEWARE_EFFECT_KINDS = [
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"request_continuation",
	"require_tool",
	"lock_tools",
	"notify_operator",
	"rewrite_tool_input",
	"request_approval",
] as const;
export type MiddlewareEffectKind = (typeof MIDDLEWARE_EFFECT_KINDS)[number];

export const MIDDLEWARE_REMINDER_SEVERITIES = ["info", "advisory", "warn", "hard-block"] as const;
export type MiddlewareReminderSeverity = (typeof MIDDLEWARE_REMINDER_SEVERITIES)[number];

/** Whether the tool call a write grant authorized has run. */
export const GRANT_EXECUTIONS = ["not_executed", "executing", "executed", "unknown"] as const;
export type GrantExecution = (typeof GRANT_EXECUTIONS)[number];

/**
 * What a declared check (`src/tools/verify/catalog.ts`) proves. `command` reads the exit code. `numeric-compare` runs
 * the command, parses its stdout as `string -> number | number[]`, and judges it against a reference file under a
 * tolerance. `perf-budget` runs the command and judges its wall time against a budget or a recorded baseline.
 * `reproduce` checks pinned input digests, runs the command in a clean environment with a declared seed, and judges
 * its metrics, their units and their shapes against a reference file or a second clean run. `browser` starts the
 * command as a dev server in a hermetic browser session, loads a loopback URL, runs an optional step file, and fails on
 * console errors, uncaught exceptions, failed requests or, when asked, axe violations.
 */
export const DECLARED_CHECK_KINDS = ["command", "numeric-compare", "perf-budget", "reproduce", "browser"] as const;
export type DeclaredCheckKind = (typeof DECLARED_CHECK_KINDS)[number];

/** Where one context activity (a compaction, a summary, a PANCODE.md generation) stands. */
export const CONTEXT_ACTIVITY_STATUSES = ["started", "running", "completed", "failed"] as const;
export type ContextActivityStatus = (typeof CONTEXT_ACTIVITY_STATUSES)[number];

/** Who asked for an artifact to be protected from edits during a session. */
export const PROTECTED_ARTIFACT_SOURCES = ["validation", "middleware", "user", "session"] as const;
export type ProtectedArtifactSource = (typeof PROTECTED_ARTIFACT_SOURCES)[number];

/** Where a provider retry stands, as the status row and the readouts report it. */
export const RETRY_STATUS_PHASES = [
	"scheduled",
	"waiting",
	"retrying",
	"moved",
	"cancelled",
	"exhausted",
	"recovered",
] as const;
export type RetryStatusPhase = (typeof RETRY_STATUS_PHASES)[number];

/** How much of PANCODE.md a session preloads into its prompt. */
export const PROJECT_PRELOAD_MODES = ["full", "partial", "synopsis", "none"] as const;
export type ProjectPreloadMode = (typeof PROJECT_PRELOAD_MODES)[number];
