// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type {
	ElicitationField,
	ElicitationPrompt,
	ElicitationSubmission,
	ElicitationValue,
} from "../../contracts/elicitation.js";
import { routes } from "../../contracts/runtime-routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { useShortcutLayer } from "../interaction/use-shortcut.js";
import {
	blankElicitation,
	describeElicitationValue,
	type ElicitationDraft,
	elicitationContent,
} from "./elicitation-model.js";
import "./interview.css";
import "./elicitation.css";

/** A new tab that cannot reach back into this window or tell the page where the operator came from. */
function openLink(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
}

type FormPrompt = Extract<ElicitationPrompt, { mode: "form" }>;
type UrlPrompt = Extract<ElicitationPrompt, { mode: "url" }>;

/** The title block: which MCP server asks, in its own words, kept as plain text. */
function ElicitationHeading({ prompt, titleId }: { prompt: ElicitationPrompt; titleId: string }) {
	return (
		<div>
			<p className="eyebrow">MCP server request</p>
			<h2 id={titleId}>
				{prompt.server} asks<span className="period">.</span>
			</h2>
		</div>
	);
}

/** The link as it would open, with the part a lookalike cannot fake set apart, and any reason to look twice. */
function ElicitationLink({ prompt }: { prompt: UrlPrompt }) {
	return (
		<dl className="elicitation__link">
			<dt>Domain</dt>
			<dd>
				<strong>{prompt.domain}</strong>
				{prompt.host !== prompt.domain ? <small> ({prompt.host})</small> : null}
			</dd>
			<dt>Link</dt>
			<dd>
				<code>{prompt.url}</code>
			</dd>
			{prompt.warnings.map((warning) => (
				<dd key={warning} className="elicitation__warning">
					<Icon name="warn" />
					{warning}
				</dd>
			))}
		</dl>
	);
}

function FieldInput({
	field,
	value,
	error,
	disabled,
	onChange,
}: {
	field: ElicitationField;
	value: ElicitationDraft[string] | undefined;
	error: string | undefined;
	disabled: boolean;
	onChange: (next: ElicitationDraft[string]) => void;
}) {
	const id = useId();
	const name = `${field.label}${field.required ? "" : " (optional)"}`;
	const hint = field.description ? <small>{field.description}</small> : null;
	const problem = error ? (
		<small role="alert" className="elicitation__error">
			{field.label} {error}
		</small>
	) : null;
	if (field.kind === "string" || field.kind === "number") {
		const type =
			field.kind === "number"
				? "number"
				: field.format === "email"
					? "email"
					: field.format === "uri"
						? "url"
						: field.format === "date"
							? "date"
							: "text";
		return (
			<label className="elicitation__field" htmlFor={id}>
				<span>{name}</span>
				{hint}
				<input
					id={id}
					type={type}
					value={typeof value === "string" ? value : ""}
					disabled={disabled}
					aria-invalid={error ? true : undefined}
					{...(field.kind === "number" ? { step: field.integer ? 1 : "any" } : {})}
					{...(field.kind === "string" && field.format === "date-time" ? { placeholder: "2026-07-28T09:30:00Z" } : {})}
					onChange={(event) => onChange(event.target.value)}
				/>
				{problem}
			</label>
		);
	}
	const choices: { value: string | boolean | null; label: string }[] =
		field.kind === "boolean"
			? [
					{ value: true, label: "Yes" },
					{ value: false, label: "No" },
				]
			: field.options.map((option) => ({ value: option.value, label: option.label }));
	const multi = field.kind === "multi";
	const selected = (choice: string | boolean | null) =>
		multi ? Array.isArray(value) && value.includes(choice as string) : value === choice;
	return (
		<fieldset className="interview-dialog__choices elicitation__choices" disabled={disabled}>
			<legend>{name}</legend>
			{hint}
			{choices.map((choice) => (
				<label key={String(choice.value)} data-selected={selected(choice.value)}>
					<input
						type={multi ? "checkbox" : "radio"}
						name={id}
						checked={selected(choice.value)}
						onChange={() => {
							if (!multi) return onChange(choice.value);
							const current = Array.isArray(value) ? value : [];
							const option = choice.value as string;
							onChange(current.includes(option) ? current.filter((entry) => entry !== option) : [...current, option]);
						}}
					/>
					<span>
						<strong>{choice.label}</strong>
					</span>
				</label>
			))}
			{!multi && !field.required && value !== null && value !== undefined ? (
				<button type="button" className="interview-dialog__clear" onClick={() => onChange(null)}>
					Leave unset
				</button>
			) : null}
			{problem}
		</fieldset>
	);
}

function ElicitationDialog({
	client,
	sessionId,
	prompt,
}: {
	client: Client;
	sessionId: string;
	prompt: ElicitationPrompt;
}) {
	const queries = useQueryClient();
	const dialog = useRef<HTMLDialogElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const submitting = useRef(false);
	const submitted = useRef<{ body: string; key: string } | null>(null);
	const title = useId();
	const [draft, setDraft] = useState<ElicitationDraft>(() =>
		prompt.mode === "form" ? blankElicitation(prompt.fields) : {},
	);
	const [stage, setStage] = useState<"ask" | "review" | "waiting">(() =>
		prompt.mode === "url" && prompt.consented ? "waiting" : "ask",
	);
	const [shown, setShown] = useState(false);
	useShortcutLayer("dialog", true);
	useEffect(() => {
		const node = dialog.current;
		node?.showModal();
		return () => node?.close();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a stage change replaces the visible heading.
	useEffect(() => heading.current?.focus(), [stage]);
	const send = useMutation({
		mutationFn: (body: ElicitationSubmission) => {
			const encoded = JSON.stringify(body);
			if (submitted.current?.body !== encoded) submitted.current = { body: encoded, key: crypto.randomUUID() };
			return client.call(
				routes.answerElicitation,
				{ params: { id: sessionId, promptId: prompt.id }, query: {}, body },
				submitted.current.key,
			);
		},
		onSuccess: () => {
			queries.setQueryData<ElicitationPrompt | null>(["session-elicitation", sessionId], (current) =>
				current?.id === prompt.id ? null : current,
			);
			void queries.invalidateQueries({ queryKey: ["session-elicitation", sessionId] });
		},
		onError: (error) => {
			if (error instanceof ApiProblem && error.problem.code === "conflict")
				void queries.invalidateQueries({ queryKey: ["session-elicitation", sessionId] });
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const submit = (body: ElicitationSubmission) => {
		if (submitting.current) return;
		submitting.current = true;
		send.mutate(body);
	};
	const busy = send.isPending;
	const form = prompt.mode === "form" ? elicitationContent(prompt.fields, draft) : null;
	const ready = form !== null && Object.keys(form.errors).length === 0;
	return createPortal(
		<dialog
			ref={dialog}
			className="interview-dialog elicitation"
			aria-labelledby={title}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) submit({ action: "cancel" });
			}}
		>
			<header className="interview-dialog__header">
				<ElicitationHeading prompt={prompt} titleId={title} />
				<button type="button" disabled={busy} onClick={() => submit({ action: "cancel" })} aria-label="Cancel request">
					<Icon name="close" />
				</button>
			</header>
			<div className="interview-dialog__body">
				<p className="elicitation__message">{prompt.message}</p>
				{prompt.mode === "form" ? (
					stage === "review" ? (
						<FormReview prompt={prompt} content={form?.content ?? {}} heading={heading} />
					) : (
						<section className="elicitation__form">
							<h3 ref={heading} tabIndex={-1}>
								Fill in what it asks for
							</h3>
							{prompt.fields.map((field) => (
								<FieldInput
									key={field.key}
									field={field}
									value={draft[field.key]}
									error={shown ? form?.errors[field.key] : undefined}
									disabled={busy}
									onChange={(next) => setDraft((current) => ({ ...current, [field.key]: next }))}
								/>
							))}
						</section>
					)
				) : (
					<section className="elicitation__url">
						<h3 ref={heading} tabIndex={-1}>
							{stage === "waiting" ? "Finish in your browser" : "Open this link?"}
						</h3>
						<ElicitationLink prompt={prompt} />
						<p>
							{stage === "waiting"
								? "When you are done on that page, choose Retry so the server can continue. Cancel stops this request."
								: "PanCode opens nothing on its own. The page belongs to the server, not to PanCode."}
						</p>
					</section>
				)}
			</div>
			<footer className="interview-dialog__footer">
				{send.error ? <p role="alert">{send.error.message}</p> : <p>Nothing reaches {prompt.server} until you choose.</p>}
				<div>
					{prompt.mode === "form" ? (
						stage === "review" ? (
							<>
								<button type="button" disabled={busy} onClick={() => setStage("ask")}>
									Edit
								</button>
								<button type="button" disabled={busy} onClick={() => submit({ action: "decline" })}>
									Decline
								</button>
								<button
									className="primary"
									type="button"
									disabled={!ready || busy}
									onClick={() => submit({ action: "accept", content: form?.content ?? {} })}
								>
									{busy ? "Sending…" : `Send to ${prompt.server}`}
									<Icon name="arrowUp" />
								</button>
							</>
						) : (
							<>
								<button type="button" disabled={busy} onClick={() => submit({ action: "decline" })}>
									Decline
								</button>
								<button
									className="primary"
									type="button"
									disabled={busy}
									onClick={() => {
										setShown(true);
										if (ready) setStage("review");
									}}
								>
									Review
									<Icon name="chevronRight" />
								</button>
							</>
						)
					) : stage === "waiting" ? (
						<>
							<button type="button" disabled={busy} onClick={() => openLink(prompt.url)}>
								Open again
							</button>
							<button type="button" disabled={busy} onClick={() => submit({ action: "cancel" })}>
								Cancel
							</button>
							<button className="primary" type="button" disabled={busy} onClick={() => submit({ action: "accept" })}>
								Retry
							</button>
						</>
					) : (
						<>
							<button type="button" disabled={busy} onClick={() => submit({ action: "decline" })}>
								Decline
							</button>
							<button
								className="primary"
								type="button"
								disabled={busy}
								onClick={() => {
									openLink(prompt.url);
									if (prompt.awaitCompletion) setStage("waiting");
									else submit({ action: "accept" });
								}}
							>
								Open in browser
								<Icon name="external" />
							</button>
						</>
					)}
				</div>
			</footer>
		</dialog>,
		document.body,
	);
}

/** The review page: every field as it will be sent, so nothing reaches the server unseen. */
function FormReview({
	prompt,
	content,
	heading,
}: {
	prompt: FormPrompt;
	content: Record<string, ElicitationValue>;
	heading?: RefObject<HTMLHeadingElement | null>;
}) {
	return (
		<section className="elicitation__review">
			<h3 ref={heading} tabIndex={-1}>
				This is what {prompt.server} receives.
			</h3>
			<dl>
				{prompt.fields.map((field) => (
					<div key={field.key}>
						<dt>{field.label}</dt>
						<dd>{describeElicitationValue(field, content[field.key])}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

export function Elicitation({
	client,
	sessionId,
	sessionOpen,
	capabilities,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
}) {
	const enabled = sessionOpen && capabilities?.elicitation?.version === 1;
	const pending = useQuery({
		queryKey: ["session-elicitation", sessionId],
		queryFn: () => client.call(routes.sessionElicitation, { params: { id: sessionId }, query: {}, body: {} }),
		enabled,
		retry: false,
	});
	return enabled && pending.data ? (
		<ElicitationDialog key={pending.data.id} client={client} sessionId={sessionId} prompt={pending.data} />
	) : null;
}
