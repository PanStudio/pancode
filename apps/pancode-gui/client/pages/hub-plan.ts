// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Sentences for PanHub catalog and its reviewed plans. Pure, so the wording is testable without a browser.

import type { Static } from "typebox";
import { type HubOriginShape, hubCopyStateWords, hubOriginLabel } from "../../../../src/core/views/hub-words.js";
import type { HubApplyResult, HubInventory, HubPlan } from "../../contracts/hub.js";
import type { StatusTone } from "../design/status.js";

export type Package = Static<typeof HubInventory>["packages"][number];
export type Plan = Static<typeof HubPlan>;
export type PlanStep = Plan["steps"][number];
export type Applied = Static<typeof HubApplyResult>;
export type Outcome = Applied["outcomes"][number];
export type Operation = Plan["operation"];
export type Scope = "user" | "project";

export const PACKAGE_KINDS = ["skill", "plugin"] as const;
const VERB: Record<Operation, string> = {
	install: "Install",
	update: "Update",
	enable: "Enable",
	disable: "Disable",
	remove: "Remove",
};
const DONE: Record<Operation, string> = {
	install: "Installed",
	update: "Updated",
	enable: "Enabled",
	disable: "Disabled",
	remove: "Removed",
};
export const verb = (operation: Operation) => VERB[operation];
export const scopeHub = (scope: Scope) => (scope === "user" ? "your user packs" : "this project's packs");
export const scopeCopy = (scope: Scope) => (scope === "user" ? "User copy" : "Project copy");

const COPY_TONES: Readonly<Record<string, StatusTone>> = {
	loadable: "success",
	disabled: "neutral",
	shadowed: "neutral",
	invalid: "fail",
	untrusted: "warn",
	incompatible: "fail",
	damaged: "fail",
};

/** A copy state in the terminal hub's words, sentence-cased for a badge. */
export function copyState(state: string): { label: string; tone: StatusTone } {
	const tone = COPY_TONES[state];
	if (tone === undefined) return { label: state, tone: "unverified" };
	const words = hubCopyStateWords(state);
	return { label: `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`, tone };
}

/** Which lifecycle operations make sense for a copy in this state. The plan, not this list, decides what is allowed. */
export function copyOperations(state: string): Operation[] {
	if (state === "disabled") return ["enable", "update", "remove"];
	if (state === "loadable" || state === "shadowed") return ["update", "disable", "remove"];
	return ["update", "remove"];
}
/** With no workspace open there is no project to install into, so only the user copy can be added. */
export function missingScopes(pkg: Package, workspace = true): Scope[] {
	return (workspace ? (["user", "project"] as const) : (["user"] as const)).filter(
		(scope) => !pkg.copies.some((copy) => copy.scope === scope),
	);
}

/** A query also matches the components a package provides, so searching for a component finds its install target. */
export function matchesPackage(pkg: Package, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase("en-US");
	if (!needle) return true;
	const provided = (pkg.provides ?? []).map((item) => `${String(item.kind)} ${String(item.name)}`);
	return [
		pkg.ref,
		pkg.name,
		pkg.description,
		pkg.sourceUrl,
		originSentence(pkg),
		...(pkg.requires ?? []),
		...pkg.copies.map((copy) => `${String(copy.scope)} ${String(copy.state)}`),
		...provided,
	]
		.join(" ")
		.toLocaleLowerCase("en-US")
		.includes(needle);
}

export function originSentence(pkg: Package): string {
	const origin = pkg.origin as HubOriginShape;
	return origin.kind === undefined && pkg.catalogOrigin === "installed"
		? "Installed; no catalog row"
		: hubOriginLabel(origin);
}

export const stepTitle = (step: PlanStep) =>
	`${VERB[step.operation]} ${step.identity.ref} ${step.operation === "install" ? "into" : "in"} ${scopeHub(step.identity.scope)}`;

export function effectSentence(step: PlanStep): string {
	const note = step.fallbackNote ? `${step.fallbackNote[0]?.toUpperCase()}${step.fallbackNote.slice(1)}.` : "";
	const after = step.effectiveAfter;
	if (!after) return note;
	const words = hubCopyStateWords(after.state);
	const state = after.loadable
		? "PanCode can load it"
		: after.state === "incompatible"
			? `it ${words}`
			: `it is ${words}`;
	return `${note} Afterwards the ${after.scope} copy is the one in effect, and ${state}.`.trim();
}

/** True when the only thing stopping the plan is requirements the catalog can supply. */
export const needsRequirements = (plan: Plan) =>
	!plan.applicable && plan.steps.some((step) => step.refusal?.startsWith("hub_requirement_missing"));

export function diskSentence(outcome: Outcome): string {
	const v = outcome.verification;
	if (!v) return "Nothing was read back from disk.";
	if (v.tree === "present" && v.record === "recorded") return "The files are on disk and the install record matches.";
	if (v.tree === "absent" && v.record === "absent") return "The files and the install record are gone.";
	return `Files on disk: ${v.tree}. Install record: ${v.record}.`;
}

export function componentSentence(outcome: Outcome): string {
	const resources = outcome.verification?.resources ?? [];
	if (outcome.operation === "remove") return "Its components are no longer offered.";
	if (!resources.length) return "This pack declares no components to admit.";
	const blocked = resources.filter((item) => !item.available);
	if (!blocked.length)
		return `${resources.length === 1 ? "Its component is" : `All ${resources.length} components are`} admitted: ${resources.map((item) => item.name).join(", ")}.`;
	return `${resources.length - blocked.length} of ${resources.length} components admitted. Held back: ${blocked
		.map((item) => `${item.name}${item.reason ? ` (${item.reason})` : ""}`)
		.join(", ")}.`;
}

export function outcomeHeadline(outcome: Outcome): { text: string; tone: StatusTone } {
	const where = `${outcome.identity.ref} in ${scopeHub(outcome.identity.scope)}`;
	if (outcome.status === "committed")
		return outcome.error
			? { text: `${DONE[outcome.operation]} ${where}, but verification disagrees`, tone: "warn" }
			: { text: `${DONE[outcome.operation]} ${where}`, tone: "success" };
	if (outcome.status === "failed")
		return { text: `Could not ${VERB[outcome.operation].toLowerCase()} ${where}`, tone: "fail" };
	return { text: `Did not attempt ${where}`, tone: "unverified" };
}
