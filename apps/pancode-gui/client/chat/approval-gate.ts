// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// What the task screen asks of a session's permissions before it draws anything: which request waits, which call it
// gates and how each call's last request settled. Kept apart from the card and its model, which load on their own.
import type { Permission } from "../../contracts/permissions.js";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import { isAwaitingAnswer } from "./permission-state.js";

export function approvalQueue(permissions: readonly Permission[]) {
	const pending = permissions.filter(isAwaitingAnswer);
	return { first: pending[0], position: pending.length > 0 ? `1 of ${pending.length}` : null };
}

/**
 * The distinction between 'told no' and 'not told no' is a real difference in what the model sees:
 * a reject is an answer the agent receives, an expiry or a cancellation is not.
 */
export const RESOLUTION_SUMMARY: Readonly<Record<string, string>> = {
	allowed: "Allowed once by the operator.",
	rejected: "Rejected by the operator. PanCode was told no.",
	cancelled: "Withdrawn when the turn ended. PanCode was not told no.",
	expired: "Nobody answered. The turn was stopped; PanCode was not told no.",
};

export const resolutionSummary = (status: string): string =>
	RESOLUTION_SUMMARY[status] ?? "PanCode recorded an outcome this window does not classify.";

/** toolCallId to the status of its newest approval request; the projection keeps the last 32. */
export function callDecisions(permissions: readonly Permission[]): ReadonlyMap<string, Permission["status"]> {
	const decisions = new Map<string, Permission["status"]>();
	for (const permission of permissions) decisions.set(permission.toolCallId, permission.status);
	return decisions;
}

/** The quiet line an answered card leaves at its anchor: the newest settled request for the call. */
export function decisionRecord(
	permissions: readonly Permission[],
	toolCallId: string,
): { readonly status: Permission["status"]; readonly summary: string } | null {
	for (let index = permissions.length - 1; index >= 0; index -= 1) {
		const permission = permissions[index];
		if (permission === undefined || permission.toolCallId !== toolCallId || isAwaitingAnswer(permission)) continue;
		return { status: permission.status, summary: resolutionSummary(permission.status) };
	}
	return null;
}

export const pendingPermission = (session: SessionSnapshot): Permission | undefined =>
	approvalQueue(session.permissions).first;

/** The permission gating this exact call, matched on the contract's direct link. */
export const permissionForCall = (session: SessionSnapshot, item: TimelineItem): Permission | undefined =>
	item.toolCallId === undefined
		? undefined
		: session.permissions.find((permission) => isAwaitingAnswer(permission) && permission.toolCallId === item.toolCallId);

/** Whether a call has any request, waiting or settled, and so an approval surface to draw beside it. */
export const hasApprovalFor = (session: SessionSnapshot, item: TimelineItem): boolean =>
	item.toolCallId !== undefined && session.permissions.some((permission) => permission.toolCallId === item.toolCallId);
