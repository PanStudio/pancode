// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { TelemetryContext } from "../../../core/telemetry/context.js";
import type { Fact } from "../../../core/telemetry/fact.js";
import {
	type TaskMemoryBankDelta,
	type TaskMemoryTelemetryDecision,
	type TaskMemoryTelemetryTier,
	type TaskMemoryTelemetryTrigger,
	taskMemoryBankDelta,
} from "../memory-events.js";
import type { TaskMemoryEntry } from "../task-bank.js";
import type { TaskMemoryPolicyReason, TaskMemoryPolicyResult, TaskMemoryRoute } from "../task-memory-policy.js";
import type { TaskMemoryActivityEvent } from "../task-memory-status.js";
import type { InterventionScope } from "./scope.js";

export const MEMORY_INTERVENTION_ACTIVITY_LIMIT = 20;

export function createInterventionTelemetry(scope: InterventionScope) {
	const { deps } = scope;

	return { emitTelemetry, citedEntries, citedEntryCount };

	function emitTelemetry(
		triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>,
		tier: TaskMemoryTelemetryTier,
		decision: TaskMemoryTelemetryDecision,
		reason: TaskMemoryPolicyReason,
		citedEntries: number,
		inputTokens: Fact<number>,
		outputTokens: Fact<number>,
		started: bigint,
		operations: {
			calls?: TaskMemoryPolicyResult["calls"];
			bankOperations: number;
			droppedOperations: number;
			refusalReason?: string;
			resumeAt?: string;
		} = {
			bankOperations: 0,
			droppedOperations: 0,
		},
		route?: TaskMemoryRoute,
		context: TelemetryContext | null | undefined = scope.stepContext,
	): void {
		const next = deps.bank.snapshot();
		const bankDelta = taskMemoryBankDelta(scope.telemetryBankSnapshot, next);
		scope.telemetryBankSnapshot = next;
		const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
		try {
			deps.telemetry?.record({
				...(context == null ? {} : { context }),
				triggerReasons,
				tier,
				bankDelta,
				decision,
				reason,
				...(operations.calls === undefined ? {} : { calls: operations.calls }),
				bankOperations: operations.bankOperations,
				droppedOperations: operations.droppedOperations,
				...(operations.refusalReason === undefined ? {} : { refusalReason: operations.refusalReason }),
				citedEntries,
				inputTokens,
				outputTokens,
				latencyMs,
				...(route === undefined ? {} : { route }),
				...(operations.resumeAt === undefined ? {} : { resumeAt: operations.resumeAt }),
			});
		} catch {
			// Observability must never steer or block the memory policy.
		}
		const event: TaskMemoryActivityEvent = {
			at: new Date().toISOString(),
			triggerReasons: [...new Set(triggerReasons)],
			tier,
			decision,
			reason,
			citedEntries,
			bankWrites: countBankWrites(bankDelta),
			latencyMs,
			...(operations.resumeAt === undefined ? {} : { resumeAt: operations.resumeAt }),
		};
		scope.activity.unshift(event);
		if (scope.activity.length > MEMORY_INTERVENTION_ACTIVITY_LIMIT)
			scope.activity.length = MEMORY_INTERVENTION_ACTIVITY_LIMIT;
	}

	function citedEntries(message: string | null): TaskMemoryEntry[] {
		if (message === null) return [];
		const snapshot = deps.bank.snapshot();
		return [...snapshot.knowledge, ...snapshot.procedural].filter((entry) => message.includes(`[${entry.id}]`));
	}

	function citedEntryCount(message: string | null): number {
		return citedEntries(message).length;
	}
}

function countBankWrites(delta: TaskMemoryBankDelta): number {
	return [delta.status, delta.knowledge, delta.procedural].reduce(
		(total, entry) => total + entry.added + entry.updated + entry.deleted,
		0,
	);
}
