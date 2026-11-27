// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionDiagnostic } from "@pancode/sdk/pack";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import type { InstalledExtensionRecord } from "./listing.js";
import { listInstalledExtensionRecords } from "./state.js";
import {
	type ExtensionHookSource,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
	isLoadableExtension,
} from "./types.js";

export const EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP = 200;
export const EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP = 20;
export const EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP = 512;

export interface BuildExtensionSnapshotInput {
	cwd: string;
	generation: number;
	now?: () => Date;
	listRecords?: (cwd?: string, options?: { all?: boolean }) => InstalledExtensionRecord[];
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
	seen.add(value as object);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function boundedDiagnostics(records: ReadonlyArray<InstalledExtensionRecord>): ExtensionSnapshotDiagnostics {
	const entries: Array<ExtensionDiagnostic & { extensionId?: string }> = [];
	let truncated = 0;
	for (const { entry } of records) {
		let admittedForPackage = 0;
		for (const diagnostic of entry.diagnostics) {
			if (
				admittedForPackage >= EXTENSION_SNAPSHOT_DIAGNOSTIC_PER_PACKAGE_CAP ||
				entries.length >= EXTENSION_SNAPSHOT_DIAGNOSTIC_CAP
			) {
				truncated += 1;
				continue;
			}
			entries.push({
				type: diagnostic.type,
				message: diagnostic.message.slice(0, EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP),
				...(diagnostic.path ? { path: diagnostic.path } : {}),
				extensionId: entry.id,
			});
			admittedForPackage += 1;
		}
	}
	return { entries, truncated };
}

export function buildExtensionSnapshot(input: BuildExtensionSnapshotInput): ExtensionSnapshot {
	const cwd = realpathSync(path.resolve(input.cwd));
	const records = (input.listRecords ?? listInstalledExtensionRecords)(cwd, { all: true });
	const hookSources: ExtensionHookSource[] = [];
	const digestPackages: unknown[] = [];

	for (const record of records) {
		const { entry } = record;
		const commandTools: string[] = [];
		let hooksDigest: string | undefined;
		if (isLoadableExtension(entry)) {
			for (const tool of entry.capabilities?.tools ?? []) commandTools.push(tool.name);
			const hookBytes = record.captured?.get("hooks.yaml");
			if (hookBytes !== undefined) {
				hooksDigest = sha256Hex(hookBytes);
				let declarations: unknown = [];
				let parseError: string | undefined;
				try {
					declarations = parseYaml(hookBytes.toString("utf8")) ?? [];
				} catch (error) {
					parseError = error instanceof Error ? error.message : String(error);
				}
				hookSources.push({
					version: entry.version,
					provenance: entry.provenance,
					declarationsDigest: hooksDigest,
					declarations,
					...(parseError ? { parseError } : {}),
				});
			}
		}
		digestPackages.push({
			id: entry.id,
			scope: entry.scope,
			loadable: entry.loadable,
			...(entry.provenance ? { provenance: entry.provenance } : {}),
			commandTools,
			...(hooksDigest ? { hooksDigest } : {}),
		});
	}

	const snapshot: ExtensionSnapshot = {
		version: 1,
		generation: input.generation,
		cwd,
		builtAt: (input.now ?? (() => new Date()))().toISOString(),
		digest: sha256Hex(canonicalJson(digestPackages)),
		packages: records.map((record) => record.entry),
		hookSources,
		diagnostics: boundedDiagnostics(records),
	};
	return deepFreeze(snapshot);
}

function packageFingerprints(snapshot: ExtensionSnapshot): Map<string, string> {
	const grouped = new Map<string, unknown[]>();
	for (const entry of snapshot.packages) {
		const list = grouped.get(entry.id) ?? [];
		list.push({
			scope: entry.scope,
			loadable: entry.loadable,
			provenance: entry.provenance ?? null,
			capabilities: entry.capabilities ?? null,
		});
		grouped.set(entry.id, list);
	}
	return new Map([...grouped].map(([id, values]) => [id, sha256Hex(canonicalJson(values))]));
}

export function diffExtensionSnapshots(
	previous: ExtensionSnapshot | null,
	next: ExtensionSnapshot,
): { changed: boolean; added: string[]; removed: string[]; modified: string[] } {
	if (previous === null) {
		return { changed: true, added: [...new Set(next.packages.map((entry) => entry.id))], removed: [], modified: [] };
	}
	const before = packageFingerprints(previous);
	const after = packageFingerprints(next);
	const added = [...after.keys()].filter((id) => !before.has(id));
	const removed = [...before.keys()].filter((id) => !after.has(id));
	const modified = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
	return { changed: previous.digest !== next.digest, added, removed, modified };
}
