// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { RESULT_COMMIT_MESSAGE_MAX_BYTES, resultSummaryMaxBytes } from "./result-contract-allowance.js";
import { COUNCIL_BALLOT_SHAPE, councilBallotShape } from "./result-contract-council.js";
import { packetCiteExample, packetCitesRule } from "./result-contract-gate.js";
import { MUTATION_FAILURE_RULE } from "./result-contract-schema.js";
import type { ResultContract } from "./result-contract-types.js";

/**
 * Bounded in-worker repair rounds for a terminal result that missed its
 * contract. A local model with few active parameters routinely gathers correct
 * evidence and then emits the wrong terminal shape; without feedback that run
 * is lost. Two rounds is the whole allowance, and the run fails after them.
 */
export const RESULT_CONTRACT_REPAIR_LIMIT = 2;

/** Live-read anchors quoted back to the model in a repair round. */
export const RESULT_CONTRACT_ANCHOR_LIMIT = 12;

/**
 * The exact terminal shape each contract accepts, quoted to the model verbatim.
 * This is the one place a contract's wire example is written; agent recipes,
 * repair rounds, and a fleet node's own answer directive all cite it, so a
 * prompt cannot drift from its validator.
 */
export function resultContractShape(contract: ResultContract): string {
	switch (contract.kind) {
		case "architect-plan":
			return `a plan artifact written to ${contract.path}, then optionally {"commitMessage":"...","summary":"..."} describing it`;
		case "scout-report":
			// The third alternative is the floor this validator actually accepts.
			// A repair round that only ever restates the strict shape is what the
			// run already failed twice, so it is told the cheaper exit as well.
			return '{"findings":[{"claim":"what you observed","path":"src/file.ts","line":1}],"needsSplit":false,"proposedSubtasks":[]} or {"findings":[],"needsSplit":true,"proposedSubtasks":[{"id":"inspect","task":"Inspect the boundary","dependencies":[],"expectedResultContract":"scout-report","requestedAuthority":"read-only"}]} or, if you cannot produce a citation you are sure of, at least {"findings":[{"claim":"what you observed"}]}, which is accepted as an ungrounded lead rather than losing the run';
		case "verifier-report":
			if (contract.assurance !== undefined)
				return `{"verdict":"fail","assurance":"${contract.assurance}","checks":[{"name":"f.post","passed":false,"evidence":"specification source and argument, trace or missing proof evidence","obligation":{"target":"src/file.c:f","kind":"post","pre":"input contract","post":"output contract","formula":"verification condition","status":"unknown"}}]}. Every check requires an obligation; optional fields are invariant, hazard and check (an exact declared proof check ID). Statuses: mechanized, modeled, argued, assumed, refuted, unknown. Assurance is fixed at ${contract.assurance}. Assumed, refuted and unknown never pass. Machine claims require this run's matching native verify proof evidence on unchanged inputs; missing evidence must be unknown with passed=false, never an invented execution.`;
			return 'one of {"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,"evidence":"exit 0"}]} or {"verdict":"fail","checks":[{"name":"npm run typecheck","passed":false,"evidence":"exit 1"}]}; verdict legal values are pass | fail and checks[].passed legal values are true | false';
		case "review-verdict": {
			if (contract.packet === undefined || contract.packet.length === 0)
				return 'one of {"verdict":"pass","checks":[{"name":"...","passed":true,"evidence":"what you inspected and observed"}]} or {"verdict":"fail","checks":[{"name":"...","passed":false,"evidence":"what you inspected and observed"}]}; the verdict must agree with every check';
			const example = packetCiteExample(contract.packet);
			return `one of {"verdict":"pass","checks":[{"name":"the change does what the task asks","passed":true,"evidence":"what you inspected and observed","cites":["${example}"]}]} or {"verdict":"fail","checks":[{"name":"...","passed":false,"evidence":"what you inspected and observed","cites":["${example}"]}]}; the verdict must agree with every check; ${packetCitesRule(contract.packet)}`;
		}
		case "judge-verdict":
			if (contract.candidates === undefined) return '{"verdict":"the conclusion","text":"the supported synthesis"}';
			return contract.packet === undefined || contract.packet.length === 0
				? `{"winner":1,"checks":[{"name":"...","passed":true,"evidence":"the item of the candidates' evidence this rests on"}]}; winner is an integer 1..${contract.candidates}`
				: `{"winner":1,"checks":[{"name":"...","passed":true,"evidence":"the item of the candidates' evidence this rests on","cites":["${packetCiteExample(contract.packet)}"]}]}; winner is an integer 1..${contract.candidates}; ${packetCitesRule(contract.packet)}`;
		case "council-report":
			return '{"members":[{"label":"alpha","runId":"run-1","round":1,"answer":"..."}],"synthesis":{"kind":"none"}}';
		case "council-ballot":
			return contract.options !== undefined && contract.options.length > 0
				? `${councilBallotShape(contract.options)}; verdict legal values are ${contract.options.join(" | ")}`
				: COUNCIL_BALLOT_SHAPE;
		case "debugger-report":
			return 'one of {"diagnosis":"...","reproduction":"reproduced","evidence":["..."]}, {"diagnosis":"...","reproduction":"not-reproduced","evidence":["..."]}, or {"diagnosis":"...","reproduction":"unknown","evidence":["..."]}; reproduction legal values are reproduced | not-reproduced | unknown';
		case "research-report":
			return 'one of {"source":"local","findings":[{"claim":"...","evidence":"..."}]} or {"source":"external","findings":[{"claim":"...","evidence":"..."}]}; source legal values are local | external';
		case "world-knowledge-report":
			return '{"discovery":"performed|caller-supplied-only|unavailable","facts":[{"claim":"...","evidence":"...","sources":["URL or document id"]}],"synthesis":["comparison or advisory conclusion"],"uncertainties":["..."],"followUpVerification":["..."]}';
		case "mutation-report":
			return `{"mutatedPaths":["src/file.ts"],"validations":[{"name":"npm test","passed":true,"evidence":"exit 0"}],"observations":["optional source or edit observations"],"declaredChecks":["optional checks not run; state why host execution is needed"],"commitMessage":"optional: the commit message for this change","summary":"the requested explanation or deliverable, or a specific limitation; otherwise optional","completion":{"state":"done|partly_done|not_done","limitations":[{"what":"...","why":"blocked_by_policy|missing_access|needs_decision|out_of_scope|out_of_budget|not_reproducible|tool_unavailable|other"}],"unverified":["claims made without a check behind them"],"remaining":["optional, for partly_done"]}}. completion is required: done when the assignment is finished, including a finding that nothing needed to change; partly_done or not_done with each limitation that stopped you. summary allows at most ${resultSummaryMaxBytes(contract)} UTF-8 bytes and commitMessage at most ${RESULT_COMMIT_MESSAGE_MAX_BYTES} UTF-8 bytes. Preserve the requested explanation and citations in summary when repairing the report; if they cannot fit or be grounded, state that specific limitation. Report only actual mutations. validations contains executed checks only; reads and edits are observations, never passed validations. Use validations:[] whenever no check executed, including a successful write without execution authority; this is unmeasured, not tests passed. ${MUTATION_FAILURE_RULE} Quality judges only the checks run after the change. observations and declaredChecks are optional arrays of strings with no passed status. Checks that were denied or unavailable belong in declaredChecks. Host checks are separate evidence from this worker's result.`;
		case "provenance-report":
			return '{"confirmedFacts":["..."],"missingEvidence":["..."],"nextInspections":["..."]}';
		case "delegation-plan":
			return '{"tasks":[{"id":"build","agent":"coder","description":"Implement the change","depends_on":[],"writes":["src"],"mode":"parallel"}]}';
		case "oracle-report":
			return '{"verdict":"one line","challenge":"the strongest objection you can mount","changesMyMind":"the evidence that would reverse the verdict","citedDecisions":["decision key or task id you relied on"]}';
		case "external-delegation":
		case "text-report":
			return "any final text";
		case "artifact-report":
			return `{"summary":"optional: what the artifact holds","completion":{"state":"done|partly_done|not_done","limitations":[{"what":"...","why":"blocked_by_policy|missing_access|needs_decision|out_of_scope|out_of_budget|not_reproducible|tool_unavailable|other"}],"unverified":["claims made without a check behind them"],"remaining":["optional, for partly_done"]}}; the artifact you wrote ${contract.path === undefined ? "at the location the task named" : `at ${JSON.stringify(contract.path)}, readable and non-empty on disk,`} is the result, and completion declares whether it is finished`;
		case "context-handbook":
			return '{"projectName":"string","identity":"one sentence","conventions":[],"invariants":[],"sections":[{"title":"Architecture","body":"markdown that cites `real/path.ts` tokens"}]}';
		case "code-report":
			return '{"passed":false,"exitCode":1,"checks":[{"name":"test","passed":false,"evidence":"exit 1"}],"artifactPaths":["/path/command.log"],"outputExcerpt":"..."}';
	}
}

/**
 * The compact output form a work round's reminder quotes, or null for a
 * contract whose result is not one JSON object a model writes (an artifact on
 * disk, any final text, a deterministic command). Kept to one line: it rides on
 * every tool batch, so a long wire example such as mutation-report's would cost
 * its bytes once per round.
 */
function resultContractReminderForm(contract: ResultContract): string | null {
	switch (contract.kind) {
		case "architect-plan":
		case "external-delegation":
		case "text-report":
		case "code-report":
			return null;
		case "artifact-report":
			return '{"summary":"...","completion":{"state":"done|partly_done|not_done","limitations":[],"unverified":[]}}';
		case "scout-report":
			return '{"findings":[{"claim":"...","path":"src/file.ts","line":1}],"needsSplit":false,"proposedSubtasks":[]}';
		case "verifier-report":
			return contract.assurance === undefined
				? '{"verdict":"pass|fail","checks":[{"name":"...","passed":true,"evidence":"..."}]}'
				: `{"verdict":"pass|fail","assurance":"${contract.assurance}","checks":[{"name":"...","passed":false,"evidence":"...","obligation":{...}}]}`;
		case "review-verdict":
			return contract.packet === undefined || contract.packet.length === 0
				? '{"verdict":"pass|fail","checks":[{"name":"...","passed":true,"evidence":"..."}]}'
				: `{"verdict":"pass|fail","checks":[{"name":"...","passed":true,"evidence":"...","cites":["${packetCiteExample(contract.packet)}"]}]}; cites from ${contract.packet.join(", ")}`;
		case "judge-verdict":
			return contract.candidates === undefined || contract.packet === undefined || contract.packet.length === 0
				? resultContractShape(contract)
				: `{"winner":1,"checks":[{"name":"...","passed":true,"evidence":"...","cites":["${packetCiteExample(contract.packet)}"]}]}; cites from ${contract.packet.join(", ")}`;
		case "debugger-report":
			return '{"diagnosis":"...","reproduction":"reproduced|not-reproduced|unknown","evidence":["..."]}';
		case "research-report":
			return '{"source":"local|external","findings":[{"claim":"...","evidence":"..."}]}';
		case "mutation-report":
			return '{"mutatedPaths":["..."],"validations":[{"name":"...","passed":true,"evidence":"..."}],"summary":"...","completion":{"state":"done|partly_done|not_done","limitations":[],"unverified":[]}}';
		case "council-ballot":
			return councilBallotShape(contract.options);
		default:
			return resultContractShape(contract);
	}
}

/**
 * One line naming the exact form of the final message, sent as a host
 * reminder on the request tail after each work round's tool results so it is
 * the most recent instruction whenever the model decides to stop. A recipe that states its contract only at the end of a long
 * system prompt loses it to a small model's recency: a 27B reviewer wrote a
 * correct review as Markdown three times, and passed once the same line moved
 * to the top of the recipe (WTF-P run mbh8qfocfm9p).
 */
export function resultContractReminder(contract: ResultContract): string | null {
	const form = resultContractReminderForm(contract);
	if (form === null) return null;
	return `[result contract: ${contract.kind}] When you finish, your final message is exactly one JSON object of the form ${form} and nothing else: no Markdown, code fences or commentary. Until then, keep working with the admitted tools.`;
}

export interface ResultContractRepairInput {
	contract: ResultContract;
	/** The validator's own reason; never a paraphrase. */
	reason: string;
	/** 1-based repair round. */
	attempt: number;
	/** `path:line` anchors from reads that succeeded in this run. */
	anchors: ReadonlyArray<string>;
	/** True only when admission preauthorized a larger tool-call revision phase. */
	toolsAvailable?: boolean;
}

/**
 * One repair directive. It states the validator's reason and exact shape. Tool
 * use remains closed unless dispatch preauthorized a larger revision phase.
 */
function resultContractRepairMessage(input: ResultContractRepairInput): string {
	const last = input.attempt >= RESULT_CONTRACT_REPAIR_LIMIT;
	const boundArtifact = input.contract.kind === "artifact-report" && input.contract.path !== undefined;
	const lines = [
		last
			? "FINAL RESULT REQUIRED IN THIS RESPONSE. Your previous response still did not satisfy this run's result contract."
			: "Your previous response did not satisfy this run's result contract.",
		`Validator reason: ${input.reason}`,
		input.toolsAvailable === true
			? "You may use the admitted tools to repair this validator failure, then emit the required terminal result."
			: "Tool use is over. Answer from the evidence you already gathered.",
		...(boundArtifact
			? [
					`Required result: ${resultContractShape(input.contract)}`,
					input.toolsAvailable === true
						? "Repair the required artifact on disk, then give a brief final status. Literal tool-call markup in final text does not write a file."
						: "State the limitation in a brief final status; the required artifact remains unsatisfied.",
				]
			: [
					`Emit exactly this shape and nothing else: ${resultContractShape(input.contract)}`,
					"Do not add prose, code fences, or commentary around it. Do not describe work you intend to do next.",
				]),
	];
	if (input.anchors.length > 0) {
		lines.push(
			"",
			"Source ranges you read successfully in this run (path:start-end, inclusive):",
			...input.anchors.slice(-RESULT_CONTRACT_ANCHOR_LIMIT).map((anchor) => `- ${anchor}`),
		);
	}
	if (input.contract.kind === "scout-report") {
		lines.push(
			"For each finding, use the exact source line that supports its claim inside a listed read range. Range endpoints are not suggested citations.",
			"If a finding's supporting line cannot be confirmed from the source already returned, remove that finding and keep the confirmed findings. Never shift a rejected citation into range just to pass validation.",
		);
	}
	return lines.join("\n");
}

/** A final-only repair retires the tool-exchange pattern, even at a prefix-cache cost. */
export function resultContractRepairUserMessage(input: ResultContractRepairInput) {
	return {
		role: "user",
		content: [{ type: "text", text: resultContractRepairMessage(input) }],
		timestamp: Date.now(),
	} as const;
}

/** Name of the synthetic tool call that carries a repair round. */
export const RESULT_CONTRACT_REPAIR_TOOL = "result_contract";

/**
 * One repair round as a protocol-legal tool exchange: a synthetic assistant
 * call to `result_contract` and the tool result that answers it, sharing the
 * id `pancode-result-contract-repair-N`. Strict endpoints (OpenAI, Anthropic)
 * reject a tool result no assistant call issued; local servers tolerated the
 * bare result, and this keeps the history-append shape #55 measured while
 * satisfying both. `stopReason: "toolUse"` and the toolCall block keep the
 * assistant half out of terminal validation, durable output, and the
 * synthesis sanitizer.
 *
 * The assistant half carries explicit zero usage. pi-ai's context estimator
 * (`estimateContextTokens`, run while sizing every request) dereferences
 * `usage` on any assistant message not marked `aborted`/`error`, so a
 * usage-less `toolUse` message throws `Cannot read properties of undefined
 * (reading 'totalTokens')` on the very next model round and the worker dies
 * with the contract `not-reached` (#70). Zero usage keeps the estimator on
 * the model's last real usage and its byte-for-byte prompt-cache behavior.
 */
export function resultContractRepairMessages(
	input: ResultContractRepairInput,
	origin: { provider: string; api: string; model: string },
) {
	const id = `pancode-result-contract-repair-${input.attempt}`;
	const timestamp = Date.now();
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: RESULT_CONTRACT_REPAIR_TOOL, arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				// PanCode wrote this message; no provider was called for it. Receipts
				// and journals count only calls that reached one.
				callInvoked: false,
			},
			...origin,
			timestamp,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: RESULT_CONTRACT_REPAIR_TOOL,
			content: [{ type: "text", text: resultContractRepairMessage(input) }],
			isError: true,
			timestamp,
		},
	] as const;
}
