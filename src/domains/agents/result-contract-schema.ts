// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { gateCheckSchema } from "./result-contract-gate.js";
import type { ResultContract } from "./result-contract-types.js";
import { AGENT_AUTOMATION_AUTHORITIES } from "./spec.js";

/** The generation schema of a builder report's completion declaration; `parseCompletionDeclaration` decides. */
const COMPLETION_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		state: { type: "string", enum: ["done", "partly_done", "not_done"] },
		limitations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					what: { type: "string", minLength: 1 },
					why: {
						type: "string",
						enum: [
							"blocked_by_policy",
							"missing_access",
							"needs_decision",
							"out_of_scope",
							"out_of_budget",
							"not_reproducible",
							"tool_unavailable",
							"other",
						],
					},
				},
				required: ["what", "why"],
				additionalProperties: false,
			},
		},
		unverified: { type: "array", items: { type: "string", minLength: 1 } },
		remaining: { type: "array", items: { type: "string", minLength: 1 } },
	},
	required: ["state", "limitations", "unverified"],
	additionalProperties: false,
};

/**
 * A failing mutation validation says which red it reports, with one example of each, wherever the worker reads the
 * report's shape: the instruction, the bound schema and every repair of a report that left it out.
 */
export const MUTATION_FAILURE_RULE =
	'Every passed:false entry must carry "baseline": true for a deliberate run before the change, such as a red test-first baseline, e.g. {"name":"npm test","passed":false,"evidence":"exit 1 before the fix","baseline":true}; false for a failure on the changed tree, e.g. {"name":"npm test","passed":false,"evidence":"exit 1","baseline":false}. Report the run after the change as its own entry.';
const BASELINE_SCHEMA = { type: "boolean", description: MUTATION_FAILURE_RULE };

/** Generation schemas guide serialization; the semantic validators below remain authoritative. */
export function internalHelperResultSchema(contract: ResultContract): Record<string, unknown> | null {
	const text = { type: "string", minLength: 1 };
	const list = (items: Record<string, unknown>) => ({ type: "array", items });
	const object = (properties: Record<string, unknown>) => ({
		type: "object",
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	});
	const strings = list(text);
	switch (contract.kind) {
		case "mutation-report":
			return {
				...object({
					mutatedPaths: strings,
					validations: list({
						anyOf: [
							{
								...object({ name: text, passed: { type: "boolean", enum: [true] }, evidence: text }),
								properties: {
									name: text,
									passed: { type: "boolean", enum: [true] },
									evidence: text,
									baseline: { type: "boolean" },
								},
							},
							object({ name: text, passed: { type: "boolean", enum: [false] }, evidence: text, baseline: BASELINE_SCHEMA }),
						],
					}),
					observations: strings,
					declaredChecks: strings,
					summary: { type: ["string", "null"] },
					commitMessage: { type: ["string", "null"] },
					completion: COMPLETION_SCHEMA,
				}),
				required: ["mutatedPaths", "validations", "completion"],
			};
		case "scout-report":
			return object({
				findings: list({
					anyOf: [object({ claim: text, path: text, line: { type: "integer", minimum: 1 } }), object({ claim: text })],
				}),
				needsSplit: { type: "boolean" },
				proposedSubtasks: {
					...list(
						object({
							id: text,
							task: { ...text, maxLength: 4096 },
							dependencies: { ...strings, maxItems: 4, uniqueItems: true },
							expectedResultContract: { type: "string", enum: [...RESULT_CONTRACT_KINDS] },
							requestedAuthority: { type: "string", enum: [...AGENT_AUTOMATION_AUTHORITIES] },
						}),
					),
					maxItems: 4,
				},
			});
		case "research-report":
			return object({
				source: { type: "string", enum: ["local", "external"] },
				findings: list(object({ claim: text, evidence: text })),
			});
		case "world-knowledge-report":
			return object({
				discovery: { type: "string", enum: ["performed", "caller-supplied-only", "unavailable"] },
				facts: list(object({ claim: text, evidence: text, sources: strings })),
				synthesis: strings,
				uncertainties: strings,
				followUpVerification: strings,
			});
		case "provenance-report":
			return object({ confirmedFacts: strings, missingEvidence: strings, nextInspections: strings });
		case "oracle-report":
			return object({ verdict: text, challenge: text, changesMyMind: text, citedDecisions: strings });
		case "context-handbook":
			return object({
				projectName: text,
				identity: text,
				conventions: strings,
				invariants: strings,
				sections: list(object({ title: text, body: text })),
			});
		default:
			return null;
	}
}

/**
 * The schema a final-only round binds a prose-parsed contract to on a runtime
 * that enforces `response_format`, or null when the contract has no single
 * JSON-object form or its form is too conditional for one schema (an assured
 * verifier's obligations). It constrains shape only: the validator remains the
 * authority on verdict agreement, grounding and size.
 */
export function resultContractResponseSchema(contract: ResultContract): Record<string, unknown> | null {
	const helper = internalHelperResultSchema(contract);
	if (helper !== null) return helper;
	const text = { type: "string", minLength: 1 };
	const object = (properties: Record<string, unknown>) => ({
		type: "object",
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	});
	switch (contract.kind) {
		case "verifier-report":
		case "review-verdict": {
			if (contract.kind === "verifier-report" && contract.assurance !== undefined) return null;
			const packet = contract.kind === "review-verdict" ? contract.packet : undefined;
			return object({
				verdict: { type: "string", enum: ["pass", "fail"] },
				checks: { type: "array", minItems: 1, items: gateCheckSchema(packet) },
			});
		}
		case "judge-verdict":
			// Only a packet-bearing compete judge gets a bound shape; its cites name the packet's ids (M10).
			if (contract.candidates === undefined || contract.packet === undefined || contract.packet.length === 0) return null;
			return object({
				winner: { type: "integer", minimum: 1, maximum: contract.candidates },
				checks: { type: "array", minItems: 1, items: gateCheckSchema(contract.packet) },
			});
		case "debugger-report":
			return object({
				diagnosis: text,
				reproduction: { type: "string", enum: ["reproduced", "not-reproduced", "unknown"] },
				evidence: { type: "array", items: text },
			});
		case "council-ballot":
			return object({
				verdict:
					contract.options !== undefined && contract.options.length > 0
						? { type: "string", enum: [...contract.options] }
						: text,
				text,
			});
		default:
			return null;
	}
}

export const RESULT_CONTRACT_KINDS: ReadonlyArray<ResultContract["kind"]> = [
	"architect-plan",
	"scout-report",
	"verifier-report",
	"council-report",
	"debugger-report",
	"research-report",
	"world-knowledge-report",
	"mutation-report",
	"provenance-report",
	"external-delegation",
];
