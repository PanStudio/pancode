// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's tool gates: the run cap on a tool batch, the refusals a single call can meet before it runs (a
 * sibling of self-compaction or finish, a bare finish, a finish with a named output missing), and the missing reply an
 * admitted bare finish files in its result.
 */

import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall } from "../../core/tool-surface.js";
import { runCapStopCode } from "../../core/turn-constraints.js";
import { missingOutputRefusal } from "../../domains/session/output-obligations.js";
import {
	bareFinishVerdict,
	FINISH_WITHOUT_REPLY_REFUSAL,
	finishSiblingRefusal,
	withoutReplyResult,
} from "../../tools/finish.js";
import { selfCompactSiblingRefusal } from "../continuity-controller.js";
import type { TurnRuntimeDeps } from "../turn-runtime-types.js";
import type { AgentBuildScope } from "./scope.js";

type AgentHooks = Required<NonNullable<Parameters<TurnRuntimeDeps["createAgent"]>[0]>>;

export function createToolGates(scope: AgentBuildScope) {
	const { deps, state } = scope.rt;

	// FX-40: bare finish calls admitted after their user turn's one refusal; each result records the missing reply.
	const bareFinishCalls = new Set<string>();
	// M-4: the first finish(done) of an operator prompt while an output its session named is absent does not run.
	const missingOutputGate = (toolCall: { name: string; arguments: unknown }) => {
		if (state.finishOutputRefused) return undefined;
		const effective = effectiveToolCall(toolCall.name, toolCall.arguments);
		if (effective.toolName !== ToolNames.Finish || effective.args?.state !== "done") return undefined;
		const missing = deps.missingOutputs?.() ?? [];
		if (missing.length === 0) return undefined;
		state.finishOutputRefused = true;
		return { block: true as const, reason: missingOutputRefusal(missing) };
	};
	// Refused calls count toward the run's tool-call cap as executed ones do.
	const beforeToolBatch: AgentHooks["beforeToolBatch"] = ({ assistantMessage }) => {
		const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
		const capRefusal = deps.runCaps?.admitToolCalls(calls.length);
		if (capRefusal === undefined) return undefined;
		// The engine refuses these calls before the registry, so no finish event says they were refused.
		const reasonCode = runCapStopCode(capRefusal);
		for (const call of calls)
			scope.rt.toolOutcomes.set(call.id, {
				outcome: "blocked",
				reason: capRefusal,
				durationMs: 0,
				...(reasonCode === undefined ? {} : { reasonCode }),
			});
		return { reason: capRefusal };
	};
	const beforeToolCall: AgentHooks["beforeToolCall"] = async ({ assistantMessage, toolCall }) => {
		scope.rt.protocolRetryCalls.delete(toolCall.id);
		const compactSibling = selfCompactSiblingRefusal(toolCall, assistantMessage);
		if (compactSibling !== undefined) return compactSibling;
		const finishSibling = finishSiblingRefusal(toolCall, assistantMessage);
		if (finishSibling !== undefined) {
			scope.rt.protocolRetryCalls.add(toolCall.id);
			return finishSibling;
		}
		const verdict = bareFinishVerdict(toolCall, assistantMessage, {
			headless: deps.headless === true,
			origin: state.currentTurnOrigin?.origin,
			promptOrigin: state.promptOrigin,
			refusedThisTurn: state.finishReplyRefused,
			repliedThisTurn: state.turnReplied,
		});
		if (verdict === "admit") bareFinishCalls.add(toolCall.id);
		if (verdict !== "refuse") return missingOutputGate(toolCall);
		state.finishReplyRefused = true;
		const active = state.activeUserTurnId;
		// Keyed like turnCalls (bt-26 N2h): a refusal after a steer settles under the user turn the run started under.
		const refusedTurn = active && (scope.rt.steeredTurns.get(active) ?? scope.runTurnId ?? active);
		if (refusedTurn)
			scope.rt.bareFinishRefusals.set(refusedTurn, (scope.rt.bareFinishRefusals.get(refusedTurn) ?? 0) + 1);
		scope.rt.protocolRetryCalls.add(toolCall.id);
		return { block: true, reason: FINISH_WITHOUT_REPLY_REFUSAL };
	};
	// FX-40: an admitted bare finish files its missing reply in the result itself, which the transcript shows, the
	// session ledger keeps and the turn's declaration is read from.
	const afterToolCall: AgentHooks["afterToolCall"] = async ({ toolCall, result, isError }) => {
		const bare = bareFinishCalls.delete(toolCall.id);
		return bare && !isError ? withoutReplyResult(result, deps.headless === true) : undefined;
	};

	return { beforeToolBatch, beforeToolCall, afterToolCall };
}
