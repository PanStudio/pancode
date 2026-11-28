// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../core/hash.js";
import {
	carriesHostFraming,
	carriesToolResultNote,
	recordedToolResultNotes,
	TOOL_RESULT_HOST_NOTES_KEY,
	TOOL_RESULT_NOTES_SEPARATOR,
	toolResultNote,
} from "../../core/reminder-framing.js";
import { ToolNames } from "../../core/tool-names.js";
import { containsInstructionMarkers, INSTRUCTION_SHAPED_NOTE } from "../../core/untrusted-content.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareMetadataValue,
} from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { callVerdict, echoedCheckExit } from "../../domains/safety/check-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { FlowRestrictionSet } from "../../domains/safety/information-flow.js";
import { hashToolCall } from "../../domains/safety/loop-detector.js";
import { detectValidationCommand } from "../../domains/safety/protected-artifacts.js";
import type { ToolResultDigest } from "../result-disposition.js";
import { toolResultContextText } from "../result-disposition.js";
import { shellExitSpeaksForCommand } from "../shell-exit-scope.js";
import type { ToolMetadata, ToolResult, ToolResultDetails, ToolSpec } from "../tool-spec.js";
import type { ToolInvokeOptions } from "./contract.js";

export function buildToolHookInput(
	hook: "before_tool" | "after_tool",
	spec: ToolSpec,
	call: ClassifierCall,
	decision: SafetyDecision,
	options: ToolInvokeOptions | undefined,
	result: ToolResult | undefined,
	resultDigest: ToolResultDigest | undefined,
	carriedFlow: FlowRestrictionSet | null,
	effectiveMetadata: ToolMetadata | undefined,
): MiddlewareHookInput {
	const metadata: Record<string, MiddlewareMetadataValue> = {
		posture: "operating",
		actionClass: decision.classification.actionClass,
		decisionKind: decision.kind,
		repeatableRead: effectiveMetadata?.repeatableRead === true,
	};
	// Declared effect of the tool the call runs (a gateway call's capability), for the loop guard (F-C13).
	if (effectiveMetadata?.readOnly !== undefined) metadata.toolReadOnly = effectiveMetadata.readOnly;
	if (effectiveMetadata?.idempotent !== undefined) metadata.toolIdempotent = effectiveMetadata.idempotent;
	// Stable call identity for repetition detectors (engine/loop-guard.ts).
	// Computed for before_tool only; after_tool consumers identify the call
	// via toolCallId.
	if (hook === "before_tool") metadata.callFingerprint = hashToolCall(spec.name, call.args ?? {});
	// What the session already carries, so an adviser sees the restriction
	// before any model send; the result's own label rides on toolResultDetails.
	if (carriedFlow !== null)
		metadata.flowRuleIds = JSON.stringify([...new Set(carriedFlow.restrictions.map((r) => r.ruleId))]);
	// A nested invocation (gateway → capability) is the model's one call seen
	// twice by the hook layer; the loop guard counts and fingerprints only the
	// outer occurrence. Every other hook still fires under the inner name.
	if (options?.nested === true) metadata.nested = true;
	if (options?.origin === "harness") metadata.origin = "harness";
	// A prompt template's turn bounds, for the loop guard's per-turn budget and step policy.
	const { budget, turnPolicy } = options?.turnConstraints ?? {};
	if (budget?.toolCalls !== undefined) metadata.templateToolCalls = budget.toolCalls;
	if (options?.batchSize !== undefined) metadata.batchSize = options.batchSize;
	if (options?.turnBudgetContinues !== undefined) metadata.turnBudgetContinues = options.turnBudgetContinues;
	if (options?.turnBudgetScale !== undefined) metadata.turnBudgetScale = options.turnBudgetScale;
	if (turnPolicy !== undefined) metadata.templateStepTool = turnPolicy.stepTool;
	const template = budget?.template ?? turnPolicy?.template;
	if ((budget?.toolCalls !== undefined || turnPolicy !== undefined) && template) metadata.templateName = template;
	// An approval the operator granted, not the judge's, so guidance can count real stops.
	if (options?.approval !== undefined && (options.approval.issuer ?? "operator") === "operator")
		metadata.operatorApproved = true;
	const validationCommand = detectedValidationCommand(call);
	if (validationCommand !== null) {
		metadata.validationCommand = validationCommand;
		// After `pytest; echo done` the status is echo's: the check is named, its outcome stays unknown. After
		// `pytest; echo "EXIT=$?"` the status the check printed is its own.
		const echoed = result?.kind === "ok" ? echoedCheckExit(result.details) : null;
		if (echoed !== null) metadata.validationExitCode = echoed;
		else if (result?.kind === "ok" && shellExitSpeaksForCommand(commandArg(call.args) ?? ""))
			metadata.validationExitCode = 0;
	}
	if (call.tool !== spec.name) metadata.requestedToolName = call.tool;
	if (result !== undefined) {
		if (
			hook === "after_tool" &&
			["web_fetch", "read", "grep", "find", "bash", "dispatch", "monitor"].includes(spec.name)
		) {
			const text = result.kind === "ok" ? result.output : result.kind === "error" ? result.message : "";
			// Read, grep and find quote file bytes or names that must stay exact
			// for edit anchors, so framing there is flagged, not rewritten.
			const quotesFiles = spec.name === ToolNames.Read || spec.name === ToolNames.Grep || spec.name === ToolNames.Find;
			metadata.untrustedInstructionMarkers = containsInstructionMarkers(text) || (quotesFiles && carriesHostFraming(text));
		}
		metadata.resultKind = result.kind;
		if (result.kind === "error") metadata.errorMessage = result.message;
		if (result.kind === "ok" && result.terminate === true) metadata.terminate = true;
		// Result identity for the stagnation detector (engine/loop-guard.ts):
		// consecutive same-shape calls whose outputs hash identically are not
		// producing new information, whatever their size arguments say.
		if (result.kind === "ok" && typeof result.output === "string") {
			metadata.resultFingerprint = sha256Hex(result.output);
			metadata.resultBytes = Buffer.byteLength(result.output, "utf8");
		}
		// Unlike the stagnation identity this covers a failing result too: a poll
		// that exits nonzero while it waits still reports new information (#445).
		const outcomeText = result.kind === "ok" ? result.output : result.kind === "error" ? result.message : null;
		if (typeof outcomeText === "string") metadata.outcomeFingerprint = sha256Hex(outcomeText);
	}

	const input: MiddlewareHookInput = {
		hook,
		toolName: spec.name,
		metadata,
	};
	if (call.args !== undefined) input.toolArgs = call.args;
	if (result?.details !== undefined) input.toolResultDetails = result.details;
	if (resultDigest !== undefined) input.toolResultDigest = resultDigest;
	if (options?.runId !== undefined) input.runId = options.runId;
	if (options?.sessionId !== undefined) input.sessionId = options.sessionId;
	if (options?.turnId !== undefined) input.turnId = options.turnId;
	if (options?.toolCallId !== undefined) input.toolCallId = options.toolCallId;
	if (options?.correlationId !== undefined) input.correlationId = options.correlationId;
	if (options?.model !== undefined) {
		input.model = options.model;
		input.modelId = options.model.id;
	}
	return input;
}

function commandArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	return typeof args.command === "string" && args.command.length > 0 ? args.command : null;
}

function detectedValidationCommand(call: ClassifierCall): string | null {
	if (call.tool !== ToolNames.Bash) return null;
	const command = commandArg(call.args);
	if (command === null) return null;
	// The call classifier alone says whether the command ran a check; the finish vocabulary only names it.
	if (callVerdict(ToolNames.Bash, { command }) !== "check") return null;
	const detected = detectValidationCommand(command);
	return detected.kind === "validation" ? detected.matched : null;
}

/** The middleware rule that emitted each hook result's first block_tool effect, so a guard block names its rule. */
export const guardRuleIds = new WeakMap<MiddlewareEffect, string>();

export function noteGuardRule(result: MiddlewareHookResult): ReadonlyArray<MiddlewareEffect> {
	const block = firstBlockToolEffect(result.effects);
	const ruleId = result.fired?.find((rule) => rule.effects.includes("block_tool"))?.ruleId;
	if (block !== null && ruleId !== undefined) guardRuleIds.set(block, ruleId);
	return result.effects;
}

export function firstBlockToolEffect(
	effects: ReadonlyArray<MiddlewareEffect>,
): Extract<MiddlewareEffect, { kind: "block_tool" }> | null {
	for (const effect of effects) {
		if (effect.kind === "block_tool") return effect;
	}
	return null;
}

/**
 * `bannered` means System One already put its own untrusted-content banner in
 * front of the output. The deterministic marker warning carries the same
 * header, so it is dropped rather than shown twice.
 */
export function applyToolResultEffects(
	result: ToolResult,
	effects: ReadonlyArray<MiddlewareEffect>,
	bannered = false,
	nested: "call" | "chain" | null = null,
): ToolResult {
	const inherited = inheritedHostNotes(result, nested);
	const annotations = annotationMessages(effects);
	if (annotations.length === 0) return withHostNotes(result, inherited);
	const warning = INSTRUCTION_SHAPED_NOTE;
	const prefix = !bannered && annotations.includes(warning) ? `${warning}\n\n` : "";
	const remaining = annotations.filter((annotation) => annotation !== warning);
	const suffix = remaining.length > 0 ? `${TOOL_RESULT_NOTES_SEPARATOR}${remaining.join("\n")}` : "";
	// A nested result already shaped keeps its model projection, which can say
	// more than the output (a catalog change line); the notes go on both.
	const projected = annotatedProjection(result, prefix, suffix);
	if (result.kind === "ok") {
		const annotated: ToolResult = { kind: "ok", output: `${prefix}${result.output}${suffix}` };
		if (projected.details !== undefined) annotated.details = projected.details;
		if (projected.modelContext !== undefined) annotated.modelContext = projected.modelContext;
		if (result.terminate === true) annotated.terminate = true;
		if (result.images !== undefined) annotated.images = result.images;
		return withHostNotes(annotated, [...inherited, ...remaining]);
	}
	const annotated: ToolResult = { kind: "error", message: `${prefix}${result.message}${suffix}` };
	if (projected.details !== undefined) annotated.details = projected.details;
	if (projected.modelContext !== undefined) annotated.modelContext = projected.modelContext;
	return withHostNotes(annotated, [...inherited, ...remaining]);
}

function annotatedProjection(
	result: ToolResult,
	prefix: string,
	suffix: string,
): { modelContext?: string; details?: ToolResultDetails } {
	if (result.modelContext === undefined) return result.details === undefined ? {} : { details: result.details };
	const modelContext = `${prefix}${result.modelContext}${suffix}`;
	const disposition = result.details?.resultDisposition;
	const details =
		disposition !== null && typeof disposition === "object" && "contextBytes" in disposition
			? {
					...result.details,
					resultDisposition: { ...disposition, contextBytes: Buffer.byteLength(modelContext) },
				}
			: result.details;
	return details === undefined ? { modelContext } : { modelContext, details };
}

/**
 * Notes the nested registry call already appended and recorded, kept only
 * when this registry itself delegated the call (the WeakMap and WeakSet
 * entries no tool output can create) and the text still carries them: a
 * gateway call ends with exactly the capability's run, a chain keeps each
 * step's run in its section.
 */
function inheritedHostNotes(result: ToolResult, nested: "call" | "chain" | null): string[] {
	if (nested === null) return [];
	const notes = recordedToolResultNotes(result.details);
	if (notes.length === 0) return [];
	const text = toolResultContextText(result);
	const carried =
		nested === "call"
			? text.endsWith(`${TOOL_RESULT_NOTES_SEPARATOR}${notes.join("\n")}`)
			: notes.every((note) => carriesToolResultNote(text, note));
	return carried ? notes : [];
}

/**
 * Record the trailing notes this host appended, and drop any value a tool put
 * under the same key: delivery accounting trusts only this record, never
 * note-shaped text at the end of tool output.
 */
function withHostNotes(result: ToolResult, notes: readonly string[]): ToolResult {
	const details = result.details;
	if (notes.length === 0 && (details === undefined || !Object.hasOwn(details, TOOL_RESULT_HOST_NOTES_KEY)))
		return result;
	const { [TOOL_RESULT_HOST_NOTES_KEY]: _forged, ...rest } = details ?? {};
	const recorded = notes.length > 0 ? { ...rest, [TOOL_RESULT_HOST_NOTES_KEY]: [...notes] } : rest;
	return { ...result, details: recorded };
}

function annotationMessages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	const messages: string[] = [];
	for (const effect of effects) {
		if (effect.kind !== "annotate_tool_result") continue;
		const severity = effect.severity ?? "info";
		messages.push(toolResultNote(severity, effect.message));
	}
	return messages;
}
