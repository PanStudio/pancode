// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { gatewayRoutingObservationFromRecord, gatewayRoutingObservationLabel } from "../../core/gateway-routing.js";
import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import { callLevelUpstreamResponses, type RunResult } from "./types.js";

/** Each distinct label once, in first-seen order, with how many calls carried it when more than one did. */
function countedLabels(labels: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

/** Human projection of the response model-id observations a run's calls carried, each distinct one once. */
export function runResponseModelIdObservationLabel(result: Pick<RunResult, "upstreamResponses">): string | null {
	const responses = callLevelUpstreamResponses(result.upstreamResponses ?? []);
	if (responses.length === 0) return null;
	const labels = responses.map((response) => {
		const observation = responseModelIdObservationFromRecord(response as unknown as Record<string, unknown>);
		if (observation.state === "reported") return `reported:${observation.reportedModelId}`;
		return observation.state;
	});
	return `response_model_id_observation=${countedLabels(labels).join(",")}`;
}

/**
 * The same label read off a run's call records, for a run whose seal carries no upstream observation: a main run's
 * calls settle in its session journal, not through a worker receipt (fleet finding 3).
 */
export function callReportedModelLabel(reported: ReadonlyArray<string | null>): string | null {
	if (reported.length === 0) return null;
	const labels = reported.map((model) => (model === null ? "not-reported" : `reported:${model}`));
	return `${RESPONSE_MODEL_ID_PREFIX}${countedLabels(labels).join(",")}`;
}

/** Human projection of the gateway routes a run's calls took, each distinct route once. */
export function runGatewayRoutingLabel(result: Pick<RunResult, "upstreamResponses">): string | null {
	const observations = callLevelUpstreamResponses(result.upstreamResponses ?? [])
		.map((response) => gatewayRoutingObservationFromRecord(response as unknown as Record<string, unknown>))
		.filter((observation) => observation !== null);
	if (observations.length === 0) return null;
	const routes = new Map<string, { count: number; overheadMs?: { min: number; max: number } }>();
	for (const observation of observations) {
		const { overheadMs, ...route } = observation;
		const label = gatewayRoutingObservationLabel(route);
		const group = routes.get(label) ?? { count: 0 };
		group.count += 1;
		if (overheadMs !== undefined) {
			group.overheadMs = {
				min: Math.min(group.overheadMs?.min ?? overheadMs, overheadMs),
				max: Math.max(group.overheadMs?.max ?? overheadMs, overheadMs),
			};
		}
		routes.set(label, group);
	}
	return [...routes]
		.map(([label, group]) => {
			const overhead = group.overheadMs;
			const overheadLabel = overhead ? ` overhead_ms=${overhead.min}${group.count > 1 ? `–${overhead.max}` : ""}` : "";
			return `${label}${overheadLabel}${group.count > 1 ? ` ×${group.count}` : ""}`;
		})
		.join(" | ");
}

const RESPONSE_MODEL_ID_PREFIX = "response_model_id_observation=";

export interface ResponseModelIdWords {
	/** Every call that carried an observation was served by the requested model. */
	servedAsRequested: boolean;
	calls: number;
	/** What the providers said, in words, such as `served gpt-6-luna on 2 calls`. */
	text: string;
}

/**
 * {@link runResponseModelIdObservationLabel}'s label in words for operator surfaces (`fleet view`, the `run --agent`
 * trailer). The label itself stays the record's field and the model-facing evidence label.
 */
export function responseModelIdWords(label: string | null, requested: string): ResponseModelIdWords | null {
	if (label === null) return null;
	const body = label.startsWith(RESPONSE_MODEL_ID_PREFIX) ? label.slice(RESPONSE_MODEL_ID_PREFIX.length) : label;
	const calls = (n: number) => `${n} call${n === 1 ? "" : "s"}`;
	let servedAsRequested = true;
	let total = 0;
	const parts = body
		.split(",")
		.filter((part) => part.length > 0)
		.map((part) => {
			const counted = /^(.*?)(?: ×(\d+))?$/u.exec(part);
			const observation = counted?.[1] ?? part;
			const count = Number(counted?.[2] ?? 1);
			total += count;
			let served: string | null = null;
			if (observation.startsWith("reported:")) served = observation.slice("reported:".length);
			if (served !== requested) servedAsRequested = false;
			const words =
				served === null
					? observation === "not-reported"
						? "no model reported"
						: "no response observed"
					: served === requested
						? `served ${served}`
						: `provider reported ${served}`;
			return `${words} on ${calls(count)}`;
		});
	if (parts.length === 0) return null;
	return { servedAsRequested, calls: total, text: parts.join(", ") };
}
