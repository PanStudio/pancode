// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { durableAssistantTextFromEvent } from "../core/worker-output.js";

/** Return the durable final assistant text carried by a worker event. */
export function assistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event).trim();
}

export {
	responseModelIdWords,
	runGatewayRoutingLabel,
	runResponseModelIdObservationLabel,
} from "../domains/dispatch/run-upstream.js";
