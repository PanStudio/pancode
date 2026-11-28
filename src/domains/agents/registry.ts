// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readSettings } from "../../core/config.js";
import { writeDiagnostic, writeHeadlessDiagnostic } from "../../core/diagnostics.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { detectPancodeRepo } from "../../core/pancode-repo.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { mcpSkillReferenceServer } from "../mcp/skills.js";
import { enabledPluginResourceRoots, withPluginDiscoveryPass } from "../plugins/index.js";
import { resolvePackageReferences } from "../resources/package-references.js";
import { cachedFrontmatterParser, withFrontmatterCache } from "../resources/skills/frontmatter-cache.js";
import { type LoadSkillsInput, loadSkills, type SkillList } from "../resources/skills/loader.js";
import { parseFrontmatter } from "./frontmatter.js";
import { type AgentRecipe, type RecipeSource, recipeIdFromPath } from "./recipe.js";
import { parseAgentRecipeSchema } from "./recipe-schema.js";
import { assertAgentSpecPolicy, isShadowAgent, normalizeAgentSpec } from "./spec.js";

const RESERVED_CUSTOM_AGENT_IDS = new Set(["worker", "delegate", "auto"]);

export interface AgentRecipeDiagnostic {
	source: RecipeSource["source"];
	filepath: string;
	message: string;
	/**
	 * Why a file is not in the catalog. `quarantine` is a parse/policy failure;
	 * `ignored` is a reserved or protected id; `overridden` lost same-id
	 * precedence to a later source. Absent on records from before this field.
	 */
	kind?: "quarantine" | "ignored" | "overridden";
	/** Recipe id when it was parsed; quarantined files may not have one. */
	id?: string;
	/** Source that won, for `overridden`. */
	by?: RecipeSource["source"];
	/** Parsed audience of an ignored/overridden recipe, so listings can keep hiding internal ones. */
	audience?: AgentRecipe["audience"];
}

/** Diagnostics are a bounded inspection aid, never a second catalog. */
const MAX_AGENT_RECIPE_DIAGNOSTICS = 256;

function recordDiagnostic(diagnostics: AgentRecipeDiagnostic[], diagnostic: AgentRecipeDiagnostic): void {
	if (diagnostics.length < MAX_AGENT_RECIPE_DIAGNOSTICS) diagnostics.push(diagnostic);
}

/**
 * Skill catalogs loaded by the current discovery, keyed by their inputs. Every
 * builtin recipe binds against the same catalog, so one discovery loads it
 * once instead of once per skill-binding recipe.
 */
let discoveryCatalogs: Map<string, SkillList> | null = null;

function boundSkillCatalog(input: LoadSkillsInput): SkillList {
	if (!discoveryCatalogs) return loadSkills(input);
	const key = JSON.stringify(input);
	let catalog = discoveryCatalogs.get(key);
	if (!catalog) {
		catalog = loadSkills(input);
		discoveryCatalogs.set(key, catalog);
	}
	return catalog;
}

/**
 * In PanCode's own checkout a built-in recipe that edits gets `pancode-dev`
 * and one that edits or verifies gets `pancode-test`, when discovery has
 * them; elsewhere, and for read-only recipes, nothing is added.
 */
function selfDevelopmentSkills(recipe: AgentRecipe, source: RecipeSource): string[] {
	if (source.source !== "builtin" || !detectPancodeRepo(source.cwd ?? process.cwd()).isPancodeRepo) return [];
	const edits = recipe.capabilityClass === "workspace-edit";
	if (!edits && recipe.capabilityClass !== "verification") return [];
	// A bound skill needs a required context tool (agent spec policy); recipes without it get none.
	if (!recipe.toolRequirements.required.includes("context")) return [];
	return [...(edits ? ["pancode-dev"] : []), "pancode-test"].filter((name) => !recipe.skills.includes(name));
}

function resolveBoundSkills(recipe: AgentRecipe, source: RecipeSource): AgentRecipe {
	const selfSkills = selfDevelopmentSkills(recipe, source);
	if (recipe.skills.length === 0 && selfSkills.length === 0) return { ...recipe, boundSkillPaths: [] };
	// Builtins may bind a package-owned skill. Custom recipes deliberately use
	// only the operator's discovered skill roots; a recipe cannot smuggle an
	// arbitrary filesystem path into worker context through a skill name.
	const packageSkills = path.resolve(source.dir, "..", "..", "..", "..", "hub", "packs", "skills");
	if (source.source === "plugin" && source.skillRoot === undefined) {
		throw new Error(
			`agent recipe: ${recipe.filepath}: ${source.source} declares bound skills but no skills resource root`,
		);
	}
	const skills =
		source.source === "plugin"
			? boundSkillCatalog({
					cwd: source.cwd ?? process.cwd(),
					trustProjectCompatRoots: readSettings().integrations.projectResources.trustProjectImports,
					disableDiscovery: true,
					explicitSkillPaths: source.skillRoot === undefined ? [] : [source.skillRoot],
				})
			: boundSkillCatalog({
					cwd: source.cwd ?? process.cwd(),
					trustProjectCompatRoots: readSettings().integrations.projectResources.trustProjectImports,
					...(source.source === "builtin" && existsSync(packageSkills) ? { explicitSkillPaths: [packageSkills] } : {}),
				});
	if (source.source === "plugin" && source.skillRoot !== undefined) {
		const canonicalRoot = realpathSync(source.skillRoot);
		for (const skill of skills.items) {
			const relative = path.relative(canonicalRoot, realpathSync(skill.filePath));
			if (relativePathEscapes(relative)) {
				throw new Error(`agent recipe: ${recipe.filepath}: bound skill escapes its ${source.source}: ${skill.filePath}`);
			}
		}
	}
	const trusted = skills.items.filter((skill) => skill.trusted);
	const byName = new Map(trusted.map((skill) => [skill.name, skill.filePath]));
	const descriptions = new Map(trusted.map((skill) => [skill.name, skill.description]));
	// An MCP server's skill is resolved and attested at dispatch, against the
	// server's recorded listing and the operator's approval, not here.
	const mcp = recipe.skills.filter((skill) => !byName.has(skill) && mcpSkillReferenceServer(skill) !== null);
	const missing = recipe.skills.filter((skill) => !byName.has(skill) && !mcp.includes(skill));
	if (missing.length > 0) {
		throw new Error(`agent recipe: ${recipe.filepath}: bound skill(s) unavailable: ${missing.join(", ")}`);
	}
	// Optional: a disabled or missing self-development skill never fails discovery.
	const bound = [...recipe.skills, ...selfSkills.filter((skill) => byName.has(skill))];
	const boundSkillPaths = bound.flatMap((skill) => {
		if (mcp.includes(skill)) return [];
		const filePath = byName.get(skill);
		if (filePath === undefined) throw new Error(`agent recipe: ${recipe.filepath}: bound skill unavailable: ${skill}`);
		return [filePath];
	});
	return {
		...recipe,
		boundSkillPaths,
		...(selfSkills.length > 0 ? { skills: bound } : {}),
		boundSkillDescriptions: bound.map((skill) => descriptions.get(skill) ?? ""),
		...(mcp.length > 0 ? { boundMcpSkills: mcp } : {}),
	};
}

/**
 * Strictly parse one recipe directory. Shipped recipe defects abort discovery;
 * user and project defects are quarantined with a structured diagnostic.
 */
export function loadRecipesFromDir(
	source: RecipeSource,
	diagnostics: AgentRecipeDiagnostic[] = [],
): ReadonlyArray<AgentRecipe> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(source.dir, { withFileTypes: true });
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
		throw err;
	}

	const recipes: AgentRecipe[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filepath = path.join(source.dir, entry.name);
		try {
			const id = recipeIdFromPath(filepath, source.dir);
			const { mtimeMs, size } = statSync(filepath);
			const raw = readFileSync(filepath, "utf8");
			const { frontmatter, body: rawBody } = parseFrontmatter(
				raw,
				filepath,
				cachedFrontmatterParser(filepath, { mtimeMs, size }),
			);
			const body = resolvePackageReferences(rawBody, {
				...(source.rootPath ? { rootPath: source.rootPath } : {}),
				plugin: source.source === "plugin",
			});
			const parsedRecipe = parseAgentRecipeSchema({ id, source: source.source, filepath, body, frontmatter });
			const recipe = resolveBoundSkills(parsedRecipe, source);
			// Policy validation runs before a recipe enters any catalog, prompt, or
			// dispatch lookup. The schema is intentionally not a permissive pre-pass.
			assertAgentSpecPolicy(normalizeAgentSpec(recipe));
			recipes.push(recipe);
		} catch (error) {
			if (source.source === "builtin") throw error;
			const message = error instanceof Error ? error.message : String(error);
			recordDiagnostic(diagnostics, { kind: "quarantine", source: source.source, filepath, message });
			writeDiagnostic(`[pancode:agents] quarantine path=${filepath} source=${source.source} reason=${message}\n`);
		}
	}

	recipes.sort((left, right) => left.id.localeCompare(right.id));
	return recipes;
}

function mergeRecipes(
	diagnostics: AgentRecipeDiagnostic[],
	...sources: ReadonlyArray<ReadonlyArray<AgentRecipe>>
): ReadonlyArray<AgentRecipe> {
	const ignored = (recipe: AgentRecipe, reason: string): void => {
		writeDiagnostic(`[pancode:agents] ignore id=${recipe.id} by=${recipe.source} reason=${reason}\n`);
		recordDiagnostic(diagnostics, {
			kind: "ignored",
			id: recipe.id,
			source: recipe.source,
			audience: recipe.audience,
			filepath: recipe.filepath,
			message: `agent recipe ${recipe.id} from ${recipe.source} ignored: ${reason}`,
		});
	};
	const byId = new Map<string, AgentRecipe>();
	const builtinById = new Map<string, AgentRecipe>();
	for (const group of sources) {
		for (const recipe of group) {
			if (recipe.source === "builtin") builtinById.set(recipe.id, recipe);
		}
	}
	for (const group of sources) {
		for (const recipe of group) {
			if (recipe.source !== "builtin" && RESERVED_CUSTOM_AGENT_IDS.has(recipe.id)) {
				ignored(recipe, "reserved-agent-id");
				continue;
			}
			const builtin = builtinById.get(recipe.id);
			if (recipe.source === "plugin" && builtin) {
				ignored(recipe, "reserved-builtin");
				continue;
			}
			if (recipe.source === "user" && builtin && isShadowAgent(normalizeAgentSpec(builtin))) {
				ignored(recipe, "reserved-shadow");
				continue;
			}
			if (recipe.source === "project" && builtin) {
				ignored(recipe, "reserved-builtin");
				continue;
			}
			const previous = byId.get(recipe.id);
			if (previous) {
				writeHeadlessDiagnostic(`[pancode:agents] override id=${recipe.id} by=${recipe.source}\n`);
				recordDiagnostic(diagnostics, {
					kind: "overridden",
					id: previous.id,
					source: previous.source,
					audience: previous.audience,
					by: recipe.source,
					filepath: previous.filepath,
					message: `agent recipe ${previous.id} from ${previous.source} overridden by ${recipe.source}`,
				});
			}
			byId.set(recipe.id, recipe);
		}
	}
	return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Discover the one native-agent catalog used by listing, fleet admission, and
 * dispatch. Plugin agents occupy the same precedence slot as plugin playbooks:
 * after builtins and before operator/user and project agents. Their skill
 * bindings remain constrained to the declaring plugin's skill root.
 */
export function discoverAgentRecipes(
	cwd = process.cwd(),
	diagnostics: AgentRecipeDiagnostic[] = [],
): ReadonlyArray<AgentRecipe> {
	if (discoveryCatalogs) return discoverAgentRecipesInPass(cwd, diagnostics);
	discoveryCatalogs = new Map();
	try {
		// Recipe frontmatter shares the skill catalog's parse cache: every boot parsed every builtin's YAML again.
		return withPluginDiscoveryPass(() => withFrontmatterCache(() => discoverAgentRecipesInPass(cwd, diagnostics)));
	} finally {
		discoveryCatalogs = null;
	}
}

function discoverAgentRecipesInPass(cwd: string, diagnostics: AgentRecipeDiagnostic[]): ReadonlyArray<AgentRecipe> {
	const builtin = loadRecipesFromDir(
		{
			dir: path.join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
			cwd,
		},
		diagnostics,
	);
	const skillRoots = new Map(enabledPluginResourceRoots("skills", cwd).map((root) => [root.source, root.path]));
	const pluginRecipes = enabledPluginResourceRoots("agents", cwd)
		.sort((left, right) => left.source.localeCompare(right.source))
		.map((root) => {
			const skillRoot = skillRoots.get(root.source);
			return loadRecipesFromDir(
				{
					dir: root.path,
					source: "plugin",
					rootPath: root.rootPath,
					cwd,
					origin: root.source,
					...(skillRoot === undefined ? {} : { skillRoot }),
				},
				diagnostics,
			);
		});
	const user = loadRecipesFromDir({ dir: path.join(pancodeConfigDir(), "agents"), source: "user", cwd }, diagnostics);
	const project = loadRecipesFromDir(
		{ dir: path.join(pancodeProjectRoot(cwd, "agents"), ".pancode", "agents"), source: "project", cwd },
		diagnostics,
	);
	return mergeRecipes(diagnostics, builtin, ...pluginRecipes, user, project);
}
