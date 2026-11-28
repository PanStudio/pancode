// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { neutralizeFraming } from "../../../core/reminder-framing.js";
import type { MemoryInterventionOffer, MemoryInterventionRegistration } from "../intervention-types.js";
import type { TaskMemoryEntry } from "../task-bank.js";
import { entryRevision, type InterventionScope } from "./scope.js";

/** Produced reminders awaiting submission; the oldest is released first. */
const PENDING_OFFER_LIMIT = 32;
/** Requests a produced reminder may miss before it is treated as dropped and released. */
const OFFER_MISSED_SUBMISSION_LIMIT = 3;
const SUBMITTED_CONTENT_LIMIT = 128;

export function createInterventionOffers(scope: InterventionScope) {
	const { deps } = scope;
	const captureContentGuard = (content?: string): (() => boolean) => {
		const capturedGeneration = scope.generation;
		const owner = scope.commitState;
		const capturedScope = scope.commitScope;
		const stamp = owner?.capture();
		const offer = content === undefined ? undefined : offerForContent(content);
		return () =>
			!scope.disposed &&
			// A reminder buffered before memory went off is not sent after it.
			scope.settings().enabled &&
			scope.generation === capturedGeneration &&
			scope.commitState === owner &&
			(!owner || (!!stamp && !!capturedScope && owner.isCurrent(stamp, capturedScope))) &&
			(offer === undefined || offerCurrent(offer));
	};
	let offerSequence = 0;
	const members: Pick<
		MemoryInterventionRegistration,
		"isContentCurrent" | "hasPendingOffers" | "acknowledgeSubmission"
	> = {
		isContentCurrent: captureContentGuard,
		hasPendingOffers: () => !scope.disposed && scope.pendingOffers.size > 0,
		acknowledgeSubmission(texts) {
			if (scope.disposed || scope.pendingOffers.size === 0) return [];
			const acknowledged: MemoryInterventionOffer[] = [];
			for (const [id, pending] of [...scope.pendingOffers]) {
				if (!texts.some((text) => text.includes(pending.offer.content))) {
					pending.missedSubmissions += 1;
					if (pending.missedSubmissions >= OFFER_MISSED_SUBMISSION_LIMIT) releaseOffer(id);
					continue;
				}
				scope.pendingOffers.delete(id);
				if (pending.generation !== scope.generation) continue;
				rememberSubmittedContent(pending.offer.content);
				try {
					pending.onSubmitted(pending.offer);
				} catch {
					// Delivery bookkeeping never fails the request that carried the reminder.
				}
				acknowledged.push(pending.offer);
			}
			return acknowledged;
		},
	};

	return {
		...members,
		captureContentGuard,
		produceOffer,
		releaseOffer,
		offerCurrent,
		citedStillHolds,
		openFailureEpisodes,
	};

	/**
	 * Register a produced reminder. Returns null when the same text was already
	 * submitted in this scope: the agent has it in context, and a second copy
	 * would also make the submission receipt ambiguous.
	 */
	function produceOffer(
		spec: Omit<MemoryInterventionOffer, "id" | "workspaceRoot"> & { workspaceRoot?: string },
		onSubmitted: (offer: MemoryInterventionOffer) => void,
	): MemoryInterventionOffer | null {
		// The registry holds the text as the host frame delivers it, so the submission receipt still finds it.
		const content = neutralizeFraming(spec.content.trim());
		if (content.length === 0 || scope.submittedContents.has(content)) return null;
		for (const pending of scope.pendingOffers.values())
			if (pending.offer.content === content && pending.generation === scope.generation) return pending.offer;
		const offer: MemoryInterventionOffer = Object.freeze({
			...spec,
			id: `mo-${(++offerSequence).toString(36)}`,
			content,
			workspaceRoot: spec.workspaceRoot ?? scope.workspaceRoot(),
		});
		scope.pendingOffers.set(offer.id, { offer, generation: scope.generation, onSubmitted, missedSubmissions: 0 });
		while (scope.pendingOffers.size > PENDING_OFFER_LIMIT) {
			const [oldest] = scope.pendingOffers.keys();
			if (oldest === undefined) break;
			releaseOffer(oldest);
		}
		return offer;
	}

	function releaseOffer(id: string): void {
		const pending = scope.pendingOffers.get(id);
		scope.pendingOffers.delete(id);
		for (const lesson of pending?.offer.lessons ?? []) scope.offeredLessons.delete(lesson.id);
		// The first-change surfacing never reached the model; leaving the check
		// spent would hide those lessons for the rest of the session.
		if (pending?.offer.trigger.reasons.includes("durable_lesson")) scope.durableLessonsChecked = false;
	}

	function rememberSubmittedContent(content: string): void {
		scope.submittedContents.add(content);
		if (scope.submittedContents.size > SUBMITTED_CONTENT_LIMIT)
			scope.submittedContents.delete(scope.submittedContents.values().next().value ?? content);
	}

	function offerForContent(content: string): MemoryInterventionOffer | undefined {
		const text = neutralizeFraming(content.trim());
		for (const pending of scope.pendingOffers.values()) if (text.includes(pending.offer.content)) return pending.offer;
		return undefined;
	}

	/**
	 * Revalidate the facts a reminder was produced from, at enqueue and again at
	 * submission. A cited entry deleted or rewritten (other than a still-open
	 * failure counting its repeat), a durable lesson no longer approved as
	 * written, or a correction whose failure episodes all resolved makes it
	 * stale. Unrelated activity in between changes none of these.
	 */
	function offerCurrent(offer: MemoryInterventionOffer): boolean {
		const pending = scope.pendingOffers.get(offer.id);
		if (scope.disposed || (pending !== undefined && pending.generation !== scope.generation)) return false;
		if (offer.kind === "durable_lesson") {
			const live = new Map([...scope.keptLessons(), ...scope.fixNotes()].map((lesson) => [lesson.id, lesson.revision]));
			return offer.lessons.every((lesson) => live.get(lesson.id) === lesson.revision);
		}
		const snapshot = deps.bank.snapshot();
		// The post-compaction restoration cites the status line too; leaving it
		// out would make that reminder stale the moment it was produced.
		const entries = new Map(
			[...(snapshot.status === null ? [] : [snapshot.status]), ...snapshot.knowledge, ...snapshot.procedural].map(
				(entry) => [entry.id, entry],
			),
		);
		for (const cited of offer.cited) {
			const entry = entries.get(cited.id);
			if (entry === undefined || !citedStillHolds(offer, cited, entry)) return false;
		}
		if (offer.trigger.failures.length === 0) return true;
		const open = offer.trigger.failures.filter(
			(episode) => scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep,
		);
		// A correction about failures that all resolved is stale; one cited
		// failure resolving also makes the text claim something no longer true.
		if (offer.kind === "corrective") return open.length > 0;
		const citedEpisodes = offer.trigger.failures.filter((episode) =>
			offer.cited.some((cited) => cited.id === episode.entryId),
		);
		return citedEpisodes.every((episode) => open.includes(episode));
	}

	/**
	 * A cited entry still says what the reminder was written from. A repeat of
	 * a still-open failure rewrites its procedural entry only to count the
	 * attempt and keep the latest error, which leaves a correction about that
	 * episode true; without this, the agent repeating the failure would be the
	 * very thing that dropped the correction.
	 */
	function citedStillHolds(
		offer: MemoryInterventionOffer,
		cited: MemoryInterventionOffer["cited"][number],
		entry: TaskMemoryEntry,
	): boolean {
		if (entryRevision(entry) === cited.revision) return true;
		return offer.trigger.failures.some(
			(episode) =>
				episode.entryId === cited.id && scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep,
		);
	}

	/** Failure episodes still open, as the reminder about to be produced sees them. */
	function openFailureEpisodes(
		fingerprints?: ReadonlySet<string>,
	): Array<{ fingerprint: string; firstStep: number; entryId: string }> {
		return [...scope.failures]
			.filter(([fingerprint]) => fingerprints === undefined || fingerprints.has(fingerprint))
			.map(([fingerprint, failure]) => ({ fingerprint, firstStep: failure.firstStep, entryId: failure.entryId }));
	}
}
