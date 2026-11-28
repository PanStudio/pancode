// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { type CommandSegment, commandSegment, receiptVouches } from "../command-evidence.js";
import type { MemoryDeliveryOutcome, MemoryInterventionOffer } from "../intervention-types.js";
import { lessonEvidence, readInsideRoot, repositoryRelativePath } from "../lesson-evidence.js";
import type { TaskMemoryEntry } from "../task-bank.js";
import { collapseWhitespace, type InterventionScope } from "./scope.js";

/** Recurrences after submission of a failure the reminder was about before it counts as contradicted. */
const MEMORY_DELIVERY_CONTRADICTED_RECURRENCES = 2;
const MEMORY_DELIVERY_WATCH_LIMIT = 16;

export function createInterventionDeliveries(scope: InterventionScope) {
	const { deps } = scope;
	const groundingOf = (entry: TaskMemoryEntry) =>
		lessonEvidence(entry, {
			succeededCommands: scope.succeededCommands,
			observedReads: scope.observedReads,
			workspaceRoot: scope.workspaceRoot(),
		});

	return { startDeliveryWatch, reviewKnowledge, settleDeliveries, noteCommandEvidence, noteReadEvidence };

	/**
	 * Start delivery accounting for a reminder the host submitted: the cited
	 * entries' injection counts, and for the model tier the durable proposal and
	 * an outcome watch.
	 *
	 * Only the model tier proposes. A rules-tier reminder cites an entry this
	 * middleware wrote itself out of one repeated tool failure, and proposing
	 * every one of those as a durable lesson would fill the operator's review
	 * queue with rows nobody asked for (#229).
	 */
	function startDeliveryWatch(offer: MemoryInterventionOffer): void {
		const snapshot = deps.bank.snapshot();
		const entries = [...snapshot.knowledge, ...snapshot.procedural].filter((entry) =>
			offer.cited.some((cited) => cited.id === entry.id && scope.citedStillHolds(offer, cited, entry)),
		);
		if (entries.length > 0) deps.bank.recordInjection(entries.map((entry) => entry.id));
		if (offer.tier !== "llm" || entries.length === 0 || deps.onInjectedEntries === undefined) return;
		try {
			deps.onInjectedEntries(entries);
		} catch {
			// A failing store is the owner's problem to report, never a reason to
			// fail the request that carried the reminder.
			return;
		}
		scope.deliveries.push({
			entries: entries.map((entry) => ({ id: entry.id, content: entry.content, entry })),
			step: scope.toolStep,
			fingerprints: new Set(
				offer.trigger.failures
					.filter((episode) => scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep)
					.map((episode) => episode.fingerprint),
			),
			recurrences: 0,
			supported: new Set(),
			heldReported: new Set(),
		});
		if (scope.deliveries.length > MEMORY_DELIVERY_WATCH_LIMIT) scope.deliveries.shift();
	}

	function reviewKnowledge(before: ReadonlyArray<TaskMemoryEntry>): void {
		if (deps.onKnowledgeReview === undefined) return;
		const after = new Map(deps.bank.snapshot().knowledge.map((entry) => [entry.id, entry]));
		// Only entries the model filed as lessons. Plain knowledge is a fact about
		// the task in hand and goes stale with it.
		const lessons = before.filter((entry) => entry.durable === true);
		if (lessons.length === 0) return;
		const unchanged = lessons.filter((entry) => after.get(entry.id)?.content === entry.content);
		// Grounding reads the live entry: the evidence command is part of what the
		// model kept, and it has to equal a command the host ran.
		const commandVerified = new Set<string>();
		const kept = unchanged.filter((entry) => {
			const live = after.get(entry.id);
			const kind = live === undefined ? null : groundingOf(live);
			if (kind === "command") commandVerified.add(entry.id);
			return kind !== null;
		});
		const ungrounded = unchanged.filter((entry) => !kept.includes(entry));
		const withdrawn = lessons.filter((entry) => after.get(entry.id)?.content !== entry.content);
		try {
			deps.onKnowledgeReview({ kept, withdrawn, ungrounded, commandVerified });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/**
	 * Report deliveries whose outcome is decided. A reminder is contradicted when
	 * a failure it was written about keeps recurring after it was submitted. An
	 * entry holds only when a later receipt satisfies that entry's own evidence:
	 * its exact command succeeded, or a read showed its quoted source. Quiet
	 * steps and unrelated successes decide nothing. A held entry stays watched,
	 * so the same failure returning later still contradicts it; an undecided
	 * delivery is dropped at scope end rather than guessed at.
	 */
	function settleDeliveries(final: boolean): void {
		const outcomes: MemoryDeliveryOutcome[] = [];
		const bank = new Map(deps.bank.snapshot().knowledge.map((entry) => [entry.id, entry]));
		for (let index = scope.deliveries.length - 1; index >= 0; index -= 1) {
			const watch = scope.deliveries[index];
			if (watch === undefined) continue;
			if (watch.recurrences >= MEMORY_DELIVERY_CONTRADICTED_RECURRENCES) {
				scope.deliveries.splice(index, 1);
				outcomes.push({ entries: watch.entries.map(({ id, content }) => ({ id, content })), kind: "contradicted" });
				continue;
			}
			const held = watch.entries.filter(
				(delivered) =>
					watch.recurrences === 0 &&
					watch.supported.has(delivered.id) &&
					!watch.heldReported.has(delivered.id) &&
					bank.get(delivered.id)?.content === delivered.content,
			);
			for (const delivered of held) watch.heldReported.add(delivered.id);
			if (held.length > 0) outcomes.push({ entries: held.map(({ id, content }) => ({ id, content })), kind: "held" });
		}
		if (final) scope.deliveries.length = 0;
		if (outcomes.length === 0 && !final) return;
		try {
			deps.onDeliveryOutcomes?.(outcomes, final);
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/** A successful receipt segment satisfies a delivered lesson whose evidence command has that identity. */
	function noteCommandEvidence(segment: CommandSegment): void {
		const root = scope.workspaceRoot();
		for (const watch of scope.deliveries)
			for (const delivered of watch.entries) {
				if (delivered.entry.durable !== true || delivered.entry.evidenceCommand === undefined) continue;
				const claim = commandSegment(delivered.entry.evidenceCommand, root);
				if (claim !== null && receiptVouches(claim, segment)) watch.supported.add(delivered.id);
			}
	}

	/** A successful read that showed a delivered lesson's quoted source, which the checkout still holds. */
	function noteReadEvidence(path: string, excerpt: string, root: string): void {
		const shown = collapseWhitespace(excerpt);
		for (const watch of scope.deliveries)
			for (const delivered of watch.entries) {
				const source = delivered.entry.evidenceSource;
				if (delivered.entry.durable !== true || source === undefined) continue;
				const quote = collapseWhitespace(source.quote);
				if (quote.length === 0 || repositoryRelativePath(source.path, [root]) !== path || !shown.includes(quote)) continue;
				const current = readInsideRoot(root, path);
				if (current !== null && collapseWhitespace(current).includes(quote)) watch.supported.add(delivered.id);
			}
	}
}
