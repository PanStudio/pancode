// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { createTomlFileReader } from "../../core/toml.js";
import { enumerateWorkspaceFiles, enumerateWorkspaceFilesAsync } from "../../core/workspace-files.js";
import { detectProjectType, detectProjectTypeHint } from "../session/workspace/project-type.js";
import { type AdoptionScanResult, scanAgentConfigs } from "./adoption.js";
import { gitOutput } from "./bootstrap-git.js";
import {
	CODE_TOKEN_RE,
	createModelGroundingCorpus,
	GENERATION_EXCLUDED_FILES,
	staleCitationReason,
} from "./bootstrap-grounding.js";
import { loadBootstrapSiblingFiles, projectName, verificationSection } from "./bootstrap-project.js";
import { proposalId, readLedgerFile, writeLedgerFile, writeProposalFile } from "./bootstrap-proposals.js";
import { authoredProjectRules, checkerRuleList, correctedRuleIds, uncoveredCheckerSection } from "./bootstrap-rules.js";
import type {
	BootstrapGenerateInput,
	BootstrapStructuredOutput,
	HandbookCompileReport,
	HandbookLedgerEntry,
} from "./bootstrap-types.js";
import { readCodewiki } from "./codewiki/artifact.js";
import { buildCodewikiCandidate } from "./codewiki/coordinator.js";
import { CODEWIKI_VERSION, type Codewiki } from "./codewiki/schema.js";
import { collectEnforcementInventory, type EnforcementInventory } from "./enforcement-inventory.js";
import { normalizeHandbookRule } from "./handbook-budget.js";
import { instructionUnits } from "./instruction-units.js";
import { HANDBOOK_TARGETS, loadProjectPancodeMd, serializePancodeMd } from "./pancode-md.js";
import { contradictingFact, forbidsCitation, type TreeFact, treeFacts } from "./tree-facts.js";

/** A handbook compiled from the tree alone, for a repository that has none. */
export interface TreeCompiledHandbook {
	/** The handbook in PANCODE.md form, so it routes to workers like a written one. */
	markdown: string;
	/** Repository-relative files its rules came from, sorted. */
	sources: string[];
	/** Rules it states: checker rules, adopted rules whose citations resolve, and manifest facts. */
	rules: number;
}

/** A tree fact as a convention that names where it was read; scripts are left to the verification section. */
function treeFactConvention(fact: TreeFact): string | null {
	switch (fact.key) {
		case "package-manager":
			return `The package manager is ${fact.value} (from ${fact.source}).`;
		case "test-runner":
			return `Tests run with ${fact.value} (from ${fact.source}).`;
		case "formatter":
			return `Code is formatted with ${fact.value} (from ${fact.source}).`;
		case "ts-strict":
			return `TypeScript strict mode is ${fact.value === "true" ? "on" : "off"} (from ${fact.source}).`;
		case "node-engine":
			return `The supported Node.js range is ${fact.value} (from ${fact.source}).`;
		case "scripts":
			return null;
	}
}

/**
 * Compile a handbook without a model for a repository that has no
 * PANCODE.md: the rules its checkers declare, the rules of other harnesses'
 * handbooks whose citations resolve in this tree, its verification commands,
 * and its tree facts. Null when no checker declares a rule and no adopted rule
 * verifies, so a repository with nothing checkable to say gets nothing.
 */
export function compileHandbookFromTree(input: {
	cwd: string;
	repositoryFiles: ReadonlyArray<string>;
	adoption: AdoptionScanResult;
	enforcement: EnforcementInventory;
}): TreeCompiledHandbook | null {
	const { cwd, repositoryFiles, adoption, enforcement } = input;
	const projectType = detectProjectTypeHint(cwd);
	const generate: BootstrapGenerateInput = {
		cwd,
		projectType,
		siblingFiles: loadBootstrapSiblingFiles(adoption),
		adoption,
		codewiki: { version: CODEWIKI_VERSION, language: projectType, files: [], symbols: [], edges: [] },
		enforcement,
		repositoryFiles: repositoryFiles.filter((path) => !GENERATION_EXCLUDED_FILES.has(path)),
	};
	const checkerRules = checkerRuleList(generate);
	if (checkerRules.length === 0 && adoption.sources.length === 0) return null;
	const ordered = [
		...checkerRules.filter((rule) => rule.architectural),
		...checkerRules.filter((rule) => !rule.architectural),
	];
	const invariants = ordered
		.slice(0, HANDBOOK_TARGETS.invariants)
		.map((rule) => rule.sentence)
		.filter((sentence) => sentence.length <= HANDBOOK_TARGETS.invariantChars);
	const conventions = treeFacts(cwd, enforcement.ciCommands ?? [])
		.map(treeFactConvention)
		.filter((line): line is string => line !== null);
	const adopted = authoredProjectRules(
		generate,
		{ projectName: "", identity: "", invariants, conventions } as BootstrapStructuredOutput,
		createModelGroundingCorpus(generate),
		{ verifiedOnly: true },
	);
	const adoptedLines = adopted.flatMap((section) => section.body.split("\n").filter((line) => line.startsWith("- ")));
	if (invariants.length === 0 && adoptedLines.length === 0) return null;
	const stated = [...invariants, ...adoptedLines].join("\n");
	const overflow = uncoveredCheckerSection(
		ordered.filter((rule) => !invariants.includes(rule.sentence)),
		stated,
		new Set(invariants.map(normalizeHandbookRule)),
	);
	const tomlFiles = createTomlFileReader(cwd);
	const verification = verificationSection(cwd, tomlFiles);
	const sources = [
		...new Set([
			...checkerRules
				.filter((rule) => invariants.includes(rule.sentence) || overflow?.body.includes(rule.sentence))
				.map((rule) => rule.path),
			...adoptedLines.flatMap((line) => /\(source: ([^():]+):\d+\)$/.exec(line)?.[1] ?? []),
		]),
	].sort();
	const overflowLines = overflow ? overflow.body.split("\n").filter((line) => line.startsWith("- ")).length : 0;
	const markdown = serializePancodeMd({
		projectName: projectName(cwd, tomlFiles),
		identity: `This handbook was compiled without a model from ${sources.map((source) => `\`${source}\``).join(", ")}; no PANCODE.md in this repository. Its invariants are what those checkers fail on, its adopted rules are kept only where every file they cite exists here, and its conventions and commands are read from the manifests. Nothing in it was run or reviewed.`,
		invariants,
		conventions,
		sections: [...adopted, ...(overflow ? [overflow] : []), ...(verification ? [verification] : [])],
	});
	return {
		markdown,
		sources,
		rules: invariants.length + conventions.length + adoptedLines.length + overflowLines,
	};
}

/** The effective handbook's rules re-checked against the current tree by `context init --verify`. */
export interface HandbookVerification {
	/** The directory the handbook paths, citations and ledger are resolved from: the repository root. */
	root: string;
	/** Root-relative paths of the handbook files that were checked. */
	files: string[];
	commit: string | null;
	entries: HandbookLedgerEntry[];
}

/** The index, less every file the tree no longer holds, so a deleted file never grounds a citation. */
function codewikiOnTree(codewiki: Codewiki, repositoryFiles: ReadonlyArray<string>, root: string): Codewiki {
	const present = new Set(repositoryFiles);
	const files = codewiki.files.filter((file) => present.has(file.path));
	const paths = new Map(files.map((file) => [file.id, file.path]));
	const texts = new Map<string, string>();
	const textOf = (path: string): string => {
		let text = texts.get(path);
		if (text === undefined) {
			try {
				text = readFileSync(join(root, path), "utf8");
			} catch {
				// The tree listing named it but it cannot be read now (removed or unreadable): it names no symbol.
				text = "";
			}
			texts.set(path, text);
		}
		return text;
	};
	// A symbol counts only while its file still names it: an index older than the tree keeps removed functions.
	const symbols = codewiki.symbols.filter((symbol) => {
		const path = paths.get(symbol.fileId);
		if (path === undefined) return false;
		const name = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(textOf(path));
	});
	if (files.length === codewiki.files.length && symbols.length === codewiki.symbols.length) return codewiki;
	return { ...codewiki, files, symbols };
}

/** A handbook file to verify: its repository-relative name, its path and its text. */
export interface HandbookToVerify {
	file: string;
	path: string;
	content: string;
}

/** Every rule of some handbooks judged against a tree, and the rules that tree's checkers declare. */
export interface HandbookRuleVerdicts {
	entries: HandbookLedgerEntry[];
	/** The checker rules as whole sentences, each naming its rule id and checker file. */
	checkerRules: string[];
}

/**
 * Re-ground each rule of `handbooks` against the tree at `root` without a
 * model and without writing anything: backticked citations against the tree,
 * tree-fact claims against the tree-fact table, checker ids against the
 * enforcement inventory. No instruction file (handbook, AGENTS.md, CLAUDE.md
 * and the like) counts as evidence. With no recorded code index and none
 * supplied, a rule citing a symbol does not verify.
 */
export function verifyHandbookRules(
	root: string,
	handbooks: ReadonlyArray<HandbookToVerify>,
	evidence: { repositoryFiles?: ReadonlyArray<string>; codewiki?: Codewiki } = {},
	origin: HandbookLedgerEntry["origin"] = "handbook",
): HandbookRuleVerdicts {
	const repositoryFiles = [
		...(evidence.repositoryFiles ?? enumerateWorkspaceFiles(root).filter((path) => !GENERATION_EXCLUDED_FILES.has(path))),
	];
	const projectType = detectProjectType(root);
	const indexed = evidence.codewiki ?? readCodewiki(root);
	const codewiki = indexed
		? codewikiOnTree(indexed, repositoryFiles, root)
		: { version: CODEWIKI_VERSION, language: projectType, files: [], symbols: [], edges: [] };
	const enforcement = collectEnforcementInventory(root, repositoryFiles);
	const adoption = scanAgentConfigs({ cwd: root, includeGlobal: false });
	const input: BootstrapGenerateInput = {
		cwd: root,
		projectType,
		// The handbook under review is the claim, never its own evidence, and neither is any other instruction file.
		siblingFiles: [
			...handbooks.map((handbook) => ({ source: "handbook", path: handbook.path, content: handbook.content })),
			...loadBootstrapSiblingFiles(adoption),
		],
		adoption,
		codewiki,
		enforcement,
		repositoryFiles,
	};
	const corpus = createModelGroundingCorpus(input);
	const facts = treeFacts(root, enforcement.ciCommands ?? []);
	const checkerRules = checkerRuleList(input);
	const codes = new Set(checkerRules.map((rule) => rule.code));
	const entries: HandbookLedgerEntry[] = [];
	for (const handbook of handbooks) {
		for (const unit of instructionUnits(handbook.content, 600, handbook.file, 1, true)) {
			const line = unit.text.trim();
			if (line.length === 0) continue;
			const citations = [...line.matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? "").filter(Boolean);
			const ids = [...new Set([...line.matchAll(/\brule\d+\b/g)].map((match) => match[0]))];
			const entry = (
				verdict: HandbookLedgerEntry["verdict"],
				reason: string,
				ruleIds: { from: string; to: string }[] = [],
			): void => {
				entries.push({
					id: sha256Hex(`${unit.file}:${unit.line}:${line}`).slice(0, 12),
					text: line,
					origin,
					source: { file: unit.file, line: unit.line, endLine: unit.endLine },
					citations,
					verdict,
					reason,
					kept: true,
					...(ruleIds.length > 0 ? { ruleIds } : {}),
				});
			};
			// Too long to judge as one rule, or an introduction whose list it could not take in: still listed.
			if (unit.unjudged === "oversized") {
				entry("unverifiable", "longer than 600 characters; split it into rules the tree can check");
				continue;
			}
			if (unit.unjudged === "intro") {
				entry("unverifiable", "an introduction with no list under it");
				continue;
			}
			// A rule is stale when nothing it cites survives grounding, or when a concrete file it names is gone.
			const stale = staleCitationReason(line, corpus);
			if (stale !== null) {
				entry("stale", stale);
				continue;
			}
			if (codes.size > 0 && ids.length > 0) {
				const report: HandbookCompileReport = { merged: [], ruleIds: [], unknownRuleIds: [] };
				correctedRuleIds(line, checkerRules, report);
				if (report.ruleIds.length > 0) {
					const changes = report.ruleIds.map((change) => `${change.from} is now ${change.to}`).join(", ");
					entry("stale", `renumbered rule id: ${changes}`, report.ruleIds);
					continue;
				}
				const unknown = [...new Set([...report.unknownRuleIds, ...ids.filter((id) => !codes.has(id))])];
				if (unknown.length > 0) {
					entry("stale", `no checker declares ${unknown.join(", ")}`);
					continue;
				}
			}
			const fact = contradictingFact(line, facts);
			if (fact) {
				entry("contradicted", `${fact.source} states ${fact.key} ${fact.value}`);
				continue;
			}
			const checked = [...line.matchAll(CODE_TOKEN_RE)].filter((match) => match[1] && !forbidsCitation(line, match.index));
			if (checked.length > 0 || ids.length > 0) entry("verified", "every citation resolves");
			else if (citations.length > 0) entry("unverifiable", "cites only what it forbids, which the tree cannot confirm");
			else entry("unverifiable", "cites nothing the tree can check");
		}
	}
	return { entries, checkerRules: checkerRules.map((rule) => rule.sentence) };
}

/**
 * Re-ground every rule of the effective handbook without a model (see
 * `verifyHandbookRules`). Paths resolve from the repository root whatever
 * directory it runs in. Records the verdicts and the commit in the handbook
 * ledger.
 */
export async function verifyHandbook(cwd: string): Promise<HandbookVerification> {
	const loaded = loadProjectPancodeMd(cwd);
	const root = pancodeProjectRoot(cwd);
	const handbooks = loaded.files.map((file) => ({
		file: relative(root, file.path).split("\\").join("/"),
		path: file.path,
		content: file.source,
	}));
	const repositoryFiles = (await enumerateWorkspaceFilesAsync(root)).filter(
		(path) => !GENERATION_EXCLUDED_FILES.has(path),
	);
	const codewiki = readCodewiki(root) ?? (await buildCodewikiCandidate(root, detectProjectType(root))).codewiki;
	const { entries } = verifyHandbookRules(root, handbooks, { repositoryFiles, codewiki });
	const commit = gitOutput(root, ["rev-parse", "HEAD"])?.trim() || null;
	const previous = readLedgerFile(root);
	writeLedgerFile(root, {
		version: 1,
		commit: typeof previous.commit === "string" ? previous.commit : null,
		entries: Array.isArray(previous.entries) ? previous.entries : [],
		verifiedCommit: commit ?? "uncommitted",
		verifiedAt: new Date().toISOString(),
		verification: entries.map((entry) => ({ ...entry, commit })),
	});
	return { root, files: handbooks.map((handbook) => handbook.file), commit, entries };
}

/**
 * Judge each instruction unit of `files` against the tree, the way
 * `context init --verify` judges the handbook (see `verifyHandbookRules`),
 * with `origin` on each entry. Paths resolve from the repository root above
 * `cwd`. The files under review are the claim, never their own evidence, and
 * neither is any other instruction file. Writes nothing.
 */
export async function judgeInstructionFiles(
	cwd: string,
	files: ReadonlyArray<HandbookToVerify>,
	origin: HandbookLedgerEntry["origin"],
): Promise<HandbookLedgerEntry[]> {
	const root = pancodeProjectRoot(cwd);
	const repositoryFiles = (await enumerateWorkspaceFilesAsync(root)).filter(
		(path) => !GENERATION_EXCLUDED_FILES.has(path),
	);
	const codewiki = readCodewiki(root) ?? (await buildCodewikiCandidate(root, detectProjectType(root))).codewiki;
	return verifyHandbookRules(root, files, { repositoryFiles, codewiki }, origin).entries;
}

/** One handbook file `--verify --apply` proposes to change, as a proposal `--accept` writes. */
export interface HandbookVerificationProposal {
	file: string;
	proposalPath: string;
	id: string;
	diff: string;
}

/**
 * The edit `--verify --apply` proposes: each stale or contradicted rule is
 * removed over its whole extent (an intro with its list, a list item with its
 * continuation lines, never into a fence or table), except one whose only fault
 * is a renumbered checker id, which is rewritten to the id the checker declares
 * now. The handbook is not touched: each changed file gets a proposal in
 * `.pancode/proposals` that `context init --accept <id>` writes.
 */
export function proposeHandbookVerification(
	verification: HandbookVerification,
	now = new Date(),
): HandbookVerificationProposal[] {
	const { root } = verification;
	const results: HandbookVerificationProposal[] = [];
	for (const file of verification.files) {
		const flagged = verification.entries
			.filter((entry) => entry.source.file === file && (entry.verdict === "stale" || entry.verdict === "contradicted"))
			.sort((a, b) => b.source.line - a.source.line);
		if (flagged.length === 0) continue;
		const path = join(root, file);
		const bytes = readFileSync(path);
		const lines = bytes.toString("utf8").split("\n");
		const hunks: string[] = [];
		for (const entry of flagged) {
			const start = entry.source.line - 1;
			const count = (entry.source.endLine ?? entry.source.line) - start;
			const before = lines.slice(start, start + count);
			const changes = entry.ruleIds ?? [];
			const after =
				changes.length === 0
					? []
					: before.map((text) =>
							changes.reduce((current, change) => current.replace(new RegExp(`\\b${change.from}\\b`, "g"), change.to), text),
						);
			lines.splice(start, count, ...after);
			hunks.unshift(
				[
					`@@ -${start + 1},${count} +${start + 1},${after.length} @@ ${entry.reason}`,
					...before.map((text) => `-${text}`),
					...after.map((text) => `+${text}`),
				].join("\n"),
			);
		}
		const proposalPath = writeProposalFile(root, now, lines.join("\n"), path, sha256Hex(bytes), { origin: "verify" });
		results.push({
			file,
			proposalPath,
			id: proposalId(proposalPath),
			diff: [`--- a/${file}`, `+++ b/${file}`, ...hunks].join("\n"),
		});
	}
	return results;
}
