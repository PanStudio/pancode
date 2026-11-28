// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SETTINGS, type MemoryLessonsMode } from "../../../core/defaults.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../../core/tool-surface.js";
import { isRecord } from "../../../core/type-guards.js";
import { headForRedaction } from "../../../lib/secrets/redact.js";
import { isRefusalToolResultError } from "../../../tools/result-disposition.js";
import type { MiddlewareHookInput } from "../../middleware/types.js";
import { callChangesTree, checkPassedForCall } from "../../safety/run-effects.js";
import {
	atWorkspaceRoot,
	type CommandSegment,
	commandSegment,
	commandSegments,
	verifyReceiptCommand,
	verifyRunPassed,
} from "../command-evidence.js";
import { WORKSPACE_CHANGING_CLASSES } from "../intervention-tool-step.js";
import type { MemoryInterventionRegistration } from "../intervention-types.js";
import { commandSubject, readInsideRoot, repositoryRelativePath } from "../lesson-evidence.js";
import { exercisesWork, fixPairOf, type MemoryNoteEvidence } from "../notes.js";
import { redactForMemoryRoute } from "../secret-text.js";
import { collapseWhitespace, type InterventionScope, setBounded } from "./scope.js";

/**
 * Tool calls since the last lesson pass that make a finished turn worth one.
 * Every other trigger fires mid-turn, so the model never saw how the turn
 * ended: in a live session its last step ran before the passing test and it
 * never learned which of its notes had been right.
 */
const MEMORY_INTERVENTION_TURN_END_MIN_TOOLS = 2;
const VERIFIED_COMMAND_LIMIT = 256;
/** Line ranges kept per read path, and paths kept, for binding a `memory_note` quote to what a read showed. */
const SHOWN_READS_PER_PATH = 8;
const SHOWN_READ_PATHS = 256;

export function createInterventionEvidence(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<MemoryInterventionRegistration, "noteEvidence" | "sideArmCount"> = {
		noteEvidence(args) {
			if (args.command !== undefined && args.path !== undefined)
				return { refused: "give command or path, not both: one note binds one piece of evidence" };
			const root = scope.workspaceRoot();
			if (args.command !== undefined) {
				const claim = commandSegment(args.command, root);
				const ran = claim === null ? undefined : scope.succeededSegments.get(claim.key);
				if (ran === undefined) {
					const check = claim === null ? undefined : scope.unpassedVerifyChecks.get(claim.key);
					return {
						refused:
							check === undefined
								? `\`${args.command}\` has not succeeded from the workspace root in this session; run it first, or leave command out`
								: `\`${args.command}\` ran through verify${check ? ` check \`${check}\`` : ""} in this session and did not pass, so it is no evidence; fix it and run it again, or leave command out`,
					};
				}
				if (!exercisesWork(ran))
					return {
						refused: `\`${args.command}\` is a help, version or always-succeeding command, so it is no evidence; leave command out`,
					};
				return { kind: "command", segment: ran };
			}
			if (args.path !== undefined) return shownQuote(args.note, args.path, root);
			return null;
		},
		sideArmCount: () => scope.armsInScope,
	};

	return {
		...members,
		sideLessonArmed,
		idleLessonWorth,
		observeDeclaration,
		noteCheckOrChange,
		noteFailedForFix,
		recordShownRead,
		rememberSucceededCommand,
		noteVerifyRun,
	};

	/**
	 * The side-model lesson pass is an opt-in (`lessons: side`) armed by evidence, not activity (DESIGN 4.4): a fix
	 * pair, or a `finish` declaration of `done` in an operator turn with a passed check (MD14), since the last pass, and
	 * at most one pass per operator turn, whether it runs at the turn's end or idle.
	 */
	function sideLessonArmed(): boolean {
		return (
			lessonsMode() === "side" &&
			scope.armsSinceLessonPass > 0 &&
			scope.lessonPassTurn !== scope.turnSequence &&
			scope.toolsSinceLessonPass >= MEMORY_INTERVENTION_TURN_END_MIN_TOOLS
		);
	}

	function idleLessonWorth(): boolean {
		return sideLessonArmed();
	}

	function lessonsMode(): MemoryLessonsMode {
		return scope.settings().surfaces.lessons ?? DEFAULT_SETTINGS.context.memory.surfaces.lessons;
	}

	/**
	 * A turn's typed `finish` declaration, never its reply text (MD14). The bank's status becomes the declared state and
	 * its `remaining` items, the progress a compaction hands back. Under `lessons: side` a declared `done` in an operator
	 * turn whose check passed is an evidence arm; a `done` without one arms nothing.
	 */
	function observeDeclaration(input: MiddlewareHookInput): void {
		const state = input.metadata?.completionState;
		if (state !== "done" && state !== "partly_done" && state !== "not_done") return;
		const remaining = input.metadata?.completionRemaining;
		const items = typeof remaining === "string" ? remaining.split("\n").filter((item) => item.length > 0) : [];
		// The model's own words reach the bank, its file and a restored context only through the memory route's redaction.
		const open = items.length > 0 ? redactForMemoryRoute(headForRedaction(items.join("; "), 4_096)) : "";
		deps.bank.updateStatus(`declared ${state}${open.length > 0 ? `; remaining: ${open}` : ""}`);
		if (state !== "done" || scope.checkStepThisTurn <= scope.lastTreeChangeStep || lessonsMode() !== "side") return;
		scope.checkStepThisTurn = 0;
		scope.armsSinceLessonPass += 1;
		scope.armsInScope += 1;
	}

	/**
	 * A call that settled ok and passed a check that speaks for it (the safety domain's reader) is this turn's latest
	 * check; any other call that ran and changed the tree, a shell mutation included, is the latest change. A refused or
	 * blocked call ran nothing and changes nothing. A chain's steps count each as its own call, in order: every leaf call
	 * takes the next number of one sequence, so an edit then a check in one chain leaves the check standing.
	 */
	function noteCheckOrChange(
		toolName: string,
		rawArgs: Record<string, unknown> | undefined,
		details: MiddlewareHookInput["toolResultDetails"],
		settled: { ok: boolean; ran: boolean; actionClass: string | undefined },
	): void {
		const children = gatewayChainReceipts(toolName, { details });
		if (children.length > 0) {
			for (const child of children) {
				const childDetails = isRecord(child.result.details) ? child.result.details : {};
				const admitted = child.admission.decision === "allowed" && child.admission.outcome !== "blocked";
				const ok = admitted && child.admission.outcome === "ok" && childDetails.kind === "ok";
				const ran = ok || (admitted && !isRefusalToolResultError({ kind: "error", details: childDetails }));
				noteCheckOrChange(child.capability, child.args, childDetails, {
					ok,
					ran,
					actionClass: child.admission.actionClass,
				});
			}
			return;
		}
		const call = effectiveToolCall(toolName, rawArgs, details);
		const args = call.args === undefined ? undefined : { ...call.args };
		const root = scope.workspaceRoot();
		if (settled.ok && checkPassedForCall(call.toolName, args, details, root)) {
			scope.evidenceSequence += 1;
			scope.checkStepThisTurn = scope.evidenceSequence;
			return;
		}
		if (!settled.ran) return;
		if (
			(settled.ok && WORKSPACE_CHANGING_CLASSES.has(String(settled.actionClass))) ||
			callChangesTree(call.toolName, args, root)
		) {
			scope.evidenceSequence += 1;
			scope.lastTreeChangeStep = scope.evidenceSequence;
		}
	}

	/** A lone shell invocation failed from the workspace root: it waits for a success that fixes it. */
	function noteFailedForFix(command: string, cwd: unknown): void {
		if (lessonsMode() === "off") return;
		const root = scope.workspaceRoot();
		const at = typeof cwd === "string" ? cwd : undefined;
		// A failed chain does not say which segment failed, so only a lone invocation is a failed pattern.
		const segments = atWorkspaceRoot(root, at) ? commandSegments(command, root, at) : [];
		const [segment] = segments;
		if (segments.length !== 1 || segment === undefined || !exercisesWork(segment)) return;
		const subject = commandSubject(segment.argv, root);
		if (subject === null) return;
		scope.failedForFix.delete(subject.key);
		scope.failedForFix.set(subject.key, { segment, step: scope.toolStep });
		if (scope.failedForFix.size > VERIFIED_COMMAND_LIMIT)
			scope.failedForFix.delete(scope.failedForFix.keys().next().value ?? subject.key);
	}

	/**
	 * A succeeded segment closes its subject's waiting failure: by succeeding itself, or as the fix of a pair. A help,
	 * version or trivial call closes nothing. A workspace change since the failure voids it, as it voids a repeated
	 * failure's annotation: the edit, not the options, may be what fixed it.
	 */
	function pairFix(segment: CommandSegment): void {
		if (!exercisesWork(segment)) return;
		const subject = commandSubject(segment.argv, scope.workspaceRoot());
		const waiting = subject === null ? undefined : scope.failedForFix.get(subject.key);
		if (subject === null || waiting === undefined) return;
		if (waiting.step <= scope.lastWorkspaceChangeStep) {
			scope.failedForFix.delete(subject.key);
			return;
		}
		const failed = waiting.segment;
		if (failed.key !== segment.key && !fixPairOf(failed, segment)) return;
		scope.failedForFix.delete(subject.key);
		if (failed.key === segment.key || lessonsMode() === "off") return;
		scope.armsSinceLessonPass += 1;
		scope.armsInScope += 1;
		try {
			deps.onFixPair?.({ failed, fixed: segment });
		} catch {
			// Filing is the owner's; a failure there never reaches the turn.
		}
	}

	/** Keep the lines a read showed, from the read tool's own range and file identity; a partial line shows no line. */
	function recordShownRead(path: string, details: Readonly<Record<string, unknown>> | undefined): void {
		const range = details?.readRange as { startLine?: unknown; endLine?: unknown; partialLine?: unknown } | undefined;
		const file = details?.file as { bytes?: unknown; mtimeMs?: unknown } | undefined;
		const { startLine: start, endLine: end } = range ?? {};
		if (typeof start !== "number" || typeof end !== "number" || end < start || range?.partialLine === true) return;
		if (typeof file?.bytes !== "number" || typeof file.mtimeMs !== "number") return;
		const ranges = scope.shownReads.get(path) ?? [];
		scope.shownReads.delete(path);
		ranges.push({ start, end, bytes: file.bytes, mtimeMs: file.mtimeMs });
		if (ranges.length > SHOWN_READS_PER_PATH) ranges.splice(0, ranges.length - SHOWN_READS_PER_PATH);
		scope.shownReads.set(path, ranges);
		if (scope.shownReads.size > SHOWN_READ_PATHS) scope.shownReads.delete(scope.shownReads.keys().next().value ?? path);
	}

	/**
	 * The quote a `memory_note` path binds: the note's longest backticked span, after every backticked span other than
	 * the path itself was found in lines a read of that file showed in this session, with the file unchanged since. A
	 * span the session never saw refuses the note; nothing is ever substituted for it. Only the quote is hashed.
	 */
	function shownQuote(note: string, pathArg: string, root: string): MemoryNoteEvidence | { refused: string } {
		const path = repositoryRelativePath(pathArg, [root]);
		const shown = path === null ? [] : (scope.shownReads.get(path) ?? []);
		if (path === null || shown.length === 0)
			return { refused: `${pathArg} was not read in this session; read it first, or leave path out` };
		let size: { bytes: number; mtimeMs: number } | null = null;
		try {
			const info = statSync(resolve(root, path));
			size = { bytes: info.size, mtimeMs: info.mtimeMs };
		} catch {
			size = null;
		}
		const content = size === null ? null : readInsideRoot(root, path);
		const current = shown.filter((read) => read.bytes === size?.bytes && read.mtimeMs === size.mtimeMs);
		if (content === null || current.length === 0)
			return { refused: `${path} changed since this session read it; read it again first` };
		const lines = content.split("\n");
		const seen = current.map((read) => collapseWhitespace(lines.slice(read.start - 1, read.end).join("\n")));
		const spans = [...note.matchAll(/`([^`\n]+)`/gu)]
			.map((match) => collapseWhitespace(match[1] ?? ""))
			.filter((span) => span.length > 0 && span !== path && span !== collapseWhitespace(pathArg));
		if (spans.length === 0)
			return { refused: `quote in backticks the text from ${path} the note relies on, as the read showed it` };
		const unseen = spans.find((span) => !seen.some((text) => text.includes(span)));
		if (unseen !== undefined)
			return {
				refused: `\`${unseen}\` is not in the lines of ${path} this session read; quote only what the read showed`,
			};
		const quote = [...spans].sort((a, b) => b.length - a.length)[0] ?? "";
		return { kind: "source", path, quote };
	}

	/**
	 * The complete command, and the evidence identity of each segment it vouches
	 * for: one simple command, or each of a pure `&&` chain run from the
	 * workspace root, since exit 0 proves every segment finished with exit 0.
	 * Nothing else is derived; `echo 'a && npm test'` and `true # && npm test`
	 * both succeed without running `npm test`, and a call whose own cwd is not
	 * the root vouches for nothing.
	 */
	function rememberSucceededCommand(command: string, cwd: unknown): void {
		const root = scope.workspaceRoot();
		const at = typeof cwd === "string" ? cwd : undefined;
		if (!atWorkspaceRoot(root, at)) return;
		const segments = commandSegments(command, root, at);
		for (const form of new Set([command, ...segments.map((segment) => segment.text)])) {
			scope.succeededCommands.add(form);
			if (scope.succeededCommands.size > VERIFIED_COMMAND_LIMIT) {
				scope.succeededCommands.delete(scope.succeededCommands.values().next().value ?? form);
			}
		}
		for (const segment of segments) {
			scope.succeededSegments.delete(segment.key);
			scope.succeededSegments.set(segment.key, segment);
			if (scope.succeededSegments.size > VERIFIED_COMMAND_LIMIT) {
				scope.succeededSegments.delete(scope.succeededSegments.keys().next().value ?? segment.key);
			}
			scope.noteCommandEvidence(segment);
			scope.settleDurableLessons(segment);
			pairFix(segment);
		}
	}

	/**
	 * A verify run is a receipt for the argv it executed from the root (CLI-P52): a pass vouches for that command as a
	 * successful shell receipt of it would. A run that did not pass vouches for nothing; it is kept only so a later
	 * memory_note naming its command can say why it is refused.
	 */
	function noteVerifyRun(settledOk: boolean, details: unknown): void {
		const root = scope.workspaceRoot();
		const command = verifyReceiptCommand(details, root);
		if (command === null) return;
		const keys = commandSegments(command, root).map((segment) => segment.key);
		if (verifyRunPassed(settledOk, details)) {
			for (const key of keys) scope.unpassedVerifyChecks.delete(key);
			rememberSucceededCommand(command, undefined);
			return;
		}
		// A run that never launched (an unavailable runner) did not run the command, so the refusal does not name it.
		if (!isRecord(details) || details.launched === false) return;
		if (isRecord(details.judgement) && details.judgement.execution === "unavailable") return;
		const check = typeof details.check === "string" ? details.check : "";
		for (const key of keys) setBounded(scope.unpassedVerifyChecks, key, check, VERIFIED_COMMAND_LIMIT);
	}
}
