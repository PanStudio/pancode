#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { kitListProblems } from "./release/installed-commands.mjs";
import { draftAction, isVersionBranch, RELEASE_BODY_LIMIT, toolingOnly } from "./release/plan.mjs";
import { registryArgs, releaseRegistry } from "./release/registry.mjs";
import { git, installers, QUALIFICATION_TEST_BUDGET, root, run, verifyCandidate } from "./release-candidate.mjs";
import { publishTagErrors, releaseVersionErrors } from "./release-version-policy.mjs";

const repository = "akougkas/pancode";
const RELEASE_APP = "pancode-release";
const NPM_WAIT_MINUTES = 40;
export function publicationPlan(receipt, branch) {
	if (!isVersionBranch(branch)) throw new Error("Public releases must come from a version branch such as v062.");
	const channel = receipt.version.includes("-") ? "beta" : "latest";
	const errors = publishTagErrors({ version: receipt.version, tag: channel });
	if (errors.length) throw new Error(errors.join("\n"));
	return {
		commit: receipt.commit,
		version: receipt.version,
		branch,
		channel,
		tag: `v${receipt.version}`,
		package: `${receipt.name}@${receipt.version}`,
		tarball: basename(receipt.tarball),
		sha256: receipt.files[basename(receipt.tarball)],
		websiteSha256: receipt.files["website.tgz"],
	};
}

function releaseMode() {
	// A check run is a release preflight that never reaches the protected job.
	const requested = process.env.PANCODE_RELEASE_MODE;
	const mode = requested === undefined || requested === "check" ? "release" : requested;
	if (!["release", "finish"].includes(mode)) throw new Error("Release mode must be release or finish.");
	return mode;
}

/** The release job's token must belong to the pancode-release App, which the release rulesets let push. */
function releaseAppSlug() {
	const slug = process.env.RELEASE_APP_SLUG;
	if (slug !== RELEASE_APP)
		throw new Error(
			`The release token must come from the ${RELEASE_APP} GitHub App, not ${slug || "an unknown identity"}.`,
		);
	return slug;
}

/** Strict SemVer ordering for npm dist-tag forwarding; build metadata is ignored. */
export function compareVersions(left, right) {
	const parse = (value) =>
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/.exec(value);
	const a = parse(left),
		b = parse(right);
	if (!a || !b) throw new Error("Invalid registry version for tag forwarding.");
	for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Math.sign(Number(a[i]) - Number(b[i]));
	const x = a[4]?.split(".") ?? [],
		y = b[4]?.split(".") ?? [];
	if (!x.length || !y.length) return x.length === y.length ? 0 : x.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const l = x[i],
			r = y[i];
		if (l === r) continue;
		if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
		const ln = /^\d+$/.test(l),
			rn = /^\d+$/.test(r);
		if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : l.length < r.length ? -1 : 1;
		if (ln !== rn) return ln ? -1 : 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

export function forwardedTags(tags, version, channel) {
	const follow = channel === "latest" ? ["beta"] : [];
	return follow.filter((tag) => tags[tag] && compareVersions(tags[tag], version) < 0);
}

export async function registryTags(name) {
	const response = await fetch(`${releaseRegistry()}-/package/${encodeURIComponent(name)}/dist-tags`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`npm dist-tags returned HTTP ${response.status}`);
	return response.json();
}

export function api(path, method = "GET", body) {
	return JSON.parse(
		run("gh", ["api", path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], {
			encoding: "utf8",
			stdio: "pipe",
			// List endpoints grow with release history; the 1 MiB default killed the 0.7.0 release.
			maxBuffer: 64 * 1024 * 1024,
			...(body === undefined ? {} : { input: JSON.stringify(body) }),
		}),
	);
}

export async function qualification(runId, commit, { inProgress = false } = {}) {
	if (!/^\d+$/u.test(String(runId))) throw new Error("A qualification run ID is required.");
	const record = api(`repos/${repository}/actions/runs/${runId}`);
	const jobs = api(`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`).jobs;
	verifyQualificationRecord(record, jobs, commit, inProgress);
	return record;
}

export function verifyQualificationRecord(record, jobs, commit, inProgress = false) {
	if (
		record.head_sha !== commit ||
		record.path !== ".github/workflows/ci.yml" ||
		record.event !== "workflow_dispatch" ||
		(!inProgress && (record.status !== "completed" || record.conclusion !== "success"))
	)
		throw new Error("Qualification must be a successful manual ci.yml run on this exact commit.");
	for (const name of ["prepare", "ci (22)", "ci (24)"]) {
		if ([...jobs].sort((a, b) => b.id - a.id).find((job) => job.name === name)?.conclusion !== "success")
			throw new Error(`Qualification gate did not pass: ${name}`);
	}
}

export async function rehearseBytes(directory, commit, branch) {
	const receipt = verifyCandidate(directory, commit);
	const plan = publicationPlan(receipt, branch);
	let dryRun;
	try {
		dryRun = JSON.parse(
			run(
				"npm",
				["publish", receipt.tarball, "--dry-run", "--json", "--access", "public", "--tag", plan.channel, ...registryArgs()],
				{ encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024 },
			),
		);
	} catch (error) {
		if (
			!String(error.stderr).includes(`You cannot publish over the previously published versions: ${receipt.version}.`) ||
			!(await registryVersion(receipt.name, receipt.version))
		)
			throw error;
		console.log(
			`npm dry-run correctly refuses the already published ${receipt.version}; no version bump or public write was made.`,
		);
	}
	if (dryRun) dryRun = dryRun[receipt.name] ?? dryRun;
	if (
		dryRun &&
		(dryRun.name !== receipt.name ||
			dryRun.version !== receipt.version ||
			dryRun.integrity !== integrity(receipt.tarball))
	)
		throw new Error("npm dry-run differs from the qualified archive.");
	verifyCandidate(directory, commit);
	console.log(
		`Publication payload verified: ${plan.package}, ${plan.tag}, five GitHub assets, prepared website. The owner's npm authorization is proven only by the real publish.`,
	);
	return plan;
}

export async function registryVersion(name, version) {
	const response = await fetch(`${releaseRegistry()}${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
	return response.json();
}

function integrity(tarball) {
	return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

export function requireIntegrity(published, receipt) {
	if (
		published.name !== receipt.name ||
		published.version !== receipt.version ||
		published.dist?.integrity !== integrity(receipt.tarball)
	)
		throw new Error("npm already contains different bytes for this version; published versions are immutable.");
}

/**
 * Finish mode's gate: npm already serves exactly the qualified bytes (the integrity check pins the
 * artifact digest recorded on adoption) and the qualified commit is an ancestor of the version
 * branch head, which may carry later non-tooling commits. Finishing never publishes to npm; it
 * returns the commit the remaining tag, GitHub release and branch steps run from.
 */
export async function finishGate({ receipt, commit, branchHead }, { registry = registryVersion, isAncestor } = {}) {
	if (receipt.commit !== commit) throw new Error("Finish mode needs the qualified receipt of this commit.");
	const published = await registry(receipt.name, receipt.version);
	if (!published)
		throw new Error(
			`Finish mode needs npm to serve ${receipt.name}@${receipt.version}; publish it through a release run.`,
		);
	requireIntegrity(published, receipt);
	if (!/^[a-f0-9]{40}$/u.test(branchHead ?? "")) throw new Error("The version branch head is unknown.");
	if (branchHead !== commit && !isAncestor(commit, branchHead))
		throw new Error(`The qualified commit ${commit} is not an ancestor of the version branch head ${branchHead}.`);
	console.log(`Finishing published ${receipt.version} from ${commit}; the version branch stays at ${branchHead}.`);
	return commit;
}

function gitAncestor(ancestor, descendant) {
	try {
		run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** The commit an origin branch names, or null when the branch does not exist. */
function originBranch(name) {
	return git("ls-remote", "--heads", "origin", `refs/heads/${name}`).split(/\s/u)[0] || null;
}

// The first release finds no main and no gh-pages on origin; its pushes create them.
function requireFastForward(commit) {
	const present = ["main", "gh-pages"].filter(originBranch);
	if (present.length) run("git", ["fetch", "origin", ...present]);
	if (present.includes("main")) run("git", ["merge-base", "--is-ancestor", "origin/main", commit], { stdio: "pipe" });
}

// A published release resolves by tag in one call. The by-tag endpoint never
// returns a draft (the 0.6.2-rc.1 run crashed on that null), and a draft this job
// creates is the newest release, so only the first page is searched for it. No
// lookup scales with release history: the 0.7.0 list call outgrew its buffer.
function existingRelease(tag) {
	try {
		return api(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
	} catch (error) {
		if (!String(error.stderr).includes("404")) throw error;
	}
	return (
		api(`repos/${repository}/releases?per_page=10`).find((release) => release.draft && release.tag_name === tag) ?? null
	);
}

function tagCommit(tag) {
	let object;
	try {
		object = api(`repos/${repository}/git/ref/tags/${tag}`).object;
	} catch (error) {
		if (String(error.stderr).includes("404")) return null;
		throw error;
	}
	for (let depth = 0; object.type === "tag" && depth < 5; depth++)
		object = api(`repos/${repository}/git/tags/${object.sha}`).object;
	if (object.type !== "commit") throw new Error("Release tag does not resolve to a commit.");
	return object.sha;
}

/**
 * The commit release.yml finishes from. It is the candidate, except that once npm serves the
 * candidate's bytes a version-branch head that only adds release-tooling commits may finish it
 * (item 3 of the 0.7.0 release): published npm bytes cannot change, so a tooling bug found after
 * publish is fixed by commit while the tag, tarball and website still come from the candidate.
 */
async function finishingHead(commit, receipt) {
	const head = process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_SHA : commit;
	if (head === commit) return head;
	if (!/^[a-f0-9]{40}$/u.test(head ?? "")) throw new Error("The workflow's source commit is unknown.");
	try {
		run("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "pipe" });
	} catch {
		throw new Error(`The dispatched head ${head} does not descend from the candidate ${commit}.`);
	}
	const paths = git("diff", "--name-only", commit, head).split("\n").filter(Boolean);
	if (!toolingOnly(paths))
		throw new Error(`Only release-tooling commits may follow the candidate; ${head} also changes:\n${paths.join("\n")}`);
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published)
		throw new Error(
			"A release-tooling fix may finish a release only after npm serves the candidate; release the candidate itself.",
		);
	requireIntegrity(published, receipt);
	console.log(`Finishing ${receipt.version} from ${head}, which adds only release-tooling changes to ${commit}.`);
	return head;
}

/**
 * Every finishing step in its read or plan form, run by the release preflight before the owner
 * publishes to npm and by the rehearsal (items 3 and 6), so a finishing bug surfaces while
 * nothing irreversible has happened.
 */
function finishCheck(directory, receipt, plan, head) {
	const notes = readFileSync(join(directory, "release-notes.md"), "utf8");
	if (notes.length > RELEASE_BODY_LIMIT)
		throw new Error(`Release notes are ${notes.length} characters; GitHub accepts at most ${RELEASE_BODY_LIMIT}.`);
	const decision = draftAction({ release: existingRelease(plan.tag), tagCommit: tagCommit(plan.tag) }, receipt.commit);
	if (decision.action === "stop") throw new Error(`GitHub release ${plan.tag}: ${decision.reason}.`);
	let site = "unchanged";
	if (plan.channel === "latest") {
		requireFastForward(head);
		site = publishWebsite(directory, receipt, { push: false });
	}
	console.log(
		`FINISH_CHECK_OK ${plan.tag} release=${decision.action} main=${plan.channel === "latest" ? `fast-forward to ${head}` : "unchanged"} site=${site}`,
	);
}

export async function preflight(directory, commit, runId, branch, rehearse = false, { check = true } = {}) {
	const receipt = verifyCandidate(directory, commit);
	await qualification(runId, commit, { inProgress: rehearse });
	if (String(receipt.run) !== String(runId)) throw new Error("Artifact belongs to another qualification run.");
	// ci (22) writes test-results.json and ci (24) test-results-24.json; both run the same tiers.
	const totals = [];
	for (const name of ["test-results.json", "test-results-24.json"]) {
		const path = join(directory, name);
		if (!existsSync(path)) throw new Error(`Qualification artifact lacks ${name}.`);
		const results = JSON.parse(readFileSync(path, "utf8"));
		if (
			results.commit !== commit ||
			results.sha256 !== receipt.files[basename(receipt.tarball)] ||
			!Number.isSafeInteger(results.total) ||
			results.total < 1 ||
			results.total + 3 > QUALIFICATION_TEST_BUDGET ||
			!["core", "gui", "package"].every(
				(tier) => Number.isSafeInteger(results.counts?.[tier]) && results.counts[tier] > 0,
			) ||
			Object.values(results.counts).reduce((sum, count) => sum + count, 0) !== results.total
		)
			throw new Error(`${name} does not describe this candidate or exceeds the test budget.`);
		if (
			results.installed?.panstoreVersion !== receipt.version ||
			!Array.isArray(results.installed.pankitServers) ||
			kitListProblems(results.installed.pankitServers).length > 0 ||
			!results.installed.pankitServeNode?.serverInfo?.name
		)
			throw new Error(`${name} does not record the installed package's panstore, pankit list and pankit serve checks.`);
		totals.push(results.total);
	}
	const mode = releaseMode();
	const plan = publicationPlan(receipt, branch);
	const remoteHead = () => git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/u)[0];
	let head;
	if (mode === "finish") {
		run("git", ["fetch", "origin", branch]);
		head = await finishGate({ receipt, commit, branchHead: remoteHead() }, { isAncestor: gitAncestor });
	} else head = rehearse ? commit : await finishingHead(commit, receipt);
	requireFastForward(head);
	if (!rehearse) {
		const changelog = run("tar", ["-xzOf", receipt.tarball, "package/CHANGELOG.md"], { encoding: "utf8", stdio: "pipe" });
		const errors = releaseVersionErrors({ version: receipt.version, changelog, releaseContext: true });
		const section = changelog.split(/^## /mu)[1];
		if (!section?.slice(section.indexOf("\n") + 1).trim()) errors.push("Release notes must not be empty.");
		const site = JSON.parse(readFileSync(join(root, "site/product.json"), "utf8"));
		if (plan.channel === "latest" && (site.version !== receipt.version || site.publishedVersion !== receipt.version))
			errors.push("Set site/product.json version and publishedVersion to the final release version before qualification.");
		if (errors.length) throw new Error(errors.join("\n"));
		// A check run comes from a rehearsal before the version branch is pushed.
		// Finish mode replaces this head-equality check with finishGate's ancestor check.
		if (mode !== "finish" && remoteHead() !== head && process.env.PANCODE_RELEASE_MODE !== "check")
			throw new Error("Version branch moved; prepare a release from its current head.");
		const tag = tagCommit(plan.tag);
		if (tag !== null && tag !== commit) throw new Error("Existing release tag points to another commit.");
		const published = await registryVersion(receipt.name, receipt.version);
		if (published) requireIntegrity(published, receipt);
		else if (tag !== null || existingRelease(plan.tag))
			throw new Error("An existing GitHub release has no matching npm version; resolve it explicitly.");
	}
	const summary = `PanCode ${plan.version}\nSource: ${commit}\nQualification: https://github.com/${repository}/actions/runs/${runId}\nPackage: ${plan.tarball}\nSHA-256: ${plan.sha256}\nTests: ${totals.join(" on Node 22, ")} on Node 24, plus runtime/platform boot checks\n\n${plan.channel === "beta" ? "Approval authorizes GitHub prerelease/tag creation for the owner-published npm beta version." : "Approval authorizes GitHub release/tag creation, main fast-forward, gh-pages deployment, and version-branch cleanup for the owner-published npm version."}\n`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	if (check) finishCheck(directory, receipt, plan, head);
	return { receipt, plan, head, mode };
}

function verifyAssets(release, receipt) {
	for (const name of [basename(receipt.tarball), ...installers]) {
		const asset = release.assets.find((item) => item.name === name);
		if (asset?.digest !== `sha256:${receipt.files[name]}`) throw new Error(`GitHub release asset differs: ${name}`);
	}
}

function publishWebsite(directory, receipt, { push = true } = {}) {
	const scratch = mkdtempSync(join(tmpdir(), "pancode-release-pages-"));
	const checkout = join(scratch, "branch");
	// The first deployment starts gh-pages as an orphan holding only the built site.
	const orphan = originBranch("gh-pages") ? null : `pancode-pages-${process.pid}`;
	try {
		if (orphan) {
			run("git", ["worktree", "add", "--detach", checkout, receipt.commit]);
			run("git", ["-C", checkout, "switch", "--quiet", "--orphan", orphan]);
		} else {
			run("git", ["fetch", "origin", "gh-pages"]);
			run("git", ["worktree", "add", "--detach", checkout, "origin/gh-pages"]);
		}
		for (const name of readdirSync(checkout))
			if (name !== ".git") rmSync(join(checkout, name), { recursive: true, force: true });
		run("tar", ["-xzf", join(directory, "website.tgz"), "-C", checkout]);
		const version = JSON.parse(readFileSync(join(checkout, "version.json"), "utf8"));
		if (
			version.publishedVersion !== receipt.version ||
			version.docsCommit !== receipt.commit ||
			version.revision !== receipt.commit
		)
			throw new Error("Prepared website differs from the candidate.");
		run("git", ["-C", checkout, "add", "-A"]);
		const changed = git("-C", checkout, "diff", "--cached", "--name-only");
		if (!push) return changed ? `${changed.split("\n").length} files to deploy` : "unchanged";
		if (changed) {
			const slug = releaseAppSlug();
			const user = api(`users/${slug}[bot]`);
			run("git", [
				"-C",
				checkout,
				"-c",
				`user.name=${slug}[bot]`,
				"-c",
				`user.email=${user.id}+${slug}[bot]@users.noreply.github.com`,
				"commit",
				"-m",
				`deploy: PanCode ${receipt.version} from ${receipt.commit.slice(0, 12)}`,
			]);
			run("git", ["-C", checkout, "push", "origin", "HEAD:refs/heads/gh-pages"]);
		}
	} finally {
		if (existsSync(checkout)) run("git", ["worktree", "remove", "--force", checkout]);
		if (orphan && git("branch", "--list", orphan)) run("git", ["branch", "-D", orphan]);
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function verifyPublic(receipt, plan, head = receipt.commit) {
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published) throw new Error("Published npm version is missing.");
	requireIntegrity(published, receipt);
	const tags = await registryTags(receipt.name);
	if (tags[plan.channel] !== receipt.version) throw new Error(`npm ${plan.channel} points to another version.`);
	const release = existingRelease(plan.tag);
	if (!release || release.draft || tagCommit(plan.tag) !== receipt.commit)
		throw new Error("GitHub release/tag is not public at the qualified commit.");
	verifyAssets(release, receipt);
	if (release.prerelease !== (plan.channel === "beta")) throw new Error("GitHub release channel differs from npm.");
	if (plan.channel === "latest" && api(`repos/${repository}/releases/latest`).tag_name !== plan.tag)
		throw new Error("GitHub Latest points to another release.");
	if (plan.channel === "latest") {
		if (api(`repos/${repository}/git/ref/heads/main`).object.sha !== head)
			throw new Error("main differs from the release.");
		for (let attempt = 0; attempt < 18; attempt++) {
			// A first deployment answers with errors, TLS ones included, until Pages serves the custom domain.
			const site = await fetch(`https://pancode.dev/version.json?release=${receipt.commit}`, {
				signal: AbortSignal.timeout(15_000),
			})
				.then((response) => (response.ok ? response.json() : null))
				.catch(() => null);
			if (
				site?.publishedVersion === receipt.version &&
				site.docsCommit === receipt.commit &&
				site.revision === receipt.commit
			)
				return;
			console.log("Waiting for the prepared gh-pages deployment...");
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
		throw new Error("Website has not reached the qualified release; resume publication without rebuilding.");
	}
}

export async function publish(directory, commit, runId, branch) {
	if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_WORKFLOW !== "release")
		throw new Error("Publication is restricted to the approved release.yml job.");
	if (process.env.PANCODE_RELEASE_MODE === "check") throw new Error("A check run never publishes.");
	releaseAppSlug();
	const { receipt, plan, head, mode } = await preflight(directory, commit, runId, branch, false, { check: false });
	// CI holds no npm credential: the owner publishes with two-factor approval inside
	// `pnpm run release` before this job writes anything to GitHub. An approval given
	// before npm serves the version waits here instead of failing; npm took 11 minutes
	// to serve 0.7.0 after accepting it.
	let published = await registryVersion(receipt.name, receipt.version);
	for (let minute = 0; !published && minute < NPM_WAIT_MINUTES; minute++) {
		console.log(`Waiting for npm to serve ${plan.package} (${minute} of ${NPM_WAIT_MINUTES} minutes)...`);
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		published = await registryVersion(receipt.name, receipt.version);
	}
	if (!published)
		throw new Error(
			`npm has no ${plan.package}. The owner publishes the qualified tarball through \`pnpm run release\`, then reruns this job.`,
		);
	requireIntegrity(published, receipt);
	console.log("npm contains the qualified bytes; continuing publication.");
	const assets = [receipt.tarball, ...installers.map((name) => join(directory, name))];
	let release = existingRelease(plan.tag);
	const decision = draftAction({ release, tagCommit: tagCommit(plan.tag) }, commit);
	if (decision.action === "stop") throw new Error(`GitHub release ${plan.tag}: ${decision.reason}.`);
	if (decision.action === "create") {
		run("gh", [
			"release",
			"create",
			plan.tag,
			"--repo",
			repository,
			"--draft",
			"--target",
			commit,
			"--title",
			`PanCode ${receipt.version}`,
			"--notes-file",
			join(directory, "release-notes.md"),
			...assets,
		]);
		release = existingRelease(plan.tag);
	} else if (release.draft) {
		// A draft keeps the target it was created with, and publishing it creates the
		// immutable tag there, so an earlier attempt's draft is pinned first (item 5).
		if (decision.action === "retarget") {
			api(`repos/${repository}/releases/${release.id}`, "PATCH", { target_commitish: commit });
			release = api(`repos/${repository}/releases/${release.id}`);
		}
		run("gh", ["release", "upload", plan.tag, "--repo", repository, "--clobber", ...assets]);
		release = api(`repos/${repository}/releases/${release.id}`);
	}
	if (!release) throw new Error(`GitHub release ${plan.tag} was not found after creating it.`);
	console.log(
		`GitHub release ${plan.tag}: id ${release.id}, draft ${release.draft}, target ${release.target_commitish}`,
	);
	verifyAssets(release, receipt);
	if (release.draft) {
		if (release.target_commitish !== commit)
			throw new Error(`Draft ${plan.tag} targets ${release.target_commitish}, not ${commit}.`);
		run("gh", [
			"release",
			"edit",
			plan.tag,
			"--repo",
			repository,
			"--draft=false",
			...(plan.channel === "beta" ? ["--prerelease", "--latest=false"] : ["--latest"]),
		]);
	}
	if (tagCommit(plan.tag) !== commit) throw new Error("Published tag differs from the qualified commit.");
	if (plan.channel === "latest") {
		requireFastForward(head);
		run("git", ["push", "origin", `${head}:refs/heads/main`]);
		publishWebsite(directory, receipt);
		await verifyPublic(receipt, plan, head);
		// A lease makes cleanup a compare-and-delete operation. A concurrent
		// development commit is preserved instead of being deleted with the branch.
		// Finish mode leaves the version branch's later commits in place.
		// The first release's version branch is the default branch, which GitHub refuses to delete.
		if (mode !== "finish" && api(`repos/${repository}`).default_branch === branch)
			console.log(`${branch} is the default branch. Make main the default branch, then delete ${branch} on origin.`);
		else if (mode !== "finish")
			run("git", ["push", `--force-with-lease=refs/heads/${branch}:${head}`, "origin", `:refs/heads/${branch}`]);
	} else await verifyPublic(receipt, plan);
	console.log(`RELEASE_COMPLETE ${receipt.version} ${commit}${head === commit ? "" : ` finished from ${head}`}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({
			options: {
				directory: { type: "string" },
				sha: { type: "string" },
				run: { type: "string" },
				mode: { type: "string" },
				branch: { type: "string" },
			},
			allowPositionals: true,
		});
		const directory = resolve(values.directory ?? "");
		if (values.mode) process.env.PANCODE_RELEASE_MODE = values.mode;
		if (positionals[0] === "plan" || positionals[0] === "verify-bytes") {
			if (!values.sha || !values.branch) throw new Error("Supply --sha and --branch.");
			if (positionals[0] === "verify-bytes") await rehearseBytes(directory, values.sha, values.branch);
			else console.log(JSON.stringify(publicationPlan(verifyCandidate(directory, values.sha), values.branch), null, 2));
			process.exit(0);
		}
		if (!values.sha || !values.run || !values.branch) throw new Error("Supply --sha, --run, and --branch.");
		if (positionals[0] === "publish") await publish(directory, values.sha, values.run, values.branch);
		else if (positionals[0] === "verify") await preflight(directory, values.sha, values.run, values.branch);
		else if (positionals[0] === "rehearse-preflight")
			await preflight(directory, values.sha, values.run, values.branch, true);
		else if (positionals[0] === "rehearse") {
			const started = performance.now();
			const result = await preflight(directory, values.sha, values.run, values.branch, true);
			await rehearseBytes(directory, values.sha, values.branch);
			console.log(`REHEARSAL_OK ${JSON.stringify(result.plan)} elapsedMs=${Math.round(performance.now() - started)}`);
		} else
			throw new Error(
				"Usage: release-publish.mjs verify|publish|rehearse --directory <path> --sha <commit> --run <id> --branch <version branch>",
			);
	} catch (error) {
		console.error(`release-publish: ${error.message}`);
		process.exitCode = 1;
	}
}
