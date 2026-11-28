// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PROMPT_TEXT_MAX_CHARACTERS } from "../chat/prompt-limit.js";

/** The first request belongs to one tab, independently of the page that currently shows it. */
export interface FirstRequest {
	readonly workspaceId: string;
	readonly exactTurnBody: { readonly text: string };
	readonly epoch: string;
	readonly createKey: string;
	readonly turnKey: string;
	readonly sessionId: string | null;
	readonly phase: "creating" | "created" | "submitting";
	readonly draftRevision: number;
}

export interface HomeDraft {
	readonly version: 1;
	readonly revision: number;
	readonly text: string;
	readonly textIssue: "too-large" | "restored-too-large" | "invalid" | null;
	readonly workspaceId: string | null;
	readonly pending: FirstRequest | null;
}

export const HOME_DRAFT_TEXT_MAX_CHARACTERS = 100_000;
export const EMPTY_HOME_DRAFT: HomeDraft = {
	version: 1,
	revision: 0,
	text: "",
	textIssue: null,
	workspaceId: null,
	pending: null,
};
const id = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

/** Storage is untrusted and optional. Editable text must never invalidate a sound pending command. */
export function decodeHomeDraft(raw: string | null): HomeDraft {
	if (!raw) return EMPTY_HOME_DRAFT;
	try {
		const value = JSON.parse(raw) as Partial<HomeDraft> | null;
		if (value?.version !== 1) return EMPTY_HOME_DRAFT;
		const request = value.pending;
		if (
			request !== null &&
			(!request ||
				!id(request.workspaceId) ||
				!id(request.epoch) ||
				!id(request.createKey) ||
				!id(request.turnKey) ||
				(request.sessionId !== null && !id(request.sessionId)) ||
				!["creating", "created", "submitting"].includes(request.phase) ||
				(request.phase !== "creating" && request.sessionId === null) ||
				!Number.isSafeInteger(request.draftRevision) ||
				request.draftRevision < 0 ||
				typeof request.exactTurnBody?.text !== "string" ||
				!request.exactTurnBody.text.trim() ||
				request.exactTurnBody.text.length > PROMPT_TEXT_MAX_CHARACTERS)
		)
			return EMPTY_HOME_DRAFT;
		const textIssue =
			typeof value.text !== "string"
				? "invalid"
				: value.text.length > HOME_DRAFT_TEXT_MAX_CHARACTERS
					? "restored-too-large"
					: value.textIssue === "too-large" || value.textIssue === "restored-too-large" || value.textIssue === "invalid"
						? value.textIssue
						: null;
		const validRevision = Number.isSafeInteger(value.revision) && (value.revision ?? -1) >= 0;
		let revision = validRevision ? (value.revision as number) : 0;
		// Repaired editor data cannot be treated as the unchanged submitted draft by a later acknowledgement.
		if (request && (textIssue || !validRevision || revision < request.draftRevision))
			revision = Math.min(Math.max(revision, request.draftRevision) + 1, Number.MAX_SAFE_INTEGER);
		return {
			version: 1,
			revision,
			text: typeof value.text === "string" ? value.text.slice(0, HOME_DRAFT_TEXT_MAX_CHARACTERS) : "",
			textIssue,
			workspaceId: id(value.workspaceId) ? value.workspaceId : (request?.workspaceId ?? null),
			pending: request
				? {
						workspaceId: request.workspaceId,
						epoch: request.epoch,
						createKey: request.createKey,
						turnKey: request.turnKey,
						sessionId: request.sessionId,
						phase: request.phase,
						draftRevision: request.draftRevision,
						exactTurnBody: { text: request.exactTurnBody.text },
					}
				: null,
		};
	} catch {
		return EMPTY_HOME_DRAFT;
	}
}

/** Confirmation of an older send must leave subsequent edits and workspace choices intact. */
export function acknowledgeFirstRequest(draft: HomeDraft, sent: FirstRequest): HomeDraft {
	if (draft.pending?.turnKey !== sent.turnKey) return draft;
	return {
		...draft,
		// A saturated or repaired counter cannot establish that no newer edit occurred.
		text: draft.revision < Number.MAX_SAFE_INTEGER && draft.revision === sent.draftRevision ? "" : draft.text,
		pending: null,
	};
}

/** Why the draft cannot be used as written, if it cannot. */
export function homeTextIssue(draft: Pick<HomeDraft, "text" | "textIssue">): string | null {
	const most = HOME_DRAFT_TEXT_MAX_CHARACTERS.toLocaleString();
	if (draft.textIssue === "too-large")
		return `Drafts can contain up to ${most} characters. This edit was not applied; shorten the text and try again.`;
	if (draft.textIssue === "restored-too-large")
		return `The saved draft exceeded ${most} characters. Only its first ${most} characters were restored.`;
	if (draft.textIssue === "invalid") return "The saved draft text could not be restored.";
	if (draft.text.trim().length > PROMPT_TEXT_MAX_CHARACTERS)
		return `A request can contain up to ${PROMPT_TEXT_MAX_CHARACTERS.toLocaleString("en-US")} characters. Shorten the draft before starting a session.`;
	return null;
}

/**
 * The workspace the next task lands in. A missing saved choice stays chosen as a recovery state; never send to a
 * fallback project silently.
 */
export function homeWorkspaceId(
	saved: string | null,
	active: string | null | undefined,
	listed: ReadonlyArray<{ id: string }>,
): string | null {
	return saved ?? active ?? listed[0]?.id ?? null;
}

/** A first request starts only with a usable connection, a listed workspace, a sendable text, and nothing in flight. */
export function canStartFirstTask(state: {
	ready: boolean;
	setupPending: boolean;
	workspacesLoaded: boolean;
	workspaceListed: boolean;
	text: string;
	busy: boolean;
	pending: boolean;
}): boolean {
	const text = state.text.trim();
	return (
		(state.ready || state.setupPending) &&
		state.workspacesLoaded &&
		state.workspaceListed &&
		text !== "" &&
		text.length <= PROMPT_TEXT_MAX_CHARACTERS &&
		!state.busy &&
		!state.pending
	);
}

/** The setup steps the new-task screen still shows, and how many of them the stage counts as done. */
export function homeOnboarding(state: {
	setupLoaded: boolean;
	ready: boolean;
	workspacesLoaded: boolean;
	listed: number;
}): { needsSetup: boolean; needsWorkspace: boolean; onboarding: boolean; stageDone: number | null } {
	const needsSetup = state.setupLoaded && !state.ready;
	const needsWorkspace = state.workspacesLoaded && state.listed === 0;
	return {
		needsSetup,
		needsWorkspace,
		onboarding: needsSetup || needsWorkspace,
		// Steps finish in order, so the caption names the first open one even when a later one is already done.
		stageDone: state.setupLoaded && state.workspacesLoaded ? (state.ready ? (needsWorkspace ? 1 : 2) : 0) : null,
	};
}

/**
 * The workspace the model-connection check is asked about: only one the workspace list holds. A workspace this
 * browser remembers from before (a removed folder, another home) is answered with not-found, which read as "the
 * model connection could not be checked" and hid a ready model behind "Connect a model".
 */
export function setupWorkspaceId(chosen: string | null, listed: ReadonlyArray<{ id: string }>): string | null {
	return chosen !== null && listed.some((item) => item.id === chosen) ? chosen : null;
}

/**
 * The new-task screen's workspace recovery notice, if any. An empty list is not one: the onboarding step names it
 * and offers Open workspace, and a second box with the same button made two empty states on one screen.
 */
export function workspaceNotice(workspaces: {
	pending: boolean;
	failed: boolean;
	listed: number;
	/** The chosen workspace is not in a loaded list. */
	missing: boolean;
}): { text: string; alert: boolean } | null {
	if (workspaces.pending) return { text: "Loading projects. You can keep writing while PanCode checks.", alert: false };
	if (workspaces.failed)
		return { text: "Projects could not be loaded. Your draft is kept; retry to check them again.", alert: true };
	if (workspaces.missing && workspaces.listed > 0)
		return {
			text: "Your chosen project is no longer listed. Retry, choose another project, or reopen its folder.",
			alert: false,
		};
	return null;
}

/**
 * The workspace list once the server has opened a workspace: it leads the list, as its newest open. A list read that
 * began before the open answers without it, and the new-task screen then called it "no longer listed" and the sidebar
 * New task fell back to another project (bt2-3, bt2-4), so the open seeds the list it already knows to be true.
 */
export function withOpenedWorkspace<T extends { id: string }>(listed: ReadonlyArray<T> | undefined, opened: T): T[] {
	return [opened, ...(listed ?? []).filter((item) => item.id !== opened.id)];
}
