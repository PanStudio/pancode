// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { stampLocal } from "../core/format-time.js";
import { InvalidIdError } from "../core/safe-id.js";
import { pancodeStateDir } from "../core/xdg.js";
import {
	type FleetRootSeal,
	type FleetStepVerdict,
	fleetStepOfRun,
	inspectFleetRootSeal,
} from "../domains/dispatch/index.js";
import { readRunOwnerRecord } from "../domains/dispatch/run-directory-records.js";
import type { RunEvidence } from "../domains/evidence/index.js";
import {
	formatTrustAxes,
	formatTrustSummary,
	inspectRunEvidence,
	listRunEvidence,
	provenanceTranscriptLines,
} from "../domains/evidence/index.js";
import { formatColumns, printError } from "./argv.js";
import { runEvidenceDetail } from "./evidence-detail.js";
import { truncate } from "./text-layout.js";

const HELP = `pancode evidence inspect <runId> [--json] [--exit-code]
pancode evidence list [--json]

Inspect a finished run's evidence: its seal's verdict and the assessment the run
journaled before sealing. Each run is assessed when it settles; there is nothing
to build. A fleet root (fleet-<hex>) is a playbook run, not one run: inspect
prints its seal, outcome and step runs, and list counts roots apart.

Exit codes:
  inspect exits 1 when the seal was checked and rejected or the run has not
  settled (a fleet root: has not sealed, or its seal does not verify). inspect --json prints its document and exits 0 for either; add
  --exit-code to exit 1 for them there too.
`;

type EvidenceCommand = "inspect" | "list";

interface ParsedEvidenceArgs {
	command?: EvidenceCommand;
	json: boolean;
	exitCode: boolean;
	runId?: string;
	help: boolean;
}

function parseEvidenceArgs(args: ReadonlyArray<string>): ParsedEvidenceArgs {
	const parsed: ParsedEvidenceArgs = { help: false, json: false, exitCode: false };
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "inspect" || arg === "list") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown evidence command: ${arg}`);
		}
		if (arg === "--json" && !parsed.json) {
			parsed.json = true;
			continue;
		}
		if (parsed.command === "inspect" && arg === "--exit-code" && !parsed.exitCode) {
			parsed.exitCode = true;
			continue;
		}
		if (parsed.command === "inspect" && parsed.runId === undefined) {
			if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
			parsed.runId = arg;
			continue;
		}
		throw new Error(`unexpected evidence argument: ${arg}`);
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("evidence requires inspect or list");
	if (parsed.command === "inspect" && parsed.runId === undefined) throw new Error("inspect requires a run id");
	return parsed;
}

export async function runEvidenceCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedEvidenceArgs;
	try {
		parsed = parseEvidenceArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		// Usage that accompanies an error goes to stderr with it, so a caller capturing stdout for evidence output never
		// collects a help screen instead.
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const stateDir = pancodeStateDir();
	try {
		if (parsed.command === "inspect" && parsed.runId !== undefined) {
			if (parsed.json) return runEvidenceDetail(parsed.runId, { exitCode: parsed.exitCode });
			const root = inspectFleetRootSeal(parsed.runId);
			if (root !== null) {
				renderFleetRoot(root);
				return root.state === "verified" ? 0 : 1;
			}
			const evidence = await inspectRunEvidence(stateDir, parsed.runId);
			if (evidence.settled === null && evidence.integrity.state !== "failed") {
				printError(
					`run ${parsed.runId} has no settled record: ${evidence.integrity.state === "verified" ? "not settled" : evidence.integrity.reason}`,
				);
				process.stderr.write("  run `pancode evidence list` to see local runs\n");
				return 1;
			}
			renderEvidence(evidence, fleetStepOfRun(parsed.runId));
			// The record is printed either way, but the exit code never says ok over a seal that was checked and rejected.
			return evidence.integrity.state === "failed" ? 1 : 0;
		}
		// A root's scope holds its code steps' records, not a settled run; it is listed as the root it is.
		const roots: FleetRootSeal[] = [];
		const runs = await listRunEvidence(stateDir, (runId) => {
			const root = inspectFleetRootSeal(runId);
			if (root !== null) roots.push(root);
			return root !== null;
		});
		if (parsed.json)
			process.stdout.write(
				`${JSON.stringify({ ...evidenceListRecord(runs), fleetRoots: roots.map(fleetRootListRow) }, null, 2)}\n`,
			);
		else {
			renderEvidenceList(runs, stateDir);
			if (roots.length > 0) renderFleetRootList(roots);
		}
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return error instanceof InvalidIdError ? 2 : 1;
	}
}

function renderEvidence(evidence: RunEvidence, fleetStep: FleetStepVerdict | null): void {
	const write = (line: string) => process.stdout.write(`${line}\n`);
	write(`run: ${evidence.runId}`);
	write(`seal: ${evidence.integrity.state === "verified" ? "verified" : evidence.integrity.reason}`);
	write(`assessed: ${evidence.assessedAt ?? "no"}`);
	if (evidence.settled) write(`outcome: ${evidence.settled.outcome} (exit ${evidence.settled.exitCode ?? "?"})`);
	// A run can succeed and the step it ran for still fail; the fleet root judged the step.
	if (fleetStep !== null)
		write(
			`fleet step: ${fleetStep.rootId} ${fleetStep.stepId} ${fleetStep.succeeded ? "succeeded" : "failed"}${fleetStep.failureReason !== null ? `: ${fleetStep.failureReason}` : ""}`,
		);
	const pipeline = evidence.settled?.stepPipeline;
	if (pipeline)
		write(
			`step pipeline: ${pipeline.done ? "done" : `incomplete (${pipeline.stoppedBy ?? "unknown"})`} via ${pipeline.stepTool}${pipeline.template ? ` for ${pipeline.template}` : ""}`,
		);
	if (evidence.totals) {
		write(`tool calls: ${evidence.totals.toolCalls}`);
		write(`blocked tools: ${evidence.totals.blockedToolCalls}`);
		write(`tokens: ${evidence.totals.tokens.display}`);
		write(`cost: ${evidence.totals.usd.display}`);
	}
	if (evidence.firstPassSuccess !== null) write(`first pass: ${evidence.firstPassSuccess ? "yes" : "no"}`);
	if (evidence.quality !== null) {
		write(`quality: ${evidence.quality.verdict}`);
		for (const name of evidence.quality.failedValidations) write(`  failed validation: ${name}`);
		for (const baseline of evidence.quality.baselines)
			write(`  baseline before the change (not judged): ${baseline.name} ${baseline.passed ? "passed" : "failed"}`);
	}
	const unclassified = evidence.unclassifiedAfterLastCheck;
	if (unclassified) {
		write(`unclassified after last check: ${unclassified.count}`);
		for (const command of unclassified.commands) write(`  ran: ${command}`);
	}
	write(`tags: ${formatList(evidence.tags)}`);
	// The compact projection answers the trust questions; the canonical axis line beneath it is the drill-down, in the
	// same form the dispatch tool and monitor print.
	write(`trust: ${formatTrustSummary(evidence.trust)}`);
	write(`  ${formatTrustAxes(evidence.trust)}`);
	for (const verdict of evidence.verdicts) write(`gate ${verdict.decisionId}: ${verdict.outcome} (${verdict.review})`);
	// Provenance is the sealed assessment's; a run whose seal did not verify prints none.
	const lines = evidence.provenance === null ? [] : provenanceTranscriptLines(evidence.provenance, evidence.trust);
	if (lines.length > 0) {
		write("provenance:");
		for (const line of lines) write(`  ${line}`);
	}
	write(`findings: ${evidence.findings.length}`);
	for (const finding of evidence.findings) write(`  [${finding.severity}] ${finding.tag}: ${finding.message}`);
}

function fleetRootSealText(root: FleetRootSeal): string {
	if (root.state === "verified" || root.state === "pending") return root.state;
	return `${root.state} (${root.reason}): ${root.detail}`;
}

function renderFleetRoot(root: FleetRootSeal): void {
	const write = (line: string) => process.stdout.write(`${line}\n`);
	write(`fleet root: ${root.rootId} (playbook ${root.playbook})`);
	write(`seal: ${fleetRootSealText(root)}`);
	write(`outcome: ${root.outcome ?? "not sealed"}`);
	write(`steps: ${root.steps.length} of ${root.plannedStepCount} settled`);
	for (const step of root.steps)
		write(
			`  ${step.stepId} (${step.kind ?? "step"}) ${step.succeeded ? "succeeded" : "failed"} run ${step.runId}${step.failureReason !== null ? `: ${step.failureReason}` : ""}`,
		);
	write("a fleet root is a playbook run, not one run:");
	write("  pancode evidence inspect <runId> shows an agent step's run");
	write(`  pancode fleet code-steps ${root.rootId} shows its code steps`);
	write(`  pancode fleet verify ${root.rootId} re-verifies the root and its step runs`);
}

function fleetRootListRow(root: FleetRootSeal) {
	return {
		rootId: root.rootId,
		playbook: root.playbook,
		outcome: root.outcome,
		seal: root.state,
		sealReason: root.reason,
		steps: root.steps.map((step) => ({ stepId: step.stepId, runId: step.runId, succeeded: step.succeeded })),
	};
}

function renderFleetRootList(roots: ReadonlyArray<FleetRootSeal>): void {
	process.stdout.write(`\n${roots.length} fleet ${roots.length === 1 ? "root" : "roots"} (playbook runs)\n\n`);
	for (const root of roots)
		process.stdout.write(
			`${[root.rootId.padEnd(28), (root.outcome ?? "-").padEnd(12), root.state.padEnd(12), root.playbook].join("")}\n`,
		);
	process.stdout.write("pancode evidence inspect <rootId> shows a root's seal and step runs\n");
}

/** A listed run's state column: its seal's state, or whether a verified run has been assessed. */
function listState(run: RunEvidence): string {
	return run.integrity.state !== "verified" ? run.integrity.state : run.assessedAt === null ? "unassessed" : "assessed";
}

/** `evidence list --json`: the rows the text list prints, one object a run; `inspect --json` holds the rest. */
function evidenceListRecord(runs: ReadonlyArray<RunEvidence>) {
	return {
		version: 1 as const,
		runs: runs.map((run) => ({
			runId: run.runId,
			outcome: run.settled?.outcome ?? null,
			exitCode: run.settled?.exitCode ?? null,
			state: listState(run),
			assessedAt: run.assessedAt,
			tags: run.tags,
		})),
	};
}

function renderEvidenceList(runs: ReadonlyArray<RunEvidence>, stateDir: string): void {
	if (runs.length === 0) {
		process.stdout.write("no runs yet; a dispatched run is listed here once it settles\n");
		return;
	}
	// Time, role and task say which run a row is; the id alone did not.
	const table = runs.map((run) => [
		run.runId,
		run.settled === null ? "-" : stampLocal(run.settled.startedAt),
		run.settled?.agentId ?? "-",
		run.settled?.outcome ?? "unsettled",
		listState(run),
		truncate((readRunOwnerRecord(stateDir, run.runId)?.started.task ?? "").replace(/\s+/gu, " ").trim() || "-", 40),
		formatList(run.tags),
	]);
	process.stdout.write(formatColumns([["run", "started", "role", "outcome", "state", "task", "tags"], ...table]));
	process.stdout.write(`${runs.length} ${runs.length === 1 ? "run" : "runs"}\n`);
}

function formatList(values: ReadonlyArray<string>): string {
	return values.length === 0 ? "none" : values.join(", ");
}
