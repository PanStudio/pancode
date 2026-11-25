// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export {
	draftIdentity,
	isFixedPoint,
	parseReportBlock,
	type RenderedReport,
	rememberIdentity,
	renderReport,
} from "./body.js";
export {
	type BuiltBundle,
	buildBundle,
	type ConsentScopes,
	consentText,
	previewBundle,
	REPORT_BUNDLE_ENVELOPE_SCHEMA,
	type ReportBundleEnvelope,
	readReportBundle,
	renderBundlePreview,
	reportBundlePath,
	saveBuiltBundle,
	sweepReportBundles,
	TRANSCRIPT_TURNS_DEFAULT,
	TRANSCRIPT_TURNS_MAX,
	transcriptExcerpt,
} from "./bundle.js";
export { type CanaryHit, canaryRefusal, canaryScan, issueCanaryHits } from "./canary.js";
export { type ReportCommandRunner, runReportCommand } from "./command.js";
export { applyVerdict, findRelated, type RelatedIssue, type RelatedVerdict, titleTokens } from "./dedup.js";
export { newReportId, REPORT_ID, type ReportDraft, stripHiddenText } from "./draft.js";
export type { ReportSessionFacts } from "./environment.js";
export { reportFingerprint } from "./fingerprint.js";
export {
	readPackagedChangelog,
	refreshReportStatus,
	reportsDoctorDetail,
	runReplyCheck,
	setReplyCheck,
	takeFixedReportNotices,
} from "./follow-up.js";
export {
	bundleDeletionRequest,
	forgetIntakeBundle,
	INTAKE_CLOSED_RETENTION_DAYS,
	INTAKE_MAX_AGE_DAYS,
	intakeReportBundle,
	readIntakeIndex,
	sweepIntakeStore,
} from "./intake.js";
export { observeSession, observeSessionAsync } from "./observe.js";
export {
	createOfferTriggers,
	HEADLESS_OFFER_LINE,
	isFirstSession,
	mayOffer,
	type OfferCandidate,
	offerRefusal,
	type ReportOffersSetting,
	readOfferLedger,
	recordAnswer,
	recordOfferShown,
	takeHeadlessOffer,
} from "./offers.js";
export { outboxEntry, readOutbox, updateOutbox } from "./outbox.js";
export {
	applyReportEdit,
	composeReportDraft,
	type DuplicateChoice,
	duplicateOptions,
	forgetReport,
	maskNoun,
	maskSummary,
	planHeadline,
	planReport,
	REPORT_DRAFT_SAVED,
	REPORT_THANKS,
	type ReportFlowOutcome,
	type ReportOfferPrefill,
	type ReportPlan,
	type ReportPlanTransport,
	relatedLine,
	reportEditTemplate,
	reportRows,
	runReportSend,
	sentLine,
} from "./plan.js";
export {
	type IdentitySettings,
	type LocalIdentity,
	localIdentity,
	type ReportMask,
	SECRET_MASK_ID,
	scrubText,
} from "./scrub.js";
export { reportBundleDigest, type ShareDigest, telemetryShareDigest } from "./share/digest.js";
export {
	newShareId,
	openShare,
	type SealedShare,
	SHARE_ID,
	SHARE_RECIPIENT,
	type ShareKind,
	type SharePlaintext,
	sealShare,
} from "./share/seal.js";
export { readReportDraft, reportDraftsDirectory, reportMarkdownPath, saveReportDraft } from "./store.js";
export { createReportTextHost, formatReportPlanText } from "./text-flow.js";
export {
	bundleDeletionComment,
	checkLastAttempt,
	detectTransport,
	ghEnvironment,
	prefillLink,
	REPORT_URL_BUDGET,
	type ReportTransport,
	routeFor,
	sendReport,
} from "./transport.js";
export * from "./vocabulary.js";
