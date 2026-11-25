// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join, resolve } from "node:path";
import { sha256Hex } from "../../core/hash.js";
import type { MainSandboxPolicy } from "../../core/sandbox/main-session.js";
import {
	describeRepeat,
	extractNumericPayloadText,
	type NumericPayload,
	parseNumericPayload,
	payloadSpread,
	type RepeatRecord,
} from "../../tools/verify/numeric.js";
import { hashJudgedInputs, judgedInputDrift, runProvenanceProbes } from "../../tools/verify/provenance.js";
import { renderReproduceReport } from "../../tools/verify/reproduce.js";
import { runReproduce } from "../../tools/verify/reproduce-run.js";
import {
	collectedNoTests,
	JUDGED_CHECK_MAX_OUTPUT_BYTES,
	judgedFileSha256,
	judgeNumericTexts,
	judgePerfTexts,
	readJudgedFile,
} from "../../tools/verify/scripts.js";
import type { PlaybookCommand } from "../agents/playbook-commands.js";
import { CODE_STEP_CAPTURE_MAX_BYTES, CODE_STEP_CLEANUP_FAILURES, runCodeStep } from "./code-step.js";
import { checkedTree, memoEvidenceSealed, memoKey, readMemo, storeMemoEntry } from "./host-verification-memo.js";
import { nothingChanged, type ResolvedCheck, scopedToTask } from "./host-verification-scope.js";
import type { RunHostVerificationCheck } from "./types.js";
import { type VerificationSlotEvents, withVerificationSlot } from "./verification-slot.js";

export const OUTPUT_TAIL_BYTES = 2_048;

export function outputTail(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= OUTPUT_TAIL_BYTES) return value;
	let text = bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
	while (Buffer.byteLength(text, "utf8") > OUTPUT_TAIL_BYTES) text = text.slice(1);
	return text;
}

/**
 * A judged check whose admission sealed its reference or baseline digest fails when the file it reads now differs:
 * the task, or the check's own command, rewrote what the verdict is judged against. A digest that is absent (a
 * request sealed before digests existed) checks nothing.
 */
function sealedFileDrift(
	label: string,
	path: string,
	sealed: string | null,
	text: string | undefined,
): string | undefined {
	const now = judgedFileSha256(text);
	if (now === sealed) return undefined;
	return `${label} '${path}' changed since admission (${sealed ?? "absent"}→${now ?? "absent"})`;
}

/**
 * The kind-specific verdict for a resolved check that already ran. A command
 * check keeps its exit code. A numeric-compare check judges captured stdout
 * against the sealed reference; a perf-budget check judges the measured
 * duration against the sealed budget or baseline. Either judgement turns a
 * clean exit into exit 1 when it fails, and a judgement that cannot be made
 * (missing reference, unparseable output) fails with the reason in the tail.
 */
function judgeResolvedCheck(
	resolvedCheck: ResolvedCheck,
	exitCode: number,
	durationMs: number,
	stdout: string,
): { exitCode: number; report?: RunHostVerificationCheck["report"]; outputTail?: string } {
	if (resolvedCheck.kind === undefined || resolvedCheck.kind === "command" || exitCode !== 0) return { exitCode };
	if (resolvedCheck.kind === "numeric-compare" && resolvedCheck.numeric !== undefined) {
		const referenceText = readJudgedFile(resolvedCheck.numeric.reference);
		const drift = sealedFileDrift(
			"reference",
			resolvedCheck.numeric.reference,
			resolvedCheck.numeric.referenceSha256,
			referenceText,
		);
		if (drift !== undefined) return { exitCode: 1, outputTail: `numeric-compare: ${drift}` };
		if (referenceText === undefined) {
			return { exitCode: 1, outputTail: `numeric-compare: reference '${resolvedCheck.numeric.reference}' cannot be read` };
		}
		const report = judgeNumericTexts(
			stdout,
			referenceText,
			resolvedCheck.numeric.tolerance,
			`reference '${resolvedCheck.numeric.reference}'`,
			resolvedCheck.numeric.reference,
		);
		if (report instanceof Error) return { exitCode: 1, outputTail: `numeric-compare: ${report.message}` };
		return { exitCode: report.passed ? 0 : 1, report, outputTail: outputTail(report.summary) };
	}
	if (resolvedCheck.kind === "perf-budget" && resolvedCheck.perf !== undefined) {
		const perf = resolvedCheck.perf;
		const baselineText = perf.baseline === undefined ? undefined : readJudgedFile(perf.baseline);
		if (perf.baseline !== undefined) {
			const drift = sealedFileDrift("baseline", perf.baseline, perf.baselineSha256, baselineText);
			if (drift !== undefined) return { exitCode: 1, outputTail: `perf-budget: ${drift}` };
		}
		const report = judgePerfTexts(durationMs, perf, baselineText, `baseline '${perf.baseline ?? ""}'`);
		if (report instanceof Error) return { exitCode: 1, outputTail: `perf-budget: ${report.message}` };
		return { exitCode: report.passed ? 0 : 1, report, outputTail: outputTail(report.summary) };
	}
	return { exitCode: 1, outputTail: `${resolvedCheck.kind}: sealed check carries no parameters` };
}

/**
 * A sealed reproduce check runs through the same runner as the verify tool,
 * from the root its declared cwd implies. It is never memoized: its inputs
 * may be untracked files the tree fingerprint does not cover, so a stored
 * pass could outlive the bytes it judged.
 */
async function runSealedReproduce(
	resolvedCheck: ResolvedCheck,
	shellSandbox: MainSandboxPolicy | undefined,
): Promise<RunHostVerificationCheck> {
	const sealed = resolvedCheck.reproduce;
	const argv = [...resolvedCheck.argv];
	if (sealed === undefined) {
		return {
			check: resolvedCheck.check,
			argv,
			cwd: resolvedCheck.cwd,
			exitCode: 1,
			durationMs: 0,
			memo: false,
			notRun: "unconfigured",
			outputTail: "reproduce: sealed check carries no parameters",
		};
	}
	const depth = sealed.declaredCwd === "." ? 0 : sealed.declaredCwd.split("/").length;
	const root = resolve(resolvedCheck.cwd, ...Array.from({ length: depth }, () => ".."));
	const outcome = await runReproduce({
		command: argv,
		cwd: sealed.declaredCwd,
		timeoutMs: resolvedCheck.timeoutMs,
		spec: sealed.spec,
		workspaceRoot: root,
		...(sealed.referenceSha256 !== undefined ? { referenceSha256: sealed.referenceSha256 } : {}),
		...(shellSandbox !== undefined ? { shellSandbox } : {}),
	});
	const base = { check: resolvedCheck.check, argv, cwd: resolvedCheck.cwd, memo: false };
	switch (outcome.kind) {
		case "refused":
			return {
				...base,
				exitCode: 1,
				durationMs: 0,
				notRun: "refused",
				outputTail: outputTail(`reproduce refused: ${outcome.refusal.message}`),
			};
		case "run-failed":
			return {
				...base,
				argv: outcome.facts.argv,
				exitCode: outcome.facts.exitCode === 0 || outcome.facts.exitCode === null ? 1 : outcome.facts.exitCode,
				durationMs: outcome.facts.durationMs,
				// A check whose first run's process could not be created stopped on its environment, not on what it
				// judges. Once a run launched the check ran, so a later run that could not start leaves it unjudged.
				...(outcome.facts.launched || outcome.completed.length > 0 ? {} : { notRun: "spawn-failed" as const }),
				outputTail: outputTail(`reproduce ${outcome.message}`),
			};
		case "unjudgeable":
			return {
				...base,
				exitCode: 1,
				durationMs: outcome.facts.reduce((sum, fact) => sum + fact.durationMs, 0),
				outputTail: outputTail(`reproduce: ${outcome.message}`),
			};
		case "judged":
			return {
				...base,
				argv: outcome.report.conditions.argv,
				exitCode: outcome.report.passed ? 0 : 1,
				durationMs: outcome.facts.reduce((sum, fact) => sum + fact.durationMs, 0),
				outputTail: outputTail(renderReproduceReport(outcome.report)),
				report: outcome.report,
			};
	}
}

interface ResolvedCheckRun {
	runId: string;
	index: number;
	resolvedCheck: ResolvedCheck;
	stateDir: string;
	env: NodeJS.ProcessEnv;
	shellSandbox?: MainSandboxPolicy;
	onDiagnostic?: (error: unknown) => void;
	slot?: VerificationSlotEvents;
}

export async function runResolvedCheck(
	input: ResolvedCheckRun,
): Promise<{ check: RunHostVerificationCheck; outputExcerpt: string }> {
	const resolvedCheck = input.resolvedCheck;
	const note = `host verification ${resolvedCheck.check} for run ${input.runId}`;
	if (resolvedCheck.kind === "reproduce") {
		const check = await withVerificationSlot(
			note,
			() => runSealedReproduce(resolvedCheck, input.shellSandbox),
			input.slot,
		);
		return { check, outputExcerpt: check.outputTail };
	}
	if (nothingChanged.has(resolvedCheck)) {
		return {
			check: {
				check: resolvedCheck.check,
				argv: [...resolvedCheck.argv],
				cwd: resolvedCheck.cwd,
				exitCode: 0,
				durationMs: 0,
				memo: false,
				notRun: "nothing-changed",
				outputTail: "not run: nothing changed under it",
			},
			outputExcerpt: "",
		};
	}
	const command: PlaybookCommand = {
		id: resolvedCheck.check,
		argv: [...resolvedCheck.argv],
		cwd: "",
		timeoutMs: resolvedCheck.timeoutMs,
		env: [],
		description: `Host verification check ${resolvedCheck.check}.`,
	};
	const judgmentKey = checkDedupeKey(resolvedCheck);
	const tree = checkedTree(resolvedCheck.cwd) ?? undefined;
	const fingerprint = tree?.fingerprint ?? null;
	// A judged verdict is never memoized: a memo hit is authenticated only as a sealed exit 0, and a stored pass would
	// stand in for a judgement against a reference or baseline the fingerprint does not cover.
	const memoable = resolvedCheck.kind !== "numeric-compare" && resolvedCheck.kind !== "perf-budget";
	const key = fingerprint === null || !memoable ? null : memoKey(command, judgmentKey, fingerprint, input.env);
	const memoHit = (): { check: RunHostVerificationCheck; outputExcerpt: string } | undefined => {
		const hit =
			key === null || fingerprint === null
				? undefined
				: readMemo(input.stateDir).entries.find(
						(entry) =>
							entry.key === key &&
							entry.check.exitCode === 0 &&
							memoEvidenceSealed(input.stateDir, entry, resolvedCheck.check, fingerprint),
					);
		if (hit === undefined) return undefined;
		// A memo hit is always a pass, so no caller ever needs its output for
		// attribution; the empty excerpt says the fresh output does not exist.
		// The tree is stamped fresh on a hit: the memo matched this tree's content,
		// but its stored entry names whichever checkout first produced the pass (F6).
		return {
			check: {
				...hit.check,
				argv: [...hit.check.argv],
				memo: true,
				evidenceRunId: hit.runId,
				...(tree !== undefined ? { tree } : {}),
			},
			outputExcerpt: "",
		};
	};
	const hit = memoHit();
	if (hit !== undefined) return hit;
	// A check scoped to the task's own files is small; every other one takes the slot, and a pass another
	// process stored for this tree while this one waited answers it.
	if (scopedToTask.has(resolvedCheck)) return spawnResolvedCheck(input, command, judgmentKey, key, tree);
	return withVerificationSlot(
		note,
		async () => memoHit() ?? (await spawnResolvedCheck(input, command, judgmentKey, key, tree)),
		input.slot,
	);
}

async function spawnResolvedCheck(
	input: ResolvedCheckRun,
	command: PlaybookCommand,
	judgmentKey: string,
	key: string | null,
	tree: RunHostVerificationCheck["tree"],
): Promise<{ check: RunHostVerificationCheck; outputExcerpt: string }> {
	const resolvedCheck = input.resolvedCheck;
	const judged = resolvedCheck.kind === "numeric-compare" || resolvedCheck.kind === "perf-budget";
	const captureMaxBytes = judged ? JUDGED_CHECK_MAX_OUTPUT_BYTES : CODE_STEP_CAPTURE_MAX_BYTES;
	const numeric = resolvedCheck.kind === "numeric-compare" ? resolvedCheck.numeric : undefined;
	const inputs = (numeric?.inputs ?? []).map((absolute) => ({ path: absolute, absolute }));
	// Hashed before the command runs and again after it, so the verdict names the bytes the command read.
	const inputsBefore = await hashJudgedInputs(inputs);
	if (inputsBefore instanceof Error) {
		return {
			check: {
				check: resolvedCheck.check,
				argv: [...resolvedCheck.argv],
				cwd: resolvedCheck.cwd,
				exitCode: 1,
				durationMs: 0,
				memo: false,
				notRun: "refused",
				outputTail: outputTail(`numeric-compare: ${inputsBefore.message}; nothing ran`),
				...(tree !== undefined ? { tree } : {}),
			},
			outputExcerpt: "",
		};
	}
	const probes =
		numeric?.provenance === undefined
			? []
			: await runProvenanceProbes(numeric.provenance, {
					cwd: resolvedCheck.cwd,
					workspaceRoot: resolvedCheck.cwd,
					...(input.shellSandbox !== undefined ? { shellSandbox: input.shellSandbox } : {}),
				});
	const seed = numeric?.seed;
	const runCommand: PlaybookCommand = seed === undefined ? command : { ...command, env: [...command.env, seed.env] };
	const runEnv: NodeJS.ProcessEnv = seed === undefined ? input.env : { ...input.env, [seed.env]: seed.value };
	const runCount = numeric?.repeat ?? 1;
	const stepId = `verification-${input.index + 1}-${resolvedCheck.check.replace(/[^a-z0-9._-]/giu, "_")}`;
	type Judgement = ReturnType<typeof judgeResolvedCheck>;
	let chosen: { outcome: Awaited<ReturnType<typeof runCodeStep>>; judgement: Judgement } | undefined;
	let durationMs = 0;
	const failedRuns: number[] = [];
	const payloads: NumericPayload[] = [];
	// Every run is judged; one that fails to execute or to be judged ends the repetition, while one outside the
	// tolerance is recorded and the rest still run, so the spread covers every run that produced a payload.
	for (let run = 1; run <= runCount; run += 1) {
		const outcome = await runCodeStep({
			stepId: runCount > 1 ? `${stepId}-run${run}` : stepId,
			command: runCommand,
			workspaceRoot: resolvedCheck.cwd,
			artifactDir: join(input.stateDir, "artifacts", input.runId, "verification"),
			env: runEnv,
			maxOutputBytes: captureMaxBytes,
			...(input.shellSandbox !== undefined ? { shellSandbox: input.shellSandbox } : {}),
		});
		durationMs += outcome.record.durationMs;
		// outputTruncated also covers the report excerpt; only capture loss prevents judgement.
		let judgement: Judgement =
			judged && outcome.record.outputTruncated && outcome.record.outputBytes > captureMaxBytes
				? {
						exitCode: 1,
						outputTail: `verify: ${resolvedCheck.kind} command output exceeded ${captureMaxBytes} bytes before judgement; captured output was truncated`,
					}
				: judgeResolvedCheck(resolvedCheck, outcome.record.exitCode, outcome.record.durationMs, outcome.stdout);
		const inputDrift =
			inputs.length === 0 || outcome.record.exitCode !== 0 ? undefined : await judgedInputDrift(inputsBefore, inputs);
		if (inputDrift !== undefined) judgement = { exitCode: 1, outputTail: outputTail(`numeric-compare: ${inputDrift}`) };
		const runLabel = runCount > 1 ? `run ${run} of ${runCount}: ` : "";
		if (judgement.report?.kind !== "numeric-compare") {
			if (judgement.exitCode !== 0 && runLabel !== "" && judgement.outputTail !== undefined) {
				judgement = { ...judgement, outputTail: outputTail(`${runLabel}${judgement.outputTail}`) };
			}
			// A command or perf check runs once; a numeric run that could not be judged ends the repetition.
			if (chosen === undefined || judgement.exitCode !== 0) chosen = { outcome, judgement };
			if (judgement.exitCode !== 0 || resolvedCheck.kind !== "numeric-compare") break;
			continue;
		}
		const payload = parseNumericPayload(extractNumericPayloadText(outcome.stdout), `run ${run} output`);
		if (!(payload instanceof Error)) payloads.push(payload);
		if (!judgement.report.passed) failedRuns.push(run);
		if (chosen === undefined || (chosen.judgement.exitCode === 0 && judgement.exitCode !== 0)) {
			chosen = { outcome, judgement };
		}
	}
	const { outcome, judgement } = chosen as NonNullable<typeof chosen>;
	const artifactPath = outcome.record.artifactPaths[0];
	// A command check whose pytest or unittest run collected no test judged nothing: sealed as not run, never a failure
	// the task is rejected for (CLI-P51). Only a run that completed on its own, with its whole output and no changed
	// test run beside it, has a summary that speaks for the exit.
	const noTests =
		outcome.launched &&
		judgement.report === undefined &&
		(resolvedCheck.kind === undefined || resolvedCheck.kind === "command") &&
		!outcome.record.timedOut &&
		!outcome.record.outputTruncated &&
		outcome.record.commandRuns === undefined &&
		!CODE_STEP_CLEANUP_FAILURES.some((failure) => outcome.report.outputExcerpt.includes(failure)) &&
		collectedNoTests(outcome.record.argv, judgement.exitCode, outcome.report.outputExcerpt);
	if (judgement.report?.kind === "numeric-compare") {
		if (numeric?.inputs !== undefined || numeric?.provenance !== undefined) {
			judgement.report.provenance = { inputs: inputsBefore, probes };
		}
		const repeat: RepeatRecord = { runs: runCount, failedRuns, spread: payloadSpread(payloads) };
		judgement.report.repeat = repeat;
		judgement.outputTail = outputTail(`${judgement.report.summary}\nrepeat: ${describeRepeat(repeat)}`);
	}
	const check: RunHostVerificationCheck = {
		check: resolvedCheck.check,
		argv: [...outcome.record.argv],
		cwd: outcome.record.cwd,
		exitCode: noTests ? 0 : judgement.exitCode,
		durationMs,
		memo: false,
		...(outcome.launched ? {} : { notRun: "spawn-failed" as const }),
		...(noTests ? { notRun: "no-tests" as const } : {}),
		outputTail: noTests
			? outputTail(
					`not run: no tests collected (exit ${judgement.exitCode})\n${judgement.outputTail ?? outcome.report.outputExcerpt}`,
				)
			: (judgement.outputTail ?? outputTail(outcome.report.outputExcerpt)),
		...(artifactPath !== undefined ? { artifactPath } : {}),
		...(judgement.report !== undefined ? { report: judgement.report } : {}),
		...(tree !== undefined ? { tree } : {}),
	};
	if (check.exitCode === 0 && !noTests && key !== null && checkDedupeKey(resolvedCheck) === judgmentKey) {
		try {
			storeMemoEntry(input.stateDir, { key, runId: input.runId, check });
		} catch (error) {
			input.onDiagnostic?.(error);
		}
	}
	// The 8KB code-step excerpt (code-step.ts:37), not the 2KB receipt tail:
	// attribution reads the runner's own failure summary and a 2KB window loses
	// it on a large suite.
	return { check, outputExcerpt: outcome.report.outputExcerpt };
}

/** Identity shared by memo reuse and batch deduplication, including the declared judgment and its input files. */
export function checkDedupeKey(resolvedCheck: ResolvedCheck): string {
	const numeric = resolvedCheck.numeric;
	const perf = resolvedCheck.perf;
	return sha256Hex(
		JSON.stringify({
			check: resolvedCheck.check,
			...(nothingChanged.has(resolvedCheck) ? { nothingChanged: true } : {}),
			argv: [...resolvedCheck.argv],
			cwd: resolve(resolvedCheck.cwd),
			timeoutMs: resolvedCheck.timeoutMs,
			kind: resolvedCheck.kind ?? "command",
			reproduce: resolvedCheck.reproduce,
			numeric:
				numeric === undefined
					? undefined
					: {
							reference: numeric.reference,
							referenceDigest: sha256Hex(JSON.stringify(readJudgedFile(numeric.reference) ?? null)),
							sealedReference: numeric.referenceSha256,
							tolerance: numeric.tolerance,
							inputs: numeric.inputs,
							provenance: numeric.provenance,
							seed: numeric.seed,
							repeat: numeric.repeat,
						},
			perf:
				perf === undefined
					? undefined
					: {
							budget:
								perf.budget === undefined
									? undefined
									: {
											wallTimeMs: perf.budget.wallTimeMs,
											tolerance: perf.budget.tolerance,
										},
							baseline: perf.baseline,
							baselineDigest:
								perf.baseline === undefined ? undefined : sha256Hex(JSON.stringify(readJudgedFile(perf.baseline) ?? null)),
							sealedBaseline: perf.baselineSha256,
							tolerance: perf.tolerance,
						},
		}),
	);
}
