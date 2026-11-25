// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { auditExtensionInstallRecords, repairExtensionInstallRecords } from "../domains/extensions/index.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	auditPluginInstallRecords,
	type DroppedInstallRecord,
	type InstallRecordReport,
	repairPluginInstallRecords,
} from "../domains/plugins/index.js";

const STORES = [
	{ kind: "plugin", audit: auditPluginInstallRecords, repair: repairPluginInstallRecords },
	{ kind: "extension", audit: auditExtensionInstallRecords, repair: repairExtensionInstallRecords },
] as const;

const SCOPES = ["user", "project"] as const;

function plural(count: number, one: string): string {
	return `${count} ${one}${count === 1 ? "" : "s"}`;
}

function droppedDetail(file: string, entry: DroppedInstallRecord): string {
	const files = entry.removed
		? ` and removed its files ${entry.removed}`
		: entry.preserved
			? `; its files did not match the record and were moved to ${entry.preserved}`
			: entry.kept
				? `; left ${entry.kept} in place because it is a link`
				: "";
	return `dropped installed.${entry.id} from ${file} (${entry.reason})${files}; reinstall with \`pancode hub install ${entry.pack}\``;
}

/**
 * Plugin and extension install records (`plugins/state.json`, `extensions/state.json`) in both scopes. A record this
 * build does not accept is one warn row; `--fix` drops it and takes its files off the load path. A state file
 * that cannot be read at all is an error row.
 */
export function installRecordFindings(options: { fix?: boolean; cwd?: string } = {}): DoctorFinding[] {
	const cwd = options.cwd ?? process.cwd();
	const findings: DoctorFinding[] = [];
	for (const store of STORES) {
		for (const scope of SCOPES) {
			const label = `${store.kind} install records (${scope})`;
			let report: InstallRecordReport | null;
			try {
				report = options.fix === true ? store.repair(scope, cwd) : store.audit(scope, cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				findings.push({ ok: false, name: label, detail: `${store.kind} install state cannot be read: ${message}` });
				continue;
			}
			if (report === null) continue;
			const { path, valid, invalid, dropped = [] } = report;
			findings.push({ ok: true, name: label, detail: `${plural(valid, "valid record")} in ${path}` });
			for (const entry of dropped)
				findings.push({
					ok: true,
					level: "warn",
					name: `${store.kind} install record ${entry.id} (${scope})`,
					detail: droppedDetail(path, entry),
				});
			for (const entry of invalid)
				findings.push({
					ok: true,
					level: "warn",
					name: `${store.kind} install record ${entry.id} (${scope})`,
					detail: `installed.${entry.id} in ${path} is not loaded: ${entry.reason}; \`pancode doctor --fix\` drops it, then \`pancode hub install ${entry.pack}\` reinstalls it`,
				});
		}
	}
	return findings;
}
