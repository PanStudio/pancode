// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";

import { resetXdgCache } from "../../src/core/xdg.js";
import {
	type PluginCatalogEntry,
	parsePluginGithubSource,
	readPluginCatalog,
} from "../../src/domains/plugins/catalog.js";
import {
	installHubPackage,
	listInstalledPlugins,
	pluginContentDigest,
	removePlugin,
} from "../../src/domains/plugins/index.js";
import {
	classifyHubRequirements,
	discoverHub,
	type HubEntry,
	hubEntryDrift,
	hubEntryInstalled,
	hubEntryPin,
	hubInstallPath,
	hubWorkspace,
	installHubPlan,
	pinHubEntry,
	planHubInstall,
	planHubUpdate,
	registerHubPackage,
	releaseHubPlan,
	resolveHubPackage,
	resolveHubRequirements,
} from "../../src/domains/resources/hub.js";
import { applyHubLifecycle, planHubLifecycle, releaseHubLifecycle } from "../../src/domains/resources/hub-actions.js";
import { discoverMarketplaceSkills } from "../../src/domains/resources/skills/marketplace.js";
import { HUB_TABS } from "../../src/interactive/overlays/hub-tabs.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { trustProjectPackages } from "../harness/project-trust.js";

let root: string;
let previousConfig: string | undefined;
let previousCwd: string;
function bundle(name = "fixture", version = "1.0.0"): string {
	const location = path.join(root, "sources", name);
	mkdirSync(path.join(location, "assets"), { recursive: true });
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version,
			description: "PanHub integrity fixture",
		}),
	);
	writeFileSync(path.join(location, "assets", "evidence.txt"), `evidence ${version}`);
	return location;
}
function entry(source: string, overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
	const manifest = JSON.parse(readFileSync(path.join(source, "plugin.json"), "utf8"));
	return {
		kind: "plugin",
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		sourceUrl: source,
		sha256: pluginContentDigest(source),
		origin: "catalog",
		...overrides,
	};
}
function catalog(items: HubEntry[]): string {
	const file = path.join(root, "config", "hub.yaml");
	writeFileSync(file, stringify({ entries: items }));
	return file;
}
async function captureCli(args: string[]): Promise<{ code: number; output: string }> {
	const result = spawnSync(
		process.execPath,
		[new URL("../../dist/cli/index.js", import.meta.url).pathname, "hub", ...args, "--json"],
		{ cwd: root, env: process.env, encoding: "utf8" },
	);
	return { code: result.status ?? 1, output: result.stdout || result.stderr };
}

describe("plugin PanHub lifecycle", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "pancode-plugin-hub-"));
		previousConfig = process.env.PANCODE_CONFIG_DIR;
		previousCwd = process.cwd();
		process.env.PANCODE_CONFIG_DIR = path.join(root, "config");
		mkdirSync(path.join(root, "config"));
		process.chdir(root);
		resetXdgCache();
	});
	afterEach(() => {
		process.chdir(previousCwd);
		if (previousConfig === undefined) delete process.env.PANCODE_CONFIG_DIR;
		else process.env.PANCODE_CONFIG_DIR = previousConfig;
		resetXdgCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies assets as well as the manifest and refuses post-plan source changes", () => {
		const source = bundle();
		const plan = planHubInstall(entry(source));
		writeFileSync(path.join(source, "assets", "evidence.txt"), "changed after review");
		throws(() => installHubPlan(plan), /digest|pin|changed/i);
		equal(existsSync(plan.path), false);
		equal(hubEntryInstalled(plan.entry), false);
	});

	it("force cannot bypass a catalog pin and a catalog cannot substitute bundle identity", () => {
		const source = bundle();
		throws(() => planHubInstall(entry(source, { sha256: "0".repeat(64) }), { force: true }), /plugin_pin_mismatch/);
		throws(() => planHubInstall(entry(source, { name: "another" })), /identity mismatch/);
		throws(() => planHubInstall(entry(source, { version: "2.0.0" })), /version mismatch/);
	});

	it("uses local directories before identically named catalog IDs", () => {
		const source = bundle();
		catalog([entry(source, { description: "catalog row" })]);
		mkdirSync(path.join(root, "fixture"));
		writeFileSync(
			path.join(root, "fixture", "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "local-choice",
				version: "1.0.0",
			}),
		);
		equal(resolveHubPackage("fixture").name, "local-choice");
		equal(resolveHubPackage("plugin:fixture").name, "fixture");
	});

	it("keeps plugin entries out of the skill marketplace", () => {
		const source = bundle();
		const index = path.join(root, "skills.json");
		writeFileSync(index, JSON.stringify({ skills: [entry(source)] }));
		const result = discoverMarketplaceSkills({ catalogDir: null, indexPath: index });
		equal(result.skills.length, 0);
		ok(result.diagnostics.some((diagnostic) => diagnostic.includes("unsupported kind")));
		catalog([entry(source)]);
		ok(discoverHub().entries.some((item) => item.kind === "plugin" && item.name === "fixture"));
	});

	it("does not mistake a stale pin for an installed resource", () => {
		writeFileSync(
			path.join(root, "config", "library-pins.yaml"),
			stringify({ "prompt:gone": { sha256: "0".repeat(64), sourceUrl: "/missing" } }),
		);
		equal(hubEntryInstalled({ kind: "prompt", name: "gone" }), false);
		throws(() => hubInstallPath({ kind: "prompt", name: "../outside" }), /invalid PanHub entry name/);
	});

	it("records scoped pins, reports drift, refuses repinning drift, and removes the selected scope", () => {
		const source = bundle();
		const item = entry(source);
		installHubPlan(planHubInstall(item));
		installHubPlan(planHubInstall(item, { scope: "project" }));
		const userPin = hubEntryPin(item, { scope: "user" });
		ok(userPin);
		equal(hubEntryDrift(item, { scope: "project" }).status, "clean");
		const projectPath = hubInstallPath(item, { scope: "project" });
		writeFileSync(path.join(projectPath, "assets", "evidence.txt"), "local changes");
		equal(hubEntryDrift(item, { scope: "project" }).status, "changed");
		equal(hubEntryDrift(item, { scope: "user" }).status, "clean");
		throws(() => pinHubEntry(item, { scope: "project" }), /plugin_local_changes/);
		removePlugin(item.name, { scope: "project" });
		equal(existsSync(projectPath), false);
		equal(hubEntryInstalled(item, { scope: "project" }), false);
		equal(hubEntryInstalled(item, { scope: "user" }), true);
		deepStrictEqual(hubEntryPin(item, { scope: "user" }), userPin);
	});

	it("updates a local origin to a new version and refuses destination changes after review", () => {
		const source = bundle();
		installHubPlan(planHubInstall(resolveHubPackage(source)));
		bundle("fixture", "2.0.0");
		const plan = planHubUpdate("fixture");
		installHubPlan(plan);
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
		bundle("fixture", "3.0.0");
		const changed = planHubUpdate("fixture");
		writeFileSync(path.join(changed.path, "assets", "evidence.txt"), "edit during review");
		throws(() => installHubPlan(changed), /plugin_destination_changed/);
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
	});

	it("updates from the latest catalog pin and refuses a changed upstream even with force", () => {
		const source = bundle();
		catalog([entry(source)]);
		installHubPlan(planHubInstall(resolveHubPackage("fixture")));
		bundle("fixture", "2.0.0");
		catalog([entry(source)]);
		installHubPlan(planHubUpdate("fixture"));
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
		writeFileSync(path.join(source, "assets", "evidence.txt"), "unpinned upstream");
		throws(() => planHubUpdate("fixture", { force: true }), /plugin_pin_mismatch/);
	});

	it("CLI and the reviewed lifecycle share install, disable, cancellation and removal behavior", async () => {
		const source = bundle();
		const installed = await captureCli(["install", source]);
		equal(installed.code, 0, installed.output);
		const item = entry(source);

		const disable = planHubLifecycle({ operation: "disable", ref: "plugin:fixture", scope: "user", cwd: root });
		equal(disable.applicable, true, JSON.stringify(disable.diagnostics));
		equal(applyHubLifecycle(disable).committed, 1);
		equal(listInstalledPlugins(root)[0]?.enabled, false);
		equal((await captureCli(["enable", "fixture"])).code, 0);

		// Cancel is the whole contract of the review gate: a released plan leaves
		// the installation exactly as it found it.
		const cancelled = planHubLifecycle({ operation: "remove", ref: "plugin:fixture", scope: "user", cwd: root });
		releaseHubLifecycle(cancelled);
		equal(hubEntryInstalled(item), true);

		const remove = planHubLifecycle({ operation: "remove", ref: "plugin:fixture", scope: "user", cwd: root });
		equal(remove.steps[0]?.identity.scope, "user");
		equal(remove.steps[0]?.destination, hubInstallPath(item));
		const result = applyHubLifecycle(remove);
		equal(result.committed, 1, JSON.stringify(result.outcomes));
		equal(result.outcomes[0]?.verification?.tree, "absent");
		equal(result.refresh.status, "not-applicable");
		equal(hubEntryInstalled(item), false);
		ok(HUB_TABS.some((tab) => tab.id === "plugin"));
	});

	it("only advertises supported, pinned remote sources and rejects traversal", () => {
		const file = path.join(root, "registry.yaml");
		const item = entry(bundle(), { sourceUrl: "https://github.com/example/repo/tree/v1/plugins/fixture" });
		writeFileSync(
			file,
			stringify({
				entries: [
					item,
					{ ...item, name: "unsupported", sourceUrl: "https://other.example/plugin.zip" },
					{ ...item, name: "unpinned", sha256: undefined },
				],
			}),
		);
		const diagnostics: string[] = [];
		const found = readPluginCatalog(file, diagnostics);
		equal(found.length, 1);
		equal(diagnostics.length, 2);
		ok(parsePluginGithubSource(item.sourceUrl));
		equal(parsePluginGithubSource("https://github.com/example/repo/tree/main/../../outside"), undefined);
		throws(() => resolveHubPackage(item.sourceUrl), /requires a catalog entry/);
	});

	it("previews with dry-run and commits an explicit install", async () => {
		const item = entry(bundle());
		catalog([item]);
		const preview = await captureCli(["install", "plugin:fixture", "--dry-run"]);
		equal(preview.code, 0, preview.output);
		equal(JSON.parse(preview.output).confirmed, false);
		equal(hubEntryInstalled(item), false);
		const applied = await captureCli(["install", "plugin:fixture"]);
		equal(applied.code, 0, applied.output);
		equal(hubEntryInstalled(item), true);
	});

	it("fetches a tree-URL source at its resolved commit using argument vectors and cleans the stage", () => {
		const source = bundle();
		const tools = path.join(root, "bin");
		mkdirSync(tools);
		const argsFile = path.join(root, "git-args.jsonl");
		const commit = "c".repeat(40);
		// A stand-in git: ls-remote names the tag's commit, checkout copies the fixture, rev-parse reports the commit.
		writeFileSync(
			path.join(tools, "git"),
			`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(argsFile)},JSON.stringify(args)+"\\n");const at=args[0]==='-C'?args[1]:undefined;if(args.includes('ls-remote'))process.stdout.write('${commit}\\trefs/tags/v1^{}\\n');else if(args.includes('checkout'))fs.cpSync(${JSON.stringify(source)},p.join(at,'plugins','fixture'),{recursive:true});else if(args.includes('rev-parse'))process.stdout.write('${commit}\\n');\n`,
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
		try {
			const plan = planHubInstall(entry(source, { sourceUrl: "https://github.com/example/repo/tree/v1/plugins/fixture" }));
			ok(plan.sourceRoot);
			equal(plan.commit, commit);
			const staged = plan.sourceRoot;
			const calls = readFileSync(argsFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			const stage = calls[1]?.[2] ?? "";
			deepStrictEqual(calls, [
				["ls-remote", "--exit-code", "--", "https://github.com/example/repo.git", "v1"],
				["init", "-q", stage],
				[
					"-C",
					stage,
					"-c",
					"core.hooksPath=/dev/null",
					"fetch",
					"--depth",
					"1",
					"--no-tags",
					"--",
					"https://github.com/example/repo.git",
					commit,
				],
				[
					"-C",
					stage,
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"advice.detachedHead=false",
					"checkout",
					"--detach",
					"FETCH_HEAD",
				],
				["-C", stage, "rev-parse", "HEAD"],
			]);
			installHubPlan(plan);
			equal(existsSync(staged), false);
			equal(hubEntryPin(plan.entry)?.sourceUrl, "https://github.com/example/repo/tree/v1/plugins/fixture");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("reports the recovery path when an explicit forced update preserves edited content", async () => {
		const source = bundle();
		equal((await captureCli(["install", source])).code, 0);
		const installed = hubInstallPath(entry(source));
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "preserve this edit");
		bundle("fixture", "2.0.0");
		equal((await captureCli(["update", "fixture"])).code, 1);
		const result = await captureCli(["update", "fixture", "--force"]);
		equal(result.code, 0, result.output);
		const backup = JSON.parse(result.output).recovery?.packageBackup as string;
		ok(backup);
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "preserve this edit");
	});

	it("routes the plugin tab through PanHub slash surface", () => {
		deepStrictEqual(parseSlashCommand("/hub"), { kind: "resources", tab: "plugin" });
		deepStrictEqual(parseSlashCommand("/hub plugin"), { kind: "resources", tab: "plugin" });
		equal(parseSlashCommand("/hub plugin unsupported").kind, "usage-error");
	});

	it("completes plugin browsing and reload through the ordinary slash grammar", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		for (const [line, expected] of [
			["/hu", "hub"],
			["/hub pl", "plugins"],
			["/reload hu", "hub"],
		]) {
			ok(line);
			ok(expected);
			const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
			ok(
				suggestions?.items.some((item) => item.value === expected),
				`${line} should complete ${expected}`,
			);
		}
	});

	it("preserves a local fork's source and disabled state across updates", async () => {
		const local = bundle();
		equal((await captureCli(["install", local])).code, 0);
		equal((await captureCli(["disable", "fixture"])).code, 0);
		const upstream = bundle("upstream", "3.0.0");
		writeFileSync(
			path.join(upstream, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "fixture",
				version: "3.0.0",
			}),
		);
		catalog([entry(upstream)]);
		bundle("fixture", "2.0.0");
		const plan = planHubUpdate("fixture");
		equal(plan.entry.sourceUrl, local);
		installHubPlan(plan);
		const installed = listInstalledPlugins(root)[0];
		equal(installed?.version, "2.0.0");
		equal(installed?.enabled, false);
	});

	it("retains dedicated plugin catalog requirements and checks their dependency graph", () => {
		const item = entry(bundle(), { requires: ["plugin:missing"] });
		const file = path.join(root, "plugins.yaml");
		writeFileSync(file, stringify({ entries: [item] }));
		const diagnostics: string[] = [];
		const rows = readPluginCatalog(file, diagnostics);
		deepStrictEqual(rows[0]?.requires, ["plugin:missing"]);
		equal(diagnostics.length, 0);
		const loaded = rows[0];
		ok(loaded);
		throws(() => resolveHubRequirements(loaded, rows), /hub_requirement_missing/);
		const cyclic = { ...loaded, requires: ["plugin:fixture" as const] };
		throws(() => resolveHubRequirements(cyclic, [cyclic]), /hub_requirement_cycle/);
	});

	it("refuses unavailable plugin requirements without reactivating installed dependencies", async () => {
		const dependency = entry(bundle());
		const consumer = entry(bundle("consumer"), { requires: ["plugin:fixture"] });
		catalog([dependency, consumer]);
		equal((await captureCli(["install", "fixture"])).code, 0);
		equal((await captureCli(["disable", "fixture"])).code, 0);
		const status = classifyHubRequirements(consumer, [dependency, consumer]);
		deepStrictEqual(status.satisfied, []);
		deepStrictEqual(
			status.inactive?.map((item) => item.name),
			["fixture"],
		);
		const add = await captureCli(["install", "plugin:consumer", "--with-requirements"]);
		equal(add.code, 1);
		match(add.output, /hub_requirement_inactive/);
		equal((await captureCli(["install", "consumer"])).code, 1);
		equal(listInstalledPlugins(root)[0]?.enabled, false);
		equal(hubEntryInstalled(consumer), false);
	});

	it("removes a plugin independently of legacy pins and reports retained edited files", async () => {
		const item = entry(bundle());
		installHubPlan(planHubInstall(item));
		const installed = hubInstallPath(item);
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "edited content");
		const legacyPins = path.join(root, "config", "library-pins.yaml");
		writeFileSync(legacyPins, "[malformed yaml");
		const removed = await captureCli(["remove", "fixture"]);
		equal(removed.code, 0, removed.output);
		const backup = JSON.parse(removed.output).recovery?.packageBackup as string;
		ok(backup);
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "edited content");
		equal(readFileSync(legacyPins, "utf8"), "[malformed yaml");
		equal(hubEntryInstalled(item), false);
	});

	it("registers scoped pins and preserves all copies after index removal", async () => {
		const source = bundle();
		const registered = registerHubPackage(source, { scope: "project" });
		equal(registered.sha256, pluginContentDigest(source));
		throws(() => registerHubPackage(source, { scope: "project" }), /already registered/);
		equal((await captureCli(["install", "plugin:fixture", "--project"])).code, 0);
		equal((await captureCli(["install", source, "--user"])).code, 0);
		rmSync(path.join(root, ".pancode/hub.yaml"));
		equal(hubWorkspace().entries.find((e) => e.name === "fixture")?.installed.length, 2);
		equal((await captureCli(["disable", "plugin:fixture", "--project"])).code, 0);
		equal((await captureCli(["enable", "plugin:fixture", "--project"])).code, 0);
		equal((await captureCli(["remove", "plugin:fixture", "--project"])).code, 0);
		equal(hubWorkspace().entries.find((e) => e.name === "fixture")?.installed.length, 1);
	});
	it("refuses hub update and forced install of an adopted host tree without re-adoption", async () => {
		const source = bundle();
		const result = installHubPackage({
			kind: "plugin",
			sourcePath: source,
			scope: "user",
			origin: { kind: "interop", host: "claude-code", source },
			trust: "foreign",
		});
		ok(result.plugin?.valid);
		writeFileSync(path.join(source, "executable.sh"), "host executable");
		throws(() => planHubUpdate("plugin:fixture", { force: true }), /reviewed adoption/);
		const forced = await captureCli(["install", source, "--force"]);
		equal(forced.code, 1);
		match(forced.output, /reviewed adoption/);
		equal(existsSync(path.join(result.plugin.rootPath, "executable.sh")), false);
		equal(listInstalledPlugins()[0]?.trust, "foreign");
	});

	it("releases cancelled staging plans without modifying installation state", () => {
		const item = entry(bundle());
		const plan = planHubInstall(item);
		let released = false;
		plan.cleanup = () => {
			released = true;
		};
		releaseHubPlan(plan);
		equal(released, true);
		equal(hubEntryInstalled(item), false);
	});

	it("rejects retired index schemas without overwriting their contents", () => {
		const source = bundle();
		const file = path.join(root, "config", "hub.yaml");
		const before = stringify({ plugins: [entry(source)] });
		writeFileSync(file, before);
		const diagnostics: string[] = [];
		deepStrictEqual(readPluginCatalog(file, diagnostics), []);
		match(diagnostics.join("; "), /entries list/);
		throws(() => registerHubPackage(source, { force: true }), /entries list/);
		equal(readFileSync(file, "utf8"), before);
	});

	it("plans a dry-run disable without changing installed state and rejects dry-run elsewhere", async () => {
		installHubPlan(planHubInstall(entry(bundle())));
		const result = await captureCli(["disable", "fixture", "--dry-run"]);
		equal(result.code, 0, result.output);
		equal(JSON.parse(result.output).apply.unattempted, 1);
		equal(listInstalledPlugins(root)[0]?.enabled, true);
		const pinned = await captureCli(["pin", "fixture", "--dry-run"]);
		equal(pinned.code, 1);
		match(pinned.output, /supported only/);
	});

	it("keeps kind-qualified lifecycle actions on the matching scope when another kind shadows its name", async () => {
		const pluginSource = bundle();
		installHubPlan(planHubInstall(entry(pluginSource), { scope: "project" }));
		trustProjectPackages(root, "plugins");
		const skillSource = bundle("skill-source");
		const manifestFile = path.join(skillSource, "plugin.json");
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		manifest.name = "fixture";
		manifest.extensions = {
			"dev.pancode": {
				manifestVersion: 1,
				kind: "skill",
				resources: { skills: "." },
				components: [{ kind: "skill", id: "fixture", path: "SKILL.md" }],
			},
		};
		writeFileSync(manifestFile, JSON.stringify(manifest));
		writeFileSync(
			path.join(skillSource, "SKILL.md"),
			"---\nname: fixture\ndescription: Scope selection fixture\n---\nReview content.\n",
		);
		const skillEntry = entry(skillSource, { kind: "skill", origin: "installed" });
		installHubPlan(planHubInstall(skillEntry, { scope: "user" }));
		const consumer = entry(bundle("consumer"), { requires: ["skill:fixture"] });
		const required = classifyHubRequirements(consumer, [skillEntry, consumer]);
		deepStrictEqual(required.satisfied, []);
		deepStrictEqual(
			required.inactive?.map((item) => `${item.kind}:${item.name}`),
			["skill:fixture"],
		);
		const copy = (scope: "user" | "project") => listInstalledPlugins(root, { all: true, scope })[0];
		const projectBefore = copy("project");
		ok(projectBefore);
		const projectDigest = pluginContentDigest(projectBefore.rootPath);
		equal((await captureCli(["disable", "skill:fixture"])).code, 0);
		equal(copy("user")?.enabled, false);
		equal(copy("project")?.enabled, true);
		equal((await captureCli(["enable", "skill:fixture"])).code, 0);
		equal(copy("user")?.enabled, true);
		const pinned = await captureCli(["pin", "skill:fixture"]);
		equal(pinned.code, 0, pinned.output);
		equal(JSON.parse(pinned.output).sha256, pluginContentDigest(skillSource));
		const userCopy = copy("user");
		ok(userCopy);
		writeFileSync(path.join(userCopy.rootPath, "assets/evidence.txt"), "user drift");
		equal((await captureCli(["drift", "skill:fixture"])).code, 1);
		equal((await captureCli(["drift", "plugin:fixture"])).code, 0);
		manifest.version = "1.1.0";
		writeFileSync(manifestFile, JSON.stringify(manifest));
		const updated = await captureCli(["update", "skill:fixture", "--force"]);
		equal(updated.code, 0, updated.output);
		equal(copy("user")?.version, "1.1.0");
		equal(copy("project")?.version, "1.0.0");
		equal((await captureCli(["remove", "skill:fixture", "--project"])).code, 1);
		ok(copy("user"));
		equal((await captureCli(["remove", "skill:fixture"])).code, 0);
		equal(copy("user"), undefined);
		equal(pluginContentDigest(projectBefore.rootPath), projectDigest);
		equal(copy("project")?.enabled, true);
		installHubPlan(planHubInstall(entry(skillSource, { kind: "skill" }), { scope: "user" }));
		removePlugin(skillEntry.name, { scope: "user" });
		equal(copy("user"), undefined);
		equal(pluginContentDigest(projectBefore.rootPath), projectDigest);
	});

	it("keeps damaged installed copies and diagnostics visible when state cannot be parsed", async () => {
		const item = entry(bundle());
		installHubPlan(planHubInstall(item));
		const state = path.join(root, "config", "plugins", "state.json");
		writeFileSync(state, "{broken");
		const workspace = hubWorkspace();
		const installed = workspace.entries.find((e) => e.name === item.name)?.installed[0];
		ok(installed);
		equal(installed.valid, false);
		ok(installed.diagnostics.length > 0);
		ok(workspace.diagnostics.some((message) => message.includes("pack state unavailable")));
		equal(hubEntryPin(item), undefined);
		const listed = await captureCli(["list"]);
		equal(listed.code, 0, listed.output);
		ok(JSON.parse(listed.output).entries.find((e: HubEntry) => e.name === item.name));
		equal(readFileSync(state, "utf8"), "{broken");
	});

	it("updates catalog-origin packages when catalog repoints to relocated source, while refusing to redirect dead explicit sources", () => {
		// 1. Catalog-origin migration: install old indexed source, remove old source
		const oldSource = bundle("migrated-pkg", "1.0.0");
		catalog([entry(oldSource)]);
		const initialPlan = planHubInstall(resolveHubPackage("migrated-pkg"));
		installHubPlan(initialPlan);
		equal(listInstalledPlugins(root)[0]?.version, "1.0.0");

		rmSync(oldSource, { recursive: true, force: true });
		equal(existsSync(oldSource), false);

		// With old source removed from disk and default catalog still pointing to it, update fails
		throws(
			() => planHubUpdate("migrated-pkg"),
			/unsupported plugin source|is not a PanHub pack or a local pack directory|unavailable/i,
		);

		// 2. Configured catalog override repoints package to relocated canonical source
		const newSource = path.join(root, "hub", "packs", "plugins", "migrated-pkg");
		mkdirSync(path.join(newSource, "assets"), { recursive: true });
		writeFileSync(
			path.join(newSource, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "migrated-pkg",
				version: "2.0.0",
				description: "Relocated catalog package",
			}),
		);
		writeFileSync(path.join(newSource, "assets", "evidence.txt"), "relocated evidence 2.0.0");

		const overrideCatalog = path.join(root, "override-catalog.yaml");
		writeFileSync(overrideCatalog, stringify({ entries: [entry(newSource)] }));

		// Configured catalog override takes precedence over default catalog
		const resolved = resolveHubPackage("migrated-pkg", { catalog: overrideCatalog });
		equal(resolved.version, "2.0.0");
		equal(resolved.sourceUrl, newSource);

		const updatePlan = planHubUpdate("migrated-pkg", { catalog: overrideCatalog });
		installHubPlan(updatePlan);
		equal(listInstalledPlugins(root).find((p) => p.name === "migrated-pkg")?.version, "2.0.0");

		// 3. Explicit direct-source case: refuses dead direct source instead of redirecting to catalog
		const directSource = bundle("direct-pkg", "1.0.0");
		installHubPlan(planHubInstall(resolveHubPackage(directSource)));
		equal(listInstalledPlugins(root).find((p) => p.name === "direct-pkg")?.version, "1.0.0");

		rmSync(directSource, { recursive: true, force: true });
		equal(existsSync(directSource), false);

		const catalogSubstitute = path.join(root, "hub", "packs", "plugins", "direct-pkg");
		mkdirSync(path.join(catalogSubstitute, "assets"), { recursive: true });
		writeFileSync(
			path.join(catalogSubstitute, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "direct-pkg",
				version: "2.0.0",
				description: "Unwanted redirect attempt",
			}),
		);
		writeFileSync(path.join(catalogSubstitute, "assets", "evidence.txt"), "substitute");
		catalog([entry(newSource), entry(catalogSubstitute)]);

		throws(
			() => planHubUpdate("direct-pkg"),
			/is not a PanHub pack or a local pack directory|unavailable|no update source/i,
		);
	});
});
