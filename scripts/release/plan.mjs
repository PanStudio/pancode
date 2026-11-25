// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure release decisions. Every function here takes facts already read from git, npm and
 * GitHub and returns a decision, so the order of irreversible steps is testable without
 * touching any service.
 */
import { resolve } from "node:path";

/** GitHub refuses a release body longer than this many characters. */
export const RELEASE_BODY_LIMIT = 125_000;

/** The 107-character socket limit leaves room for at most this much TMPDIR. */
export const MAX_TMPDIR_LENGTH = 40;

/** Qualification and packing must never fill the shared 4 GB /tmp (item 11 of the 0.7.0 release). */
export function tmpdirProblem(directory) {
	const path = resolve(directory);
	if (path === "/tmp" || path.startsWith("/tmp/"))
		return `TMPDIR resolves to ${path}, the shared system /tmp. Export a short private directory first, such as TMPDIR=$HOME/.cache/cr.`;
	if (path.length > MAX_TMPDIR_LENGTH)
		return `TMPDIR ${path} is ${path.length} characters; sockets under it fail past 107. Use one of at most ${MAX_TMPDIR_LENGTH}.`;
	return null;
}

/**
 * Paths whose change cannot alter the qualified package bytes. A release may finish from a
 * version-branch head that only adds commits touching these, after npm already serves the
 * candidate (item 3): the tag, tarball and website still come from the candidate.
 */
const TOOLING = [
	/^scripts\/release[^/]*\.mjs$/u,
	/^scripts\/release\/[^/]+\.mjs$/u,
	/^\.github\/workflows\/release\.yml$/u,
	/^tests\/contracts\/release-[^/]+\.test\.ts$/u,
];
export const toolingOnly = (paths) =>
	paths.length > 0 && paths.every((path) => TOOLING.some((rule) => rule.test(path)));

/**
 * Draft handling (item 5). A draft keeps the target it was created with, and publishing it
 * creates the immutable tag there, so the target is pinned before any publish.
 */
export function draftAction({ release, tagCommit }, commit) {
	if (tagCommit !== null && tagCommit !== commit)
		return { action: "stop", reason: "the tag already points to another commit" };
	if (release && !release.draft)
		return tagCommit === commit
			? { action: "verify" }
			: { action: "stop", reason: "a published release has no tag at the candidate" };
	if (!release) return { action: "create" };
	if (release.target_commitish !== commit) return { action: "retarget" };
	return { action: "publish" };
}

/** A version branch: `v` and three or more digits (`v071`, and `v0710` for 0.7.10). */
export const isVersionBranch = (branch) => /^v\d{3,}$/u.test(String(branch));

/** The GitHub App whose installation token release.yml mints, and the owner who approves its job. */
export const RELEASE_APP_ID = 5919481;
export const RELEASE_REVIEWER = "akougkas";

const coversMain = (ruleset) =>
	ruleset.target === "branch" &&
	ruleset.conditions?.ref_name?.include?.some((ref) => ref === "refs/heads/main" || ref === "~DEFAULT_BRANCH");
const coversTags = (ruleset) =>
	ruleset.target === "tag" &&
	ruleset.conditions?.ref_name?.include?.some((ref) => ref === "refs/tags/v*" || ref === "~ALL");
const hasRules = (ruleset, ...types) => types.every((type) => ruleset.rules?.some((rule) => rule.type === type));
const appBypasses = (ruleset) =>
	ruleset.bypass_actors?.some((actor) => actor.actor_type === "Integration" && actor.actor_id === RELEASE_APP_ID);

/**
 * What the repository still lacks for release.yml to publish only behind the owner's approval, from the
 * `release` environment, its deployment policies, variable and secret, and the active rulesets in full.
 * GitHub enforces an environment's required reviewer only on a public repository of a personal account.
 */
export function releaseSetupProblems({ visibility, environment, policies, variable, secret, rulesets }) {
	const problems = [];
	if (visibility !== "public")
		problems.push(`the repository is ${visibility}, where GitHub does not enforce the release environment's reviewer`);
	if (!environment) problems.push("the release environment does not exist");
	else {
		const reviewers = environment.protection_rules?.find((rule) => rule.type === "required_reviewers")?.reviewers;
		if (!reviewers?.some((entry) => entry.type === "User" && entry.reviewer?.login === RELEASE_REVIEWER))
			problems.push(
				`the release environment has no required reviewer ${RELEASE_REVIEWER}, so release.yml would publish unapproved`,
			);
		if (environment.deployment_branch_policy?.custom_branch_policies !== true)
			problems.push("the release environment does not restrict deployments to selected branches and tags");
		for (const [name, type] of [
			["v*", "tag"],
			["v[0-9][0-9][0-9]", "branch"],
		])
			if (!policies?.some((policy) => policy.name === name && policy.type === type))
				problems.push(`the release environment lacks the ${type} deployment rule ${name}`);
	}
	if (variable?.value !== String(RELEASE_APP_ID))
		problems.push(`the release environment variable RELEASE_APP_ID is not ${RELEASE_APP_ID}`);
	if (!secret) problems.push("the release environment lacks the secret RELEASE_APP_PRIVATE_KEY");
	const active = rulesets.filter((ruleset) => ruleset.enforcement === "active");
	const main = active.filter(coversMain);
	const tags = active.filter(coversTags);
	if (!main.some((ruleset) => hasRules(ruleset, "deletion", "non_fast_forward") && !appBypasses(ruleset)))
		problems.push("no ruleset forbids deleting or force-pushing main without a release App bypass");
	const checks = main.find((ruleset) => hasRules(ruleset, "required_status_checks"));
	const contexts = checks?.rules
		.find((rule) => rule.type === "required_status_checks")
		.parameters?.required_status_checks?.map((check) => check.context);
	if (!["ci (22)", "ci (24)"].every((context) => contexts?.includes(context)))
		problems.push("no ruleset requires ci (22) and ci (24) on main");
	if (main.some((ruleset) => hasRules(ruleset, "required_status_checks") && !appBypasses(ruleset)))
		problems.push(`the main status-check ruleset lacks the release App ${RELEASE_APP_ID} as a bypass actor`);
	if (!tags.some((ruleset) => hasRules(ruleset, "creation") && appBypasses(ruleset)))
		problems.push(`no tag ruleset restricts v* creation to the release App ${RELEASE_APP_ID}`);
	if (!tags.some((ruleset) => hasRules(ruleset, "update", "deletion") && !appBypasses(ruleset)))
		problems.push("no tag ruleset makes published v* tags immutable for everyone");
	if (tags.some((ruleset) => (hasRules(ruleset, "update") || hasRules(ruleset, "deletion")) && appBypasses(ruleset)))
		problems.push("the release App bypasses a ruleset that protects published tags; keep v* creation in its own ruleset");
	return problems;
}
