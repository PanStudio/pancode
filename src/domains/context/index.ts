// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export {
	type AdoptionScanResult,
	type AdoptionSourcesChangedOptions,
	adoptionSnapshotsHash,
	adoptionSourcesChanged,
	renderImportedAgentContext,
	scanAgentConfigs,
} from "./adoption.js";
export { fallbackBootstrapOutput, runBootstrap } from "./bootstrap.js";
export { type AcceptProposalResult, acceptHandbookProposal } from "./bootstrap-proposals.js";
export type {
	BootstrapFallbackMode,
	BootstrapFallbackResult,
	BootstrapGenerate,
	BootstrapGenerateInput,
	BootstrapGenerationSink,
	BootstrapGenerationTelemetry,
	BootstrapProgressEvent,
	BootstrapProgressSink,
	BootstrapRunTelemetry,
	BootstrapStructuredOutput,
	HandbookLedgerEntry,
	RunBootstrapInput,
	RunBootstrapResult,
} from "./bootstrap-types.js";
export {
	type HandbookVerification,
	judgeInstructionFiles,
	proposeHandbookVerification,
	verifyHandbook,
} from "./bootstrap-verify.js";
export { type RunContextClearInput, type RunContextClearResult, runContextClear } from "./clear.js";
export {
	codemapPath,
	codewikiEntries,
	codewikiNeedsBackfill,
	parseCodewikiRaw,
	readCodewiki,
	serializeCodewiki,
	structuralCodewikiHash,
	writeCodewiki,
} from "./codewiki/artifact.js";
export { type CooperativeSlicer, createSlicer, INDEX_SLICE_MS } from "./codewiki/cooperative.js";
export { renderCodewikiDigest } from "./codewiki/digest.js";
export {
	buildCodewiki,
	syncCodewiki,
	updateCodewikiPaths,
} from "./codewiki/indexer.js";
export { CODEWIKI_VERSION } from "./codewiki/schema.js";
export { renderEffectivePromptContext } from "./compiled-handbook.js";
export type {
	ContextContract,
	ContextState,
	ProjectPromptContext,
	ProjectStructuredContext,
	StartupHint,
} from "./contract.js";
export {
	computeFingerprint,
	isStale,
} from "./fingerprint.js";
export {
	abbreviateHeadTail,
	BRIEFING_MIN_EXCERPT_BYTES,
	BRIEFING_SEPARATOR,
	type BriefingClip,
	type BriefingNotice,
	type BriefingPart,
	type BriefingPartKind,
	type BuiltBriefing,
	buildBriefing,
	shareBytesFairly,
} from "./fold/briefing.js";
export type { FoldCursor, FoldOwner } from "./fold/contract.js";
export { describeHandbookFreshness, readHandbookFreshness } from "./handbook-ledger.js";
export {
	type LoadedOperatorProfile,
	loadOperatorProfile,
	OPERATOR_PROFILE_MAX_CHARS,
	type OperatorProfile,
	renderOperatorProfile,
} from "./operator-profile.js";
export {
	loadProjectPancodeMd,
	parsePancodeMd,
	renderProjectContextFragment,
	serializePancodeMd,
	tryReadPancodeMd,
} from "./pancode-md.js";
export {
	loadProjectRules,
	type ProjectRule,
	type ProjectRulesLoad,
	selectActiveRules,
} from "./project-rules.js";
export { renderPromptContext } from "./prompt-context.js";
export {
	type RunContextRefreshInput,
	type RunContextRefreshResult,
	runContextRefresh,
} from "./refresh.js";
export {
	type BootstrapGenerationMode,
	type BootstrapGenerationState,
	type BootstrapParserOutcome,
	readPancodeState,
	writePancodeState,
} from "./state.js";
export { assembleWikiTree, type WikiAssemblyReport, type WikiPageIssue } from "./wiki/assemble.js";
export {
	readWikiPage,
	type WikiPageDocument,
	type WikiPageMetadata,
} from "./wiki/frontmatter.js";
export {
	type RunWikiGenerateInput,
	type RunWikiGenerateResult,
	runWikiGenerate,
	type WikiGenerate,
	type WikiGenerateInput,
	type WikiGenerateMode,
} from "./wiki/generate.js";
export {
	isGeneratedWikiFile,
	listWikiPages,
	listWikiPagesInDir,
	WIKI_INDEX,
	WIKI_PLAN_FILE,
	WIKI_QUICKSTART,
	type WikiPage,
	wikiDir,
	wikiMarkdownFilesInDir,
} from "./wiki/layout.js";
export { renderWikiPage } from "./wiki/markdown.js";
export {
	computeWikiContentHash,
	computeWikiContentHashOfDir,
	currentWikiGitHead,
	readWikiMeta,
	validateWikiMeta,
	type WikiMeta,
	type WikiMetaGeneration,
	type WikiMetaValidation,
	wikiMetaPath,
	writeWikiMeta,
} from "./wiki/meta.js";
export {
	buildCandidatePlan,
	type DepthStrategy,
	pagePathForArea,
	planWikiGeneration,
	type ResolvedWikiDepth,
	WIKI_DEPTH_STRATEGY,
	type WikiDepth,
	type WikiGenerationPlan,
	type WikiPlan,
	type WikiPlanPage,
} from "./wiki/plan.js";
export {
	MAX_PAGE_ATTEMPTS,
	pendingPages,
	readWikiPlanFile,
	sanitizePagePath,
	sanitizeWikiPlan,
	writeWikiPlanFile,
} from "./wiki/plan-store.js";
export {
	type BuildWikiPagePromptInput,
	type BuildWikiPlanPromptInput,
	buildWikiPagePrompt,
	buildWikiPlanPrompt,
} from "./wiki/prompts.js";
export {
	changedPathsSince,
	type WikiCompleteness,
	type WikiStaleness,
	wikiCompleteness,
	wikiCompletenessFromMeta,
	wikiStaleness,
} from "./wiki/staleness.js";
