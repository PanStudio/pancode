// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { adoptionSourcesChanged } from "./adoption.js";
export { fallbackBootstrapOutput, runBootstrap } from "./bootstrap.js";
export { acceptHandbookProposal } from "./bootstrap-proposals.js";
export type {
	BootstrapFallbackMode,
	BootstrapGenerate,
	BootstrapGenerateInput,
	BootstrapGenerationTelemetry,
	BootstrapProgressEvent,
	BootstrapRunTelemetry,
	BootstrapStructuredOutput,
	HandbookLedgerEntry,
} from "./bootstrap-types.js";
export {
	judgeInstructionFiles,
	proposeHandbookVerification,
	verifyHandbook,
} from "./bootstrap-verify.js";
export { runContextClear } from "./clear.js";
export {
	codemapPath,
	codewikiEntries,
	readCodewiki,
	writeCodewiki,
} from "./codewiki/artifact.js";
export { renderCodewikiDigest } from "./codewiki/digest.js";
export { lazyCodeSkeleton } from "./codewiki/lazy-skeleton.js";
export { CODEWIKI_VERSION } from "./codewiki/schema.js";
export { renderEffectivePromptContext } from "./compiled-handbook.js";
export type {
	ContextContract,
	ContextState,
	ProjectPromptContext,
} from "./contract.js";
export {
	computeFingerprint,
	isStale,
} from "./fingerprint.js";
export {
	BRIEFING_MIN_EXCERPT_BYTES,
	BRIEFING_SEPARATOR,
	type BriefingNotice,
	type BriefingPart,
	type BuiltBriefing,
	buildBriefing,
} from "./fold/briefing.js";
export type { FoldCursor, FoldOwner } from "./fold/contract.js";
export { describeHandbookFreshness } from "./handbook-ledger.js";
export {
	type LoadedOperatorProfile,
	loadOperatorProfile,
	renderOperatorProfile,
} from "./operator-profile.js";
export {
	loadProjectPancodeMd,
	serializePancodeMd,
} from "./pancode-md.js";
export {
	loadProjectRules,
	type ProjectRulesLoad,
	selectActiveRules,
} from "./project-rules.js";
export { renderPromptContext } from "./prompt-context.js";
export { runContextRefresh } from "./refresh.js";
export {
	type BootstrapGenerationState,
	type BootstrapParserOutcome,
	readPancodeState,
} from "./state.js";
export {
	type RunWikiGenerateResult,
	runWikiGenerate,
} from "./wiki/generate.js";
export {
	listWikiPages,
	wikiDir,
} from "./wiki/layout.js";
export {
	currentWikiGitHead,
	readWikiMeta,
	type WikiMeta,
} from "./wiki/meta.js";
export type { WikiDepth } from "./wiki/plan.js";
export { MAX_PAGE_ATTEMPTS } from "./wiki/plan-store.js";
export { foldWorkingSet } from "./working-set/fold.js";
export {
	canonicalize,
	createPathIndexBuilder,
	type PathIndexBuilder,
	type PathObservation,
} from "./working-set/path-index.js";
export { recalledRef } from "./working-set/payload.js";
export { projectWorkingSet } from "./working-set/project.js";
export { recallableRefs } from "./working-set/recall.js";
export { compactionCut } from "./working-set/visible.js";
