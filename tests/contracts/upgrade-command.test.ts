// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { runUpgradeCommand, type UpgradeDependencies } from "../../src/cli/upgrade.js";
import { detectNewerHome, initializePancodeHome } from "../../src/core/init.js";
import { readPancodeVersion } from "../../src/core/package-root.js";
import { processBirthToken } from "../../src/core/process-identity.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	inspectInstallation,
	installationCommand,
	npmInstallArgs,
} from "../../src/domains/lifecycle/install-method.js";
import { describeUpgradeNotice } from "../../src/domains/lifecycle/upgrade-notice.js";
import { isolatePancodeEnv, makeScratchHome } from "../harness/scratch-env.js";

const ARGV_MODULE = new URL("../../src/cli/argv.ts", import.meta.url).href;
const TSX_IMPORT = `--import=${import.meta.resolve("tsx")}`;

function installedFixture() {
	const home = makeScratchHome("pancode-upgrade-command-");
	const prefix = join(home.dir, "custom prefix");
	const root = join(prefix, "lib/node_modules/@panstudio/pancode");
	const entry = join(root, "dist/cli/index.js");
	const bin = join(home.dir, "bin");
	const log = join(home.dir, "calls.jsonl");
	mkdirSync(dirname(entry), { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(root, "package.json"), '{"name":"@panstudio/pancode","version":"0.5.4","type":"module"}');
	// The relaunch is judged by the real startup parser, not by the fixture: a
	// fake that accepted any argv is how a refused relaunch once stayed
	// green. The post-install and doctor children are recognized by their verb.
	writeFileSync(
		entry,
		[
			"import fs from 'node:fs';",
			"const args = process.argv.slice(2);",
			"fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ entry: process.argv[1], args, parent: process.env.PANCODE_UPGRADE_PARENT })+'\\n');",
			"if (args[0] === 'upgrade' || args[0] === 'doctor') process.exitCode = Number(process.env.POST_CODE || 0);",
			"else {",
			`  const { extractGlobalFlags } = await import(${JSON.stringify(ARGV_MODULE)});`,
			"  const parsed = extractGlobalFlags(args);",
			"  if (parsed.error) { process.stderr.write('relaunch refused: ' + parsed.error + '\\n'); process.exitCode = 2; }",
			"  else process.exitCode = Number(process.env.RESTART_CODE || 0);",
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(bin, "npm"),
		`#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: 'npm', args: process.argv.slice(2) })+'\\n');`,
		{ mode: 0o755 },
	);
	writeFileSync(join(bin, "pancode"), "#!/bin/sh\necho WRONG_LAUNCHER >&2\nexit 91\n", { mode: 0o755 });
	function run(args: string[], extra = "", env: NodeJS.ProcessEnv = {}) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--input-type=module",
				"-e",
				`
			import { runUpgradeCommand } from ${JSON.stringify(new URL("../../src/cli/upgrade.ts", import.meta.url).href)};
			import { inspectInstallation } from ${JSON.stringify(new URL("../../src/domains/lifecycle/install-method.ts", import.meta.url).href)};
			process.exitCode = await runUpgradeCommand(${JSON.stringify(args)}, {
				inspectInstallation: () => inspectInstallation(${JSON.stringify(entry)}),
				lookUpAvailableVersion: async () => ({ asked: true, version: '99.0.0' }),
				${extra}
			});`,
			],
			{
				env: {
					...process.env,
					...home.env,
					HOME: home.dir,
					npm_config_cache: join(home.dir, "npm-cache"),
					PATH: `${bin}:${process.env.PATH}`,
					CALL_LOG: log,
					// The installed-entry fixture imports the TypeScript argv parser.
					NODE_OPTIONS: [process.env.NODE_OPTIONS, TSX_IMPORT].filter(Boolean).join(" "),
					...env,
				},
				encoding: "utf8",
				timeout: 20_000,
			},
		);
	}
	// run() in this process, for tests of the plan and its output rather than of the relaunch through the real parser.
	async function call(args: string[], extra: Partial<UpgradeDependencies> = {}, env: NodeJS.ProcessEnv = {}) {
		const scope = await isolatePancodeEnv("pancode-upgrade-call-");
		Object.assign(process.env, home.env, {
			HOME: home.dir,
			npm_config_cache: join(home.dir, "npm-cache"),
			PATH: `${bin}:${process.env.PATH}`,
			CALL_LOG: log,
			...env,
		});
		resetXdgCache();
		try {
			const {
				value: status,
				stdout,
				stderr,
			} = await captureOutput(() =>
				runUpgradeCommand(args, {
					inspectInstallation: () => inspectInstallation(entry),
					lookUpAvailableVersion: async () => ({ asked: true, version: "99.0.0" }),
					...extra,
				}),
			);
			return { status, stdout, stderr };
		} finally {
			scope.restore();
		}
	}
	const calls = () =>
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { home, prefix, root, entry, log, run, call, calls };
}

async function captureOutput<T>(run: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	// The test runner reports through stdout as binary frames; only the command's own text is captured.
	const forward = process.stdout.write.bind(process.stdout) as (chunk: string | Uint8Array) => boolean;
	const out = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		if (typeof chunk !== "string") return forward(chunk);
		stdout += chunk;
		return true;
	});
	const err = mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	try {
		const value = await run();
		return { value, stdout, stderr };
	} finally {
		out.mock.restore();
		err.mock.restore();
	}
}

const logLine = (log: string, row: Record<string, unknown>) => appendFileSync(log, `${JSON.stringify(row)}\n`);

test("npm layout preserves a custom prefix through launcher symlinks and shell quoting", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const link = join(f.home.dir, "launcher");
	symlinkSync(f.entry, link);
	const found = inspectInstallation(link);
	assert.equal(found.kind, "npm");
	assert.equal(found.prefix, f.prefix);
	assert.deepEqual(npmInstallArgs(found, "latest"), [
		"install",
		"-g",
		"--prefix",
		f.prefix,
		"@panstudio/pancode@latest",
	]);
	assert.match(installationCommand(found, "uninstall"), /npm uninstall -g --prefix '.*custom prefix'/);
	assert.throws(() => npmInstallArgs({ ...found, kind: "pnpm" }, "latest"), /original package manager/);
});

test("pnpm project stores stay local while its recognized global layout uses pnpm guidance", (t) => {
	const home = makeScratchHome("pancode-pnpm-layout-");
	t.after(home.cleanup);
	for (const [layout, kind] of [
		["project/node_modules/.pnpm/pkg/node_modules/@panstudio/pancode", "local"],
		["pnpm/global/5/.pnpm/pkg/node_modules/@panstudio/pancode", "pnpm"],
		["share/pnpm/store/v11/links/@panstudio/pancode/0.9.1/a1/node_modules/@panstudio/pancode", "pnpm"],
		["shared/store/v11/links/@panstudio/pancode/0.9.1/b2/node_modules/@panstudio/pancode", "local"],
	] as const) {
		const root = join(home.dir, layout);
		const entry = join(root, "dist/cli/index.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "// fixture");
		writeFileSync(join(root, "package.json"), '{"name":"@panstudio/pancode","version":"0.5.4"}');
		// pnpm 11+ reaches a global package through <pnpm home>/global/v<n>/<id>/node_modules.
		if (layout.startsWith("share/pnpm/")) {
			const link = join(home.dir, "share/pnpm/global/v11/c3/node_modules/@panstudio/pancode");
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(root, link);
		}
		assert.equal(inspectInstallation(entry).kind, kind, layout);
	}
});

test("upgrade updates the same prefix and runs checks with the exact installed entry despite PATH shadowing", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--json"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(JSON.parse(result.stdout).status, "success");
	assert.deepEqual(f.calls(), [
		{ command: "npm", args: ["install", "-g", "--prefix", f.prefix, "@panstudio/pancode@99.0.0"] },
		{ entry: f.entry, args: ["upgrade", "--post-install", "--channel=latest", "--json"], parent: "1" },
	]);
});

test("a successful upgrade asks the installed CLI to restart an idle background app once", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const background = join(f.home.dir, "state/gui/background");
	mkdirSync(background, { recursive: true });
	writeFileSync(join(background, "owner.json"), "{}\n");
	const restart: Partial<UpgradeDependencies> = {
		runBackgroundRestart: async (installation) => {
			logLine(f.log, { backgroundEntry: installation.entry });
			return "PanCode background app was left running because it is busy.";
		},
	};
	const result = await f.call(["--json"], restart);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.deepEqual(f.calls().at(-1), { backgroundEntry: f.entry });
	assert.match(result.stdout, /background app was left running because it is busy/);

	// The post-install run an upgrade starts leaves the restart to it, so an idle app restarts once.
	const child = await f.call(
		["--post-install", "--json"],
		{
			runBackgroundRestart: async () => {
				throw new Error("must not run under an upgrade");
			},
		},
		{ PANCODE_UPGRADE_PARENT: "1" },
	);
	assert.equal(child.status, 0, child.stderr + child.stdout);
	assert.doesNotMatch(child.stdout, /must not run under an upgrade|background app/);
	assert.deepEqual(f.calls().at(-1), { backgroundEntry: f.entry });

	// A post-install the installer runs on its own restarts the app itself.
	const installer = await f.call(["--post-install", "--json"], restart);
	assert.equal(installer.status, 0, installer.stderr + installer.stdout);
	assert.equal(f.calls().filter((call) => call.backgroundEntry === f.entry).length, 2);
	assert.match(installer.stdout, /background app was left running because it is busy/);
});

test("post-install leaves a background app another installation owns where it is and names the installer root it left", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const background = join(f.home.dir, "state/gui/background");
	mkdirSync(background, { recursive: true });
	writeFileSync(join(background, "owner.json"), "{}\n");
	const installRoot = join(f.home.dir, "old-install");
	const oldPrefix = join(installRoot, "versions", "0.6.2");
	const oldPackage = join(oldPrefix, "lib/node_modules/pancode");
	const shadowDir = join(f.home.dir, "shadow-bin");
	mkdirSync(join(oldPackage, "dist"), { recursive: true });
	mkdirSync(shadowDir);
	const launcher = join(shadowDir, "pancode");
	writeFileSync(
		join(installRoot, "install.json"),
		JSON.stringify({
			schema: 3,
			kind: "pancode-installer",
			current: oldPrefix,
			node: join(oldPrefix, "bin", "node"),
			launcher,
		}),
	);
	writeFileSync(launcher, `#!/bin/sh\n# pancode-installer launcher\nexec "${oldPrefix}/bin/x"\n`, { mode: 0o755 });
	writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: oldPackage }));
	const env = { PANCODE_INSTALL_DIR: installRoot, PATH: `${shadowDir}:${process.env.PATH}` };
	const moved = await f.call(["--post-install"], {}, env);
	assert.equal(moved.status, 0, moved.stderr + moved.stdout);
	// No gui background command ran: the other installation's service and desktop entry are untouched.
	assert.equal(existsSync(join(f.home.dir, "calls.jsonl")), false);
	const said = (moved.stdout + moved.stderr).replace(/\s+/g, " ");
	assert.match(said, /Left the desktop app running from \S*old-install\/versions\/0\.6\.2/);
	assert.match(
		said,
		/Move it to this installation when you want it to follow: pancode gui background install --handover/,
	);
	assert.match(said, /old-install \(\d+ B\) is no longer used by this installation/);
	assert.match(said, /shadow-bin\/pancode comes first on PATH and still starts the old installation/);
	assert.match(moved.stdout, /pancode uninstall --inactive/);

	// A newer version of the same installation restarts the app and never hands over.
	writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: f.root }));
	const same = await f.call(["--post-install"], {}, env);
	assert.equal(same.status, 0, same.stderr + same.stdout);
	assert.doesNotMatch(same.stdout + same.stderr, /--handover/);
	assert.deepEqual(f.calls().at(-1)?.args, ["gui", "background", "restart", "--if-idle"]);
});

test("an installer post-install under --no-gui leaves the desktop app, its handover and its shortcut alone (F-C17)", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const background = join(f.home.dir, "state/gui/background");
	mkdirSync(background, { recursive: true });
	writeFileSync(join(background, "owner.json"), "{}\n");
	// Another installation owns the app; a post-install never hands it over or rewrites its shortcut.
	writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: join(f.home.dir, "elsewhere") }));
	const untouched: Partial<UpgradeDependencies> = {
		runBackgroundRestart: async () => {
			throw new Error("must not restart");
		},
	};
	const declined = await f.call(["--post-install"], untouched, { PANCODE_INSTALL_GUI: "0" });
	assert.equal(declined.status, 0, declined.stderr + declined.stdout);
	assert.doesNotMatch(declined.stdout + declined.stderr, /must not restart/);
	assert.match(declined.stdout, /Left the desktop app running from \S*elsewhere/);
	assert.match(declined.stdout, /pancode gui background install --handover/);
	// No child ran at all, so no `gui background install` could write a launcher or a Start Menu shortcut.
	assert.equal(existsSync(join(f.home.dir, "calls.jsonl")), false);

	// The app of this same installation needs only a restart, not a handover from itself.
	writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: f.root }));
	const own = await f.call(["--post-install"], untouched, { PANCODE_INSTALL_GUI: "0" });
	assert.equal(own.status, 0, own.stderr + own.stdout);
	assert.match(own.stdout, /pancode gui background restart --if-idle/);
	assert.doesNotMatch(own.stdout, /--handover|Move it to this installation/);
	assert.equal(existsSync(join(f.home.dir, "calls.jsonl")), false);
});

test("restart follows successful checks, relaunches with argv the real parser accepts, and propagates the new CLI's exit status", (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = f.run(["--restart"], "isInteractive: () => true,", { RESTART_CODE: "7" });
	assert.equal(result.status, 7, result.stderr + result.stdout);
	assert.doesNotMatch(result.stderr, /relaunch refused/);
	assert.deepEqual(
		f.calls().map((row) => row.args),
		[
			["install", "-g", "--prefix", f.prefix, "@panstudio/pancode@99.0.0"],
			["upgrade", "--post-install", "--channel=latest", "--json"],
			[],
		],
	);
});

test("a failed relaunch names pancode --continue, which the startup parser accepts", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const relaunchFailed = await f.call(["--restart"], {
		isInteractive: () => true,
		runRestart: async () => {
			throw new Error("spawn failed");
		},
	});
	assert.equal(relaunchFailed.status, 1);
	assert.match(relaunchFailed.stderr, /run pancode --continue in this project/);
	assert.doesNotMatch(relaunchFailed.stdout + relaunchFailed.stderr, /\/resume/);
	assert.equal(extractGlobalFlags(["--continue"]).error, undefined);
});

test("failed checks never relaunch and recovery points to post-install", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = await f.call(["--restart"], { isInteractive: () => true }, { POST_CODE: "1" });
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.equal(f.calls().length, 2);
	assert.match(result.stdout, /upgrade --post-install/);
});

test("post-install initializes integrity without running environment repairs", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const state = join(f.home.dir, "state");
	mkdirSync(state);
	writeFileSync(join(state, "home.json"), JSON.stringify({ version: readPancodeVersion() }));
	const result = await f.call(["--post-install", "--json"]);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.throws(f.calls, /ENOENT/, "post-install no longer invokes environment doctor repair");
});

test("restart rejects automation and conflicting flags before changing the installation", async (t) => {
	const home = await isolatePancodeEnv("pancode-upgrade-rejected-");
	t.after(() => home.restore());
	const before = readdirSync(home.dir);
	for (const args of [["--restart"], ["--restart", "--json"], ["--restart", "--post-install"]]) {
		const code = await runUpgradeCommand(args, {
			isInteractive: () => false,
			inspectInstallation: () => {
				throw new Error("rejected restart inspected the installation");
			},
		});
		assert.equal(code, 2);
	}
	assert.deepEqual(readdirSync(home.dir), before);
});

test("manual package managers get instructions without replacement and dry runs never restart", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = await f.call(["--json"], {
		inspectInstallation: () => ({ ...inspectInstallation(f.entry), kind: "pnpm" }),
	});
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.match(result.stdout, /pnpm add -g/);
	// npm has no beta dist-tag between pre-releases, so the beta command names the version beta resolves to.
	const beta = await f.call(["--channel", "beta", "--json"], {
		inspectInstallation: () => ({ ...inspectInstallation(f.entry), kind: "pnpm" }),
		lookUpAvailableVersion: async (channel) => ({ asked: true, version: channel === "beta" ? "99.0.0" : null }),
	});
	assert.equal(beta.status, 1, beta.stderr + beta.stdout);
	assert.match(beta.stdout, /pnpm add -g @panstudio\/pancode@99\.0\.0/);
	assert.doesNotMatch(beta.stdout, /@beta/);
	// Without a registry answer the beta check lists both tags, and the replacement waits for the version they name.
	const unknownBeta = await f.call(["--channel", "beta", "--json"], {
		inspectInstallation: () => ({ ...inspectInstallation(f.entry), kind: "pnpm" }),
		lookUpAvailableVersion: async () => ({ asked: true, version: null }),
	});
	assert.equal(unknownBeta.status, 1, unknownBeta.stderr + unknownBeta.stdout);
	assert.match(unknownBeta.stdout, /pnpm view @panstudio\/pancode dist-tags/);
	assert.match(unknownBeta.stdout, /pnpm add -g @panstudio\/pancode@<version>/);
	assert.doesNotMatch(unknownBeta.stdout, /@beta/);
	// A newer npm version says nothing about what Homebrew would install.
	const brew = await f.call(["--json"], {
		inspectInstallation: () => ({ ...inspectInstallation(f.entry), kind: "homebrew" }),
		lookUpAvailableVersion: async () => ({ asked: true, version: "99.0.0" }),
	});
	assert.equal(brew.status, 1, brew.stderr + brew.stdout);
	assert.match(brew.stdout, /brew outdated pancode/);
	assert.doesNotMatch(brew.stdout, /99\.0\.0|needs a package-manager update/);
	const preview = await f.call(["--dry-run", "--restart"]);
	assert.equal(preview.status, 0, preview.stderr + preview.stdout);
	assert.match(preview.stdout, /Would relaunch/);
	assert.throws(f.calls, /ENOENT/);
});

test("an older dist-tag never downgrades the installed package", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = await f.call(["--json"], { lookUpAvailableVersion: async () => ({ asked: true, version: "0.0.1" }) });
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.throws(f.calls, /ENOENT/, "post-install no longer invokes environment doctor repair");
	assert.match(result.stdout, /keeping it/);
});

test("init closes private state directories found group or world readable", {
	skip: process.platform === "win32",
}, async (t) => {
	const home = await isolatePancodeEnv("pancode-private-memory-");
	t.after(() => home.restore());
	const open = [
		join(home.dir, "state", "memory"),
		join(home.dir, "data", "memory"),
		join(home.dir, "state", "sessions"),
	];
	for (const dir of open) {
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o755);
	}
	initializePancodeHome();
	for (const dir of open) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
});

test("post-install integrity rejects malformed settings with useful details", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	mkdirSync(join(f.home.dir, "config"));
	writeFileSync(join(f.home.dir, "config/settings.yaml"), "broken: [\n");
	const result = await f.call(["--post-install", "--json"]);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /settings.yaml|YAML|parse/i);
	assert.throws(f.calls, /ENOENT/, "doctor --fix was not invoked");
	assert.equal(readFileSync(join(f.home.dir, "config/settings.yaml"), "utf8"), "broken: [\n");
});

test("rollback refuses manager-owned installs before any child command", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	const result = await f.call(["--rollback", "--json"]);
	assert.equal(result.status, 2, result.stdout + result.stderr);
	assert.match(result.stdout, /native installer/i);
	assert.match(result.stdout, /@panstudio\/pancode@<version>/);
	assert.throws(f.calls, /ENOENT/);

	// Once the home records the version it ran before, the advice names it exactly.
	mkdirSync(join(f.home.dir, "state"), { recursive: true });
	writeFileSync(
		join(f.home.dir, "state/home.json"),
		JSON.stringify({ version: "0.7.1-dev", upgradedFrom: "0.6.9", platform: "linux", nodeVersion: "v24" }),
	);
	const named = await f.call(["--rollback"]);
	assert.equal(named.status, 2, named.stdout + named.stderr);
	assert.match(named.stdout, /previous version, 0\.6\.9/);
	assert.match(named.stdout, /npm install -g --prefix .* @panstudio\/pancode@0\.6\.9/);
});

async function rollBackTo(
	homeDir: string,
	version: string,
): Promise<{ code: number; stamped: { version: string; downgradedFrom?: string } }> {
	const root = join(homeDir, "install");
	const previous = join(root, "versions", version);
	const pkg = join(previous, "lib/node_modules/pancode");
	mkdirSync(join(pkg, "dist/cli"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
	writeFileSync(join(pkg, "dist/cli/index.js"), "");
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "install.sh"), "echo '[install] switched'\n");
	const { value: code } = await captureOutput(() =>
		runUpgradeCommand(["--rollback", "--json"], {
			inspectInstallation: () => ({
				kind: "installer",
				root,
				entry: join(root, "versions", "current", "dist/cli/index.js"),
				prefix: join(root, "versions", "current"),
				installer: {
					root,
					node: process.execPath,
					nodeVersion: "24",
					nodeBuild: "linux-x64",
					current: join(root, "versions", "current"),
					previous,
					launcher: join(homeDir, "bin", "pancode"),
					channel: "latest",
				},
			}),
		}),
	);
	return { code, stamped: JSON.parse(readFileSync(join(homeDir, "state", "home.json"), "utf8")) };
}

test("a native rollback leaves the older version able to open the home the newer one used", {
	skip: process.platform === "win32",
}, async (t) => {
	const home = await isolatePancodeEnv("pancode-rollback-home-");
	t.after(() => home.restore());
	initializePancodeHome();
	const { code, stamped } = await rollBackTo(home.dir, "0.7.0");
	assert.equal(code, 0);
	assert.deepEqual([stamped.version, stamped.downgradedFrom], ["0.7.0", readPancodeVersion()]);
});

test("rolling back to a newer version records no downgrade", { skip: process.platform === "win32" }, async (t) => {
	const home = await isolatePancodeEnv("pancode-rollback-forward-");
	t.after(() => home.restore());
	initializePancodeHome();
	const homeJson = join(home.dir, "state", "home.json");
	const before = { ...JSON.parse(readFileSync(homeJson, "utf8")), version: "0.7.0", upgradedFrom: "0.6.9" };
	writeFileSync(homeJson, JSON.stringify(before));
	const { code, stamped } = await rollBackTo(home.dir, readPancodeVersion());
	assert.equal(code, 0);
	assert.deepEqual(stamped, before);
});

test("upgrade refuses while another registered session runs from an npm prefix the deferred wrapper owns", async (t) => {
	const f = installedFixture();
	t.after(f.home.cleanup);
	// The layout deferredUpdateTarget accepts: the prefix's launcher is this package's, and npm sits in the prefix.
	writeFileSync(join(f.root, "bin.cjs"), "");
	mkdirSync(join(f.prefix, "bin"));
	symlinkSync(join(f.root, "bin.cjs"), join(f.prefix, "bin", "pancode"));
	const npmCli = join(f.prefix, "lib/node_modules/npm/bin/npm-cli.js");
	mkdirSync(dirname(npmCli), { recursive: true });
	writeFileSync(
		npmCli,
		"require('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: 'npm-cli' })+'\\n');",
	);
	const session = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(() => session.kill("SIGKILL"));
	const pid = session.pid as number;
	const hold = join(f.prefix, "lib/node_modules");
	const machine = ["/etc/machine-id", "/var/lib/dbus/machine-id"]
		.map((file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : ""))
		.find(Boolean);
	mkdirSync(join(hold, ".pancode-active"));
	writeFileSync(
		join(hold, ".pancode-active", String(pid)),
		JSON.stringify({
			host: machine ? `${machine}:${hostname()}` : hostname(),
			hostname: hostname(),
			birth: processBirthToken(pid),
			startedAt: Date.now(),
		}),
	);
	const result = f.run([]);
	assert.equal(result.status, 75, result.stderr + result.stdout);
	assert.match(result.stdout + result.stderr, new RegExp(`${pid}@${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.throws(f.calls, /ENOENT/, "no package manager ran");
	assert.equal(existsSync(join(hold, ".pancode-update.json")), false);
});

test("a home a 0.7.1 pre-release build stamped opens under 0.8.0 without the older-version prompt", async (t) => {
	const home = await isolatePancodeEnv("pancode-prerelease-stamp-");
	t.after(() => home.restore());
	initializePancodeHome();
	for (const version of ["0.7.1", "0.7.1-dev", "0.7.1-rc.0", "0.7.0"]) {
		writeFileSync(
			join(home.dir, "state", "home.json"),
			JSON.stringify({ version, upgradedFrom: "0.7.0", platform: "linux", nodeVersion: "v24" }),
		);
		assert.equal(detectNewerHome(), null, version);
	}
});

test("an upgrade without keyboard-facing changes points at its CHANGELOG section", () => {
	const notice = describeUpgradeNotice({ from: "0.9.0", to: "0.9.1" });
	assert.equal(notice, "pancode: upgraded 0.9.0 → 0.9.1. What changed is in CHANGELOG.md, section 0.9.1.");
});
