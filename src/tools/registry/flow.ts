// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isMcpToolName } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	type FlowRestrictionSet,
	flowEndpointIdentity,
	flowTransferRefusal,
	mergeFlowRestrictions,
	resolveToolDestination,
} from "../../domains/safety/information-flow.js";
import { outboundFilesOf } from "../registry-call-prep.js";
import { FLOW_SOURCE_TOOLS } from "../registry-verdicts.js";
import type { ToolSpec } from "../tool-spec.js";
import type { RegistryScope } from "./scope.js";

/**
 * The information-flow gates a registry call passes before its body runs: content carried outward to a
 * destination its source rules do not admit, and source admission while the flow policy is unavailable.
 */
export function createFlowGates(reg: RegistryScope) {
	const { deps } = reg;
	/**
	 * Block reason when this call would carry the session's restricted content
	 * to a destination its source rules do not admit, or null. Judged on the
	 * requested identity; a fetch's redirect hops are judged again by the
	 * fetch loop through `flowAdmitsUrl`.
	 */
	const outboundFlowViolation = (spec: ToolSpec, call: ClassifierCall): string | null => {
		const destination = resolveToolDestination(spec.name, call.args, (tool) => deps.flow?.mcpTransport?.(tool) ?? null);
		if (destination === null) return null;
		const refusal = deps.flow?.refusal() ?? null;
		if (refusal !== null) return refusal;
		return flowTransferRefusal(
			deps.safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
			carriedWithFiles(spec, call),
			destination,
		);
	};

	/** What the context carries, plus the labels of each file the call sends off the host. */
	const carriedWithFiles = (spec: ToolSpec, call: ClassifierCall): FlowRestrictionSet | null => {
		const files = outboundFilesOf(spec, call.args);
		const carried = deps.flow?.carried() ?? null;
		if (files.length === 0) return carried;
		return mergeFlowRestrictions(
			carried,
			...files.map((file) => deps.safety.policy?.flowRestrictionsFor?.(file.source) ?? null),
		);
	};

	/**
	 * Block reason when a storage URL an MCP call's files go to is not a
	 * destination the carried labels and the files' own labels admit, or null.
	 */
	const fileTargetFlowViolation = (spec: ToolSpec, call: ClassifierCall, url: string): string | null => {
		const refusal = deps.flow?.refusal() ?? null;
		if (refusal !== null) return refusal;
		const endpoint = flowEndpointIdentity(url);
		const violation = flowTransferRefusal(
			deps.safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
			carriedWithFiles(spec, call),
			{ kind: "tool", tool: spec.name, endpoint, ...(endpoint === null ? { endpointUnresolved: true } : {}) },
		);
		if (violation === null || endpoint === null) return violation;
		const origin = URL.parse(url)?.origin ?? null;
		return origin === null ? violation : violation.replaceAll(endpoint, origin);
	};

	/**
	 * Tools whose result can carry a restricted source into the transcript: the
	 * path readers the source rules name, every MCP tool, and the outbound
	 * tools. While the policy cannot say what is restricted, running one would
	 * persist content under no label, and a later resume would read it as
	 * unrestricted. Refused with the policy's own reason, which names the
	 * snapshot and the remedy and never the content.
	 */
	const sourceAdmissionRefusal = (spec: ToolSpec, call: ClassifierCall): string | null => {
		const refusal = deps.safety.policy?.informationFlow?.().refusal ?? null;
		if (refusal === null) return null;
		const isSource =
			FLOW_SOURCE_TOOLS.has(spec.name) ||
			isMcpToolName(spec.name) ||
			resolveToolDestination(spec.name, call.args) !== null;
		return isSource ? `${spec.name} refused while the information-flow policy is unavailable: ${refusal}` : null;
	};
	return { outboundFlowViolation, fileTargetFlowViolation, sourceAdmissionRefusal };
}
