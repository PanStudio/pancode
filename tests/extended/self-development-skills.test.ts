// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it, type TestContext } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { PANCODE_SELF_DEVELOPMENT_SKILLS } from "../../src/core/pancode-repo.js";
import { agentSkillToolPolicy, withModelSkillActivation } from "../../src/core/skill-activation.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { createSkillsReminderRegistration } from "../../src/domains/middleware/skills-reminder.js";
import {
	clearPluginSnapshots,
	disablePlugin,
	installPlugin,
	listInstalledPlugins,
	pluginContentDigest,
} from "../../src/domains/plugins/index.js";
import type { SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadSkills, modelVisibleSkills } from "../../src/domains/resources/skills/loader.js";
import { AUTONOMY_LEVELS, modelMayActivateSkills } from "../../src/lib/autonomy/autonomy.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

async function fixture(t: TestContext, worktree = false) {
	const env = await isolatePancodeEnv("pancode-self-development-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "repo");
	mkdirSync(cwd);
	if (worktree) writeFileSync(path.join(cwd, ".git"), "gitdir: /fixture/worktree\n");
	else mkdirSync(path.join(cwd, ".git"));
	writeFileSync(
		path.join(cwd, "package.json"),
		JSON.stringify({ name: "@panstudio/pancode", repository: "https://github.com/PanStudio/pancode" }),
	);
	for (const marker of [
		"src/entry/orchestrator.ts",
		"src/worker/entry.ts",
		"src/domains/prompts/fragments/identity/pancode.md",
	]) {
		mkdirSync(path.dirname(path.join(cwd, marker)), { recursive: true });
		writeFileSync(path.join(cwd, marker), "fixture\n");
	}
	for (const name of PANCODE_SELF_DEVELOPMENT_SKILLS) {
		cpSync(
			new URL(`../../hub/packs/skills/meta/${name}/`, import.meta.url),
			path.join(cwd, "hub/packs/skills/meta", name),
			{
				recursive: true,
			},
		);
	}
	return { env, cwd };
}

for (const worktree of [false, true]) {
	it(`loads the two checkout skills through normal admission from a ${worktree ? "worktree" : "repository"} subdirectory`, async (t) => {
		const { env, cwd } = await fixture(t, worktree);
		const nested = path.join(cwd, "src");
		const list = loadSkills({ cwd: nested, home: env.dir });
		const source = modelVisibleSkills(list.items).filter((skill) => skill.sourceInfo.source === "self-development");
		deepStrictEqual(
			source.map((skill) => skill.name),
			[...PANCODE_SELF_DEVELOPMENT_SKILLS],
		);
		for (const level of AUTONOMY_LEVELS) {
			const context = createContextTool({ getCwd: () => nested, skillMarketplace: false });
			for (const name of PANCODE_SELF_DEVELOPMENT_SKILLS) {
				const pendingSkillPolicy = withModelSkillActivation(undefined, modelMayActivateSkills());
				const result = await context.run({ scope: "skills", name }, pendingSkillPolicy ? { pendingSkillPolicy } : {});
				strictEqual(result.kind, modelMayActivateSkills() ? "ok" : "error", level);
				if (result.kind === "ok") {
					ok(pendingSkillPolicy?.loadedSkillNames.has(name));
				} else match(result.message, /only the operator can activate/);
			}
		}
		const bound = withModelSkillActivation(agentSkillToolPolicy(["unrelated-skill"]), true);
		ok(bound);
		const denied = await createContextTool({ getCwd: () => nested }).run(
			{ scope: "skills", name: "pancode-dev" },
			{ pendingSkillPolicy: bound },
		);
		strictEqual(denied.kind, "error");
		if (denied.kind === "error") match(denied.message, /only its declared skill/);
	});
}

it("does not discover checkout skills outside the owning repo or when discovery is disabled", async (t) => {
	const { env, cwd } = await fixture(t);
	const nestedRepo = path.join(cwd, "nested");
	mkdirSync(path.join(nestedRepo, ".git"), { recursive: true });
	for (const input of [
		{ cwd, home: env.dir, disableDiscovery: true },
		{ cwd: nestedRepo, home: env.dir },
		{ cwd: env.dir, home: env.dir },
		{ cwd, home: env.dir, roots: [] },
	]) {
		strictEqual(
			loadSkills(input).items.some((skill) => skill.sourceInfo.source === "self-development"),
			false,
		);
	}
	rmSync(path.join(cwd, ".git"), { recursive: true });
	strictEqual(
		loadSkills({ cwd, home: env.dir }).items.some((skill) => skill.sourceInfo.source === "self-development"),
		false,
	);
});

it("honors hidden source skills and refuses source symlinks outside the checkout", async (t) => {
	const { env, cwd } = await fixture(t);
	const devPath = path.join(cwd, "hub/packs/skills/meta/pancode-dev/SKILL.md");
	writeFileSync(
		devPath,
		readFileSync(devPath, "utf8").replace("name: pancode-dev", "name: pancode-dev\ndisable-model-invocation: true"),
	);
	const testRoot = path.join(cwd, "hub/packs/skills/meta/pancode-test");
	const outside = path.join(env.dir, "outside");
	cpSync(testRoot, outside, { recursive: true });
	rmSync(testRoot, { recursive: true });
	symlinkSync(outside, testRoot, "dir");
	const loaded = loadSkills({ cwd, home: env.dir });
	strictEqual(
		modelVisibleSkills(loaded.items).some((skill) => PANCODE_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name)),
		false,
	);
	strictEqual(
		modelVisibleSkills(loadSkills({ cwd: path.join(cwd, "src"), home: env.dir }).items).some((skill) =>
			PANCODE_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name),
		),
		false,
	);
	ok(loaded.diagnostics.some((diagnostic) => /outside|escape/i.test(diagnostic.message)));
});

it("installed ownership prevents disabled or damaged packages from falling back to checkout skills", async (t) => {
	const { env, cwd } = await fixture(t);
	for (const [name, state] of [
		["pancode-dev", "disabled"],
		["pancode-test", "damaged"],
	] as const) {
		const source = path.join(cwd, "hub/packs/skills/meta", name);
		const installed = installPlugin(source, {
			cwd,
			scope: "project",
			expectedId: name,
			expectedDigest: pluginContentDigest(source),
		});
		trustProjectPackages(cwd, "plugins");
		const plugin = listInstalledPlugins(cwd).find((entry) => entry.id === name);
		ok(plugin?.loadable, JSON.stringify(installed.diagnostics));
		if (state === "disabled") {
			disablePlugin(name, { cwd, scope: "project" });
			trustProjectPackages(cwd, "plugins");
		} else writeFileSync(path.join(plugin.rootPath, "SKILL.md"), "damaged\n");
	}
	clearPluginSnapshots();
	for (const directory of [cwd, path.join(cwd, "src")]) {
		const loaded = loadSkills({ cwd: directory, home: env.dir });
		strictEqual(
			modelVisibleSkills(loaded.items).some((skill) =>
				PANCODE_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name),
			),
			false,
		);
	}
});

for (const overridePath of ["pancode-dev/SKILL.md", "pancode-dev.md", "custom-name/SKILL.md"]) {
	it(`a native local override at ${overridePath} retains ownership from root and subdirectory`, async (t) => {
		const { env, cwd } = await fixture(t);
		const file = path.join(cwd, ".pancode/skills", overridePath);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			"---\nname: pancode-dev\ndescription: Local override.\ndisable-model-invocation: true\n---\nLocal\n",
		);
		const loaded = loadSkills({ cwd, home: env.dir });
		strictEqual(loaded.items.find((skill) => skill.name === "pancode-dev")?.filePath, file);
		strictEqual(
			modelVisibleSkills(loaded.items).some((skill) => skill.name === "pancode-dev"),
			false,
		);
		strictEqual(
			modelVisibleSkills(loadSkills({ cwd: path.join(cwd, "src"), home: env.dir }).items).some(
				(skill) => skill.name === "pancode-dev",
			),
			false,
		);
	});
}

it("repo guidance tracks actual skill capability, autonomy and turn restrictions without injecting skill bodies", async (t) => {
	const { cwd } = await fixture(t);
	const context: DomainContext = { bus: createTelemetryHub(), getContract: () => undefined };
	const bundle = createPromptsBundle(context);
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	async function prompt(sessionInputs: SessionPromptInputs, autonomy = "default", workspace = cwd) {
		return bundle.contract.compileSessionPrompt({ sessionId: "self-dev", cwd: workspace, autonomy, sessionInputs });
	}
	const inputs = {
		coordinatorCapabilities: ["context"],
		toolNames: ["context"],
		providerSupportsTools: true,
		readySkillCount: 2,
	};
	const automatic = await prompt(inputs);
	match(automatic.systemPrompt, /# Self-development skills/);
	match(automatic.systemPrompt, /without waiting for a separate skill request/);
	match(automatic.systemPrompt, /Never load both up front or for a step the task does not reach/);
	// CLI-P56: the fixed prefix says a skill loaded this session by any route is never loaded again, and the per-turn
	// list leaves out a skill the session already loaded.
	match(
		automatic.systemPrompt,
		/unless it is already loaded this session \(by you, by the operator's \/skill, or by the host\)/,
	);
	const ranked = (loaded: string[]) =>
		createSkillsReminderRegistration({
			countModelVisibleSkills: () => 2,
			modelMayActivateSkills: () => true,
			rankSkills: () => PANCODE_SELF_DEVELOPMENT_SKILLS.map((id) => ({ id, description: `${id} workflow`, score: 1 })),
			loadedSkillNames: () => loaded,
		})
			.evaluate({ hook: "turn_start", text: "Fix the parser in src", metadata: { conversationMessages: 0 } })
			.map((effect) => ("message" in effect ? effect.message : ""))
			.join("\n");
	match(ranked([]), /- pancode-dev:/);
	const afterLoad = ranked(["pancode-dev"]);
	strictEqual(afterLoad.includes("- pancode-dev:"), false, afterLoad);
	match(afterLoad, /- pancode-test:/);
	strictEqual(automatic.systemPrompt.includes("## Establish the actual assignment"), false);
	const headless = await prompt({ ...inputs, headless: true });
	match(headless.systemPrompt, /load pancode-dev before the first edit/);
	match(headless.systemPrompt, /skip one already loaded this session/);
	strictEqual(headless.systemPrompt.includes("does not load these skills"), false);
	const worker = await bundle.contract.compileWorkerPrompt({
		cwd,
		persona: { id: "agent.test", relPath: "inline/test", body: "Test worker.", contentHash: "test", dynamic: false },
		providerSupportsTools: true,
		toolNames: ["read"],
		toolPromptHints: [],
		hasCanonicalContext: false,
		hasBoundSkills: false,
		onPermission: "deny",
	});
	match(worker.systemPrompt, /# PanCode Source Tree/);
	for (const disabled of [
		{ ...inputs, skillDiscoveryEnabled: false },
		{ ...inputs, providerSupportsTools: false },
		{ ...inputs, readySkillCount: 0 },
		{ ...inputs, toolNames: ["read"] },
		{ ...inputs, turnConstraints: { skills: "disabled" } },
		{ ...inputs, turnConstraints: { mode: "answer" } },
		{ ...inputs, turnConstraints: { mode: "proposal" } },
		{ ...inputs, turnConstraints: { allowedTools: ["read"] } },
	] satisfies SessionPromptInputs[]) {
		strictEqual(
			(await prompt(disabled)).sections.some((section) => section.id === "context.self-development-skills"),
			false,
		);
	}
	strictEqual(
		(await prompt(inputs, "default", path.dirname(cwd))).systemPrompt.includes("# Self-development skills"),
		false,
	);
	const noSkills = createPromptsBundle(context, { noSkills: true });
	await noSkills.extension.start();
	t.after(() => noSkills.extension.stop?.());
	const suppressed = await noSkills.contract.compileSessionPrompt({ sessionId: "disabled", cwd, sessionInputs: inputs });
	strictEqual(suppressed.systemPrompt.includes("# Self-development skills"), false);
});

it("binds the self-development skills to built-in edit recipes that require context only in PanCode's checkout", async (t) => {
	const env = await isolatePancodeEnv("pancode-self-development-recipes-");
	t.after(() => env.restore());
	const dir = path.join(import.meta.dirname, "../../src/domains/agents/builtins");
	const bound = (cwd: string, id: string) =>
		loadRecipesFromDir({ source: "builtin", dir, cwd }).find((recipe) => recipe.id === id)?.skills ?? [];
	const repo = path.resolve(import.meta.dirname, "../..");
	ok(bound(repo, "coder").includes("pancode-dev"));
	ok(bound(repo, "coder").includes("pancode-test"));
	// verifier and tester do not require context, so agent spec policy forbids binding them a skill.
	deepStrictEqual(
		bound(repo, "verifier").filter((name) => name.startsWith("pancode-")),
		[],
	);
	deepStrictEqual(
		bound(repo, "scout").filter((name) => name.startsWith("pancode-")),
		[],
	);
	const elsewhere = env.dir;
	deepStrictEqual(
		bound(elsewhere, "coder").filter((name) => name.startsWith("pancode-")),
		[],
	);
});
