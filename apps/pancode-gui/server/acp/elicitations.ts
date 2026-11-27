// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
	type ElicitationPrompt,
	ElicitationRequest,
	type ElicitationResult,
	ElicitationSubmission,
	ElicitationWithdrawal,
	elicitationContentErrors,
} from "../../contracts/elicitation.js";
import { AppProblem } from "../services/problem.js";

/** The most MCP elicitations one session keeps waiting; tools that ask at once are shown one after another. */
const MAX_WAITING = 8;

type Waiting = { elicitationId: string; prompt: ElicitationPrompt; resolve: (result: ElicitationResult) => void };

/**
 * MCP servers' forms and links parked for the person at this GUI, oldest
 * first. Nothing here answers for them: only a submission, a cancel, the
 * runtime withdrawing the request, or the turn ending settles one.
 */
export class Elicitations {
	private waiting: Waiting[] = [];
	constructor(private readonly changed: (prompt: ElicitationPrompt | null) => void) {}
	current(): ElicitationPrompt | null {
		const head = this.waiting[0];
		return head ? structuredClone(head.prompt) : null;
	}
	request(sessionId: string, turnId: string | null, value: unknown): Promise<ElicitationResult> {
		if (!Value.Check(ElicitationRequest, value) || value.sessionId !== sessionId || !turnId)
			throw new AppProblem("upstream_acp", "Elicitation does not match this session's active turn or its contract.");
		if (this.waiting.length >= MAX_WAITING)
			throw new AppProblem("upstream_acp", "Too many MCP elicitations are already waiting in this session.");
		const { sessionId: _session, elicitationId, ...asked } = value;
		const prompt = {
			...structuredClone(asked),
			id: randomUUID(),
			turnId,
			requestedAt: new Date().toISOString(),
		} as ElicitationPrompt;
		return new Promise((resolve) => {
			this.waiting.push({ elicitationId, prompt, resolve });
			if (this.waiting.length === 1) this.changed(this.current());
		});
	}
	answer(id: string, submission: ElicitationSubmission) {
		const head = this.waiting[0];
		if (!head || head.prompt.id !== id) throw new AppProblem("conflict", "This MCP request is no longer waiting.");
		if (!Value.Check(ElicitationSubmission, submission))
			throw new AppProblem("validation", "The answer does not match the elicitation submission contract.");
		if (submission.action !== "accept") return this.settle(head, { action: submission.action });
		if (head.prompt.mode === "url") {
			if (submission.content !== undefined)
				throw new AppProblem("validation", "A link request is accepted without form content.");
			return this.settle(head, { action: "accept" });
		}
		const content = submission.content ?? {};
		const errors = elicitationContentErrors(head.prompt.fields, content);
		if (errors.length > 0) throw new AppProblem("validation", errors.join("; "));
		this.settle(head, { action: "accept", content });
	}
	cancel() {
		const waiting = this.waiting;
		this.waiting = [];
		if (waiting.length > 0) this.changed(null);
		for (const entry of waiting) entry.resolve({ action: "cancel" });
	}
	withdraw(sessionId: string, value: unknown): void {
		if (!Value.Check(ElicitationWithdrawal, value) || value.sessionId !== sessionId) return;
		const entry = this.waiting.find((waiting) => waiting.elicitationId === value.elicitationId);
		if (entry) this.settle(entry, { action: "cancel" });
	}
	private settle(entry: Waiting, result: ElicitationResult) {
		const at = this.waiting.indexOf(entry);
		if (at < 0) return;
		this.waiting.splice(at, 1);
		if (at === 0) this.changed(this.current());
		entry.resolve(result);
	}
}
