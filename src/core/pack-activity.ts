// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { writeDiagnostic } from "./diagnostics.js";
import type { PackIdentity } from "./pack-identity.js";

export const EXTENSION_ACTIVITY = "pancode_extension_activity";
export const PLUGIN_RESOURCE_USE = "pancode_plugin_resource_use";
export interface PackActivity {
	eventId: string;
	at: string;
	type: typeof EXTENSION_ACTIVITY | typeof PLUGIN_RESOURCE_USE;
	kind: string;
	owner: PackIdentity;
	outcome?: string;
	sessionId?: string;
	turnId?: string;
	runId?: string;
	captureDroppedBefore?: number;
	details?: Readonly<Record<string, unknown>>;
}
type ActivityInput = Omit<PackActivity, "eventId" | "at" | "type" | "captureDroppedBefore"> & {
	type?: PackActivity["type"];
	at?: string;
};
const LIMIT = 200;
let sink: ((activity: PackActivity) => boolean) | undefined;
const pending: PackActivity[] = [];
const recent: PackActivity[] = [];
let dropped = 0;
export function bindPackActivitySink(next: (activity: PackActivity) => boolean): () => void {
	sink = next;
	flushPackActivities();
	return () => {
		if (sink !== next) return;
		sink = undefined;
		dropped += pending.length;
		pending.length = 0;
		recent.length = 0;
	};
}
export function flushPackActivities(): void {
	if (!sink) return;
	while (pending.length > 0) {
		try {
			const activity = pending[0];
			const reported = dropped;
			if (!activity || !sink(reported > 0 ? { ...activity, captureDroppedBefore: reported } : activity)) return;
			pending.shift();
			dropped -= reported;
			if (reported > 0)
				writeDiagnostic(`Package activity capture dropped ${reported} earlier events; details are unavailable.`);
		} catch {
			// Observability has no authority over a committed host operation.
			return;
		}
	}
}
export function recordPackActivity(input: ActivityInput): void {
	const activity: PackActivity = {
		...input,
		type: input.type ?? EXTENSION_ACTIVITY,
		eventId: randomUUID(),
		at: input.at ?? new Date().toISOString(),
	};
	recent.push(activity);
	if (recent.length > LIMIT) recent.shift();
	pending.push(activity);
	if (pending.length > LIMIT) {
		pending.shift();
		dropped += 1;
	}
	flushPackActivities();
}
export function recentPackActivity(id: string): ReadonlyArray<PackActivity> {
	return recent.filter((row) => row.owner.id === id).slice(-8);
}
export function packageActivityText(activity: PackActivity): string {
	return `${activity.owner.id}@${activity.owner.version} ${activity.kind}${activity.outcome ? `: ${activity.outcome}` : ""} (${activity.owner.digest.slice(0, 12)})`;
}
