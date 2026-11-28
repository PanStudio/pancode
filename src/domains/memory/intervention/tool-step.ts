// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../../core/hash.js";
import { isRecord } from "../../../core/type-guards.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
} from "../../../tools/dispatch-plan.js";
import {
	sanitizeToolResultDigest,
	type ToolResultDigest,
	textToolResultDigest,
} from "../../../tools/result-disposition.js";
import type { MiddlewareHookInput } from "../../middleware/types.js";
import { hashToolCall } from "../../safety/loop-detector.js";
import { redactForMemoryRoute } from "../secret-text.js";
import { shortText } from "../util.js";

const CALL_DESCRIPTION_MAX_CHARS = 180;

type ToolOutcome = "ok" | "error";

export interface PendingToolStep {
	toolName: string;
	operationFingerprint: string;
	callDescription: string;
}

/** Action classes whose successful call can change what a rerun of a failed check sees. */
export const WORKSPACE_CHANGING_CLASSES: ReadonlySet<string> = new Set([
	"write",
	"system_modify",
	"git_destructive",
	"destructive",
	"dispatch",
]);

export function prepareToolStep(input: MiddlewareHookInput): PendingToolStep | null {
	const toolName = input.toolName?.trim();
	if (!toolName) return null;
	const canonical = hashToolCall(toolName, input.toolArgs ?? {});
	// Host preparation artifacts belong to exact identity, not descriptive
	// context. Keep public arguments so memory can explain what was attempted.
	const publicArgs = Object.fromEntries(
		Object.entries(input.toolArgs ?? {}).filter(
			([key]) => key !== RESOLVED_DISPATCH_PLAN_ARGUMENT && key !== DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
		),
	);
	return {
		toolName,
		operationFingerprint: sha256Hex(canonical).slice(0, 16),
		callDescription: shortText(
			redactForMemoryRoute(
				Object.keys(publicArgs).length > 0
					? `${toolName} ${hashToolCall("", publicArgs)}`
					: toolName === "dispatch"
						? "dispatch plan preparation"
						: toolName,
			),
			CALL_DESCRIPTION_MAX_CHARS,
		),
	};
}

/** The model-facing text a settled chain step returned. */
export function chainChildText(result: unknown): string {
	const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
	return content
		.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

export function pendingKey(input: MiddlewareHookInput, operationFingerprint: string): string {
	return input.toolCallId ?? `anonymous:${operationFingerprint}`;
}

export function resultDigest(input: MiddlewareHookInput, outcome: ToolOutcome): ToolResultDigest {
	if (input.toolResultDigest !== undefined) return sanitizeToolResultDigest(input.toolResultDigest);
	if (outcome === "error") {
		const metadataMessage = input.metadata?.errorMessage;
		if (typeof metadataMessage === "string" && metadataMessage.trim().length > 0) {
			return textToolResultDigest(diagnosticLine(metadataMessage), { outcome });
		}
		for (const key of ["error", "message"] as const) {
			const value = input.toolResultDetails?.[key];
			if (typeof value === "string" && value.trim().length > 0) {
				return textToolResultDigest(diagnosticLine(value), { outcome });
			}
		}
		return textToolResultDigest("", { outcome });
	}
	const resultFingerprint = input.metadata?.resultFingerprint;
	return textToolResultDigest(
		typeof resultFingerprint === "string" ? `ok result ${resultFingerprint.slice(0, 16)}` : "ok",
		{ outcome },
	);
}

const DIAGNOSTIC_HINT =
	/\b(error|failed|failure|cannot|unable|expected|refused|denied|missing|not found|timed out|timeout|fatal)\b/iu;

/**
 * A runtime opens its output with its own frame pointer, not with the diagnosis,
 * and closes it with paths that repeat the command. The bounded digest is the
 * whole advisory a model reads, so it spends that budget on the first line that
 * names a problem and falls back to the first line when none does.
 */
function diagnosticLine(value: string): string {
	const lines = value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.find((line) => DIAGNOSTIC_HINT.test(line)) ?? lines[0] ?? "";
}

/**
 * A write whose only target is a prose document. Live negative controls, a
 * README-only task and a new notes file, each got the validator recipe at
 * their one edit and used none of it; the recipe waits for a change a command
 * could actually exercise. A change with no single named path still counts.
 */
/** A verify listing that found no declared check and derived none; anything else is not a gap. */
export function verificationGap(details: unknown): boolean {
	if (!isRecord(details) || !Array.isArray(details.sources) || !Array.isArray(details.derived)) return false;
	return (
		details.derived.length === 0 &&
		details.sources.every((source) => isRecord(source) && Array.isArray(source.checks) && source.checks.length === 0)
	);
}

export function documentationChange(args: Readonly<Record<string, unknown>> | undefined): boolean {
	const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : null;
	return path !== null && /\.(?:md|mdx|markdown|txt|rst|adoc)$/iu.test(path);
}
