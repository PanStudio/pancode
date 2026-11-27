// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Review every community row file that differs from a base ref.
 *
 *   node --import tsx scripts/hub-review.ts --base <ref> [--submission] [--json]
 *
 * Each row's commit is fetched as untrusted data (hooks off, nothing in the
 * tree runs), validated, and its digests recomputed. Schema, path, digest,
 * licence and launcher-pin failures fail the review. Envelope growth, the
 * command a server pack launches and body scan hits are findings a reviewer
 * reads; they do not fail it. With
 * `--submission`, a change to more than one row file or to anything outside
 * `hub/community/` fails. Output goes to stdout and, when set, to
 * `$GITHUB_STEP_SUMMARY`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { reviewExtensionEnvelope } from "../src/domains/extensions/envelope-review.js";
import { fetchPluginCommit, type PluginSource } from "../src/domains/plugins/catalog.js";
import type { HubRowSource, HubTier } from "../src/domains/resources/hub-types.js";
import { type HubPackageValidationResult, validateHubPackage } from "../src/domains/resources/hub-validation.js";
import { buildRegistryRow, packLicense, type RegistryRow, rowFileProblems } from "./pin-hub-remote.js";

const ROW_FILE = /^hub\/community\/([^/]+)\/([^/]+)\.yaml$/;

export interface ReviewFailure {
	file: string;
	row?: string;
	message: string;
}

export interface ReviewFinding {
	file: string;
	row: string;
	kind: "envelope-added" | "envelope-removed" | "server-launch" | "body-scan";
	message: string;
}

export interface HubReviewResult {
	ok: boolean;
	reviewed: string[];
	failures: ReviewFailure[];
	findings: ReviewFinding[];
}

/** One changed path: its content now (absent when deleted) and at the base (absent when new). */
export interface ChangedFile {
	file: string;
	content?: string;
	baseContent?: string;
}

export interface HubReviewDeps {
	fetchPluginCommit: (source: HubRowSource) => PluginSource;
	validateHubPackage: (root: string) => HubPackageValidationResult;
}

const defaultDeps: HubReviewDeps = { fetchPluginCommit, validateHubPackage };

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

function exactPythonSpec(spec: string): boolean {
	const match = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:==|@)(.+)$/.exec(spec);
	return !!match?.[1] && EXACT_VERSION.test(match[1]);
}

function exactNodeSpec(spec: string): boolean {
	const match = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(.+)$/.exec(spec);
	return !!match?.[1] && EXACT_VERSION.test(match[1]);
}

/**
 * Every `uvx` or `npx` launch in a pack's `mcp.json` that does not name an exact
 * version: `pkg==x.y.z`, `--from pkg==x.y.z`, or `pkg@x.y.z`.
 */
export function unpinnedLaunches(root: string): string[] {
	const file = path.join(root, "mcp.json");
	if (!existsSync(file)) return [];
	let parsed: { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
	} catch (error) {
		return [`mcp.json: ${error instanceof Error ? error.message : String(error)}`];
	}
	const problems: string[] = [];
	for (const [id, server] of Object.entries(parsed.mcpServers ?? {})) {
		if (typeof server?.command !== "string") continue;
		const launcher = path.basename(server.command);
		if (launcher !== "uvx" && launcher !== "npx") continue;
		const args = Array.isArray(server.args) ? server.args.map(String) : [];
		let spec: string | undefined;
		if (launcher === "uvx") {
			const from = args.indexOf("--from");
			spec = from >= 0 ? args[from + 1] : args.find((arg) => !arg.startsWith("-"));
			if (!spec || !exactPythonSpec(spec))
				problems.push(`mcpServers.${id}: uvx ${spec ?? "(no package)"} names no exact version`);
		} else {
			const flag = args.findIndex((arg) => arg === "-p" || arg === "--package");
			spec = flag >= 0 ? args[flag + 1] : args.find((arg) => !arg.startsWith("-"));
			if (!spec || !exactNodeSpec(spec))
				problems.push(`mcpServers.${id}: npx ${spec ?? "(no package)"} names no exact version`);
		}
	}
	return problems;
}

/** The command line a server pack's one server runs, with its directory when it names one. */
export function serverLaunch(root: string): string | undefined {
	let parsed: { mcpServers?: Record<string, { command?: unknown; args?: unknown; cwd?: unknown }> };
	try {
		parsed = JSON.parse(readFileSync(path.join(root, "mcp.json"), "utf8")) as typeof parsed;
	} catch {
		return undefined;
	}
	const [server] = Object.values(parsed.mcpServers ?? {});
	if (typeof server?.command !== "string") return undefined;
	const args = Array.isArray(server.args) ? server.args.map(String) : [];
	return [server.command, ...args].join(" ") + (typeof server.cwd === "string" ? ` (in ${server.cwd})` : "");
}

/** Text in a skill or prompt body that addresses the host rather than the task. */
const HOST_DIRECTED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{
		label: "overrides earlier instructions",
		pattern:
			/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above|other)\s+instructions\b/i,
	},
	{
		label: "addresses the system prompt",
		pattern: /\b(?:ignore|override|replace|reveal|print|change|bypass)\s+(?:the\s+|your\s+)?system\s+prompt\b/i,
	},
	{
		label: "changes settings or trust",
		pattern:
			/\b(?:edit|change|modify|disable|turn\s+off|bypass|raise)\s+(?:the\s+|your\s+)?(?:pancode\s+|host\s+|agent\s+)?(?:settings|configuration|trust|permissions?|sandbox|approvals?)\b|\btrustProjectImports\b/i,
	},
	{
		label: "pipes a download to a shell",
		pattern:
			/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i,
	},
];

function bodyFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (directory: string, inPrompts: boolean): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(full, inPrompts || entry.name === "prompts");
			else if (entry.isFile() && (entry.name === "SKILL.md" || (inPrompts && entry.name.endsWith(".md")))) out.push(full);
		}
	};
	walk(root, false);
	return out.sort();
}

/** Lines in skill and prompt bodies that look aimed at the host. */
export function scanBodies(root: string): string[] {
	const hits: string[] = [];
	for (const file of bodyFiles(root)) {
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		lines.forEach((line, index) => {
			for (const { label, pattern } of HOST_DIRECTED)
				if (pattern.test(line))
					hits.push(`${path.relative(root, file)}:${index + 1}: ${label}: ${line.trim().slice(0, 160)}`);
		});
	}
	return hits;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function rowsOf(content: string | undefined): RegistryRow[] {
	if (content === undefined) return [];
	try {
		const parsed = parse(content) as { rows?: unknown } | null;
		return Array.isArray(parsed?.rows) ? (parsed.rows as RegistryRow[]) : [];
	} catch {
		return [];
	}
}

function fetchFailure(error: unknown): string {
	return `fetch or validation failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Review a set of changed paths. Pure apart from `deps`, so tests stage trees without a network. */
export function reviewHubChanges(
	changed: ReadonlyArray<ChangedFile>,
	options: { submission?: boolean; deps?: HubReviewDeps } = {},
): HubReviewResult {
	const deps = options.deps ?? defaultDeps;
	const failures: ReviewFailure[] = [];
	const findings: ReviewFinding[] = [];
	const reviewed: string[] = [];
	const rowFiles = changed.filter((item) => ROW_FILE.test(item.file));
	if (options.submission) {
		const outside = changed.filter((item) => !item.file.startsWith("hub/community/"));
		for (const item of outside)
			failures.push({ file: item.file, message: "a submission changes only its row file under hub/community/" });
		if (rowFiles.length > 1)
			failures.push({
				file: rowFiles.map((item) => item.file).join(", "),
				message: `a submission changes one row file, not ${rowFiles.length}`,
			});
	}
	for (const item of changed)
		if (item.file.startsWith("hub/community/") && !ROW_FILE.test(item.file) && item.file !== "hub/community/README.md")
			failures.push({ file: item.file, message: "hub/community/ holds <publisher>/<name>.yaml row files only" });
	for (const item of rowFiles) {
		const [, publisher = "", name = ""] = ROW_FILE.exec(item.file) ?? [];
		if (item.content === undefined) {
			reviewed.push(item.file);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = parse(item.content);
		} catch (error) {
			failures.push({ file: item.file, message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const problems = rowFileProblems(item.file, publisher, name, parsed);
		for (const message of problems) failures.push({ file: item.file, message });
		if (problems.length) continue;
		reviewed.push(item.file);
		const baseRows = rowsOf(item.baseContent);
		for (const row of (parsed as { rows: RegistryRow[] }).rows) {
			const ref = `${row.kind}:${row.name}`;
			const source = row.source as HubRowSource;
			let fetched: PluginSource | undefined;
			let previous: PluginSource | undefined;
			try {
				fetched = deps.fetchPluginCommit(source);
				const result = deps.validateHubPackage(fetched.root);
				if (!result.valid || !result.manifest) {
					const messages = [
						...result.diagnostics.map((d) => d.message),
						...result.validation.diagnostics.filter((d) => d.severity === "error").map((d) => `[${d.code}] ${d.message}`),
					];
					failures.push({ file: item.file, row: ref, message: messages.join("; ") || "package failed validation" });
					continue;
				}
				if (result.manifest.pancode.kind === "server" && existsSync(path.join(fetched.root, "server.json"))) {
					failures.push({
						file: item.file,
						row: ref,
						message: "a community server pack must declare its server in mcp.json, not server.json",
					});
					continue;
				}
				const regenerated = buildRegistryRow(
					fetched.root,
					result,
					{ source },
					typeof row.category === "string" ? row.category : undefined,
					{ publisher: row.publisher as string, tier: row.tier as HubTier, license: row.license as string },
				);
				for (const field of Object.keys(row))
					if (!sameValue(row[field], regenerated[field]))
						failures.push({
							file: item.file,
							row: ref,
							message: `${field} is ${JSON.stringify(regenerated[field] ?? null)} at ${source.commit}, the row states ${JSON.stringify(row[field])}`,
						});
				const manifestLicense = packLicense(fetched.root, result);
				if (manifestLicense !== undefined && manifestLicense !== row.license)
					failures.push({
						file: item.file,
						row: ref,
						message: `the pack declares license ${manifestLicense}, the row states ${String(row.license)}`,
					});
				for (const message of unpinnedLaunches(fetched.root)) failures.push({ file: item.file, row: ref, message });
				if (row.kind === "extension") {
					const before = baseRows.find((candidate) => candidate.kind === row.kind && candidate.name === row.name);
					const beforeSource = before?.source as HubRowSource | undefined;
					if (beforeSource && !sameValue(beforeSource, source)) {
						try {
							previous = deps.fetchPluginCommit(beforeSource);
							const added = reviewExtensionEnvelope(fetched.root, previous.root)?.growth ?? [];
							const removed = reviewExtensionEnvelope(previous.root, fetched.root)?.growth ?? [];
							for (const message of added) findings.push({ file: item.file, row: ref, kind: "envelope-added", message });
							for (const message of removed) findings.push({ file: item.file, row: ref, kind: "envelope-removed", message });
						} catch (error) {
							findings.push({
								file: item.file,
								row: ref,
								kind: "envelope-added",
								message: `the base commit ${beforeSource.commit} could not be fetched to compare envelopes: ${error instanceof Error ? error.message : String(error)}`,
							});
						}
					} else if (!beforeSource) {
						const review = reviewExtensionEnvelope(fetched.root);
						if (review)
							findings.push({
								file: item.file,
								row: ref,
								kind: "envelope-added",
								message: `new extension; envelope sha256 ${review.digest}`,
							});
					}
				}
				if (row.kind === "server")
					findings.push({
						file: item.file,
						row: ref,
						kind: "server-launch",
						message: `runs ${serverLaunch(fetched.root) ?? "no command"}`,
					});
				for (const message of scanBodies(fetched.root))
					findings.push({ file: item.file, row: ref, kind: "body-scan", message });
			} catch (error) {
				failures.push({ file: item.file, row: ref, message: fetchFailure(error) });
			} finally {
				fetched?.cleanup();
				previous?.cleanup();
			}
		}
	}
	return { ok: failures.length === 0, reviewed, failures, findings };
}

function git(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout;
}

/** Paths that differ between the merge base with `base` and the working tree, with both contents. */
export function changedSince(root: string, base: string): ChangedFile[] {
	const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
	const names = new Set(
		[
			...git(root, ["diff", "--name-only", "--no-renames", mergeBase, "--"]).split("\n"),
			...git(root, ["ls-files", "--others", "--exclude-standard", "--", "hub/community"]).split("\n"),
		].filter(Boolean),
	);
	return [...names].sort().map((file) => {
		const full = path.join(root, file);
		const shown = spawnSync("git", ["show", `${mergeBase}:${file}`], { cwd: root, encoding: "utf8" });
		return {
			file,
			...(existsSync(full) ? { content: readFileSync(full, "utf8") } : {}),
			...(shown.status === 0 ? { baseContent: shown.stdout } : {}),
		};
	});
}

export function renderReview(result: HubReviewResult): string {
	const lines = [`## PanHub review: ${result.ok ? "pass" : "fail"}`, ""];
	lines.push(`Reviewed: ${result.reviewed.length ? result.reviewed.join(", ") : "no row files"}`, "");
	if (result.failures.length) {
		lines.push("### Failures", "");
		for (const failure of result.failures)
			lines.push(`- ${failure.file}${failure.row ? ` ${failure.row}` : ""}: ${failure.message}`);
		lines.push("");
	}
	if (result.findings.length) {
		lines.push("### Findings for the reviewer", "");
		for (const finding of result.findings)
			lines.push(`- ${finding.file} ${finding.row} (${finding.kind}): ${finding.message}`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function main(argv: string[]): number {
	let base: string | undefined;
	let submission = false;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--base") base = argv[++i];
		else if (arg === "--submission") submission = true;
		else if (arg === "--json") json = true;
		else {
			process.stderr.write(`hub-review: unknown argument ${arg}\n`);
			return 2;
		}
	}
	if (!base) {
		process.stderr.write("usage: hub-review --base <ref> [--submission] [--json]\n");
		return 2;
	}
	const root = path.resolve(import.meta.dirname, "..");
	const result = reviewHubChanges(changedSince(root, base), { submission });
	const text = renderReview(result);
	process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : text);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
	return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	process.exitCode = main(process.argv.slice(2));
