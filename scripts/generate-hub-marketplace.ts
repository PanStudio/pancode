// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Regenerate `.claude-plugin/marketplace.json`: the standard Claude Code
 * repository marketplace that makes the canonical `hub/` packs
 * installable by another agent without duplicating a single recipe body.
 *
 * Run through `pnpm run hub:pin`; verified by `pnpm run hub:check`,
 * which `lint` runs, so a stale marketplace fails the gate.
 * Local host interoperability checks reproduce the host behavior this file
 * relies on, against real host CLIs in throwaway homes.
 *
 * Behavior measured against Claude Code 2.1.267 rather than assumed:
 *
 * - Every entry is a relative-path source into the canonical tree. Claude Code
 *   resolves it against the marketplace root, which is the repository root, and
 *   copies those bytes into its own plugin cache at install.
 * - A package with a root `SKILL.md`, no `skills/` subdirectory and no
 *   top-level `skills` manifest field loads as a single-skill plugin. Its
 *   invocation name comes from the `SKILL.md` frontmatter, so it survives the
 *   versioned cache directory. This is the standalone skill layout.
 * - A package with a `skills/` directory publishes exactly those skills.
 * - No package needs a `.claude-plugin/plugin.json` and no entry needs
 *   `strict: false`. Claude Code reads only `.claude-plugin/plugin.json`, treats
 *   it as optional, and takes display metadata from the entry.
 *
 * The entries are derived from `hub/index.yaml`, which `pin-hub.ts`
 * generates from the actual package manifests and content digests. This file is
 * therefore a projection of the curated packages, never a second catalog anyone
 * edits by hand.
 *
 * References: Agent Skills specification (https://agentskills.io/specification);
 * the Claude Code plugins and plugin-marketplace references; the Codex "Build
 * skills" guide.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/** Public-facing marketplace id: users type `<plugin>@pancode` to install. */
const MARKETPLACE_NAME = "pancode";
const MARKETPLACE_DESCRIPTION =
	"PanHub, the PanCode packs: curated skills for planning, research, git and scientific software work, plus domain plugins.";
const OWNER_NAME = "PanCode";

/** Entry fields Claude Code documents; anything else would fail `validate --strict`. */
interface MarketplaceEntry {
	name: string;
	source: string;
	description?: string;
	version?: string;
	category?: string;
	license?: string;
	author?: { name: string; email?: string; url?: string };
}

interface RegistryEntry {
	kind: string;
	name: string;
	description?: string;
	category?: string;
	version: string;
	/** A first-party pack's directory relative to `hub/`; a community row names `source` instead. */
	sourceUrl?: string;
	source?: { repo: string; commit: string; subdir?: string };
}

interface PortableManifest {
	name?: string;
	version?: string;
	license?: string;
	author?: { name?: string; email?: string; url?: string } | string;
	skills?: unknown;
}

/**
 * Directories and files Claude Code loads by default from a plugin root, with
 * no manifest and no marketplace field asking it to. Measured on 2.1.267 by
 * publishing the composite authoring template, whose root `agents/` holds a
 * PanCode strict-v1 recipe: `claude plugin details` reported `Agents (1)
 * data-curator`, and `claude plugin validate --strict` did not object.
 *
 * PanHub accepts agent-, prompt- and playbook-only packages and its composite
 * template uses ordinary top-level `agents/` and `prompts/` directories. Those
 * are first-class packs; they simply have no vendor projection here.
 * PanCode `prompts/` and `playbooks/` are inert to Claude Code, but a root `agents/`
 * would silently present a PanCode agent recipe as a native Claude agent, with
 * tools, model and budget fields the host never honors. A package like that is
 * not publishable, and saying so is the point: the alternative is a claimed
 * compatibility that was never measured. An author who wants one package to
 * serve both audiences declares its PanCode resource roots at paths no host scans,
 * such as `native/agents`, through the resources map in the manifest.
 */
const HOST_SCANNED_ROOTS = ["agents", "commands", "hooks", "output-styles", ".mcp.json", ".claude-plugin"] as const;

/**
 * The one pack published for its root `.mcp.json` alone. Its servers are
 * PanKit's own, launched through `npx -y -p @akougkas/pancode pankit serve <id>`,
 * so the host-native MCP component it presents is exactly what it is. PanCode
 * reads `mcp.json`, never `.mcp.json`, so the same pack declares nothing there.
 */
const CLAUDE_MCP_PACK = "pankit";

/** Why a pinned package is not published to the Claude Code marketplace. */
interface Exclusion {
	name: string;
	sourceUrl: string;
	reason: string;
}

/**
 * The portable inclusion rule, in one place: a package publishes only when it
 * has a skill surface Claude Code actually loads, and carries nothing Claude
 * Code would default-scan into a host-native component.
 *
 * Returning a reason rather than throwing is deliberate. A future native-only
 * pack is a normal PanHub contribution, not a pinning failure, so it is
 * reported and skipped instead of breaking `hub:pin` for everything else.
 *
 * `mcpPack` marks `CLAUDE_MCP_PACK`: its root `.mcp.json` is the surface it
 * publishes, so it needs that file and no skill surface; every other
 * default-scanned root still refuses it.
 */
function portabilityVerdict(
	directory: string,
	manifest: PortableManifest,
	mcpPack: boolean,
): { publish: boolean; reason?: string } {
	for (const scanned of HOST_SCANNED_ROOTS) {
		if (mcpPack && scanned === ".mcp.json") continue;
		if (existsSync(path.join(directory, scanned))) {
			return {
				publish: false,
				reason: `a root ${scanned} would be default-scanned by Claude Code as a host-native component; the pack stays a valid PanHub pack, and to publish it too, declare its PanCode resource roots at a path no host scans, such as native/agents`,
			};
		}
	}
	if (mcpPack) {
		return existsSync(path.join(directory, ".mcp.json"))
			? { publish: true }
			: { publish: false, reason: "no root .mcp.json, so a host would load no MCP server" };
	}

	const skillsDirectory = path.join(directory, "skills");
	const hasSkillsDirectory = existsSync(skillsDirectory);
	if (hasSkillsDirectory) {
		const published = readdirSync(skillsDirectory, { withFileTypes: true }).filter(
			(item) => item.isDirectory() && existsSync(path.join(skillsDirectory, item.name, "SKILL.md")),
		);
		if (published.length === 0) {
			return { publish: false, reason: "skills/ holds no <name>/SKILL.md, so a host would publish nothing" };
		}
		return { publish: true };
	}

	if (!existsSync(path.join(directory, "SKILL.md"))) {
		return {
			publish: false,
			reason: "no portable skill surface: neither a root SKILL.md nor a skills/ directory, so a host would load nothing",
		};
	}
	if (manifest.skills !== undefined) {
		return {
			publish: false,
			reason: "a top-level skills manifest field suppresses the root SKILL.md fallback; add a skills/ directory instead",
		};
	}
	return { publish: true };
}

export interface GenerateMarketplaceOptions {
	root?: string;
	check?: boolean;
}

export interface GenerateMarketplaceResult {
	ok: boolean;
	path: string;
	content: string;
	drift: boolean;
	driftLines: string[];
	errors: string[];
	entries: MarketplaceEntry[];
	excluded: Exclusion[];
}

/** `hub/index.yaml` records `sourceUrl` relative to `hub/`. */
function entrySource(registrySourceUrl: string): string {
	return `./hub/${registrySourceUrl}`;
}

/**
 * Marketplace-visible author, from the package's own portable manifest. A bare
 * string author has no documented object form here, so it is dropped rather
 * than guessed at.
 */
function entryAuthor(manifest: PortableManifest): MarketplaceEntry["author"] {
	const author = manifest.author;
	if (!author || typeof author === "string" || typeof author.name !== "string") return undefined;
	return {
		name: author.name,
		...(author.email ? { email: author.email } : {}),
		...(author.url ? { url: author.url } : {}),
	};
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function renderHubMarketplace(options: GenerateMarketplaceOptions = {}): {
	content: string;
	entries: MarketplaceEntry[];
	excluded: Exclusion[];
	errors: string[];
} {
	const root = options.root ? path.resolve(options.root) : path.resolve(import.meta.dirname, "..");
	const registryPath = path.join(root, "hub", "index.yaml");
	const errors: string[] = [];

	if (!existsSync(registryPath)) {
		return {
			content: "",
			entries: [],
			excluded: [],
			errors: [`${registryPath} is missing; run pnpm run hub:pin first`],
		};
	}

	const parsed = parse(readFileSync(registryPath, "utf8")) as { entries?: RegistryEntry[] } | null;
	const registry = Array.isArray(parsed?.entries) ? parsed.entries : [];
	if (registry.length === 0) errors.push("hub/index.yaml has no entries");

	const entries: MarketplaceEntry[] = [];
	const excluded: Exclusion[] = [];
	for (const entry of registry) {
		const where = entry.source
			? `${entry.source.repo}@${entry.source.commit}${entry.source.subdir ? `/${entry.source.subdir}` : ""}`
			: (entry.sourceUrl ?? "");
		if (entry.kind === "extension") {
			excluded.push({
				name: entry.name,
				sourceUrl: where,
				reason: "PanCode extension, not an Agent Plugin; other hosts cannot load it",
			});
			continue;
		}
		if (entry.source || !entry.sourceUrl || /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(entry.sourceUrl)) {
			excluded.push({
				name: entry.name,
				sourceUrl: where,
				reason: "remote package; not vendored into the marketplace tree, so it has no local plugin.json to project",
			});
			continue;
		}
		const directory = path.join(root, "hub", entry.sourceUrl);
		const manifestPath = path.join(directory, "plugin.json");
		if (!existsSync(manifestPath)) {
			errors.push(`${entry.name}: no portable plugin.json at hub/${entry.sourceUrl}`);
			continue;
		}
		const manifest = readJson<PortableManifest>(manifestPath);
		if (manifest.name !== entry.name) {
			errors.push(`${entry.name}: manifest name is ${JSON.stringify(manifest.name)}`);
		}
		if (manifest.version !== entry.version) {
			errors.push(`${entry.name}: manifest version ${manifest.version} does not match pinned ${entry.version}`);
		}
		const verdict = portabilityVerdict(directory, manifest, entry.kind === "plugin" && entry.name === CLAUDE_MCP_PACK);
		if (!verdict.publish) {
			excluded.push({ name: entry.name, sourceUrl: entry.sourceUrl, reason: verdict.reason ?? "not portable" });
			continue;
		}
		const author = entryAuthor(manifest);
		entries.push({
			name: entry.name,
			source: entrySource(entry.sourceUrl),
			...(entry.description ? { description: entry.description } : {}),
			version: entry.version,
			...(entry.category ? { category: entry.category } : {}),
			...(manifest.license ? { license: manifest.license } : {}),
			...(author ? { author } : {}),
		});
	}

	const packageJson = readJson<{ homepage?: string; repository?: { url?: string } }>(path.join(root, "package.json"));
	const marketplace = {
		name: MARKETPLACE_NAME,
		owner: {
			name: OWNER_NAME,
			...(packageJson.homepage ? { url: packageJson.homepage } : {}),
		},
		description: MARKETPLACE_DESCRIPTION,
		plugins: entries,
	};

	return { content: `${JSON.stringify(marketplace, null, "\t")}\n`, entries, excluded, errors };
}

/** Which entries a stale file is missing, holding stale, or holding orphaned. */
function describeDrift(current: string, expected: ReadonlyArray<MarketplaceEntry>): string[] {
	let actual: MarketplaceEntry[] = [];
	try {
		const parsed = JSON.parse(current) as { plugins?: MarketplaceEntry[] };
		actual = Array.isArray(parsed.plugins) ? parsed.plugins : [];
	} catch {
		return ["marketplace.json is not parseable JSON"];
	}
	const lines: string[] = [];
	const actualByName = new Map(actual.map((entry) => [entry.name, entry]));
	const expectedByName = new Map(expected.map((entry) => [entry.name, entry]));
	for (const entry of expected) {
		const found = actualByName.get(entry.name);
		if (!found) lines.push(`${entry.name}: pinned in PanHub but missing from the marketplace`);
		else if (found.version !== entry.version || found.source !== entry.source) {
			lines.push(`${entry.name}: marketplace entry is stale`);
		}
	}
	for (const entry of actual) {
		if (!expectedByName.has(entry.name)) lines.push(`${entry.name}: in the marketplace but not a pinned PanHub pack`);
	}
	return lines;
}

export function generateHubMarketplace(options: GenerateMarketplaceOptions = {}): GenerateMarketplaceResult {
	const root = options.root ? path.resolve(options.root) : path.resolve(import.meta.dirname, "..");
	const destination = path.join(root, ".claude-plugin", "marketplace.json");
	const { content, entries, excluded, errors } = renderHubMarketplace({ root });

	if (errors.length > 0) {
		return { ok: false, path: destination, content, drift: false, driftLines: [], errors, entries, excluded };
	}

	const current = existsSync(destination) ? readFileSync(destination, "utf8") : null;
	if (options.check) {
		const drift = current !== content;
		return {
			ok: !drift,
			path: destination,
			content,
			drift,
			driftLines: drift ? describeDrift(current ?? "", entries) : [],
			errors,
			entries,
			excluded,
		};
	}

	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
	return {
		ok: true,
		path: destination,
		content,
		drift: current !== content,
		driftLines: [],
		errors,
		entries,
		excluded,
	};
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
	const check = process.argv.includes("--check");
	const result = generateHubMarketplace({ check });
	for (const error of result.errors) process.stderr.write(`generate-hub-marketplace: ${error}\n`);
	for (const skip of result.excluded) {
		process.stdout.write(
			`not published to Claude Code: ${skip.name} (${/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(skip.sourceUrl) ? skip.sourceUrl : `hub/${skip.sourceUrl}`}) — ${skip.reason}\n`,
		);
	}
	if (!result.ok) {
		if (check && result.drift) {
			process.stderr.write(".claude-plugin/marketplace.json does not match the pinned packs\n");
			for (const line of result.driftLines) process.stderr.write(`  ${line}\n`);
			process.stderr.write("Run `pnpm run hub:pin` and commit the result.\n");
		}
		process.exit(1);
	}
	process.stdout.write(
		`${check ? "Verified" : "Generated"} ${result.entries.length} Claude Code marketplace entries.\n`,
	);
}
