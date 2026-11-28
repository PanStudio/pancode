// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { ToolNames } from "../../../core/tool-names.js";
import { gatewayChainReceipts } from "../../../core/tool-surface.js";
import { isRecord } from "../../../core/type-guards.js";
import { redactForMemoryRoute } from "../../../lib/secrets/memory-route.js";
import { isRefusalToolResultError } from "../../../tools/result-disposition.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../middleware/types.js";
import { successfulShellReceipt } from "../command-evidence.js";
import { recordObservedRead, repositoryRelativePath } from "../lesson-evidence.js";
import { shortText } from "../util.js";
import { type InterventionScope, NO_EFFECTS, setBounded, type TrajectoryStep } from "./scope.js";
import {
	chainChildText,
	documentationChange,
	pendingKey,
	prepareToolStep,
	resultDigest,
	verificationGap,
	WORKSPACE_CHANGING_CLASSES,
} from "./tool-step.js";

const TURN_LOG_LIMIT = 40;
const TURN_LOG_CALL_MAX_CHARS = 300;
const TURN_LOG_READ_EXCERPT_CHARS = 240;

export function createInterventionToolSteps(scope: InterventionScope) {
	return { observeBeforeTool, observeAfterTool };

	function observeBeforeTool(input: MiddlewareHookInput): void {
		const prepared = prepareToolStep(input);
		if (prepared === null) return;
		setBounded(scope.pending, pendingKey(input, prepared.operationFingerprint), prepared, scope.settings().windowSteps);
	}

	function observeAfterTool(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
		const fallback = prepareToolStep(input);
		if (fallback === null) return NO_EFFECTS;
		const key = pendingKey(input, fallback.operationFingerprint);
		const prepared = scope.pending.get(key) ?? fallback;
		scope.pending.delete(key);
		const outcome = input.metadata?.resultKind === "error" ? "error" : "ok";
		scope.toolStep += 1;
		scope.toolsSinceMemoryStep += 1;
		scope.toolsSinceLessonPass += 1;
		if (prepared.toolName === ToolNames.Bash) scope.shellStepsSinceLessonPass += 1;
		const live = scope.settings();
		// The model tiers of bank maintenance and correction run only when their surface says `model`; the rules tier below
		// (failure entries, repeated-failure annotation and reminder) runs either way.
		if (live.surfaces.bank === "model" && scope.toolsSinceMemoryStep >= live.everyNTools)
			scope.pendingTriggers.add("interval");
		if (outcome === "error") {
			for (const watch of scope.deliveries) {
				if (watch.fingerprints.has(prepared.operationFingerprint)) watch.recurrences += 1;
			}
			scope.consecutiveErrors += 1;
			if (live.surfaces.correct === "model" && scope.consecutiveErrors >= 2 && !scope.operatorAskedRepeat)
				scope.pendingTriggers.add("tool_error_streak");
		} else {
			scope.consecutiveErrors = 0;
		}
		const digest = resultDigest(input, outcome);
		const step: TrajectoryStep = {
			...prepared,
			step: scope.toolStep,
			outcome,
			resultDigest: digest.text,
			resultDigestProvenance: digest.provenance,
		};
		// The registry passes whatever arguments the model sent, so a `command`
		// field on a read or a write proves nothing ran. Only the shell tool's own
		// success receipt does: its name, an ok result, and a zero exit it reported.
		const command =
			prepared.toolName === ToolNames.Bash && typeof input.toolArgs?.command === "string" ? input.toolArgs.command : null;
		if (command !== null && successfulShellReceipt(input.metadata?.resultKind === "ok", input.toolResultDetails))
			scope.rememberSucceededCommand(command, input.toolArgs?.cwd);
		if (prepared.toolName === ToolNames.Verify)
			scope.noteVerifyRun(input.metadata?.resultKind === "ok", input.toolResultDetails);
		{
			const kind = input.metadata?.resultKind;
			scope.noteCheckOrChange(input.toolName ?? "", input.toolArgs, input.toolResultDetails, {
				ok: kind === "ok",
				ran: kind === "ok" || (kind === "error" && !isRefusalToolResultError({ kind, details: input.toolResultDetails })),
				actionClass: typeof input.metadata?.actionClass === "string" ? input.metadata.actionClass : undefined,
			});
		}
		const root = scope.workspaceRoot();
		const readPath =
			prepared.toolName === ToolNames.Read && outcome === "ok" && typeof input.toolArgs?.path === "string"
				? repositoryRelativePath(input.toolArgs.path, [root])
				: null;
		// A successful read carries a bounded excerpt of what it returned, so the
		// lesson pass can quote the source a fact came from. The excerpt is also
		// the only text that read can later vouch for.
		const readExcerpt =
			readPath === null ? "" : shortText(redactForMemoryRoute(digest.text), TURN_LOG_READ_EXCERPT_CHARS);
		if (readPath !== null) {
			recordObservedRead(scope.observedReads, readPath, readExcerpt);
			scope.noteReadEvidence(readPath, readExcerpt, root);
			scope.recordShownRead(readPath, input.toolResultDetails);
		}
		const excerpt =
			outcome === "error"
				? ` => ${shortText(redactForMemoryRoute(digest.text), 160)}`
				: readExcerpt
					? ` => ${readExcerpt}`
					: "";
		scope.turnLog.push(
			`${scope.toolStep}. ${outcome === "ok" ? "ok" : "FAILED"}: ${shortText(redactForMemoryRoute(command ?? prepared.callDescription), TURN_LOG_CALL_MAX_CHARS)}${excerpt}`,
		);
		observeChainSteps(prepared.toolName, input);
		while (scope.turnLog.length > TURN_LOG_LIMIT) scope.turnLog.shift();
		scope.trajectory.push(step);
		if (scope.trajectory.length > live.windowSteps)
			scope.trajectory.splice(0, scope.trajectory.length - live.windowSteps);
		if (outcome === "ok" && WORKSPACE_CHANGING_CLASSES.has(String(input.metadata?.actionClass))) {
			scope.lastWorkspaceChangeStep = scope.toolStep;
		}
		if (input.metadata?.resultKind === "ok") {
			// Only an explicit receipt for this exact operation closes its failure
			// episode. Keep the bank entry and trajectory as history; this does not
			// verify the surrounding task or reinterpret tool exit classifications.
			scope.failures.delete(step.operationFingerprint);
			scope.annotatedThisTurn.delete(step.operationFingerprint);
			if (scope.lastInjectedOperationFingerprint === step.operationFingerprint)
				scope.lastInjectedOperationFingerprint = null;
		}
		if (outcome !== "error") {
			if (outcome !== "ok") return NO_EFFECTS;
			if (prepared.toolName === ToolNames.Verify && verificationGap(input.toolResultDetails)) {
				const answered = scope.surfaceForVerificationGap();
				if (answered.length > 0) return answered;
			}
			const touched = scope.surfaceForSubject(prepared.toolName, input.toolArgs);
			if (touched.length > 0) return touched;
			return WORKSPACE_CHANGING_CLASSES.has(String(input.metadata?.actionClass)) && !documentationChange(input.toolArgs)
				? scope.surfaceDurableLessons(input.toolArgs)
				: NO_EFFECTS;
		}
		scope.rememberFailure(step);
		if (command !== null) scope.noteFailedForFix(command, input.toolArgs?.cwd);
		const recipe = command === null ? NO_EFFECTS : scope.surfaceRecipeForFailure(command);
		return recipe.length > 0 ? recipe : scope.annotateRepeatedFailure(step);
	}

	/**
	 * A gateway chain ran real steps under one outer call. Its settled, admitted
	 * children (the canonical receipts every other ledger reader expands) add
	 * their own lesson-log lines and evidence: a shell child's exact command when
	 * it reported success with exit 0, a read child's excerpt as shown. The
	 * outer call keeps its single trajectory step, failure episode and
	 * reminder semantics; a failed or blocked child is logged and proves nothing.
	 */
	function observeChainSteps(toolName: string, input: MiddlewareHookInput): void {
		const children = gatewayChainReceipts(toolName, { details: input.toolResultDetails });
		for (const child of children) {
			const details = isRecord(child.result.details) ? child.result.details : {};
			const settled = child.admission.outcome === "ok" && child.admission.decision === "allowed" && details.kind === "ok";
			const label = `${scope.toolStep}.${child.id}`;
			if (child.capability === ToolNames.Bash && typeof child.args.command === "string") {
				scope.shellStepsSinceLessonPass += 1;
				// The same receipt rule a direct shell call meets.
				const succeeded = successfulShellReceipt(settled, details);
				if (succeeded) scope.rememberSucceededCommand(child.args.command, child.args.cwd);
				scope.turnLog.push(
					`${label} ${succeeded ? "ok" : "FAILED"}: ${shortText(redactForMemoryRoute(child.args.command), TURN_LOG_CALL_MAX_CHARS)}`,
				);
				continue;
			}
			// The same verify rule a direct call meets: the run's own judgement decides, never the chain's wrapper.
			if (child.capability === ToolNames.Verify)
				scope.noteVerifyRun(child.admission.outcome === "ok" && child.admission.decision === "allowed", details);
			const path =
				settled && child.capability === ToolNames.Read && typeof child.args.path === "string"
					? repositoryRelativePath(child.args.path, [scope.workspaceRoot()])
					: null;
			const excerpt =
				path === null ? "" : shortText(redactForMemoryRoute(chainChildText(child.result)), TURN_LOG_READ_EXCERPT_CHARS);
			if (path !== null) {
				recordObservedRead(scope.observedReads, path, excerpt);
				scope.noteReadEvidence(path, excerpt, scope.workspaceRoot());
			}
			scope.turnLog.push(
				`${label} ${settled ? "ok" : "FAILED"}: ${shortText(`${child.capability}${path === null ? "" : ` ${path}`}`, TURN_LOG_CALL_MAX_CHARS)}${excerpt ? ` => ${excerpt}` : ""}`,
			);
		}
	}
}
