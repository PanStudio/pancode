// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { validateHubPackage } from "../src/domains/resources/hub-validation.js";
import { buildPluginServers } from "./build-plugin-servers.js";
import { generateClaudeMcpFiles, generateHubMarketplace } from "./generate-hub-marketplace.js";
import {
	buildRegistryRow,
	mergeCommunityRows,
	type RegistryRow,
	readCommunityRowFiles,
	readRevokedList,
} from "./pin-hub-remote.js";
import { pinSkillsCatalog } from "./pin-skills.js";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "hub", "index.yaml");
const checkMode = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// 0. Build each plugin's MCP server from its src/ into server.mjs and mcp.json,
// then its Claude Code .mcp.json from that mcp.json. They are package files,
// so they must be current before the pins below hash the tree.
// ---------------------------------------------------------------------------
const servers = await buildPluginServers({ root, check: checkMode });
const claudeForms =
	servers.errors.length > 0 ? { changed: [], errors: [] } : generateClaudeMcpFiles({ root, check: checkMode });
const buildErrors = [...servers.errors, ...claudeForms.errors];
if (buildErrors.length > 0) {
	for (const error of buildErrors) process.stderr.write(`hub plugin server error: ${error}\n`);
	process.exit(1);
}
if (checkMode && servers.changed.length + claudeForms.changed.length > 0) {
	for (const file of [...servers.changed, ...claudeForms.changed])
		process.stderr.write(`hub:check: ${file} does not match what its plugin's src/ builds\n`);
	process.stderr.write("Run `pnpm hub:pin` and commit the result.\n");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Validate curated packages and authoring templates
// ---------------------------------------------------------------------------
const KIND_DIRS = [
	{ dirName: "skills", expectedKind: "skill" },
	{ dirName: "agents", expectedKind: "agent" },
	{ dirName: "prompts", expectedKind: "prompt" },
	{ dirName: "playbooks", expectedKind: "playbook" },
	{ dirName: "plugins", expectedKind: "plugin" },
	{ dirName: "extensions", expectedKind: "extension" },
	{ dirName: "servers", expectedKind: "server" },
] as const;

interface PackageTarget {
	directory: string;
	expectedKind: string;
}

const packages: PackageTarget[] = [];
function collect(directory: string, expectedKind: string): void {
	if (existsSync(path.join(directory, "plugin.json")) || existsSync(path.join(directory, "pancode-extension.yaml"))) {
		packages.push({ directory, expectedKind });
		return;
	}
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (item.isDirectory() && !item.name.startsWith(".")) collect(path.join(directory, item.name), expectedKind);
	}
}

for (const { dirName, expectedKind } of KIND_DIRS) {
	const kindDir = path.join(root, "hub", "packs", dirName);
	if (existsSync(kindDir)) collect(kindDir, expectedKind);
}

// Authoring templates to validate (explicitly excluded from catalog entries)
const templatesDir = path.join(root, "hub", "_authoring", "templates");
const templateTargets: string[] = [];
if (existsSync(templatesDir)) {
	for (const item of readdirSync(templatesDir, { withFileTypes: true })) {
		if (item.isDirectory() && !item.name.startsWith(".")) {
			const templatePath = path.join(templatesDir, item.name);
			if (existsSync(path.join(templatePath, "plugin.json"))) {
				templateTargets.push(templatePath);
			}
		}
	}
}

const validationErrors: string[] = [];

// A digest covers the whole tree, so a file or an empty directory git ignores
// (a test run's __pycache__, an editor backup) would pin bytes no clean clone
// has, and the package would then fail verification on every install. Every
// entry of every package goes to `git check-ignore` as raw NUL-separated
// paths, so quoting and empty directories cannot hide one; tracked files are
// never reported.
function packageEntries(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) =>
		path.relative(root, path.join(entry.parentPath, entry.name)),
	);
}
const packagePaths = packages.flatMap((target) => packageEntries(target.directory));
const probe = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
	cwd: root,
	input: `${packagePaths.join("\0")}\0`,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
// Exit 1 means nothing matched; anything else but 0 means git could not answer
// (no checkout), and pinning then proceeds as it did before this check.
const ignoredPaths =
	probe.status === 0
		? probe.stdout
				.split("\0")
				.filter(Boolean)
				.map((file) => path.join(root, file))
		: [];
for (const target of packages) {
	const inside = ignoredPaths.filter((file) => file.startsWith(`${target.directory}${path.sep}`));
	if (inside.length > 0)
		validationErrors.push(
			`${path.relative(root, target.directory)}: holds files git ignores (${inside
				.slice(0, 3)
				.map((file) => path.relative(target.directory, file))
				.join(", ")}); remove them and pin again, or the digest will not match a clean clone`,
		);
}

// Validate all curated packages. The first pass learns every skill the catalog
// ships, so the second can hold a routing clause to names that actually exist.
const knownSkills = new Set(
	packages.flatMap((target) =>
		validateHubPackage(target.directory)
			.validation.resources.filter((resource) => resource.kind === "skill")
			.map((resource) => resource.name),
	),
);
const validatedPackages: {
	directory: string;
	expectedKind: string;
	result: ReturnType<typeof validateHubPackage>;
}[] = [];
// Warnings speak to whoever is pinning; the check runs inside every lint and stays quiet.
function reportAuthoringWarnings(result: ReturnType<typeof validateHubPackage>): void {
	if (checkMode) return;
	for (const resource of result.validation.resources)
		for (const diag of resource.diagnostics)
			if (diag.severity === "warning")
				process.stderr.write(`hub warning: ${path.relative(root, diag.path ?? resource.path)}: ${diag.message}\n`);
}
for (const target of packages) {
	const result = validateHubPackage(target.directory, { authoring: { knownSkills } });
	reportAuthoringWarnings(result);
	if (!result.valid) {
		const msgs = [
			...result.diagnostics.map((d) => d.message),
			...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
		];
		validationErrors.push(`${path.relative(root, target.directory)}: ${msgs.join("; ")}`);
	} else {
		validatedPackages.push({ ...target, result });
	}
}

// Validate authoring templates
for (const templatePath of templateTargets) {
	const result = validateHubPackage(templatePath, { authoring: { knownSkills } });
	reportAuthoringWarnings(result);
	if (!result.valid) {
		const msgs = [
			...result.diagnostics.map((d) => d.message),
			...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
		];
		validationErrors.push(`${path.relative(root, templatePath)}: ${msgs.join("; ")}`);
	}
}

if (validationErrors.length > 0) {
	for (const err of validationErrors) process.stderr.write(`hub validation error: ${err}\n`);
	process.stderr.write(
		`hub:${checkMode ? "check" : "pin"}: ${validationErrors.length} pack/template validation violation(s)\n`,
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Compute full-tree package pins and hold them to their versions. This comes
// before anything is written, so a refused pin leaves every generated file as it
// was. The registry itself is written below, once skill evidence is current.
// ---------------------------------------------------------------------------
const names = new Set<string>();
const localEntries: RegistryRow[] = validatedPackages.map(({ directory, expectedKind, result }) => {
	if (!result.manifest) {
		throw new Error(`${directory}: missing manifest`);
	}
	const actualKind = result.manifest.pancode.kind ?? "plugin";
	if (actualKind !== expectedKind) {
		throw new Error(`${directory}: package kind "${actualKind}" does not match kind directory "${expectedKind}"`);
	}
	// Plugin-backed kinds share one install directory per scope and extensions
	// have their own, so a plugin and the extension serving it may share a name.
	const identity = `${expectedKind === "extension" ? "extension" : "plugin"}:${result.manifest.name}`;
	if (names.has(identity)) throw new Error(`duplicate PanHub pack identity: ${identity}`);
	names.add(identity);
	const sourceUrl = path.relative(path.dirname(destination), directory).split(path.sep).join("/");
	return buildRegistryRow(directory, result, { sourceUrl }, path.basename(path.dirname(directory)));
});

// ---------------------------------------------------------------------------
// A released version names one tree forever. `hub update` compares
// versions to tell an operator a package moved, so bytes that change under an
// unchanged version would never reach the copies already installed. The last
// release tag is the baseline: a package edited twice between releases still
// needs only one bump. No tag or no checkout (an unpacked tarball) has no
// baseline to hold, and pinning proceeds as it did before this check.
// ---------------------------------------------------------------------------
function lastReleaseRows(): { tag: string; rows: Map<string, { version?: string; sha256?: string }> } | null {
	const tag = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], {
		cwd: root,
		encoding: "utf8",
	});
	if (tag.status !== 0) return null;
	const name = tag.stdout.trim();
	const shown = spawnSync("git", ["show", `${name}:hub/index.yaml`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (shown.status !== 0) return null;
	const parsed = parse(shown.stdout) as {
		entries?: Array<{ kind: string; name: string; version?: string; sha256?: string }>;
	};
	return {
		tag: name,
		rows: new Map((parsed.entries ?? []).map((row) => [`${row.kind}:${row.name}`, row])),
	};
}

const versionErrors: string[] = [];
const released = lastReleaseRows();
for (const row of localEntries) {
	const previous = released?.rows.get(`${row.kind}:${row.name}`);
	if (previous && previous.version === row.version && previous.sha256 !== row.sha256)
		versionErrors.push(
			`${row.kind}:${row.name} changed since ${released?.tag} but still declares ${row.version}; bump the version in its manifest and SKILL.md`,
		);
}
if (versionErrors.length > 0) {
	for (const error of versionErrors) process.stderr.write(`hub version error: ${error}\n`);
	process.stderr.write(`hub:${checkMode ? "check" : "pin"}: ${versionErrors.length} pack version violation(s)\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Refresh/check normalized skill evidence
// ---------------------------------------------------------------------------
const skillResult = pinSkillsCatalog({ check: checkMode });
if (!skillResult.ok) {
	if (skillResult.errors.length > 0) {
		for (const err of skillResult.errors) process.stderr.write(`pin-skills: ${err}\n`);
	}
	if (checkMode) {
		if (skillResult.manifestDrift) {
			process.stderr.write(`pin-skills: ${skillResult.manifestPath} does not match the catalog content hashes\n`);
			for (const line of skillResult.manifestDriftLines) {
				process.stderr.write(`pin-skills:   ${line}\n`);
			}
		}
		if (skillResult.indexDrift) {
			process.stderr.write(`pin-skills: ${skillResult.indexPath} does not match the catalog\n`);
		}
		process.stderr.write("pin-skills: run `pnpm run skills:pin` or `pnpm run hub:pin` and commit the result\n");
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 3a. Community rows. hub:pin fetches each row file's exact commit and
// regenerates its index row from the tree; a row that fails keeps its committed
// index row byte for byte and fails the run. hub:check never fetches: it holds
// the committed index rows to the row files that state them.
// ---------------------------------------------------------------------------
const community = readCommunityRowFiles(root);
const revokedList = readRevokedList(root);
const communityErrors: string[] = [...community.problems, ...revokedList.problems];
const committedRows = new Map<string, RegistryRow>();
if (existsSync(destination)) {
	const committed = parse(readFileSync(destination, "utf8")) as { entries?: RegistryRow[] } | null;
	for (const row of committed?.entries ?? []) committedRows.set(`${row.kind}:${row.name}`, row);
}
const merged = mergeCommunityRows(community.files, { committedRows, identities: names, check: checkMode });
const communityEntries = merged.entries;
const fetchFailures = merged.failures.length;
const fetchedRows = merged.fetched;
communityErrors.push(...merged.errors);
for (const failure of merged.failures) process.stderr.write(`hub:pin: ${failure}\n`);
if (checkMode && communityErrors.length > 0) {
	for (const error of communityErrors) process.stderr.write(`hub community error: ${error}\n`);
	process.stderr.write(`hub:check: ${communityErrors.length} community row violation(s); run pnpm hub:pin\n`);
	process.exit(1);
}
if (!checkMode && communityErrors.length > 0) {
	for (const error of communityErrors) process.stderr.write(`hub community error: ${error}\n`);
	process.exit(1);
}

const entries: RegistryRow[] = [...localEntries, ...communityEntries].sort((a, b) => a.name.localeCompare(b.name));

const content = `# Generated by pnpm hub:pin. SHA-256 covers every package file.\n${stringify({ entries, revoked: revokedList.revoked })}`;

if (checkMode) {
	if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
		process.stderr.write("PanHub pins are stale; run pnpm hub:pin.\n");
		process.exit(1);
	}
} else {
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

// ---------------------------------------------------------------------------
// 4. Project the pinned packages into the Claude Code repository marketplace
// ---------------------------------------------------------------------------
// The outbound catalog is a projection of the pins above, so it can only be
// generated once hub/index.yaml is current. Checking it here keeps a stale
// marketplace out of the gate without a second command to remember.
//
// Only packages with a skill surface a host actually loads are published, and
// only when they carry nothing Claude Code would default-scan into a native
// component. A native-only pack is a normal PanHub contribution: it is
// reported here and left out of the marketplace, never published under a
// compatibility claim and never treated as a pinning failure.
const marketplace = generateHubMarketplace({ root, check: checkMode });
for (const skip of marketplace.excluded) {
	process.stdout.write(
		`not published to Claude Code: ${skip.name} (${/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(skip.sourceUrl) ? skip.sourceUrl : `hub/${skip.sourceUrl}`}) — ${skip.reason}\n`,
	);
}
if (!marketplace.ok) {
	for (const error of marketplace.errors) process.stderr.write(`hub marketplace error: ${error}\n`);
	if (checkMode && marketplace.drift) {
		process.stderr.write(".claude-plugin/marketplace.json does not match the pinned packs\n");
		for (const line of marketplace.driftLines) process.stderr.write(`  ${line}\n`);
		process.stderr.write("Run `pnpm hub:pin` and commit the result.\n");
	}
	process.exit(1);
}

if (checkMode) {
	process.stdout.write(
		`Verified ${templateTargets.length} authoring templates, ${skillResult.entries.length} normalized skills, ${localEntries.length} full-tree PanHub pack pins, ${communityEntries.length} community rows against their row files, ${revokedList.revoked.length} revocations, and ${marketplace.entries.length} of ${entries.length} packages published as Claude Code marketplace entries.\n`,
	);
} else {
	process.stdout.write(
		`Validated ${templateTargets.length} templates, refreshed ${skillResult.entries.length} skills, pinned ${entries.length} packs (${fetchedRows} community rows fetched by commit), and published ${marketplace.entries.length} of ${entries.length} as Claude Code marketplace entries.\n`,
	);
}
if (fetchFailures > 0) {
	process.stderr.write(
		`hub:pin: ${fetchFailures} community row(s) failed to fetch or verify; their committed rows were kept unverified\n`,
	);
	process.exit(1);
}
