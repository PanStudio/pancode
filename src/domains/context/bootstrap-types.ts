// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { ContextActivityPayload } from "../../core/telemetry/live-events.js";
import type { RunUsageFacts } from "../../core/telemetry/schemas.js";
import type { TomlFileReader } from "../../core/toml.js";
import type { ProjectPreloadClass } from "../prompts/preload.js";
import type { ProjectType } from "../session/workspace/project-type.js";
import type { AdoptionScanResult } from "./adoption.js";
import type { BootstrapDepth, BootstrapEvidence } from "./bootstrap-evidence.js";
import type { Codewiki } from "./codewiki/schema.js";
import type { EnforcementInventory } from "./enforcement-inventory.js";
import type { PancodeMdSection, ParsedPancodeMd } from "./pancode-md.js";
import type { SiblingContextFile } from "./sibling-files.js";
import type { BootstrapGenerationMode, BootstrapParserOutcome } from "./state.js";

export interface BootstrapStructuredOutput {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	sections?: PancodeMdSection[];
	importedAgentContext?: string;
	conventionsOverride?: string;
	sectionsBeforeConventions?: number;
}

export interface BootstrapIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

/**
 * Input handed to a PANCODE.md generator. Carries the adoption scan plus the freshly
 * built codewiki so generators can ground their output in the real repository
 * structure (entry points, key modules) instead of guessing from prose alone.
 */
export interface BootstrapGenerateInput {
	cwd: string;
	expectedProjectName?: string;
	/** Operation-scoped parsed TOML documents shared by bootstrap consumers. */
	tomlFiles?: TomlFileReader;
	projectType: ProjectType;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	adoption: AdoptionScanResult;
	codewiki: Codewiki;
	existingPancodeMd?: ParsedPancodeMd;
	existingPancodeMdText?: string;
	/**
	 * Hard invariants of the handbook a rewrite replaces. The draft ignores
	 * them as source; each one whose cited paths and symbols still exist is
	 * carried forward verbatim.
	 */
	previousInvariants?: ReadonlyArray<string>;
	/**
	 * Custom sections of the handbook a rewrite replaces. Handbook units route a
	 * section to fleet workers by its title, so a title the draft drops is
	 * carried with the blocks that name a check the repository still defines.
	 */
	previousSections?: ReadonlyArray<PancodeMdSection>;
	/** What CI runs and which custom checks exist; the model explains each as a rule. */
	enforcement?: EnforcementInventory;
	depth?: BootstrapDepth;
	evidence?: BootstrapEvidence;
	repositoryFiles?: ReadonlyArray<string>;
	progress?: BootstrapProgressSink;
	reportGeneration?: BootstrapGenerationSink;
	assessDraft?: (draft: BootstrapStructuredOutput) => string | null;
	/** Sections the evidence supports that a draft omits, each with the evidence that supports it. */
	missingSections?: (draft: BootstrapStructuredOutput) => ExpectedSection[];
	/** Receives one entry per instruction unit the authored-rule pass judged; only the final pass passes one. */
	handbookLedger?: HandbookLedgerEntry[];
}

/** One adopted instruction unit and the verdict that decided whether it entered PANCODE.md. */
export interface HandbookLedgerEntry {
	id: string;
	text: string;
	origin: "adopted" | "handbook";
	/** Where the rule is stated, 1-based; `endLine` is its last line when `--verify` judged it. */
	source: { file: string; line: number; endLine?: number };
	citations: string[];
	verdict: "verified" | "stale" | "unverifiable" | "contradicted";
	reason: string;
	kept: boolean;
	/** Renumbered checker ids `--verify` found; when this is the only problem, `--apply` rewrites them. */
	ruleIds?: { from: string; to: string }[];
}

export type BootstrapGenerate = (
	input: BootstrapGenerateInput,
) => BootstrapStructuredOutput | Promise<BootstrapStructuredOutput>;

export type BootstrapProgressEvent = Omit<ContextActivityPayload, "kind" | "at" | "operation">;
export type BootstrapProgressSink = (event: BootstrapProgressEvent) => void;

export interface BootstrapRunTelemetry {
	structuredOutputMode: "native-schema" | "prompt-parser";
	runId?: string;
	targetId?: string;
	wireModelId?: string;
	runtimeId?: string;
	runtimeKind?: string;
	thinkingLevel?: string;
	/** The generation run's spend, one fact per quantity (#434). */
	spend?: RunUsageFacts;
	toolCalls?: number;
	toolFailures?: number;
	toolBlocked?: number;
	durationMs?: number;
	promptBytes: number;
	outputBytes: number;
}

export interface BootstrapGenerationTelemetry {
	mode: BootstrapGenerationMode;
	parserOutcome: BootstrapParserOutcome;
	fallbackReason?: string;
	/** The dispatch whose draft this generation reports on. */
	run?: BootstrapRunTelemetry;
	/**
	 * Every dispatch this generation made, in order: schema fallback, repair and
	 * section requests each spend tokens and tool calls that `run` alone omits.
	 */
	runs?: ReadonlyArray<BootstrapRunTelemetry>;
	/** Monotonic span of the whole generation, every dispatch included. */
	durationMs?: number;
	repairRan?: boolean;
	repairProducedHandbook?: boolean;
}

export type BootstrapGenerationSink = (telemetry: BootstrapGenerationTelemetry) => void;

export type BootstrapFallbackMode = "existing" | "heuristic";

export interface BootstrapFallbackResult {
	mode: BootstrapFallbackMode;
	output: BootstrapStructuredOutput;
}

export interface RunBootstrapInput {
	signal?: AbortSignal;
	cwd?: string;
	io?: BootstrapIo;
	modelId?: string;
	now?: () => Date;
	preview?: boolean;
	adopt?: boolean;
	applyPancodeMd?: boolean;
	rewritePancodeMd?: boolean;
	proposePancodeMd?: boolean;
	includeGlobalImports?: boolean;
	homeDir?: string;
	generate?: BootstrapGenerate;
	onProgress?: BootstrapProgressSink;
	depth?: BootstrapDepth;
}

export interface RunBootstrapResult {
	pancodeMdPath: string;
	statePath: string;
	siblingFiles: ReadonlyArray<SiblingContextFile>;
	output: BootstrapStructuredOutput;
	projectType: ProjectType;
	summary: RunBootstrapSummary;
	adoption: AdoptionScanResult;
	telemetry: {
		generation: BootstrapGenerationTelemetry;
	};
	/**
	 * How the session compiler will preload the project context that exists
	 * on disk after this run with unknown tool capability: full, partial,
	 * or none. In preview mode this reflects the current on-disk state, since
	 * preview writes nothing.
	 */
	preload: ProjectPreloadClass;
}

export interface RunBootstrapSummary {
	action: "wrote" | "refreshed" | "preserved" | "proposed" | "previewed";
	contextFileCount: number;
	contextFileNames: string[];
	/** Repository files PanCode excerpted into the drafting agent's evidence brief; empty when nothing was drafted. */
	evidenceFileNames: string[];
	codewikiEntries: number;
	dirtyFiles: number;
	adoption: RunBootstrapAdoptionSummary;
	proposalPath?: string;
	/** Restated rules merged and checker ids corrected while compiling, when there were any. */
	compile?: HandbookCompileReport;
	/** What the generated handbook absorbed from sibling handbooks, when a draft judged their rules. */
	absorb?: AbsorbReport;
}

/** Verdict counts from the handbook ledger and every rule that did not enter PANCODE.md as written. */
export interface AbsorbReport {
	counts: Record<HandbookLedgerEntry["verdict"], number>;
	rules: { status: "dropped" | "contradicted" | "merged"; file: string; line: number; text: string; reason: string }[];
	/** Sibling handbooks read as sources; PanCode never modifies them. */
	handbooks: string[];
}

export interface RunBootstrapAdoptionSummary {
	mode: "scan" | "adopt" | "preview";
	sourceCount: number;
	projectSourceCount: number;
	globalSourceCount: number;
	importedRuleCount: number;
	conflictCount: number;
	rejectedCount: number;
	includeGlobal: boolean;
}

/** What compiling the handbook merged or corrected in the rules it kept; reported, never silent. */
export interface HandbookCompileReport {
	merged: { kept: string; dropped: string }[];
	ruleIds: { from: string; to: string }[];
	unknownRuleIds: string[];
}

export interface ExpectedSection {
	title: string;
	reason: string;
}
