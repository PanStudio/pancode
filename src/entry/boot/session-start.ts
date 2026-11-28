// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import { captureAdmits } from "../../core/telemetry/capture.js";
import { registerResearchTraceSink } from "../../core/telemetry/research-trace.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { describeUpgradeNotice, takeUpgradeNotice } from "../../domains/install/index.js";
import type { MiddlewareDomain } from "../../domains/middleware/extension.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import { type FlowRestrictionSet, resolveModelDestination } from "../../domains/safety/index.js";
import type { TelemetryDomain } from "../../domains/telemetry/extension.js";
import { createFlowLedger } from "../flow-ledger.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootSessionCells {
	flowRestrictionsForDispatch: (() => FlowRestrictionSet | null) | null;
	sessionOriginForDispatch: (() => { id: string; cwdHash: string; parentSessionId?: string | null } | null) | null;
}

/** What startBootSession reads from the names bootOrchestrator built before it. */
export interface BootSessionInput {
	heldTrustNotices: string[];
	interactive: boolean;
	middlewareDomain: MiddlewareDomain;
	providers: ProvidersContract | undefined;
	readFlowSessionEntries: (sessionId: string) => ReadonlyArray<unknown>;
	result: LoadResult<DomainContractMap>;
	telemetryDomain: TelemetryDomain;
	cells: BootSessionCells;
}

/**
 * Stage P2: the loaded contracts, the research trace sink, the session flow ledger and model flow admission, and the
 * initial notices with the once-per-version upgrade notice.
 */
export async function startBootSession(input: BootSessionInput) {
	const { heldTrustNotices, interactive, middlewareDomain, providers, readFlowSessionEntries, result, telemetryDomain } =
		input;
	const { cells } = input;
	const middleware = result.getContract("middleware");
	const middlewareRegistrar = middlewareDomain.registrar();
	const telemetry = result.getContract("telemetry");
	const telemetryRunReaders = telemetryDomain.runReaders();
	const safety = result.getContract("safety");
	const session = result.getContract("session");
	telemetry?.resetSession(session?.current()?.id ?? null);
	// Memory and compaction traces run outside any call; they journal into the session current when they fire,
	// the same session background memory calls are journaled under (#434).
	registerResearchTraceSink({
		admits(kind) {
			const origin = session?.current();
			const capture = origin ? telemetry?.telemetryCapture?.(origin) : undefined;
			return capture !== undefined && captureAdmits(capture, kind);
		},
		record(kind, data, preimage) {
			const origin = session?.current();
			if (origin) telemetry?.recordResearchTrace?.(origin, { role: "memory", id: origin.id }, kind, data, preimage);
		},
	});
	// One durable union of restricted sources per session. Every model send,
	// mediated outbound call and System One request is judged against it.
	const flowLedger = createFlowLedger({
		session: session ?? null,
		readEntries: readFlowSessionEntries,
		policy: safety?.policy,
	});
	// The registry and tool `flow` port, shared so both read the one ledger.
	const flowPort = { carried: flowLedger.current, refusal: flowLedger.refusal, absorb: flowLedger.absorb };
	cells.flowRestrictionsForDispatch = () => {
		// A worker launched while the ledger cannot vouch would carry unlabeled
		// context; the refusal surfaces at its first model request instead.
		const refusal = flowLedger.refusal();
		if (refusal !== null) throw new Error(refusal);
		return flowLedger.current();
	};
	/**
	 * Block reason when the session's restricted context may not reach a
	 * configured target as it is configured now, or null. The live target
	 * descriptor is read at every request, so a URL changed behind the id is
	 * judged on what it is now.
	 */
	const admitModelFlow = (destination: { targetId: string; runtimeId: string; wireModelId: string }): string | null =>
		flowLedger.admitDestination(
			resolveModelDestination({
				targetId: destination.targetId,
				runtimeId: destination.runtimeId,
				url: providers?.getTarget(destination.targetId)?.url ?? null,
				model: destination.wireModelId,
			}),
		);
	cells.sessionOriginForDispatch = () => session?.current() ?? null;
	const prompts = result.getContract("prompts");
	const agents = result.getContract("agents");
	const resources = result.getContract("resources");
	const extensions = result.getContract("extensions");
	const mux = result.getContract("mux");
	const contextDomain = result.getContract("context");
	const interop = result.getContract("interop");
	const initialNotices = interactive
		? [...heldTrustNotices, ...(contextDomain?.startupHints() ?? []).map((hint) => hint.text)]
		: [];
	// Once per version, interactive only: headless and ACP have no operator at
	// the keyboard to tell, and the record is left unclaimed for the boot that does.
	const upgrade = interactive ? takeUpgradeNotice() : null;
	if (upgrade !== null) {
		initialNotices.push(describeUpgradeNotice(upgrade));
		// No network: the packaged changelog says whether this upgrade fixes something the operator reported (R-14).
		const { takeFixedReportNotices } = await import("../../domains/report/index.js");
		initialNotices.push(...takeFixedReportNotices(pancodeStateDir(), upgrade));
	}
	return {
		admitModelFlow,
		agents,
		contextDomain,
		extensions,
		flowLedger,
		flowPort,
		initialNotices,
		interop,
		middleware,
		middlewareRegistrar,
		mux,
		prompts,
		resources,
		safety,
		session,
		telemetry,
		telemetryRunReaders,
	};
}
