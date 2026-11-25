// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer on screen for a session, reached from outside it: the retry and starter buttons fill it, the
 * Ctrl+K palette runs a command in it, and the Task actions menu opens its dialogs. Each composer registers its
 * handlers here while it is mounted.
 */
import { draftStore } from "./composer-model.js";
import type { SlashAction } from "./slash-model.js";

/** Focus handlers keyed by session, so a retry elsewhere in the turn can fill and focus this field. */
export const focusHandlers = new Map<string, () => void>();
/** Catalog runners keyed by session, so the Ctrl+K palette runs a command where its output is shown. */
export const commandRunners = new Map<string, (name: string) => boolean>();

/** Put the caret in this session's composer, for a control that is leaving the page with focus. */
export function focusComposer(sessionId: string): void {
	focusHandlers.get(sessionId)?.();
}

/**
 * Run a catalog command that takes no arguments, as if `/name` had been submitted here. False when this
 * session has no composer on screen or the line does not parse to a command; nothing was sent then.
 */
export function runComposerCommand(sessionId: string, name: string): boolean {
	return commandRunners.get(sessionId)?.(name) ?? false;
}

/** Dialog openers keyed by session, so the Task actions menu and the palette open what the slash list opens. */
export const actionOpeners = new Map<string, (action: SlashAction) => void>();

/** Form openers keyed by session: the Task actions menu opens the Actions dialog at one command's form. */
export const formOpeners = new Map<string, (name: string) => void>();

/** Open the Actions dialog over this session's composer at the named command's form. */
export function openComposerForm(sessionId: string, name: string): void {
	formOpeners.get(sessionId)?.(name);
}

/** Open one session action's dialog over this session's composer; false when no composer for it is on screen. */
export function openComposerAction(sessionId: string, action: SlashAction): boolean {
	const open = actionOpeners.get(sessionId);
	open?.(action);
	return open !== undefined;
}

/** Fill the composer for this session and put the caret in it. Used by Try again and the starters. */
export function fillComposer(sessionId: string, text: string): void {
	draftStore(sessionId).write(text);
	focusComposer(sessionId);
}
