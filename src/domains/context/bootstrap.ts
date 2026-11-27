// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ContextOperationFact } from "../../core/context-operation.js";
import { gitVia } from "../../core/internal-git-run.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { sumFacts } from "../../core/telemetry/pricing.js";
import { createTomlFileReader } from "../../core/toml.js";
import { enumerateWorkspaceFilesAsync } from "../../core/workspace-files.js";
import { FULL_PROJECT_CONTEXT_MAX_CHARS, FULL_PROJECT_CONTEXT_MAX_LINES } from "../prompts/preload.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import {
	type AdoptionScanResult,
	adoptionSnapshotsHash,
	renderImportedAgentContext,
	restrictAdoptionScan,
	scanAgentConfigs,
} from "./adoption.js";
import { collectBootstrapEvidence } from "./bootstrap-evidence.js";
import { countStatusLines, gitStatus, uncommittedContextSources } from "./bootstrap-git.js";
import {
	CODE_TOKEN_RE,
	correctSymbolAttributions,
	createModelGroundingCorpus,
	GENERATION_EXCLUDED_FILES,
	groundedModelLine,
	groundedToken,
	sanitizeModelSection,
} from "./bootstrap-grounding.js";
import {
	handbookInstructionFiles,
	indexedSourceFileCount,
	inferConventions,
	loadBootstrapSiblingFiles,
	measureProjectPreload,
	projectName,
	pushUnique,
	resolveDefaultIdentity,
	stabilizedIdentity,
	tsconfigConvention,
	VERIFICATION_SECTION_RE,
	verificationSection,
} from "./bootstrap-project.js";
import { dropVerifyVerdicts, hashExistingFile, writeHandbookLedger, writeProposalFile } from "./bootstrap-proposals.js";
import {
	authoredProjectRules,
	CHECKER_SECTION_TITLE,
	carriedRuleKeys,
	checkerRuleList,
	correctedRuleIds,
	enforcedPreviousSections,
	enforcementNames,
	groundedPreviousInvariants,
	handbookRuleTokens,
	missingHandbookSections,
	restatesCheckerRule,
	restatesHandbookRule,
	rewordedRule,
	sameRuleIds,
	uncoveredCheckerSection,
	verifiedImportedRules,
} from "./bootstrap-rules.js";
import { buildAbsorbReport, formatBootstrapSummary, summarizeAdoption } from "./bootstrap-summary.js";
import type {
	AbsorbReport,
	BootstrapFallbackResult,
	BootstrapGenerate,
	BootstrapGenerateInput,
	BootstrapGenerationSink,
	BootstrapGenerationTelemetry,
	BootstrapIo,
	BootstrapProgressEvent,
	BootstrapRunTelemetry,
	BootstrapStructuredOutput,
	HandbookCompileReport,
	HandbookLedgerEntry,
	RunBootstrapInput,
	RunBootstrapResult,
	RunBootstrapSummary,
} from "./bootstrap-types.js";
import {
	buildCodewikiCandidate,
	coordinateCodewikiExclusive,
	coordinateCodewikiWrite,
} from "./codewiki/coordinator.js";
import type { Codewiki } from "./codewiki/schema.js";
import { collectEnforcementInventory, type EnforcementInventory } from "./enforcement-inventory.js";
import type { Fingerprint } from "./fingerprint.js";
import {
	fitGeneratedHandbook,
	handbookBlocks,
	normalizeHandbookRule,
	orderSectionsForWorkers,
	type ProtectedHandbook,
	placeWorkerSections,
} from "./handbook-budget.js";
import { ContextOperationAbortError } from "./operation-result.js";
import {
	HANDBOOK_TARGETS,
	type PancodeMdSection,
	type ParsedPancodeMd,
	parsePancodeMd,
	serializePancodeMd,
	tryReadPancodeMd,
} from "./pancode-md.js";
import { indexProgressSink } from "./progress.js";
import {
	type BootstrapGenerationState,
	readPancodeState,
	statePath as resolveStatePath,
	writePancodeState,
} from "./state.js";

function out(io: BootstrapIo | undefined, message: string): void {
	io?.stdout(message);
}

function warn(io: BootstrapIo | undefined, message: string): void {
	io?.stderr(message);
}

function progress(input: RunBootstrapInput, event: BootstrapProgressEvent): void {
	input.onProgress?.(event);
}

export { type PackageManager, packageManager } from "./package-manager.js";

function stabilizeGeneratedOutput(
	input: BootstrapGenerateInput,
	base: BootstrapStructuredOutput,
	onModelSectionRetained?: () => void,
	groundModelOutput = false,
	onProtected?: (content: ProtectedHandbook) => void,
	report?: HandbookCompileReport,
): BootstrapStructuredOutput {
	const tomlFiles = input.tomlFiles ?? createTomlFileReader(input.cwd);
	const existing = input.existingPancodeMd;
	const groundingCorpus = groundModelOutput ? createModelGroundingCorpus(input) : null;
	// Human-authored rules first, then the model's grounded rules, then the
	// sibling-file heuristics, so a generated rule never displaces an authored one.
	const conventions: string[] = [];
	for (const convention of existing?.conventions ?? []) pushUnique(conventions, convention);
	for (const convention of base.conventions ?? []) {
		const grounded = groundedModelLine(convention, groundingCorpus);
		if (grounded) {
			pushUnique(conventions, grounded);
			if (groundModelOutput) onModelSectionRetained?.();
		}
	}
	for (const convention of conventions.length === 0
		? inferConventions(input.cwd, handbookInstructionFiles(input), input.codewiki)
		: []) {
		pushUnique(conventions, convention);
	}
	const invariants: string[] = [];
	for (const invariant of existing?.invariants ?? []) pushUnique(invariants, invariant);
	for (const invariant of base.invariants ?? []) {
		const grounded = groundedModelLine(invariant, groundingCorpus);
		if (grounded) {
			pushUnique(invariants, grounded);
			if (groundModelOutput) onModelSectionRetained?.();
		}
	}
	// A checker rule that constrains imports between path sets is a hard
	// invariant: it leads, in the checker's own declaration, and a model rule
	// that only restates one gives way to it.
	const checkerRules = checkerRuleList(input);
	const architectural = checkerRules.filter((rule) => rule.architectural);
	const architecturalTokens = architectural.map((rule) => handbookRuleTokens(rule.sentence));
	const restatesArchitecture = (rule: string): boolean =>
		architectural.length > 0 && restatesCheckerRule(rule, architectural, checkerRules, architecturalTokens);
	const names = enforcementNames(input);
	const carryCorpus =
		(input.previousInvariants?.length ?? 0) > 0 || (input.previousSections?.length ?? 0) > 0
			? (groundingCorpus ?? createModelGroundingCorpus(input))
			: null;
	const carriedInvariants = carryCorpus
		? groundedPreviousInvariants(input, carryCorpus).filter((entry) => !restatesArchitecture(entry.rule))
		: [];
	const carried = carriedInvariants.map((entry) => entry.rule);
	const carriedBlocks = carryCorpus ? enforcedPreviousSections(input, names, carryCorpus) : [];
	// A model rule gives way to carried content only when it states it, or its leading clauses, word for word.
	// One that resembles a carried rule may add a clause, flip a prohibition or change its scope, so both stay.
	// A model copy of a carried invariant loses its CI sentences, so what remains of it counts as the carried rule too.
	const carriedKeys = new Set(
		[
			...carriedInvariants.flatMap((entry) => [...carriedRuleKeys(entry.rule), entry.modelCopy]),
			...carriedBlocks.flatMap((section) => handbookBlocks(section.body)).flatMap(carriedRuleKeys),
		]
			.filter((rule) => rule.length > 0)
			.map(normalizeHandbookRule),
	);
	const duplicatesCarried = (rule: string): boolean => carriedKeys.has(normalizeHandbookRule(rule));
	// Checker import rules, carried rules and authored rules lead and are never cut: a model rule gives way to
	// them, and the cap applies to model rules alone. When they exceed the target on their own they all stay,
	// and the handbook parser warns that hard invariants exceed it.
	const authoredInvariants = existing?.invariants ?? [];
	const protectedInvariants: string[] = [];
	for (const rule of architectural) {
		if (!authoredInvariants.includes(rule.sentence)) pushUnique(protectedInvariants, rule.sentence);
	}
	// Carried and authored rules lead and are not cut for length, but one that rewords an earlier one is the
	// same rule twice: the first wording stays and the pair is reported.
	const protectedWording = new Map<ReadonlySet<string>, string>();
	const rewordingOf = (rule: string): string | undefined => {
		const candidates = [...protectedWording].filter(([, kept]) => sameRuleIds(rule, kept)).map(([tokens]) => tokens);
		const match = rewordedRule(handbookRuleTokens(rule), candidates, 0.55);
		return match ? protectedWording.get(match) : undefined;
	};
	const pushProtected = (rule: string): void => {
		if (protectedInvariants.includes(rule)) return;
		const kept = rewordingOf(rule);
		if (kept !== undefined) {
			report?.merged.push({ kept, dropped: rule });
			return;
		}
		protectedWording.set(handbookRuleTokens(rule), rule);
		protectedInvariants.push(rule);
	};
	for (const rule of carried) if (!authoredInvariants.includes(rule)) pushProtected(rule);
	for (const rule of authoredInvariants) pushProtected(rule);
	// A previous section block counts as stated only by a rule the final fit cannot cut, word for word.
	const protectedKeys = new Set(protectedInvariants.map(normalizeHandbookRule));
	// A model rule that only resembles a carried one may flip it or add a clause, so it stays (see above).
	const modelInvariants = invariants.filter(
		(rule) =>
			!authoredInvariants.includes(rule) &&
			!protectedInvariants.includes(rule) &&
			!restatesArchitecture(rule) &&
			!duplicatesCarried(rule),
	);
	// A worker receives the invariants ahead of every other rule, so model rules end at the count, and one
	// that would pass the total length is skipped for a shorter one, leaving room for the Tests and Gotchas rules.
	const retainedInvariants = [...protectedInvariants];
	let invariantChars = retainedInvariants.reduce((sum, rule) => sum + rule.length, 0);
	for (const rule of modelInvariants) {
		if (retainedInvariants.length >= HANDBOOK_TARGETS.invariants) break;
		if (invariantChars + rule.length > HANDBOOK_TARGETS.invariantsTotalChars) continue;
		retainedInvariants.push(rule);
		invariantChars += rule.length;
	}
	const uncarriedInvariantTokens = retainedInvariants.filter((rule) => !carried.includes(rule)).map(handbookRuleTokens);
	const typescriptConvention = tsconfigConvention(
		input.cwd,
		[...retainedInvariants, ...conventions, ...(base.sections ?? []).map((section) => section.body)].join("\n"),
	);
	// Invariants win over conventions, then both win over section bullets so boundary rules appear once.
	const retainedConventions = [
		...(typescriptConvention ? [typescriptConvention] : []),
		...conventions
			.filter(
				(rule) =>
					!restatesHandbookRule(handbookRuleTokens(rule), uncarriedInvariantTokens) &&
					!duplicatesCarried(rule) &&
					!restatesArchitecture(rule),
			)
			.slice(0, HANDBOOK_TARGETS.conventions - (typescriptConvention ? 1 : 0)),
	];
	const uncarriedRuleTokens = [...uncarriedInvariantTokens, ...retainedConventions.map(handbookRuleTokens)];

	const verification = verificationSection(input.cwd, tomlFiles);
	const inferredSections = inferHeuristicSections(input);
	const existingSections = existing?.sections ?? [];
	const ordinarySections: PancodeMdSection[] = [];
	const modelSections = new Set<PancodeMdSection>();
	const seenSectionTitles = new Set<string>();
	const addSection = (section: PancodeMdSection, modelSection = false, carriedSection = false): boolean => {
		if (VERIFICATION_SECTION_RE.test(section.title)) return false;
		const restatesKept = (block: string): boolean =>
			carriedSection
				? protectedKeys.has(normalizeHandbookRule(block))
				: restatesHandbookRule(handbookRuleTokens(block), uncarriedRuleTokens) || duplicatesCarried(block);
		// A bullet that rewords an earlier bullet of the same section is dropped; the first wording stays.
		const keptHere = new Map<ReadonlySet<string>, string>();
		const body = handbookBlocks(section.body)
			.filter((block) => {
				if (!/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(block)) return true;
				if (restatesKept(block) || restatesArchitecture(block)) return false;
				if (!carriedSection) {
					// Plurals fold to one word here so "links" and "link" match between two bullets of one section.
					const tokens = new Set(
						[...handbookRuleTokens(block)].map((token) => (token.startsWith("`") ? token : token.replace(/s$/, ""))),
					);
					const match = rewordedRule(
						tokens,
						[...keptHere].filter(([, kept]) => sameRuleIds(block, kept)).map(([keys]) => keys),
						0.55,
					);
					if (match) {
						report?.merged.push({ kept: keptHere.get(match) ?? "", dropped: block });
						return false;
					}
					keptHere.set(tokens, block);
				}
				return true;
			})
			.join("\n");
		if (!body.trim()) return false;
		const titleKey = section.title.replace(/\s+/g, " ").trim().toLowerCase();
		if (seenSectionTitles.has(titleKey)) return false;
		seenSectionTitles.add(titleKey);
		const retained = body === section.body ? section : { ...section, body };
		ordinarySections.push(retained);
		if (modelSection) modelSections.add(retained);
		return true;
	};
	const authoredRules = authoredProjectRules(input, base, groundingCorpus ?? createModelGroundingCorpus(input));
	for (const section of authoredRules) addSection(section);
	// Authored sections, then the model's grounded sections, then heuristics:
	// the model reads the repository, the heuristics only read its metadata.
	// The checker section is derived on every run; a stale copy from the previous handbook is not authored.
	for (const section of existingSections) if (section.title !== CHECKER_SECTION_TITLE) addSection(section);
	for (const section of base.sections ?? []) {
		const sanitized = groundingCorpus ? sanitizeModelSection(section, groundingCorpus) : section;
		if (sanitized) addSection(sanitized, true);
	}
	// A previous section returns under its title when the draft dropped the title. Under a kept title, its
	// enforced blocks lead, verbatim, and the model's blocks follow unless one states a carried block word for
	// word: naming the same check is not stating the same instruction. A block a protected rule or an earlier
	// carried block states word for word is not repeated. Only the carried blocks are protected, so neither the
	// section limit nor the final fit cuts them, while the model's additions fit like any other content.
	const carriedSections = new Map<PancodeMdSection, string[]>();
	const carriedSeen = new Set(protectedKeys);
	for (const section of carriedBlocks) {
		const blocks = handbookBlocks(section.body).filter((block) => {
			const blockKey = normalizeHandbookRule(block);
			if (carriedSeen.has(blockKey)) return false;
			carriedSeen.add(blockKey);
			return true;
		});
		if (blocks.length === 0) continue;
		const key = section.title.replace(/\s+/g, " ").trim().toLowerCase();
		const index = ordinarySections.findIndex((kept) => kept.title.replace(/\s+/g, " ").trim().toLowerCase() === key);
		const current = ordinarySections[index];
		if (!current) {
			const retained = addSection({ title: section.title, body: blocks.join("\n") }, false, true)
				? ordinarySections.at(-1)
				: undefined;
			if (retained) carriedSections.set(retained, handbookBlocks(retained.body));
			continue;
		}
		const blockKeys = new Set(blocks.map(normalizeHandbookRule));
		const additions = handbookBlocks(current.body).filter((block) => !blockKeys.has(normalizeHandbookRule(block)));
		const merged = { ...current, body: [...blocks, ...additions].join("\n") };
		ordinarySections[index] = merged;
		if (modelSections.delete(current)) modelSections.add(merged);
		carriedSections.set(merged, blocks);
	}
	const keptRules = [
		...retainedInvariants,
		...retainedConventions,
		...ordinarySections.flatMap((section) => handbookBlocks(section.body)),
	];
	const checkerSection = uncoveredCheckerSection(
		checkerRules.filter((rule) => !rule.architectural),
		keptRules.join("\n"),
		new Set(keptRules.map(normalizeHandbookRule)),
	);
	if (checkerSection) addSection(checkerSection);
	for (const section of inferredSections) addSection(section);
	const ordinaryLimit = verification ? HANDBOOK_TARGETS.sections - 1 : HANDBOOK_TARGETS.sections;
	let room = ordinaryLimit - carriedSections.size;
	const retainedOrdinarySections = ordinarySections.filter((section) => carriedSections.has(section) || room-- > 0);
	for (const section of retainedOrdinarySections) {
		if (modelSections.has(section)) onModelSectionRetained?.();
	}
	// A section the operator wrote, kept from the handbook or carried from the replaced one, keeps its place
	// and its scope; generated sections are ordered for workers in the places left between them.
	const authoredTitles = new Set(
		[...existingSections, ...carriedBlocks].map((section) => section.title.replace(/\s+/g, " ").trim().toLowerCase()),
	);
	const authoredSection = (section: PancodeMdSection): boolean =>
		authoredTitles.has(section.title.replace(/\s+/g, " ").trim().toLowerCase());
	const authoredSections = retainedOrdinarySections.filter(authoredSection);
	const generatedInOrder = orderSectionsForWorkers(
		retainedOrdinarySections.filter((section) => !authoredSection(section)),
	);
	onProtected?.({
		invariants: protectedInvariants,
		sections: [...carriedSections].map(([section, blocks]) => ({ title: section.title, body: blocks.join("\n") })),
		authoredTitles: authoredSections.map((section) => section.title),
	});
	const fixIds = (line: string): string => correctedRuleIds(line, checkerRules, report);
	return {
		...base,
		projectName: existing?.projectName ?? projectName(input.cwd, tomlFiles),
		identity: existing?.identity ?? stabilizedIdentity(input, base.identity, tomlFiles),
		conventions: retainedConventions.map(fixIds),
		invariants: retainedInvariants.map(fixIds),
		sections: [
			...retainedOrdinarySections
				.map((section) => (authoredSection(section) ? section : (generatedInOrder.shift() ?? section)))
				.map((section) => {
					const body = handbookBlocks(section.body).map(fixIds).join("\n");
					return body === section.body ? section : { ...section, body };
				}),
			...(verification ? [verification] : []),
		],
	};
}

function inferHeuristicSections(input: BootstrapGenerateInput): PancodeMdSection[] {
	// No entry-point or layout section: a repository tour costs every session
	// tokens and does not shorten the path to the right file. The session prompt
	// already routes navigation through `code_nav`.
	const sections: PancodeMdSection[] = [];
	if (input.adoption.sources.length > 0) {
		const sourceNames = input.adoption.sources
			.map((source) => `\`${source.displayPath}\``)
			.slice(0, 8)
			.join(", ");
		sections.push({
			title: "Agent context interop",
			body: [
				`Bootstrap scanned ${input.adoption.sources.length} sibling context source${input.adoption.sources.length === 1 ? "" : "s"}: ${sourceNames}${input.adoption.sources.length > 8 ? ", ..." : ""}.`,
				"Run `pancode context init --adopt` to refresh the managed provenance section when those sources change.",
			].join(" "),
		});
	}
	return sections.slice(0, 6);
}

/**
 * Deterministic PANCODE.md generator. Distills identity, conventions, and invariants
 * from sibling agent-context files and package metadata without a model. Used as
 * the offline path and as the fallback when model-driven generation is
 * unavailable or fails.
 */
function heuristicBootstrapOutputSync(input: BootstrapGenerateInput): BootstrapStructuredOutput {
	const tomlFiles = input.tomlFiles ?? createTomlFileReader(input.cwd);
	const sharedInput = input.tomlFiles ? input : { ...input, tomlFiles };
	return stabilizeGeneratedOutput(sharedInput, {
		projectName: projectName(input.cwd, tomlFiles),
		identity: resolveDefaultIdentity(input.cwd, input.projectType, handbookInstructionFiles(input), tomlFiles).text,
		conventions: inferConventions(input.cwd, handbookInstructionFiles(input), input.codewiki),
		invariants: [],
		sections: inferHeuristicSections(input),
	});
}

export const heuristicBootstrapOutput: BootstrapGenerate = heuristicBootstrapOutputSync;

function bootstrapOutputFromParsed(parsed: ParsedPancodeMd): BootstrapStructuredOutput {
	const out: BootstrapStructuredOutput = {
		projectName: parsed.projectName,
		identity: parsed.identity,
		conventions: [...parsed.conventions],
		invariants: [...parsed.invariants],
	};
	if (parsed.sections.length > 0) {
		out.sections = parsed.sections.map((section) => ({ title: section.title, body: section.body }));
	}
	if (parsed.importedAgentContext) out.importedAgentContext = parsed.importedAgentContext;
	if (parsed.conventionsOverride) out.conventionsOverride = parsed.conventionsOverride;
	if (parsed.sectionsBeforeConventions) out.sectionsBeforeConventions = parsed.sectionsBeforeConventions;
	return out;
}

function existingPancodeMdBootstrapOutput(cwd: string): BootstrapStructuredOutput | null {
	const parsed = tryReadPancodeMd(cwd);
	if (!parsed?.ok || !parsed.value) return null;
	return bootstrapOutputFromParsed(parsed.value);
}

export function fallbackBootstrapOutput(input: BootstrapGenerateInput): BootstrapFallbackResult {
	const existing = input.existingPancodeMd
		? bootstrapOutputFromParsed(input.existingPancodeMd)
		: existingPancodeMdBootstrapOutput(input.cwd);
	if (existing) return { mode: "existing", output: existing };
	return { mode: "heuristic", output: heuristicBootstrapOutputSync(input) };
}

function readExistingPancodeMdText(cwd: string): string | null {
	try {
		return readFileSync(join(cwd, "PANCODE.md"), "utf8");
	} catch {
		return null;
	}
}

function replaceImportedAgentContext(
	output: BootstrapStructuredOutput,
	importedAgentContext: string,
): BootstrapStructuredOutput {
	const { importedAgentContext: _old, ...rest } = output;
	if (importedAgentContext.length === 0) return rest;
	return { ...rest, importedAgentContext };
}

function serializeBootstrapOutput(output: BootstrapStructuredOutput): string {
	const serialized = serializePancodeMd({ ...output, fingerprint: null });
	const parsed = parsePancodeMd(serialized);
	if (!parsed.ok) throw new Error(`bootstrap produced invalid PANCODE.md: ${parsed.errors.join("; ")}`);
	return serialized;
}

function writePancodeMdFile(cwd: string, output: BootstrapStructuredOutput): string {
	const pancodeMdPath = join(cwd, "PANCODE.md");
	mkdirSync(dirname(pancodeMdPath), { recursive: true });
	const serialized = serializeBootstrapOutput(output);
	safeResourceWrite(pancodeMdPath, serialized);
	return pancodeMdPath;
}

function writePancodeMdProposal(
	cwd: string,
	now: Date,
	output: BootstrapStructuredOutput,
	generation: BootstrapGenerationTelemetry,
	sourceHash: string | null,
	absorb: AbsorbReport | undefined,
): string {
	return writeProposalFile(cwd, now, serializeBootstrapOutput(output), join(cwd, "PANCODE.md"), sourceHash, {
		generation: durableGenerationTelemetry(generation),
		...(absorb ? { absorb } : {}),
	});
}

function boundedStateString(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined) return undefined;
	const bounded = value.replace(/\s+/g, " ").trim().slice(0, maxChars);
	return bounded.length > 0 ? bounded : undefined;
}

function safeStateCounter(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function durableGenerationTelemetry(telemetry: BootstrapGenerationTelemetry): BootstrapGenerationState {
	const state: BootstrapGenerationState = {
		mode: telemetry.mode,
		parserOutcome: telemetry.parserOutcome,
		...(telemetry.repairRan !== undefined ? { repairRan: telemetry.repairRan } : {}),
		...(telemetry.repairProducedHandbook !== undefined
			? { repairProducedHandbook: telemetry.repairProducedHandbook }
			: {}),
	};
	const fallbackReason = boundedStateString(telemetry.fallbackReason, 500);
	if (fallbackReason) state.fallbackReason = fallbackReason;
	// The generation's own span, kept even when no dispatch ran; one dispatch's
	// receipt is not the span of several.
	const durationMs = safeStateCounter(telemetry.durationMs);
	if (durationMs !== undefined) state.durationMs = durationMs;
	const run = telemetry.run;
	if (!run) return state;
	state.structuredOutputMode = run.structuredOutputMode;
	for (const [key, value] of [
		["runId", run.runId],
		["targetId", run.targetId],
		["wireModelId", run.wireModelId],
		["runtimeId", run.runtimeId],
		["runtimeKind", run.runtimeKind],
		["thinkingLevel", run.thinkingLevel],
	] as const) {
		const bounded = boundedStateString(value, 512);
		if (bounded) state[key] = bounded;
	}
	// A dispatch without a run id never started a worker and spent nothing.
	const runs = (telemetry.runs ?? [run]).filter((entry) => entry === run || entry.runId !== undefined);
	const measuredTotal = (entries: ReadonlyArray<BootstrapRunTelemetry>): number | undefined => {
		const sum = sumFacts(entries.flatMap((entry) => (entry.spend ? [entry.spend.totalTokens] : [])));
		return sum.coverage.measured === entries.length ? sum.measured : undefined;
	};
	const across = (field: (entry: BootstrapRunTelemetry) => number | undefined): number | undefined => {
		let total = 0;
		for (const entry of runs) {
			const value = field(entry);
			if (value === undefined) return undefined;
			total += value;
		}
		return total;
	};
	for (const [key, value] of [
		// The project state keeps a plain count, so a total is recorded only when every dispatch measured its own (#434).
		["tokenCount", measuredTotal(runs)],
		["toolCalls", across((entry) => entry.toolCalls)],
		["promptBytes", across((entry) => entry.promptBytes)],
		["outputBytes", across((entry) => entry.outputBytes)],
	] as const) {
		const counter = safeStateCounter(value);
		if (counter !== undefined) state[key] = counter;
	}
	return state;
}

function writeProjectState(
	cwd: string,
	projectType: ProjectType,
	now: Date,
	indexedAt: string,
	adoption: AdoptionScanResult,
	recordAdoption: boolean,
	codewikiVersion: number,
	fingerprint: Fingerprint,
	generation: BootstrapGenerationTelemetry,
	published: boolean,
): string {
	const statePath = resolveStatePath(cwd);
	const prev = readPancodeState(cwd);
	// lastBootstrap describes how the PANCODE.md on disk was produced, not what the
	// most recent run happened to do. Proposals retain their own generation record.
	const lastBootstrap = published ? durableGenerationTelemetry(generation) : prev?.lastBootstrap;
	const contextSources = recordAdoption ? adoption.sourceSnapshots : prev?.contextSources;
	const contextSourceHash = contextSources ? adoptionSnapshotsHash(contextSources) : undefined;
	writePancodeState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? projectType,
		fingerprint: prev?.fingerprint ?? fingerprint,
		codewikiVersion: prev?.codewikiVersion ?? codewikiVersion,
		...(published
			? { bootstrapFingerprint: fingerprint }
			: prev?.bootstrapFingerprint
				? { bootstrapFingerprint: prev.bootstrapFingerprint }
				: {}),
		lastInitAt: now.toISOString(),
		lastSessionAt: now.toISOString(),
		lastIndexedAt: prev?.lastIndexedAt ?? indexedAt,
		...(lastBootstrap ? { lastBootstrap } : {}),
		...(contextSources ? { contextSources } : {}),
		...(contextSourceHash ? { contextSourceHash } : {}),
	});
	return statePath;
}

/**
 * Publish the deterministic index before Scout runs so a worker-side code_nav
 * call reuses this build instead of demand-building the same repository again.
 * This is an index checkpoint, not a completed init: lastInitAt remains unchanged
 * until PANCODE.md handling succeeds below.
 */
function persistCodewikiForGeneration(
	cwd: string,
	projectType: ProjectType,
	indexedAt: string,
	codewiki: Codewiki,
	fingerprint: Fingerprint,
): void {
	const prev = readPancodeState(cwd);
	writePancodeState(
		cwd,
		{
			version: 1,
			projectType,
			fingerprint,
			codewikiVersion: codewiki.version,
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
			...(prev?.bootstrapFingerprint ? { bootstrapFingerprint: prev.bootstrapFingerprint } : {}),
			lastSessionAt: prev?.lastSessionAt ?? indexedAt,
			lastIndexedAt: indexedAt,
		},
		codewiki,
	);
}

export async function runBootstrap(input: RunBootstrapInput = {}): Promise<RunBootstrapResult> {
	const committed: ContextOperationFact[] = [];
	try {
		return await runBootstrapWork(input, committed);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError")
			throw new ContextOperationAbortError(error.message, committed);
		throw error;
	}
}

async function runBootstrapWork(
	input: RunBootstrapInput,
	committed: ContextOperationFact[],
): Promise<RunBootstrapResult> {
	input.signal?.throwIfAborted();
	const cwd = input.cwd ?? process.cwd();
	const tomlFiles = createTomlFileReader(cwd);
	const projectType = detectProjectType(cwd);
	progress(input, {
		phase: "scan",
		status: "started",
		message: "scanning project and sibling agent context",
		detail: projectType,
	});
	const scanned = scanAgentConfigs({
		cwd,
		...(input.homeDir ? { homeDir: input.homeDir } : {}),
		includeGlobal: input.includeGlobalImports === true,
	});
	const withheld = new Set(uncommittedContextSources(cwd, scanned));
	const adoption = withheld.size > 0 ? restrictAdoptionScan(scanned, (path) => !withheld.has(path)) : scanned;
	if (withheld.size > 0) {
		out(
			input.io,
			`  left out ${withheld.size} context source${withheld.size === 1 ? "" : "s"} Git does not track, because PANCODE.md is not ignored and would publish them: ${[
				...withheld,
			]
				.map((path) => relative(cwd, path).split("\\").join("/"))
				.slice(0, 6)
				.join(", ")}${withheld.size > 6 ? ", ..." : ""}\n`,
		);
	}
	const siblingFiles = loadBootstrapSiblingFiles(adoption);
	progress(input, {
		phase: "scan",
		status: "completed",
		message:
			siblingFiles.length === 0
				? "no sibling context files found"
				: `folded ${siblingFiles.length} sibling context file${siblingFiles.length === 1 ? "" : "s"}`,
		current: siblingFiles.length,
		total: siblingFiles.length,
	});
	const now = input.now?.() ?? new Date();
	const indexedAt = now.toISOString();
	// Index the repository before generation so the generator can ground PANCODE.md
	// in the real structure (entry points, key modules), not just sibling prose.
	progress(input, { phase: "codewiki", status: "started", message: "reconciling codemap index" });
	let codewiki: Codewiki;
	let codewikiFingerprint: Fingerprint;
	if (input.preview === true) {
		const candidate = await buildCodewikiCandidate(cwd, projectType, indexProgressSink(input.onProgress), input.signal);
		codewiki = candidate.codewiki;
		codewikiFingerprint = candidate.fingerprint;
	} else {
		const coordinated = await coordinateCodewikiWrite(
			cwd,
			(current) => ({
				kind: "ensure",
				cwd,
				language: projectType,
				current,
				previous: readPancodeState(cwd)?.fingerprint ?? null,
			}),
			{
				onProgress: indexProgressSink(input.onProgress),
				...(input.signal ? { signal: input.signal } : {}),
				afterCommit: ({ codewiki: indexed, fingerprint }, workspace) => {
					persistCodewikiForGeneration(workspace, projectType, indexedAt, indexed, fingerprint);
					committed.push({ kind: "indexed", unit: "source-files", count: indexedSourceFileCount(indexed) });
				},
			},
		);
		if (!coordinated) throw new Error("codewiki bootstrap transaction did not commit");
		codewiki = coordinated.codewiki;
		codewikiFingerprint = coordinated.worker.fingerprint;
	}
	const codewikiEntryCount = indexedSourceFileCount(codewiki);
	progress(input, {
		phase: "codewiki",
		status: "completed",
		message: `indexed ${codewikiEntryCount} source file${codewikiEntryCount === 1 ? "" : "s"}`,
		current: codewikiEntryCount,
		total: codewikiEntryCount,
	});
	input.signal?.throwIfAborted();
	const hadPancodeMd = existsSync(join(cwd, "PANCODE.md"));
	const originalPancodeMdText = readExistingPancodeMdText(cwd);
	let originalPancodeMdHash: string | null;
	try {
		originalPancodeMdHash = hashExistingFile(join(cwd, "PANCODE.md"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
		throw new Error(
			`PANCODE.md exists but cannot be read (${code}); make it a readable file or move it aside, then run context init again.`,
		);
	}
	const useExistingPancodeMdAsSource = hadPancodeMd && input.rewritePancodeMd !== true;
	const existingPancodeMdText = useExistingPancodeMdAsSource ? originalPancodeMdText : null;
	const existingPancodeMd = useExistingPancodeMdAsSource ? tryReadPancodeMd(cwd) : null;
	const existingParsed = existingPancodeMd?.ok ? existingPancodeMd.value : undefined;
	const replaced = hadPancodeMd && input.rewritePancodeMd === true ? tryReadPancodeMd(cwd) : null;
	const previousInvariants = replaced?.ok && replaced.value ? replaced.value.invariants : [];
	const previousSections = replaced?.ok && replaced.value ? replaced.value.sections : [];
	const replacePancodeMd = input.applyPancodeMd === true || input.rewritePancodeMd === true;
	if (
		input.adopt === true &&
		input.preview !== true &&
		hadPancodeMd &&
		!existingParsed &&
		!replacePancodeMd &&
		input.proposePancodeMd !== true
	) {
		const detail = existingPancodeMd && !existingPancodeMd.ok ? ` (${existingPancodeMd.error})` : "";
		throw new Error(
			`cannot refresh Imported agent context because PANCODE.md has no structured projection${detail}; use --apply or --rewrite after reviewing the handbook`,
		);
	}
	// A supplied generator *is* the request to generate: both entry points
	// withhold `generate` for --heuristic and --preview and supply it otherwise.
	// For an existing handbook, retain that work as a proposal unless replacement
	// or adoption was explicitly requested. Generation never implies publication.
	const adoptionOnly = input.adopt === true && hadPancodeMd && !replacePancodeMd && input.proposePancodeMd !== true;
	const shouldGenerate =
		!hadPancodeMd ||
		replacePancodeMd ||
		input.proposePancodeMd === true ||
		(input.generate !== undefined && !adoptionOnly);
	const shouldPropose =
		input.proposePancodeMd === true ||
		(hadPancodeMd && input.generate !== undefined && !replacePancodeMd && input.adopt !== true);
	let output: BootstrapStructuredOutput;
	let protectedContent: ProtectedHandbook | undefined;
	const compileReport: HandbookCompileReport = { merged: [], ruleIds: [], unknownRuleIds: [] };
	const compiled = (): { compile?: HandbookCompileReport } =>
		compileReport.merged.length + compileReport.ruleIds.length + compileReport.unknownRuleIds.length > 0
			? { compile: compileReport }
			: {};
	let generation: BootstrapGenerationTelemetry = {
		mode: shouldGenerate ? "heuristic" : existingParsed ? "existing" : "heuristic",
		parserOutcome: "not-run",
	};
	let reportedGeneration: BootstrapGenerationTelemetry | undefined;
	const reportGeneration: BootstrapGenerationSink = (reported) => {
		if (reportedGeneration === undefined) reportedGeneration = reported;
	};
	let enforcementSeen: EnforcementInventory | undefined;
	let evidenceFileNames: string[] = [];
	let handbookLedger: HandbookLedgerEntry[] | undefined;
	if (shouldGenerate) {
		const depth = input.depth ?? "standard";
		// The handbook this run writes is its output, not repository evidence. A
		// tracked draft let a rewrite ground slash-joined prose in its own
		// previous text; only --apply hands the old handbook over, as existingPancodeMd.
		// PanCode's own hand-written PANCODE-DEV.md stays out too, so a generated
		// handbook can be compared with it instead of copying it.
		const repositoryFiles = (await enumerateWorkspaceFilesAsync(cwd)).filter(
			(path) => !GENERATION_EXCLUDED_FILES.has(path),
		);
		const enforcement = collectEnforcementInventory(cwd, repositoryFiles);
		enforcementSeen = enforcement;
		const anchors = codewiki.files
			.filter((file) => file.lang !== "config" && file.role !== "test")
			.sort(
				(a, b) =>
					Number(b.role === "entry") - Number(a.role === "entry") ||
					b.imports.length - a.imports.length ||
					a.path.localeCompare(b.path),
			)
			.slice(0, depth === "quick" ? 2 : depth === "deep" ? 8 : 4)
			.map((file) => file.path);
		const evidence = collectBootstrapEvidence(cwd, repositoryFiles, enforcement, depth, anchors);
		evidenceFileNames = evidence.files.map((file) => file.path);
		progress(input, {
			phase: "generate",
			status: "started",
			message: input.generate ? "drafting PANCODE.md with the bootstrap agent" : "drafting PANCODE.md with heuristic",
		});
		const generateInput: BootstrapGenerateInput = {
			cwd,
			expectedProjectName: projectName(cwd, tomlFiles),
			tomlFiles,
			projectType,
			siblingFiles,
			adoption,
			codewiki,
			enforcement,
			depth,
			evidence,
			repositoryFiles,
			...(existingParsed ? { existingPancodeMd: existingParsed } : {}),
			...(existingPancodeMdText ? { existingPancodeMdText } : {}),
			...(previousInvariants.length > 0 ? { previousInvariants } : {}),
			...(previousSections.length > 0 ? { previousSections } : {}),
			...(input.onProgress ? { progress: input.onProgress } : {}),
			reportGeneration,
			missingSections: (draft) => missingHandbookSections({ cwd, enforcement }, draft),
			// Deterministic sampling repeats an empty draft unless a bounded repair receives grounding feedback.
			assessDraft: (draft) => {
				let retained = 0;
				stabilizeGeneratedOutput(
					generateInput,
					draft,
					() => {
						retained += 1;
					},
					true,
				);
				if (retained > 0) return null;
				const rules = [
					...draft.invariants,
					...draft.conventions,
					...(draft.sections ?? []).flatMap((section) => handbookBlocks(section.body)),
				];
				const corpus = createModelGroundingCorpus(generateInput);
				const tokens = rules.flatMap((rule) =>
					[...correctSymbolAttributions(rule, corpus).matchAll(CODE_TOKEN_RE)].map((match) => match[1] ?? ""),
				);
				const unknown = [...new Set(tokens.filter((token) => !groundedToken(token, corpus)))].slice(0, 12);
				const reason =
					rules.length === 0
						? "no rules"
						: tokens.length === 0
							? "no rules cited a file or symbol"
							: unknown.length > 0
								? `rules cited unknown tokens: ${unknown.join(", ")}`
								: "no rules or sections passed the citation and retention filters";
				return `The draft had ${rules.length} rules; none survived grounding (${reason}). Write the invariants, change recipes and test rules supported by the original evidence brief, each citing its file in backticks. Return the complete handbook JSON.`;
			},
		};
		input.signal?.throwIfAborted();
		output = await (input.generate ?? heuristicBootstrapOutput)(generateInput);
		input.signal?.throwIfAborted();
		generation = reportedGeneration ?? generation;
		let retainedModelSections = 0;
		const ledgerEntries: HandbookLedgerEntry[] = [];
		handbookLedger = ledgerEntries;
		output = stabilizeGeneratedOutput(
			{
				cwd,
				expectedProjectName: projectName(cwd, tomlFiles),
				tomlFiles,
				projectType,
				siblingFiles,
				adoption,
				codewiki,
				evidence,
				enforcement,
				repositoryFiles,
				handbookLedger: ledgerEntries,
				...(existingParsed ? { existingPancodeMd: existingParsed } : {}),
				...(existingPancodeMdText ? { existingPancodeMdText } : {}),
				...(previousInvariants.length > 0 ? { previousInvariants } : {}),
				...(previousSections.length > 0 ? { previousSections } : {}),
			},
			output,
			() => {
				retainedModelSections += 1;
			},
			generation.mode === "model",
			(content) => {
				protectedContent = content;
			},
			compileReport,
		);
		if (generation.mode === "model" && retainedModelSections === 0) {
			generation = {
				...generation,
				mode: "heuristic",
				fallbackReason: "bootstrap draft contributed no evidence-grounded rules or sections",
			};
		}
		progress(input, {
			phase: "generate",
			status: "completed",
			message: `${output.projectName}: ${output.sections?.length ?? 0} custom section${(output.sections?.length ?? 0) === 1 ? "" : "s"}`,
			detail: `${generation.mode}; parser=${generation.parserOutcome}`,
		});
	} else {
		output = existingParsed
			? bootstrapOutputFromParsed(existingParsed)
			: await heuristicBootstrapOutput({ cwd, tomlFiles, projectType, siblingFiles, adoption, codewiki });
		progress(input, {
			phase: "generate",
			status: "completed",
			message: hadPancodeMd
				? "preserving existing PANCODE.md; no generated rewrite requested"
				: "using heuristic PANCODE.md draft",
		});
	}
	if (input.adopt === true) {
		const imported = verifiedImportedRules({ cwd, projectType, siblingFiles, adoption, codewiki });
		output = replaceImportedAgentContext(output, renderImportedAgentContext({ ...adoption, importedRules: imported }));
	}
	if (shouldGenerate && generation.mode !== "existing") {
		output = placeWorkerSections(
			fitGeneratedHandbook(output, protectedContent, ({ chars, lines }) =>
				warn(
					input.io,
					`  warning: the carried and authored hard invariants and carried section blocks exceed the PANCODE.md target on their own (${chars} characters, ${lines} lines; target ${HANDBOOK_TARGETS.chars} and ${HANDBOOK_TARGETS.lines}); they were kept whole. Shorten or retire them in the handbook.\n`,
				),
			),
			protectedContent?.authoredTitles,
		);
	}
	if (shouldGenerate && generation.mode === "model") {
		for (const section of missingHandbookSections(
			{ cwd, ...(enforcementSeen ? { enforcement: enforcementSeen } : {}) },
			output,
		)) {
			warn(
				input.io,
				`  warning: the generated PANCODE.md has no ${section.title} section although ${section.reason}; rerun \`pancode context init --rewrite\` to draft it again.\n`,
			);
		}
	}
	const readNames = siblingFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	// Only a run that read a sibling handbook has something to report.
	const absorb =
		handbookLedger && readNames.length > 0
			? buildAbsorbReport(
					handbookLedger,
					compileReport,
					readNames.map((path) => (isAbsolute(path) ? relative(cwd, path) : path)),
				)
			: undefined;
	const absorbed = (): { absorb?: AbsorbReport } => (absorb ? { absorb } : {});
	const previewStatus = gitStatus(cwd);
	if (input.preview === true) {
		progress(input, { phase: "pancode-md", status: "completed", message: "preview ready; no files written" });
		const summary: RunBootstrapSummary = {
			action: "previewed",
			contextFileCount: readNames.length,
			contextFileNames: readNames,
			evidenceFileNames,
			codewikiEntries: codewikiEntryCount,
			dirtyFiles: countStatusLines(previewStatus),
			adoption: summarizeAdoption(adoption, "preview"),
			...compiled(),
			...absorbed(),
		};
		out(input.io, formatBootstrapSummary(summary));
		progress(input, { phase: "done", status: "completed", message: "context preview ready; no files written" });
		return {
			pancodeMdPath: join(cwd, "PANCODE.md"),
			statePath: resolveStatePath(cwd),
			siblingFiles,
			output,
			projectType,
			summary,
			adoption,
			telemetry: { generation },
			preload: measureProjectPreload(cwd),
		};
	}

	let pancodeMdPath = join(cwd, "PANCODE.md");
	let proposalPath: string | undefined;
	progress(input, {
		phase: "pancode-md",
		status: "started",
		message: hadPancodeMd ? "preserving PANCODE.md" : "writing PANCODE.md",
	});
	const action = await coordinateCodewikiExclusive(
		cwd,
		(): RunBootstrapSummary["action"] => {
			const wouldPublish =
				!hadPancodeMd || (replacePancodeMd && generation.mode !== "existing") || (input.adopt && existingParsed);
			const sourceChanged =
				hadPancodeMd !== existsSync(pancodeMdPath) || originalPancodeMdText !== readExistingPancodeMdText(cwd);
			if (shouldPropose || (wouldPublish && sourceChanged)) {
				proposalPath = writePancodeMdProposal(cwd, now, output, generation, originalPancodeMdHash, absorb);
				if (sourceChanged)
					warn(input.io, "PANCODE.md changed during initialization; the generated draft was saved as a proposal.\n");
				return "proposed";
			} else if (wouldPublish) {
				pancodeMdPath = writePancodeMdFile(cwd, output);
				dropVerifyVerdicts(cwd, pancodeMdPath);
				return hadPancodeMd ? "refreshed" : "wrote";
			}
			return "preserved";
		},
		input.signal,
	);
	if (handbookLedger) writeHandbookLedger(cwd, handbookLedger);
	progress(input, {
		phase: "pancode-md",
		status: "completed",
		message:
			action === "wrote"
				? "PANCODE.md written"
				: action === "refreshed"
					? "PANCODE.md refreshed"
					: action === "proposed"
						? "PANCODE.md proposal written"
						: "PANCODE.md preserved",
		detail: proposalPath ?? pancodeMdPath,
	});
	const adoptionApplied = input.adopt === true && (action === "wrote" || action === "refreshed");
	progress(input, { phase: "state", status: "started", message: "persisting codemap and project state" });
	const statePath = await coordinateCodewikiExclusive(cwd, () =>
		writeProjectState(
			cwd,
			projectType,
			now,
			indexedAt,
			adoption,
			adoptionApplied,
			codewiki.version,
			codewikiFingerprint,
			generation,
			action === "wrote" || action === "refreshed",
		),
	);
	progress(input, {
		phase: "state",
		status: "completed",
		message: `state updated; ${codewikiEntryCount} codemap entr${codewikiEntryCount === 1 ? "y" : "ies"}`,
	});

	const postStatus = gitStatus(cwd);
	const summary: RunBootstrapSummary = {
		action,
		contextFileCount: readNames.length,
		contextFileNames: readNames,
		evidenceFileNames,
		codewikiEntries: codewikiEntryCount,
		dirtyFiles: countStatusLines(postStatus),
		adoption: summarizeAdoption(adoption, adoptionApplied ? "adopt" : "scan"),
		...(proposalPath ? { proposalPath } : {}),
		...compiled(),
		...absorbed(),
	};
	out(input.io, formatBootstrapSummary(summary));
	if (action === "wrote" || action === "refreshed") {
		const ignored = await gitVia(runCommandVector, ["check-ignore", "--quiet", "--", "PANCODE.md"], {
			cwd,
			workspaceRoot: cwd,
			timeoutMs: 5_000,
			maxOutputBytes: 4_096,
		});
		if (ignored.exitCode === 0) {
			warn(
				input.io,
				"  warning: PANCODE.md was written but is ignored by Git. Remove its matching ignore rule or add !PANCODE.md to .gitignore if you want to version it; then git add PANCODE.md. The matching handbook ignore rule was left unchanged.\n",
			);
		}
	}
	const preload = measureProjectPreload(cwd);
	out(input.io, `  project instructions: ${preload.label}\n`);
	if (preload.mode === "full" && preload.nearLimit) {
		warn(
			input.io,
			`  warning: project context is within 10% of the preload limit (${preload.chars} UTF-16 units of ${FULL_PROJECT_CONTEXT_MAX_CHARS}, ${preload.lines} rendered lines of ${FULL_PROJECT_CONTEXT_MAX_LINES}); further growth may omit authored suffixes\n`,
		);
	}
	progress(input, {
		phase: "done",
		status: "completed",
		message: `${summary.action} PANCODE.md; ${summary.dirtyFiles} dirty file${summary.dirtyFiles === 1 ? "" : "s"}; project instructions: ${preload.label}`,
	});
	return {
		pancodeMdPath,
		statePath,
		siblingFiles,
		output,
		projectType,
		summary,
		adoption,
		telemetry: { generation },
		preload,
	};
}
