// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Permission asks over ACP: the worker ask bridge that forwards worker
 * permission rounds to the client, and the main chat's permission bridge.
 */

import { emitApproval } from "../../core/telemetry/approvals.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { PermissionRequestedPayload, PermissionResolvedPayload } from "../../core/telemetry/live-events.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../../domains/safety/autonomy.js";
import { describeMainCallConsequences, mainCallExposure } from "../../domains/safety/call-consequence.js";
import { describeCallTarget, sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { COMMAND_CONSEQUENCE_MAX_SEVERE } from "../../domains/safety/command-consequence.js";
import type { DecisionPresentation, TrustedDecisionFacts } from "../../domains/safety/decision-presentation.js";
import {
	classifyDecisionPresentation,
	decisionActionClass,
	decisionFactsForPermission,
} from "../../domains/safety/decision-presentation.js";
import { escapeScopeOptionLabel } from "../../domains/safety/escape-scope.js";
import { redactUrlCredentials } from "../../domains/safety/redaction.js";
import type { SessionContract } from "../../domains/session/contract.js";
import { mutationFacts, sessionApprovalTask } from "../../session-control/approval-request-facts.js";
import type { ApprovalRequestView, MutationFacts } from "../../session-control/approval-request-view.js";
import { resolvePermission } from "../../session-control/index.js";
import { askUserExposure } from "../../tools/ask-user.js";
import type { ToolRegistry } from "../../tools/registry-contract.js";
import { clippedCallCommand } from "../worker-refusals.js";
import { ACP_DISPATCH_PLAN_META_KEY, dispatchPlanTitle, projectDispatchPlanMeta } from "./dispatch-plan-meta.js";
import { AcpTimeoutError } from "./errors.js";
import { boundString, redactCallText, safeStoredIdentifier, safeStoredString } from "./server-bounds.js";
import type { AcpClientSurface } from "./server-options.js";
import type { AcpToolCallSnapshot } from "./server-tool-updates.js";
import { ACP_MAX_TOOL_TITLE_BYTES, permissionTitle, toolKind } from "./server-tool-updates.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import type { AcpRequestPermissionResponse } from "./types.js";
import { ACP_DECISION_META_KEY, ACP_PERMISSION_ASK_META_KEY, ACP_WORKER_ASK_META_KEY } from "./types.js";

/** The host side of a forwarded worker ask: the dispatch domain's answer path and the open tool call it binds to. */
interface AcpWorkerAskPort {
	/** True once the client advertised `pancode/workerPermissions` at initialize. */
	enabled: () => boolean;
	/** Settles the worker's parked ask. Throws when the run no longer accepts a decision. */
	resolve: (runId: string, requestId: string, decision: "approve" | "deny") => void;
	/** The wire id of the open tool call this run belongs to, else the newest open one, else null. */
	bindToolCall: (runId: string) => string | null;
	/** Tells the client an ask it still holds is no longer waiting. */
	withdraw: (sessionId: string, requestId: string) => void;
}

/** The one client-facing ask in flight, shared by main-agent and worker asks. */
interface AcpPermissionQueue {
	chain: Promise<void>;
	cancel: ((reason: string) => void) | null;
	cancelWorkers: (() => void) | null;
}

function enqueuePermissionRequest(
	queue: AcpPermissionQueue,
	run: () => Promise<void>,
	refuse: (reason: string) => Promise<void> | void,
	diagnostics: ((line: string) => void) | undefined,
): void {
	queue.chain = queue.chain
		.then(run, run)
		.catch(async (err: unknown) => {
			const reason = `ACP permission request failed: ${err instanceof Error ? err.message : String(err)}`;
			try {
				await refuse(reason);
			} finally {
				diagnostics?.(reason);
			}
		})
		.catch(() => {
			// ACP audit finding 1: even a failed refusal or diagnostic must not
			// reject the detached queue and terminate the protocol connection.
		});
}

/** How often a worker ask retries binding to an open tool call while the model is between calls. */
const ACP_WORKER_ASK_BIND_POLL_MS = 200;
/** How often an outstanding main-session ask checks that its call is still parked, for a client that takes withdrawals. */
const ACP_MAIN_ASK_SETTLED_POLL_MS = 250;
const ACP_MAX_WORKER_ASK_ID_BYTES = 128;

interface AcpWorkerAsk {
	requestId: string;
	runId: string;
	agentId: string;
	tool: string;
	payload: PermissionRequestedPayload;
}

/** A live worker escalation, read the way the terminal's overlay reads it. */
function workerAskOf(payload: PermissionRequestedPayload): AcpWorkerAsk | null {
	if (payload.escalation !== true) return null;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	if (!origin?.startsWith("worker:")) return null;
	const requestId = safeStoredIdentifier(payload.requestId, ACP_MAX_WORKER_ASK_ID_BYTES);
	const runId = safeStoredIdentifier(
		typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length),
		ACP_MAX_WORKER_ASK_ID_BYTES,
	);
	if (requestId === null || runId === null) return null;
	return {
		requestId,
		runId,
		agentId: safeStoredIdentifier(payload.agentId, ACP_MAX_WORKER_ASK_ID_BYTES) ?? "worker",
		tool: safeStoredString(payload.tool, 64, "unknown"),
		payload,
	};
}

function workerAskAxis(
	payload: PermissionRequestedPayload,
): { kind: "safety-net"; ruleId: string } | { kind: "autonomy"; level: string } {
	const axisId = typeof payload.axis === "string" ? payload.axis : undefined;
	if (axisId?.startsWith("net:")) return { kind: "safety-net", ruleId: axisId.slice("net:".length) || "unknown" };
	if (axisId?.startsWith("autonomy:")) {
		return { kind: "autonomy", level: axisId.slice("autonomy:".length) || DEFAULT_AUTONOMY_LEVEL };
	}
	if (typeof payload.ruleId === "string" && payload.ruleId.length > 0) {
		return { kind: "safety-net", ruleId: payload.ruleId };
	}
	return { kind: "autonomy", level: DEFAULT_AUTONOMY_LEVEL };
}

/**
 * Puts a dispatched worker's escalation in front of an attended ACP client as
 * `session/request_permission`, bound to the tool call the run belongs to, and
 * answers the worker with what the person chose. The ask carries the worker's
 * provenance beside the decision facts so a client can say whose request it is
 * and who may discharge it. An ask nobody can be shown (no open tool call
 * before the worker's own deadline) is left to the worker's timeout fallback
 * rather than denied in the operator's name.
 */
function installWorkerAskBridge(
	input: {
		transport: AcpJsonRpcPeerTransport;
		bus?: TelemetryHub;
		toolCallSnapshot: (wireId: string) => AcpToolCallSnapshot | null;
		activeSessionId: () => string | null;
		/** The window a client-facing ask gets, read per ask because the client negotiates it at initialize. */
		permissionTimeoutMs: () => number;
		clientSurface: () => AcpClientSurface;
		cancelActivePrompt: (reason: string) => void;
		workerAsks?: AcpWorkerAskPort;
		diagnostics?: (line: string) => void;
	},
	queue: AcpPermissionQueue,
): () => void {
	const workers = input.workerAsks;
	const bus = input.bus;
	if (workers === undefined || bus === undefined) return () => {};
	// Asks still queued or on the client, each with the callback that marks it
	// settled elsewhere (the worker timed out, the run ended, the owner revoked it).
	const waiting = new Map<string, () => void>();
	queue.cancelWorkers = () => {
		for (const settle of waiting.values()) settle();
	};
	const unregisterRequested = bus.subscribe("approval.requested", (payload: PermissionRequestedPayload) => {
		if (!workers.enabled()) return;
		const ask = workerAskOf(payload);
		if (ask === null || waiting.has(ask.requestId)) return;
		const owningSessionId = input.activeSessionId();
		if (owningSessionId === null || (payload.sessionId !== undefined && payload.sessionId !== owningSessionId)) return;
		const windowMs = input.permissionTimeoutMs();
		const askWindowMs = Math.min(
			windowMs,
			typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
				? payload.timeoutMs
				: windowMs,
		);
		const giveUpAt = performance.now() + askWindowMs;
		let settledElsewhere = false;
		let signalSettled: () => void = () => {};
		const settled = new Promise<{ kind: "settled" }>((resolve) => {
			signalSettled = () => resolve({ kind: "settled" });
		});
		waiting.set(ask.requestId, () => {
			settledElsewhere = true;
			signalSettled();
		});
		const answerWorker = (decision: "approve" | "deny"): void => {
			try {
				workers.resolve(ask.runId, ask.requestId, decision);
			} catch (err) {
				// The run ended or the ask expired while the person was deciding; the
				// worker already applied its fallback, so a late answer has no one to reach.
				input.diagnostics?.(
					`worker permission ${ask.requestId} could not be answered: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		};
		const wait = (ms: number): Promise<void> =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				timer.unref?.();
			});
		const run = async (): Promise<void> => {
			try {
				if (settledElsewhere) return;
				let sessionId: string | null = null;
				let toolCallId: string | null = null;
				// The model is often between tool calls when a worker asks, so binding
				// retries until the ask's own window closes instead of failing at once.
				for (;;) {
					sessionId = input.activeSessionId();
					if (sessionId !== owningSessionId) return;
					toolCallId = sessionId === null ? null : workers.bindToolCall(ask.runId);
					if (toolCallId !== null || settledElsewhere || performance.now() >= giveUpAt) break;
					await Promise.race([wait(ACP_WORKER_ASK_BIND_POLL_MS), settled]);
				}
				const snapshot = toolCallId === null ? null : input.toolCallSnapshot(toolCallId);
				if (settledElsewhere || performance.now() >= giveUpAt) return;
				if (sessionId === null || toolCallId === null || snapshot === null) {
					input.diagnostics?.(`worker permission ${ask.requestId} had no open tool call to ask under`);
					return;
				}
				const facts = decisionFactsForPermission({
					tool: ask.tool,
					actionClass: decisionActionClass(payload.actionClass),
					axis: workerAskAxis(payload),
					origin: { kind: "worker", agentId: ask.agentId, runId: ask.runId },
				});
				const presentation = classifyDecisionPresentation(facts);
				const approveAction = presentation.requiredActions.find((action) => action.id === "approve-once");
				const denyAction = presentation.requiredActions.find((action) => action.id === "deny");
				const stopAction = presentation.requiredActions.find((action) => action.id === "stop");
				const consequence = Array.isArray(payload.consequence)
					? payload.consequence.filter((line): line is string => typeof line === "string")
					: [];
				const workerMeta = {
					version: 1,
					requestId: ask.requestId,
					requestedBy: ask.runId,
					agentId: ask.agentId,
					...(payload.approvalAuthority === "main" || payload.approvalAuthority === "operator"
						? { approvalAuthority: payload.approvalAuthority }
						: {}),
					forwardedByMain: payload.forwardedByMain === true,
					fallback: payload.fallback === "fail" ? "fail" : "deny",
					...(typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
						? { timeoutMs: Math.max(0, Math.floor(payload.timeoutMs)) }
						: {}),
				};
				const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolveCancelled) => {
					queue.cancel = (reason: string) => resolveCancelled({ kind: "cancelled", reason });
				});
				const answered = Promise.resolve()
					.then(() =>
						input.transport.request<AcpRequestPermissionResponse>(
							"session/request_permission",
							{
								sessionId,
								toolCall: {
									toolCallId,
									title: snapshot.title,
									kind: snapshot.kind,
									status: "in_progress",
									rawInput: snapshot.rawInput,
									...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
								},
								options: [
									{ optionId: "allow-once", name: approveAction?.label ?? "Approve once", kind: "allow_once" },
									{ optionId: "reject-once", name: denyAction?.label ?? "Deny this request", kind: "reject_once" },
									{ optionId: "reject-and-stop", name: stopAction?.label ?? "Deny and stop", kind: "reject_once" },
								],
								_meta: {
									...decisionMeta(facts, presentation, typeof payload.target === "string" ? payload.target : "", consequence),
									[ACP_WORKER_ASK_META_KEY]: workerMeta,
								},
							},
							Math.max(1, giveUpAt - performance.now()),
						),
					)
					.then(
						(response) => ({ kind: "response" as const, response }),
						(err: unknown) => ({ kind: "failed" as const, err }),
					);
				try {
					const outcome = await Promise.race([answered, cancelled, settled]);
					if (outcome.kind === "settled") {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (outcome.kind === "cancelled") {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (outcome.kind === "failed") {
						workers.withdraw(sessionId, ask.requestId);
						input.diagnostics?.(
							`worker permission ${ask.requestId} failed: ${outcome.err instanceof Error ? outcome.err.message : String(outcome.err)}`,
						);
						return;
					}
					if (settledElsewhere || performance.now() >= giveUpAt) {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					const response: unknown = outcome.response;
					const answer = isRecord(response) && isRecord(response.outcome) ? response.outcome : null;
					if (
						answer === null ||
						answer.outcome !== "selected" ||
						typeof answer.optionId !== "string" ||
						!["allow-once", "reject-once", "reject-and-stop"].includes(answer.optionId)
					) {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (answer.outcome === "selected" && answer.optionId === "allow-once") {
						answerWorker("approve");
						return;
					}
					answerWorker("deny");
					// The terminal's Deny and stop: the worker is denied first, then the
					// main turn the person asked to stop being asked in is cancelled.
					if (answer.outcome === "selected" && answer.optionId === "reject-and-stop") {
						input.cancelActivePrompt(
							`${askAnswerer(input.clientSurface()).name} denied a worker request and stopped the run`,
						);
					}
				} finally {
					queue.cancel = null;
				}
			} finally {
				waiting.delete(ask.requestId);
			}
		};
		enqueuePermissionRequest(queue, run, () => answerWorker("deny"), input.diagnostics);
	});
	// Any resolution of an ask this bridge has not answered itself means the
	// person's card is stale: the worker timed out, the run ended, or the owner revoked it.
	const unregisterResolved = bus.subscribe("approval.resolved", (payload) => {
		if (typeof payload.requestId === "string") waiting.get(payload.requestId)?.();
	});
	return () => {
		queue.cancelWorkers?.();
		unregisterRequested();
		unregisterResolved();
	};
}

/** Distinct (run, tool) pairs one connection remembers before it starts over. */
const ACP_UNANSWERED_WORKER_ASK_MEMORY = 256;

/**
 * Tells the client when a dispatched worker's ask was settled without anyone
 * answering it: no responder (the client did not opt into worker permissions,
 * so the worker applied its fallback at once) or the ask's window closed. The
 * worker is not stuck, but without this the client never learns that it wanted
 * something and was refused. One notice per run and tool, built only from
 * bounded identifiers; the worker-composed reason never reaches the wire.
 */
function installUnansweredWorkerAskNotice(input: {
	bus?: TelemetryHub;
	activeSessionId: () => string | null;
	workerAsksEnabled: () => boolean;
	notice?: (sessionId: string, text: string) => void;
}): () => void {
	const bus = input.bus;
	const notice = input.notice;
	if (bus === undefined || notice === undefined) return () => {};
	const told = new Set<string>();
	return bus.subscribe("approval.resolved", (payload: PermissionResolvedPayload) => {
		const timedOut = payload.decidedBy === "timeout";
		if (!timedOut && payload.decidedBy !== "policy:no-operator") return;
		if (payload.status === "granted") return;
		const origin = typeof payload.origin === "string" ? payload.origin : "";
		if (!origin.startsWith("worker:") && !origin.startsWith("delegation:")) return;
		const sessionId = input.activeSessionId();
		if (sessionId === null || (payload.sessionId !== undefined && payload.sessionId !== sessionId)) return;
		const runId = safeStoredIdentifier(
			typeof payload.requestedBy === "string" ? payload.requestedBy : origin.slice(origin.indexOf(":") + 1),
			ACP_MAX_WORKER_ASK_ID_BYTES,
		);
		const tool = safeStoredIdentifier(payload.tool, 64) ?? "a tool";
		const actionClass = safeStoredIdentifier(payload.actionClass, 32);
		const key = `${runId ?? "?"}\u0000${tool}`;
		if (told.has(key)) return;
		if (told.size >= ACP_UNANSWERED_WORKER_ASK_MEMORY) told.clear();
		told.add(key);
		const who = runId === null ? "A dispatched worker" : `Worker run ${runId}`;
		const what = actionClass === null ? tool : `${tool} (${actionClass})`;
		const fallback = payload.fallback === "fail" ? "fail, which ends the run" : "deny";
		const why = timedOut
			? `nobody answered before its window closed, so its fallback applied: ${fallback}.`
			: `it was refused by policy without asking anyone.${
					input.workerAsksEnabled()
						? ""
						: " This client did not opt into pancode/workerPermissions, so worker asks cannot reach it."
				}`;
		notice(sessionId, `\n\n${who} asked to use ${what}; ${why}\n`);
	});
}

interface AcpPermissionBridge {
	unregister(): void;
	/** Settles the outstanding permission request, if any, as cancellation. */
	cancelPending(reason: string): void;
}

/**
 * The closed set of option ids a `session/request_permission` from this server
 * offers, announced at initialize. `allow-once` grants; the two rejects deny and
 * differ only in what happens to the rest of the turn. `allow-session-scope`
 * rides only a sandbox escape whose card names a session scope (M-7), and grants
 * the call and that scope. A client that returns anything this ask did not offer
 * is denied, so minting `allow-always` cannot buy a grant this server never offered.
 */
export const ACP_PERMISSION_OPTION_IDS = [
	"allow-once",
	"reject-once",
	"reject-and-stop",
	"allow-session-scope",
] as const;

/** Bound for one line of decision copy. The longest of them is well under this. */
const ACP_MAX_DECISION_COPY_BYTES = 512;

/**
 * One line of decision copy, scrubbed as the call's title is ahead of its bound: the meta quotes the operator's request
 * and the call target, either of which can carry the credential the title hides (M-53).
 */
function decisionCopy(value: string): string {
	return boundString(redactCallText(sanitizeCallTargetText(value)), ACP_MAX_DECISION_COPY_BYTES);
}

/**
 * The classification the server already performed to label the two options,
 * attached to the ask instead of discarded. Everything here is host-derived:
 * the copy is generated from enforced policy facts, and the one caller-shaped
 * value, the call target, is rendered from the tool's own field allowlist and
 * sanitized before it is bounded. No model-authored prose reaches this record,
 * which is what lets a client render it as an authority statement rather than
 * as tool output.
 */
function decisionMeta(
	facts: TrustedDecisionFacts,
	presentation: DecisionPresentation,
	callTarget: string,
	consequence: ReadonlyArray<string>,
	mutation: MutationFacts | null = null,
	task?: ApprovalRequestView["task"],
): Record<string, unknown> {
	const axis =
		facts.axis.kind === "safety-net"
			? { kind: facts.axis.kind, ruleId: decisionCopy(facts.axis.ruleId) }
			: facts.axis.kind === "autonomy"
				? { kind: facts.axis.kind, level: decisionCopy(facts.axis.level) }
				: { kind: facts.axis.kind };
	const origin =
		facts.origin.kind === "worker"
			? {
					kind: facts.origin.kind,
					agentId: decisionCopy(facts.origin.agentId),
					runId: decisionCopy(facts.origin.runId),
				}
			: { kind: facts.origin.kind };
	const target = decisionCopy(callTarget);
	// What a bash command would do, one sentence per step. The sentences are
	// written by the host from the full command, so a client renders them beside
	// the generic consequence copy instead of re-deriving them from `target`,
	// which is flattened to one line and cut.
	const consequenceLines = consequence
		.slice(0, COMMAND_CONSEQUENCE_MAX_SEVERE + 1)
		.map(decisionCopy)
		.filter((line) => line.length > 0);
	return {
		[ACP_DECISION_META_KEY]: {
			version: 1,
			tier: presentation.tier,
			tierLabel: decisionCopy(presentation.tierLabel),
			title: decisionCopy(presentation.title),
			semanticToken: presentation.semanticToken,
			authorizationCopy: decisionCopy(presentation.authorizationCopy),
			consequenceCopy: decisionCopy(presentation.consequenceCopy),
			reversibilityCopy: decisionCopy(presentation.reversibilityCopy),
			requestedByCopy: decisionCopy(presentation.requestedByCopy),
			actionClass: facts.actionClass ?? "unknown",
			axis,
			origin,
			exposure: facts.exposure,
			affectedScope: facts.affectedScope,
			reversibility: facts.reversibility,
			...(target.length > 0 ? { target } : {}),
			...(consequenceLines.length > 0 ? { consequenceLines } : {}),
			// The size and digest of a parked write or edit, the facts the terminal
			// card shows on its mutation row. Only numbers, an enum and a hex digest,
			// so a client can bind what it renders from `rawInput` to the exact call
			// it approves.
			...(mutation !== null ? { mutation } : {}),
			// The operator's own last message, read from the session ledger, never model prose.
			...(task !== undefined
				? {
						task: {
							text: decisionCopy(task.text),
							...(task.via !== undefined ? { via: decisionCopy(task.via) } : {}),
						},
					}
				: {}),
		},
	};
}

/**
 * Who answered an ask, by the client's surface. The PanCode GUI is the operator's own window onto this session, so
 * its card is the operator answering, as the terminal card is. Any other ACP client answers as itself, and the model
 * is never told this session's operator approved (#434).
 */
function askAnswerer(surface: AcpClientSurface): { decidedBy: string; grantRequestedBy: string; name: string } {
	return surface === "gui"
		? { decidedBy: "operator", grantRequestedBy: "gui:operator", name: "The operator" }
		: { decidedBy: "acp-client", grantRequestedBy: "acp-client", name: "ACP client" };
}

export function installPermissionBridge(input: {
	transport: AcpJsonRpcPeerTransport;
	toolRegistry: ToolRegistry | undefined;
	bus?: TelemetryHub;
	activeSessionId: () => string | null;
	/**
	 * The wire id of the engine id's most recently opened tool call, or null when
	 * it names no call the client currently has open. Lookup only: this never
	 * mints a wire id, so an engine id nothing was emitted for fails closed.
	 */
	resolveToolCallId: (engineToolCallId: string) => string | null;
	/** The wire id of the turn's one open tool call, or null when it is not exactly one. */
	soleOpenToolCallId: () => string | null;
	/**
	 * What this wire id's `tool_call` update put on the wire, or null when this
	 * turn emitted no such call. The ask repeats it verbatim; nothing here is
	 * rebuilt from the registry's arguments.
	 */
	toolCallSnapshot: (wireId: string) => AcpToolCallSnapshot | null;
	/** The window a client-facing ask gets, read per ask because the client negotiates it at initialize. */
	permissionTimeoutMs: () => number;
	clientSurface: () => AcpClientSurface;
	expireActivePrompt: () => void;
	cancelActivePrompt: (reason: string) => void;
	/** Forwarded worker asks; absent leaves them to the worker's own timeout fallback. */
	workerAsks?: AcpWorkerAskPort;
	/** Shows a warning in the active turn when a worker's ask was settled with no one answering it. */
	workerAskNotice?: (sessionId: string, text: string) => void;
	diagnostics?: (line: string) => void;
	/** The session ledger a main-agent ask reads the operator's request from. */
	session?: SessionContract;
}): AcpPermissionBridge {
	// One client-facing ask at a time: a main-agent ask and a forwarded worker ask
	// share this queue because the client holds a single pending permission.
	const queue: AcpPermissionQueue = { chain: Promise.resolve(), cancel: null, cancelWorkers: null };
	const unregisterAskBridge = installWorkerAskBridge(input, queue);
	const unregisterUnansweredNotice = installUnansweredWorkerAskNotice({
		...(input.bus !== undefined ? { bus: input.bus } : {}),
		activeSessionId: input.activeSessionId,
		workerAsksEnabled: () => input.workerAsks?.enabled() === true,
		...(input.workerAskNotice !== undefined ? { notice: input.workerAskNotice } : {}),
	});
	const unregisterWorkerAsks = (): void => {
		unregisterAskBridge();
		unregisterUnansweredNotice();
	};
	if (!input.toolRegistry) {
		return {
			unregister: unregisterWorkerAsks,
			cancelPending: (reason) => {
				queue.cancelWorkers?.();
				queue.cancel?.(reason);
			},
		};
	}
	const queuedRequestIds = new Set<string>();
	const queuedRequestDetails = new Map<string, { tool: string; actionClass: string }>();
	const unregister = input.toolRegistry.onPermissionRequired((call, decision, meta) => {
		if (queuedRequestIds.has(meta.requestId)) return;
		// The facts are kept, not just the presentation built from them. The ask
		// used to throw away everything but two label strings, leaving a client to
		// re-derive the tier and the consequence from a tool name it cannot
		// classify.
		const facts = decisionFactsForPermission({
			tool: redactUrlCredentials(call.tool),
			actionClass: decision.classification.actionClass,
			axis: meta.axis.startsWith("net:")
				? { kind: "safety-net", ruleId: meta.axis.slice("net:".length) || "unknown" }
				: { kind: "autonomy", level: meta.axis.slice("autonomy:".length) || DEFAULT_AUTONOMY_LEVEL },
			origin: { kind: "main" },
			exposure: call.tool === ToolNames.AskUser ? askUserExposure(call.args) : mainCallExposure(call, decision),
			...(meta.dispatchPlan !== undefined ? { workers: meta.dispatchPlan.taskCount } : {}),
		});
		// A dispatch plan is named by what one approval starts, as the terminal card names it.
		const planTitle = meta.dispatchPlan !== undefined ? dispatchPlanTitle(meta.dispatchPlan) : undefined;
		const presentation = classifyDecisionPresentation(facts);
		const approveAction = presentation.requiredActions.find((action) => action.id === "approve-once");
		const denyAction = presentation.requiredActions.find((action) => action.id === "deny");
		const stopAction = presentation.requiredActions.find((action) => action.id === "stop");
		const answerer = askAnswerer(input.clientSurface());
		queuedRequestIds.add(meta.requestId);
		queuedRequestDetails.set(meta.requestId, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
		});
		const resolve = (
			payload: { status: "granted" | "denied" | "expired"; decidedBy: string; reason?: string },
			action: "grant" | "deny" | "stop" | "expire" = "deny",
			beforeRelease?: () => void,
			reason?: string,
			sessionScope?: true,
		) =>
			resolvePermission(
				{ ...(input.bus ? { bus: input.bus } : {}), ...(input.toolRegistry ? { registry: input.toolRegistry } : {}) },
				{
					action,
					payload: {
						...payload,
						requestId: meta.requestId,
						origin: "acp-server",
						tool: call.tool,
						actionClass: decision.classification.actionClass,
					},
					...(action === "grant" ? { grantRequestedBy: answerer.grantRequestedBy } : {}),
					...(action === "grant" && sessionScope === true ? { sessionScope } : {}),
					...(beforeRelease ? { beforeRelease } : {}),
					...(reason !== undefined ? { reason } : {}),
				},
			);
		const emitQueuedErrorResolutions = (currentRequestId: string, reason: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				emitApproval(input.bus, "approval.resolved", {
					status: "denied",
					requestId,
					origin: "acp-server",
					decidedBy: "error",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason,
				});
			}
		};
		const emitQueuedExpiryResolutions = (currentRequestId: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				emitApproval(input.bus, "approval.resolved", {
					status: "expired",
					requestId,
					origin: "acp-server",
					decidedBy: "timeout",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason: "permission approval expired",
				});
			}
		};
		const run = async (): Promise<void> => {
			if (!queuedRequestIds.has(meta.requestId)) return;
			const sessionId = input.activeSessionId();
			const noSessionReason = "ACP permission requested with no active session";
			if (!sessionId) {
				void resolve({ status: "denied", decidedBy: "error", reason: noSessionReason }, "stop", () => {
					emitQueuedErrorResolutions(meta.requestId, noSessionReason);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
				});
				return;
			}
			// The client already rendered a tool_call under the engine's id; asking
			// about a different id would present the operator with a call they
			// cannot see. So the engine's id is resolved by lookup and nothing
			// else: an id no tool_call was emitted for, or one whose call the
			// client has already seen finish, binds to nothing. When the bridge
			// gets no engine id, the turn's one open call is the only binding that
			// can be right. Everything else fails closed: a bridge-local id nothing
			// on the client matches asked the operator to approve a call they had
			// no way to identify.
			const toolCallId =
				meta.toolCallId !== undefined && meta.toolCallId.length > 0
					? input.resolveToolCallId(meta.toolCallId)
					: input.soleOpenToolCallId();
			// The operator is being shown a call the client already rendered, so the
			// arguments in the ask are that frame's own: a tool's admission normalizer
			// can rewrite a relative path to an absolute one or attach a prepared
			// artifact, and rebuilding the record from the registry's copy produced a
			// `rawInput` the client could not match to anything it had drawn. A bound
			// id always has a snapshot, since every open call stored one when it was
			// emitted; the missing case fails closed anyway.
			const snapshot = toolCallId === null ? null : input.toolCallSnapshot(toolCallId);
			if (toolCallId === null || snapshot === null) {
				const unbindableReason = "permission request has no bindable tool call";
				void resolve({ status: "denied", decidedBy: "error", reason: unbindableReason });
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
				return;
			}
			// The transport has no per-request abort, so a cancelled prompt races
			// the outstanding request against a local deferral. The client's late
			// answer resolves a promise nothing is waiting on any more.
			const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolveCancelled) => {
				queue.cancel = (reason: string) => resolveCancelled({ kind: "cancelled", reason });
			});
			// A client that takes withdrawn asks gets the same notice for a main-session
			// ask that it gets for a worker's, keyed by the id on the request, so a card
			// a person answers minutes later from another device does not outlive the
			// ask. Every other client sees exactly the request it saw before.
			const withdrawable = input.workerAsks?.enabled() === true;
			const withdraw = (): void => {
				if (!withdrawable) return;
				try {
					input.workerAsks?.withdraw(sessionId, meta.requestId);
				} catch (err) {
					input.diagnostics?.(
						`permission ${meta.requestId} could not be withdrawn: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			};
			// Settled elsewhere: the parked call left the registry without this ask
			// answering it (its turn aborted, or another path stopped it). The registry
			// has no event for that, so the park is polled while the request is out.
			let settledPoll: ReturnType<typeof setInterval> | undefined;
			const registry = input.toolRegistry;
			const settledElsewhere = withdrawable
				? new Promise<{ kind: "settled" }>((resolveSettled) => {
						settledPoll = setInterval(() => {
							if (!registry?.isParked(meta.requestId)) resolveSettled({ kind: "settled" });
						}, ACP_MAIN_ASK_SETTLED_POLL_MS);
						settledPoll.unref?.();
					})
				: new Promise<never>(() => {});
			try {
				const answered = Promise.resolve()
					.then(() =>
						input.transport.request<unknown>(
							"session/request_permission",
							{
								sessionId,
								toolCall: {
									toolCallId,
									// A generic client shows only the title, so it names the call: the clipped, scrubbed command for a
									// shell call as refusals word it, a dispatch plan's headline, the tool and its target otherwise.
									title: boundString(
										redactUrlCredentials(
											decision.kind === "ask" && decision.confirmationRuleId === "dispatch-external-read"
												? `Scout read-only root: ${describeCallTarget(call.tool, call.args)}`
												: (planTitle ?? permissionTitle(call.tool, clippedCallCommand(call, decision))),
										),
										ACP_MAX_TOOL_TITLE_BYTES,
									),
									kind: toolKind(call.tool),
									status: "pending",
									rawInput: snapshot.rawInput,
									...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
								},
								options: [
									{
										optionId: "allow-once",
										name: approveAction?.label ?? "Approve once",
										kind: "allow_once",
									},
									{
										optionId: "reject-once",
										name: denyAction?.label ?? "Deny this request",
										kind: "reject_once",
									},
									// The TUI's third action, which the wire had no
									// equivalent for. It is `reject_once` and not
									// `reject_always`: it grants no standing denial, it
									// ends this run. A client that renders only the spec
									// kinds shows it as a second deny, which is a true
									// reading of what it does.
									{
										optionId: "reject-and-stop",
										name: stopAction?.label ?? "Deny and stop",
										kind: "reject_once",
									},
									// A sandbox escape's session option (M-7): its label is the scope it grants.
									...(meta.escapeScope !== undefined
										? [
												{
													optionId: "allow-session-scope",
													name: escapeScopeOptionLabel(meta.escapeScope),
													kind: "allow_always",
												},
											]
										: []),
								],
								_meta: {
									...decisionMeta(
										facts,
										presentation,
										planTitle ?? describeCallTarget(call.tool, call.args),
										describeMainCallConsequences(call),
										mutationFacts(call.tool, call.args),
										sessionApprovalTask(input.session, meta.turnId),
									),
									// The plan admission rendered, whose hash a plan-scale run seals.
									...(meta.dispatchPlan !== undefined
										? { [ACP_DISPATCH_PLAN_META_KEY]: projectDispatchPlanMeta(meta.dispatchPlan) }
										: {}),
									...(withdrawable ? { [ACP_PERMISSION_ASK_META_KEY]: { version: 1, requestId: meta.requestId } } : {}),
								},
							},
							input.permissionTimeoutMs(),
						),
					)
					.then(
						(response) => ({ kind: "response" as const, response }),
						(err: unknown) => ({ kind: "failed" as const, err }),
					);
				const outcome = await Promise.race([answered, cancelled, settledElsewhere]);
				if (outcome.kind === "settled") {
					withdraw();
					return;
				}
				if (outcome.kind === "cancelled") {
					withdraw();
					void resolve({ status: "denied", decidedBy: "cancelled", reason: outcome.reason });
					return;
				}
				if (outcome.kind === "response") {
					// Exactly one option grants. `startsWith("allow")` would let a
					// client mint `allow-always` and get a grant this server never
					// offered as an option.
					const response = outcome.response;
					const answer = isRecord(response) && isRecord(response.outcome) ? response.outcome : null;
					if (
						answer === null ||
						(answer.outcome !== "cancelled" &&
							(answer.outcome !== "selected" ||
								typeof answer.optionId !== "string" ||
								!ACP_PERMISSION_OPTION_IDS.some((id) => id === answer.optionId) ||
								(answer.optionId === "allow-session-scope" && meta.escapeScope === undefined)))
					) {
						throw new Error("malformed ACP permission response: expected cancellation or an offered optionId");
					}
					if (answer.outcome === "cancelled") {
						const reason = "ACP client cancelled permission";
						// Abort before releasing the parked tools so their results cannot
						// start another model request while session/cancel is in flight.
						input.cancelActivePrompt(reason);
						void resolve({ status: "denied", decidedBy: "cancelled", reason }, "stop", () => {
							queuedRequestIds.clear();
							queuedRequestDetails.clear();
						});
						return;
					}
					// Deny-and-stop is the TUI's `s` action on the wire: it denies
					// every parked request from this turn and ends the run, not just
					// the one the operator is looking at. It orders like the client
					// cancellation above rather than like a plain denial, because a
					// parked call released before the prompt aborts can start another
					// model request while the abort is in flight.
					if (answer.outcome === "selected" && answer.optionId === "reject-and-stop") {
						const reason = `${answerer.name} denied this tool call and stopped the run`;
						input.cancelActivePrompt(reason);
						void resolve({ status: "denied", decidedBy: answerer.decidedBy, reason }, "stop", () => {
							queuedRequestIds.clear();
							queuedRequestDetails.clear();
						});
						return;
					}
					if (answer.outcome === "selected" && answer.optionId === "allow-once") {
						await resolve({ status: "granted", decidedBy: answerer.decidedBy }, "grant");
						return;
					}
					if (answer.outcome === "selected" && answer.optionId === "allow-session-scope") {
						await resolve({ status: "granted", decidedBy: answerer.decidedBy }, "grant", undefined, undefined, true);
						return;
					}
					void resolve({
						status: "denied",
						decidedBy: answerer.decidedBy,
						reason: `${answerer.name} denied this tool call`,
					});
					return;
				}
				const err = outcome.err;
				const message = `ACP permission request failed: ${err instanceof Error ? err.message : String(err)}`;
				// The client may still show the card for a request that failed or timed out on this side.
				withdraw();
				if (err instanceof AcpTimeoutError) {
					void resolve({ status: "expired", decidedBy: "timeout", reason: "permission approval expired" }, "expire", () => {
						emitQueuedExpiryResolutions(meta.requestId);
						queuedRequestIds.clear();
						queuedRequestDetails.clear();
						input.expireActivePrompt();
					});
					return;
				}
				void resolve({ status: "denied", decidedBy: "error", reason: message }, "stop", () => {
					emitQueuedErrorResolutions(meta.requestId, message);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
				});
			} finally {
				if (settledPoll !== undefined) clearInterval(settledPoll);
				queue.cancel = null;
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
			}
		};
		enqueuePermissionRequest(
			queue,
			run,
			(reason) => {
				queue.cancel = null;
				return resolve({ status: "denied", decidedBy: "error", reason }, "stop", () => {
					emitQueuedErrorResolutions(meta.requestId, reason);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
				});
			},
			input.diagnostics,
		);
	});
	return {
		unregister: () => {
			unregister();
			unregisterWorkerAsks();
		},
		cancelPending: (reason: string) => {
			queue.cancelWorkers?.();
			queue.cancel?.(reason);
		},
	};
}
