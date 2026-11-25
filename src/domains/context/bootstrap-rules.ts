// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { relative } from "node:path";
import { sha256Hex } from "../../core/hash.js";
import type { AdoptionScanResult } from "./adoption.js";
import {
	CODE_TOKEN_RE,
	createModelGroundingCorpus,
	groundedModelBody,
	groundedModelLine,
	groundedToken,
	type ModelGroundingCorpus,
	staleCitationReason,
	withoutCiClauses,
	withoutCiStatements,
	withoutWorkflowCitations,
} from "./bootstrap-grounding.js";
import { handbookInstructionFiles, packageScripts } from "./bootstrap-project.js";
import type {
	BootstrapGenerateInput,
	BootstrapStructuredOutput,
	ExpectedSection,
	HandbookCompileReport,
	HandbookLedgerEntry,
} from "./bootstrap-types.js";
import { handbookBlocks, normalizeHandbookRule } from "./handbook-budget.js";
import { instructionUnits } from "./instruction-units.js";
import { HANDBOOK_TARGETS, type PancodeMdSection } from "./pancode-md.js";
import { contradictingFact, factClaims, treeFacts } from "./tree-facts.js";

const RULE_LANGUAGE_RE = /\b(?:never|must|forbidden|required|do not|don't|preserve|only|ask the user before)\b/i;
const MAX_UNVERIFIABLE_RULES = 6;

/**
 * Root handbooks are authored policy, but a sibling handbook may be stale or
 * wrong about this tree. Every unit is verified before it is adopted: one whose
 * citations all resolve is kept with its source line, one citing a path or
 * script the tree lacks is stale, one asserting a tree fact the tree states
 * otherwise is contradicted, and at most a few uncited rules survive, ranked by
 * how many sources state them.
 */
export function authoredProjectRules(
	input: BootstrapGenerateInput,
	output: BootstrapStructuredOutput,
	corpus: ModelGroundingCorpus,
	options: { verifiedOnly?: boolean } = {},
): PancodeMdSection[] {
	const normalize = normalizeHandbookRule;
	const generated = normalize(
		[...output.invariants, ...output.conventions, ...(output.sections ?? []).map((section) => section.body)].join("\n"),
	);
	const facts = treeFacts(input.cwd, input.enforcement?.ciCommands ?? []);
	const units: Array<{ line: string; file: string; at: number; operating: boolean; key: string; order: number }> = [];
	const sourcesByKey = new Map<string, Set<string>>();
	for (const file of handbookInstructionFiles(input)) {
		const source = relative(input.cwd, file.path).split("\\").join("/");
		// Global preferences remain separate; only project-wide handbooks become
		// unconditional project rules, and fenced examples supply no policy.
		if (source.startsWith("../")) continue;
		// Hard-wrapped handbooks emitted 30+ physical-line fragments; retain complete rules with their heading scope.
		for (const unit of instructionUnits(file.content, 600, source)) {
			const line = unit.text.replace(/^Project rules:\s*/i, "").trim();
			if (line.length === 0) continue;
			const key = normalize(line);
			const stating = sourcesByKey.get(key) ?? new Set<string>();
			stating.add(source);
			sourcesByKey.set(key, stating);
			units.push({
				line,
				file: unit.file,
				at: unit.line,
				operating: /\b(?:operating|development sessions|default scope|development checks)\b/i.test(unit.heading),
				key,
				order: units.length,
			});
		}
	}
	const ledger = input.handbookLedger;
	const record = (
		unit: (typeof units)[number],
		citations: string[],
		verdict: HandbookLedgerEntry["verdict"],
		reason: string,
		kept: boolean,
	): void => {
		ledger?.push({
			id: sha256Hex(`${unit.file}:${unit.at}:${unit.line}`).slice(0, 12),
			text: unit.line,
			origin: "adopted",
			source: { file: unit.file, line: unit.at },
			citations,
			verdict,
			reason,
			kept,
		});
	};
	const candidates: Array<{
		unit: (typeof units)[number];
		line: string;
		citations: string[];
		verified: boolean;
		emphasized: boolean;
	}> = [];
	const seen = new Set<string>();
	for (const unit of units) {
		const citations = [...unit.line.matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? "").filter(Boolean);
		const grounded = groundedModelBody(unit.line, corpus);
		if (citations.length > 0 && grounded.length === 0) {
			const unresolved = citations.filter((token) => !groundedToken(token, corpus));
			record(
				unit,
				citations,
				"stale",
				unresolved.length > 0
					? `does not resolve in this tree: ${unresolved.join(", ")}`
					: "its citations do not pass the citation rule",
				false,
			);
			continue;
		}
		const fact = contradictingFact(unit.line, facts);
		if (fact) {
			record(unit, citations, "contradicted", `${fact.source} states ${fact.key} ${fact.value}`, false);
			continue;
		}
		const verified = grounded.length > 0;
		const line = verified ? grounded.replace(/\s*\n\s*/g, " ") : unit.line;
		const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z])/).map(normalize);
		if (seen.has(unit.key)) {
			record(unit, citations, verified ? "verified" : "unverifiable", "an earlier unit states it", false);
			continue;
		}
		if (sentences.every((sentence) => generated.includes(sentence))) {
			seen.add(unit.key);
			record(unit, citations, verified ? "verified" : "unverifiable", "the draft already states it", true);
			continue;
		}
		seen.add(unit.key);
		// Fragment-heavy handbooks hid strong policy; prefer caps or bold rule language under the cap.
		const emphasized =
			/\b(?:NEVER|MUST|CRITICAL|IMPORTANT)\b/.test(line) ||
			[...line.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g)].some((match) =>
				/\b(?:never|must|critical|important)\b/i.test(match[1] ?? match[2] ?? ""),
			);
		candidates.push({ unit, line, citations, verified, emphasized });
	}
	// A rule nothing cites survives only as one of the few most-stated rules, and never against a kept rule.
	const keptClaims = candidates.filter((candidate) => candidate.verified).flatMap((c) => factClaims(c.line));
	const unverifiable = candidates
		.filter((candidate) => !candidate.verified)
		.sort(
			(a, b) =>
				(sourcesByKey.get(b.unit.key)?.size ?? 0) - (sourcesByKey.get(a.unit.key)?.size ?? 0) ||
				a.unit.order - b.unit.order,
		);
	const admitted = new Set<(typeof candidates)[number]>(candidates.filter((candidate) => candidate.verified));
	let uncited = 0;
	for (const candidate of unverifiable) {
		const against = factClaims(candidate.line).find((claim) =>
			keptClaims.some((kept) => kept.key === claim.key && kept.value !== claim.value),
		);
		if (against) {
			record(candidate.unit, candidate.citations, "contradicted", `a kept rule states another ${against.key}`, false);
			continue;
		}
		if (options.verifiedOnly || !RULE_LANGUAGE_RE.test(candidate.line) || uncited >= MAX_UNVERIFIABLE_RULES) {
			record(candidate.unit, candidate.citations, "unverifiable", "cites nothing the tree can check", false);
			continue;
		}
		uncited += 1;
		admitted.add(candidate);
	}
	// Bound both sections together so numerous authored rules cannot overwhelm the lean handbook.
	const retained: typeof candidates = [];
	let chars = 0;
	const rendered = (candidate: (typeof candidates)[number]): string =>
		`- ${candidate.line} (source: ${candidate.unit.file}:${candidate.unit.at})`;
	for (const candidate of [...admitted].sort(
		(a, b) => Number(b.emphasized) - Number(a.emphasized) || a.unit.order - b.unit.order,
	)) {
		const length = rendered(candidate).length + 1;
		const fits = retained.length < 16 && chars + length <= 5000;
		record(
			candidate.unit,
			candidate.citations,
			candidate.verified ? "verified" : "unverifiable",
			fits
				? candidate.verified
					? "every citation resolves"
					: "cites nothing, but sources state it and nothing contradicts it"
				: "over the authored-rule budget",
			fits,
		);
		if (!fits) continue;
		retained.push(candidate);
		chars += length;
	}
	const rules: string[] = [];
	const operating: string[] = [];
	// Priority decides survival, while source order keeps the retained rules readable in their original context.
	for (const candidate of retained.sort((a, b) => a.unit.order - b.unit.order))
		(candidate.unit.operating ? operating : rules).push(rendered(candidate));
	return [
		...(operating.length ? [{ title: "Operating instructions from project handbooks", body: operating.join("\n") }] : []),
		...(rules.length ? [{ title: "Authored project rules", body: rules.join("\n") }] : []),
	];
}

// Repeated boundary rules consumed both invariant and convention slots; compare stable citation and prose tokens.
// Citations keep a leading backtick so the two kinds stay apart.
export function handbookRuleTokens(rule: string): ReadonlySet<string> {
	return new Set(
		[
			...normalizeHandbookRule(rule)
				.toLowerCase()
				.matchAll(/`([^`\n]+)`|\b[a-z]{4,}\b/g),
		].map((match) => (match[1] !== undefined ? `\`${match[1]}` : match[0])),
	);
}

// A path below the root: a root document such as `CONTRIBUTING.md` is cited as the source of unrelated rules.
const CITED_FILE_RE = /^`[^`\s/]+\/[^`\s]/;

/** Most words match: two bullets that only cite the same files may state different obligations. */
/** Two rules that cite different checker ids (`rule3`, `rule9`) are different rules, however alike they read. */
export function sameRuleIds(a: string, b: string): boolean {
	const ids = (text: string): string => [...new Set(text.match(/\brule\d+\b/g) ?? [])].sort().join(",");
	const left = ids(a);
	const right = ids(b);
	return left === "" || right === "" || left === right;
}

/**
 * The kept rule this one rewords: most of its words match. With `citedFloor`, a lower share also counts when
 * both cite the same file below the root, as two wordings of one handbook rule usually do.
 */
export function rewordedRule<T extends ReadonlySet<string>>(
	tokens: ReadonlySet<string>,
	kept: ReadonlyArray<T>,
	citedFloor?: number,
): T | undefined {
	return kept.find((other) => {
		const shorter = tokens.size <= other.size ? tokens : other;
		const longer = tokens.size <= other.size ? other : tokens;
		if (shorter.size === 0) return false;
		const shared = [...shorter].filter((token) => longer.has(token));
		const share = shared.length / shorter.size;
		if (share >= 0.7) return true;
		return citedFloor !== undefined && share >= citedFloor && shared.some((token) => CITED_FILE_RE.test(token));
	});
}

/**
 * Two rules are one when most words match, or when they cite the same files
 * and names. A model that states a rule as an invariant and again as a change
 * recipe rewords it (PanCode's own settings rule shared 42% of its words with its
 * restatement) but cites the same `src/core/defaults.ts` symbols in both.
 */
export function restatesHandbookRule(tokens: ReadonlySet<string>, kept: ReadonlyArray<ReadonlySet<string>>): boolean {
	const citations = [...tokens].filter((token) => token.startsWith("`"));
	return kept.some((other) => {
		const shorter = tokens.size <= other.size ? tokens : other;
		const longer = tokens.size <= other.size ? other : tokens;
		if (shorter.size > 0 && [...shorter].filter((token) => longer.has(token)).length / shorter.size >= 0.7) return true;
		const otherCitations = [...other].filter((token) => token.startsWith("`"));
		const shared = citations.filter((token) => other.has(token));
		const fewest = Math.min(citations.length, otherCitations.length);
		return shared.length >= 2 && shared.some((token) => CITED_FILE_RE.test(token)) && shared.length / fewest >= 2 / 3;
	});
}

export const CHECKER_SECTION_TITLE = "Checker-enforced invariants";

interface CheckerRule {
	code: string;
	path: string;
	/** The rule as one or more whole sentences, its paths marked as code. */
	sentence: string;
	/** It constrains imports between path sets, so it is a hard invariant of the build. */
	architectural: boolean;
}

const IMPORT_RULE_RE = /\b(?:value-)?import(?:s|er|ers|ed|ing)?\b/i;
const RULE_PATH_RE = /@?[\w.*<>-]+(?:\/[\w.*<>-]*)+/g;
const RULE_CODE_TOKEN_RE =
	/(@?[\w.*<>-]+(?:\/[\w.*<>-]*)+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml)\b)/g;

/**
 * A path in a rule's prose names repository paths when it is a pattern, a
 * package scope, or exists here; `messages/ledger` in a sentence is prose.
 */
function rulePathToken(token: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): boolean {
	if (!token.includes("/")) return true;
	if (/[*<>]/.test(token) || token.startsWith("@")) return true;
	const path = token.replace(/\/$/, "");
	return files.has(path) || directories.has(path);
}

function markRuleCode(text: string, files: ReadonlySet<string>, directories: ReadonlySet<string>): string {
	return text.replace(RULE_CODE_TOKEN_RE, (match) => {
		const token = match.replace(/\.+$/, "");
		if (!rulePathToken(token, files, directories)) return match;
		return `\`${token}\`${match.slice(token.length)}`;
	});
}

/**
 * Every coded rule the project's checkers declare, as a whole sentence with
 * its subject. The failure message is the fallback only: it names the
 * offending file and interpolates the rule's subject away.
 */
export function checkerRuleList(input: BootstrapGenerateInput): CheckerRule[] {
	const files = new Set(input.repositoryFiles ?? []);
	const directories = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
	}
	const rules: CheckerRule[] = [];
	for (const file of input.enforcement?.checkFiles ?? []) {
		for (const rule of file.rules ?? []) {
			const text =
				rule.source === "failure" ? `A file that ${rule.text.replace(/^…\s*/, "").replace(/\(…\s*\)/g, "")}` : rule.text;
			const sentence = markRuleCode(text.replace(/[\s.;:,]+$/, ""), files, directories);
			const paths = [...rule.text.matchAll(RULE_PATH_RE)].length;
			rules.push({
				code: rule.code,
				path: file.path,
				sentence: `${sentence}. Checked as \`${rule.code}\` by \`${file.path}\`.`,
				architectural: IMPORT_RULE_RE.test(rule.text) && paths > 0,
			});
		}
	}
	const number = (code: string): number => Number(/\d+/.exec(code)?.[0] ?? 0);
	return rules.sort((a, b) => a.path.localeCompare(b.path) || number(a.code) - number(b.code));
}

/**
 * A rule that cites one checker id (`rule15`) is held against the checker's own rules. When another id's text
 * matches the rule clearly better, the id was renumbered since the rule was written and is rewritten; when no
 * checker rule matches and the id is absent, it is reported. A sentence the checker section derived is left as is.
 */
export function correctedRuleIds(
	line: string,
	rules: ReadonlyArray<CheckerRule>,
	report?: HandbookCompileReport,
): string {
	if (rules.length === 0) return line;
	const ids = [...new Set([...line.matchAll(/\brule\d+\b/g)].map((match) => match[0]))];
	const id = ids[0];
	if (ids.length !== 1 || id === undefined || rules.some((rule) => rule.sentence === line)) return line;
	const tokens = handbookRuleTokens(line.replaceAll(id, " "));
	const score = (rule: CheckerRule): number => {
		const own = handbookRuleTokens(rule.sentence.replace(/\s*Checked as `[^`]+` by `[^`]+`\.$/, ""));
		return own.size === 0 ? 0 : [...own].filter((token) => tokens.has(token)).length / own.size;
	};
	let best: { code: string; score: number } | undefined;
	let cited = -1;
	for (const rule of rules) {
		const value = score(rule);
		if (rule.code === id) cited = Math.max(cited, value);
		if (!best || value > best.score) best = { code: rule.code, score: value };
	}
	if (!best || best.score < 0.3) {
		if (cited < 0 && !report?.unknownRuleIds.includes(id)) report?.unknownRuleIds.push(id);
		return line;
	}
	// Rules of one checker share its vocabulary, so a renumbering must win clearly: on this repository's own
	// handbook a correct id scored 0.27 against 0.38 for a neighbour, and the renumbered owner rule 0.27 against 0.46.
	if (best.code === id || best.score < 0.4 || best.score - Math.max(cited, 0) < 0.15) return line;
	report?.ruleIds.push({ from: id, to: best.code });
	return line.replace(new RegExp(`\\b${id}\\b`, "g"), best.code);
}

/** Whether handbook prose names a rule code, alone (`rule8`) or in a list (`rules 10 and 14`). */
function namesRuleCode(code: string, text: string): boolean {
	const lower = text.toLowerCase();
	const exact = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(?:^|[^a-z0-9])${exact}(?![a-z0-9])`).test(lower)) return true;
	const parts = /^([a-z]+)(\d+[a-z]?)$/.exec(code.toLowerCase());
	if (!parts) return false;
	return new RegExp(`\\b${parts[1]}s\\s+(?:[\\w-]+\\s*(?:,|and|or|/|&)\\s*)*${parts[2]}(?![a-z0-9])`).test(lower);
}

/** Scripts npm runs on install, pack, publish and version without being asked. */
const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
	"preinstall",
	"install",
	"postinstall",
	"prepublish",
	"preprepare",
	"prepare",
	"postprepare",
	"prepublishOnly",
	"prepack",
	"postpack",
	"publish",
	"postpublish",
	"preversion",
	"version",
	"postversion",
	"dependencies",
]);

interface EnforcementNames {
	/** Lifecycle scripts package.json declares: cited only in backticks. */
	scripts: ReadonlySet<string>;
	/** Single-word failure codes (`lint`): cited in backticks, or named bare before "check" ("the prompts check"). */
	codes: ReadonlySet<string>;
	/** Codes with a hyphen or digit (`case-portable-paths`, `rule12`) and check functions, which prose names bare. */
	named: ReadonlyArray<string>;
}

/**
 * Every name under which the inventory shows a check failing a change: the
 * checks and coded failures check files define, and the lifecycle scripts npm
 * runs unasked. A check file's path is not one: a rule citing
 * `scripts/check-hygiene.ts` may name a check that file no longer defines.
 */
export function enforcementNames(input: BootstrapGenerateInput): EnforcementNames {
	const scripts = new Set(Object.keys(packageScripts(input.cwd)).filter((name) => LIFECYCLE_SCRIPTS.has(name)));
	const codes = new Set<string>();
	const named = new Set<string>();
	const addCode = (code: string): void => {
		if (/[-\d]/.test(code)) named.add(code);
		else codes.add(code);
	};
	for (const file of input.enforcement?.checkFiles ?? []) {
		for (const check of file.checks) named.add(check);
		for (const failure of file.failures) {
			const head = /^([\w.:/-]+): /.exec(failure)?.[1];
			for (const code of head?.split("/") ?? []) addCode(code);
		}
		for (const rule of file.rules ?? []) addCode(rule.code);
	}
	return { scripts, codes, named: [...named] };
}

/** A check function (`checkCasePortablePaths`) keyed as its failure code (`case-portable-paths`). */
function checkCode(name: string): string {
	return /^check[A-Z]/.test(name)
		? name
				.slice(5)
				.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
				.toLowerCase()
		: name.toLowerCase();
}

/** The enforcement a rule names, typed so a script and a code of one name stay apart: `script:prepublishOnly`, `code:case-portable-paths`. */
function namedEnforcement(rule: string, names: EnforcementNames): string[] {
	const found = new Set<string>();
	for (const match of rule.matchAll(/`([^`\n]+)`/g)) {
		const token = (match[1] ?? "").trim();
		const script = /^(?:pnpm|npm|yarn|bun)(?: run)? ([\w:.-]+)$/.exec(token)?.[1] ?? token;
		if (names.scripts.has(script)) found.add(`script:${script}`);
		if (names.codes.has(token)) found.add(`code:${token.toLowerCase()}`);
	}
	const lower = rule.toLowerCase();
	for (const code of names.codes) {
		const exact = code.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?<![\\w\`.:-])${exact}\\s+checks?\\b`).test(lower)) found.add(`code:${code.toLowerCase()}`);
	}
	for (const name of names.named) if (namesRuleCode(name, rule)) found.add(`code:${checkCode(name)}`);
	return [...found];
}

/**
 * The previous handbook's hard invariants, verbatim, while every path and
 * symbol each one cites still grounds. A rewrite drafts afresh, and small
 * models left check-enforced rules (case-colliding paths, retired HTML docs,
 * the gitignored-literal join, the throwing `prepublishOnly`) out of Hard
 * invariants, and reworded the published-tag rule only `CONTRIBUTING.md`
 * states. A rule whose citations no longer ground is not carried. A carried
 * rule keeps every word except a clause that names CI, which model text loses
 * too: a claim an older handbook made about CI otherwise survived every
 * rewrite. A sentence that cites a workflow file is cut whole.
 */
export function groundedPreviousInvariants(
	input: BootstrapGenerateInput,
	corpus: ModelGroundingCorpus,
): CarriedInvariant[] {
	const carried: CarriedInvariant[] = [];
	for (const invariant of input.previousInvariants ?? []) {
		const source = withoutWorkflowCitations(invariant.replace(/\s+/g, " ").trim());
		const rule = withoutCiClauses(source);
		if (!rule || carried.some((entry) => entry.rule === rule) || groundedModelLine(rule, corpus) === null) continue;
		carried.push({ rule, modelCopy: withoutCiStatements(source) });
	}
	return carried;
}

/**
 * A carried rule and each run of its leading clauses: a model that shortened
 * "Keep X: Y." to "Keep X." restated the carried rule and adds nothing to it.
 */
export function carriedRuleKeys(rule: string): string[] {
	const clauses = rule.split(/(?<=[.;:!?])\s+/);
	return clauses.map((_, index) => clauses.slice(0, index + 1).join(" "));
}

interface CarriedInvariant {
	rule: string;
	/** What grounding leaves of a model copy of the previous rule: its sentences that name CI are cut whole. */
	modelCopy: string;
}

/**
 * Sections of the replaced handbook, cut to the blocks that name a check the
 * repository still defines and whose citations still ground. A rewrite on mini
 * dropped Docs and prose, the section documentation workers receive, while its
 * documentation-links, product-namespace and prompts checks all still existed.
 * A block is grounded like model text, so its sentences that name CI are cut.
 */
export function enforcedPreviousSections(
	input: BootstrapGenerateInput,
	names: EnforcementNames,
	corpus: ModelGroundingCorpus,
): PancodeMdSection[] {
	const carried: PancodeMdSection[] = [];
	for (const section of input.previousSections ?? []) {
		if (section.title === CHECKER_SECTION_TITLE) continue;
		const blocks = handbookBlocks(section.body).flatMap((block) => {
			if (namedEnforcement(block, names).length === 0) return [];
			const grounded = groundedModelBody(block, corpus);
			return grounded && namedEnforcement(grounded, names).length > 0 ? [grounded] : [];
		});
		if (blocks.length > 0) carried.push({ title: section.title, body: blocks.join("\n") });
	}
	return carried;
}

/**
 * A model rule the checker already states: it names only codes the checker
 * declares in `stated`, or restates one of them in other words.
 */
export function restatesCheckerRule(
	rule: string,
	stated: ReadonlyArray<CheckerRule>,
	all: ReadonlyArray<CheckerRule>,
	statedTokens: ReadonlyArray<ReadonlySet<string>>,
): boolean {
	const named = all.filter((checker) => namesRuleCode(checker.code, rule));
	if (named.length > 0) return named.every((checker) => stated.includes(checker));
	return restatesHandbookRule(handbookRuleTokens(rule), statedTokens);
}

/**
 * The coded rules not stated above, listed so a checker rule is never silently
 * missing from the handbook. A rule the handbook names by code, or a kept rule
 * states word for word, is left out. Sharing its citations is not stating it:
 * a gotcha that `SURFACE_TOTAL_EXEMPTIONS` only shrinks cost rule14, that the
 * surfaces sum no token or cost field, its place here.
 */
export function uncoveredCheckerSection(
	rules: ReadonlyArray<CheckerRule>,
	handbook: string,
	keptKeys: ReadonlySet<string>,
): PancodeMdSection | null {
	const lines: string[] = [];
	let chars = 0;
	for (const rule of rules) {
		if (namesRuleCode(rule.code, handbook)) continue;
		if (keptKeys.has(normalizeHandbookRule(rule.sentence))) continue;
		const line = `- ${rule.sentence}`;
		if (chars + line.length + 1 > HANDBOOK_TARGETS.sectionChars - 200) break;
		lines.push(line);
		chars += line.length + 1;
	}
	if (lines.length === 0) return null;
	return {
		title: CHECKER_SECTION_TITLE,
		body: [
			"Rules the project's checks declare that the rules above do not state, each in its checker's words. A change that breaks one fails that check.",
			...lines,
		].join("\n"),
	};
}

/**
 * The sections a handbook must carry when the evidence supports them. A draft
 * from the same model on the same repository kept Change recipes in one run
 * and dropped the whole section in the next, and nothing said so.
 */
export function missingHandbookSections(
	input: Pick<BootstrapGenerateInput, "cwd" | "enforcement">,
	draft: Pick<BootstrapStructuredOutput, "sections">,
): ExpectedSection[] {
	const titles = (draft.sections ?? []).map((section) => section.title);
	const missing: ExpectedSection[] = [];
	const checks = (input.enforcement?.checkFiles ?? []).filter((file) => file.failures.length > 0);
	if (checks.length > 0 && !titles.some((title) => /recipe/i.test(title))) {
		missing.push({
			title: "Change recipes",
			reason: `${checks.map((file) => file.path).join(", ")} report failures a change can only fix by editing files together`,
		});
	}
	if (typeof packageScripts(input.cwd).test === "string" && !titles.some((title) => /\btests?\b/i.test(title))) {
		missing.push({ title: "Tests", reason: "package.json declares a test script" });
	}
	return missing;
}

/** At most this many adopted rules enter "Imported agent context", as before verification raised the scan caps. */
const MAX_RENDERED_IMPORTED_RULES = 20;

/**
 * The adopted rules `--adopt` writes under "Imported agent context": a rule
 * whose citations no longer resolve in the tree is left out, like a sibling
 * rule `context init` judges stale.
 */
export function verifiedImportedRules(
	input: Pick<BootstrapGenerateInput, "cwd" | "projectType" | "siblingFiles" | "adoption" | "codewiki">,
): AdoptionScanResult["importedRules"] {
	if (input.adoption.importedRules.length === 0) return [];
	const corpus = createModelGroundingCorpus(input);
	return input.adoption.importedRules
		.filter((rule) => staleCitationReason(rule.text, corpus) === null)
		.slice(0, MAX_RENDERED_IMPORTED_RULES);
}
