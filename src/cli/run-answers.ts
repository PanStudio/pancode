// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AnswerRule, parseRunAnswersFile, RunAnswersFileError } from "../core/run-answers-file.js";
import type { AskUserAnswer, AskUserHandler, AskUserQuestion, AskUserResult } from "../tools/ask-user.js";

/**
 * `pancode run --answers <file.yaml>`: the author's answers, written ahead,
 * to the questions only the author may answer in a headless run (WTF-P 0.8.3
 * B1). Those are an extension's interview steps (its gate questions) and the
 * model's `operator_only` ask_user questions. The file is
 *
 *   answers:
 *     - id: plan-introduction        # an extension question's checkpoint id
 *       choice: Approve this plan as shown
 *     - header: Research question    # the question's header, exactly
 *       note: Does tiered caching cut tail latency?
 *     - match: "^Accept the"         # a regex over the question text
 *       choice: Keep it pending
 *
 * Each entry names exactly one rule and gives a `choice` (option labels, one
 * or a list), a `note` (typed text: beside the choice, or the whole answer to
 * a question without options), or both. The first entry in file order whose
 * rule matches answers the question. Rules match author questions only: the
 * model's ordinary ask_user round is never answered from the file, and goes
 * as it does in a run without one, with no operator to answer it. An author
 * question no entry matches is never answered for the author: the round is
 * cancelled as unscripted and the run ends, naming the question so the script
 * can be extended.
 */

/** The question an answers file could not answer, as the run's closing message names it. */
export interface UnscriptedQuestion {
	question: string;
	header?: string;
	checkpoint?: string;
	/** Why it went unanswered: no rule matched, or the matching rule's choice is not on offer. */
	reason: string;
}

export interface ScriptedAnswers {
	/** The answers file as the operator named it, resolved to an absolute path. */
	readonly file: string;
	/**
	 * The ask_user tool's handler. It answers an `operator_only` round from the
	 * file and returns `noOperator` for any other round, which nobody answers in
	 * a headless run.
	 */
	readonly askUser: AskUserHandler;
	/** The headless extension host's handler: answers each extension interview step from the file. */
	readonly interview: AskUserHandler;
	/** The first question the file could not answer; null while every question matched. */
	unscripted(): UnscriptedQuestion | null;
	/** Told once, synchronously, when the first unscripted question cancels its round. */
	onUnscripted(listener: (question: UnscriptedQuestion) => void): () => void;
}

/** Exit status of a run that ended on a question its answers file did not script. */
export const UNSCRIPTED_EXIT_CODE = 5;

function matches(rule: AnswerRule, question: AskUserQuestion): boolean {
	switch (rule.kind) {
		case "id":
			return question.checkpoint === rule.value;
		case "header":
			return question.header?.trim() === rule.value;
		case "match":
			return rule.pattern?.test(question.question) === true;
	}
}

/** The rule's answer to one question, or why that answer is not on offer. */
function answerFor(
	rule: AnswerRule,
	question: AskUserQuestion,
	file: string,
): { answer: AskUserAnswer } | { refusal: string } {
	const offered = (question.options ?? []).map((option) => option.label);
	const scripted = { file, rule: rule.label };
	if (offered.length === 0 || rule.choice === undefined) {
		// A question without options, or an "Other" answer to one with them: the note is the typed answer.
		const text = rule.note ?? rule.choice?.join("; ") ?? "";
		return { answer: { question: question.question, answer: text, value: text, scripted } };
	}
	const missing = rule.choice.find((label) => !offered.includes(label));
	if (missing !== undefined)
		return { refusal: `${rule.label} chooses ${JSON.stringify(missing)}, which the question does not offer` };
	if (rule.choice.length > 1 && question.multi_select !== true)
		return { refusal: `${rule.label} chooses ${rule.choice.length} options for a single-choice question` };
	const labels = offered.filter((label) => rule.choice?.includes(label));
	return {
		answer: {
			question: question.question,
			answer: [...labels, ...(rule.note !== undefined ? [rule.note] : [])].join("; "),
			options: labels,
			...(rule.note !== undefined ? { value: rule.note } : {}),
			scripted,
		},
	};
}

function describeQuestion(question: UnscriptedQuestion): string {
	const named = [
		...(question.header !== undefined ? [`header ${JSON.stringify(question.header)}`] : []),
		...(question.checkpoint !== undefined ? [`id ${JSON.stringify(question.checkpoint)}`] : []),
	];
	const first = question.question.split("\n")[0]?.trim() ?? "";
	return named.length > 0 ? named.join(", ") : `question ${JSON.stringify(first)}`;
}

/** The run's closing line for a question the file did not script. */
export function unscriptedRunMessage(answers: ScriptedAnswers, question: UnscriptedQuestion): string {
	return `pancode run: unscripted question (${describeQuestion(question)}): ${question.reason}; add an entry for it to ${answers.file} and run again`;
}

function createScriptedAnswers(file: string, rules: ReadonlyArray<AnswerRule>): ScriptedAnswers {
	let first: UnscriptedQuestion | null = null;
	const listeners = new Set<(question: UnscriptedQuestion) => void>();
	const unscripted = (question: AskUserQuestion, reason: string): AskUserResult => {
		if (first === null) {
			first = {
				question: question.question,
				...(question.header !== undefined ? { header: question.header } : {}),
				...(question.checkpoint !== undefined ? { checkpoint: question.checkpoint } : {}),
				reason,
			};
			const settled = first;
			for (const listener of [...listeners]) listener(settled);
		}
		return { answers: [], cancelled: true, unscripted: true };
	};
	const interview: AskUserHandler = async (questions) => {
		// Once one question went unanswered the run is ending; nothing later is answered either.
		const ended = first;
		if (ended !== null) return { answers: [], cancelled: true, unscripted: true };
		const answers: AskUserAnswer[] = [];
		for (const question of questions) {
			const rule = rules.find((candidate) => matches(candidate, question));
			if (rule === undefined) return unscripted(question, `no entry in ${path.basename(file)} matches it`);
			const resolved = answerFor(rule, question, file);
			if ("refusal" in resolved) return unscripted(question, resolved.refusal);
			answers.push(resolved.answer);
		}
		return { answers };
	};
	return {
		file,
		// operator_only is asked alone, so a round is either wholly the author's or wholly the model's ordinary ask.
		askUser: (questions, options) =>
			questions.some((question) => question.operator_only === true)
				? interview(questions, options)
				: Promise.resolve({ answers: [], cancelled: true, noOperator: true }),
		interview,
		unscripted: () => first,
		onUnscripted(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Read and validate an answers file before boot; a bad file is a usage error naming the offending entry. */
export function loadScriptedAnswers(file: string): ScriptedAnswers | { error: string } {
	const resolved = path.resolve(file);
	let text: string;
	try {
		text = readFileSync(resolved, "utf8");
	} catch (error) {
		return {
			error: `--answers ${resolved}: cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		return createScriptedAnswers(resolved, parseRunAnswersFile(text));
	} catch (error) {
		if (error instanceof RunAnswersFileError) return { error: `--answers ${resolved}: ${error.message}` };
		throw error;
	}
}
