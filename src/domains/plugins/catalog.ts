// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { gitVia } from "../../core/internal-git-run.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { isPluginId } from "../../core/plugin-id.js";
import { runStagingCommandSync } from "../../core/safe-exec.js";
import { isSemanticVersion } from "../extensions/compatibility.js";
import {
	HUB_PROVIDES_LIMITS,
	HUB_TIERS,
	type HubPackEntry,
	type HubProvidedResource,
	type HubRequirementRef,
	type HubRowSource,
	type HubTier,
	isHubAuditState,
	isHubComponentKind,
	isHubKind,
} from "./hub-types.js";
import { pluginContentDigest } from "./integrity.js";

export type PluginCatalogEntry = HubPackEntry;

export interface PluginSource {
	root: string;
	cleanup: () => void;
	/** The exact commit a remote source was fetched at; absent for a local directory. */
	commit?: string;
}

/** A commit is named only by its full lowercase SHA-1; a short or uppercase name could be ambiguous. */
const HUB_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const HUB_PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** Explicit GitHub tree URLs identify both the revision and the bundle directory. */
export function parsePluginGithubSource(
	source: string,
): { url: string; ref: string; subdir: string; owner: string } | undefined {
	const match =
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([A-Za-z0-9_.-]+)(?:\/(.*?))?\/?$/.exec(source);
	if (!match?.[1] || !match[2] || !match[3]) return undefined;
	const subdir = match[4] ?? "";
	if (!safeSubdir(subdir)) return undefined;
	return { url: `https://github.com/${match[1]}/${match[2]}.git`, ref: match[3], subdir, owner: match[1] };
}

function safeSubdir(subdir: string): boolean {
	return (
		!subdir.startsWith("/") &&
		!subdir.split("/").some((part) => part === ".." || part === ".") &&
		!subdir.includes("\\") &&
		!subdir.includes("\0")
	);
}

/** The GitHub owner a repository URL names, lowercased as a publisher, or undefined for another host. */
export function githubOwnerOf(repo: string): string | undefined {
	const owner = (GITHUB_REPO.exec(repo) ?? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\//.exec(repo))?.[1]?.toLowerCase();
	return owner && HUB_PUBLISHER_PATTERN.test(owner) ? owner : undefined;
}

/** The tree URL a community row is shown and recorded as: the repository at its exact commit. */
function hubSourceUrl(source: HubRowSource): string {
	const repo = source.repo.replace(/\.git$/u, "").replace(/\/$/u, "");
	return `${repo}/tree/${source.commit}${source.subdir ? `/${source.subdir}` : ""}`;
}

export function pluginLocalPath(source: string, cwd = process.cwd()): string {
	return path.resolve(cwd, source.startsWith("~/") ? path.join(homedir(), source.slice(2)) : source);
}

const GIT_OPTIONS = {
	timeoutMs: 120_000,
	maxOutputBytes: 1_000_000,
	env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
} as const;

function fetchableRepo(repo: string): boolean {
	return /^https:\/\/[^\s]+$/u.test(repo) || /^file:\/\/[^\s]+$/u.test(repo);
}

/**
 * Resolve a tag or branch name to the commit it names now, once, so the install
 * records that commit. A peeled tag wins over the tag object, and a tag wins
 * over a branch of the same name.
 */
function resolveGitRef(repo: string, ref: string): string {
	if (HUB_COMMIT_PATTERN.test(ref)) return ref;
	if (!fetchableRepo(repo)) throw new Error(`unsupported repository URL: ${repo}`);
	const output = gitVia(runStagingCommandSync, ["ls-remote", "--exit-code", "--", repo, ref], GIT_OPTIONS);
	const refs = new Map<string, string>();
	for (const line of output.split("\n")) {
		const [commit, name] = line.trim().split(/\s+/u);
		if (commit && name && HUB_COMMIT_PATTERN.test(commit)) refs.set(name, commit);
	}
	const commit = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`) ?? refs.get(`refs/heads/${ref}`);
	if (!commit) throw new Error(`no tag or branch ${ref} in ${repo}`);
	return commit;
}

/**
 * Fetch exactly one commit into a fresh stage under TMPDIR, with hooks off and
 * nothing run from the tree. The checkout must name the requested commit, and
 * with `expectedSha256` the package directory's tree digest must equal it
 * before the caller sees the root.
 */
export function fetchPluginCommit(source: HubRowSource, expectedSha256?: string): PluginSource {
	if (!HUB_COMMIT_PATTERN.test(source.commit))
		throw new Error(`commit must be 40 lowercase hex characters: ${source.commit}`);
	if (!fetchableRepo(source.repo)) throw new Error(`unsupported repository URL: ${source.repo}`);
	if (!safeSubdir(source.subdir)) throw new Error(`unsafe pack directory: ${source.subdir}`);
	const temp = mkdtempSync(path.join(tmpdir(), "pancode-plugin-"));
	const cleanup = (): void => rmSync(temp, { recursive: true, force: true });
	try {
		gitVia(runStagingCommandSync, ["init", "-q", temp], GIT_OPTIONS);
		gitVia(
			runStagingCommandSync,
			[
				"-C",
				temp,
				"-c",
				"core.hooksPath=/dev/null",
				"fetch",
				"--depth",
				"1",
				"--no-tags",
				"--",
				source.repo,
				source.commit,
			],
			GIT_OPTIONS,
		);
		gitVia(
			runStagingCommandSync,
			[
				"-C",
				temp,
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"advice.detachedHead=false",
				"checkout",
				"--detach",
				"FETCH_HEAD",
			],
			GIT_OPTIONS,
		);
		const head = gitVia(runStagingCommandSync, ["-C", temp, "rev-parse", "HEAD"], GIT_OPTIONS).trim();
		if (head !== source.commit) throw new Error(`fetched ${head || "nothing"} where ${source.commit} was requested`);
		const root = source.subdir ? path.join(temp, source.subdir) : temp;
		if (!existsSync(root) || !statSync(root).isDirectory())
			throw new Error(`plugin source has no directory ${source.subdir || "."} at ${source.commit}`);
		if (!isSameOrDescendant(realpathSync(root), realpathSync(temp))) throw new Error("plugin source escapes repository");
		// Repository metadata is transport state, not part of a root-level package.
		if (!source.subdir) rmSync(path.join(temp, ".git"), { recursive: true, force: true });
		if (expectedSha256 !== undefined && pluginContentDigest(root) !== expectedSha256)
			throw new Error(`plugin_pin_mismatch: ${source.subdir || source.repo} at ${source.commit}`);
		return { root, cleanup, commit: source.commit };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/**
 * A local directory, or a GitHub tree URL fetched at one exact commit. A
 * 40-hex ref is the commit; any other ref is resolved once through ls-remote.
 */
export function fetchPluginSource(source: string, cwd = process.cwd()): PluginSource {
	const local = pluginLocalPath(source, cwd);
	if (existsSync(local)) return { root: local, cleanup: () => {} };
	const remote = parsePluginGithubSource(source);
	if (!remote)
		throw new Error(
			`unsupported plugin source: ${source}; use a local directory or https://github.com/owner/repo/tree/ref/path`,
		);
	return fetchPluginCommit({ repo: remote.url, commit: resolveGitRef(remote.url, remote.ref), subdir: remote.subdir });
}

const PROVIDED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Parse optional `provides` hints. A malformed hint list is dropped with a
 * diagnostic and the row stays valid: hints support discovery, never admission,
 * so a bad hint must not hide an otherwise installable package.
 */
function providedResources(value: unknown, name: string, diagnostics: string[]): HubProvidedResource[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > HUB_PROVIDES_LIMITS.entries) {
		diagnostics.push(`The hub index provides ignored (not a bounded list): ${name}`);
		return undefined;
	}
	const hints: HubProvidedResource[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
		if (
			!item ||
			!(isHubComponentKind(item.kind) || item.kind === "extension") ||
			typeof item.name !== "string" ||
			item.name.length > HUB_PROVIDES_LIMITS.name ||
			!PROVIDED_NAME.test(item.name) ||
			(item.description !== undefined &&
				(typeof item.description !== "string" || item.description.length > HUB_PROVIDES_LIMITS.description))
		) {
			diagnostics.push(`The hub index provides ignored (malformed hint): ${name}`);
			return undefined;
		}
		const key = `${item.kind}:${item.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		hints.push({
			kind: item.kind,
			name: item.name,
			...(typeof item.description === "string" ? { description: item.description } : {}),
		});
	}
	return hints;
}

/**
 * How much a row is trusted to say. The bundled index and the verified remote
 * index are PanCode's own and hold the strict schema; the operator's private,
 * project and `--catalog` indexes keep today's looser rules, and their tier is
 * never honoured because trust follows the origin there.
 */
export type HubIndexMode = "bundled" | "remote" | "operator";

/** Licences a `verified` row may carry. */
export const HUB_VERIFIED_LICENSES: ReadonlySet<string> = new Set([
	"MIT",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	"MPL-2.0",
	"CC-BY-4.0",
	"CC0-1.0",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const SPDX = /^[A-Za-z0-9.+:() -]{1,128}$/u;

function readRowSource(value: unknown, mode: HubIndexMode): HubRowSource | string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "source must be { repo, commit, subdir }";
	const item = value as Record<string, unknown>;
	const keys = Object.keys(item).filter((key) => !["repo", "commit", "subdir"].includes(key));
	if (keys.length > 0) return `source has unknown field(s): ${keys.join(", ")}`;
	if (typeof item.repo !== "string") return "source.repo is required";
	const github = GITHUB_REPO.test(item.repo);
	if (!github && !(mode === "operator" && /^file:\/\/\S+$/u.test(item.repo)))
		return `source.repo must be https://github.com/<owner>/<repo>: ${item.repo}`;
	if (typeof item.commit !== "string" || !HUB_COMMIT_PATTERN.test(item.commit))
		return "source.commit must be 40 lowercase hex characters";
	const subdir = item.subdir === undefined ? "" : item.subdir;
	if (typeof subdir !== "string" || !safeSubdir(subdir))
		return "source.subdir must be a relative path inside the repository";
	return { repo: item.repo.replace(/\/$/u, ""), commit: item.commit, subdir: subdir.replace(/\/$/u, "") };
}

/**
 * The Part of a row that decides where it comes from and who answers for it.
 * Returns the problems that make the row unusable in `mode`; empty means the
 * row may be offered.
 */
function hubRowProblems(item: Record<string, unknown>, mode: HubIndexMode): string[] {
	const problems: string[] = [];
	const strict = mode !== "operator";
	const hasSource = item.source !== undefined;
	const hasUrl = item.sourceUrl !== undefined;
	if (hasSource === hasUrl) problems.push("a row has exactly one of source and sourceUrl");
	if (hasSource) {
		const source = readRowSource(item.source, mode);
		if (typeof source === "string") problems.push(source);
	}
	if (hasUrl && (typeof item.sourceUrl !== "string" || item.sourceUrl.trim().length === 0))
		problems.push("sourceUrl must be a non-empty string");
	if (
		item.publisher !== undefined &&
		(typeof item.publisher !== "string" || !HUB_PUBLISHER_PATTERN.test(item.publisher))
	)
		problems.push("publisher must be a lowercase GitHub owner name");
	if (item.license !== undefined && (typeof item.license !== "string" || !SPDX.test(item.license)))
		problems.push("license must be an SPDX expression of at most 128 characters");
	if (item.tier !== undefined && !HUB_TIERS.includes(item.tier as HubTier))
		problems.push("tier must be core, verified or listed");
	for (const field of ["envelopeDigest", "mcpDigest"] as const)
		if (item[field] !== undefined && (typeof item[field] !== "string" || !SHA256.test(item[field] as string)))
			problems.push(`${field} must be a SHA-256 digest`);
	if (item.envelopeDigest !== undefined && item.kind !== "extension")
		problems.push("only an extension row has envelopeDigest");
	if (item.default !== undefined && item.default !== true) problems.push("default is true or absent");
	if (item.default === true && hasSource) problems.push("only a first-party row is installed by default");
	if (!strict) return problems;
	if (typeof item.publisher !== "string") problems.push("publisher is required");
	if (item.tier === undefined) problems.push("tier is required");
	if (hasUrl && typeof item.sourceUrl === "string") {
		const url = item.sourceUrl;
		if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(url) || path.isAbsolute(url) || path.win32.isAbsolute(url))
			problems.push(`sourceUrl must be relative to the index: ${url}`);
		else if (!url.startsWith("packs/") || url.split("/").some((part) => part === ".." || part === "."))
			problems.push(`sourceUrl must name a directory under packs/: ${url}`);
		if (item.publisher !== "pancode") problems.push("a first-party row has publisher pancode");
		if (item.tier !== undefined && item.tier !== "core") problems.push("a first-party row has tier core");
	}
	if (hasSource) {
		if (item.publisher === "pancode") problems.push("a community row names its own publisher, not pancode");
		if (item.tier === "core") problems.push("a core row comes from packs/, not a community source");
		if (typeof item.license !== "string") problems.push("a community row has a license");
		if (item.tier === "verified" && typeof item.license === "string" && !HUB_VERIFIED_LICENSES.has(item.license))
			problems.push(`a verified row's license is on the allowlist, not ${item.license}`);
	}
	return problems;
}

export interface HubCatalogReadOptions {
	mode?: HubIndexMode;
	/** Where a relative sourceUrl resolves; defaults to the index file's directory. */
	packsRoot?: string;
}

/** Parse index rows already read from YAML. Shared by every index reader and the pin and review scripts. */
export function parseHubIndexRows(
	parsed: unknown,
	file: string,
	diagnostics: string[],
	options: HubCatalogReadOptions = {},
): HubPackEntry[] {
	const mode = options.mode ?? "operator";
	const base = options.packsRoot ?? path.dirname(file);
	const rows: unknown[] | undefined = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
			? (parsed as { entries: unknown[] }).entries
			: undefined;
	if (!rows) throw new Error("The hub index must be a list or contain an entries list");
	const seen = new Set<string>();
	return rows.flatMap((row): HubPackEntry[] => {
		if (!row || typeof row !== "object") {
			diagnostics.push(`The hub index entry malformed: ${file}`);
			return [];
		}
		const item = row as Record<string, unknown>;
		const declaresSource = item.source !== undefined;
		if (
			!isHubKind(item.kind) ||
			typeof item.name !== "string" ||
			!isPluginId(item.name) ||
			typeof item.description !== "string" ||
			(!declaresSource && (typeof item.sourceUrl !== "string" || item.sourceUrl.trim().length === 0)) ||
			!isSemanticVersion(item.version) ||
			typeof item.sha256 !== "string" ||
			!SHA256.test(item.sha256)
		) {
			diagnostics.push(
				`The hub index entry requires name, description, source or sourceUrl, version, and full-tree sha256: ${String(item.name ?? file)}`,
			);
			return [];
		}
		const problems = hubRowProblems(item, mode);
		if (problems.length > 0) {
			diagnostics.push(`The hub index row dropped (${item.kind}:${item.name}): ${problems.join("; ")}`);
			return [];
		}
		const identity = `${item.kind}:${item.name}`;
		if (mode !== "operator") {
			if (seen.has(identity)) {
				diagnostics.push(`The hub index row dropped (${item.kind}:${item.name}): a second row with the same kind and name`);
				return [];
			}
			seen.add(identity);
		}
		if (
			item.requires !== undefined &&
			(!Array.isArray(item.requires) || item.requires.some((ref) => typeof ref !== "string"))
		) {
			diagnostics.push(`hub_requirement_malformed: ${item.name}`);
			return [];
		}
		const source = declaresSource ? (readRowSource(item.source, mode) as HubRowSource) : undefined;
		const sourceUrlText = typeof item.sourceUrl === "string" ? item.sourceUrl : "";
		const remote = !source && /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(sourceUrlText);
		if (remote && !parsePluginGithubSource(sourceUrlText)) {
			diagnostics.push(`unsupported hub index source: ${sourceUrlText}`);
			return [];
		}
		const provides = providedResources(item.provides, item.name, diagnostics);
		if (
			item.plugin !== undefined &&
			(item.kind !== "extension" || typeof item.plugin !== "string" || !isPluginId(item.plugin))
		) {
			diagnostics.push(`The hub index plugin ignored (only an extension names a plugin it serves): ${item.name}`);
		}
		const serves =
			item.kind === "extension" && typeof item.plugin === "string" && isPluginId(item.plugin) ? item.plugin : undefined;
		const verbs =
			item.kind === "extension" && Array.isArray(item.verbs)
				? item.verbs.filter((verb): verb is string => typeof verb === "string" && /^[a-z][a-z0-9-]*$/u.test(verb))
				: [];
		const publisher =
			typeof item.publisher === "string"
				? item.publisher
				: source
					? githubOwnerOf(source.repo)
					: remote
						? parsePluginGithubSource(sourceUrlText)?.owner.toLowerCase()
						: undefined;
		return [
			{
				kind: item.kind,
				name: item.name,
				description: item.description,
				sourceUrl: source ? hubSourceUrl(source) : remote ? sourceUrlText : path.resolve(base, sourceUrlText),
				version: item.version,
				sha256: item.sha256,
				origin: "catalog",
				...(source ? { source } : {}),
				...(publisher && HUB_PUBLISHER_PATTERN.test(publisher) ? { publisher } : {}),
				...(typeof item.license === "string" ? { license: item.license } : {}),
				...(mode !== "operator" && typeof item.tier === "string" ? { tier: item.tier as HubTier } : {}),
				...(typeof item.envelopeDigest === "string" ? { envelopeDigest: item.envelopeDigest } : {}),
				...(typeof item.mcpDigest === "string" ? { mcpDigest: item.mcpDigest } : {}),
				...(mode === "bundled" && item.default === true ? { default: true as const } : {}),
				...(typeof item.category === "string" ? { category: item.category } : {}),
				...(isHubAuditState(item.audit) ? { audit: item.audit } : {}),
				...(Array.isArray(item.triggers)
					? { triggers: item.triggers.filter((value): value is string => typeof value === "string") }
					: {}),
				...(Array.isArray(item.requires) ? { requires: item.requires as HubRequirementRef[] } : {}),
				...(serves ? { plugin: serves } : {}),
				...(verbs.length > 0 ? { verbs } : {}),
				...(provides ? { provides } : {}),
				index: path.resolve(file),
			},
		];
	});
}

export function readPluginCatalog(
	file: string,
	diagnostics: string[],
	options: HubCatalogReadOptions = {},
): HubPackEntry[] {
	if (!existsSync(file)) return [];
	try {
		return parseHubIndexRows(parseYaml(readFileSync(file, "utf8")), file, diagnostics, options);
	} catch (error) {
		diagnostics.push(`The hub index unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** The index shipped inside this PanCode package; rows from it are the only "bundled" evidence. */
export function bundledHubIndexPath(): string {
	return path.join(resolvePackageRoot(), "hub", "index.yaml");
}

export function bundledPluginCatalog(diagnostics: string[]): HubPackEntry[] {
	try {
		return readPluginCatalog(bundledHubIndexPath(), diagnostics, { mode: "bundled" });
	} catch (error) {
		diagnostics.push(`The hub index unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
