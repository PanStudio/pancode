// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "typebox/value";
import { elicitationValueError } from "../contracts/elicitation.js";
import { INTERVIEW_META_KEY, InterviewRound } from "../contracts/interviews.js";
import { Interviews } from "../server/acp/interviews.js";

(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`,
);
const { InterviewHeading, ReviewedAnswer } = await import("../client/chat/Interview.js");

const questions = [{ question: "Which partition?", options: [{ label: "gpu" }, { label: "cpu" }] }];

function parkedRound(meta?: Record<string, unknown>): InterviewRound {
	let round: InterviewRound | null = null;
	const interviews = new Interviews((next) => {
		round = next;
	});
	void interviews.request("s1", "t1", {
		sessionId: "s1",
		interviewId: "i1",
		questions,
		...(meta ? { _meta: meta } : {}),
	});
	assert.ok(round, "the request parks a round");
	assert.ok(Value.Check(InterviewRound, round), "the parked round meets the public round contract");
	return round;
}

test("an interview round is operator_only only when the runtime's interview metadata says so", () => {
	assert.equal(parkedRound({ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: true } }).operatorOnly, true);
	for (const meta of [
		undefined,
		{ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: false } },
		{ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: "true" } },
		{ [INTERVIEW_META_KEY]: null },
		{ other: { operatorOnly: true } },
	])
		assert.equal("operatorOnly" in parkedRound(meta), false, JSON.stringify(meta));
});

test("the interview dialog labels an operator_only round and leaves an ordinary one unlabelled", () => {
	const round = parkedRound();
	const render = (value: InterviewRound) =>
		renderToStaticMarkup(React.createElement(InterviewHeading, { round: value, titleId: "t" }));
	const marked = render({ ...round, operatorOnly: true });
	assert.match(marked, /class="interview-dialog__operator-only"/);
	assert.match(marked, /Operator only/);
	assert.doesNotMatch(render(round), /Operator only|interview-dialog__operator-only/);
});

test("the review page draws a question's markdown as the question page did, not its raw backticks", () => {
	const html = renderToStaticMarkup(
		React.createElement(ReviewedAnswer, {
			question: {
				header: "Outside workspace",
				question: "Should I write `hello` to `/tmp/x/note.txt`?",
				options: [{ label: "Yes" }],
			},
			at: 0,
			answer: { selected: [0], text: "" },
			busy: false,
			onEdit: () => {},
		}),
	);
	assert.match(html, /<code[^>]*>hello<\/code>/);
	assert.doesNotMatch(html, /`/);
	assert.match(html, /interview-dialog__chosen">Yes</);
});

test("elicitation value validation rejects impossible date-time and whitespace-padded uri values", () => {
	const when = { key: "when", label: "When", kind: "string", required: true, format: "date-time" } as const;
	for (const bad of ["2026-07-28T25:00:00Z", "2026-07-28T24:00:00Z", "2026-07-28 09:30:00+25:00"])
		assert.notEqual(elicitationValueError(when, bad), null, bad);
	for (const good of ["2026-07-28T12:00:00Z", "2026-07-28 09:30:00+02:30"])
		assert.equal(elicitationValueError(when, good), null, good);
	assert.notEqual(
		elicitationValueError(
			{ key: "link", label: "Link", kind: "string", required: true, format: "uri" },
			" https://example.com",
		),
		null,
	);
	assert.equal(
		elicitationValueError(
			{ key: "link", label: "Link", kind: "string", required: true, format: "uri" },
			"https://example.com/ok",
		),
		null,
	);
});
