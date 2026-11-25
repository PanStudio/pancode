// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { parse } from "node:path";
import type { AdoptionScanResult } from "./adoption.js";
import { proposalId } from "./bootstrap-proposals.js";
import type {
	AbsorbReport,
	HandbookCompileReport,
	HandbookLedgerEntry,
	RunBootstrapAdoptionSummary,
	RunBootstrapSummary,
} from "./bootstrap-types.js";

export function buildAbsorbReport(
	ledger: ReadonlyArray<HandbookLedgerEntry>,
	compile: HandbookCompileReport,
	handbooks: ReadonlyArray<string>,
): AbsorbReport {
	const counts: AbsorbReport["counts"] = { verified: 0, stale: 0, unverifiable: 0, contradicted: 0 };
	const rules: AbsorbReport["rules"] = [];
	for (const entry of ledger) {
		counts[entry.verdict] += 1;
		if (entry.kept) continue;
		rules.push({
			status: entry.verdict === "contradicted" ? "contradicted" : "dropped",
			file: entry.source.file,
			line: entry.source.line,
			text: entry.text,
			reason: entry.reason,
		});
	}
	for (const pair of compile.merged) {
		const source = ledger.find((entry) => pair.dropped.includes(entry.text));
		if (!source) continue;
		rules.push({
			status: "merged",
			file: source.source.file,
			line: source.source.line,
			text: source.text,
			reason: `restates: ${pair.kept.replace(/\s+/g, " ").trim()}`,
		});
	}
	return { counts, rules, handbooks: [...handbooks] };
}

const ABSORB_LINE_CAP = 20;

function formatAbsorbLines(summary: RunBootstrapSummary): string[] {
	const absorb = summary.absorb;
	if (!absorb) return [];
	const clip = (text: string): string => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
	};
	const { counts } = absorb;
	const lines = [
		`  absorbed rules: ${counts.verified} verified, ${counts.stale} stale, ${counts.contradicted} contradicted, ${counts.unverifiable} unverifiable`,
	];
	for (const rule of absorb.rules.slice(0, ABSORB_LINE_CAP))
		lines.push(`    ${rule.status} ${rule.file}:${rule.line} ${clip(rule.text)} (${clip(rule.reason)})`);
	if (absorb.rules.length > ABSORB_LINE_CAP)
		lines.push(`    and ${absorb.rules.length - ABSORB_LINE_CAP} more in the ledger`);
	if (absorb.handbooks.length > 0)
		lines.push(`  absorbed handbooks: ${absorb.handbooks.join(", ")}; PanCode did not modify them`);
	return lines;
}

function basenameList(paths: ReadonlyArray<string>): string {
	const names = paths.map((path) => parse(path).base).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return "";
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function formatAdoptionLine(summary: RunBootstrapSummary): string | null {
	const adoption = summary.adoption;
	const shouldRender =
		summary.action === "previewed" ||
		adoption.mode === "adopt" ||
		adoption.globalSourceCount > 0 ||
		adoption.conflictCount > 0 ||
		adoption.rejectedCount > 0;
	if (!shouldRender) return null;
	const global = adoption.includeGlobal ? `${adoption.globalSourceCount} global` : "global off";
	const verb = adoption.mode === "adopt" ? "imported" : "scanned";
	return `  adoption ${verb} ${adoption.sourceCount} source${adoption.sourceCount === 1 ? "" : "s"} (${adoption.projectSourceCount} project, ${global}); ${adoption.importedRuleCount} candidate rule${adoption.importedRuleCount === 1 ? "" : "s"}; ${adoption.conflictCount} conflict${adoption.conflictCount === 1 ? "" : "s"}; ${adoption.rejectedCount} rejected`;
}

function formatCompileLines(summary: RunBootstrapSummary): string[] {
	const compile = summary.compile;
	if (!compile) return [];
	const clip = (rule: string): string => {
		const flat = rule.replace(/\s+/g, " ").trim();
		return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
	};
	const lines: string[] = [];
	if (compile.merged.length > 0) {
		lines.push(`  merged ${compile.merged.length} restated rule${compile.merged.length === 1 ? "" : "s"}`);
		if (summary.action === "previewed")
			for (const pair of compile.merged) lines.push(`    kept: ${clip(pair.kept)}`, `    dropped: ${clip(pair.dropped)}`);
	}
	for (const fix of compile.ruleIds) lines.push(`  rule id ${fix.from} rewritten to ${fix.to}`);
	for (const id of compile.unknownRuleIds) lines.push(`  rule id ${id} not found in the checker`);
	return lines;
}

export function formatBootstrapSummary(summary: RunBootstrapSummary): string {
	const contextLine =
		summary.contextFileCount > 0
			? `folded ${summary.contextFileCount} context file${summary.contextFileCount === 1 ? "" : "s"} (${basenameList(summary.contextFileNames)})`
			: "no sibling context files found";
	const dirtyLine =
		summary.dirtyFiles === 0
			? "workspace clean"
			: `workspace has ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}`;
	if (summary.action === "previewed") {
		const adoptionLine = formatAdoptionLine(summary);
		return [
			"pancode context init preview",
			`  ${contextLine}; codemap would index ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; ${dirtyLine}; no files written`,
			...(adoptionLine ? [adoptionLine] : []),
			...formatCompileLines(summary),
			...formatAbsorbLines(summary),
			"",
		].join("\n");
	}
	const adoptionLine = formatAdoptionLine(summary);
	const proposalLine = summary.proposalPath ? `  proposal written ${summary.proposalPath}` : null;
	if (summary.action === "preserved") {
		return [
			"pancode context init preserved PANCODE.md",
			`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			"  PANCODE.md is treated as human-owned. Use --apply to replace it with a generated draft, --propose to write an ignored proposal, or --adopt to refresh only imported agent context.",
			...(adoptionLine ? [adoptionLine] : []),
			"",
		].join("\n");
	}
	if (summary.action === "proposed") {
		return [
			"pancode context init proposed PANCODE.md",
			`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
			...(proposalLine ? [proposalLine] : []),
			summary.proposalPath
				? `  PANCODE.md was not changed. After reviewing the proposal, write it with pancode context init --accept ${proposalId(summary.proposalPath)}`
				: "  PANCODE.md was not changed.",
			...(adoptionLine ? [adoptionLine] : []),
			...formatCompileLines(summary),
			...formatAbsorbLines(summary),
			"",
		].join("\n");
	}
	return [
		`pancode context init ${summary.action} PANCODE.md`,
		`  ${contextLine}; codemap reconciled ${summary.codewikiEntries} entr${summary.codewikiEntries === 1 ? "y" : "ies"}; state refreshed; ${dirtyLine}`,
		"  git policy: PANCODE.md and what you author under .pancode/ can be committed; .pancode/.gitignore keeps generated files and *.local.yaml out of Git.",
		...(proposalLine ? [proposalLine] : []),
		...(adoptionLine ? [adoptionLine] : []),
		...formatCompileLines(summary),
		...formatAbsorbLines(summary),
		"",
	].join("\n");
}

export function summarizeAdoption(
	adoption: AdoptionScanResult,
	mode: RunBootstrapAdoptionSummary["mode"],
): RunBootstrapAdoptionSummary {
	let projectSourceCount = 0;
	let globalSourceCount = 0;
	for (const source of adoption.sources) {
		if (source.scope === "global") globalSourceCount += 1;
		else projectSourceCount += 1;
	}
	return {
		mode,
		sourceCount: adoption.sources.length,
		projectSourceCount,
		globalSourceCount,
		importedRuleCount: adoption.importedRules.length,
		conflictCount: adoption.conflicts.length,
		rejectedCount: adoption.rejected.length,
		includeGlobal: adoption.includeGlobal,
	};
}
