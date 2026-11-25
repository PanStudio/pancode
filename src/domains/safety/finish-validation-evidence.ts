// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { isProjectVerifierCheckId, isVerificationScriptName } from "../../core/verification-scripts.js";
import { PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../../tools/verify/catalog.js";
import { trustVerdict } from "../evidence/trust-projection.js";
import { validateTrustStatus } from "../evidence/trust-status.js";
import type { ObservedCheck } from "../session/task-board.js";
import type { DeclaredVerifierCommand } from "./declared-checks.js";
import { declaredCheckRuns, isWithinWorkspace } from "./declared-checks.js";
import type {
	FinishContractEvidence,
	ToolCallEvidenceCandidate,
	ValidationExecutionEvidence,
} from "./finish-contract.js";
import {
	acceptanceValidationCommand,
	asRecord,
	capabilityEntries,
	pushEvidence,
	stringFromFirst,
	successfulToolResultId,
	turnIdOf,
	validationCheckFields,
	validationCheckId,
} from "./finish-entries.js";
import { scanShellLike } from "./shell-scan.js";

/**
 * Receipt-based validation evidence over the recent window: shell and operator
 * `!` checks the shared fold settled, verify check runs, passed dispatch
 * receipts, and protected-artifact records. The finish vocabulary
 * (`detectValidationCommand`) only labels a shell check and admits its package
 * execution; it never decides whether one is credited.
 * Inspection was removed because inspecting the repo is never a mutation, so it
 * can no longer be on the path to engaging the contract.
 */
export function collectValidationEvidence(
	recent: ReadonlyArray<unknown>,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
	standing: ReadonlyMap<string, ObservedCheck>,
): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const toolCalls = new Map<string, ToolCallEvidenceCandidate>();
	const declaredRuns = new Map<string, ToolCallEvidenceCandidate[]>();
	const dispatchCalls = new Map<string, ToolCallEvidenceCandidate>();
	const shellCalls = new Map<string, string | null>();
	const seen = new Set<string>();
	const entries = capabilityEntries(recent);
	// A check run through the shell, `verify`, an operator's `!` or a dispatch run record counts only where the shared
	// fold settled its pass and no later change retired it, the same fold the task board and the recorder's change
	// sequence use (x7-5, x8-1). `standing` keys a call by its id and a `!` run by `#<index>` into these same entries.

	for (const [index, entry] of entries.entries()) {
		const protectedArtifact = protectedArtifactEvidence(entry);
		if (protectedArtifact !== null) {
			pushEvidence(evidence, seen, protectedArtifact);
			continue;
		}

		// A declared check credits on its own terms even when the command is also a generic validation command.
		const declaredCalls = bashDeclaredVerifierCalls(entry, workspaceRoot, declared);
		const declaredCallId = declaredCalls[0]?.toolCallId;
		if (declaredCallId !== undefined) declaredRuns.set(declaredCallId, declaredCalls);

		const call = bashValidationCall(entry, acceptanceChecks, workspaceRoot);
		if (call !== null) {
			toolCalls.set(call.toolCallId, call);
			continue;
		}
		if (declaredCallId !== undefined) continue;
		const shellCallId = bashCallId(entry);
		if (shellCallId !== null) {
			shellCalls.set(shellCallId, turnIdOf(entry));
			continue;
		}

		const typedValidationCall = validationToolCall(entry);
		if (typedValidationCall !== null) {
			toolCalls.set(typedValidationCall.toolCallId, typedValidationCall);
			continue;
		}

		const dispatchCall = dispatchEvidenceCall(entry);
		if (dispatchCall !== null) {
			dispatchCalls.set(dispatchCall.toolCallId, dispatchCall);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const pass = standing.get(resultId);
			if (pass === undefined) continue;
			const dispatchRunRecord = dispatchRunRecordEvidence(entry, dispatchCalls.get(resultId));
			if (dispatchRunRecord !== null) {
				pushEvidence(evidence, seen, dispatchRunRecord);
				continue;
			}
			const candidate = toolCalls.get(resultId);
			if (candidate !== undefined) {
				pushEvidence(evidence, seen, validationEvidence(candidate, entry));
				for (const declaredCandidate of verifyDeclaredVerifierRuns(candidate, entry, workspaceRoot, declared))
					pushEvidence(evidence, seen, validationEvidence(declaredCandidate, entry));
			}
			for (const declaredCandidate of declaredRuns.get(resultId) ?? [])
				pushEvidence(evidence, seen, validationEvidence(declaredCandidate, entry));
			if (shellCalls.has(resultId))
				pushEvidence(evidence, seen, observedCheckEvidence(pass, shellCalls.get(resultId) ?? null));
			continue;
		}

		const pass = standing.get(`#${index}`);
		if (pass === undefined) continue;
		const bashExecution = bashExecutionEvidence(entry, acceptanceChecks, workspaceRoot);
		const declaredExecutions = bashExecutionDeclaredEvidence(entry, workspaceRoot, declared);
		if (bashExecution !== null) pushEvidence(evidence, seen, bashExecution);
		for (const declaredExecution of declaredExecutions) pushEvidence(evidence, seen, declaredExecution);
		if (bashExecution === null && declaredExecutions.length === 0) {
			const marker = asRecord(entry)?.excludeFromContext === true ? " [not sent to model]" : "";
			pushEvidence(evidence, seen, observedCheckEvidence(pass, turnIdOf(entry), marker));
		}
	}

	return evidence;
}

function bashValidationCall(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "bash") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const command = typeof args?.command === "string" ? args.command : null;
	if (command === null) return null;
	const execution = workspaceValidationCommand(command, args?.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: detected.matched,
		...validationCheckFields(detected.matched),
		execution: packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/** A model `bash` call's id, for a check the shared fold settles that the finish vocabulary does not name. */
function bashCallId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null || stringFromFirst(payload, ["name", "toolName", "tool"]) !== "bash") return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
}

/**
 * A pass the shared classifier settled and no later change retired, credited under the name the fold filed it by
 * (`cargo clippy`, `mypy .`) when the finish vocabulary has no label for it, so the gate and the receipt agree (x8-1).
 */
function observedCheckEvidence(pass: ObservedCheck, turnId: string | null, marker = ""): FinishContractEvidence {
	return {
		kind: "validation_command",
		summary: `validation command passed: ${pass.name}${marker}`,
		...(pass.check ? { check: pass.check } : {}),
		...(turnId !== null ? { turnId } : {}),
	};
}

/** A model `bash` call's runs of declared checks, each credited when the call's result succeeds. */
function bashDeclaredVerifierCalls(
	entry: unknown,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): ToolCallEvidenceCandidate[] {
	if (declared.length === 0 || workspaceRoot === undefined) return [];
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return [];
	const payload = asRecord(record.payload);
	if (payload === null || stringFromFirst(payload, ["name", "toolName", "tool"]) !== "bash") return [];
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (typeof args?.command !== "string") return [];
	const execution = workspaceValidationCommand(args.command, args.cwd, workspaceRoot);
	if (execution === null) return [];
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return [];
	const turnId = turnIdOf(entry);
	return declaredCheckRuns(args.command, shellBase(workspaceRoot, args.cwd), declared).map(({ check }) => {
		const catalog = catalogCheckExecution(check, workspaceRoot);
		return {
			toolCallId,
			command: `${execution.command.trim()} (declared check ${check.id})`,
			check: check.id,
			...(catalog !== undefined ? { execution: catalog } : {}),
			...(turnId !== null ? { turnId } : {}),
		};
	});
}

/** A `verify` run credits the declared checks its command runs, as the same command through `bash` does. */
function verifyDeclaredVerifierRuns(
	candidate: ToolCallEvidenceCandidate,
	entry: unknown,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): ToolCallEvidenceCandidate[] {
	if (declared.length === 0 || workspaceRoot === undefined) return [];
	const payload = asRecord(asRecord(entry)?.payload);
	if (payload === null || stringFromFirst(payload, ["toolName", "name", "tool"]) !== "verify") return [];
	const details = asRecord(asRecord(payload.result)?.details);
	const command = details?.command;
	if (typeof command !== "string") return [];
	return declaredCheckRuns(command, shellBase(workspaceRoot, details?.cwd), declared).map(({ check }) => {
		const catalog = catalogCheckExecution(check, workspaceRoot);
		return {
			toolCallId: candidate.toolCallId,
			command: `${command} (declared check ${check.id})`,
			check: check.id,
			...(catalog !== undefined ? { execution: catalog } : {}),
			...(candidate.turnId !== undefined ? { turnId: candidate.turnId } : {}),
		};
	});
}

/** A catalog check run through the shell keeps its declaration's source, cwd and argv, as a package script run does. */
function catalogCheckExecution(
	check: DeclaredVerifierCommand,
	workspaceRoot: string,
): ValidationExecutionEvidence | undefined {
	if (check.session || check.segments.length !== 1) return undefined;
	return {
		source: { kind: "project-catalog", path: resolve(workspaceRoot, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH) },
		cwd: check.cwd,
		argv: [...(check.segments[0] ?? [])],
	};
}

function shellBase(workspaceRoot: string, cwd: unknown): string {
	return resolve(workspaceRoot, typeof cwd === "string" && cwd.length > 0 ? cwd : ".");
}

/** An operator `!` run's declared checks; the run carries its own exit code. */
function bashExecutionDeclaredEvidence(
	entry: unknown,
	workspaceRoot: string | undefined,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): FinishContractEvidence[] {
	if (declared.length === 0 || workspaceRoot === undefined) return [];
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution" || typeof record.command !== "string") return [];
	if (record.cancelled === true || record.exitCode !== 0) return [];
	const execution = workspaceValidationCommand(record.command, record.cwd, workspaceRoot);
	if (execution === null) return [];
	const turnId = turnIdOf(entry);
	return declaredCheckRuns(record.command, shellBase(workspaceRoot, record.cwd), declared).map(({ check }) => ({
		kind: "validation_command",
		summary: `validation command passed: ${execution.command.trim()} (declared check ${check.id})`,
		check: check.id,
		...(catalogCheckExecution(check, workspaceRoot) ?? {}),
		...(turnId !== null ? { turnId } : {}),
	}));
}

function dispatchEvidenceCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== "dispatch") return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const { agentId, task } = dispatchCallDescriptor(args);
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: `agent=${agentId}${task.length > 0 ? ` task=${task}` : ""}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * Agent id and lead task text for a dispatch call, tolerant of both the toolkit
 * v2 `tasks` array (task strings or {agent, task} objects, with an optional
 * shared default agent) and the single `task` argument. Only the first
 * task seeds the summary; it feeds the receipt evidence's agent fallback and the
 * audit line, never the gate decision itself.
 */
function dispatchCallDescriptor(args: Record<string, unknown> | null): { agentId: string; task: string } {
	const defaultAgent = stringFromFirst(args ?? {}, ["agent", "agent_id", "agentId"]);
	const tasks = Array.isArray(args?.tasks) ? args.tasks : null;
	if (tasks !== null && tasks.length > 0) {
		const first = tasks[0];
		if (typeof first === "string") {
			return { agentId: defaultAgent ?? "coder", task: first.trim() };
		}
		const firstRecord = asRecord(first);
		const itemAgent = firstRecord === null ? null : stringFromFirst(firstRecord, ["agent", "agent_id", "agentId"]);
		const itemTask = typeof firstRecord?.task === "string" ? firstRecord.task.trim() : "";
		return { agentId: itemAgent ?? defaultAgent ?? "coder", task: itemTask };
	}
	const singleTask = typeof args?.task === "string" ? args.task.trim() : "";
	return { agentId: defaultAgent ?? "coder", task: singleTask };
}

function validationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName === null) return null;
	const summary = typedValidationSummary(toolName, payload);
	if (summary === null) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		command: summary,
		...validationCheckFields(summary),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}

/**
 * The canonical command a typed validation tool call stands for, or null when
 * the call is not a validation. Exported because run-effects grounds a mutation
 * report's claimed validations against the same notion this gate uses.
 */
export function typedValidationSummary(toolName: string, payload: Record<string, unknown>): string | null {
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	if (toolName === "verify") {
		const check = typeof args?.check === "string" ? args.check.trim() : "";
		if (check === "frontend") {
			const path = typeof args?.path === "string" && args.path.trim().length > 0 ? args.path.trim() : "artifact";
			return `verify frontend ${path}`;
		}
		if (isVerificationScriptName(check)) return `npm run ${check}`;
		if (isProjectVerifierCheckId(check)) return `verify ${check}`;
		return null;
	}
	return null;
}

export function dispatchRunRecordEvidence(
	entry: unknown,
	candidate: ToolCallEvidenceCandidate | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["toolName", "name", "tool"]);
	if (toolName !== null && toolName !== "dispatch") return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (details === null) return null;
	const summary = passedDispatchRunRecordSummary(details, candidate);
	if (summary === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "dispatch_run_record",
		summary,
	};
	const turnId = candidate?.turnId ?? turnIdOf(entry);
	if (turnId !== null && turnId !== undefined) evidence.turnId = turnId;
	return evidence;
}

/**
 * Summarizes a dispatch result as passed-run evidence, or null when it is
 * not a passing dispatch. Handles the toolkit v2 batch shape
 * (`{mode, runIds, runCount, failedCount, runs:[{runId, agentId, exitCode}]}`
 * where exit codes live per-run) as well as the single-run shape
 * (`{exitCode, runId, agentId}`). A batch counts only when it has at least one
 * run and every run exited cleanly. Current results must also carry verified
 * integrity and validated evidence on their canonical trust axes, so failed or
 * ungrounded checks never become validation evidence through process success.
 */
function passedDispatchRunRecordSummary(
	details: Record<string, unknown>,
	candidate: ToolCallEvidenceCandidate | undefined,
): string | null {
	if (Array.isArray(details.runs)) {
		const runs = details.runs.map(asRecord);
		if (runs.length === 0 || runs.some((run) => run === null || !passedDispatchRun(run))) return null;
		if (typeof details.failedCount === "number" && details.failedCount !== 0) return null;
		const first = runs[0];
		const runId = typeof first?.runId === "string" && first.runId.length > 0 ? first.runId : "unknown";
		const agentId = dispatchRunRecordAgentId(typeof first?.agentId === "string" ? first.agentId : undefined, candidate);
		const extra = runs.length > 1 ? ` (+${runs.length - 1} more)` : "";
		return `dispatch run record passed: run ${runId} agent ${agentId}${extra}`;
	}
	if (passedDispatchRun(details)) {
		const runId = typeof details.runId === "string" && details.runId.length > 0 ? details.runId : "unknown";
		const agentId = dispatchRunRecordAgentId(
			typeof details.agentId === "string" ? details.agentId : undefined,
			candidate,
		);
		return `dispatch run record passed: run ${runId} agent ${agentId}`;
	}
	return null;
}

function passedDispatchRun(run: Record<string, unknown>): boolean {
	if (run.exitCode !== 0) return false;
	// Historical results predate canonical trust status. For current results,
	// a clean process exit cannot overrule failed, absent, or ungrounded validation.
	if (!("trustStatus" in run)) return true;
	// The child's assurance is the one value read (fleet design 4.8): only a grounded or reviewed result is evidence.
	const trust = validateTrustStatus(run.trustStatus);
	if (!trust.ok) return false;
	const assurance = trustVerdict(trust.status);
	return assurance === "grounded" || assurance === "reviewed";
}

/** Prefer the receipt's own agent id, then the dispatch call's, then unknown. */
function dispatchRunRecordAgentId(
	runAgentId: string | undefined,
	candidate: ToolCallEvidenceCandidate | undefined,
): string {
	if (runAgentId !== undefined && runAgentId.length > 0) return runAgentId;
	return candidate?.command.match(/^agent=([^\s]+)/)?.[1] ?? "unknown";
}

function bashExecutionEvidence(
	entry: unknown,
	acceptanceChecks: ReadonlySet<string>,
	workspaceRoot: string | undefined,
): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true) return null;
	if (record.exitCode !== 0) return null;
	const execution = workspaceValidationCommand(record.command, record.cwd, workspaceRoot);
	if (execution === null) return null;
	const detected = acceptanceValidationCommand(execution.command, acceptanceChecks);
	if (detected.kind !== "validation") return null;
	const contextMarker = record.excludeFromContext === true ? " [not sent to model]" : "";
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${detected.matched}${contextMarker}`,
		...validationCheckFields(detected.matched),
		...packageCommandExecution(execution.command, execution.cwd, workspaceRoot),
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function protectedArtifactEvidence(entry: unknown): FinishContractEvidence | null {
	const record = asRecord(entry);
	if (record?.kind !== "protectedArtifact" || record.action !== "protect") return null;
	const artifact = asRecord(record.artifact);
	const path = typeof artifact?.path === "string" && artifact.path.trim().length > 0 ? artifact.path.trim() : null;
	if (path === null) return null;
	const evidence: FinishContractEvidence = {
		kind: "protected_artifact",
		summary: `protected artifact recorded: ${path}`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) evidence.turnId = turnId;
	return evidence;
}

function validationEvidence(candidate: ToolCallEvidenceCandidate, entry: unknown): FinishContractEvidence {
	const evidence: FinishContractEvidence = {
		kind: "validation_command",
		summary: `validation command passed: ${candidate.command}`,
		...(candidate.check ? { check: candidate.check } : {}),
		...(candidate.execution ?? declaredCheckExecution(entry, candidate.check)),
	};
	if (candidate.turnId !== undefined) evidence.turnId = candidate.turnId;
	return evidence;
}

/** Preserve the verifier's execution facts only when they identify the declared check. */
function declaredCheckExecution(entry: unknown, check: string | undefined): ValidationExecutionEvidence {
	const payload = asRecord(asRecord(entry)?.payload);
	const details = asRecord(asRecord(payload?.result)?.details);
	const source = asRecord(details?.source);
	if (
		!details ||
		details.check !== check ||
		details.exitCode !== 0 ||
		details.aborted === true ||
		details.timedOut === true ||
		details.outputCapped === true ||
		(source?.kind !== "package.json" && source?.kind !== "project-catalog") ||
		typeof source.path !== "string" ||
		typeof details.cwd !== "string" ||
		!Array.isArray(details.argv) ||
		!details.argv.every((arg): arg is string => typeof arg === "string")
	)
		return {};
	if (source.kind === "project-catalog") {
		const argv = details.argv;
		if (
			!Array.isArray(details.declaredCommand) ||
			details.declaredCommand.length !== details.argv.length ||
			!details.declaredCommand.every((arg, index) => arg === argv[index]) ||
			typeof details.declaredCwd !== "string" ||
			typeof details.declaredTimeoutMs !== "number" ||
			typeof details.durationMs !== "number" ||
			details.durationMs > details.declaredTimeoutMs ||
			resolve(source.path, "../..", details.declaredCwd) !== details.cwd
		)
			return {};
	}
	return {
		source: { kind: source.kind, path: source.path },
		cwd: details.cwd,
		argv: details.argv,
		...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
	};
}

/** Resolve a literal leading cd without crediting checks from a different workspace. */
function workspaceValidationCommand(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): { command: string; cwd: unknown } | null {
	const tokens = scanShellLike(command);
	if (tokens[0]?.value !== "cd") return { command, cwd };
	const directory = tokens[1];
	const separator = tokens[2];
	if (
		!workspaceRoot ||
		!directory ||
		directory.operator ||
		directory.substitutions?.length ||
		directory.homeRelative ||
		/[$`]/u.test(directory.value) ||
		separator?.operator !== true ||
		separator.value !== "&&"
	)
		return null;
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".", directory.value);
	if (!isWithinWorkspace(executionCwd, workspaceRoot)) return null;
	return { command: command.slice(separator.end).trim(), cwd: executionCwd };
}

/** Exact package commands retain their execution cwd; a matched substring proves no project identity. */
function packageCommandExecution(
	command: string,
	cwd: unknown,
	workspaceRoot: string | undefined,
): ValidationExecutionEvidence {
	if (
		!workspaceRoot ||
		!/^(?:npm|pnpm|yarn|bun) /u.test(command.trim()) ||
		validationCheckId(command.trim()) === undefined
	)
		return {};
	const executionCwd = resolve(workspaceRoot, typeof cwd === "string" ? cwd : ".");
	return {
		source: { kind: "package.json", path: resolve(executionCwd, "package.json") },
		cwd: executionCwd,
		argv: command.trim().split(/\s+/u),
	};
}
