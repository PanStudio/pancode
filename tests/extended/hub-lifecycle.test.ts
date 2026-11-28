// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { installRecordFindings } from "../../src/cli/doctor-install-records.js";
import { readLifecycleReceipts } from "../../src/core/hub-receipts.js";
import { INTERNAL_GIT_BASE_OPTIONS } from "../../src/core/internal-git.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { extensionBaseDir, listInstalledExtensions } from "../../src/domains/extensions/index.js";
import { applyHubImport, planHubImport } from "../../src/domains/interop/import.js";
import {
	disablePlugin,
	listInstalledPlugins,
	pluginBaseDir,
	pluginContentDigest,
	pluginStatePath,
	readPluginInstallRecord,
	removePlugin,
	withPluginScopeLock,
} from "../../src/domains/plugins/index.js";
import type { PluginScope } from "../../src/domains/plugins/types.js";
import {
	applyHubLifecycle,
	type HubRefreshHost,
	hubImportOutcome,
	planHubLifecycle,
	releaseHubLifecycle,
	retryHubRefresh,
} from "../../src/domains/resources/hub-actions.js";
import { readHubInventory } from "../../src/domains/resources/hub-inventory.js";
import { installSkill } from "../../src/domains/resources/skills/marketplace.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { scratchPancodeEnvVars } from "../harness/scratch-env.js";

let root: string;
let previousEnv: NodeJS.ProcessEnv;
let previousCwd: string;

interface PackageSpec {
	name: string;
	version?: string;
	kind?: "plugin" | "skill";
	requires?: string[];
	skill?: string;
}

function source(spec: PackageSpec): string {
	const location = path.join(root, "sources", `${spec.name}-${spec.version ?? "1.0.0"}`);
	mkdirSync(path.join(location, "assets"), { recursive: true });
	const pancode =
		spec.kind === "skill"
			? {
					manifestVersion: 1,
					kind: "skill",
					...(spec.requires ? { requires: spec.requires } : {}),
					resources: { skills: "." },
					components: [{ kind: "skill", id: spec.skill ?? spec.name, path: "SKILL.md" }],
				}
			: spec.requires
				? { manifestVersion: 1, requires: spec.requires, resources: {}, components: [] }
				: undefined;
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: spec.name,
			version: spec.version ?? "1.0.0",
			description: `Lifecycle fixture ${spec.name}`,
			...(pancode ? { extensions: { "dev.pancode": pancode } } : {}),
		}),
	);
	if (spec.kind === "skill")
		writeFileSync(
			path.join(location, "SKILL.md"),
			`---\nname: ${spec.skill ?? spec.name}\ndescription: Lifecycle skill ${spec.name}\n---\nUse it.\n`,
		);
	writeFileSync(path.join(location, "assets", "evidence.txt"), `evidence ${spec.version ?? "1.0.0"}`);
	return location;
}

function catalog(sources: string[]): void {
	writeFileSync(
		path.join(root, "config", "hub.yaml"),
		stringify({
			entries: sources.map((location) => {
				const manifest = JSON.parse(readFileSync(path.join(location, "plugin.json"), "utf8"));
				const pancode = manifest.extensions?.["dev.pancode"];
				return {
					kind: pancode?.kind ?? "plugin",
					name: manifest.name,
					version: manifest.version,
					description: manifest.description,
					sourceUrl: location,
					sha256: pluginContentDigest(location),
					...(pancode?.requires ? { requires: pancode.requires } : {}),
				};
			}),
		}),
	);
}

function install(ref: string, scope: PluginScope = "user", withRequirements = false) {
	const plan = planHubLifecycle({ operation: "install", ref, scope, cwd: root, withRequirements });
	const result = applyHubLifecycle(plan);
	equal(
		result.failed,
		0,
		JSON.stringify(
			result.outcomes.map((item) => item.error),
			null,
			1,
		),
	);
	return result;
}

/** Both scopes are listed so precedence is the real cross-scope rule, not a single-scope view. */
function copy(scope: PluginScope, id: string) {
	return listInstalledPlugins(root, { all: true }).find((item) => item.id === id && item.scope === scope);
}

function stubHost(): { host: HubRefreshHost; calls: number } {
	const state = {
		calls: 0,
		host: (() => ({ status: "refreshed", generation: 1, changed: true })) as HubRefreshHost,
	};
	state.host = () => {
		state.calls += 1;
		return { status: "refreshed", generation: state.calls, changed: true };
	};
	return state;
}

function cli(args: string[]): { code: number; json: Record<string, unknown> } {
	const result = spawnSync(
		process.execPath,
		[new URL("../../dist/cli/index.js", import.meta.url).pathname, "hub", ...args, "--json"],
		{ cwd: root, env: process.env, encoding: "utf8" },
	);
	const text = result.stdout || result.stderr;
	return { code: result.status ?? 1, json: JSON.parse(text) };
}

describe("The hub lifecycle plans", () => {
	it("lifecycle receipts retain committed identity", () => {
		const name = "telemetry-lifecycle";
		const first = source({ name, version: "1.0.0" });
		catalog([first]);
		const before = readLifecycleReceipts(name).length;
		const dry = planHubLifecycle({ operation: "install", ref: `plugin:${name}`, scope: "user", cwd: root });
		applyHubLifecycle(dry, { dryRun: true });
		equal(readLifecycleReceipts(name).length, before);
		install(`plugin:${name}`);
		const installed = readLifecycleReceipts(name).at(-1);
		ok(installed);
		equal(installed.operation, "install");
		equal(installed.version, "1.0.0");
		equal(installed.contentDigest, pluginContentDigest(first));
		equal(installed.source, first);
		equal(installed.actor, "operator");
		ok(!Number.isNaN(Date.parse(installed.at)));
		const second = source({ name, version: "2.0.0" });
		catalog([second]);
		const update = planHubLifecycle({ operation: "update", ref: `plugin:${name}`, scope: "user", cwd: root });
		applyHubLifecycle(update, { refresh: () => ({ status: "failed", error: "fixture refresh refused" }) });
		equal(readLifecycleReceipts(name).at(-1)?.operation, "update");
		equal(readLifecycleReceipts(name).at(-1)?.version, "2.0.0");
		removePlugin(name, { cwd: root, scope: "user", lifecycle: { actor: "model-confirmed" } });
		const removed = readLifecycleReceipts(name).at(-1);
		equal(removed?.operation, "remove");
		equal(removed?.contentDigest, pluginContentDigest(second));
		equal(removed?.version, "2.0.0");
		equal(removed?.actor, "model-confirmed");
		removePlugin(name, { cwd: root, scope: "user" });
		equal(readLifecycleReceipts(name).at(-1)?.operationId, removed?.operationId);
	});
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "pancode-hub-lifecycle-"));
		previousEnv = { ...process.env };
		previousCwd = process.cwd();
		Object.assign(process.env, scratchPancodeEnvVars(root));
		mkdirSync(path.join(root, "config"));
		process.chdir(root);
		resetXdgCache();
	});
	afterEach(() => {
		process.chdir(previousCwd);
		for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
		Object.assign(process.env, previousEnv);
		resetXdgCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("signals only newer or changed catalog copies and leaves local and imported copies alone", () => {
		const first = source({ name: "signal" });
		catalog([first]);
		install("plugin:signal");
		const update = () => readHubInventory({ cwd: root }).copies.find((p) => p.name === "signal")?.update;
		equal(update(), undefined);
		catalog([source({ name: "signal", version: "2.0.0" })]);
		deepStrictEqual(update(), { version: "2.0.0", reason: "newer-version" });
		writeFileSync(path.join(first, "assets/evidence.txt"), "changed upstream");
		catalog([first]);
		deepStrictEqual(update(), { version: "1.0.0", reason: "changed-content" });
		catalog([source({ name: "signal", version: "0.9.0" })]);
		equal(update(), undefined);
		const local = source({ name: "local-copy" });
		install(local);
		const imported = source({ name: "imported-copy", kind: "skill" });
		ok(applyHubImport(planHubImport(imported, { cwd: root }), true).published);
		catalog([
			source({ name: "local-copy", version: "2.0.0" }),
			source({ name: "imported-copy", kind: "skill", version: "2.0.0" }),
		]);
		const copies = readHubInventory({ cwd: root }).copies;
		equal(copies.find((p) => p.name === "local-copy")?.update, undefined);
		equal(copies.find((p) => p.name === "imported-copy")?.update, undefined);
	});

	it("bulk update skips extensions and continues after a damaged copy refuses", () => {
		catalog([source({ name: "a-refused" }), source({ name: "b-updated" })]);
		install("plugin:a-refused");
		install("plugin:b-updated");
		writeFileSync(path.join(copy("user", "a-refused")?.rootPath ?? "", "assets/evidence.txt"), "local edit");
		const extension = path.join(root, "sources", "extension");
		mkdirSync(extension);
		const manifest = {
			id: "skip-extension",
			name: "skip-extension",
			version: "1.0.0",
			description: "Fixture",
			runtime: { api: 2, entrypoint: "main.mjs", commands: [{ name: "check", description: "Check" }] },
		};
		writeFileSync(path.join(extension, "pancode-extension.json"), JSON.stringify(manifest));
		writeFileSync(
			path.join(extension, "main.mjs"),
			'export default function(api) { api.handle("check", () => ({ text: "ok" })); }',
		);
		const publish = () => {
			catalog([source({ name: "a-refused", version: "2.0.0" }), source({ name: "b-updated", version: "2.0.0" })]);
			const file = path.join(root, "config/hub.yaml");
			const data = parse(readFileSync(file, "utf8"));
			data.entries.push({
				kind: "extension",
				name: manifest.id,
				version: manifest.version,
				description: "Fixture",
				sourceUrl: extension,
				sha256: pluginContentDigest(extension),
			});
			writeFileSync(file, stringify(data));
		};
		publish();
		install("extension:skip-extension");
		manifest.version = "2.0.0";
		writeFileSync(path.join(extension, "pancode-extension.json"), JSON.stringify(manifest));
		publish();
		const result = cli(["update", "--all"]);
		equal(result.code, 1, JSON.stringify(result.json));
		deepStrictEqual(
			(result.json.results as Array<{ ref: string; ok: boolean }>).map((r) => [r.ref, r.ok]),
			[
				["plugin:a-refused", false],
				["plugin:b-updated", true],
			],
		);
		deepStrictEqual(result.json.skipped, [{ ref: "extension:skip-extension", scope: "user", reason: "extension" }]);
		equal(copy("user", "b-updated")?.version, "2.0.0");
		equal(listInstalledExtensions(root, { scope: "user" }).find((p) => p.id === manifest.id)?.version, "1.0.0");
	});

	it("retains only the three newest edited recovery copies", () => {
		const location = source({ name: "recover" });
		catalog([location]);
		install("plugin:recover");
		const backups: string[] = [];
		for (let i = 0; i < 5; i++) {
			writeFileSync(path.join(copy("user", "recover")?.rootPath ?? "", "assets/evidence.txt"), `edit ${i}`);
			const result = applyHubLifecycle(
				planHubLifecycle({ operation: "update", ref: "plugin:recover", scope: "user", cwd: root, force: true }),
			);
			equal(result.failed, 0);
			const backup = result.outcomes[0]?.recovery?.packageBackup;
			ok(backup);
			backups.push(backup);
		}
		deepStrictEqual(
			backups.map((file) => existsSync(file)),
			[false, false, true, true, true],
		);
	});

	it("refuses stale content, state and origin facts inside the writer lock", () => {
		catalog([source({ name: "alpha" })]);
		install("plugin:alpha");
		const stateFile = pluginStatePath("user", root);

		const removal = planHubLifecycle({ operation: "remove", ref: "plugin:alpha", scope: "user", cwd: root });
		writeFileSync(path.join(pluginBaseDir("user", root), "alpha", "assets", "evidence.txt"), "edited after review");
		const staleTree = applyHubLifecycle(removal);
		equal(staleTree.outcomes[0]?.status, "failed");
		equal(staleTree.outcomes[0]?.error?.code, "stale_plan");
		equal(staleTree.outcomes[0]?.error?.changed?.fact, "tree");
		ok(copy("user", "alpha"), "stale plan wrote nothing");

		const toggle = planHubLifecycle({ operation: "disable", ref: "plugin:alpha", scope: "user", cwd: root });
		disablePlugin("alpha", { cwd: root, scope: "user" });
		const staleState = applyHubLifecycle(toggle);
		equal(staleState.outcomes[0]?.error?.code, "stale_plan");
		equal(staleState.outcomes[0]?.error?.changed?.fact, "enabled");

		// Restore the recorded bytes so only provenance differs from the reviewed plan.
		writeFileSync(path.join(pluginBaseDir("user", root), "alpha", "assets", "evidence.txt"), "evidence 1.0.0");
		const enable = planHubLifecycle({ operation: "enable", ref: "plugin:alpha", scope: "user", cwd: root });
		equal(enable.applicable, true, enable.steps[0]?.refusal);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		state.installed.alpha.trust = "foreign";
		state.installed.alpha.origin = {
			kind: "import",
			source: path.join(root, "sources", "alpha-1.0.0"),
			transport: "local",
			format: "portable",
		};
		writeFileSync(stateFile, JSON.stringify(state));
		const staleOrigin = applyHubLifecycle(enable);
		equal(staleOrigin.outcomes[0]?.error?.code, "stale_plan");
		ok(["trust", "origin"].includes(String(staleOrigin.outcomes[0]?.error?.changed?.fact)));
		equal(copy("user", "alpha")?.enabled, false, "identical bytes with changed provenance did not enable");
	});

	it("reads past an install record without a publisher and doctor --fix drops it", () => {
		catalog([
			source({ name: "alpha", kind: "skill" }),
			source({ name: "beta", kind: "skill" }),
			source({ name: "gamma", kind: "skill" }),
		]);
		for (const name of ["alpha", "beta", "gamma"]) install(`skill:${name}`);
		const stateFile = pluginStatePath("user", root);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		delete state.installed.alpha.publisher;
		delete state.installed.beta.publisher;
		writeFileSync(stateFile, JSON.stringify(state));
		writeFileSync(path.join(pluginBaseDir("user", root), "beta", "assets", "evidence.txt"), "edited by the operator");

		equal(copy("user", "gamma")?.loadable, true);
		equal(copy("user", "alpha")?.loadable, false);
		match(
			copy("user", "alpha")
				?.diagnostics.map((item) => item.message)
				.join("\n") ?? "",
			/installed\.alpha is invalid \(publisher must be a lowercase publisher name\).*hub install skill:alpha/,
		);
		disablePlugin("gamma", { cwd: root, scope: "user" });
		ok(JSON.parse(readFileSync(stateFile, "utf8")).installed.alpha, "an unrelated write keeps the invalid record");

		const audit = installRecordFindings({ cwd: root }).filter((row) => row.level === "warn");
		deepStrictEqual(
			audit.map((row) => row.name),
			["plugin install record alpha (user)", "plugin install record beta (user)"],
		);
		match(audit[0]?.detail ?? "", /`pancode doctor --fix` drops it, then `pancode hub install skill:alpha`/);

		const fixed = installRecordFindings({ cwd: root, fix: true }).filter((row) => row.level === "warn");
		match(fixed[0]?.detail ?? "", /dropped installed\.alpha .* and removed its files/);
		match(fixed[1]?.detail ?? "", /dropped installed\.beta .* did not match the record and were moved to/);
		equal(existsSync(path.join(pluginBaseDir("user", root), "alpha")), false);
		ok(readdirSync(pluginBaseDir("user", root)).some((name) => name.startsWith(".beta.removed-")));
		deepStrictEqual(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).installed), ["gamma"]);
		deepStrictEqual(
			installRecordFindings({ cwd: root }).filter((row) => row.level === "warn"),
			[],
		);
		install("skill:alpha");
		equal(copy("user", "alpha")?.loadable, true);
	});

	it("keeps a disabled project copy shadowing the user copy and reveals it on removal", () => {
		catalog([source({ name: "shared", kind: "skill" })]);
		install("skill:shared", "user");
		install("skill:shared", "project");
		trustProjectPackages(root, "plugins");
		const disable = planHubLifecycle({ operation: "disable", ref: "skill:shared", scope: "project", cwd: root });
		equal(disable.steps[0]?.effectiveAfter?.scope, "project");
		equal(disable.steps[0]?.effectiveAfter?.loadable, false);
		match(disable.steps[0]?.fallbackNote ?? "", /still shadows the user copy/);
		const disabled = applyHubLifecycle(disable);
		equal(disabled.committed, 1);
		// The disable rewrote the project state bytes, so the approval is stale until re-approved.
		deepStrictEqual(disabled.outcomes[0]?.verification?.effective, { scope: "user", loadable: true });
		trustProjectPackages(root, "plugins");
		equal(copy("user", "shared")?.loadable, false);

		const remove = planHubLifecycle({ operation: "remove", ref: "skill:shared", scope: "project", cwd: root });
		equal(remove.steps[0]?.effectiveAfter?.scope, "user");
		const removed = applyHubLifecycle(remove);
		equal(removed.outcomes[0]?.status, "committed");
		equal(removed.outcomes[0]?.verification?.tree, "absent");
		equal(removed.outcomes[0]?.verification?.record, "absent");
		deepStrictEqual(removed.outcomes[0]?.verification?.effective, { scope: "user", loadable: true });
		equal(copy("user", "shared")?.loadable, true);
	});

	it("refuses newly broken dependents but not pre-existing breakage, in plans and raw writers", () => {
		catalog([
			source({ name: "dep", kind: "skill" }),
			source({ name: "consumer", requires: ["skill:dep"] }),
			source({ name: "orphan", requires: ["skill:never"] }),
			source({ name: "spare" }),
		]);
		install("skill:dep");
		install("plugin:consumer");
		install("plugin:spare");
		// An orphan with an unmet requirement is pre-existing breakage; install it through the raw writer.
		const orphanPlan = planHubLifecycle({ operation: "install", ref: "plugin:orphan", scope: "user", cwd: root });
		equal(orphanPlan.applicable, false);
		match(orphanPlan.steps[0]?.refusal ?? "", /hub_requirement_missing: skill:never/);
		releaseHubLifecycle(orphanPlan);

		const remove = planHubLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(remove.applicable, false);
		deepStrictEqual(remove.steps[0]?.dependents.newlyBroken, [
			{ ref: "plugin:consumer", scope: "user", missing: ["skill:dep"] },
		]);
		const refused = applyHubLifecycle(remove);
		equal(refused.outcomes[0]?.error?.code, "refused");
		ok(copy("user", "dep"));

		const raw = removePlugin("dep", { cwd: root, scope: "user" });
		equal(raw.diagnostics[0]?.code, "dependents");
		ok(copy("user", "dep"), "raw writer cannot bypass dependency safety");
		equal(disablePlugin("dep", { cwd: root, scope: "user" }).diagnostics[0]?.code, "dependents");

		const spare = planHubLifecycle({ operation: "remove", ref: "plugin:spare", scope: "user", cwd: root });
		equal(spare.applicable, true, "unrelated removal is not blocked by other packages");
		equal(applyHubLifecycle(spare).committed, 1);

		const consumer = planHubLifecycle({ operation: "disable", ref: "plugin:consumer", scope: "user", cwd: root });
		equal(applyHubLifecycle(consumer).committed, 1);
		const afterwards = planHubLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(afterwards.applicable, true, "a disabled dependent is not newly broken");
	});

	it("catches dependents installed after planning at the writer boundary", () => {
		catalog([source({ name: "dep", kind: "skill" }), source({ name: "late", requires: ["skill:dep"] })]);
		install("skill:dep");
		const remove = planHubLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(remove.applicable, true);
		install("plugin:late");
		const result = applyHubLifecycle(remove);
		equal(result.outcomes[0]?.status, "failed");
		equal(result.outcomes[0]?.error?.code, "refused");
		ok(copy("user", "dep"));
	});

	it("retains committed dependency writes, lists unattempted work and refreshes after a partial batch", () => {
		const first = source({ name: "first", kind: "skill" });
		const second = source({ name: "second", kind: "skill" });
		const target = source({ name: "target", requires: ["skill:first", "skill:second"] });
		catalog([first, second, target]);
		const plan = planHubLifecycle({
			operation: "install",
			ref: "plugin:target",
			scope: "user",
			cwd: root,
			withRequirements: true,
		});
		deepStrictEqual(
			plan.steps.map((step) => step.identity.ref),
			["skill:first", "skill:second", "plugin:target"],
		);
		equal(
			plan.steps[2]?.expected.some((fact) => fact.id === "first"),
			false,
			"a batch never stales itself",
		);
		// Change the second dependency's source after review so its writer refuses the pinned digest.
		writeFileSync(path.join(second, "assets", "evidence.txt"), "changed after review");
		const refresh = stubHost();
		const result = applyHubLifecycle(plan, { refresh: refresh.host });
		deepStrictEqual(
			result.outcomes.map((item) => item.status),
			["committed", "failed", "unattempted"],
		);
		equal(result.committed, 1);
		equal(result.unattempted, 1);
		ok(copy("user", "first")?.loadable, "the committed dependency is retained");
		equal(copy("user", "second"), undefined);
		equal(copy("user", "target"), undefined);
		equal(result.refresh.status, "refreshed");
		equal(refresh.calls, 1, "refresh runs once after a partial batch");
		equal(result.outcomes[0]?.verification?.evidence, "post-refresh");
		equal(result.outcomes[0]?.verification?.resources[0]?.available, true);
	});

	it("preserves edited trees as recovery copies on update and removal", () => {
		const v1 = source({ name: "edited" });
		catalog([v1]);
		install("plugin:edited");
		const installed = path.join(pluginBaseDir("user", root), "edited");
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "local work");
		const blocked = planHubLifecycle({ operation: "update", ref: "plugin:edited", scope: "user", cwd: root });
		equal(blocked.applicable, false);
		match(blocked.steps[0]?.refusal ?? "", /plugin_local_changes/);
		releaseHubLifecycle(blocked);

		const v2 = source({ name: "edited", version: "1.1.0" });
		catalog([v2]);
		const update = planHubLifecycle({
			operation: "update",
			ref: "plugin:edited",
			scope: "user",
			cwd: root,
			force: true,
		});
		equal(update.applicable, true);
		const updated = applyHubLifecycle(update);
		equal(updated.outcomes[0]?.status, "committed");
		const backup = updated.outcomes[0]?.recovery?.packageBackup;
		ok(backup && existsSync(backup));
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "local work");
		equal(copy("user", "edited")?.version, "1.1.0");

		writeFileSync(path.join(installed, "assets", "evidence.txt"), "more local work");
		const remove = planHubLifecycle({ operation: "remove", ref: "plugin:edited", scope: "user", cwd: root });
		const removed = applyHubLifecycle(remove);
		equal(removed.outcomes[0]?.status, "committed");
		ok(removed.outcomes[0]?.recovery?.packageBackup && existsSync(removed.outcomes[0].recovery.packageBackup));
	});

	it("releases every staged remote source on cancel, failure and success", () => {
		const bundle = source({ name: "remote" });
		const tools = path.join(root, "bin");
		mkdirSync(tools);
		const clones = path.join(root, "clones.txt");
		writeFileSync(
			path.join(tools, "git"),
			// A stand-in git behind the internal-git hardening: the fetch resolves the tag with ls-remote, then inits the stage (logged), fetches, checks out and reads HEAD.
			`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const a=process.argv.slice(${2 + INTERNAL_GIT_BASE_OPTIONS.length});const c='1'.repeat(40);if(a.includes('ls-remote')){process.stdout.write(c+'\\trefs/tags/v1\\n');process.exit(0)}if(a.includes('init')){fs.mkdirSync(a.at(-1),{recursive:true});fs.appendFileSync(${JSON.stringify(clones)},a.at(-1)+"\\n");process.exit(0)}if(a.includes('fetch'))fs.cpSync(${JSON.stringify(bundle)},p.join(a[1],'plugins','remote'),{recursive:true});if(a.includes('rev-parse'))process.stdout.write(c+'\\n');\n`,
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
		try {
			writeFileSync(
				path.join(root, "config", "hub.yaml"),
				stringify({
					entries: [
						{
							kind: "plugin",
							name: "remote",
							version: "1.0.0",
							description: "remote fixture",
							sourceUrl: "https://github.com/example/repo/tree/v1/plugins/remote",
							sha256: pluginContentDigest(bundle),
						},
					],
				}),
			);
			const stagedDirs = () => readFileSync(clones, "utf8").trim().split("\n");
			const cancelled = planHubLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			equal(cancelled.steps[0]?.source?.staged, true);
			ok(existsSync(stagedDirs()[0] as string));
			releaseHubLifecycle(cancelled);
			equal(existsSync(stagedDirs()[0] as string), false);
			equal(copy("user", "remote"), undefined, "cancel writes nothing");

			const committed = planHubLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			const dry = applyHubLifecycle(committed, { dryRun: true });
			equal(dry.unattempted, 1);
			equal(copy("user", "remote"), undefined, "dry run writes nothing");
			equal(existsSync(stagedDirs()[1] as string), false, "dry run released its staging");

			const real = planHubLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			equal(applyHubLifecycle(real).committed, 1);
			equal(existsSync(stagedDirs()[2] as string), false);
			const temp = readdirSync(tmpdir()).filter((name) => name.startsWith("pancode-plugin-"));
			for (const dir of stagedDirs()) ok(!temp.includes(path.basename(dir)));
		} finally {
			process.env.PATH = previousPath;
		}
	});

	it("reports refresh failure separately, retries refresh only, and re-verifies after a successful refresh", () => {
		catalog([source({ name: "refreshed", kind: "skill" })]);
		const plan = planHubLifecycle({ operation: "install", ref: "skill:refreshed", scope: "user", cwd: root });
		const failing: HubRefreshHost = () => {
			throw new Error("namespace clash");
		};
		const result = applyHubLifecycle(plan, { refresh: failing });
		equal(result.committed, 1);
		deepStrictEqual(result.refresh, { status: "failed", error: "namespace clash" });
		equal(result.outcomes[0]?.verification?.evidence, "pre-refresh");
		const installedAt = readPluginInstallRecord("refreshed", { cwd: root, scope: "user" })?.installedAt;
		const retry = stubHost();
		equal(retryHubRefresh(root, retry.host).status, "refreshed");
		equal(retry.calls, 1);
		equal(readPluginInstallRecord("refreshed", { cwd: root, scope: "user" })?.installedAt, installedAt, "no reinstall");
		equal(retryHubRefresh(root).status, "not-applicable");
	});

	it("keeps a durable commit when read-back verification fails and still refreshes", () => {
		catalog([source({ name: "durable" })]);
		const plan = planHubLifecycle({ operation: "install", ref: "plugin:durable", scope: "user", cwd: root });
		const refresh = stubHost();
		const corrupting: HubRefreshHost = (cwd) => {
			writeFileSync(pluginStatePath("user", root), "{broken");
			return refresh.host(cwd);
		};
		const result = applyHubLifecycle(plan, { refresh: corrupting });
		equal(result.outcomes[0]?.status, "committed");
		equal(result.committed, 1);
		equal(result.refresh.status, "refreshed");
		equal(result.outcomes[0]?.error?.code, "verification");
		equal(result.outcomes[0]?.verification?.evidence, "post-refresh");
		equal(result.outcomes[0]?.verification?.record, "unreadable");
		ok(existsSync(path.join(pluginBaseDir("user", root), "durable")), "the committed tree is still on disk");
	});

	it("fails fast with a locked code while another scope operation holds the peer lock", () => {
		catalog([source({ name: "locked", kind: "skill" })]);
		install("skill:locked", "user");
		install("skill:locked", "project");
		const plan = planHubLifecycle({ operation: "remove", ref: "skill:locked", scope: "project", cwd: root });
		ok(
			plan.steps[0]?.expected.some((fact) => fact.scope === "user"),
			"peer copy is a reviewed fact",
		);
		const held = withPluginScopeLock("user", root, () => applyHubLifecycle(plan));
		equal(held.outcomes[0]?.error?.code, "locked");
		ok(copy("project", "locked"));
		const again = planHubLifecycle({ operation: "remove", ref: "skill:locked", scope: "project", cwd: root });
		equal(applyHubLifecycle(again).committed, 1);
	});

	it("projects an import into the outcome shape with its actual kind and separate admission", () => {
		const foreign = source({ name: "imported", kind: "skill", skill: "imported-skill" });
		const plan = planHubImport(foreign, { cwd: root, scope: "project" });
		equal(plan.action, "install", plan.reasons.join("; "));
		const result = applyHubImport(plan, true, { trustProjectImports: false });
		equal(result.published, true);
		trustProjectPackages(root, "plugins");
		const outcome = hubImportOutcome(plan, result);
		equal(outcome.status, "committed");
		equal(outcome.identity.ref, "skill:imported");
		equal(outcome.identity.scope, "project");
		equal(outcome.verification?.tree, "present");
		equal(copy("project", "imported")?.trust, "foreign");
		const admission = outcome.verification?.resources.find((item) => item.name === "imported-skill");
		ok(admission, "the published skill is visible to verification");
		equal(admission.available, false, "publication is not admission for foreign content");
	});

	it("bundles the catalog without installing it, and the skill offer uses the active profile in both scopes", () => {
		const inventory = readHubInventory({ cwd: root });
		ok(inventory.packages.some((item) => item.ref === "skill:architecture"));
		equal(inventory.copies.length, 0);
		for (const scope of ["user", "project"] as const) {
			const installed = installSkill({ source: "skill:architecture", cwd: root, scope });
			ok(existsSync(installed.path));
			ok(copy(scope, "architecture")?.valid);
		}
		trustProjectPackages(root, "plugins");
		equal(copy("project", "architecture")?.loadable, true);
		equal(copy("user", "architecture")?.effective, false);
	});

	it("labels drift as damaged and repairs through a forced update with a backup", () => {
		catalog([source({ name: "repair", kind: "skill" })]);
		install("skill:repair");
		const installed = copy("user", "repair");
		ok(installed);
		writeFileSync(path.join(installed.rootPath, "assets", "evidence.txt"), "local changes");
		const listed = cli(["list", "--kind", "skill"]);
		const row = (listed.json.entries as Array<{ name: string; copies: Array<{ state: string }> }>).find(
			(item) => item.name === "repair",
		);
		equal(row?.copies[0]?.state, "damaged");
		const refused = cli(["enable", "skill:repair", "--user"]);
		equal(refused.code, 1);
		match(String(refused.json.error), /hub update skill:repair --user --force/);
		const repaired = cli(["update", "skill:repair", "--user", "--force"]);
		equal(repaired.code, 0, JSON.stringify(repaired.json));
		ok(copy("user", "repair")?.loadable);
		ok(JSON.stringify(repaired.json).includes("backup"));
	});

	it("applies only the reviewed extension envelope and loads only a copy whose recorded envelope matches", () => {
		const location = path.join(root, "sources", "gamma-1.0.0");
		mkdirSync(location, { recursive: true });
		writeFileSync(
			path.join(location, "pancode-extension.json"),
			JSON.stringify({
				id: "gamma",
				name: "gamma",
				version: "1.0.0",
				description: "Lifecycle extension",
				runtime: { api: 2, entrypoint: "main.mjs", commands: [{ name: "check", description: "Check" }] },
			}),
		);
		writeFileSync(
			path.join(location, "main.mjs"),
			'export default function (api) { api.handle("check", () => ({ text: "ok" })); }\n',
		);
		writeFileSync(
			path.join(root, "config", "hub.yaml"),
			stringify({
				entries: [
					{
						kind: "extension",
						name: "gamma",
						version: "1.0.0",
						description: "Lifecycle extension",
						sourceUrl: location,
						sha256: pluginContentDigest(location),
					},
				],
			}),
		);
		const plan = planHubLifecycle({ operation: "install", ref: "extension:gamma", scope: "user", cwd: root });
		const review = plan.reviews?.find((item) => item.ref === "extension:gamma");
		ok(review?.envelopeDigest);
		review.envelopeDigest = "0".repeat(64);
		const refused = applyHubLifecycle(plan);
		equal(refused.outcomes[0]?.status, "failed");
		match(String(refused.outcomes[0]?.error?.message), /envelope differs from the one reviewed/);
		equal(listInstalledExtensions(root, { scope: "user", all: true }).length, 0);

		install("extension:gamma");
		const loadable = () =>
			listInstalledExtensions(root, { scope: "user", all: true }).find((item) => item.id === "gamma")?.loadable;
		equal(loadable(), true);
		const stateFile = path.join(extensionBaseDir("user", root), "state.json");
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		state.installed.gamma.envelopeDigest = "1".repeat(64);
		writeFileSync(stateFile, JSON.stringify(state));
		equal(loadable(), false, "a differing recorded envelope");
		delete state.installed.gamma.envelopeDigest;
		writeFileSync(stateFile, JSON.stringify(state));
		equal(loadable(), false, "a missing recorded envelope");
	});

	it("keeps a disabled extension copy disabled across hub update", () => {
		const location = path.join(root, "sources", "delta");
		const writeExtension = (version: string) => {
			mkdirSync(location, { recursive: true });
			writeFileSync(
				path.join(location, "pancode-extension.json"),
				JSON.stringify({
					id: "delta",
					name: "delta",
					version,
					description: "Disabled-update extension",
					runtime: { api: 2, entrypoint: "main.mjs", commands: [{ name: "check", description: "Check" }] },
				}),
			);
			writeFileSync(
				path.join(location, "main.mjs"),
				`export default function (api) { api.handle("check", () => ({ text: ${JSON.stringify(version)} })); }\n`,
			);
			writeFileSync(
				path.join(root, "config", "hub.yaml"),
				stringify({
					entries: [
						{
							kind: "extension",
							name: "delta",
							version,
							description: "Disabled-update extension",
							sourceUrl: location,
							sha256: pluginContentDigest(location),
						},
					],
				}),
			);
		};
		writeExtension("1.0.0");
		install("extension:delta");
		const disable = applyHubLifecycle(
			planHubLifecycle({ operation: "disable", ref: "extension:delta", scope: "user", cwd: root }),
		);
		equal(disable.outcomes[0]?.status, "committed");

		writeExtension("1.0.1");
		const plan = planHubLifecycle({ operation: "update", ref: "extension:delta", scope: "user", cwd: root });
		equal(plan.steps[0]?.effectiveAfter?.state, "disabled");
		equal(plan.steps[0]?.effectiveAfter?.loadable, false);
		const updated = applyHubLifecycle(plan);
		equal(updated.outcomes[0]?.status, "committed");
		const copyAfter = listInstalledExtensions(root, { scope: "user", all: true }).find((item) => item.id === "delta");
		equal(copyAfter?.version, "1.0.1");
		equal(copyAfter?.enabled, false);
		equal(copyAfter?.loadable, false);
	});

	it("exposes plans and outcomes through the CLI with additive JSON and dry-run for every mutation", () => {
		catalog([source({ name: "cli", kind: "skill" }), source({ name: "user", requires: ["skill:cli"] })]);
		const dry = cli(["install", "skill:cli", "--dry-run"]);
		equal(dry.code, 0, JSON.stringify(dry.json));
		equal(dry.json.confirmed, false);
		equal((dry.json.apply as { unattempted: number }).unattempted, 1);
		equal(copy("user", "cli"), undefined);
		const installed = cli(["install", "skill:cli"]);
		equal(installed.code, 0, JSON.stringify(installed.json));
		equal(installed.json.confirmed, true);
		equal((installed.json.writes as unknown[]).length, 1);
		equal((installed.json.apply as { refresh: { status: string } }).refresh.status, "not-applicable");
		const disableDry = cli(["disable", "skill:cli", "--dry-run"]);
		equal(disableDry.code, 0);
		equal(copy("user", "cli")?.enabled, true, "dry-run disable writes nothing");
		equal(cli(["install", "plugin:user"]).code, 0);
		const refused = cli(["remove", "skill:cli"]);
		equal(refused.code, 1);
		equal(refused.json.ok, false);
		match(String(refused.json.error), /would break user:plugin:user/);
		ok(copy("user", "cli"));
		const disabled = cli(["disable", "plugin:user"]);
		equal(disabled.code, 0);
		equal((disabled.json.plugin as { enabled: boolean }).enabled, false);
		const removed = cli(["remove", "skill:cli"]);
		equal(removed.code, 0, JSON.stringify(removed.json));
		equal(removed.json.removed, "skill:cli");
		equal(copy("user", "cli"), undefined);
	});

	it("keeps lifecycle code out of native workers and headless discovery", () => {
		const forbidden = [
			"src/worker",
			"src/engine/worker-runtime.ts",
			"src/engine/worker-run-types.ts",
			"src/engine/worker-assistant-reply.ts",
			"src/engine/worker-result-contract.ts",
			"src/engine/worker-grounding.ts",
			"src/engine/worker-thrash-note.ts",
			"src/engine/worker-escalation.ts",
			"src/domains/plugins/resources.ts",
			"src/domains/agents",
		];
		const repo = path.resolve(new URL("../..", import.meta.url).pathname);
		const walk = (target: string): string[] => {
			const full = path.join(repo, target);
			if (!existsSync(full)) return [];
			if (!readdirSync(path.dirname(full)).includes(path.basename(full))) return [];
			try {
				return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
					entry.isDirectory() ? walk(path.join(target, entry.name)) : [path.join(target, entry.name)],
				);
			} catch {
				return [target];
			}
		};
		for (const file of forbidden.flatMap(walk).filter((file) => file.endsWith(".ts")))
			ok(!readFileSync(path.join(repo, file), "utf8").includes("hub-actions"), `${file} imports lifecycle code`);
	});
});
