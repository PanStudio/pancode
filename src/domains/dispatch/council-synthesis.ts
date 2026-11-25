// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The council's synthesis run: the verdict a council round reaches is filed as its own judge run in the
 * ledger, settled with a receipt and published on the bus so the Fleet Runs board and /share can read it.
 * Lifted from createDispatchBundle; the bundle passes its ledger, bus and reproducibility collector.
 */
import type { DomainContext } from "../../core/domain-loader.js";
import { readPancodeVersion } from "../../core/package-root.js";
import { type TelemetryContext, type WorkerTelemetryContext, workerAgent } from "../../core/telemetry/context.js";
import type { DispatchRunIdentity } from "../../core/telemetry/live-events.js";
import { noCallRunUsageFacts, spendSumsOf } from "../../core/telemetry/pricing.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import { telemetryRunDirectory } from "../telemetry/index.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { collectReproducibilityMetadata } from "./reproducibility.js";
import { defaultRoutingIntent } from "./routing-intent.js";
import { createRunResultQuality } from "./run-findings.js";
import { settleRunResult } from "./run-settlement.js";
import { openRunTelemetry } from "./run-telemetry.js";
import { type Ledger, newRunId } from "./state.js";
import type { DispatchRequestOrigin, RunEnvelope, RunResult } from "./types.js";

/** What sealing a council synthesis reads from the dispatch bundle; createDispatchBundle passes its own. */
export interface CouncilSynthesisScope {
	context: DomainContext;
	requireLedger: () => Ledger;
	collectReproducibility: typeof collectReproducibilityMetadata;
	sinklessRunContext: (runId: string, sessionId: string | null | undefined) => TelemetryContext;
}

export async function sealCouncilSynthesis(
	{ collectReproducibility, context, requireLedger, sinklessRunContext }: CouncilSynthesisScope,
	input: {
		group: string;
		round: number;
		kind: "none" | "vote" | "judge";
		text: string;
		subjects: ReadonlyArray<{ runId: string; digest: string | null }>;
		template: RunResult;
		rootRequestOrigin?: DispatchRequestOrigin;
	},
): Promise<RunResult> {
	const l = requireLedger();
	const runId = newRunId();
	const task = `Council ${input.kind} synthesis`;
	// The synthesis is the council's own verdict, filed under the origin the
	// council was asked from: an internal origin would keep it out of the
	// transcript worker fold, and with it out of /share.
	const origin = input.template.requestOrigin ?? "agent";
	const asked = input.rootRequestOrigin !== undefined ? { rootRequestOrigin: input.rootRequestOrigin } : {};
	const gate = { role: "synthesis" as const, group: input.group, cycle: input.round, subjects: [...input.subjects] };
	const council = { group: input.group, label: "synthesis", round: input.round };
	const created = l.create({
		id: runId,
		agentId: "council-synthesis",
		executionRole: "judge",
		requestOrigin: origin,
		...asked,
		task,
		targetId: input.template.targetId,
		wireModelId: input.template.wireModelId,
		runtimeId: input.template.runtimeId,
		runtimeKind: input.template.runtimeKind,
		sessionId: input.template.sessionId,
		cwd: input.template.reproducibility?.cwd ?? process.cwd(),
	});
	const endedAt = new Date().toISOString();
	// The terminal patch commits with receiptPath, after the receipt exists (#428).
	const terminalPatch: Partial<RunEnvelope> = {
		status: "completed",
		outcome: "succeeded",
		endedAt,
		exitCode: 0,
		gate,
		council,
		...(input.template.lineage !== undefined ? { lineage: { ...input.template.lineage } } : {}),
		...(input.template.plan !== undefined ? { plan: input.template.plan } : {}),
	};
	const identity: DispatchRunIdentity = {
		runId,
		sessionId: input.template.sessionId ?? null,
		agentId: "council-synthesis",
		task,
		requestOrigin: origin,
		...asked,
		targetId: input.template.targetId,
		wireModelId: input.template.wireModelId,
		runtimeId: input.template.runtimeId,
		runtimeKind: input.template.runtimeKind,
		gate: { role: gate.role, cycle: gate.cycle },
		council,
	};
	try {
		// The synthesis never ran as a worker, so its run journal is opened here to settle it (#434).
		const synthesisContext: WorkerTelemetryContext =
			input.template.sessionId === null
				? { sessionId: null, runId, agent: workerAgent(runId) }
				: { sessionId: input.template.sessionId, runId, agent: workerAgent(runId) };
		const synthesisJournal = await openRunTelemetry(synthesisContext, telemetryRunDirectory(pancodeStateDir(), runId));
		let receipt: RunResult;
		try {
			receipt = await settleRunResult(
				l,
				runId,
				{
					runId,
					agentId: "council-synthesis",
					executionRole: "judge",
					requestOrigin: origin,
					task,
					targetId: input.template.targetId,
					wireModelId: input.template.wireModelId,
					runtimeId: input.template.runtimeId,
					runtimeKind: input.template.runtimeKind,
					startedAt: created.startedAt,
					endedAt,
					outcome: "succeeded",
					outcomeDetail: null,
					exitCode: 0,
					spend: noCallRunUsageFacts(),
					spendSums: spendSumsOf(noCallRunUsageFacts()),
					output: { state: "final", text: input.text, bytes: Buffer.byteLength(input.text, "utf8"), truncated: false },
					compiledPromptHash: null,
					staticCompositionHash: null,
					pancodeVersion: readPancodeVersion(),
					piMonoVersion: readPiMonoVersion(),
					platform: process.platform,
					nodeVersion: process.version,
					toolCalls: 0,
					toolStats: [],
					verification: { state: "unverified", basis: "no-validation-tool" },
					routingIntent: defaultRoutingIntent({}),
					quality: createRunResultQuality({ runtimeEnforceable: false, enforcementPassed: null, resultContract: null }),
					reproducibility: collectReproducibility(input.template.reproducibility?.cwd ?? process.cwd(), null),
					sessionId: input.template.sessionId,
					gate,
					council,
					...(input.template.lineage !== undefined ? { lineage: { ...input.template.lineage } } : {}),
					...(input.template.plan !== undefined ? { plan: input.template.plan } : {}),
				},
				terminalPatch,
				synthesisJournal,
				{ terminal: { terminalReason: "completed" }, processExitCode: null, frameType: null, usage: undefined },
			);
		} finally {
			await synthesisJournal.close();
		}
		await l.persist();
		// The synthesis never ran as a worker, so nothing else publishes its
		// lifecycle. The Fleet Runs board and /share are built from these
		// events, and a council whose synthesis they cannot see is a council
		// whose verdict the operator cannot read or share.
		context.bus.emit("run.enqueued", { ...identity, requestOrigin: origin });
		context.bus.emit(
			"run.started",
			{ ...identity, requestOrigin: origin, pid: null, assignmentId: runId, attempt: 0 },
			// The synthesis has no run journal; its start is not misfiled into the asker's (#434).
			sinklessRunContext(runId, identity.sessionId),
		);
		context.bus.emit("run.completed", {
			...identity,
			requestOrigin: origin,
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: input.template.lineage ?? { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			spend: receipt.spend,
			durationMs: 0,
			exitCode: 0,
			toolActivity: null,
		});
		return receipt;
	} catch (error) {
		reportDispatchDiagnostic(`finalize run ${runId}`, error);
		const detail = `finalization failure: ${error instanceof Error ? error.message : String(error)}`;
		try {
			l.update(runId, {
				status: "failed",
				outcome: "failed",
				outcomeDetail: detail,
				endedAt: new Date().toISOString(),
				exitCode: 1,
				gate,
				council,
			});
			await l.persist();
		} catch (ledgerError) {
			reportDispatchDiagnostic(`persist failed row for run ${runId}`, ledgerError);
		}
		context.bus.emit("run.failed", {
			...identity,
			outcome: "failed",
			outcomeDetail: detail,
			reason: "failed",
			lineage: input.template.lineage ?? { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			exitCode: 1,
		});
		throw error;
	}
}
