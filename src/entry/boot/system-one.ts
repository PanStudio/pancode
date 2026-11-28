// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import { credentialsPresent } from "../../domains/providers/credentials.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { LlmRequestAdmission, OneShotPort } from "../../domains/providers/one-shot.js";
import { isFlowRestrictionSet, resolveModelDestination } from "../../domains/safety/index.js";
import type { SessionContract } from "../../domains/session/contract.js";
import { createSystemOne, parseRouteList, type SystemOneInstance } from "../../domains/system-one/index.js";
import type { TelemetryContract } from "../../domains/telemetry/contract.js";
import type { cwdHash } from "../../engine/session.js";
import type { BootOptions } from "../boot-options.js";
import type { createFlowLedger } from "../flow-ledger.js";
import type { createSessionSettingsView } from "../session-settings-view.js";
import { createSideRequestAdmission } from "../side-request-admission.js";
import { createSystemOneControl } from "../system-one-control.js";

type SessionSettingsView = ReturnType<typeof createSessionSettingsView>;

/** What buildBootSystemOne reads from the names bootOrchestrator built before it. */
export interface BootSystemOneInput {
	createSystemOneOneShot: (providers: ProvidersContract, admitRequest: LlmRequestAdmission) => OneShotPort;
	cwdHash: typeof cwdHash;
	flowLedger: ReturnType<typeof createFlowLedger>;
	getCurrentSettings: SessionSettingsView["getCurrentSettings"];
	options: BootOptions;
	providers: ProvidersContract;
	result: LoadResult<DomainContractMap>;
	session: SessionContract | undefined;
	telemetry: TelemetryContract;
	unattendedYolo: () => boolean;
}

/**
 * Stage P10a: the side-request admission and System One over the session's settings, its one-shot safety judge, and
 * the control the slash commands drive.
 */
export function buildBootSystemOne(input: BootSystemOneInput) {
	const {
		createSystemOneOneShot,
		cwdHash,
		flowLedger,
		getCurrentSettings,
		options,
		providers,
		result,
		session,
		telemetry,
		unattendedYolo,
	} = input;
	// System One: one instance for the process, fixed at startup in what it binds.
	const currentSessionId = (): string | null => session?.current()?.id ?? null;
	const sessionScheduling = result.getContract("scheduling");
	sessionScheduling?.setNeverWaitForRaise?.(unattendedYolo);
	const systemOneAdmissionDeps = {
		providers,
		...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
		...(telemetry ? { telemetry } : {}),
		getCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
		currentSession: currentSessionId,
		repoIdentity: () => {
			const meta = session?.current();
			return meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null;
		},
	};
	const admitSystemOneRequest = createSideRequestAdmission(systemOneAdmissionDeps);
	const safetyJudgeOneShot = createSystemOneOneShot(
		providers,
		createSideRequestAdmission({ ...systemOneAdmissionDeps, role: "safety-judge" }),
	);
	// `run --systemone` holds for this process and writes nothing.
	const systemOneSettings = (): Readonly<PancodeSettings> => {
		const settings = getCurrentSettings();
		const use = options.headless?.systemOne;
		return use === undefined ? settings : { ...settings, systemOne: { ...settings.systemOne, use: parseRouteList(use) } };
	};
	const systemOneCore = createSystemOne({
		settings: () => systemOneSettings(),
		// Every engine request is judged against the restrictions it inherited
		// before a byte leaves, typed and LLM engines alike. The runner treats a
		// throw as abstention, so this only ever returns.
		flowCheck: (request) => {
			const reason = flowLedger.admitDestination(
				resolveModelDestination({
					targetId: request.destination.targetId,
					runtimeId: request.destination.runtimeId,
					url: request.destination.url ?? null,
					model: request.destination.wireModelId,
				}),
				isFlowRestrictionSet(request.inherited) ? request.inherited : null,
			);
			return reason === null ? { allowed: true } : { allowed: false, reason };
		},
		providers,
		credentialsPresent,
		oneShot: createSystemOneOneShot(providers, admitSystemOneRequest),
		admitLlmRequest: admitSystemOneRequest,
		// Each call is bound to the session it starts in, so a slow answer that settles
		// after /new, /resume or a branch switch files under the session that asked.
		currentSession: currentSessionId,
	});
	// Every caller that reaches System One through this instance inherits the
	// session's restrictions on its request unless it already names a narrower
	// set, so the flow check above sees them whoever asked.
	const systemOne: SystemOneInstance = {
		...systemOneCore,
		ask: (point, object, options) => {
			const flow = options?.flow !== undefined ? options.flow : flowLedger.current();
			const merged = { ...(options ?? {}), ...(flow !== null && flow !== undefined ? { flow } : {}) };
			return systemOneCore.ask(point, object, merged);
		},
	};
	const systemOneControl = createSystemOneControl({
		settings: () => systemOneSettings(),
		runtimes: { get: (id) => providers.getRuntime(id) },
		refusedEngines: () => systemOne.refusedEngines?.() ?? new Map(),
	});
	return { safetyJudgeOneShot, sessionScheduling, systemOne, systemOneControl };
}
