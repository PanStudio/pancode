// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Worker-ask decisions: the safety judge's answer under fleet.permissions.mode=judge and the main agent's
 * answer to an ask (grant, forward to the operator, or refuse). Lifted from createDispatchBundle; the
 * bundle passes the grant broker and the state each decision reads.
 */

import type { SafetyContract } from "../safety/contract.js";
import type { DispatchBundleOptions } from "./bundle-types.js";
import type { DispatchContract, DispatchRequest, MainGrantOutcome, WorkerGrantView } from "./contract.js";
import { evaluateJudgedGrant, evaluateMainGrant } from "./grant-authority.js";
import type { GrantBroker, GrantRecord } from "./grant-broker.js";
import { evaluateWriteRootGrant, WRITE_ROOTS_GRANT_TOOL, writeRootOutcomeMessage } from "./write-root-requests.js";

/** The dispatch bundle's grant state a worker-ask decision reads; createDispatchBundle passes its own. */
export interface GrantDecisionScope {
	options: DispatchBundleOptions | undefined;
	grantBroker: GrantBroker;
	safety: SafetyContract;
	grantAttended: () => boolean;
	grantView: (record: GrantRecord) => WorkerGrantView;
	foreignAskOwner: (runId: string, requestId: string) => string | null;
	heldAskRefusal: (holder: string, runId: string) => string;
}

/**
 * The safety judge's answer to one worker ask under fleet.permissions.mode=judge,
 * decided in this process and never inside the worker. The verdict is
 * delivered through the broker like a main grant, bound to the attempt and
 * argument digest the worker parked; a request that left pending while the
 * judge read it (expiry, cancel, worker exit) keeps that settlement.
 */
export async function decideJudgedGrant(
	{
		grantAttended,
		grantBroker,
		options,
		safety,
	}: Pick<GrantDecisionScope, "grantAttended" | "grantBroker" | "options" | "safety">,
	record: GrantRecord,
	turnConstraints: DispatchRequest["turnConstraints"],
): Promise<void> {
	const judge = options?.workerAskJudge;
	const settled = new AbortController();
	void grantBroker.waitForDecision(record.requestId).then(() => settled.abort());
	const hookDrift = judge?.hookDrift?.();
	let verdict: Awaited<ReturnType<typeof evaluateJudgedGrant>>;
	try {
		verdict = await evaluateJudgedGrant({
			record,
			autonomy: judge?.autonomy() ?? "default",
			safety,
			judge: judge?.seat(),
			...(turnConstraints !== undefined ? { turnConstraints } : {}),
			signal: settled.signal,
			...(hookDrift !== undefined ? { hookDrift } : {}),
		});
	} catch (error) {
		verdict = {
			kind: "deny",
			reason: `the safety judge failed (${error instanceof Error ? error.message : String(error)}), so the ask is denied`,
		};
	}
	if (grantBroker.get(record.requestId)?.state !== "pending") return;
	if (verdict.kind === "ask-operator") {
		// Changed git hooks are the operator's call: attended, the request
		// reaches the operator's card and an allow accepts the files it named;
		// with nobody to ask it is denied.
		if (!grantAttended()) {
			grantBroker.decide(record.requestId, { decision: "deny", issuer: "main", reason: verdict.reason });
			return;
		}
		grantBroker.markForwarded(record.requestId, verdict.reason);
		const answered = await grantBroker.waitForDecision(record.requestId);
		if (
			answered?.issuer === "operator" &&
			(answered.state === "authorized" || answered.state === "executing" || answered.state === "completed")
		) {
			hookDrift?.accept(verdict.drift);
		}
		return;
	}
	grantBroker.decide(record.requestId, {
		decision: verdict.kind === "grant" ? "approve" : "deny",
		issuer: "main",
		reason: verdict.reason,
	});
}

/**
 * The main agent's answer to one worker ask (Phase D). Denial always
 * settles. Approval is admitted by grant-authority.ts: granted as the main
 * agent's own call at yolo, forwarded to an attended operator below yolo,
 * refused and denied otherwise.
 */
export async function decideGrantAsMain(
	{
		foreignAskOwner,
		grantAttended,
		grantBroker,
		grantView,
		heldAskRefusal,
		safety,
	}: Pick<
		GrantDecisionScope,
		"foreignAskOwner" | "grantAttended" | "grantBroker" | "grantView" | "heldAskRefusal" | "safety"
	>,
	input: Parameters<NonNullable<DispatchContract["grants"]>["decideAsMain"]>[0],
): Promise<MainGrantOutcome> {
	const outcome = await decideGrantRecordAsMain(
		{ foreignAskOwner, grantAttended, grantBroker, grantView, heldAskRefusal, safety },
		input,
	);
	return grantBroker.get(input.requestId)?.tool === WRITE_ROOTS_GRANT_TOOL ? writeRootOutcomeMessage(outcome) : outcome;
}

async function decideGrantRecordAsMain(
	{
		foreignAskOwner,
		grantAttended,
		grantBroker,
		grantView,
		heldAskRefusal,
		safety,
	}: Pick<
		GrantDecisionScope,
		"foreignAskOwner" | "grantAttended" | "grantBroker" | "grantView" | "heldAskRefusal" | "safety"
	>,
	input: Parameters<NonNullable<DispatchContract["grants"]>["decideAsMain"]>[0],
): Promise<MainGrantOutcome> {
	const found = grantBroker.get(input.requestId);
	if (found === null) return { ok: false, message: `unknown permission request '${input.requestId}'` };
	// Answering is the ask's, not the run's: a fork answers the ask it adopted from its parked parent (bt-11).
	const holder =
		found.state === "pending" && found.ownerSessionId !== input.sessionId
			? foreignAskOwner(found.runId, input.requestId)
			: null;
	if (holder !== null) return { ok: false, message: heldAskRefusal(holder, found.runId) };
	const record = grantBroker.get(input.requestId) ?? found;
	const base = { sessionId: input.sessionId, runId: input.runId };
	const failed = (reason: string, view?: GrantRecord): MainGrantOutcome => ({
		ok: false,
		message: reason,
		...(view !== undefined ? { view: grantView(view) } : {}),
	});
	if (input.decision === "deny") {
		const result = grantBroker.decide(input.requestId, {
			...base,
			decision: "deny",
			issuer: "main",
			reason: "denied by the main agent",
		});
		if (!result.ok) return failed(result.reason, result.record);
		return {
			ok: true,
			view: grantView(result.record),
			decision: "denied",
			decidedBy: result.record.issuer ?? "main",
			message: result.duplicate
				? `request ${input.requestId} was already denied`
				: `denied request ${input.requestId}; the worker continues without the ${result.record.tool} call`,
		};
	}
	if (record.reviewer === "safety-judge" && record.state === "pending") {
		return failed(
			`request ${input.requestId} is with the main session's safety judge (fleet.permissions.mode=judge); it settles on the judge's verdict, so do not approve it yourself`,
			record,
		);
	}
	if (record.state !== "pending") {
		const result = grantBroker.decide(input.requestId, { ...base, decision: "approve", issuer: "main" });
		if (!result.ok) return failed(result.reason, result.record);
		return {
			ok: true,
			view: grantView(result.record),
			decision: "approved",
			decidedBy: result.record.issuer ?? "main",
			message: `request ${input.requestId} is already ${result.record.state}; one approval runs the call at most once`,
		};
	}
	if (record.ownerSessionId !== input.sessionId) {
		return failed(`permission request '${input.requestId}' belongs to another session`);
	}
	if (input.runId !== record.runId && input.runId !== record.rootRunId) {
		return failed(`permission request '${input.requestId}' belongs to run ${record.runId}, not '${input.runId}'`);
	}
	const verdict =
		record.tool === WRITE_ROOTS_GRANT_TOOL
			? evaluateWriteRootGrant({
					autonomy: input.autonomy,
					...(input.operatorAutonomy !== undefined ? { operatorAutonomy: input.operatorAutonomy } : {}),
					attended: grantAttended(),
				})
			: evaluateMainGrant({
					record,
					autonomy: input.autonomy,
					...(input.operatorAutonomy !== undefined ? { operatorAutonomy: input.operatorAutonomy } : {}),
					attended: grantAttended(),
					safety,
					...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
				});
	if (verdict.kind === "grant") {
		const result = grantBroker.decide(input.requestId, {
			...base,
			decision: "approve",
			issuer: "main",
			reason: "granted by the main agent at yolo",
		});
		if (!result.ok) return failed(result.reason, result.record);
		return {
			ok: true,
			view: grantView(result.record),
			decision: "approved",
			decidedBy: "main",
			message: `approved request ${input.requestId}: the worker runs this ${record.tool} call once; the approval does not cover any later call`,
		};
	}
	if (verdict.kind === "deny") {
		const result = grantBroker.decide(input.requestId, {
			...base,
			decision: "deny",
			issuer: "main",
			reason: `the main agent's approval was refused: ${verdict.reason}`,
		});
		return failed(
			`approval refused: ${verdict.reason}. Request ${input.requestId} is ${result.ok ? "denied" : (result.record?.state ?? "settled")} and the worker continues without the call`,
			result.ok ? result.record : result.record,
		);
	}
	// Main below yolo, attended: the operator decides; the main agent's
	// approval is recorded as provenance on the card and the receipt.
	grantBroker.markForwarded(input.requestId);
	const settled = await grantBroker.waitForDecision(input.requestId, input.signal);
	if (settled === null) {
		return failed(
			`request ${input.requestId} is with the operator (${verdict.reason}); it stays pending until they answer or it expires`,
		);
	}
	if (settled.state === "denied") {
		return {
			ok: true,
			view: grantView(settled),
			decision: "denied",
			decidedBy: settled.issuer ?? "operator",
			message: `the operator denied request ${input.requestId}; the worker continues without the ${settled.tool} call`,
		};
	}
	if (settled.state === "authorized" || settled.state === "executing" || settled.state === "completed") {
		return {
			ok: true,
			view: grantView(settled),
			decision: "approved",
			decidedBy: settled.issuer ?? "operator",
			message: `the operator approved request ${input.requestId} (${verdict.reason}); the worker runs this ${settled.tool} call once`,
		};
	}
	return failed(`request ${input.requestId} ${settled.state} before the operator answered`, settled);
}
