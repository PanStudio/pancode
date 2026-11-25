// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { existsSync, readFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { isReleaseOnlyWorkflow, readCiFileRuns } from "../../core/ci-commands.js";
import { readJsonFile } from "../../core/json-file.js";
import { type TomlFileReader, tomlTableAt } from "../../core/toml.js";
import { pythonProposals } from "../../tools/verify/toolchain.js";
import { INTEROP_AGENT_KINDS } from "../interop/registry.js";
import { type ProjectPreloadClass, selectProjectPreload } from "../prompts/preload.js";
import type { ProjectType } from "../session/workspace/project-type.js";
import { type AdoptionScanResult, RULE_KEYWORDS } from "./adoption.js";
import type { BootstrapGenerateInput } from "./bootstrap-types.js";
import type { Codewiki } from "./codewiki/schema.js";
import { packageManager } from "./package-manager.js";
import type { PancodeMdSection } from "./pancode-md.js";
import { type ProjectMetadata, readProjectMetadata } from "./project-metadata.js";
import { renderPromptContext } from "./prompt-context.js";
import type { SiblingContextFile } from "./sibling-files.js";
import { contradictingFact, treeFacts } from "./tree-facts.js";

function stringField(value: unknown, key: string): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function titleFromPackageName(raw: string): string {
	const base = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
	return base
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

/**
 * A name a manifest chose is already the project's own spelling; a name read
 * off a package identifier or a directory is a slug that has to be titled.
 */
function projectNameFrom(metadata: ProjectMetadata, cwd: string): string {
	const declared = metadata.name;
	if (declared) {
		return metadata.nameSource === "package.json" ? titleFromPackageName(declared) : declared.slice(0, 80);
	}
	return titleFromPackageName(parse(cwd).base || "Project");
}

export function projectName(cwd: string, tomlFiles: TomlFileReader): string {
	return projectNameFrom(readProjectMetadata(cwd, tomlFiles), cwd);
}

function projectTypeLabel(projectType: ProjectType): string {
	switch (projectType) {
		case "typescript":
			return "TypeScript/Node.js";
		case "javascript":
			return "JavaScript/Node.js";
		case "python":
			return "Python";
		case "rust":
			return "Rust";
		case "go":
			return "Go";
		case "c":
			return "C";
		case "c++":
			return "C++";
		case "java":
			return "Java";
		case "ruby":
			return "Ruby";
		case "c#":
			return "C#";
		case "polyglot":
			return "polyglot";
		case "dotfiles":
			return "dotfiles";
		case "unknown":
			return "software";
	}
}

/** Only project-wide instructions may become unconditional handbook rules. */
export function handbookInstructionFiles(input: BootstrapGenerateInput): SiblingContextFile[] {
	const projectPaths = new Set(
		INTEROP_AGENT_KINDS.flatMap((kind) =>
			[...kind.instructionFiles, ...(kind.rootInstructionFiles ?? [])].map((file) => resolve(input.cwd, file)),
		),
	);
	const allowed = new Set(
		input.adoption.sources
			.filter((source) => {
				if (source.kind !== "instructions") return false;
				if (source.scope === "project") return projectPaths.has(source.path);
				return input.adoption.includeGlobal && source.path === resolve(input.adoption.homeDir, ".codex/AGENTS.md");
			})
			.map((source) => source.path),
	);
	return input.siblingFiles.filter((file) => allowed.has(file.path));
}

function allContextText(files: ReadonlyArray<SiblingContextFile>): string {
	return files.map((file) => file.content).join("\n\n");
}

interface DeterministicIdentity {
	/** The identity sentence the deterministic path produces. */
	text: string;
	/**
	 * True when nothing but the project name and the stack label reached the
	 * sentence, so `text` is the bare `<name> is a <stack> project.` template.
	 * That happens only when no manifest, no research metadata, and no README
	 * variant in this repository describes it at all. The flag is what decides
	 * whether a model-authored identity is allowed to win, so the caller never
	 * has to pattern-match the rendering.
	 */
	bare: boolean;
	/** Repo-relative file the description came from, or null when bare. */
	descriptionSource: string | null;
}

export function resolveDefaultIdentity(
	cwd: string,
	projectType: ProjectType,
	files: ReadonlyArray<SiblingContextFile>,
	tomlFiles: TomlFileReader,
): DeterministicIdentity {
	const metadata = readProjectMetadata(cwd, tomlFiles);
	const name = projectNameFrom(metadata, cwd);
	const context = allContextText(files);
	if (/PanCode owns the agent loop/i.test(context) && /pi-(?:ai|SDK)/i.test(context)) {
		return {
			text: [
				"PanCode is systems software for coding agents.",
				"pi-ai is accessed through the engine boundary.",
				"PanCode owns the agent loop, TUI, session format, tool registry, and identity.",
			].join(" "),
			bare: false,
			descriptionSource: null,
		};
	}
	const stack = projectTypeLabel(projectType);
	const head = `${name} is a ${stack} project.`;
	const description = metadata.description;
	if (!description) return { text: head.slice(0, 600), bare: true, descriptionSource: null };
	const cleaned = description.replace(/\.$/, "").trim();
	// A description is usually a noun phrase; one opening with an article
	// ("A coding agent for science") read as a verbless sentence after the head.
	const phrase = /^(?:A|An|The)\s/.test(cleaned) ? `${cleaned[0]?.toLowerCase() ?? ""}${cleaned.slice(1)}` : cleaned;
	const role = /^[a-z]/.test(phrase) ? `It is ${phrase}.` : `${phrase}.`;
	return { text: `${head} ${role}`.slice(0, 600), bare: false, descriptionSource: metadata.descriptionSource };
}

/**
 * Identity precedence for a stabilized handbook, below an existing `PANCODE.md`
 * identity, which always wins. The deterministic sentence is evidence read off
 * the repository, so it outranks anything the model wrote. The single exception
 * is the bare case: with no `package.json` description and no `README.md`
 * summary the deterministic path can only say `<name> is a <stack> project.`,
 * which tells a reader nothing the directory name did not. A model sentence is
 * strictly better than that, and only than that.
 */
export function stabilizedIdentity(
	input: BootstrapGenerateInput,
	modelIdentity: unknown,
	tomlFiles: TomlFileReader,
): string {
	const deterministic = resolveDefaultIdentity(input.cwd, input.projectType, handbookInstructionFiles(input), tomlFiles);
	const model = typeof modelIdentity === "string" ? modelIdentity.trim() : "";
	if (deterministic.bare && model.length > 0) return model;
	return deterministic.text;
}

export function pushUnique(target: string[], value: string): void {
	if (target.includes(value)) return;
	target.push(value);
}

const SKIP_BULLET_PATTERNS = [/^marker\s*[:=]/i, /marker[-_:]\s*\w+-\w+/i, /^todo\b/i, /^note\b/i, /^example\b/i];

function harvestSiblingBullets(files: ReadonlyArray<SiblingContextFile>): string[] {
	const out: string[] = [];
	for (const file of files) {
		for (const rawLine of file.content.split("\n")) {
			const match = /^[\s>]*[-*]\s+(.+?)\s*$/.exec(rawLine);
			if (!match) continue;
			const bullet = match[1]?.trim();
			if (!bullet || bullet.length < 5) continue;
			if (bullet.length > 200) continue;
			if (SKIP_BULLET_PATTERNS.some((re) => re.test(bullet))) continue;
			if (!RULE_KEYWORDS.test(bullet)) continue;
			out.push(bullet);
		}
	}
	return out;
}

/**
 * The extension local imports actually carry, measured from the specifiers the
 * indexer already extracted. Reported only on a clear majority so a repository
 * mid-migration is described as having no rule rather than the wrong one.
 */
function localImportExtension(codewiki: Codewiki): string | null {
	const counts = new Map<string, number>();
	let total = 0;
	for (const file of codewiki.files) {
		for (const specifier of file.imports) {
			if (!specifier.startsWith(".")) continue;
			total += 1;
			const extension = /\.([A-Za-z0-9]+)$/.exec(specifier)?.[1];
			const key = extension === undefined ? "" : `.${extension}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	if (total < 4) return null;
	for (const [extension, count] of counts) {
		if (extension.length > 0 && count / total >= 0.8) return extension;
	}
	return null;
}

export function inferConventions(cwd: string, files: ReadonlyArray<SiblingContextFile>, codewiki: Codewiki): string[] {
	const conventions: string[] = [];
	const context = allContextText(files);
	const pkg = readJsonFile(join(cwd, "package.json"));
	const packageText = typeof pkg === "object" && pkg !== null ? JSON.stringify(pkg) : "";
	// A convention here is read as fact on every turn, so it is measured or it
	// is not stated. The stack alone decides nothing: a repository that imports
	// `./money.ts` under allowImportingTsExtensions is told to break its own
	// build by a rule inferred from the presence of a tsconfig.
	const importExtension = localImportExtension(codewiki);
	if (importExtension !== null) {
		pushUnique(conventions, `Local imports end in \`${importExtension}\`.`);
	}
	if (/node:test/i.test(context) || /node --import tsx --test|node --test/.test(packageText)) {
		pushUnique(conventions, "Tests use `node:test`.");
	}
	// An uncited sibling bullet is kept only when no tree fact contradicts it; a cited one is adopted
	// only through the verified authored-rule pass, which checks its citations against the tree.
	const facts = treeFacts(cwd);
	for (const bullet of harvestSiblingBullets(files)) {
		if (!/`[^`\n]+`/.test(bullet) && !contradictingFact(bullet, facts)) pushUnique(conventions, bullet);
	}
	return conventions.slice(0, 6);
}

export function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

/** Measure how the session compiler will preload the on-disk project context. */
export function measureProjectPreload(cwd: string): ProjectPreloadClass {
	const promptContext = renderPromptContext(cwd);
	return selectProjectPreload(promptContext, null, { cwd }).classification;
}

export function packageScripts(cwd: string): Record<string, string> {
	const pkg = readJsonFile(join(cwd, "package.json"));
	if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return {};
	const scripts = (pkg as Record<string, unknown>).scripts;
	if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
	const out: Record<string, string> = {};
	for (const [name, command] of Object.entries(scripts)) {
		if (typeof command === "string" && command.trim().length > 0) out[name] = command.trim();
	}
	return out;
}

/** A script whose command rewrites the tree cannot serve as a verification gate. */
const MUTATING_SCRIPT_RE = /(?:^|\s)--(?:fix|write)(?:\s|$)/;

/**
 * First preset a human could actually invoke: named and not hidden. Hidden
 * presets exist only to be inherited from, so naming one in the handbook would
 * hand the agent a command CMake refuses to run.
 */
function cmakePresetName(presets: unknown, key: string): string | null {
	if (typeof presets !== "object" || presets === null || Array.isArray(presets)) return null;
	const list = (presets as Record<string, unknown>)[key];
	if (!Array.isArray(list)) return null;
	for (const entry of list) {
		if ((entry as Record<string, unknown> | null)?.hidden === true) continue;
		const name = stringField(entry, "name");
		if (name !== null) return name;
	}
	return null;
}

/**
 * CMake presets are the project's own declared configure/build/test recipes,
 * the same authority package.json scripts carry for Node. A CMake tree without
 * presets stays silent: nothing there declares a runnable command, and a
 * guessed `cmake -B build` fails on exactly the toolchain-file and MPI-wrapper
 * projects this tool targets. Configure, build, and test are each named
 * independently: a project can declare a visible build preset without a
 * visible configure preset (e.g. the configure preset is the hidden base
 * every build preset inherits from), and that build command is still one the
 * agent can run.
 */
function cmakeVerificationLines(cwd: string): string[] {
	const presets = readJsonFile(join(cwd, "CMakePresets.json"));
	if (presets === null) return [];
	const configure = cmakePresetName(presets, "configurePresets");
	const build = cmakePresetName(presets, "buildPresets");
	const test = cmakePresetName(presets, "testPresets");
	const lines: string[] = [];
	if (configure !== null) lines.push(`Configure with \`cmake --preset ${configure}\`.`);
	if (build !== null) lines.push(`Build with \`cmake --build --preset ${build}\`.`);
	if (test !== null) lines.push(`Run tests with \`ctest --preset ${test}\`.`);
	return lines;
}

/**
 * Python has no single scripts manifest, so this names a runner only where the
 * project declares one: a tox configuration declares `tox`, a pytest
 * configuration or dependency declares `pytest`, and test modules under
 * `tests/` with neither declare the standard-library unittest runner. A uv
 * project runs each through `uv run`, because a bare interpreter does not see
 * the project environment. Tox wins when both are declared because it
 * typically wraps the pytest run. Detection is shared with the verify tool's
 * derived checks, so the handbook names the command verify would run.
 */
function pythonVerificationLines(cwd: string, tomlFiles: TomlFileReader): string[] {
	const launcher = existsSync(join(cwd, "uv.lock")) ? "uv run " : "";
	const pyproject = tomlFiles.read("pyproject.toml");
	if (existsSync(join(cwd, "tox.ini")) || (pyproject !== null && tomlTableAt(pyproject, ["tool", "tox"]))) {
		return [`Run \`${launcher}tox\`.`];
	}
	if (
		existsSync(join(cwd, "pytest.ini")) ||
		(pyproject !== null && tomlTableAt(pyproject, ["tool", "pytest", "ini_options"]))
	) {
		return [`Run \`${launcher}pytest\`.`];
	}
	const derived = pythonProposals(cwd, []).find((proposal) => proposal.tags.includes("test"));
	return derived ? [`Run the Python tests with \`${derived.command.join(" ")}\`.`] : [];
}

/** CI steps that prepare the machine rather than judge the change. */
const CI_SETUP_RE =
	/^(?:uv\s+(?:sync|venv|pip|python\s+install)|pip3?\s+install|python3?\s+-m\s+pip\b|(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b|yarn$|corepack\b|sudo\b|apt(?:-get)?\b|brew\b|curl\b|wget\b|git\s+(?:config|fetch|clone|submodule)\b|cd\b|echo\b|export\b|mkdir\b|cp\b|mv\b|rm\b|ls\b|cat\b)/;
const MAX_CI_GATE_COMMANDS = 8;

/**
 * The commands each pipeline file runs, named exactly with the events that
 * start it. A repository whose gate is a script (`scripts/gate.sh`) or a make
 * target declares nothing a manifest reader sees, so without this line its
 * handbook named no command and agents recorded that they could not run the
 * tests. The line states what a file runs, never that CI gates a change, and a
 * workflow that runs only on a tag or a release is left out.
 */
function ciGateLines(cwd: string): string[] {
	const named = new Set<string>();
	const lines: string[] = [];
	for (const { file, commands, triggers } of readCiFileRuns(cwd)) {
		if (isReleaseOnlyWorkflow(triggers)) continue;
		const steps = commands
			.filter((command) => !CI_SETUP_RE.test(command) && !command.includes("$") && !command.includes("`"))
			.filter((command) => !named.has(command))
			.slice(0, MAX_CI_GATE_COMMANDS - named.size);
		if (steps.length === 0) continue;
		for (const command of steps) named.add(command);
		const events = triggers ? ` on ${triggers.map((entry) => `\`${entry.event}\``).join(", ")}` : "";
		lines.push(`\`${file}\` runs ${steps.map((command) => `\`${command}\``).join(", ")}${events}.`);
		if (named.size >= MAX_CI_GATE_COMMANDS) break;
	}
	if (lines.length === 0) return [];
	return [...lines, "These are workflow steps, not authorization to expand the current task."];
}

export function verificationSection(cwd: string, tomlFiles: TomlFileReader): PancodeMdSection | null {
	const scripts = packageScripts(cwd);
	const pm = packageManager(cwd);
	const hasScript = (name: string) => typeof scripts[name] === "string";
	const command = (name: string) => `\`${pm} run ${name}\``;
	// Prefer a non-mutating `:check` variant. Naming an autofixer as the gate
	// tells the agent to rewrite the working tree instead of judging it, which
	// turns a verification step into an unreviewed diff.
	const gate = (name: string): string | null => {
		if (hasScript(`${name}:check`)) return `${name}:check`;
		return hasScript(name) && !MUTATING_SCRIPT_RE.test(scripts[name] ?? "") ? name : null;
	};
	const lines: string[] = [];
	const baseline = ["typecheck", "lint", "format"]
		.map(gate)
		.filter((name): name is string => name !== null)
		.map(command);
	if (baseline.length > 0) {
		lines.push(`Available static checks: ${baseline.join(", ")}.`);
	}
	if (hasScript("build")) {
		lines.push(`Build command: ${command("build")}; rebuild when the selected validation consumes compiled output.`);
	}
	const targeted = ["test:contracts", "test:smoke", "check:boundaries"].filter(hasScript).map(command);
	if (targeted.length > 0) {
		lines.push(`Use targeted checks for narrower risk: ${targeted.join(", ")}.`);
	}
	if (hasScript("test")) {
		lines.push(`Declared test command: ${command("test")}.`);
		const selection = scripts.test;
		// Preserve literal selection rather than guessing that every test root runs in CI.
		// Oversized or Markdown-active commands remain available at their source path.
		if (selection && selection.length <= 1200 && !/[`\r\n]/.test(selection)) {
			lines.push(
				`Exact package.json#scripts.test: \`${selection}\`. Other test scripts have separate selection; check which command runs a test before claiming coverage.`,
			);
		}
	}
	if (hasScript("ci")) {
		lines.push(`Full CI command, when requested: ${command("ci")}.`);
	}
	lines.push(...cmakeVerificationLines(cwd));
	// Cargo's commands are defined by the toolchain, not by each project, so
	// naming them for any Cargo workspace carries the same confidence as a
	// declared package script.
	const cargo = tomlFiles.read("Cargo.toml");
	if (cargo !== null && (tomlTableAt(cargo, ["package"]) || tomlTableAt(cargo, ["workspace"]))) {
		lines.push("Cargo validation commands: `cargo build` and `cargo test`.");
	}
	// Go's commands are defined by the toolchain, not by each project, so
	// naming them for any module carries the same confidence as a declared
	// package script.
	if (existsSync(join(cwd, "go.mod"))) {
		lines.push("Go validation commands: `go build ./...` and `go test ./...`.");
	}
	lines.push(...pythonVerificationLines(cwd, tomlFiles));
	lines.unshift(...ciGateLines(cwd));
	if (lines.length === 0) return null;
	lines.push(
		"Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.",
	);
	return { title: "Verification expectations", body: lines.join(" ") };
}

export const VERIFICATION_SECTION_RE = /\bverification\b/i;

/** Strictness flags whose meaning an agent cannot read off ordinary code. */
const TSCONFIG_STRICT_FLAGS: ReadonlyArray<readonly [string, string]> = [
	["exactOptionalPropertyTypes", "an optional property is omitted, never assigned `undefined`"],
	["noUncheckedIndexedAccess", "an index access yields `T | undefined`"],
	["noImplicitOverride", "an overriding member is marked `override`"],
	["noPropertyAccessFromIndexSignature", "an index-signature key is read with brackets"],
];

/**
 * The root `tsconfig.json` strictness flags a handbook does not already name,
 * as one convention. Two drafts in a row dropped this line, and it decides
 * whether code compiles.
 */
export function tsconfigConvention(cwd: string, handbook: string): string | null {
	let options: Record<string, unknown> = {};
	try {
		const raw = readFileSync(join(cwd, "tsconfig.json"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/,(\s*[}\]])/g, "$1");
		const parsed = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
		options = parsed.compilerOptions ?? {};
	} catch {
		// No root tsconfig, or one this reader cannot parse: no convention is stated.
		return null;
	}
	const enabled = TSCONFIG_STRICT_FLAGS.filter(([flag]) => options[flag] === true && !handbook.includes(flag));
	if (enabled.length === 0) return null;
	return `\`tsconfig.json\` enables ${enabled.map(([flag, meaning]) => `\`${flag}\` (${meaning})`).join(", ")}.`;
}

export function loadBootstrapSiblingFiles(adoption: AdoptionScanResult): SiblingContextFile[] {
	return adoption.sources.map((source) => ({
		source: source.scope,
		path: source.path,
		content: source.content,
	}));
}
