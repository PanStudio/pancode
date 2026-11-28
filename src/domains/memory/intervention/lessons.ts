// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { tmpdir } from "node:os";
import type { MemoryDeliveryMode } from "../../../core/defaults.js";
import { ToolNames } from "../../../core/tool-names.js";
import type { MiddlewareEffect } from "../../middleware/types.js";
import {
	COMMAND_EVIDENCE_REF_PREFIX,
	type CommandSegment,
	commandSegment,
	receiptVouches,
	sameCommandIdentity,
} from "../command-evidence.js";
import { repositoryRelativePath } from "../lesson-evidence.js";
import { type KeptLesson, renderKeptLesson } from "../lesson-projection.js";
import { sharesInvocationTarget } from "../recipes.js";
import { lessonsForTask } from "../relevance.js";
import { type InterventionScope, NO_EFFECTS, noTokens } from "./scope.js";
import type { MemoryInterventionRegistration } from "./types.js";

/** Kept lessons the turn-end pass is shown so it does not rewrite them. */
const KEPT_LESSONS_FOR_PASS = 10;

export function createInterventionLessons(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<MemoryInterventionRegistration, "offerLessonsForTask"> = {
		offerLessonsForTask(task, carried) {
			scope.sectionCarries = carried;
			if (scope.disposed || !scope.settings().enabled) return "";
			try {
				const lessons = lessonsForTask(
					task,
					keptLessons().filter((lesson) => !carried(lesson.id)),
				);
				const [effect] = deliverDurableLessons("durable_lesson_task", lessons);
				return effect?.kind === "annotate_tool_result" ? effect.message : "";
			} catch {
				// The section and memory_recall still stand; a turn never fails on this.
				return "";
			}
		},
	};

	return {
		...members,
		keptLessons,
		fixNotes,
		keptLessonsForPass,
		surfaceDurableLessons,
		surfaceForVerificationGap,
		surfaceForSubject,
		surfaceRecipeForFailure,
		settleDurableLessons,
	};

	function keptLessons(): ReadonlyArray<KeptLesson> {
		if (!scope.settings().enabled) return [];
		try {
			return deps.getKeptLessons?.() ?? [];
		} catch {
			// An unreadable store surfaces nothing; the session continues without it.
			return [];
		}
	}

	function fixNotes(): ReadonlyArray<KeptLesson> {
		if (!scope.settings().enabled) return [];
		try {
			return (deps.getFixNotes?.() ?? []).filter((note) => note.failed !== undefined);
		} catch {
			return [];
		}
	}

	function carriedBySection(id: string): boolean {
		try {
			return scope.sectionCarries(id);
		} catch {
			return false;
		}
	}

	function deliveryMode(): MemoryDeliveryMode {
		try {
			return deps.getDelivery?.() ?? "decision";
		} catch {
			return "decision";
		}
	}

	function keptLessonsForPass(): ReadonlyArray<{ id: string; text: string }> {
		return keptLessons()
			.slice(0, KEPT_LESSONS_FOR_PASS)
			.map((lesson) => ({ id: lesson.id, text: lesson.text }));
	}

	/**
	 * Show an earlier session's approved lessons next to the action they are about.
	 *
	 * The prompt's memory section already lists approved lessons, and a live
	 * Dynamo session still rediscovered the validator its approved lesson named,
	 * step for step: the decision about how to validate is made right after an
	 * edit, far from the system prompt. So the first workspace change of a
	 * session surfaces, once, the approved repository lessons whose recommended
	 * command this session has not yet run successfully, those about the
	 * changed file first. No model call, no cadence.
	 */
	function surfaceDurableLessons(args: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<MiddlewareEffect> {
		// The first-change broadcast is an opt-in (`delivery: broadcast`): it repeats the section, and none of the
		// lane broadcasts settled (DESIGN 5).
		if (scope.durableLessonsChecked || !scope.settings().enabled || deliveryMode() !== "broadcast") return NO_EFFECTS;
		scope.durableLessonsChecked = true;
		const changed = new Set(touchedPaths(ToolNames.Write, args));
		const pending = commandLessons().filter((lesson) => !lesson.commands.recommended.some(commandSucceeded));
		return deliverDurableLessons("durable_lesson", [
			...pending.filter((lesson) => lesson.paths.some((path) => changed.has(path))),
			...pending.filter((lesson) => !lesson.paths.some((path) => changed.has(path))),
		]);
	}

	/**
	 * PanCode's own verification route reported no declared or derivable check: the
	 * session is asking how this repository validates. Approved lessons whose
	 * recommended command it has not yet run successfully are that answer.
	 */
	function surfaceForVerificationGap(): ReadonlyArray<MiddlewareEffect> {
		return deliverDurableLessons(
			"durable_lesson_verify",
			commandLessons().filter((lesson) => !lesson.commands.recommended.some(commandSucceeded)),
		);
	}

	/**
	 * The session read, changed or ran a repository file an approved lesson is about: a source lesson an operator
	 * approved that quotes or names it, or a command lesson whose recommended command names it (DESIGN 4.4 channel
	 * table). A quote no operator reviewed never rides this channel.
	 */
	function surfaceForSubject(
		toolName: string,
		args: Readonly<Record<string, unknown>> | undefined,
	): ReadonlyArray<MiddlewareEffect> {
		const touched = new Set(touchedPaths(toolName, args));
		if (touched.size === 0) return NO_EFFECTS;
		const root = scope.workspaceRoot();
		// A command names a path as an argument or as an option's value (`--config=scripts/cfg.json`).
		const names = (lesson: KeptLesson): boolean =>
			(commandEvidence(lesson) &&
				lesson.commands.recommended.some((command) =>
					command.split(/[\s=]+/u).some((word) => touched.has(repositoryRelativePath(word, [root]) ?? "")),
				)) ||
			(lesson.approval === "operator" &&
				lesson.sourcePaths.length > 0 &&
				[...lesson.paths, ...lesson.sourcePaths].some((path) => touched.has(path)));
		return deliverDurableLessons(
			"durable_lesson_subject",
			// A lesson whose recommended command already succeeded here has nothing left to say.
			keptLessons().filter((lesson) => names(lesson) && !lesson.commands.recommended.some(commandSucceeded)),
		);
	}

	function touchedPaths(toolName: string, args: Readonly<Record<string, unknown>> | undefined): string[] {
		const root = scope.workspaceRoot();
		const named =
			typeof args?.path === "string"
				? [args.path]
				: typeof args?.file_path === "string"
					? [args.file_path]
					: toolName === ToolNames.Bash && typeof args?.command === "string"
						? args.command.split(/\s+/u)
						: [];
		return named.flatMap((token) => repositoryRelativePath(token, [root]) ?? []);
	}

	/** Approved repository lessons that recommend at least one command. */
	function commandLessons(): KeptLesson[] {
		return keptLessons().filter((lesson) => lesson.commands.recommended.length > 0);
	}

	/**
	 * A failed command that runs the same repository file through the same
	 * program as a command an approved lesson recommends, or that is exactly a
	 * failed example the lesson quotes: the session is on the trap that lesson's
	 * recipe fixes. It rides back on the failed result. A fix claim reaches the
	 * failed call only when its failed pattern is that call's evidence identity.
	 */
	function surfaceRecipeForFailure(command: string): ReadonlyArray<MiddlewareEffect> {
		const root = scope.workspaceRoot();
		const failedCall = commandSegment(command, root);
		return deliverDurableLessons(
			"durable_lesson_variant",
			// Fix notes ride this one channel, labelled unverified, and only on their own failed pattern (DESIGN 4.4).
			[...keptLessons(), ...fixNotes()].filter((lesson) =>
				lesson.failed !== undefined
					? failedCall !== null && receiptVouches(lesson.failed, failedCall, [tmpdir()])
					: lesson.commands.recommended.some(
							(quoted) => !sameCommandIdentity(quoted, command, root) && sharesInvocationTarget(command, quoted, root),
						) ||
						(lesson.commands.recommended.length > 0 &&
							lesson.commands.examples.some((quoted) => sameCommandIdentity(quoted, command, root))),
			),
		);
	}

	/**
	 * Whole lessons, each at most once per session, while they fit the memory
	 * reminder budget the operator configured; nothing is cut mid-lesson.
	 * Relevance was decided by the caller over every eligible lesson, so the
	 * budget only bounds what is shown. Delivery is recorded when the host
	 * submits the annotation, not here.
	 */
	function deliverDurableLessons(
		trigger:
			| "durable_lesson"
			| "durable_lesson_variant"
			| "durable_lesson_verify"
			| "durable_lesson_subject"
			| "durable_lesson_task",
		candidates: ReadonlyArray<KeptLesson>,
	): ReadonlyArray<MiddlewareEffect> {
		// The broadcast opens only under `broadcast`, every other reminder from `decision` up (DESIGN 4.1).
		const mode = deliveryMode();
		if (mode === "off" || mode === "section" || (trigger === "durable_lesson" && mode !== "broadcast")) return NO_EFFECTS;
		const budget = scope.settings().maxTokens * 4;
		const chosen: KeptLesson[] = [];
		let lines: string[] = [];
		for (const lesson of candidates) {
			if (scope.deliveredLessons.has(lesson.id) || scope.offeredLessons.has(lesson.id)) continue;
			if (carriedBySection(lesson.id)) continue;
			if (!channelCarries(trigger, lesson)) continue;
			const next = [...lines, renderKeptLesson(lesson)];
			if (next.join("\n").length > budget) continue;
			lines = next;
			chosen.push(lesson);
		}
		if (chosen.length === 0) return NO_EFFECTS;
		const offer = scope.produceOffer(
			{
				kind: "durable_lesson",
				tier: "rules",
				content: lines.join("\n"),
				cited: chosen.map((lesson) => ({ id: lesson.id, revision: lesson.revision })),
				trigger: { reasons: [trigger], step: scope.toolStep, failures: [] },
				lessons: chosen.map(({ id, revision, appliesWhen, avoidWhen, approval, evidenceRefs }) => ({
					id,
					revision,
					appliesWhen,
					avoidWhen,
					approval,
					evidenceRefs,
				})),
			},
			() => {
				for (const lesson of chosen) {
					scope.offeredLessons.delete(lesson.id);
					scope.deliveredLessons.add(lesson.id);
					scope.durableWatch.set(lesson.id, lesson.commands.recommended);
				}
				reportDurableLessons(
					chosen.map((lesson) => lesson.id),
					[],
				);
			},
		);
		if (offer === null) return NO_EFFECTS;
		for (const lesson of chosen) scope.offeredLessons.add(lesson.id);
		scope.lastDecision = "injected";
		scope.emitTelemetry(
			[trigger],
			"rules",
			"injected",
			"intervened",
			chosen.length,
			noTokens,
			noTokens,
			process.hrtime.bigint(),
		);
		scope.lessonDelivered = true;
		return [{ kind: "annotate_tool_result", message: offer.content, severity: "info" }];
	}

	/**
	 * A submitted lesson holds in this session once a receipt segment with the
	 * evidence identity of its recommended command succeeds. Failures, other
	 * commands that merely mention it, and its quoted failed examples prove
	 * nothing about it.
	 */
	function settleDurableLessons(segment: CommandSegment): void {
		if (scope.durableWatch.size === 0) return;
		const root = scope.workspaceRoot();
		const held = [...scope.durableWatch]
			.filter(([, commands]) =>
				commands.some((quoted) => {
					const claim = commandSegment(quoted, root);
					return claim !== null && receiptVouches(claim, segment);
				}),
			)
			.map(([id]) => id);
		if (held.length === 0) return;
		for (const id of held) scope.durableWatch.delete(id);
		reportDurableLessons([], held);
	}

	/** This session ran a command with that evidence identity successfully. */
	function commandSucceeded(quoted: string): boolean {
		const claim = commandSegment(quoted, scope.workspaceRoot());
		if (claim === null) return false;
		for (const segment of scope.succeededSegments.values()) if (receiptVouches(claim, segment)) return true;
		return false;
	}

	function reportDurableLessons(delivered: ReadonlyArray<string>, held: ReadonlyArray<string>): void {
		try {
			deps.onDurableLessonOutcomes?.({ sessionId: scope.observedSessionId, delivered, held });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}
}

/** A lesson carries command evidence: a `command:` ref, which only a succeeded receipt writes. */
function commandEvidence(lesson: Pick<KeptLesson, "evidenceRefs">): boolean {
	return lesson.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX));
}

/**
 * The evidence each reminder channel requires (DESIGN 4.4 channel table). A failed call and a verification gap take
 * command evidence; the broadcast and the task reminder repeat the section's rule, command evidence or an operator's
 * approval; a touched file's own rule is applied by its caller, which knows the path.
 */
function channelCarries(
	trigger:
		| "durable_lesson"
		| "durable_lesson_variant"
		| "durable_lesson_verify"
		| "durable_lesson_subject"
		| "durable_lesson_task",
	lesson: KeptLesson,
): boolean {
	switch (trigger) {
		case "durable_lesson_variant":
		case "durable_lesson_verify":
			return commandEvidence(lesson);
		case "durable_lesson_subject":
			return commandEvidence(lesson) || (lesson.approval === "operator" && lesson.sourcePaths.length > 0);
		case "durable_lesson":
		case "durable_lesson_task":
			return commandEvidence(lesson) || lesson.approval === "operator";
	}
}
