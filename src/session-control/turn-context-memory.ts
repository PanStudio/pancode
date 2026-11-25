// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../core/hash.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import type { HostInsertRecord, SessionEntry } from "../domains/session/entries.js";
import { findLastEntry } from "../domains/session/tree/active-path.js";
import type { AgentMessage } from "../engine/types.js";
import type { TurnContext } from "./turn-context.js";
import type { TurnContextScope } from "./turn-context-scope.js";

/**
 * The memory section the active path's last prompt compile recorded, or null when none was recorded since the last
 * compaction, which unfreezes memory, or memory was off for it (bt-10).
 */
export function recordedMemorySection(entries: ReadonlyArray<SessionEntry>): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.kind === "compactionSummary") return null;
		if (entry?.kind !== "custom" || entry.customType !== "promptRecompiled") continue;
		const section = (entry.data as { memorySection?: unknown } | null)?.memorySection;
		return typeof section === "string" ? section : null;
	}
	return null;
}

/**
 * Memory for one turn context: the commit scope and its notices, the restoration install, and the per-turn memory
 * prepare and commit the controller exposes.
 */
export function createTurnContextMemory(shared: TurnContextScope) {
	const {
		activeEntries,
		deps,
		memoryOrigin,
		refreshLiveBudget,
		sessionWorkingContextPaths,
		state,
		syncCodexConfiguration,
	} = shared;

	let memoryTurnSequence = 0;

	const bindMemoryScope = () => {
		const sessionId = deps.session?.current()?.id;
		if (!sessionId) return null;
		const scope = { sessionId, branchAnchorTurnId: shared.branchAnchorTurnId };
		deps.memoryCommitBridge?.bindCommitScope(scope);
		return scope;
	};
	const notifyMemoryCommit: TurnContext["notifyMemoryCommit"] = (commitId, kind, outcome) => {
		const scope = bindMemoryScope();
		if (scope) {
			const entries = activeEntries();
			const summary = entries.find(
				(entry) =>
					entry.kind === "compactionSummary" &&
					(entry.turnId === commitId || (kind === "continuity" && entry.continuity?.commit?.entry.turnId === commitId)),
			);
			deps.memoryCommitBridge?.notifyContextCommitted({
				...scope,
				commitId,
				kind,
				outcome,
				...(summary?.kind === "compactionSummary" && summary.memoryReceipt ? { memoryReceipt: summary.memoryReceipt } : {}),
			});
		}
	};
	/**
	 * The restoration protocol (SPEC §1.3). The install is a durable host insert,
	 * so an install that survives a failed attempt is found again, never doubled,
	 * and one the model already read is never offered a second time.
	 */
	const installMemoryRestoration: TurnContext["installMemoryRestoration"] = (runtime, pendingText, beforeTurnId) => {
		const bridge = deps.memoryCommitBridge;
		if (!bridge || !bindMemoryScope()) return false;
		// An install an earlier process wrote has no offer here, so it stays as delivered text and is only journaled.
		for (const prior of deps.hostInserts?.inherited("memory-restoration") ?? []) {
			if (prior.restoration)
				bridge.noteInheritedRestoration?.(prior.restoration.commitId, prior.restoration.citedEntryIds);
		}
		const inserts = deps.hostInserts;
		// Navigation or a stopped turn voided the offer behind an install no request carried: acknowledgement
		// would refuse it, so it is undone on both sides under its original owner.
		const authority = bridge.captureMemoryAuthority();
		for (const prior of inserts?.onPath() ?? []) {
			const held = prior.restoration;
			if (
				prior.source === "memory-restoration" &&
				held &&
				inserts?.isUnsent(prior.id) &&
				(!authority ||
					held.sessionId !== authority.scope.sessionId ||
					held.branchAnchorTurnId !== authority.scope.branchAnchorTurnId ||
					held.generation !== authority.stamp.generation)
			)
				inserts.retract(prior, runtime);
		}
		const entries = activeEntries();
		const latest = findLastEntry(
			entries,
			(entry) => entry.kind === "continuityCommit" || entry.kind === "compactionSummary",
		);
		const currentState =
			latest?.kind === "continuityCommit"
				? { kind: "handoff" as const, text: latest.continuity.accepted.note }
				: latest?.kind === "compactionSummary"
					? { kind: "summary" as const, text: latest.summary }
					: null;
		const view = refreshLiveBudget(pendingText);
		const available = Math.max(
			0,
			(view.effectiveWindow ?? 0) - (view.outputReserveTokens ?? 0) - (view.inputTokens ?? 0) - 64,
		);
		const offer = bridge.prepareRestoration(currentState, available);
		if (!offer) return false;
		if (!offer.message) {
			bridge.acknowledgeRestoration(offer);
			return false;
		}
		if (!bridge.canAcknowledgeRestoration(offer)) return false;
		const content = `<system-reminder>\n${offer.message}\n</system-reminder>`;
		const restoration = {
			installId: sha256Hex(
				JSON.stringify([
					offer.scope.sessionId,
					offer.scope.branchAnchorTurnId,
					offer.commitId,
					content,
					offer.citedEntryIds,
				]),
			),
			sessionId: offer.scope.sessionId,
			branchAnchorTurnId: offer.scope.branchAnchorTurnId,
			commitId: offer.commitId,
			generation: offer.authority.generation,
			citedEntryIds: [...offer.citedEntryIds],
		};
		let install: HostInsertRecord | null = null;
		for (const prior of inserts?.onPath() ?? []) {
			const held = prior.restoration;
			if (
				prior.source !== "memory-restoration" ||
				!held ||
				held.sessionId !== restoration.sessionId ||
				held.branchAnchorTurnId !== restoration.branchAnchorTurnId ||
				held.commitId !== restoration.commitId ||
				held.generation !== restoration.generation
			)
				continue;
			if (held.installId === restoration.installId) install = prior;
			else if (inserts?.isUnsent(prior.id)) inserts.retract(prior, runtime);
			else {
				// The model already read restoration text for this commit; a second install would repeat it.
				bridge.releaseRestoration(offer);
				return false;
			}
		}
		let pushed: AgentMessage | null = null;
		// Present, its cost is already in the estimate; absent, it is pushed from the record. Fit is charged once.
		if (install) inserts?.ensureLive(runtime, install);
		else {
			pushed = { role: "user", content, timestamp: Date.now() };
			const cost = estimateAgentMessageTokens(pushed);
			if (!requestFits((view.inputTokens ?? Infinity) + cost, view.outputReserveTokens, view.effectiveWindow))
				return false;
			const options = { restoration, ...(beforeTurnId !== undefined ? { before: beforeTurnId } : {}) };
			if (inserts) install = inserts.insert(runtime, "memory-restoration", [pushed], options);
			else runtime.agent.state.messages.push(pushed);
		}
		if (!bridge.acknowledgeRestoration(offer)) {
			if (install) inserts?.retract(install, runtime);
			else runtime.agent.state.messages = runtime.agent.state.messages.filter((item) => item !== pushed);
			return false;
		}
		refreshLiveBudget(pendingText);
		return true;
	};
	const memoryTurnMethods: Required<Pick<TurnContext, "prepareMemoryTurn" | "commitMemoryTurn">> = {
		prepareMemoryTurn(runtime, input): void {
			const scope = bindMemoryScope();
			const observations = deps.memoryCommitBridge?.observations;
			if (scope && observations) {
				const entries = activeEntries();
				// Only committed receipts matter here; the source units are memory's to build when it needs them.
				const commits = entries.flatMap((entry) =>
					entry.kind === "compactionSummary" &&
					entry.memoryReceipt &&
					(entry.continuity?.commit?.summaryRef !== entry.turnId ||
						entries.some(
							(candidate) =>
								candidate.kind === "continuityCommit" && candidate.turnId === entry.continuity?.commit?.entry.turnId,
						))
						? [{ commitId: entry.turnId, receipt: entry.memoryReceipt }]
						: [],
				);
				if (commits.length > 0) observations.recoverConsumption(scope, commits);
			}
			shared.pendingUserImages = [...(input.images ?? [])];
			if (input.continuation && shared.memoryTurn !== null) return;
			// A prewarm has not chosen the first operator turn's memory. Freeze
			// only after preparation has loaded that turn's evidence. Sessionless
			// loops retain their submitted turns in engine history instead (#423).
			if (
				!input.continuation &&
				state.lastTurnId === null &&
				!runtime.agent.state.messages.some((message) => message.role === "user") &&
				!(deps.readSessionEntries?.() ?? []).some((entry) => entry.kind === "message" && entry.role === "user")
			) {
				shared.frozenMemorySection = null;
				shared.sessionPromptKey = null;
				if (!shared.postureGenerationPersisted) shared.postureGeneration = null;
			}
			const sessionId = deps.session?.current()?.id ?? null;
			memoryTurnSequence += 1;
			shared.memoryTurn = {
				id: String(memoryTurnSequence),
				sessionId,
				sessionAuthority: JSON.stringify([shared.memoryAuthorityEpoch, sessionId ?? `pending:${memoryTurnSequence}`]),
				origin: memoryOrigin(runtime),
				taskText: input.taskText,
				activePaths: Object.freeze([...sessionWorkingContextPaths]),
			};
		},
		commitMemoryTurn(runtime): void {
			syncCodexConfiguration(runtime);
			shared.pendingUserImages = [];
			// appendSubmittedUserTurn creates the first session synchronously.
			// Only that null -> bound transition with unchanged origin can alias
			// its prepared authority; navigation never uses this exception.
			if (shared.memoryTurn?.sessionId === null && shared.memoryTurn.origin === memoryOrigin(runtime)) {
				shared.memoryTurn.sessionId = deps.session?.current()?.id ?? null;
			}
		},
	};

	return { bindMemoryScope, installMemoryRestoration, memoryTurnMethods, notifyMemoryCommit };
}
