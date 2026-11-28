// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * RECORD: what one measured iteration adds to the project's claims ledger, through the host's claims service.
 *
 * The agent's stated plan becomes a hypothesis on the campaign's slate (`slate.json` beside the journal, schema
 * `pancode.hypothesis-slate.v1`), whose success criterion names the objective check. Before the checks run, the
 * iteration's run is begun against the objective and gate checks, so the hypothesis is bound to this run. After they
 * run, every judged check (numeric-compare, reproduce) yields a claim from PanCode's own execution, and every research
 * hypothesis is tested without a claim (other project hypotheses bound to the same check keep the claim as their
 * evidence). A claim's reference agreement says the output still matches; it says nothing about whether the change
 * improved the metric. Whether the hypothesis held is the research grade's call (`researchHypothesisVerdict`): the
 * journal records it, and `research report` recomputes the grade from the raw samples.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionClaims } from "pancode/sdk/extension";
import { campaignDir, samplesName, writeFileAtomic } from "./store.ts";
import type { ResearchCampaign, ResearchGrade, ResearchHypothesisVerdict } from "./types.ts";

const HYPOTHESIS_SLATE_SCHEMA = "pancode.hypothesis-slate.v1";
const LEDGER_READ_LIMIT = 1000;

/** The hypothesis verdict a research grade implies: improved supports, regressed refutes, anything else is inconclusive. */
export function researchHypothesisVerdict(grade: ResearchGrade | null): ResearchHypothesisVerdict {
	if (grade?.verdict === "improved") return "supported";
	if (grade?.verdict === "regressed") return "refuted";
	return "inconclusive";
}

/** The claims run of one iteration, `<campaign>/it-NNNN`; the host records it as `extension:research:<run>`. */
export function iterationRun(campaign: ResearchCampaign, iteration: number): string {
	return `${campaign.id}/${samplesName(iteration)}`;
}

interface SlateEntry {
	id: string;
	statement: string;
	prediction: string;
	status: "proposed";
	experiment: { successCriterion: { kind: string; verifyId: string; statement: string } };
}

/** The campaign slate with hypothesis `H<iteration>` added or replaced, as written to `slate.json`. */
export function slateWith(
	campaign: ResearchCampaign,
	previous: string | null,
	iteration: number,
	hypothesis: { statement: string; prediction: string },
): string {
	let entries: SlateEntry[] = [];
	if (previous !== null) {
		try {
			const parsed = JSON.parse(previous) as { hypotheses?: unknown };
			if (Array.isArray(parsed.hypotheses)) entries = parsed.hypotheses as SlateEntry[];
		} catch {
			entries = [];
		}
	}
	const objective = campaign.objective;
	const id = `H${iteration}`;
	entries = entries.filter((entry) => entry.id !== id);
	entries.push({
		id,
		statement: hypothesis.statement,
		prediction:
			hypothesis.prediction.length > 0
				? hypothesis.prediction
				: `${objective.metric} moves ${objective.direction === "min" ? "down" : "up"} by at least ${objective.minImprovement * 100}%`,
		status: "proposed",
		experiment: {
			successCriterion: {
				kind: "research-objective",
				verifyId: objective.check,
				statement: `median ${objective.metric} ${objective.direction === "min" ? "falls" : "rises"} by at least ${objective.minImprovement * 100}% over ${objective.trials} interleaved pairs, with a bootstrap 95% interval excluding zero`,
			},
		},
	});
	return `${JSON.stringify({ schema: HYPOTHESIS_SLATE_SCHEMA, campaign: campaign.id, hypotheses: entries }, null, 2)}\n`;
}

export interface IterationRecord {
	/** Ledger id of the iteration's hypothesis, null when the ledger kept an unchanged earlier record. */
	hypothesis: string | null;
	bindings: Record<string, string[]>;
}

/**
 * Add the iteration's hypothesis to the campaign slate and record it, then begin the run's checks so the record is
 * bound to them.
 */
export async function beginIterationRecord(
	claims: ExtensionClaims,
	root: string,
	input: {
		campaign: ResearchCampaign;
		iteration: number;
		hypothesis: { statement: string; prediction: string };
		checks: ReadonlyArray<string>;
	},
): Promise<IterationRecord> {
	const { campaign } = input;
	const path = join(campaignDir(root, campaign.id), "slate.json");
	const text = slateWith(
		campaign,
		existsSync(path) ? readFileSync(path, "utf8") : null,
		input.iteration,
		input.hypothesis,
	);
	writeFileAtomic(path, text);
	const ids = await claims.hypotheses(campaign.id, text);
	const bindings = await claims.begin(iterationRun(campaign, input.iteration), input.checks);
	return { hypothesis: ids[`H${input.iteration}`] ?? null, bindings };
}

/**
 * Ledger ids of every research improvement hypothesis among `ids`: drafted from a campaign slate with the
 * `research-objective` criterion. Reference agreement is never evidence for one of them.
 */
async function researchHypotheses(claims: ExtensionClaims, ids: ReadonlySet<string>): Promise<string[]> {
	if (ids.size === 0) return [];
	const records = await claims.read({ types: ["hypothesis"], limit: LEDGER_READ_LIMIT });
	return records
		.filter((record) => {
			const criterion = record.criterion as { kind?: unknown } | undefined;
			return typeof record.id === "string" && ids.has(record.id) && criterion?.kind === "research-objective";
		})
		.map((record) => record.id as string);
}

/** A check's result by receipt, or a check the run stopped before judging. */
export type ResearchCheckOutcome = { check: string; receipt: string } | { check: string; execution: "aborted" };

/**
 * Record the claims the judged checks produced and test the hypotheses bound to the run. `outcomes` holds a receipt per
 * check that ran, or an aborted outcome for one the run stopped before judging. Returns the claim id per check.
 */
export async function finishIterationRecord(
	claims: ExtensionClaims,
	input: {
		campaign: ResearchCampaign;
		iteration: number;
		bindings: Readonly<Record<string, ReadonlyArray<string>>>;
		outcomes: ReadonlyArray<ResearchCheckOutcome>;
	},
): Promise<Record<string, string>> {
	const bound = new Set(Object.values(input.bindings).flat());
	const withoutClaim = await researchHypotheses(claims, bound);
	return claims.finish(
		iterationRun(input.campaign, input.iteration),
		input.outcomes,
		withoutClaim.length > 0 ? { withoutClaim } : {},
	);
}
