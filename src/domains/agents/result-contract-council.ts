// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import {
	failure,
	hasOnlyKeys,
	parseJson,
	string,
	success,
	unexpectedResultKeyReason,
} from "./result-contract-payload.js";
import type { ResultContract, ResultContractValidation } from "./result-contract-types.js";

/**
 * Longest verdict token a ballot may cast, in bytes.
 *
 * A tally groups members by their exact verdict string, so a verdict that is a
 * sentence can only ever tie with itself and a council of any size reports
 * `no_majority`. The bound is what makes a majority reachable: it forces the
 * decision into a token members can match (`yes`, `no`, `keep`, an option
 * name) and pushes the reasoning into `text`, where the report already reads
 * it. A newline is refused for the same reason.
 */
export const COUNCIL_BALLOT_VERDICT_MAX_BYTES = 64;

/**
 * The verdict slot of the ballot example. It names what goes there instead of
 * showing an answer: an example token such as "yes" is what a small model
 * copies into its ballot whatever the question (FL-23), so no ballot example
 * carries one.
 */
const COUNCIL_BALLOT_VERDICT_PLACEHOLDER = "<your answer as one short token>";

/**
 * The ballot's wire shape, quoted verbatim to the member that must cast it and
 * by the repair round that corrects it. Exported because the council composes
 * the member's ask from it, which is the rule this module already states: a
 * contract's example is written once so a prompt cannot drift from its
 * validator.
 */
export const COUNCIL_BALLOT_SHAPE = `{"verdict":${JSON.stringify(COUNCIL_BALLOT_VERDICT_PLACEHOLDER)},"text":"the answer and the evidence behind it"}`;

/**
 * The ballot shape for a question that listed its answers. The verdict is a
 * placeholder naming them, so no example token sits where a member may copy it.
 */
export function councilBallotShape(options?: ReadonlyArray<string>): string {
	if (options === undefined || options.length === 0) return COUNCIL_BALLOT_SHAPE;
	const placeholder = `<one of: ${options.join("|")}>`;
	return COUNCIL_BALLOT_SHAPE.replace(JSON.stringify(COUNCIL_BALLOT_VERDICT_PLACEHOLDER), JSON.stringify(placeholder));
}

/** Whether a listed answer can be cast as a verdict at all: one non-empty line within the verdict bound. */
export function isCouncilBallotOption(option: string): boolean {
	const trimmed = option.trim();
	return (
		trimmed.length > 0 &&
		trimmed === option &&
		!trimmed.includes("\n") &&
		Buffer.byteLength(trimmed, "utf8") <= COUNCIL_BALLOT_VERDICT_MAX_BYTES
	);
}

/**
 * The key a verdict is tallied and matched under: lower-cased, with any run of
 * spaces, hyphens and underscores read as one space, so `url-path`, `URL path`
 * and `url_path` are one answer. Spelling alone split a 4-of-5 agreement into a
 * reported tie on the Copilot seat (FL-23).
 */
export function councilVerdictKey(verdict: string): string {
	return verdict
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/gu, " ");
}

interface CouncilBallot {
	/** The comparable token the tally counts. */
	verdict: string;
	/** The member's answer in prose, which is what the council report shows. */
	text: string;
}

/**
 * Read a council member's ballot. The council reads a verdict out of the
 * member's terminal text with its own reader, because the judge synthesis
 * carries the same two fields under no contract at all; this one is what
 * decides whether the member is allowed to seal that text as its result.
 */
function parseCouncilBallot(output: string | null): CouncilBallot | null {
	const parsed = parseJson(output);
	if (!parsed.ok) return null;
	const value = parsed.value;
	if (!hasOnlyKeys(value, ["verdict", "text"]) || !string(value.verdict) || !string(value.text)) return null;
	const verdict = value.verdict.trim();
	if (verdict.includes("\n") || Buffer.byteLength(verdict, "utf8") > COUNCIL_BALLOT_VERDICT_MAX_BYTES) return null;
	return { verdict, text: value.text.trim() };
}

export function validateCouncilBallot(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	const unexpected = unexpectedResultKeyReason("Council ballot", value, ["verdict", "text"]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	for (const key of ["verdict", "text"] as const) {
		if (!string(value[key])) return failure(contract, "unmeasured", `Council ballot ${key} must be a non-empty string`);
	}
	const ballot = parseCouncilBallot(output);
	if (ballot === null) {
		return failure(
			contract,
			"unmeasured",
			`Council ballot verdict must be a single line of at most ${COUNCIL_BALLOT_VERDICT_MAX_BYTES} UTF-8 bytes`,
		);
	}
	// A copied placeholder is no answer; the tally would count it as one.
	if (councilVerdictKey(ballot.verdict) === COUNCIL_BALLOT_VERDICT_PLACEHOLDER) {
		return failure(
			contract,
			"unmeasured",
			`Council ballot verdict ${JSON.stringify(ballot.verdict)} copies the placeholder; cast your own answer as the verdict`,
		);
	}
	const options = contract.kind === "council-ballot" ? contract.options : undefined;
	if (options !== undefined && options.length > 0) {
		const verdict = councilVerdictKey(ballot.verdict);
		if (!options.some((option) => councilVerdictKey(option) === verdict)) {
			return failure(
				contract,
				"unmeasured",
				`Council ballot verdict ${JSON.stringify(ballot.verdict)} is not one of the listed options: ${options.join(" | ")}`,
			);
		}
	}
	// Unmeasured, like every other contract whose shape carries no correctness
	// claim: casting a well-formed ballot says nothing about whether the member
	// was right, and the tally is a count of opinions rather than a check.
	return success(contract, "unmeasured", ballot);
}

export interface CouncilReportMember {
	label: string;
	runId: string;
	round: number;
	answer: string;
	verdict?: string;
	failed?: { reason: string };
}

/** The run id a council report gives a seat that never ran because admission found its target down (FL-4). */
export const COUNCIL_SEAT_NOT_RUN_ID = "not-run";
/** What every council surface says for such a seat, in place of a failed answer. */
export const COUNCIL_SEAT_NOT_RUN_WORDS = "seat not run (connection unavailable)";

/**
 * A seat that never ran because its target was down: it is skipped, not a failed answer, so a council counts only the
 * seats that ran. Takes an unparsed member too, since `/council` reads tool details before any parse.
 */
export function isCouncilSeatNotRun(member: { readonly runId?: unknown; readonly failed?: unknown }): boolean {
	if (member.failed === null || typeof member.failed !== "object") return false;
	const reason = (member.failed as { reason?: unknown }).reason;
	return member.runId === COUNCIL_SEAT_NOT_RUN_ID || (typeof reason === "string" && reason.startsWith("seat not run"));
}

export interface CouncilReport {
	members: CouncilReportMember[];
	synthesis: {
		kind: "none" | "judge" | "vote";
		text?: string;
		verdict?: string;
		tally?: Record<string, number>;
		judgeRunId?: string;
	};
	/** Members a per-member deadline ended; the council returned without their final answer. */
	partial?: { timedOut: string[] };
}

export function parseCouncilReport(output: string | null): CouncilReport | null {
	if (output === null) return null;
	const parsed = parseJsonObjectPayload(output);
	if (!parsed.ok) return null;
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["members", "synthesis", "partial"]) ||
		!Array.isArray(value.members) ||
		value.members.length === 0
	) {
		return null;
	}
	const members: CouncilReportMember[] = [];
	for (const raw of value.members) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const member = raw as Record<string, unknown>;
		if (
			!hasOnlyKeys(member, ["label", "runId", "round", "answer", "verdict", "failed"]) ||
			!string(member.label) ||
			!string(member.runId) ||
			!Number.isInteger(member.round) ||
			Number(member.round) < 1 ||
			typeof member.answer !== "string" ||
			(member.verdict !== undefined && !string(member.verdict))
		)
			return null;
		let failed: { reason: string } | undefined;
		if (member.failed !== undefined) {
			if (
				member.failed === null ||
				typeof member.failed !== "object" ||
				Array.isArray(member.failed) ||
				!hasOnlyKeys(member.failed as Record<string, unknown>, ["reason"]) ||
				!string((member.failed as Record<string, unknown>).reason)
			)
				return null;
			failed = { reason: (member.failed as { reason: string }).reason };
		}
		members.push({
			label: member.label,
			runId: member.runId,
			round: Number(member.round),
			answer: member.answer,
			...(member.verdict !== undefined ? { verdict: member.verdict as string } : {}),
			...(failed !== undefined ? { failed } : {}),
		});
	}
	if (value.synthesis === null || typeof value.synthesis !== "object" || Array.isArray(value.synthesis)) return null;
	const rawSynthesis = value.synthesis as Record<string, unknown>;
	if (!hasOnlyKeys(rawSynthesis, ["kind", "text", "verdict", "tally", "judgeRunId"])) return null;
	if (rawSynthesis.kind !== "none" && rawSynthesis.kind !== "judge" && rawSynthesis.kind !== "vote") return null;
	for (const key of ["text", "verdict", "judgeRunId"] as const) {
		if (rawSynthesis[key] !== undefined && !string(rawSynthesis[key])) return null;
	}
	let tally: Record<string, number> | undefined;
	if (rawSynthesis.tally !== undefined) {
		if (rawSynthesis.tally === null || typeof rawSynthesis.tally !== "object" || Array.isArray(rawSynthesis.tally))
			return null;
		tally = {};
		for (const [key, count] of Object.entries(rawSynthesis.tally as Record<string, unknown>)) {
			if (!key || !Number.isInteger(count) || Number(count) < 0) return null;
			tally[key] = Number(count);
		}
	}
	let partial: CouncilReport["partial"];
	if (value.partial !== undefined) {
		const raw = value.partial as Record<string, unknown> | null;
		if (
			raw === null ||
			typeof raw !== "object" ||
			!hasOnlyKeys(raw, ["timedOut"]) ||
			!Array.isArray(raw.timedOut) ||
			!raw.timedOut.every(string)
		)
			return null;
		partial = { timedOut: [...(raw.timedOut as string[])] };
	}
	return {
		members,
		...(partial !== undefined ? { partial } : {}),
		synthesis: {
			kind: rawSynthesis.kind,
			...(rawSynthesis.text !== undefined ? { text: rawSynthesis.text as string } : {}),
			...(rawSynthesis.verdict !== undefined ? { verdict: rawSynthesis.verdict as string } : {}),
			...(tally !== undefined ? { tally } : {}),
			...(rawSynthesis.judgeRunId !== undefined ? { judgeRunId: rawSynthesis.judgeRunId as string } : {}),
		},
	};
}
