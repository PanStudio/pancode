// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { ModelSelectionRefusal } from "../../contracts/common.js";
import { type AcpAdmissionReason, AcpRuntimeComponent } from "../pancode/wire-shims.js";

/** #423: only the core's bounded refusal facts cross REST; arbitrary upstream error prose stays private. */
export function modelSelectionRefusal(value: unknown): ModelSelectionRefusal | undefined {
	if (value === undefined) return undefined;
	const projected = Value.Clean(ModelSelectionRefusal, structuredClone(value));
	return Value.Check(ModelSelectionRefusal, projected) ? projected : undefined;
}

const UNROUTED =
	"PanCode did not start this turn because its selected target is not configured or available. Check the conversation route and connection settings before retrying.";
const UNSERVED =
	"PanCode did not start this turn because its selected runtime cannot serve this conversation. Check the connection runtime and choose a supported target before retrying.";
const UNADMITTED =
	"PanCode did not start this turn. Check the conversation route and session trace before retrying. (prompt_not_admitted)";
/** Keyed by the engine's reasons, so a reason src adds fails to compile here until it is worded. */
const ADMISSION_DETAIL: Record<AcpAdmissionReason, string> = {
	"orchestrator-not-configured": UNROUTED,
	"target-not-configured": UNROUTED,
	"target-unknown": UNROUTED,
	"target-not-found": UNROUTED,
	"model-not-configured":
		"PanCode did not start this turn because its session model is not configured. Choose an available model in the conversation controls before retrying.",
	"runtime-not-registered": UNSERVED,
	"chat-unsupported": UNSERVED,
	"streaming-unsupported": UNSERVED,
	"context-window-exceeded":
		"PanCode did not start this turn because the request exceeds the model's context window. Compact the conversation or reduce the request before retrying.",
	"handoff-skill-refused": UNADMITTED,
	"admission-failed": UNADMITTED,
};

export function promptAdmissionDetail(reason: unknown): string {
	return typeof reason === "string" && Object.hasOwn(ADMISSION_DETAIL, reason)
		? ADMISSION_DETAIL[reason as AcpAdmissionReason]
		: UNADMITTED;
}

/** The install remedy for a runtime component PanCode reported missing, or null for an unknown id. */
export function missingComponentRemedy(component: unknown): string | null {
	// Only a component `pancode programs install` provides is named to the operator.
	if (!Value.Check(AcpRuntimeComponent, component)) return null;
	return `its runtime needs the ${component} component, which is not installed on this machine. Run pancode programs install ${component} in a terminal`;
}
