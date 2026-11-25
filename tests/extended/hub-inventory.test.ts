// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { readPluginCatalog } from "../../src/domains/plugins/catalog.js";
import { disablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/index.js";
import {
	classifyHubOrigin,
	type HubComponent,
	inspectHubCopy,
	parseHubResourceKey,
	readHubInventory,
} from "../../src/domains/resources/hub-inventory.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolatePancodeEnv, scratchPancodeEnvVars } from "../harness/scratch-env.js";

const kitSource = fileURLToPath(new URL("../fixtures/plugins/sample-kit/", import.meta.url));
const cliEntry = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

function write(root: string, name: string, text: string): void {
	const file = join(root, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function skill(root: string, dir: string, name: string, description = `Fixture ${name}`): void {
	write(root, `${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

/** A small plugin with one skill, one prompt, one playbook; agents are optional. */
function fixture(root: string, name: string, options: { duplicateSkill?: boolean; brokenPrompt?: boolean } = {}): void {
	skill(root, "skills/alpha", `${name}-alpha`);
	if (options.duplicateSkill) skill(root, "skills/beta", `${name}-alpha`, "Second file claiming the same name");
	write(
		root,
		`prompts/${name}/help.md`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal unresolved component reference is the broken-prompt fixture.
		`---\ndescription: ${name} help\n---\n${options.brokenPrompt ? "Read ${component:resource:missing}" : "Help text."}\n`,
	);
	write(
		root,
		`playbooks/${name}-review.md`,
		`---\nversion: 1\nname: ${name}-review\ndescription: ${name} review\nsteps:\n  - id: review\n    agent: coder\n    scope: readonly\n    dependencies: []\nmaxWorkers: 1\nonFailure: stop\n---\nReview.\n`,
	);
	write(
		root,
		"plugin.json",
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version: "1.0.0",
			description: `${name} fixture`,
			extensions: {
				"dev.pancode": {
					manifestVersion: 1,
					resources: { skills: "skills", prompts: "prompts", playbooks: "playbooks" },
					components: [],
				},
			},
		}),
	);
}

function byOwner(resources: ReadonlyArray<HubComponent>, ref: string): HubComponent[] {
	return resources.filter((item) => item.owner?.ref === ref);
}

function counts(resources: ReadonlyArray<HubComponent>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of resources) out[item.kind] = (out[item.kind] ?? 0) + 1;
	return out;
}

function cli(env: { dir: string }, cwd: string, args: string[]): { code: number; json: unknown; stderr: string } {
	const result = spawnSync(process.execPath, [cliEntry, "hub", ...args], {
		cwd,
		env: { ...process.env, ...scratchPancodeEnvVars(env.dir), HOME: env.dir },
		encoding: "utf8",
		timeout: 120000,
	});
	let json: unknown;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		json = undefined;
	}
	return { code: result.status ?? 1, json, stderr: result.stderr };
}

describe("hub inventory", () => {
	it("search requires every query word, matches trigger phrases and reports no matches", async () => {
		const env = await isolatePancodeEnv();
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			write(
				env.dir,
				"config/hub.yaml",
				stringify({
					entries: [
						{
							kind: "plugin",
							name: "needle",
							description: "Search fixture",
							triggers: ["rare workflow phrase"],
							sourceUrl: "https://github.com/example/repo/tree/v1/needle",
							version: "1.0.0",
							sha256: "a".repeat(64),
						},
					],
				}),
			);
			for (const query of ["needle fixture", "rare workflow phrase"]) {
				const result = cli(env, cwd, ["search", query, "--json"]);
				strictEqual(result.code, 0, result.stderr);
				ok(JSON.stringify(result.json).includes('"needle"'));
				strictEqual(readHubInventory({ cwd, query }).packages.length, 1);
			}
			strictEqual(readHubInventory({ cwd, query: "needle nonexistentword" }).packages.length, 0);
			const result = spawnSync(process.execPath, [cliEntry, "hub", "search", "nonexistentword"], {
				cwd,
				env: { ...process.env, ...scratchPancodeEnvVars(env.dir) },
				encoding: "utf8",
			});
			strictEqual(result.status, 0);
			match(result.stdout + result.stderr, /no .*match/i);
		} finally {
			env.restore();
		}
	});

	it("prints inactive packages without admitting their resources", async () => {
		const env = await isolatePancodeEnv();
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const src = join(env.dir, "inactive");
			fixture(src, "inactive");
			const installed = installPlugin(src, { cwd, scope: "user" });
			ok(installed.plugin);
			write(installed.plugin.rootPath, "skills/alpha/SKILL.md", "Changed.");
			strictEqual(byOwner(readHubInventory({ cwd }).resources, "plugin:inactive").length, 0);
			for (const args of [["components"], ["skills", "--all"]]) {
				const result = spawnSync(process.execPath, [cliEntry, "hub", ...args], {
					cwd,
					env: { ...process.env, ...scratchPancodeEnvVars(env.dir) },
					encoding: "utf8",
				});
				strictEqual(result.status, 0, result.stderr);
				match(result.stdout, /inactive.*user.*damaged/);
				const json = cli(env, cwd, [...args, "--json"]).json as { inactivePackages: Array<{ ref: string; state: string }> };
				ok(json.inactivePackages.some((p) => p.ref === "plugin:inactive" && p.state === "damaged"));
			}
		} finally {
			env.restore();
		}
	});

	it("reports sample-kit's actual 1 skill, 3 agents, 1 prompt and 1 playbook with owner, runtime names and local origin", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-sample-kit-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const installed = installPlugin(kitSource, {
				cwd,
				scope: "user",
				origin: { kind: "catalog", source: kitSource },
			});
			ok(installed.plugin?.loadable, JSON.stringify(installed.diagnostics));

			const inventory = readHubInventory({ cwd, home: env.dir });
			const owned = byOwner(inventory.resources, "plugin:sample-kit");
			deepStrictEqual(counts(owned), { skill: 1, agent: 3, prompt: 1, playbook: 1 });
			for (const item of owned) {
				strictEqual(item.owner?.scope, "user");
				strictEqual(item.availability, "available", `${item.key}: ${item.reason ?? ""}`);
				strictEqual(item.origin.kind, "local");
				strictEqual(item.format, "portable");
				strictEqual(item.source.class, "package");
				strictEqual(item.source.id, "plugin:user:sample-kit");
				ok(item.key.startsWith(`${item.kind}:${item.name}@plugin:user:sample-kit#`), item.key);
				ok(!("content" in item) && !("body" in item));
			}
			const skills = owned.filter((item) => item.kind === "skill").map((item) => item.name);
			ok(
				skills.every((name) => name.startsWith("sample-kit-")),
				skills.join(","),
			);
			deepStrictEqual(
				owned
					.filter((item) => item.kind === "agent")
					.map((item) => item.name)
					.sort(),
				["sample-kit-mechanized-reviewer", "sample-kit-modeled-reviewer", "sample-kit-reviewer"],
			);
			ok(owned.filter((item) => item.kind === "prompt").every((item) => item.name.startsWith("sample-kit:")));
			strictEqual(
				owned.find((item) => item.kind === "prompt" && item.name === "sample-kit:review")?.invocation,
				"/sample-kit:review",
			);
			strictEqual(owned.find((item) => item.kind === "playbook")?.name, "sample-kit-build-review");
			strictEqual(
				owned.find((item) => item.kind === "agent" && item.name === "sample-kit-reviewer")?.invocation,
				'dispatch(agent="sample-kit-reviewer")',
			);

			const copy = inventory.copies.find((item) => item.ref === "plugin:sample-kit");
			ok(copy);
			strictEqual(copy.state, "loadable");
			strictEqual(copy.origin.kind, "local");
			strictEqual(copy.trust, "trusted");

			const record = inventory.packages.find((item) => item.ref === "plugin:sample-kit");
			ok(record);
			// Rows name the installed copy's version (af26a2aa2).
			deepStrictEqual(record.copies, [{ scope: "user", state: "loadable", version: copy.version }]);
			ok(copy.version);

			// Explicit inspection keeps the declared component id separate from the runtime name.
			const inspection = inspectHubCopy("plugin:sample-kit", { cwd });
			const prompt = inspection.resources.find((item) => item.kind === "prompt" && item.name === "sample-kit:review");
			strictEqual(prompt?.componentId, "review");
			strictEqual(inspection.resources.filter((item) => item.kind === "prompt").length, 1);
		} finally {
			env.restore();
		}
	});

	it("finds a bundle by a provided recipe kind or name and returns the owning package, without fetching", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-search-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			// A remote row in the private index must be listed by metadata alone.
			write(
				env.dir,
				"config/hub.yaml",
				stringify({
					entries: [
						{
							kind: "plugin",
							name: "remote-bundle",
							description: "Remote catalog row without hints",
							sourceUrl: "https://github.com/example/bundles/tree/v1/remote-bundle",
							version: "1.0.0",
							sha256: "a".repeat(64),
						},
					],
				}),
			);
			const started = Date.now();
			const skills = readHubInventory({ cwd, home: env.dir, kinds: ["skill"], include: { resources: false } });
			ok(Date.now() - started < 5000);
			ok(skills.packages.some((item) => item.ref === "plugin:hpc"));
			ok(skills.packages.every((item) => item.kind === "skill" || item.provides?.some((hint) => hint.kind === "skill")));
			ok(!skills.packages.some((item) => item.ref === "plugin:remote-bundle"));

			const byName = readHubInventory({
				cwd,
				home: env.dir,
				query: "hpc-darshan",
				include: { resources: false },
			});
			deepStrictEqual(
				byName.packages.map((item) => item.ref),
				["plugin:hpc"],
			);
			deepStrictEqual(byName.packages[0]?.copies, []);

			const remote = readHubInventory({
				cwd,
				home: env.dir,
				ref: "plugin:remote-bundle",
				include: { resources: false },
			});
			strictEqual(remote.packages.length, 1);
			deepStrictEqual(remote.packages[0]?.origin, {
				kind: "remote",
				url: "https://github.com/example/bundles/tree/v1/remote-bundle",
				catalog: join(env.dir, "config", "hub.yaml"),
			});
			strictEqual(remote.packages[0]?.provides, undefined);
		} finally {
			env.restore();
		}
	});

	it("lists core and loose recipes as unmanaged sources with honest origin, trust and audience filtering", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-loose-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			skill(cwd, ".pancode/skills/project-skill", "project-skill");
			skill(env.dir, "config/skills/user-skill", "user-skill");
			skill(cwd, ".claude/skills/foreign-skill", "foreign-skill");
			write(
				env.dir,
				".claude/skills/odd-tools/SKILL.md",
				"---\nname: odd-tools\ndescription: Odd\nallowed-tools: Glob\n---\nOdd.\n",
			);
			write(cwd, ".pancode/prompts/local-help.md", "---\ndescription: Local help\n---\nHelp.\n");

			const operator = readHubInventory({ cwd, home: env.dir, trustProjectCompatRoots: false });
			const coder = operator.resources.find((item) => item.kind === "agent" && item.name === "coder");
			ok(coder);
			deepStrictEqual(coder.origin, { kind: "core" });
			strictEqual(coder.source.class, "core");
			strictEqual(coder.owner, undefined);
			strictEqual(coder.audience, "base");
			ok(!operator.resources.some((item) => item.name === "researcher"), "shadow agent hidden by default");
			ok(!operator.resources.some((item) => item.name === "context-bootstrap"), "internal agent hidden by default");
			ok(!operator.copies.some((item) => item.name === "coder"), "core recipes are not packages");

			const project = operator.resources.find((item) => item.name === "project-skill");
			ok(project);
			strictEqual(project.source.class, "project");
			strictEqual(project.source.id, "project");
			strictEqual(project.owner, undefined);
			deepStrictEqual(project.origin, { kind: "local", path: join(cwd, ".pancode/skills/project-skill/SKILL.md") });
			strictEqual(project.key, "skill:project-skill@project#.pancode/skills/project-skill/SKILL.md");
			strictEqual(project.invocation, "/skill project-skill");

			const user = operator.resources.find((item) => item.name === "user-skill");
			strictEqual(user?.source.class, "user");
			strictEqual(user?.source.id, "config");

			const foreign = operator.resources.find((item) => item.name === "foreign-skill");
			ok(foreign);
			strictEqual(foreign.source.class, "compat");
			strictEqual(foreign.availability, "untrusted");
			strictEqual(foreign.invocation, undefined);
			strictEqual(foreign.format, "claude-code");
			strictEqual(foreign.origin.kind, "local");
			strictEqual(foreign.origin.kind === "local" ? foreign.origin.host : undefined, "claude");

			strictEqual(operator.resources.find((item) => item.name === "local-help")?.invocation, "/local-help");

			const all = readHubInventory({ cwd, home: env.dir, all: true, kinds: ["agent"] });
			ok(all.resources.some((item) => item.name === "researcher" && item.audience === "shadow"));
			ok(all.resources.some((item) => item.name === "context-bootstrap" && item.audience === "internal"));

			const model = readHubInventory({
				cwd,
				home: env.dir,
				audience: "model",
				all: true,
				trustProjectCompatRoots: false,
			});
			strictEqual(model.audience, "model");
			ok(!model.resources.some((item) => item.name === "researcher"), "model never sees shadow agents");
			ok(!model.resources.some((item) => item.name === "foreign-skill"), "model never sees untrusted recipes");
			ok(model.resources.some((item) => item.name === "project-skill"));

			const trusted = readHubInventory({ cwd, home: env.dir, trustProjectCompatRoots: true, ref: "foreign-skill" });
			// Import trust admits imported packages; loose foreign folders remain discovery-only.
			strictEqual(trusted.resources[0]?.availability, "untrusted");
			strictEqual(trusted.resources[0]?.invocation, undefined);

			const onlyCore = readHubInventory({ cwd, home: env.dir, sources: ["core"] });
			ok(onlyCore.resources.length > 0);
			ok(onlyCore.resources.every((item) => item.source.class === "core"));
			// A foreign root's diagnostic is shown unfiltered and dropped by a `--source` that excludes it (R2-F9).
			ok(
				operator.diagnostics.some((item) => item.includes("odd-tools")),
				operator.diagnostics.join("\n"),
			);
			deepStrictEqual(
				onlyCore.diagnostics.filter((item) => item.includes("odd-tools")),
				[],
			);
		} finally {
			env.restore();
		}
	});

	it("keeps two scoped copies with actual precedence: a disabled valid project copy still shadows the user copy", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-scopes-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "source");
			fixture(source, "twin");
			write(source, "mcp.json", JSON.stringify({ mcpServers: { twin: { type: "stdio", command: "true" } } }));
			ok(installPlugin(source, { cwd, scope: "user" }).plugin?.loadable);
			ok(installPlugin(source, { cwd, scope: "project" }).plugin);
			trustProjectPackages(cwd, "plugins");

			let inventory = readHubInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state, item.overriddenBy]),
				[
					["project", "loadable", undefined],
					["user", "shadowed", "project"],
				],
			);
			deepStrictEqual(inventory.packages[0]?.copies, [
				{ scope: "project", state: "loadable", version: "1.0.0" },
				{ scope: "user", state: "shadowed", version: "1.0.0" },
			]);
			for (const copy of inventory.copies) deepStrictEqual(copy.origin, { kind: "local", path: source });
			const owned = byOwner(inventory.resources, "plugin:twin");
			deepStrictEqual(counts(owned), { skill: 1, prompt: 1, playbook: 1 });
			ok(owned.every((item) => item.owner?.scope === "project"));
			const userInspection = inspectHubCopy("plugin:twin", { cwd, scope: "user" });
			strictEqual(userInspection.copy.effective, false);
			strictEqual(userInspection.copy.state, "shadowed");
			strictEqual(userInspection.copy.loadable, false);
			// The validator's MCP note is already on the copy, so inspection does not repeat it (R2-F9).
			ok(userInspection.copy.diagnostics.some((item) => item.startsWith("MCP servers in mcp.json")));
			deepStrictEqual(
				userInspection.diagnostics.filter((item) => userInspection.copy.diagnostics.includes(item)),
				[],
			);

			deepStrictEqual(disablePlugin("twin", { cwd, scope: "project" }).diagnostics, []);
			trustProjectPackages(cwd, "plugins");
			inventory = readHubInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state, item.enabled, item.effective]),
				[
					["project", "disabled", false, true],
					["user", "shadowed", true, false],
				],
			);
			strictEqual(byOwner(inventory.resources, "plugin:twin").length, 0, "no fallback while the project copy exists");

			// Explicit inspection still enumerates the disabled copy's members.
			const inspection = inspectHubCopy("plugin:twin", { cwd, scope: "project" });
			strictEqual(inspection.copy.state, "disabled");
			strictEqual(inspectHubCopy("plugin:twin", { cwd, scope: "user" }).copy.effective, false);
			deepStrictEqual(
				inspection.resources.map((item) => [item.kind, item.name, item.valid]),
				[
					["skill", "twin-alpha", true],
					["prompt", "twin:help", true],
					["playbook", "twin-review", true],
				],
			);

			ok(removePlugin("twin", { cwd, scope: "project" }).removed);
			trustProjectPackages(cwd, "plugins");
			inventory = readHubInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state]),
				[["user", "loadable"]],
			);
			ok(byOwner(inventory.resources, "plugin:twin").every((item) => item.owner?.scope === "user"));
			strictEqual(inspectHubCopy("plugin:twin", { cwd, scope: "user" }).copy.loadable, true);
		} finally {
			env.restore();
		}
	});

	it("keeps damaged, invalid, unavailable, colliding and same-owner duplicate resources inspectable with distinct keys", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-damage-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const damagedSource = join(env.dir, "damaged");
			fixture(damagedSource, "damaged");
			const damaged = installPlugin(damagedSource, { cwd, scope: "user" });
			ok(damaged.plugin?.loadable);
			writeFileSync(
				join(damaged.plugin.rootPath, "skills/alpha/SKILL.md"),
				"---\nname: damaged-alpha\ndescription: edited\n---\n",
			);

			const brokenSource = join(env.dir, "broken");
			fixture(brokenSource, "broken", { brokenPrompt: true, duplicateSkill: true });
			ok(installPlugin(brokenSource, { cwd, scope: "user" }).plugin?.loadable);

			const invalidSource = join(env.dir, "invalid");
			fixture(invalidSource, "invalid");
			const invalid = installPlugin(invalidSource, { cwd, scope: "project" });
			ok(invalid.plugin);
			trustProjectPackages(cwd, "plugins");
			rmSync(join(invalid.plugin.rootPath, "plugin.json"));

			skill(cwd, ".pancode/skills/shared", "shared-skill", "project copy");
			skill(env.dir, "config/skills/shared", "shared-skill", "user copy");
			write(cwd, ".pancode/agents/bad-agent.md", "---\nname: Bad\n---\nno schema\n");

			const inventory = readHubInventory({ cwd, home: env.dir });
			const states = new Map(inventory.copies.map((item) => [`${item.ref}@${item.scope}`, item.state]));
			strictEqual(states.get("plugin:damaged@user"), "damaged");
			strictEqual(states.get("plugin:broken@user"), "loadable");
			strictEqual(states.get("plugin:invalid@project"), "invalid");
			strictEqual(byOwner(inventory.resources, "plugin:damaged").length, 0, "drifted copies are not admitted");
			ok(inventory.copies.find((item) => item.name === "damaged")?.diagnostics.some((m) => m.includes("drift")));

			const prompt = inventory.resources.find((item) => item.kind === "prompt" && item.name === "broken:help");
			strictEqual(prompt?.availability, "unavailable");
			ok(prompt?.reason?.includes("component"), prompt?.reason);
			strictEqual(prompt?.invocation, undefined);

			// Same runtime name, same owner, two physical files: both rows, distinct keys.
			const duplicates = inventory.resources.filter((item) => item.kind === "skill" && item.name === "broken-alpha");
			strictEqual(duplicates.length, 2);
			ok(duplicates.every((item) => item.owner?.ref === "plugin:broken"));
			deepStrictEqual(duplicates.map((item) => parseHubResourceKey(item.key)?.relativePath).sort(), [
				"skills/alpha/SKILL.md",
				"skills/beta/SKILL.md",
			]);
			deepStrictEqual(duplicates.map((item) => item.availability).sort(), ["available", "shadowed"]);
			const [, second] = duplicates;
			ok(second);
			const exact = readHubInventory({ cwd, home: env.dir, ref: second.key });
			deepStrictEqual(
				exact.resources.map((item) => item.key),
				[second.key],
			);
			deepStrictEqual(
				exact.packages.map((item) => item.ref),
				["plugin:broken"],
				"an exact owned key answers only with its owner",
			);

			const shared = inventory.resources.filter((item) => item.name === "shared-skill");
			deepStrictEqual(shared.map((item) => [item.source.class, item.availability]).sort(), [
				["project", "available"],
				["user", "shadowed"],
			]);

			const bad = inventory.resources.find((item) => item.kind === "agent" && item.name === "bad-agent");
			strictEqual(bad?.availability, "invalid");
			strictEqual(bad?.source.class, "project");
			ok(bad?.reason);

			const fleets = inventory.resources.filter((item) => item.kind === "playbook" && item.source.class === "core");
			ok(fleets.some((item) => item.availability === "unavailable" && item.reason));
			ok(inventory.resources.every((item) => item.diagnostics.length <= 8));
		} finally {
			env.restore();
		}
	});

	it("classifies origin from evidence only and keeps foreign imports visibly foreign", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-origin-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "vendor");
			fixture(source, "vendored");
			// Author metadata claims nothing; the install record does.
			const imported = installPlugin(source, {
				cwd,
				scope: "user",
				origin: {
					kind: "interop",
					host: "claude-code",
					source: "/home/someone/.claude/plugins/marketplaces/acme/vendored",
					format: "claude-code",
					marketplace: "acme",
				},
			});
			ok(imported.plugin, JSON.stringify(imported.diagnostics));
			strictEqual(imported.plugin.trust, "foreign");
			const inventory = readHubInventory({ cwd, home: env.dir, ref: "plugin:vendored" });
			const copy = inventory.copies[0];
			deepStrictEqual(copy?.origin, {
				kind: "imported",
				agent: "claude-code",
				path: "/home/someone/.claude/plugins/marketplaces/acme/vendored",
				marketplace: "acme",
			});
			strictEqual(copy?.format, "claude-code");
			strictEqual(copy?.trust, "foreign");
			strictEqual(copy?.state, "loadable");
			const members = byOwner(inventory.resources, "plugin:vendored");
			ok(members.length > 0);
			for (const item of members) {
				strictEqual(item.origin.kind, "imported");
				strictEqual(item.format, "claude-code");
			}
			// Loadable copy, but a foreign skill is not admitted to the model without the opt-in.
			strictEqual(members.find((item) => item.kind === "skill")?.availability, "untrusted");

			deepStrictEqual(
				classifyHubOrigin({
					kind: "install-record",
					rootPath: cwd,
					record: {
						installedAt: "",
						source: "https://github.com/example/pkg/tree/v1/pkg",
						contentDigest: "0".repeat(64),
						publisher: "example",
						origin: {
							kind: "import",
							transport: "github",
							source: "https://github.com/example/pkg/tree/v1/pkg",
							format: "codex",
						},
					},
				}),
				{ origin: { kind: "remote", url: "https://github.com/example/pkg/tree/v1/pkg" }, format: "codex" },
			);
			deepStrictEqual(
				classifyHubOrigin({ kind: "install-record", rootPath: cwd, record: undefined }).origin.kind,
				"unknown",
			);
			strictEqual(
				classifyHubOrigin({ kind: "resource-root", sourceId: "plugin:project:uncorrelated", path: cwd }).origin.kind,
				"unknown",
				"a resource without its copy record must not invent local package provenance",
			);
			deepStrictEqual(
				classifyHubOrigin({
					kind: "catalog-row",
					entry: {
						kind: "plugin",
						name: "x",
						description: "",
						sourceUrl: join(env.dir, "somewhere"),
						origin: "catalog",
						index: join(env.dir, "config", "hub.yaml"),
					},
				}).origin,
				{ kind: "local", path: join(env.dir, "somewhere"), catalog: join(env.dir, "config", "hub.yaml") },
			);
		} finally {
			env.restore();
		}
	});

	it("accepts indexes without hints, drops malformed hints without dropping the row, and never writes index evidence back", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-index-");
		try {
			const file = join(env.dir, "index.yaml");
			const base = {
				kind: "plugin",
				description: "row",
				sourceUrl: "https://github.com/example/repo/tree/v1/pkg",
				version: "1.0.0",
				sha256: "b".repeat(64),
			};
			writeFileSync(
				file,
				stringify({
					entries: [
						{ ...base, name: "plain" },
						{ ...base, name: "hinted", provides: [{ kind: "agent", name: "helper", description: "Helps" }] },
						{ ...base, name: "malformed", provides: [{ kind: "plugin", name: "nested" }] },
						{
							...base,
							name: "oversized",
							provides: Array.from({ length: 300 }, (_, i) => ({ kind: "skill", name: `s${i}` })),
						},
					],
				}),
			);
			const diagnostics: string[] = [];
			const rows = readPluginCatalog(file, diagnostics);
			deepStrictEqual(
				rows.map((row) => [row.name, row.provides?.length ?? null, row.index]),
				[
					["plain", null, file],
					["hinted", 1, file],
					["malformed", null, file],
					["oversized", null, file],
				],
			);
			strictEqual(diagnostics.length, 2);
			ok(diagnostics.every((message) => message.includes("provides ignored")));
		} finally {
			env.restore();
		}
	});

	it("keeps the GUI skills inventory wire contract fixed and exposes the recipes read through the CLI", async () => {
		const env = await isolatePancodeEnv("pancode-inventory-cli-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			ok(installPlugin(kitSource, { cwd, scope: "project", origin: { kind: "catalog", source: kitSource } }).plugin);
			trustProjectPackages(cwd, "plugins");
			skill(cwd, ".pancode/skills/local", "local-skill");

			const gui = cli(env, cwd, ["inventory", "--json"]);
			strictEqual(gui.code, 0, gui.stderr);
			const snapshot = gui.json as Record<string, unknown>;
			deepStrictEqual(Object.keys(snapshot).sort(), [
				"diagnostics",
				"generatedAt",
				"invalidReason",
				"modelVisible",
				"skills",
				"skillsTruncated",
				"total",
				"valid",
				"version",
			]);
			strictEqual(snapshot.version, 1);
			const guiSkill = (snapshot.skills as Array<Record<string, unknown>>).find((item) => item.name === "local-skill");
			ok(guiSkill);
			deepStrictEqual(Object.keys(guiSkill).sort(), [
				"allowedTools",
				"audit",
				"description",
				"diagnostics",
				"disallowedTools",
				"installedAt",
				"installedByWorker",
				"modelInvocable",
				"modelVisible",
				"name",
				"precedence",
				"scope",
				"source",
				"trusted",
				"updatable",
				"updatedAt",
			]);

			const recipes = cli(env, cwd, ["components", "--kind", "agent", "--json"]);
			strictEqual(recipes.code, 0, recipes.stderr);
			const read = recipes.json as {
				version: number;
				resources: HubComponent[];
				packages?: unknown;
				truncated: unknown;
			};
			strictEqual(read.version, 1);
			strictEqual(read.packages, undefined);
			ok(read.resources.every((item) => item.kind === "agent"));
			strictEqual(byOwner(read.resources, "plugin:sample-kit").length, 3);
			ok(read.resources.some((item) => item.name === "coder" && item.origin.kind === "core"));
			ok(!read.resources.some((item) => item.audience === "shadow" || item.audience === "internal"));
			ok(
				!JSON.stringify(read).includes("three reviewer agents bound to it"),
				"no package descriptions leak into recipe rows",
			);

			const search = cli(env, cwd, ["search", "hpc-darshan", "--kind", "skill", "--json"]);
			strictEqual(search.code, 0, search.stderr);
			const found = (search.json as { entries: Array<Record<string, unknown>> }).entries;
			deepStrictEqual(
				found.map((item) => [item.kind, item.name, (item.provenance as { kind: string }).kind]),
				[["plugin", "hpc", "bundled"]],
			);
			ok(Array.isArray(found[0]?.provides));
			ok(Array.isArray(found[0]?.installed));

			const inspect = cli(env, cwd, ["inspect", "plugin:sample-kit", "--json"]);
			strictEqual(inspect.code, 0, inspect.stderr);
			const detail = inspect.json as { id: string; scope: string; hub: ReturnType<typeof inspectHubCopy> };
			strictEqual(detail.id, "sample-kit");
			strictEqual(detail.scope, "project");
			strictEqual(detail.hub.copy.origin.kind, "local");
			strictEqual(detail.hub.resources.length, 6);
			strictEqual(detail.hub.resources.find((item) => item.name === "sample-kit:review")?.componentId, "review");

			const bad = cli(env, cwd, ["components", "--kind", "plugin", "--json"]);
			strictEqual(bad.code, 1);
		} finally {
			env.restore();
		}
	});
});
