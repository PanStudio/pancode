// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure Git commit-message attribution.
 *
 * Callers supply sealed facts, never model prose. This module only translates
 * those facts into role trailers and has no filesystem, process, Git, or
 * settings dependencies, so every controlled commit seam shares one policy.
 */

/**
 * Slug of the GitHub App "PanCode Agent" whose bot account `pancode-agent[bot]`
 * is PanCode's commit identity. `pancode` is an unrelated user's login.
 */
const PANCODE_GITHUB_APP_SLUG = "pancode-agent";

/**
 * Account id of the App's bot user, read with
 * `gh api users/pancode-agent%5Bbot%5D --jq .id`; it is not the App id. GitHub
 * links a trailer to an account only by email, and a bot account answers to
 * `<id>+<slug>[bot]@users.noreply.github.com`. Changing it changes the managed
 * hook script, so bump `MANAGED_HOOK_VERSION`
 * (`src/core/git-commit-attribution.ts`) in the same commit.
 */
const PANCODE_GITHUB_BOT_USER_ID = 361236557;

/** The one email every PanCode commit trailer names, and the author email of an autonomous commit. */
export const PANCODE_COMMIT_EMAIL = `${PANCODE_GITHUB_BOT_USER_ID}+${PANCODE_GITHUB_APP_SLUG}[bot]@users.noreply.github.com`;

/** The author name of an autonomous commit; it changes the managed hook script, so bump `MANAGED_HOOK_VERSION` with it. */
export const PANCODE_COMMIT_NAME = "PanCode";

export const PANCODE_COMMIT_IDENTITY = `${PANCODE_COMMIT_NAME} <${PANCODE_COMMIT_EMAIL}>`;

/** A Git identity `Name <email>` that can stand in one trailer line. */
const HUMAN_IDENTITY = /^([^<>\r\n]*[^<>\s])\s+<([^<>\s]+@[^<>\s]+)>$/u;

/**
 * The `Co-authored-by:` trailer crediting the human committer of a
 * PanCode-authored commit, or null when `identity` is not one well-formed
 * `Name <email>` or names PanCode itself.
 */
export function humanCoAuthorTrailer(identity: string): string | null {
	const match = HUMAN_IDENTITY.exec(identity.trim());
	if (match === null || (match[2] ?? "").toLowerCase() === PANCODE_COMMIT_EMAIL.toLowerCase()) return null;
	return `Co-authored-by: ${match[1]} <${match[2]}>`;
}

export const PANCODE_COMMIT_TRAILERS = {
	assisted: `Assisted-by: ${PANCODE_COMMIT_IDENTITY}`,
	tested: `Tested-by: ${PANCODE_COMMIT_IDENTITY}`,
	reviewed: `Reviewed-by: ${PANCODE_COMMIT_IDENTITY}`,
	coAuthored: `Co-authored-by: ${PANCODE_COMMIT_IDENTITY}`,
} as const;

export const PANCODE_DECISION_TRAILER_KEY = "PanCode-Decision";

/** Most `PanCode-Decision:` trailers one commit carries; matches the run's decision-ref cap. */
export const PANCODE_DECISION_TRAILER_CAP = 32;

/**
 * A decision ref is `<interviewId>/<key>`: an `ask_user` interview id or an
 * `agent:<uuid>` decision-set id, then the decision key. Operator keys are
 * snake_case and agent keys are kebab-case, the same shape `isDecisionRecord`
 * admits. Only refs of this shape become trailers, so a malformed value can
 * never inject a second trailer line or a stray control character into a
 * commit message.
 */
const DECISION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}\/[a-z0-9]+(?:[_-][a-z0-9]+)*$/u;

/** A finished run's identity, the digest of its run.settled, for a commit the run directly accounts for (#434). */
interface CommitRunEvidence {
	version: 1;
	algorithm: "sha256";
	digest: string;
	/** The run was held by its producer or read back under a seal that verified. */
	integrityValid: boolean;
	/** The run did work or gave a verdict directly relevant to this commit. */
	directlyRelevant: boolean;
}

/** Trusted facts about the work recorded by one commit. */
export interface CommitAttributionEvidence {
	/** PanCode materially created or edited work recorded by this commit. */
	materiallyAssisted?: boolean;
	/** A real validation command completed successfully against the committed work. */
	validationSucceeded?: boolean;
	/** An independent verifier or reviewer produced a passing result. */
	independentReviewPassed?: boolean;
	/** PanCode materially authored part of the committed change. */
	materiallyAuthored?: boolean;
	/** Optional settled run for a directly relevant fact above. */
	run?: CommitRunEvidence;
	/**
	 * Decision refs (`<interviewId>/<key>`) the committed work was done under,
	 * read from the session decision board or a dispatched run's
	 * `decisionRefs`. Each becomes one `PanCode-Decision:` trailer.
	 */
	decisions?: ReadonlyArray<string>;
}

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]+(.+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function normalizedTrailer(line: string): string | null {
	const match = TRAILER_LINE.exec(line);
	if (match === null) return null;
	return `${match[1]?.toLowerCase()}:${match[2]
		?.trim()
		.replace(/[ \t]+/gu, " ")
		.toLowerCase()}`;
}

const KNOWN_PANCODE_TRAILERS = new Set(
	Object.values(PANCODE_COMMIT_TRAILERS)
		.map((line) => normalizedTrailer(line))
		.filter((line): line is string => line !== null),
);

function isPancodeTrailer(key: string): boolean {
	return (
		KNOWN_PANCODE_TRAILERS.has(key) ||
		// A run seal of any version is recognized so an amended message never keeps a stale managed trailer (#434).
		/^pancode-evidence:run-v\d+\/sha256:/u.test(key) ||
		key.startsWith(`${PANCODE_DECISION_TRAILER_KEY.toLowerCase()}:`)
	);
}

/** Well-formed decision refs from the evidence, deduplicated, sorted, and capped. */
export function decisionTrailerRefs(decisions: ReadonlyArray<string> | undefined): string[] {
	if (decisions === undefined) return [];
	const refs = new Set<string>();
	for (const ref of decisions) {
		if (typeof ref === "string" && DECISION_REF_PATTERN.test(ref)) refs.add(ref);
	}
	return [...refs].sort().slice(0, PANCODE_DECISION_TRAILER_CAP);
}

function decisionTrailer(ref: string): string {
	return `${PANCODE_DECISION_TRAILER_KEY}: ${ref}`;
}

/**
 * Return the first line of a conventional trailing trailer paragraph.
 * Human continuation lines are recognized as part of the block but never
 * interpreted or rewritten; PanCode's own trailers are always one line.
 */
function trailerBlockStart(lines: ReadonlyArray<string>): number | null {
	if (lines.length < 2) return null;
	const separator = lines.lastIndexOf("");
	const first = separator + 1;
	// A trailer paragraph is separated from subject/body by a blank line. This
	// keeps a subject such as "Fix: parser" a subject rather than metadata.
	if (separator < 0 || first >= lines.length) return null;
	let sawTrailer = false;
	for (const line of lines.slice(first)) {
		if (TRAILER_LINE.test(line)) {
			sawTrailer = true;
			continue;
		}
		if (sawTrailer && /^[ \t]+/u.test(line)) continue;
		return null;
	}
	return sawTrailer ? first : null;
}

function runTrailer(run: CommitRunEvidence | undefined): string | null {
	if (
		run?.version !== 1 ||
		run.algorithm !== "sha256" ||
		run.integrityValid !== true ||
		run.directlyRelevant !== true ||
		!SHA256.test(run.digest)
	) {
		return null;
	}
	return `PanCode-Evidence: run-v${run.version}/sha256:${run.digest}`;
}

interface CommitAttributionOptions {
	/**
	 * PanCode is the commit's author (an autonomous commit), and this is the human
	 * committer's `Name <email>`. PanCode's Assisted-by and Co-authored-by are then
	 * redundant and dropped; the human gets one `Co-authored-by:` trailer.
	 * Evidence trailers (Tested-by, Reviewed-by, PanCode-Evidence, PanCode-Decision)
	 * are unaffected.
	 */
	pancodeAuthorFor?: string;
}

/** PanCode's role trailers that only restate authorship once PanCode is the author. */
const PANCODE_AUTHOR_REDUNDANT_TRAILERS: ReadonlySet<string> = new Set(
	[PANCODE_COMMIT_TRAILERS.assisted, PANCODE_COMMIT_TRAILERS.coAuthored]
		.map((line) => normalizedTrailer(line))
		.filter((line): line is string => line !== null),
);

/**
 * Append only evidence-justified PanCode trailers.
 *
 * Disabled attribution is the one byte-preserving path. When enabled, CRLF and
 * lone CR are normalized to LF, the message ends with one newline, existing
 * subject/body and human trailers remain in order, repeated PanCode trailers
 * are removed case-insensitively, and processing the result again is
 * idempotent.
 */
export function attributeCommitMessage(
	originalMessage: string,
	evidence: Readonly<CommitAttributionEvidence>,
	enabled = true,
	options: Readonly<CommitAttributionOptions> = {},
): string {
	if (!enabled) return originalMessage;
	const humanTrailer = options.pancodeAuthorFor === undefined ? null : humanCoAuthorTrailer(options.pancodeAuthorFor);

	const normalized = originalMessage.replace(/\r\n?/gu, "\n");
	const lines = normalized.replace(/\n+$/u, "").split("\n");
	const blockStart = trailerBlockStart(lines);
	const seenPancode = new Set<string>();
	const retained = lines.filter((line, index) => {
		if (blockStart === null || index < blockStart) return true;
		const key = normalizedTrailer(line);
		if (key === null || !isPancodeTrailer(key)) return true;
		if (humanTrailer !== null && PANCODE_AUTHOR_REDUNDANT_TRAILERS.has(key)) return false;
		if (seenPancode.has(key)) return false;
		seenPancode.add(key);
		return true;
	});

	const desired: string[] = [];
	// Material authorship necessarily means material assistance too. Keeping the
	// two facts separate lets Co-authored-by remain a platform compatibility
	// marker rather than a substitute for the semantic role trailer. When PanCode
	// is the author, both are redundant and the human is credited instead.
	if (humanTrailer === null && (evidence.materiallyAssisted === true || evidence.materiallyAuthored === true)) {
		desired.push(PANCODE_COMMIT_TRAILERS.assisted);
	}
	if (evidence.validationSucceeded === true) desired.push(PANCODE_COMMIT_TRAILERS.tested);
	if (evidence.independentReviewPassed === true) desired.push(PANCODE_COMMIT_TRAILERS.reviewed);
	if (humanTrailer === null && evidence.materiallyAuthored === true) desired.push(PANCODE_COMMIT_TRAILERS.coAuthored);
	if (humanTrailer !== null) desired.push(humanTrailer);
	const runEvidence = runTrailer(evidence.run);
	if (runEvidence !== null) desired.push(runEvidence);
	for (const ref of decisionTrailerRefs(evidence.decisions)) desired.push(decisionTrailer(ref));

	const existing = new Set(
		(blockStart === null ? [] : retained.slice(blockStart))
			.map((line) => normalizedTrailer(line))
			.filter((line): line is string => line !== null),
	);
	const additions = desired.filter((line) => !existing.has(normalizedTrailer(line) ?? ""));
	if (additions.length === 0) return `${retained.join("\n")}\n`;

	if (blockStart === null) {
		while (retained.at(-1) === "") retained.pop();
		retained.push("", ...additions);
	} else {
		retained.push(...additions);
	}
	return `${retained.join("\n")}\n`;
}
