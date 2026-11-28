// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { InterviewQuestion, InterviewSubmission } from "../../contracts/interviews.js";

export type InterviewDraft = { selected: number[]; text: string };
export function blankInterview(questions: readonly InterviewQuestion[]): InterviewDraft[] {
	return questions.map(() => ({ selected: [], text: "" }));
}
/** A draft saved for this round, kept only when every answer still fits its question; otherwise a blank one. */
export function restoredAnswers(questions: readonly InterviewQuestion[], raw: string | null): InterviewDraft[] {
	try {
		const saved: unknown = JSON.parse(raw ?? "null");
		if (
			Array.isArray(saved) &&
			saved.length === questions.length &&
			saved.every(
				(answer, index) =>
					typeof answer?.text === "string" &&
					answer.text.length <= 8192 &&
					Array.isArray(answer.selected) &&
					new Set(answer.selected).size === answer.selected.length &&
					(questions[index]?.multi_select || answer.selected.length <= 1) &&
					answer.selected.every(
						(choice: unknown) =>
							Number.isInteger(choice) && Number(choice) >= 0 && !!questions[index]?.options?.[Number(choice)],
					),
			)
		)
			return saved as InterviewDraft[];
	} catch {
		/* A malformed draft starts blank. */
	}
	return blankInterview(questions);
}
export function answerReady(question: InterviewQuestion, answer: InterviewDraft | undefined): boolean {
	return (
		!!answer &&
		(answer.text.trim().length > 0 || answer.selected.length > 0) &&
		(question.multi_select === true || answer.selected.length <= 1) &&
		answer.selected.every((index) => question.options?.[index] !== undefined)
	);
}
export function selectInterviewChoice(
	question: InterviewQuestion,
	draft: InterviewDraft,
	index: number,
): InterviewDraft {
	if (!question.options?.[index]) return draft;
	const selected = draft.selected.includes(index)
		? draft.selected.filter((choice) => choice !== index)
		: question.multi_select
			? [...draft.selected, index].sort((a, b) => a - b)
			: [index];
	return { ...draft, selected };
}
export function interviewSubmission(
	questions: readonly InterviewQuestion[],
	answers: readonly InterviewDraft[],
): InterviewSubmission | null {
	return questions.length === answers.length &&
		questions.every((question, index) => answerReady(question, answers[index]))
		? { answers: answers.map((answer) => ({ selected: answer.selected, text: answer.text })) }
		: null;
}
