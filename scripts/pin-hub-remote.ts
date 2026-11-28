// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Rows for `hub/index.yaml`: the shared row builder for first-party packs and
 * community packs, and the community row files under `hub/community/`.
 *
 * A community pack enters as `hub/community/<publisher>/<name>.yaml` holding
 * one row, or a plugin row and the extension row that serves it. `hub:pin`
 * fetches each row's exact commit, requires the fetched tree to match the
 * row's `sha256`, and regenerates the index row from that tree. A row whose
 * fetch or validation fails is never rewritten: the committed index row stays
 * byte for byte, a changed row file is not merged, and the pin run fails.
 * `hub:check` reads the same files offline and never fetches.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { loadManifestFromRoot } from "../src/domains/extensions/index.js";
import { fetchPluginCommit, type PluginSource, parseHubIndexRows } from "../src/domains/plugins/catalog.js";
import { hubEnvelopeDigest, hubMcpDigest } from "../src/domains/resources/hub-digests.js";
import {
	clipAtWord,
	HUB_PROVIDES_LIMITS,
	type HubProvidedResource,
	type HubRowSource,
	type HubTier,
	isHubComponentKind,
} from "../src/domains/resources/hub-types.js";
import { type HubPackageValidationResult, validateHubPackage } from "../src/domains/resources/hub-validation.js";

export type RegistryRow = Record<string, unknown> & { kind: string; name: string };

/** Where a row's tree comes from: a directory under `hub/`, or an exact commit of a community repository. */
type RowLocation = { sourceUrl: string } | { source: HubRowSource };

/** Who answers for a row, as the row states it. */
interface RowTrust {
	publisher: string;
	tier: HubTier;
	/** The row's licence; a first-party row reads it from the pack manifest instead. */
	license?: string;
}

/** Fields a submitter states in a row file; everything else `hub:pin` derives from the fetched tree. */
const ROW_FILE_FIELDS = new Set([
	"kind",
	"publisher",
	"name",
	"version",
	"description",
	"source",
	"sha256",
	"license",
	"tier",
	"envelopeDigest",
	"mcpDigest",
	"plugin",
	"category",
]);

/** The licence a pack declares in its own manifest, if any. */
export function packLicense(root: string, result: Pick<HubPackageValidationResult, "manifest">): string | undefined {
	if (result.manifest?.pancode.kind === "extension") return loadManifestFromRoot(root).manifest?.license;
	return result.manifest?.license;
}

/**
 * Build one registry row from a validated package root. First-party and
 * community packs derive their rows from the same evidence (manifest, content
 * digest, parsed resource hints, envelope and MCP digests); only the location
 * and the trust fields differ. `category` only applies to skill-kind rows.
 */
export function buildRegistryRow(
	root: string,
	result: Pick<HubPackageValidationResult, "manifest" | "contentDigest" | "validation">,
	location: RowLocation,
	category: string | undefined,
	trust: RowTrust = { publisher: "pancode", tier: "core" },
): RegistryRow {
	const manifest = result.manifest;
	if (!manifest) throw new Error(`${root}: missing manifest`);
	if (!result.contentDigest) throw new Error(`${root}: missing content digest`);
	const skillFile = path.join(root, "SKILL.md");
	const frontmatter = existsSync(skillFile)
		? /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf8"))?.[1]
		: undefined;
	const metadata = frontmatter ? (parse(frontmatter) as Record<string, unknown>) : {};
	const triggers = Array.isArray(metadata.triggers)
		? metadata.triggers.filter((item): item is string => typeof item === "string")
		: [];
	// Hints are the validator's actual parsed runtime names, never component
	// ids or display titles. Ancillary scripts/resources stay manifest metadata.
	const provides: HubProvidedResource[] = result.validation.resources
		.flatMap((resource): HubProvidedResource[] => {
			// A local binding carries the narrowing into the object literal.
			const kind = resource.kind;
			if (!(isHubComponentKind(kind) || kind === "extension") || !resource.valid) return [];
			return [
				{
					kind,
					name: resource.name,
					...(resource.description
						? { description: clipAtWord(resource.description, HUB_PROVIDES_LIMITS.description) }
						: {}),
				},
			];
		})
		.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
		.slice(0, HUB_PROVIDES_LIMITS.entries);
	const kind = manifest.pancode.kind ?? "plugin";
	// An extension row names the plugin it serves, so a plugin and its extension pair without reading package trees.
	const extension = kind === "extension" ? loadManifestFromRoot(root).manifest : undefined;
	const serves = extension?.plugin;
	// The `pancode <verb>` names it declares, so a verb typed before the pack is installed can name the pack.
	const verbs = (extension?.runtimeV2?.cli ?? []).map((entry) => entry.verb).sort();
	const license = trust.license ?? packLicense(root, result);
	const envelopeDigest = kind === "extension" ? hubEnvelopeDigest(root) : undefined;
	const mcpDigest = hubMcpDigest(root, result.contentDigest);
	return {
		kind,
		publisher: trust.publisher,
		name: manifest.name,
		description: manifest.description ?? "",
		...(kind === "skill" ? { category: category ?? "", audit: "pass", ...(triggers.length ? { triggers } : {}) } : {}),
		version: manifest.version,
		...location,
		sha256: result.contentDigest,
		...(license ? { license } : {}),
		tier: trust.tier,
		...(envelopeDigest ? { envelopeDigest } : {}),
		...(mcpDigest ? { mcpDigest } : {}),
		...(manifest.pancode.requires ? { requires: manifest.pancode.requires } : {}),
		...(serves ? { plugin: serves } : {}),
		...(verbs.length ? { verbs } : {}),
		...(provides.length ? { provides } : {}),
	};
}

/** One community row file and the rows it states. */
export interface CommunityRowFile {
	/** Path relative to the repository root, with forward slashes. */
	file: string;
	publisher: string;
	name: string;
	rows: RegistryRow[];
}

/**
 * Check one row file's parsed content against the row schema and its path.
 * Returns the problems; an empty list means the file is well formed.
 */
export function rowFileProblems(file: string, publisher: string, name: string, parsed: unknown): string[] {
	const problems: string[] = [];
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [`${file}: must be a mapping with rows`];
	const extra = Object.keys(parsed).filter((key) => key !== "rows");
	if (extra.length) problems.push(`${file}: unknown top-level field(s): ${extra.join(", ")}`);
	const rows = (parsed as { rows?: unknown }).rows;
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2)
		return [...problems, `${file}: rows must hold one row, or a plugin row and the extension that serves it`];
	const diagnostics: string[] = [];
	const accepted = parseHubIndexRows({ entries: rows }, file, diagnostics, { mode: "remote" });
	for (const message of diagnostics) problems.push(`${file}: ${message}`);
	if (accepted.length !== rows.length) return problems;
	for (const row of rows as Array<Record<string, unknown>>) {
		const unknown = Object.keys(row).filter((key) => !ROW_FILE_FIELDS.has(key));
		if (unknown.length)
			problems.push(`${file}: ${row.kind}:${row.name} states field(s) hub:pin derives: ${unknown.join(", ")}`);
		if (row.source === undefined) problems.push(`${file}: ${row.kind}:${row.name} must name a source commit`);
		if (row.publisher !== publisher) problems.push(`${file}: ${row.kind}:${row.name} publisher must be ${publisher}`);
		if (row.name !== name) problems.push(`${file}: row name ${String(row.name)} must be ${name}`);
	}
	if (rows.length === 2) {
		const [first, second] = rows as Array<Record<string, unknown>>;
		const kinds = [first?.kind, second?.kind].sort().join(",");
		const extension = first?.kind === "extension" ? first : second;
		if (kinds !== "extension,plugin" || extension?.plugin !== name)
			problems.push(`${file}: two rows must be a plugin and the extension that names it as its plugin`);
	}
	return problems;
}

/** Every row file under `hub/community/`, read and checked offline. */
export function readCommunityRowFiles(root: string): { files: CommunityRowFile[]; problems: string[] } {
	const base = path.join(root, "hub", "community");
	const files: CommunityRowFile[] = [];
	const problems: string[] = [];
	if (!existsSync(base)) return { files, problems };
	for (const publisher of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!publisher.isDirectory()) {
			if (publisher.name !== "README.md") problems.push(`hub/community/${publisher.name}: not a publisher directory`);
			continue;
		}
		for (const entry of readdirSync(path.join(base, publisher.name), { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const file = `hub/community/${publisher.name}/${entry.name}`;
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
				problems.push(`${file}: a row file is <name>.yaml`);
				continue;
			}
			const name = entry.name.slice(0, -".yaml".length);
			let parsed: unknown;
			try {
				parsed = parse(readFileSync(path.join(root, file), "utf8"));
			} catch (error) {
				problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const found = rowFileProblems(file, publisher.name, name, parsed);
			if (found.length) {
				problems.push(...found);
				continue;
			}
			files.push({ file, publisher: publisher.name, name, rows: (parsed as { rows: RegistryRow[] }).rows });
		}
	}
	return { files, problems };
}

/** The `revoked` list from `hub/revoked.yaml`, checked for shape. */
export function readRevokedList(root: string): { revoked: Array<Record<string, unknown>>; problems: string[] } {
	const file = path.join(root, "hub", "revoked.yaml");
	if (!existsSync(file)) return { revoked: [], problems: ["hub/revoked.yaml is missing"] };
	const parsed = parse(readFileSync(file, "utf8")) as { revoked?: unknown } | null;
	if (!parsed || !Array.isArray(parsed.revoked))
		return { revoked: [], problems: ["hub/revoked.yaml must hold a revoked list"] };
	const problems: string[] = [];
	const revoked = parsed.revoked.filter((item, index): item is Record<string, unknown> => {
		const row = item as Record<string, unknown> | null;
		const ok =
			!!row &&
			typeof row === "object" &&
			typeof row.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(row.sha256) &&
			typeof row.reason === "string" &&
			row.reason.trim().length > 0 &&
			typeof row.date === "string" &&
			/^\d{4}-\d{2}-\d{2}$/.test(row.date);
		if (!ok) problems.push(`hub/revoked.yaml: revoked[${index}] must be { sha256, reason, date: YYYY-MM-DD }`);
		return ok;
	});
	return { revoked, problems };
}

export interface CommunityFetchDeps {
	fetchPluginCommit: (source: HubRowSource, expectedSha256?: string) => PluginSource;
	validateHubPackage: (root: string) => HubPackageValidationResult;
}

const defaultDeps: CommunityFetchDeps = { fetchPluginCommit, validateHubPackage };

type CommunityRowResult = { ok: true; row: RegistryRow } | { ok: false; error: string };

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fetch one community row's exact commit and regenerate its index row from the
 * tree. The fetch refuses a tree whose digest differs from the row's `sha256`;
 * the regenerated row must also repeat every field the row file states.
 */
export function refreshCommunityRow(row: RegistryRow, deps: CommunityFetchDeps = defaultDeps): CommunityRowResult {
	let fetched: PluginSource | undefined;
	try {
		const source = row.source as HubRowSource;
		fetched = deps.fetchPluginCommit(source, row.sha256 as string);
		const result = deps.validateHubPackage(fetched.root);
		if (!result.valid || !result.manifest) {
			const messages = [
				...result.diagnostics.map((d) => d.message),
				...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
			];
			throw new Error(messages.join("; ") || "fetched package failed validation");
		}
		const manifestLicense = packLicense(fetched.root, result);
		if (manifestLicense !== undefined && manifestLicense !== row.license)
			throw new Error(`the pack declares license ${manifestLicense}, the row states ${String(row.license)}`);
		const regenerated = buildRegistryRow(
			fetched.root,
			result,
			{ source: { repo: source.repo, commit: source.commit, subdir: source.subdir } },
			typeof row.category === "string" ? row.category : undefined,
			{ publisher: row.publisher as string, tier: row.tier as HubTier, license: row.license as string },
		);
		// Every field the row file states must hold at the commit; the rest is derived from the tree.
		const mismatched = Object.keys(row).filter((field) => !sameValue(row[field], regenerated[field]));
		if (mismatched.length)
			throw new Error(
				mismatched
					.map(
						(field) =>
							`${field} is ${JSON.stringify(regenerated[field] ?? null)} at the commit, the row states ${JSON.stringify(row[field])}`,
					)
					.join("; "),
			);
		return { ok: true, row: regenerated };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		fetched?.cleanup();
	}
}

/**
 * Whether a committed index row is the one a row file states: every field the
 * row file names is repeated exactly. `hub:check` uses this to hold the index to
 * its row files without fetching.
 */
function indexRowMatches(stated: RegistryRow, indexed: RegistryRow): boolean {
	return Object.keys(stated).every((field) => sameValue(stated[field], indexed[field]));
}

interface CommunityMergeResult {
	/** Index rows for the community files: regenerated, or the committed row kept unverified on failure. */
	entries: RegistryRow[];
	/** Schema and identity errors, and in check mode every row file the index does not hold. */
	errors: string[];
	/** Rows whose fetch or validation failed during a pin run. */
	failures: string[];
	fetched: number;
}

/**
 * Merge the community row files into index rows. A pin run fetches each row's
 * commit; a row that fails keeps its committed index row byte for byte, and a
 * changed row file whose fetch fails is not merged at all. A check run never
 * fetches and holds each committed index row to the row file that states it.
 */
export function mergeCommunityRows(
	files: ReadonlyArray<CommunityRowFile>,
	options: {
		committedRows: ReadonlyMap<string, RegistryRow>;
		/** Identities already taken by first-party rows; extended with the community rows. */
		identities: Set<string>;
		check: boolean;
		deps?: CommunityFetchDeps;
	},
): CommunityMergeResult {
	const result: CommunityMergeResult = { entries: [], errors: [], failures: [], fetched: 0 };
	for (const file of files) {
		for (const row of file.rows) {
			const identity = `${row.kind === "extension" ? "extension" : "plugin"}:${row.name}`;
			if (options.identities.has(identity)) {
				result.errors.push(`${file.file}: duplicate PanHub pack identity: ${identity}`);
				continue;
			}
			options.identities.add(identity);
			const committed = options.committedRows.get(`${row.kind}:${row.name}`);
			if (options.check) {
				if (committed && indexRowMatches(row, committed)) result.entries.push(committed);
				else
					result.errors.push(`${file.file}: hub/index.yaml does not hold the ${row.kind}:${row.name} row this file states`);
				continue;
			}
			const refreshed = refreshCommunityRow(row, options.deps);
			if (refreshed.ok) {
				result.fetched++;
				result.entries.push(refreshed.row);
				continue;
			}
			const commit = (row.source as { commit?: unknown } | undefined)?.commit;
			result.failures.push(`${file.file} ${row.kind}:${row.name} at ${String(commit)}: ${refreshed.error}`);
			if (committed) result.entries.push(committed);
		}
	}
	return result;
}
