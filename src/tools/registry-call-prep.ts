// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { isHarnessExtensionToolName } from "../core/tool-names.js";
import type { ToolCallLanding } from "../domains/middleware/types.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { OutboundFile } from "./registry-contract.js";
import type { ToolResultDisposition } from "./result-disposition.js";
import { DEFAULT_TOOL_RESULT_MAX_BYTES } from "./result-shaping.js";
import { pathToolLanding } from "./tool-landing.js";
import type { ToolSpec } from "./tool-spec.js";

/**
 * Run a tool's optional `prepareArguments` normalizer before its body. A
 * throwing or non-object result is discarded so a buggy normalizer can never
 * abort admission; the raw args pass through unchanged.
 */
export function prepareToolArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
	if (!spec.prepareArguments) return args;
	try {
		const prepared = spec.prepareArguments(args);
		return prepared !== null && typeof prepared === "object" && !Array.isArray(prepared) ? prepared : args;
	} catch {
		return args;
	}
}

/**
 * Resolve the argument-sensitive disposition, failing closed. A throwing
 * resolver cannot fall back to the declared disposition: the caller may have
 * asked for a narrower context than the tool declares, and silently restoring
 * the declared mode would widen model context while recording the declared mode
 * as the requested one. The failure keeps the declared presentation and applies
 * the narrowest context instead, so the applied and recorded modes stay honest.
 */
export function resolveToolResultDisposition(
	spec: ToolSpec,
	args: Record<string, unknown>,
): ToolResultDisposition | undefined {
	const declared = spec.metadata?.resultDisposition;
	if (!spec.resolveResultDisposition) return declared;
	try {
		return spec.resolveResultDisposition(args, declared);
	} catch (error) {
		const maxBytes =
			declared !== undefined && declared.context.maxBytes !== undefined
				? declared.context.maxBytes
				: DEFAULT_TOOL_RESULT_MAX_BYTES;
		return {
			presentation: declared?.presentation ?? { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true },
			context: { mode: "metadata-only", maxBytes },
			// The narrowing is recorded with the result, so a resolver bug shows up
			// on the transcript row and in the model's header instead of reading as
			// a deliberate metadata-only request.
			fallback: { reason: "resolver-error", message: error instanceof Error ? error.message : String(error) },
		};
	}
}

export function disposeAdmissionArgs(spec: ToolSpec | undefined, args: Record<string, unknown>): void {
	try {
		spec?.disposeAdmissionArguments?.(args);
	} catch {
		// Cleanup is best-effort here; durable reservation expiry is the backstop.
	}
}

/** A landing the hook cannot have is no landing: the call is judged on its arguments, as before. */
export function hookLanding(spec: ToolSpec, call: ClassifierCall): ToolCallLanding | null {
	try {
		return spec.describeHookLanding?.(call.args ?? {}) ?? pathToolLanding(spec.name, call.args);
	} catch {
		// Resolution only reads the filesystem; a failure leaves the hook its raw arguments.
		return null;
	}
}

export function prepareAdmissionCall(spec: ToolSpec | undefined, call: ClassifierCall): ClassifierCall {
	if (!spec?.prepareAdmissionArguments) return call;
	try {
		const prepared = spec.prepareAdmissionArguments(call.args ?? {});
		if (prepared === null || typeof prepared !== "object" || Array.isArray(prepared)) return call;
		return { ...call, args: prepared };
	} catch {
		return call;
	}
}

/** The files a call sends off the host; a spec that cannot read its arguments names none. */
export function outboundFilesOf(spec: ToolSpec | undefined, args: Record<string, unknown> | undefined): OutboundFile[] {
	if (spec?.outboundFiles === undefined) return [];
	try {
		return [...spec.outboundFiles(args ?? {})];
	} catch {
		return [];
	}
}

/**
 * The registered class of a call the classifier could not class. A call that
 * sends files off the host is outward, and never read: a read-trusted tool is
 * raised to execute for that call, so read-only refuses it and default and yolo
 * send it to the safety judge as an outward action.
 */
export function applyRegisteredToolClassification(
	decision: SafetyDecision,
	spec: ToolSpec,
	readOnly = false,
	args?: Record<string, unknown>,
): SafetyDecision {
	const registered =
		decision.classification.actionClass !== "unknown" && !declaredRuntimeExtensionTool(decision, spec)
			? decision
			: {
					...decision,
					classification: {
						actionClass: readOnly ? (spec.readOnlyActionClass ?? spec.baseActionClass) : spec.baseActionClass,
						reasons: [`registered tool: ${spec.name}`],
					},
				};
	const sends = args === undefined ? 0 : outboundFilesOf(spec, args).length;
	if (sends === 0) return registered;
	const { classification } = registered;
	return {
		...registered,
		classification: {
			...classification,
			actionClass: classification.actionClass === "read" ? "execute" : classification.actionClass,
			reasons: [...classification.reasons, `sends ${sends === 1 ? "a file" : `${sends} files`} off the host`],
			exposure: "outward",
		},
	};
}

/**
 * An extension runtime tool (no `safetyCall` projection) whose name the
 * classifier floored to execute. Its install-approved manifest declares the
 * class, which the runtime schema limits to what its permissions allow.
 */
function declaredRuntimeExtensionTool(decision: SafetyDecision, spec: ToolSpec): boolean {
	return (
		decision.classification.actionClass === "execute" &&
		spec.safetyCall === undefined &&
		spec.sourceInfo?.extension !== undefined &&
		isHarnessExtensionToolName(spec.name)
	);
}
