// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { endpointCapacityHolders } from "../domains/dispatch/index.js";
import {
	canonicalEndpointKey,
	endpointCapacityFor,
	endpointCapacityForStatus,
	modelResidencyForStatus,
	type ProvidersContract,
	type TargetStatus,
} from "../domains/providers/index.js";
import type { ModelRequestSlots } from "./status-types.js";
import type { ChatLoopTarget, PreInvocationStage } from "./turn-state.js";

const PRE_INVOCATION_STAGE_LABEL: Readonly<Record<PreInvocationStage, string>> = {
	transform: "request transform",
	auth: "authentication",
	"budget admission": "budget admission",
	admission: "request admission",
};

/**
 * The stall watchdog's abort text. A silent request that never reached the
 * provider names the step it was in: the session behind #423 read "no output
 * from openai-codex" while no request had left the host. Both forms end in a
 * timeout; only an invoked stream belongs on the transient retry ladder (#424).
 */
export function stallAbortReason(
	targetId: string,
	idleMs: number,
	stage: PreInvocationStage | null,
	awaitingFirstToken: boolean,
): string {
	const seconds = Math.round(idleMs / 1000);
	if (stage !== null) {
		return `request stalled: ${PRE_INVOCATION_STAGE_LABEL[stage]} made no progress for ${seconds}s and nothing was sent to ${targetId}, aborting (pre-invocation timeout)`;
	}
	return `stream stalled: no ${awaitingFirstToken ? "first token" : "output"} from ${targetId} for ${seconds}s, aborting (stream timeout)`;
}

/**
 * Say that the first request will pay for a load, before it does.
 *
 * A self-hosted server loads a model on demand, and a 30B at 4-bit takes tens
 * of seconds off disk. PanCode sends the request and waits, which from the outside
 * is indistinguishable from a hang: no spinner explains it, no notice names it,
 * and the operator's next move is usually Ctrl-C. The probe already knows the
 * model is not resident, because llama-swap and LM Studio both report per-model
 * load state; nothing was reading it.
 *
 * Notice only, never a block. The server loads it either way, and a state that
 * says `unknown` says nothing worth interrupting for. Residency comes from the
 * same discovery view the planner budgets against, so a model PanCode is planning
 * a loaded window for is never announced as absent.
 */
/** Reading the slots takes the admission state lock, so a wait reads them at this pace and no faster. */
export const MODEL_SLOTS_SAMPLE_MS = 2_000;

/**
 * Other PanCode work on this request's endpoint, for a wait that has no response yet. The request itself holds one
 * foreground slot and never counts against itself. Null when nothing else of PanCode's is there: then PanCode knows nothing
 * about a queue, and says nothing about one.
 */
export function modelRequestSlots(
	target: Pick<ChatLoopTarget, "target" | "runtime">,
	providers: Pick<ProvidersContract, "list">,
): ModelRequestSlots | null {
	const key = canonicalEndpointKey(target.target);
	if (key === null) return null;
	let holders: ReturnType<typeof endpointCapacityHolders>;
	try {
		holders = endpointCapacityHolders(key);
	} catch {
		// The state lock stayed busy: this sample says nothing, and the next one may.
		return null;
	}
	const otherRequests = Math.max(0, holders.foregroundStreams - 1);
	if (holders.leases + holders.reservations + otherRequests === 0) return null;
	const status = providers.list().find((entry) => entry.target.id === target.target.id);
	const capacity = status
		? endpointCapacityForStatus(status)
		: endpointCapacityFor({ target: target.target, runtime: target.runtime });
	return {
		limit:
			capacity && capacity.source !== "local-native-default" && capacity.source !== "runtime-default"
				? capacity.limit
				: null,
		workers: holders.leases,
		reservations: holders.reservations,
		otherRequests,
	};
}

export function coldModelNotice(
	status: TargetStatus | null | undefined,
	targetId: string,
	wireModelId: string,
): { key: string; message: string } | null {
	const residency = modelResidencyForStatus(status, wireModelId);
	if (residency === "loading") {
		return {
			key: `${targetId}|${wireModelId}|loading`,
			message: `[PanCode] ${wireModelId} is still loading on ${targetId}; the first reply waits for it.`,
		};
	}
	if (residency !== "absent") return null;
	return {
		key: `${targetId}|${wireModelId}|unloaded`,
		message: `[PanCode] ${wireModelId} is not resident on ${targetId}; the first request loads it, which can take a minute.`,
	};
}
