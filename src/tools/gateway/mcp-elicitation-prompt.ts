// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * MCP elicitation on the terminal: a server's form or link is put to the
 * operator on the ask_user card, as a harness interview the model cannot
 * answer or interleave. A form is asked a few fields per step, every answer
 * is read and checked against its field (a bad one is asked again with the
 * reason), and a review step shows what would be sent, so the operator can
 * accept, edit or decline it (client/elicitation, Form Mode User Interaction).
 * A link is shown whole with its domain and warnings and opens only on the
 * operator's consent (URL Mode User Interaction).
 */

import { openBrowser } from "../../core/open-browser.js";
import { sleep } from "../../core/timers.js";
import { elicitationValueError, type McpFormField } from "../../core/views/elicitation-values.js";
import {
	describeValue,
	type McpElicitationContext,
	type McpElicitationHost,
	type McpElicitResult,
	type McpElicitValue,
	type McpFormElicitation,
	type McpUrlElicitation,
	readTypedValue,
} from "../../domains/gateway/mcp/index.js";
import type { AskUserAnswer, AskUserHandler, AskUserQuestion, AskUserResult } from "../ask-user.js";
import { createHarnessHold, type HarnessHold, type ToolInvokeOptions } from "../registry-contract.js";

const FIELDS_PER_STEP = 4;
const LEAVE_UNSET = "Leave unset";
/** How long a card waits for the screen another card or a model round holds, in steps. */
const BUSY_RETRY_MS = 250;
const BUSY_RETRIES = 240;

type Interview = NonNullable<ToolInvokeOptions["harnessInterview"]>;
type Draft = NonNullable<Interview["initial"]>[number];

/** The labels a field offers, unique so a picked label names one value; the unset row last. */
function fieldChoices(field: McpFormField): { labels: string[]; values: McpElicitValue[]; unset: string | null } {
	const offered: Array<{ label: string; value: McpElicitValue }> =
		field.kind === "boolean"
			? [
					{ label: "Yes", value: true },
					{ label: "No", value: false },
				]
			: field.kind === "choice" || field.kind === "multi"
				? field.options.map((option) => ({ label: option.label, value: option.value }))
				: [];
	const seen = new Set<string>();
	const labels = offered.map(({ label, value }) => {
		const unique = seen.has(label) ? `${label} (${String(value)})` : label;
		seen.add(unique);
		return unique;
	});
	let unset: string | null = null;
	if (!field.required) {
		unset = LEAVE_UNSET;
		while (seen.has(unset)) unset = `(${unset})`;
	}
	return { labels, values: offered.map(({ value }) => value), unset };
}

function fieldHint(field: McpFormField): string {
	switch (field.kind) {
		case "string": {
			const format = {
				email: "an email address",
				uri: "a URL",
				date: "a date, YYYY-MM-DD",
				"date-time": "a date and time",
			};
			const parts = [
				...(field.format !== undefined ? [`Enter ${format[field.format]}.`] : []),
				...(field.minLength !== undefined ? [`At least ${field.minLength} characters.`] : []),
				...(field.maxLength !== undefined ? [`At most ${field.maxLength} characters.`] : []),
			];
			return parts.join(" ");
		}
		case "number": {
			const range =
				field.minimum !== undefined && field.maximum !== undefined
					? ` from ${field.minimum} to ${field.maximum}`
					: field.minimum !== undefined
						? ` of at least ${field.minimum}`
						: field.maximum !== undefined
							? ` of at most ${field.maximum}`
							: "";
			return `Enter ${field.integer ? "a whole number" : "a number"}${range}.`;
		}
		case "multi":
			return field.minItems !== undefined || field.maxItems !== undefined
				? `Pick ${field.minItems ?? 0} to ${field.maxItems ?? field.options.length}.`
				: "Pick any that apply.";
		default:
			return "";
	}
}

function fieldQuestion(field: McpFormField, error: string | undefined, lead: string | null): AskUserQuestion {
	const { labels, unset } = fieldChoices(field);
	const text = [
		...(lead === null ? [] : [lead]),
		`${field.label}${field.required ? "" : " (optional)"}`,
		...(field.description !== undefined ? [field.description] : []),
		...(fieldHint(field).length > 0 ? [fieldHint(field)] : []),
		...(error !== undefined ? [`Not sent: ${field.label} ${error}. Answer again.`] : []),
	].join("\n\n");
	const options = [...labels, ...(unset !== null ? [unset] : [])];
	const typed = field.kind === "string" || field.kind === "number";
	return {
		question: text,
		header: field.label,
		...(options.length > 0 ? { options: options.map((label) => ({ label })) } : {}),
		...(field.kind === "multi" ? { multi_select: true } : {}),
		// A typed field keeps its Other row, which is where the value is typed beside "Leave unset".
		...(options.length > 0 && !typed ? { fixedChoices: true } : {}),
	};
}

/** The operator's last answer to a field, drafted back into its question. */
function fieldDraft(field: McpFormField, value: McpElicitValue | undefined, typed: string | undefined): Draft {
	if (typed !== undefined) return { text: typed };
	if (value === undefined) return {};
	if (field.kind === "string" || field.kind === "number") return { text: String(value) };
	const { values } = fieldChoices(field);
	const picked = Array.isArray(value) ? value : [value];
	return { selected: values.flatMap((option, index) => (picked.includes(option as string) ? [index] : [])) };
}

type FieldRead = { value: McpElicitValue } | { unset: true } | { error: string; typed?: string };

function readField(field: McpFormField, answer: AskUserAnswer | undefined): FieldRead {
	if (answer === undefined) return { error: "was not answered" };
	const { labels, values, unset } = fieldChoices(field);
	const picked =
		answer.options ??
		(answer.value === undefined && (labels.includes(answer.answer) || answer.answer === unset) ? [answer.answer] : []);
	if (unset !== null && picked.includes(unset) && picked.length === 1) return { unset: true };
	let value: McpElicitValue;
	if (field.kind === "string" || field.kind === "number") {
		const typed = answer.value ?? answer.answer;
		const read = readTypedValue(field, typed);
		if ("error" in read) return { error: read.error, typed };
		value = read.value;
		const error = elicitationValueError(field, value);
		return error === null ? { value } : { error, typed };
	}
	const chosen = picked.filter((label) => label !== unset).map((label) => values[labels.indexOf(label)]);
	if (chosen.some((item) => item === undefined)) return { error: "names an option the form does not offer" };
	value = field.kind === "multi" ? (chosen as string[]) : (chosen[0] as McpElicitValue);
	if (field.kind !== "multi" && chosen.length !== 1) return { error: "needs exactly one choice" };
	const error = elicitationValueError(field, value);
	return error === null ? { value } : { error };
}

/**
 * Ask one round, waiting while another card holds the screen; null is the
 * operator's Esc, an abort, or a screen that never came free.
 */
async function round(
	ask: AskUserHandler,
	questions: AskUserQuestion[],
	interview: Interview,
	hold: HarnessHold,
	signal: AbortSignal,
): Promise<AskUserResult | null> {
	for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
		if (signal.aborted) return null;
		const result = await ask(questions, { origin: "harness", harnessHold: hold, signal, harnessInterview: interview });
		if (result.unavailable === true) {
			await sleep(BUSY_RETRY_MS, signal).catch(() => {});
			continue;
		}
		if (result.cancelled === true || result.timedOut !== undefined || signal.aborted) return null;
		return result;
	}
	return null;
}

async function askForm(
	ask: AskUserHandler,
	serverId: string,
	form: McpFormElicitation,
	signal: AbortSignal,
	hold: HarnessHold,
): Promise<McpElicitResult> {
	const title = `MCP ${serverId}`;
	const lead = `MCP server '${serverId}' asks:\n${form.message}`;
	const values = new Map<string, McpElicitValue>();
	for (const field of form.fields) if (field.default !== undefined) values.set(field.key, field.default);
	const steps: McpFormField[][] = [];
	for (let index = 0; index < form.fields.length; index += FIELDS_PER_STEP)
		steps.push(form.fields.slice(index, index + FIELDS_PER_STEP));
	const total = steps.length + 1;
	while (true) {
		for (const [index, fields] of steps.entries()) {
			const errors = new Map<string, string>();
			const typed = new Map<string, string>();
			while (true) {
				const questions = fields.map((field, position) =>
					fieldQuestion(field, errors.get(field.key), position === 0 ? lead : null),
				);
				const result = await round(
					ask,
					questions,
					{
						title,
						step: index + 1,
						total,
						initial: fields.map((field) => fieldDraft(field, values.get(field.key), typed.get(field.key))),
					},
					hold,
					signal,
				);
				if (result === null) return { action: "cancel" };
				errors.clear();
				typed.clear();
				for (const [position, field] of fields.entries()) {
					const read = readField(field, result.answers[position]);
					if ("unset" in read) values.delete(field.key);
					else if ("value" in read) values.set(field.key, read.value);
					else {
						errors.set(field.key, read.error);
						if (read.typed !== undefined) typed.set(field.key, read.typed);
					}
				}
				if (errors.size === 0) break;
			}
		}
		const lines = form.fields.map((field) => {
			const value = values.get(field.key);
			return `  ${field.label}: ${value === undefined ? "(not set)" : describeValue(field, value)}`;
		});
		const review = await round(
			ask,
			[
				{
					question: `Send this to MCP server '${serverId}'?\n\n${lines.join("\n")}`,
					header: "Review",
					options: [
						{ label: "Accept", description: "Send these values to the server" },
						{ label: "Edit", description: "Go back through the form" },
						{ label: "Decline", description: "Send nothing; the server is told you declined" },
					],
					fixedChoices: true,
				},
			],
			{ title, step: total, total },
			hold,
			signal,
		);
		if (review === null) return { action: "cancel" };
		const choice = review.answers[0]?.options?.[0] ?? review.answers[0]?.answer;
		if (choice === "Decline") return { action: "decline" };
		if (choice === "Accept") return { action: "accept", content: Object.fromEntries(values) };
	}
}

async function askUrl(
	ask: AskUserHandler,
	serverId: string,
	request: McpUrlElicitation,
	context: McpElicitationContext,
	hold: HarnessHold,
	open: (url: string) => boolean,
): Promise<McpElicitResult> {
	const title = `MCP ${serverId}`;
	const where = [
		`URL: ${request.url}`,
		`Domain: ${request.domain}`,
		...request.warnings.map((line) => `Warning: ${line}`),
	];
	let opened = true;
	if (!context.consented) {
		const consent = await round(
			ask,
			[
				{
					question: `MCP server '${serverId}' asks you to open a page in your browser:\n${request.message}\n\n${where.join("\n")}`,
					header: "Open link",
					options: [
						{ label: "Open in browser", description: `Open ${request.domain} in your browser` },
						{ label: "Decline", description: "Do not open it; the server is told you declined" },
					],
					fixedChoices: true,
				},
			],
			{ title, step: 1, ...(context.awaitCompletion ? { total: 2 } : { total: 1 }) },
			hold,
			context.signal,
		);
		if (consent === null) return { action: "cancel" };
		const choice = consent.answers[0]?.options?.[0] ?? consent.answers[0]?.answer;
		if (choice !== "Open in browser") return { action: "decline" };
		try {
			opened = open(request.url);
		} catch {
			opened = false;
		}
		if (!context.awaitCompletion) return { action: "accept" };
	}
	// A server that reports the page finished answers the card as Retry would.
	const waiting =
		context.completed === undefined ? context.signal : AbortSignal.any([context.signal, context.completed]);
	const done = await round(
		ask,
		[
			{
				question: `Finish in your browser at ${request.domain}, then choose Retry.${opened ? "" : "\nPanCode could not open a browser here, so open the URL yourself."}\n\n${where.join("\n")}`,
				header: "Waiting",
				options: [
					{ label: "Retry", description: `Tell '${serverId}' you are done` },
					{ label: "Cancel", description: "Stop waiting; the server is told you cancelled" },
				],
				fixedChoices: true,
			},
		],
		{ title, step: context.consented ? 1 : 2, total: context.consented ? 1 : 2 },
		hold,
		waiting,
	);
	if (context.completed?.aborted === true && !context.signal.aborted) return { action: "accept" };
	if (done === null) return { action: "cancel" };
	const choice = done.answers[0]?.options?.[0] ?? done.answers[0]?.answer;
	return { action: choice === "Retry" ? "accept" : "cancel" };
}

/** The terminal's elicitation host, over the ask_user card the TUI registers. */
export function askUserElicitationHost(
	ask: AskUserHandler,
	open: (url: string) => boolean = (url) => openBrowser(url),
): McpElicitationHost {
	return async (serverId, request, context) => {
		const hold = createHarnessHold();
		try {
			return request.mode === "form"
				? await askForm(ask, serverId, request, context.signal, hold)
				: await askUrl(ask, serverId, request, context, hold, open);
		} finally {
			hold.release();
		}
	};
}
