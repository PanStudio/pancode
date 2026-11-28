// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { HUB_PLUGIN_BACKED_KINDS, type HubEntryKind } from "../../src/domains/plugins/hub-types.js";
import {
	disablePlugin,
	enablePlugin,
	installHubPack,
	installPlugin,
	listInstalledPlugins,
	pluginContentDigest,
	readPluginInstallRecord,
	readPluginManifest,
	removePlugin,
	updatePlugin,
} from "../../src/domains/plugins/index.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

function write(root: string, file: string, body: string): void {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), body);
}
/** A pack of `kind`; `carries` puts one public component in it, and a plugin carrying a prompt is the prompt case. */
function fixture(root: string, kind: HubEntryKind, version = "1.0.0", carries?: "skill" | "prompt"): void {
	const component = kind === "skill" ? "skill" : carries;
	const file = component === "skill" ? "skills/example/SKILL.md" : `${component}s/example.md`;
	const bare = component === undefined;
	if (!bare) write(root, file, `---\nname: example\ndescription: Fixture content\n---\nContent ${version}\n`);
	write(root, "assets/proof.txt", version);
	write(
		root,
		"plugin.json",
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "example",
			version,
			extensions: {
				"dev.pancode": {
					manifestVersion: 1,
					kind,
					resources: bare ? {} : { [`${component}s`]: `${component}s` },
					components: bare ? [] : [{ kind: component, id: "example", path: file }],
				},
			},
		}),
	);
}

for (const kind of HUB_PLUGIN_BACKED_KINDS)
	test(`${kind} uses the same scoped manifest, pin, provenance and lifecycle`, async () => {
		const env = await isolatePancodeEnv(`hub-${kind}-`);
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "source");
			fixture(source, kind);
			const digest = pluginContentDigest(source);
			for (const scope of ["user", "project"] as const) {
				const result = installHubPack({
					kind,
					sourcePath: source,
					scope,
					cwd,
					origin: { kind: "local", source },
					trust: "trusted",
				});
				ok(result.plugin?.valid, JSON.stringify(result.diagnostics));
				equal(result.plugin.kind, kind);
				equal(readPluginInstallRecord("example", { cwd, scope })?.contentDigest, digest);
			}
			trustProjectPackages(cwd, "plugins");
			equal(listInstalledPlugins(cwd, { all: true }).filter((e) => e.id === "example").length, 2);
			ok(disablePlugin("example", { cwd, scope: "project" }).plugin?.enabled === false);
			trustProjectPackages(cwd, "plugins");
			equal(listInstalledPlugins(cwd).find((p) => p.id === "example")?.loadable, false);
			ok(enablePlugin("example", { cwd, scope: "project" }).plugin);
			trustProjectPackages(cwd, "plugins");
			ok(listInstalledPlugins(cwd, { scope: "project" }).find((p) => p.id === "example")?.loadable);
			fixture(source, kind, "1.1.0");
			ok(updatePlugin("example", { cwd, scope: "project" }).plugin?.version === "1.1.0");
			const installed = listInstalledPlugins(cwd, { scope: "project", all: true })[0];
			ok(installed);
			write(installed.rootPath, "plugin.json", "invalid manifest");
			const broken = listInstalledPlugins(cwd, { scope: "project", all: true }).find((e) => e.id === "example");
			equal(broken?.kind, kind);
			equal(broken?.valid, false);
			const removed = removePlugin("example", { cwd, scope: "project" });
			ok(!removed.diagnostics.some((d) => d.type === "error"));
			equal(existsSync(installed.rootPath), false);
			ok(removed.recovery?.packageBackup);
			equal(listInstalledPlugins(cwd, { scope: "user", all: true }).find((p) => p.id === "example")?.kind, kind);
			ok(updatePlugin("example", { cwd, scope: "user" }).plugin?.version === "1.1.0");
			ok(disablePlugin("example", { cwd, scope: "user" }).plugin?.enabled === false);
			ok(enablePlugin("example", { cwd, scope: "user" }).plugin?.loadable);
			ok(!removePlugin("example", { cwd, scope: "user" }).diagnostics.some((d) => d.type === "error"));
			equal(listInstalledPlugins(cwd, { all: true }).filter((p) => p.id === "example").length, 0);
		} finally {
			env.restore();
		}
	});

for (const kind of ["skill", "prompt"] as const)
	test(`foreign ${kind} keeps trust and provenance through reload and refuses every replacement bypass`, async () => {
		const env = await isolatePancodeEnv(`foreign-${kind}-`);
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "host");
			const packKind = kind === "skill" ? "skill" : "plugin";
			fixture(source, packKind, "1.0.0", kind);
			const origin = { kind: "interop" as const, host: "claude-code", source };
			const installed = installHubPack({
				kind: packKind,
				sourcePath: source,
				scope: "user",
				cwd,
				origin,
				trust: "foreign",
			});
			ok(installed.plugin?.valid);
			const before = readPluginInstallRecord("example", { cwd, scope: "user" });
			deepStrictEqual(before?.origin, origin);
			equal(before?.trust, "foreign");
			equal(listInstalledPlugins(cwd)[0]?.trust, "foreign");
			const loaded = () =>
				kind === "skill"
					? loadSkills({
							cwd,
							home: env.dir,
							trustProjectCompatRoots: readSettings().integrations.hub.trustProjectImports,
						}).items.find((e) => e.name === "example")?.trusted
					: loadPromptTemplates({
							cwd,
							trustProjectCompatRoots: readSettings().integrations.hub.trustProjectImports,
						}).items.find((e) => e.name === "example")?.trusted;
			equal(loaded(), false);
			if (kind === "skill") {
				const file = join(installed.plugin.rootPath, "skills/example/SKILL.md");
				equal(loadSkills({ cwd, disableDiscovery: true, explicitSkillPaths: [file] }).items[0]?.trusted, false);
				equal(
					loadSkills({ cwd, disableDiscovery: true, explicitSkillPaths: [file], trustProjectCompatRoots: true }).items[0]
						?.trusted,
					true,
				);
			}

			updateSettings((settings) => {
				settings.integrations.hub.trustProjectImports = true;
			});
			equal(loaded(), true);
			updateSettings((settings) => {
				settings.integrations.hub.trustProjectImports = false;
			});
			equal(loaded(), false);
			write(source, "host-executable.sh", "dangerous host hook\n");
			match(
				updatePlugin("example", { cwd, scope: "user", force: true }).diagnostics[0]?.message ?? "",
				/reviewed adoption/,
			);
			const direct = installPlugin(source, {
				cwd,
				scope: "user",
				force: true,
				origin: { kind: "local", source },
				trust: "trusted",
			});
			match(direct.diagnostics[0]?.message ?? "", /reviewed adoption/);
			deepStrictEqual(readPluginInstallRecord("example", { cwd, scope: "user" }), before);
			equal(existsSync(join(installed.plugin.rootPath, "host-executable.sh")), false);
			equal(loaded(), false);
		} finally {
			env.restore();
		}
	});

test("manifest kind and explicit version cannot be substituted or changed with force", async () => {
	const env = await isolatePancodeEnv("hub-manifest-");
	try {
		const source = join(env.dir, "source");
		fixture(source, "skill");
		ok(
			installHubPack({
				kind: "plugin",
				sourcePath: source,
				scope: "user",
				origin: { kind: "local", source },
				trust: "trusted",
			}).diagnostics.some((d) => d.type === "error"),
		);
		ok(installPlugin(source).plugin?.valid);
		rmSync(join(source, "skills"), { recursive: true });
		fixture(source, "plugin", "1.0.0", "prompt");
		match(installPlugin(source, { force: true }).diagnostics[0]?.message ?? "", /kind cannot change/);
		const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
		delete manifest.version;
		write(source, "plugin.json", JSON.stringify(manifest));
		equal(readPluginManifest(source).valid, false);
	} finally {
		env.restore();
	}
});

test("package versions share strict prerelease validation and single kinds cannot hide extra public files", async () => {
	const env = await isolatePancodeEnv("hub-semver-");
	try {
		const root = join(env.dir, "source");
		for (const version of ["0.0.0", "1.0.0-0", "1.2.3-alpha.0", "1.0.0-01a", "1.2.3+001"]) {
			fixture(root, "plugin", version);
			ok(readPluginManifest(root).valid, version);
		}
		for (const version of [
			"1.0.0-01",
			"1.0.0-alpha.01",
			"v1.2.3",
			"01.2.3",
			"1.2",
			"1.2.3-",
			"1.2.3+",
			"9007199254740992.0.0",
		]) {
			fixture(root, "plugin", version);
			equal(readPluginManifest(root).valid, false, version);
		}
		fixture(root, "skill");
		write(root, "skills/undeclared/SKILL.md", "---\nname: undeclared\ndescription: Unexpected public skill\n---\n");
		equal(readPluginManifest(root).valid, false);
	} finally {
		env.restore();
	}
});
