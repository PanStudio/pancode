// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Session facts every surface reports as a notice. The terminal renders each in
 * its footer or transcript, an ACP client receives it as session metadata, and
 * a headless run writes it on stderr, so a fact one surface shows is never
 * silent on another. Returning null from a formatter means "ignore the event".
 */
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { MiddlewareHookFailedPayload, PermissionRequestedPayload } from "../core/telemetry/live-events.js";
import { actionClassWords } from "../core/views/approval-words.js";
import { HOOK_BUDGET_STALL_FACTOR } from "../domains/middleware/budget.js";
import type { NoticeSource } from "./notice-source.js";

export interface SessionNotice {
	level: "info" | "warn" | "error";
	text: string;
	/** One fact, one key: a surface that keys its notices replaces the earlier one. */
	key: string;
	/** Where the terminal puts it: the footer's notice slot, or a transcript row. */
	surface: "footer" | "transcript";
	/** A footer notice that stays until replaced, because the fact holds until a restart. */
	sticky?: true;
	source?: NoticeSource;
}

export type SessionNoticeFact =
	| "config.restart_required"
	| "safety.git_hooks_changed"
	| "safety.internal_git_drifted"
	| "extension.load_failed"
	| "middleware.hook_failed"
	| "approval.foreign_changed"
	| "reload.applied";

export interface SessionNoticeOptions {
	/** A `/reload` report in progress states restart-bound settings itself. */
	reloadReporting?: () => boolean;
	/** Facts this surface already reports another way. */
	skip?: ReadonlyArray<SessionNoticeFact>;
}

/** Restart-required settings changed under a running session. */
export function restartRequiredNotice(payload: unknown): string | null {
	const diff = (payload as { diff?: { restartRequired?: unknown } } | null | undefined)?.diff;
	const raw = diff?.restartRequired;
	if (!Array.isArray(raw)) return null;
	const paths = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
	if (paths.length === 0) return null;
	const label = paths.length === 1 ? "setting" : "settings";
	return `[config] ${label} ${paths.join(", ")} changed; restart PanCode to apply.`;
}

function isMiddlewareHookFailedPayload(value: unknown): value is MiddlewareHookFailedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (p.kind !== "hook_failed" && p.kind !== "budget_exceeded" && p.kind !== "registration_conflict") return false;
	if (typeof p.registrationId !== "string" || p.registrationId.length === 0) return false;
	if (typeof p.hook !== "string" || p.hook.length === 0) return false;
	if (p.message !== undefined && typeof p.message !== "string") return false;
	if (p.elapsedMs !== undefined && typeof p.elapsedMs !== "number") return false;
	if (p.budgetMs !== undefined && typeof p.budgetMs !== "number") return false;
	if (p.steadyStateWarn !== undefined && typeof p.steadyStateWarn !== "boolean") return false;
	if (p.p95Ms !== undefined && typeof p.p95Ms !== "number") return false;
	if (p.overCount !== undefined && typeof p.overCount !== "number") return false;
	if (p.windowSamples !== undefined && typeof p.windowSamples !== "number") return false;
	return true;
}

interface MiddlewareNotice {
	level: "warn";
	text: string;
	source?: NoticeSource;
}

function middlewareBudgetWarningKey(payload: unknown): string | null {
	if (!isMiddlewareHookFailedPayload(payload)) return null;
	if (payload.kind !== "budget_exceeded") return null;
	return `${payload.registrationId}\u0000${payload.hook}`;
}

/**
 * A middleware hook registration threw (its effects were discarded) or
 * overran the soft budget (its effects still applied). The turn proceeded
 * either way; this warn notice is the operator's only live signal that a
 * guard or assessor is misbehaving.
 */
function middlewareHookFailedNotice(payload: unknown, noteBudgetWarningSuppression: boolean): MiddlewareNotice | null {
	if (!isMiddlewareHookFailedPayload(payload)) return null;
	if (payload.kind === "registration_conflict") {
		const detail =
			payload.message !== undefined && payload.message.length > 0
				? payload.message
				: `registration '${payload.registrationId}' conflicts with an existing id`;
		return { level: "warn", text: `[middleware] ${detail}` };
	}
	if (payload.kind === "hook_failed") {
		const detail = payload.message !== undefined && payload.message.length > 0 ? `: ${payload.message}` : "";
		return {
			level: "warn",
			text: `[middleware] Hook '${payload.registrationId}' failed on ${payload.hook}${detail}. Its effects were skipped; the turn continued.`,
			source: "hooks",
		};
	}
	const elapsed = payload.elapsedMs !== undefined ? `${payload.elapsedMs.toFixed(1)}ms` : "unknown";
	const budget = payload.budgetMs !== undefined ? `${payload.budgetMs}ms` : "budget";
	if (isHookStall(payload))
		return {
			level: "warn",
			text: `[middleware] hook '${payload.registrationId}' stalled on ${payload.hook} for ${elapsed} (soft budget ${budget}); the turn waited for it. Further budget warnings for this hook are suppressed.`,
		};
	const trend =
		payload.overCount !== undefined && payload.windowSamples !== undefined && payload.windowSamples > 0
			? ` slow on ${payload.overCount} of the last ${payload.windowSamples} ${payload.hook} calls${
					payload.p95Ms !== undefined ? `, p95 ${payload.p95Ms.toFixed(1)}ms` : ""
				};`
			: ";";
	const suffix = noteBudgetWarningSuppression ? " further budget warnings for this hook suppressed" : "";
	return {
		level: "warn",
		text:
			`[middleware] hook '${payload.registrationId}' consistently exceeds its soft budget on ${payload.hook} (${elapsed} > ${budget})${trend}${suffix}`.trimEnd(),
	};
}

/** A lone overrun of ten times the budget or more: the turn sat waiting on the hook (a cold spawn, a blocking read). */
function isHookStall(payload: MiddlewareHookFailedPayload): boolean {
	return (
		payload.kind === "budget_exceeded" &&
		payload.elapsedMs !== undefined &&
		payload.budgetMs !== undefined &&
		payload.elapsedMs >= payload.budgetMs * HOOK_BUDGET_STALL_FACTOR
	);
}

/**
 * Notice gate. Steady-state slowness and a stall surface to the operator; a
 * lone post-warmup spike short of a stall (`steadyStateWarn` false) rides the
 * bus for telemetry only. The warning set ensures each registration and hook
 * pair is shown only once.
 */
export function middlewareHookFailedSessionNotice(
	payload: unknown,
	seenBudgetWarnings: Set<string>,
): MiddlewareNotice | null {
	if (
		isMiddlewareHookFailedPayload(payload) &&
		payload.kind === "budget_exceeded" &&
		payload.steadyStateWarn === false &&
		!isHookStall(payload)
	) {
		return null;
	}
	const key = middlewareBudgetWarningKey(payload);
	if (key !== null) {
		if (seenBudgetWarnings.has(key)) return null;
		seenBudgetWarnings.add(key);
	}
	return middlewareHookFailedNotice(payload, key !== null);
}

/** An ask a worker of another PanCode process on this state directory holds; a terminal there shows its card. */
function foreignApprovalNotice(request: PermissionRequestedPayload, refusal: string | undefined): string {
	const runId = request.origin?.startsWith("worker:") ? request.origin.slice("worker:".length) : request.requestedBy;
	const worker = request.agentId ?? "worker";
	const refused = refusal !== undefined && refusal.length > 0 ? ` The answer given here was refused: ${refusal}.` : "";
	return `[approval] Worker ${worker}${runId ? ` (run ${runId})` : ""} of another PanCode process asks to run ${request.tool}, which ${actionClassWords(request.actionClass)}. Answer it in that process or in a PanCode terminal on this workspace.${refused}`;
}

/** Subscribes one surface to every session notice fact; returns the unsubscribe. */
export function subscribeSessionNotices(
	bus: Pick<TelemetryHub, "subscribe">,
	sink: (notice: SessionNotice, fact: SessionNoticeFact) => void,
	options: SessionNoticeOptions = {},
): () => void {
	const skipped = new Set(options.skip ?? []);
	const seenBudgetWarnings = new Set<string>();
	const seenForeignAsks = new Set<string>();
	const raise = (fact: SessionNoticeFact, notice: SessionNotice | null): void => {
		if (notice !== null && !skipped.has(fact)) sink(notice, fact);
	};
	const unsubscribers = [
		bus.subscribe("config.restart_required", (payload) => {
			if (options.reloadReporting?.()) return;
			const text = restartRequiredNotice(payload);
			raise(
				"config.restart_required",
				text === null ? null : { level: "warn", text, key: "config:restart-required", surface: "footer", sticky: true },
			);
		}),
		// The first sight of a hook file changed since the operator's baseline:
		// the next git command PanCode runs outside the sandbox asks the operator.
		bus.subscribe("safety.git_hooks_changed", (payload) => {
			if (typeof payload?.message !== "string" || payload.message.length === 0) return;
			raise("safety.git_hooks_changed", {
				level: "warn",
				text: payload.message,
				key: "safety:git-hooks-changed",
				surface: "transcript",
				source: "safety",
			});
		}),
		// Git PanCode ran itself with hooks off after drift, announced once per set
		// of changes. At yolo it ran as configured, and only the exit summary
		// records it.
		bus.subscribe("safety.internal_git_drifted", (payload) => {
			if (payload?.hardened !== true || payload.announce !== true) return;
			if (typeof payload.message !== "string" || payload.message.length === 0) return;
			raise("safety.internal_git_drifted", {
				level: "warn",
				text: payload.message,
				key: "safety:internal-git-drifted",
				surface: "transcript",
				source: "safety",
			});
		}),
		bus.subscribe("extension.load_failed", (payload) => {
			if (typeof payload?.message !== "string" || payload.message.trim().length === 0) return;
			raise("extension.load_failed", {
				level: "warn",
				text: payload.message,
				key: `extension:${payload.message}`,
				surface: "footer",
			});
		}),
		bus.subscribe("middleware.hook_failed", (payload) => {
			const notice = middlewareHookFailedSessionNotice(payload, seenBudgetWarnings);
			raise(
				"middleware.hook_failed",
				notice === null
					? null
					: {
							...notice,
							key: `middleware:${payload.registrationId}:${payload.hook}:${payload.kind}`,
							surface: "footer",
						},
			);
		}),
		bus.subscribe("approval.foreign_changed", (change) => {
			if (change.kind !== "requested") {
				if (change.resolved.requestId !== undefined) seenForeignAsks.delete(change.resolved.requestId);
				return;
			}
			if (typeof change.request.tool !== "string") return;
			const requestId = change.request.requestId;
			// One notice per ask; a refused answer is news again.
			if (requestId !== undefined && seenForeignAsks.has(requestId) && change.refusal === undefined) return;
			if (requestId !== undefined) seenForeignAsks.add(requestId);
			raise("approval.foreign_changed", {
				level: "warn",
				text: foreignApprovalNotice(change.request, change.refusal),
				key: `approval:foreign:${requestId ?? change.request.tool}`,
				surface: "transcript",
				source: "approval",
			});
		}),
		bus.subscribe("reload.applied", (payload) => {
			if (typeof payload?.text !== "string" || payload.text.length === 0) return;
			raise("reload.applied", {
				level: payload.failed ? "warn" : "info",
				text: payload.text,
				key: `reload:${payload.target}`,
				surface: "transcript",
			});
		}),
	];
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}
