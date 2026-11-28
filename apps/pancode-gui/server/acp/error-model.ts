// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { ModelSelectionRefusal } from "../../contracts/common.js";

/** #423: only the core's bounded refusal facts cross REST; arbitrary upstream error prose stays private. */
export function modelSelectionRefusal(value: unknown): ModelSelectionRefusal | undefined {
	if (value === undefined) return undefined;
	const projected = Value.Clean(ModelSelectionRefusal, structuredClone(value));
	return Value.Check(ModelSelectionRefusal, projected) ? projected : undefined;
}

export function promptAdmissionDetail(reason: unknown): string {
	switch (reason) {
		case "orchestrator-not-configured":
		case "target-not-configured":
		case "target-unknown":
		case "target-not-found":
			return "PanCode did not start this turn because its selected target is not configured or available. Check the conversation route and connection settings before retrying.";
		case "model-not-configured":
			return "PanCode did not start this turn because its session model is not configured. Choose an available model in the conversation controls before retrying.";
		case "runtime-not-registered":
		case "chat-unsupported":
		case "streaming-unsupported":
			return "PanCode did not start this turn because its selected runtime cannot serve this conversation. Check the connection runtime and choose a supported target before retrying.";
		case "context-window-exceeded":
			return "PanCode did not start this turn because the request exceeds the model's context window. Compact the conversation or reduce the request before retrying.";
		default:
			return "PanCode did not start this turn. Check the conversation route and session trace before retrying. (prompt_not_admitted)";
	}
}

/** The runtime components `pancode programs install` provides; any other value is not named to the operator. */
const RUNTIME_COMPONENTS = new Set(["copilot-sdk", "claude-sdk"]);

/** The install remedy for a runtime component PanCode reported missing, or null for an unknown id. */
export function missingComponentRemedy(component: unknown): string | null {
	if (typeof component !== "string" || !RUNTIME_COMPONENTS.has(component)) return null;
	return `its runtime needs the ${component} component, which is not installed on this machine. Run pancode programs install ${component} in a terminal`;
}
