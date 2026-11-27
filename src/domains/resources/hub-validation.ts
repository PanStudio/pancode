// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { isRecord } from "../../core/type-guards.js";
import { parseFrontmatter } from "../agents/frontmatter.js";
import { parsePlaybook, resolvePlaybookReferences } from "../agents/playbook.js";
import { recipeIdFromPath } from "../agents/recipe.js";
import { parseAgentRecipeSchema } from "../agents/recipe-schema.js";
import { assertAgentSpecPolicy, normalizeAgentSpec } from "../agents/spec.js";
import { loadManifestFromRoot } from "../extensions/index.js";
import { loadPluginMcpFile } from "../gateway/mcp/config.js";
import { pluginResourcePath } from "../plugins/discovery.js";
import type { PluginCandidate, PluginManifest } from "../plugins/types.js";
import { readHubManifest } from "./hub-packages.js";
import { resolvePackageReferences } from "./package-references.js";
import { loadPromptTemplates, type PromptTemplateRoot } from "./prompts/loader.js";
import { skillAuthoringDiagnostics } from "./skills/authoring-check.js";
import { loadSkills, type Skill, type SkillRoot, skillCatalogValidity } from "./skills/loader.js";

export type HubValidationSeverity = "warning" | "error";

export interface HubValidationDiagnostic {
	severity: HubValidationSeverity;
	code: string;
	message: string;
	path?: string | undefined;
	componentRef?: string | undefined;
	kind?: string | undefined;
}

export interface HubComponentValidationRecord {
	kind: string;
	name: string;
	path: string;
	componentRef?: string | undefined;
	/** Authored description when the resource parsed; body text is never carried. */
	description?: string | undefined;
	valid: boolean;
	diagnostics: HubValidationDiagnostic[];
}

export interface HubValidationPrerequisite {
	type: "command" | "agent" | "capability";
	identifier: string;
	description?: string | undefined;
	sourcePath?: string | undefined;
}

export interface HubPackageValidation {
	contentValid: boolean;
	resources: HubComponentValidationRecord[];
	diagnostics: HubValidationDiagnostic[];
	prerequisites: HubValidationPrerequisite[];
}

export interface HubPackageValidationResult extends PluginCandidate {
	manifestValid: boolean;
	validation: HubPackageValidation;
}

function normalizePathRel(root: string, targetPath: string): string {
	return path.relative(root, targetPath).split(path.sep).join("/");
}

function parseRefErrorCode(message: string, fallback: string): string {
	return message.includes("component reference") || message.includes("package path")
		? "ERR_PACKAGE_REFERENCE"
		: fallback;
}

export interface HubValidationOptions {
	cwd?: string;
	/**
	 * Also hold skills to the authoring checks: body references, routing names,
	 * length and verification age. Installing and inspecting a package never ask
	 * for these, since a broken link in a third party's prose is its author's bug.
	 */
	authoring?: { knownSkills: ReadonlySet<string> };
}

/** The servers of the PanKit policy manifest this PanCode ships, or why that file cannot serve as one. */
function shippedKitServers(): Record<string, unknown>[] | string {
	const file = path.join(resolvePackageRoot(), "packages", "kit", "servers.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		return `the shipped PanKit policy ${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (!isRecord(parsed) || parsed.version !== 1)
		return `the shipped PanKit policy ${file} is not version 1 of the server manifest`;
	if (!Array.isArray(parsed.servers) || !parsed.servers.every(isRecord))
		return `the shipped PanKit policy ${file} has no list of server entries`;
	return parsed.servers;
}

/**
 * Whether `root` is the first-party pack of server `id` inside this PanCode
 * package. Only that directory may supply a builtin-form pack to an index or an
 * install; validation alone accepts any copy whose policy matches.
 */
export function isBundledServerPack(root: string, id: string): boolean {
	try {
		const bundled = bundledServerPackDir(id);
		if (realpathSync(root) === realpathSync(bundled)) return true;
		// A case-insensitive filesystem can keep the caller's spelling in the real path, so compare the directory itself.
		const [a, b] = [statSync(root, { bigint: true }), statSync(bundled, { bigint: true })];
		return a.isDirectory() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
	} catch {
		return false;
	}
}

/** Where this PanCode package keeps the first-party pack of server `id`. */
export function bundledServerPackDir(id: string): string {
	return path.join(resolvePackageRoot(), "hub", "packs", "servers", id);
}

/** The facts of one server PanKit ships, as its policy manifest states them. */
export interface ShippedServerPolicy {
	version: string;
	title: string;
	tools: Array<{ name: string; actionClass: string }>;
	environment: string[];
}

/**
 * The shipped policy of server `id` when the pack at `root` holds exactly that entry in `server.json`, or why it
 * does not. The facts come from the shipped manifest, so a changed copy is reported rather than described.
 */
export function shippedServerPolicy(root: string, id: string): ShippedServerPolicy | string {
	const file = path.join(root, "server.json");
	let entry: unknown;
	try {
		entry = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		return `${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`;
	}
	const servers = shippedKitServers();
	if (typeof servers === "string") return servers;
	const shipped = servers.find((server) => server.id === id);
	if (shipped === undefined) return `${id} is not a server PanKit ships`;
	if (JSON.stringify(shipped) !== JSON.stringify(entry))
		return `${file} differs from the ${id} entry of packages/kit/servers.json`;
	const { version, title, tools, environment } = shipped;
	if (
		typeof version !== "string" ||
		typeof title !== "string" ||
		!Array.isArray(tools) ||
		!tools.every((tool) => isRecord(tool) && typeof tool.name === "string" && typeof tool.actionClass === "string") ||
		!Array.isArray(environment) ||
		!environment.every((name) => typeof name === "string")
	)
		return `the ${id} entry of packages/kit/servers.json lacks a version, title, tools or environment`;
	return {
		version,
		title,
		tools: tools.map((tool) => ({ name: tool.name as string, actionClass: tool.actionClass as string })),
		environment: environment as string[],
	};
}

/**
 * A server pack holds one server in one of two forms. The builtin form is
 * `server.json`, one server's entry of the PanKit policy manifest; only the
 * servers PanCode ships have it, so the file must equal the shipped entry of
 * the same id. The launcher form is `mcp.json` declaring exactly one stdio
 * server named like the pack, which installs as a plugin-scope declaration.
 */
function validateServerPack(root: string, manifest: PluginManifest): HubComponentValidationRecord[] {
	const hasPolicy = existsSync(path.join(root, "server.json"));
	const hasLauncher = existsSync(path.join(root, "mcp.json"));
	const form = hasLauncher && !hasPolicy ? "mcp.json" : "server.json";
	const fail = (message: string): HubComponentValidationRecord[] => [
		{
			kind: "server",
			name: manifest.name,
			path: form,
			valid: false,
			diagnostics: [{ severity: "error", code: "ERR_SERVER", message, path: path.join(root, form), kind: "server" }],
		},
	];
	if (hasPolicy && hasLauncher) return fail("a server pack holds server.json or mcp.json, not both");
	if (!hasPolicy && !hasLauncher) return fail("a server pack holds its server in server.json or mcp.json");
	if (hasLauncher) return validateLauncherServer(root, manifest, fail);
	const file = path.join(root, "server.json");
	let entry: unknown;
	try {
		entry = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		return fail(`server.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string")
		return fail("server.json is one server's entry of the PanKit policy manifest");
	if (entry.id !== manifest.name) return fail(`server.json names ${entry.id}, not the pack name ${manifest.name}`);
	if (entry.version !== manifest.version)
		return fail(`server.json has version ${String(entry.version)}, not the pack version ${manifest.version}`);
	const servers = shippedKitServers();
	if (typeof servers === "string") return fail(servers);
	const shipped = servers.find((server) => server.id === entry.id);
	if (shipped === undefined) return fail(`${entry.id} is not a server PanKit ships; only those have a server.json`);
	if (JSON.stringify(shipped) !== JSON.stringify(entry))
		return fail(`server.json differs from the ${entry.id} entry of packages/kit/servers.json; run pnpm kit:manifest`);
	return [
		{ kind: "server", name: entry.id, path: "server.json", description: entry.title, valid: true, diagnostics: [] },
	];
}

/**
 * The launcher form: `mcp.json` declares exactly one stdio server whose id is the pack name, in the shape a plugin's
 * `mcp.json` has and checked by the loader that later declares it, so a pack that validates also loads.
 */
function validateLauncherServer(
	root: string,
	manifest: PluginManifest,
	fail: (message: string) => HubComponentValidationRecord[],
): HubComponentValidationRecord[] {
	const servers = shippedKitServers();
	if (typeof servers === "string") return fail(servers);
	if (servers.some((server) => server.id === manifest.name))
		return fail(`${manifest.name} is a server PanCode carries; a server pack cannot take its name`);
	const loaded = loadPluginMcpFile({ id: manifest.name, scope: "user", rootPath: root, contentDigest: "" });
	const refused = loaded.diagnostics.find((diagnostic) => diagnostic.severity !== "warning");
	if (refused !== undefined) return fail(`mcp.json: ${refused.message}`);
	const [server] = loaded.servers;
	if (!server || loaded.servers.length !== 1)
		return fail(`mcp.json declares ${loaded.servers.length} servers; a server pack declares exactly one`);
	if (server.id !== manifest.name)
		return fail(`mcp.json declares server ${server.id}, not the pack name ${manifest.name}`);
	return [
		{
			kind: "server",
			name: server.id,
			path: "mcp.json",
			...(manifest.description !== undefined ? { description: manifest.description } : {}),
			valid: true,
			diagnostics: loaded.diagnostics.map((diagnostic) => ({
				severity: "warning",
				code: "WARN_SERVER",
				message: `mcp.json: ${diagnostic.message}`,
				path: diagnostic.path,
				kind: "server",
			})),
		},
	];
}

export function validateHubPackage(
	packageRoot: string,
	options: HubValidationOptions = {},
): HubPackageValidationResult {
	const resolved = path.resolve(packageRoot);
	const candidate = readHubManifest(resolved);

	if (!candidate.valid || !candidate.manifest) {
		const manifestErrors: HubValidationDiagnostic[] = candidate.diagnostics.map((diag) => ({
			severity: diag.type === "error" ? "error" : "warning",
			code: "ERR_MANIFEST",
			message: diag.message,
			path: diag.path,
		}));
		return {
			...candidate,
			manifestValid: false,
			valid: false,
			validation: {
				contentValid: false,
				resources: [],
				diagnostics: manifestErrors,
				prerequisites: [],
			},
		};
	}

	const manifest = candidate.manifest;
	const packageKind = manifest.pancode.kind ?? "plugin";
	const declaredResources = manifest.pancode.resources ?? {};
	const declaredComponents = manifest.pancode.components ?? [];

	const contentDiagnostics: HubValidationDiagnostic[] = [];
	const resources: HubComponentValidationRecord[] = [];
	const prerequisites: HubValidationPrerequisite[] = [];

	if (packageKind === "extension" || existsSync(path.join(resolved, "pancode-extension.yaml"))) {
		const facet = loadManifestFromRoot(resolved);
		for (const diagnostic of facet.diagnostics)
			contentDiagnostics.push({
				severity: diagnostic.type === "error" ? "error" : "warning",
				code: "ERR_EXTENSION",
				message: diagnostic.message,
				path: diagnostic.path,
				kind: "extension",
			});
		if (facet.manifest)
			resources.push({
				kind: "extension",
				name: facet.manifest.id,
				path: path.relative(resolved, facet.manifestPath ?? resolved),
				description: facet.manifest.description,
				valid: facet.valid,
				diagnostics: [],
			});
	}

	if (packageKind === "server")
		for (const record of validateServerPack(resolved, manifest)) {
			resources.push(record);
			contentDiagnostics.push(...record.diagnostics);
		}

	// ---------------------------------------------------------------------------
	// 1. Skills
	// ---------------------------------------------------------------------------
	const loadedSkills = new Map<string, Skill>();
	let skillRootDir: string | undefined;
	if (declaredResources.skills !== undefined || existsSync(path.join(resolved, "skills"))) {
		const relativeSkills = declaredResources.skills ?? "skills";
		try {
			skillRootDir = pluginResourcePath(resolved, relativeSkills, packageKind === "skill" && relativeSkills === ".");
			const skillRoot: SkillRoot = {
				path: skillRootDir,
				scope: "package",
				source: "plugin",
				rootPath: resolved,
				containment: resolved,
			};
			const skillList = loadSkills({ roots: [skillRoot], disableDiscovery: true, cwd: resolved });
			const validity = skillCatalogValidity(skillList);
			const loadedPaths = new Set(skillList.items.map((s) => s.filePath));
			const authoring = options.authoring;
			const knownSkills = authoring
				? new Set([...authoring.knownSkills, ...skillList.items.map((item) => item.name)])
				: undefined;

			if (!validity.ok) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_SKILL",
					message: `skill catalog invalid: ${validity.reason}`,
					path: skillRootDir,
					kind: "skill",
				});
			}

			for (const skill of skillList.items) {
				loadedSkills.set(skill.name, skill);
				const relPath = normalizePathRel(resolved, skill.filePath);
				const checked = knownSkills
					? [...skill.diagnostics, ...skillAuthoringDiagnostics(skill, { knownSkills })]
					: skill.diagnostics;
				const hasHardError = checked.some((d) => d.type === "error" || d.type === "collision");
				const skillDiags: HubValidationDiagnostic[] = checked.map((d) => ({
					severity: d.type === "error" || d.type === "collision" ? "error" : "warning",
					code: d.type === "error" || d.type === "collision" ? "ERR_SKILL" : "WARN_SKILL",
					message: d.message,
					path: d.path ?? skill.filePath,
					kind: "skill",
				}));
				for (const d of skillDiags) {
					if (d.severity === "error") contentDiagnostics.push(d);
				}
				resources.push({
					kind: "skill",
					name: skill.name,
					path: relPath,
					description: skill.description,
					valid: !hasHardError,
					diagnostics: skillDiags,
				});
			}

			for (const diag of skillList.diagnostics) {
				const isUnloadable = diag.path !== undefined && !loadedPaths.has(diag.path);
				const isHard = diag.type === "error" || diag.type === "collision" || isUnloadable;
				if (isHard) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_SKILL",
						message: diag.message,
						path: diag.path,
						kind: "skill",
					});
				}
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_SKILL",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, relativeSkills),
				kind: "skill",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 2. Prompts
	// ---------------------------------------------------------------------------
	if (declaredResources.prompts !== undefined) {
		try {
			const promptsDir = pluginResourcePath(resolved, declaredResources.prompts);
			const promptRoot: PromptTemplateRoot = {
				path: promptsDir,
				scope: "package",
				source: "plugin",
				plugin: true,
				trusted: true,
				rootPath: resolved,
			};
			const promptList = loadPromptTemplates({ roots: [promptRoot] });
			const loadedPromptPaths = new Set(promptList.items.map((p) => p.filePath));

			for (const template of promptList.items) {
				const relPath = normalizePathRel(resolved, template.filePath);
				const isUnavailable = template.unavailable !== undefined;
				const templateDiags: HubValidationDiagnostic[] = [];
				if (isUnavailable) {
					const diag: HubValidationDiagnostic = {
						severity: "error",
						code: "ERR_PROMPT",
						message: `prompt template /${template.name} cannot run: ${template.unavailable}`,
						path: template.filePath,
						kind: "prompt",
					};
					templateDiags.push(diag);
					contentDiagnostics.push(diag);
				}
				resources.push({
					kind: "prompt",
					name: template.name,
					path: relPath,
					description: template.description,
					valid: !isUnavailable,
					diagnostics: templateDiags,
				});
			}

			for (const diag of promptList.diagnostics) {
				const isDropped = diag.path !== undefined && !loadedPromptPaths.has(diag.path);
				const isHard = diag.type === "error" || diag.type === "collision" || isDropped;
				if (isHard) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_PROMPT",
						message: diag.message,
						path: diag.path,
						kind: "prompt",
					});
				}
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_PROMPT",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.prompts),
				kind: "prompt",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 3. Agents
	// ---------------------------------------------------------------------------
	if (declaredResources.agents !== undefined) {
		try {
			const agentsDir = pluginResourcePath(resolved, declaredResources.agents);
			let agentEntries: import("node:fs").Dirent[] = [];
			try {
				agentEntries = readdirSync(agentsDir, { withFileTypes: true });
			} catch (err) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_AGENT",
					message: `cannot read agents directory: ${err instanceof Error ? err.message : String(err)}`,
					path: agentsDir,
					kind: "agent",
				});
			}

			for (const entry of agentEntries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const filepath = path.join(agentsDir, entry.name);
				const relPath = normalizePathRel(resolved, filepath);
				const agentDiags: HubValidationDiagnostic[] = [];
				let recipeName = path.basename(entry.name, ".md");
				let recipeDescription: string | undefined;

				try {
					const id = recipeIdFromPath(filepath, agentsDir);
					recipeName = id;
					const raw = readFileSync(filepath, "utf8");
					const { frontmatter, body: rawBody } = parseFrontmatter(raw, filepath);
					const body = resolvePackageReferences(rawBody, { rootPath: resolved, plugin: true });
					const recipe = parseAgentRecipeSchema({ id, source: "plugin", filepath, body, frontmatter });
					recipeDescription = recipe.description;

					if (recipe.skills.length > 0) {
						if (packageKind === "agent") {
							agentDiags.push({
								severity: "error",
								code: "ERR_AGENT",
								message: `agent: ${filepath}: a standalone agent cannot bind external skills; must declare skills: []`,
								path: filepath,
								kind: "agent",
							});
						} else if (!skillRootDir) {
							agentDiags.push({
								severity: "error",
								code: "ERR_AGENT",
								message: `agent: ${filepath}: plugin declares bound skills but no skills resource root`,
								path: filepath,
								kind: "agent",
							});
						} else {
							const canonicalSkillRoot = realpathSync(skillRootDir);
							for (const skillName of recipe.skills) {
								const skill = loadedSkills.get(skillName);
								if (!skill?.trusted) {
									agentDiags.push({
										severity: "error",
										code: "ERR_AGENT",
										message: `agent: ${filepath}: bound skill unavailable: ${skillName}`,
										path: filepath,
										kind: "agent",
									});
								} else {
									const canonicalSkill = realpathSync(skill.filePath);
									const relative = path.relative(canonicalSkillRoot, canonicalSkill);
									if (relativePathEscapes(relative)) {
										agentDiags.push({
											severity: "error",
											code: "ERR_AGENT",
											message: `agent: ${filepath}: bound skill escapes its plugin: ${skill.filePath}`,
											path: filepath,
											kind: "agent",
										});
									}
								}
							}
						}
					}

					assertAgentSpecPolicy(normalizeAgentSpec(recipe));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					agentDiags.push({
						severity: "error",
						code: parseRefErrorCode(message, "ERR_AGENT"),
						message,
						path: filepath,
						kind: "agent",
					});
				}

				for (const d of agentDiags) contentDiagnostics.push(d);
				resources.push({
					kind: "agent",
					name: recipeName,
					path: relPath,
					...(recipeDescription !== undefined ? { description: recipeDescription } : {}),
					valid: agentDiags.length === 0,
					diagnostics: agentDiags,
				});
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_AGENT",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.agents),
				kind: "agent",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 4. Playbooks
	// ---------------------------------------------------------------------------
	if (declaredResources.playbooks !== undefined) {
		try {
			const playbooksDir = pluginResourcePath(resolved, declaredResources.playbooks);
			let playbookEntries: import("node:fs").Dirent[] = [];
			try {
				playbookEntries = readdirSync(playbooksDir, { withFileTypes: true });
			} catch (err) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_PLAYBOOK",
					message: `cannot read playbooks directory: ${err instanceof Error ? err.message : String(err)}`,
					path: playbooksDir,
					kind: "playbook",
				});
			}

			for (const entry of playbookEntries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const filepath = path.join(playbooksDir, entry.name);
				const relPath = normalizePathRel(resolved, filepath);
				const playbookDiags: HubValidationDiagnostic[] = [];
				let publicName = path.basename(entry.name, ".md");
				let playbookDescription: string | undefined;

				try {
					const raw = readFileSync(filepath, "utf8");
					const playbook = parsePlaybook(raw, filepath);
					publicName = playbook.name;
					playbookDescription = playbook.description;
					const resolvedPlaybook = resolvePlaybookReferences(playbook, { source: "plugin", rootPath: resolved });

					for (const step of resolvedPlaybook.steps) {
						if (step.kind === "code") {
							prerequisites.push({
								type: "command",
								identifier: step.command,
								sourcePath: filepath,
								description: `playbook step '${step.id}' requires command '${step.command}'`,
							});
						} else if (step.kind === "agent") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `playbook step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "plan") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `playbook plan step '${step.id}' requires agent '${step.agent}'`,
								});
							}
							for (const rosterAgent of step.roster) {
								const isLocalRoster = resources.some((r) => r.kind === "agent" && r.name === rosterAgent);
								if (!isLocalRoster) {
									prerequisites.push({
										type: "agent",
										identifier: rosterAgent,
										sourcePath: filepath,
										description: `playbook plan step '${step.id}' roster requires agent '${rosterAgent}'`,
									});
								}
							}
						} else if (step.kind === "gate") {
							const isLocal = resources.some((r) => r.kind === "agent" && r.name === step.agent);
							if (!isLocal) {
								prerequisites.push({
									type: "agent",
									identifier: step.agent,
									sourcePath: filepath,
									description: `playbook gate step '${step.id}' requires agent '${step.agent}'`,
								});
							}
						} else if (step.kind === "loop") {
							if (step.check.kind === "code") {
								prerequisites.push({
									type: "command",
									identifier: step.check.command,
									sourcePath: filepath,
									description: `playbook loop step '${step.id}' check requires command '${step.check.command}'`,
								});
							} else if (step.check.kind === "agent") {
								const checkAgent = step.check.agent;
								const isLocal = resources.some((r) => r.kind === "agent" && r.name === checkAgent);
								if (!isLocal) {
									prerequisites.push({
										type: "agent",
										identifier: checkAgent,
										sourcePath: filepath,
										description: `playbook loop step '${step.id}' check requires agent '${checkAgent}'`,
									});
								}
							}
							const repairAgent = step.repair.agent;
							const isLocalRepair = resources.some((r) => r.kind === "agent" && r.name === repairAgent);
							if (!isLocalRepair) {
								prerequisites.push({
									type: "agent",
									identifier: step.repair.agent,
									sourcePath: filepath,
									description: `playbook loop step '${step.id}' repair requires agent '${step.repair.agent}'`,
								});
							}
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					playbookDiags.push({
						severity: "error",
						code: parseRefErrorCode(message, "ERR_PLAYBOOK"),
						message,
						path: filepath,
						kind: "playbook",
					});
				}

				for (const d of playbookDiags) contentDiagnostics.push(d);
				resources.push({
					kind: "playbook",
					name: publicName,
					path: relPath,
					...(playbookDescription !== undefined ? { description: playbookDescription } : {}),
					valid: playbookDiags.length === 0,
					diagnostics: playbookDiags,
				});
			}
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_PLAYBOOK",
				message: err instanceof Error ? err.message : String(err),
				path: path.join(resolved, declaredResources.playbooks),
				kind: "playbook",
			});
		}
	}

	// ---------------------------------------------------------------------------
	// 5. Component verification and omission detection
	// ---------------------------------------------------------------------------
	for (const comp of declaredComponents) {
		const componentRef = `${comp.kind}:${comp.id}`;
		let fullCompPath: string;
		try {
			fullCompPath = pluginResourcePath(resolved, comp.path);
		} catch (err) {
			contentDiagnostics.push({
				severity: "error",
				code: "ERR_COMPONENT",
				message: `component ${componentRef} path invalid: ${err instanceof Error ? err.message : String(err)}`,
				path: path.join(resolved, comp.path),
				componentRef,
				kind: comp.kind,
			});
			continue;
		}

		const normalizedCompPath = normalizePathRel(resolved, fullCompPath);

		if (["agent", "playbook", "skill", "prompt"].includes(comp.kind)) {
			if (comp.kind === "agent") {
				const agentsDir = declaredResources.agents ? pluginResourcePath(resolved, declaredResources.agents) : null;
				if (agentsDir && path.dirname(fullCompPath) !== agentsDir) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_COMPONENT",
						message: `component agent:${comp.id} at ${comp.path} is nested and cannot be discovered by runtime loader`,
						path: fullCompPath,
						componentRef,
						kind: "agent",
					});
				}
			} else if (comp.kind === "playbook") {
				const playbooksDir = declaredResources.playbooks ? pluginResourcePath(resolved, declaredResources.playbooks) : null;
				if (playbooksDir && path.dirname(fullCompPath) !== playbooksDir) {
					contentDiagnostics.push({
						severity: "error",
						code: "ERR_COMPONENT",
						message: `component playbook:${comp.id} at ${comp.path} is nested and cannot be discovered by runtime loader`,
						path: fullCompPath,
						componentRef,
						kind: "playbook",
					});
				}
			}

			const matched = resources.find((r) => r.path === normalizedCompPath && r.kind === comp.kind);
			if (!matched) {
				contentDiagnostics.push({
					severity: "error",
					code: "ERR_COMPONENT",
					message: `component ${componentRef} declared in manifest was not successfully loaded from ${comp.path}`,
					path: fullCompPath,
					componentRef,
					kind: comp.kind,
				});
			} else {
				matched.componentRef = componentRef;
			}
		} else {
			const exists = existsSync(fullCompPath) && statSync(fullCompPath).isFile();
			const diags: HubValidationDiagnostic[] = exists
				? []
				: [
						{
							severity: "error",
							code: "ERR_COMPONENT",
							message: `ancillary component ${componentRef} file does not exist: ${comp.path}`,
							path: fullCompPath,
							componentRef,
							kind: comp.kind,
						},
					];
			for (const d of diags) contentDiagnostics.push(d);
			resources.push({
				kind: comp.kind,
				name: comp.id,
				path: normalizedCompPath,
				componentRef,
				valid: exists,
				diagnostics: diags,
			});
		}
	}

	const contentValid = !contentDiagnostics.some((d) => d.severity === "error");
	const valid = true && contentValid;

	return {
		...candidate,
		manifestValid: true,
		valid,
		validation: {
			contentValid,
			resources,
			diagnostics: contentDiagnostics,
			prerequisites,
		},
	};
}
