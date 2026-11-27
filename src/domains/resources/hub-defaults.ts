// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * First-party packs a PanCode install gives once. The bundled index marks them
 * `default: true`; `upgrade --post-install` installs each into the user scope the
 * first time a release offers it and records the ref, so a pack the operator
 * removes stays removed. Consent is the envelope the release was reviewed with:
 * the staged tree must carry the row's sha256 and envelope digest, or nothing is
 * written. A later post-install moves an installed default to the bundled row only
 * when its envelope reaches no further than the installed copy.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pancodeConfigPath } from "../../core/xdg.js";
import { ENVELOPE_SEAT_BELT, envelopeLines } from "../extensions/envelope-review.js";
import { bundledPluginCatalog } from "../plugins/catalog.js";
import { hubEntryRef } from "./hub.js";
import {
	applyHubLifecycle,
	type HubLifecyclePlan,
	planHubLifecycle,
	releaseHubLifecycle,
	syncHubPackBinaries,
} from "./hub-actions.js";
import { listInstalledHubPackages, readHubInstallRecord } from "./hub-packages.js";
import type { HubPackageEntry } from "./hub-types.js";

/** Where post-install reports. The upgrade presenter satisfies it. */
export interface DefaultPackOutput {
	completedStep(text: string): void;
	note(text: string): void;
	fields(rows: ReadonlyArray<readonly [string, string]>): void;
	warn(text: string): void;
	commandAdvice(lead: string, command: string): void;
}

interface GivenRecord {
	version: 1;
	given: string[];
}

/** `<config>/extensions/defaults.json`: every default ref this home was given. */
function defaultPacksRecordPath(): string {
	return path.join(pancodeConfigPath(), "extensions", "defaults.json");
}

function readGiven(file: string): Set<string> {
	if (!existsSync(file)) return new Set();
	let parsed: Partial<GivenRecord>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GivenRecord>;
	} catch (error) {
		throw new Error(`${file} is unreadable (${error instanceof Error ? error.message : String(error)})`);
	}
	if (parsed?.version !== 1 || !Array.isArray(parsed.given) || parsed.given.some((ref) => typeof ref !== "string"))
		throw new Error(`${file} is not a default pack record`);
	return new Set(parsed.given);
}

function writeGiven(file: string, given: ReadonlySet<string>): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const record: GivenRecord = { version: 1, given: [...given].sort() };
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

/** Why the staged tree is not the one the release reviewed, or null when it is. */
function unreviewed(plan: HubLifecyclePlan, row: HubPackageEntry): string | null {
	const step = plan.steps[0];
	if (plan.steps.length !== 1 || !step) return "it needs other packs installed first";
	if (step.refusal) return step.refusal;
	if (step.source?.sha256 !== row.sha256) return "the staged copy is not the one this release pinned";
	if (row.kind !== "extension") return null;
	const review = plan.reviews?.find((item) => item.ref === step.identity.ref);
	if (!review?.envelope || review.envelopeDigest !== row.envelopeDigest)
		return "its capability envelope is not the one this release reviewed";
	return null;
}

function printEnvelope(out: DefaultPackOutput, plan: HubLifecyclePlan, row: HubPackageEntry): void {
	const review = plan.reviews?.find((item) => item.ref === hubEntryRef(row));
	if (!review?.envelope) return;
	out.note(`${hubEntryRef(row)} is allowed to:`);
	out.fields(
		envelopeLines(review.envelope, row.kind === "extension" ? row.name : undefined).map((line) => {
			const at = line.indexOf(": ");
			return at < 0 ? (["", line] as const) : ([line.slice(0, at), line.slice(at + 2)] as const);
		}),
	);
	out.note(ENVELOPE_SEAT_BELT);
}

async function syncPrograms(
	out: DefaultPackOutput,
	ref: string,
	apply: ReturnType<typeof applyHubLifecycle>,
	cwd: string,
) {
	const failures = await syncHubPackBinaries(apply, cwd, (message) => out.note(message));
	if (failures.length === 0) return;
	for (const failure of failures) out.warn(`A pinned program did not download: ${failure}`);
	out.commandAdvice("Fetch it again with:", `pancode hub update ${ref}`);
}

async function giveDefault(out: DefaultPackOutput, row: HubPackageEntry, cwd: string): Promise<boolean> {
	const ref = hubEntryRef(row);
	const plan = planHubLifecycle({ operation: "install", ref, scope: "user", catalogOnly: true, cwd });
	const problem = unreviewed(plan, row);
	if (problem !== null) {
		releaseHubLifecycle(plan);
		out.warn(`Did not install the default pack ${ref}: ${problem}`);
		out.commandAdvice("Install it yourself after a look with:", `pancode hub install ${ref}`);
		return false;
	}
	printEnvelope(out, plan, row);
	const apply = applyHubLifecycle(plan);
	const outcome = apply.outcomes[0];
	if (outcome?.status !== "committed") {
		out.warn(`Did not install the default pack ${ref}: ${outcome?.error?.message ?? "nothing was committed"}`);
		return false;
	}
	out.completedStep(`Installed ${ref} ${row.version ?? ""}`.trimEnd());
	out.commandAdvice(`${ref} ships with PanCode; remove it with:`, `pancode hub remove ${ref}`);
	await syncPrograms(out, ref, apply, cwd);
	return true;
}

async function refreshDefault(out: DefaultPackOutput, row: HubPackageEntry, cwd: string): Promise<void> {
	const ref = hubEntryRef(row);
	const installed = readHubInstallRecord(row.name, { cwd, scope: "user" }, row.kind);
	if (!installed || installed.contentDigest === row.sha256) return;
	// An update writes the copy enabled; a pack the operator turned off stays off.
	const copy = listInstalledHubPackages(cwd, { scope: "user", all: true }).find(
		(item) => item.id === row.name && (item.kind ?? "plugin") === row.kind,
	);
	if (copy && !copy.enabled) return;
	const update = `pancode hub update ${ref}`;
	let plan: HubLifecyclePlan;
	try {
		plan = planHubLifecycle({ operation: "update", ref, scope: "user", cwd });
	} catch (error) {
		out.note(`Left ${ref} as installed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const problem = unreviewed(plan, row);
	const growth = plan.reviews?.find((item) => item.ref === ref)?.growth;
	if (problem !== null || (row.kind === "extension" && (growth === undefined || growth.length > 0))) {
		releaseHubLifecycle(plan);
		out.note(
			problem !== null
				? `Left ${ref} as installed: ${problem}`
				: `Left ${ref} as installed; ${row.version ?? "the bundled copy"} reaches further: ${(growth ?? []).join("; ")}`,
		);
		out.commandAdvice("Review and update it with:", update);
		return;
	}
	const apply = applyHubLifecycle(plan);
	const outcome = apply.outcomes[0];
	if (outcome?.status !== "committed") {
		out.warn(`Did not update ${ref}: ${outcome?.error?.message ?? "nothing was committed"}`);
		out.commandAdvice("Update it with:", update);
		return;
	}
	out.completedStep(`Updated ${ref} to ${row.version ?? row.sha256}`);
	await syncPrograms(out, ref, apply, cwd);
}

/** The default refs this home has not been given and has no user copy of; empty when the record is unreadable. */
export function pendingDefaultPacks(cwd: string = homedir()): string[] {
	let given: Set<string>;
	try {
		given = readGiven(defaultPacksRecordPath());
	} catch {
		return [];
	}
	const copies = listInstalledHubPackages(cwd, { scope: "user", all: true });
	return bundledPluginCatalog([])
		.filter(
			(row) =>
				row.default === true &&
				!given.has(hubEntryRef(row)) &&
				!copies.some((copy) => copy.id === row.name && (copy.kind ?? "plugin") === row.kind),
		)
		.map(hubEntryRef);
}

/**
 * Give each default pack this home has not had, and move the installed ones
 * that need no new consent. A failure warns; it never fails the post-install.
 */
export async function applyDefaultPacks(out: DefaultPackOutput, cwd: string = homedir()): Promise<void> {
	const diagnostics: string[] = [];
	const defaults = bundledPluginCatalog(diagnostics).filter((row) => row.default === true);
	if (defaults.length === 0) return;
	const file = defaultPacksRecordPath();
	let given: Set<string>;
	try {
		given = readGiven(file);
	} catch (error) {
		out.warn(
			`Skipped the default packs: ${error instanceof Error ? error.message : String(error)}; move it aside to have them offered again`,
		);
		return;
	}
	for (const row of defaults) {
		const ref = hubEntryRef(row);
		try {
			if (given.has(ref)) {
				await refreshDefault(out, row, cwd);
				continue;
			}
			const present = listInstalledHubPackages(cwd, { scope: "user", all: true }).some(
				(copy) => copy.id === row.name && (copy.kind ?? "plugin") === row.kind,
			);
			if (present || (await giveDefault(out, row, cwd))) {
				given.add(ref);
				writeGiven(file, given);
			}
		} catch (error) {
			out.warn(`Did not set up the default pack ${ref}: ${error instanceof Error ? error.message : String(error)}`);
			out.commandAdvice(
				given.has(ref) ? "Update it yourself with:" : "Install it yourself after a look with:",
				`pancode hub ${given.has(ref) ? "update" : "install"} ${ref}`,
			);
		}
	}
}
