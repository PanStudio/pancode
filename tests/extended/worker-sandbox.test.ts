// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { readSettings } from "../../src/core/config.js";
import { sandboxAvailability, sandboxNetworkIsolation } from "../../src/core/sandbox/availability.js";
import { buildBwrapInvocation } from "../../src/core/sandbox/bwrap.js";
import { egressResultNote } from "../../src/core/sandbox/egress/bridge.js";
import {
	egressGrants,
	isDeniedEgressAddress,
	redactedUpstreamProxy,
	upstreamProxyProblem,
} from "../../src/core/sandbox/egress/policy.js";
import { createEgressProxy } from "../../src/core/sandbox/egress/proxy.js";
import { EGRESS_UNGRANTED } from "../../src/core/sandbox/egress/setup.js";
import { planHomeReads } from "../../src/core/sandbox/home-reads.js";
import { mainLaunchEgress, mainSandboxPolicy, planMainSandboxSpawn } from "../../src/core/sandbox/main-session.js";
import { buildSeatbeltInvocation } from "../../src/core/sandbox/seatbelt.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import {
	composeWorkerSandboxInvocation,
	configureWorkerProcessSandbox,
	planSandboxedSpawn,
} from "../../src/core/sandbox/worker-process.js";
import { settingsChangeKind } from "../../src/core/settings-change-kind.js";
import { formatControlValue, hasRedactedControlCredentials } from "../../src/core/settings-controls.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { resolveWorkerEnvelope } from "../../src/domains/dispatch/envelope.js";
import { workerSandboxFor } from "../../src/domains/dispatch/worker-spec.js";
import { createTaskWorktree } from "../../src/tools/task-worktree.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

// A scratch PanCode home for the whole file, holding the desktop app's launch token.
const pancodeHome = await isolatePancodeEnv("pancode-worker-sandbox-' ; ");
after(() => pancodeHome.restore());
const appToken = join(pancodeHome.dir, "state", "gui", "background", "server.json");
mkdirSync(join(appToken, ".."), { recursive: true });
writeFileSync(appToken, '{"port":1,"token":"GUI_LAUNCH_TOKEN"}\n', { mode: 0o600 });

function run(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});
}

type EnvelopeInput = Parameters<typeof resolveWorkerEnvelope>[0];

function envelopeOf(tools: ToolName[], overrides: Partial<EnvelopeInput> = {}) {
	return resolveWorkerEnvelope({
		role: "builder",
		capabilityClass: "workspace-edit",
		recipeTools: tools,
		profiledTools: tools,
		denied: new Set(),
		delegates: () => true,
		ledger: false,
		write: { mode: "none", roots: [] },
		runtime: { toolsSupported: true, ownLoop: true, offers: () => true },
		host: { networkStripped: false, shellStripped: false, confinesWrites: false, harnessTools: new Set() },
		skills: { names: [], paths: [], disabled: false, contextAttached: () => false },
		read: { roots: [], outside: [] },
		sandbox: { backend: "bwrap", applies: true, egress: "off", networkOff: false },
		approval: { autonomy: "default", asks: "deny" },
		permitDigest: "",
		...overrides,
	});
}

test("a worker's shell network follows safety.egress.workers, not its web tools (P3)", () => {
	const network = (tools: ToolName[], egress: "off" | "proxied" | "open", networkOff = false) =>
		envelopeOf(tools, { sandbox: { backend: "bwrap", applies: true, egress, networkOff } }).network.shell;
	assert.equal(network([ToolNames.Bash], "off"), false);
	assert.equal(network([ToolNames.Bash, ToolNames.WebFetch], "off"), false);
	assert.equal(network([ToolNames.Bash, ToolNames.WebRead], "off"), false);
	assert.equal(network([ToolNames.Bash], "proxied"), true);
	assert.equal(network([ToolNames.Bash], "open"), true);
	assert.equal(network([ToolNames.Bash], "proxied", true), false);
});

test("every role holds code_nav whatever its recipe lists; a runtime without it withholds nothing unasked (PV-5)", () => {
	const roles = [
		["builder", "workspace-edit"],
		["builder", "artifact-write"],
		["explorer", "read-only"],
		["checker", "verification"],
		["reviewer", "verification"],
		["judge", "read-only"],
		["seat", "read-only"],
	] as const;
	for (const [role, capabilityClass] of roles) {
		const envelope = envelopeOf([ToolNames.Read], { role, capabilityClass });
		assert.ok(envelope.tools.direct.includes(ToolNames.CodeNav), `${role}/${capabilityClass}`);
	}
	const denied = envelopeOf([ToolNames.Read], { denied: new Set([ToolNames.CodeNav]) });
	assert.ok(!denied.tools.direct.includes(ToolNames.CodeNav));
	assert.deepEqual(denied.withheld, [{ capability: ToolNames.CodeNav, reason: "denied" }]);
	// A delegated-tools ceiling without code_nav drops the held tool instead of refusing the recipe (WTF-P F01).
	const ceiling = envelopeOf([ToolNames.Read], { delegates: (tool) => tool === ToolNames.Read });
	assert.deepEqual(ceiling.tools.direct, [ToolNames.Read]);
	assert.deepEqual(ceiling.withheld, []);
	const foreign = envelopeOf([ToolNames.Read], {
		runtime: { toolsSupported: true, ownLoop: false, offers: (tool) => tool === ToolNames.Read },
	});
	assert.deepEqual(foreign.tools.direct, [ToolNames.Read]);
	assert.deepEqual(foreign.withheld, []);
});

test("under bwrap a worker command writes only its writable root and cannot reach the network", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-worker-sandbox-")));
	const root = join(scratch, "worktree");
	const outside = join(scratch, "checkout");
	mkdirSync(root);
	mkdirSync(outside);
	const server = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const policy = (network: boolean): WorkerSandboxSpec => ({
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: "required",
		writableRoots: [root],
		readOnlyPaths: [],
		gitWritablePaths: [],
		// The parent checkout stays visible read-only, as a task worktree's does.
		readableRoots: [outside],
		network,
	});
	const command = {
		argv: [
			"/bin/bash",
			"--noprofile",
			"--norc",
			"-c",
			[
				'echo inside > "$1/inside.txt" && echo wrote-inside',
				'if echo outside > "$2/outside.txt" 2>/dev/null; then echo wrote-outside; fi',
				'if exec 3<>"/dev/tcp/127.0.0.1/$3"; then echo connected; else echo no-network; fi',
			].join("; "),
			"worker-sandbox",
			root,
			outside,
			String(address.port),
		],
	};

	const isolated = composeWorkerSandboxInvocation(policy(false), command, root, availability, []);
	assert.ok(isolated !== null);
	const result = await run(isolated.file, isolated.args);
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /wrote-inside/u);
	assert.doesNotMatch(result.output, /wrote-outside/u);
	assert.match(result.output, /no-network/u);
	assert.equal(existsSync(join(root, "inside.txt")), true);
	assert.equal(existsSync(join(outside, "outside.txt")), false);

	// Control: the same listener is reachable once the run holds a network
	// grant, so the refusal above is the namespace and not a dead port.
	const granted = composeWorkerSandboxInvocation(policy(true), command, root, availability, []);
	assert.ok(granted !== null);
	assert.match((await run(granted.file, granted.args)).output, /connected/u);
});

test("under bwrap a task worktree's worker cannot read the secrets of the checkout that owns it", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const checkout = realpathSync(mkdtempSync(join(tmpdir(), "pancode-worker-checkout-")));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(checkout, "README.md"), "x\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "init");
	const worktree = join(checkout, ".pancode", "worktrees", "run1");
	const sibling = join(checkout, ".pancode", "worktrees", "run2");
	git("worktree", "add", "-q", "-b", "pancode/task/run1", worktree);
	git("worktree", "add", "-q", "-b", "pancode/task/run2", sibling);
	writeFileSync(join(checkout, ".env"), "ROOT_SECRET=checkout\n");
	writeFileSync(join(sibling, ".env"), "SIBLING_SECRET=sibling\n");
	const spec = resolveWorkerSandboxSpec({
		mode: "auto",
		readOnly: false,
		cwd: worktree,
		writeBoundaries: [],
		taskWorktree: { path: worktree, branch: "pancode/task/run1" },
		network: false,
		dependencyRoots: [],
	});
	configureWorkerProcessSandbox(spec);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plan = planSandboxedSpawn(
		{
			argv: [
				"/bin/sh",
				"-c",
				'cat "$@" README.md 2>&1; true',
				"worker-sandbox",
				join(checkout, ".env"),
				join(sibling, ".env"),
			],
		},
		worktree,
	);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const result = await run(plan.file, plan.args);
	assert.match(result.output, /^x$/mu, "the worker still reads its own tree");
	assert.doesNotMatch(result.output, /ROOT_SECRET|SIBLING_SECRET/u, result.output);

	// A bare repository's checkouts are all linked worktrees of `<name>.git`, so the source is found the same way.
	const bare = join(checkout, "..", `${basename(checkout)}-bare.git`);
	const source = `${bare.slice(0, -".git".length)}-main`;
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	execFileSync("git", ["clone", "-q", "--bare", checkout, bare], { stdio: "ignore" });
	execFileSync("git", ["-C", bare, "worktree", "add", "-q", source, "main"], { stdio: "ignore" });
	const bareTask = join(source, ".pancode", "worktrees", "run1");
	execFileSync("git", ["-C", source, "worktree", "add", "-q", "-b", "pancode/task/bare1", bareTask], {
		stdio: "ignore",
	});
	writeFileSync(join(source, ".env"), "BARE_SOURCE_SECRET=source\n");
	configureWorkerProcessSandbox(
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: bareTask,
			writeBoundaries: [],
			taskWorktree: { path: bareTask, branch: "pancode/task/bare1" },
			network: false,
			dependencyRoots: [],
		}),
	);
	const barePlan = planSandboxedSpawn(
		{ argv: ["/bin/sh", "-c", 'cat "$1" README.md 2>&1; true', "worker-sandbox", join(source, ".env")] },
		bareTask,
	);
	assert.equal(barePlan.kind, "sandboxed");
	if (barePlan.kind !== "sandboxed") return;
	const bareResult = await run(barePlan.file, barePlan.args);
	assert.match(bareResult.output, /^x$/mu, "the worker still reads its own tree");
	assert.doesNotMatch(bareResult.output, /BARE_SOURCE_SECRET/u, bareResult.output);
});

test("under bwrap no contained command reads the desktop app's launch token", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pancode-app-token-")));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const command = { argv: ["/bin/sh", "-c", 'cat "$1" 2>&1; true', "worker-sandbox", appToken] };
	configureWorkerProcessSandbox(
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: workspace,
			writeBoundaries: [],
			network: false,
		}),
	);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plans = {
		worker: planSandboxedSpawn(command, workspace),
		main: planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), command, workspace),
	};
	for (const [name, plan] of Object.entries(plans)) {
		assert.equal(plan.kind, "sandboxed", name);
		if (plan.kind !== "sandboxed") continue;
		const result = await run(plan.file, plan.args);
		assert.doesNotMatch(result.output, /GUI_LAUNCH_TOKEN/u, `${name}: ${result.output}`);
	}
});

test("under bwrap a running command cannot read PanCode's credential store after PanCode rewrites it, and still reads settings and recipes", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const config = join(pancodeHome.dir, "config");
	const store = join(config, "credentials.yaml");
	mkdirSync(join(config, "skills", "demo"), { recursive: true });
	writeFileSync(join(config, "skills", "demo", "SKILL.md"), "SKILL_BODY\n");
	mkdirSync(join(config, "agents"), { recursive: true });
	writeFileSync(join(config, "agents", "demo.md"), "AGENT_BODY\n");
	const settings = join(config, "settings.yaml");
	writeFileSync(settings, "# SETTINGS_BEFORE\n");
	writeFileSync(store, "token: STORE_BEFORE\n", { mode: 0o600 });
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pancode-store-rename-")));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const command = {
		argv: [
			"/bin/sh",
			"-c",
			'cat "$1/skills/demo/SKILL.md" "$1/agents/demo.md"; for i in 1 2 3 4 5 6 7 8; do cat "$1/credentials.yaml" "$1/settings.yaml" 2>&1; ls -a "$1"; sleep 0.25; done',
			"worker-sandbox",
			config,
		],
	};
	const plan = planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), command, workspace);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const child = spawn(plan.file, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise((resolve) => child.on("exit", resolve));
	await new Promise((resolve) => setTimeout(resolve, 600));
	// What safeResourceWrite does on a login or an OAuth refresh: a sibling temp file renamed over the store.
	const temp = join(config, ".credentials.yaml.tmp-1-x");
	writeFileSync(temp, "token: STORE_AFTER\n", { mode: 0o600 });
	await new Promise((resolve) => setTimeout(resolve, 300));
	renameSync(temp, store);
	// settings.yaml is bound back from its old inode, so the same rewrite cannot show the new file.
	writeFileSync(join(config, ".settings.yaml.tmp-1-x"), "# SETTINGS_AFTER\n");
	renameSync(join(config, ".settings.yaml.tmp-1-x"), settings);
	await exited;
	assert.match(output, /^SKILL_BODY$/mu, "installed skills stay readable");
	assert.match(output, /^AGENT_BODY$/mu, "user agent recipes stay readable");
	assert.match(output, /^# SETTINGS_BEFORE$/mu, "settings.yaml stays readable when it is not masked");
	assert.doesNotMatch(output, /SETTINGS_AFTER|settings\.yaml\.tmp/u, output);
	assert.doesNotMatch(output, /STORE_BEFORE|STORE_AFTER|credentials\.yaml\.tmp/u, output);
});

test("workerSandboxFor shares task worktree dependencies only when the placed envelope has a sandbox backend", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pancode-worktree-dep-gate-")));
	const externalParent = realpathSync(mkdtempSync(join(tmpdir(), "pancode-worktree-dep-parent-")));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(externalParent, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
	writeFileSync(join(root, "package.json"), '{"name":"dep-gate"}\n');
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	execFileSync("git", ["-C", root, "add", "package.json", ".gitignore"], { stdio: "ignore" });
	execFileSync(
		"git",
		["-C", root, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"],
		{ stdio: "ignore" },
	);
	mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
	const unsandboxedWorktree = createTaskWorktree(root, "unsandboxed", undefined, "merge", externalParent);
	const sandboxedWorktree = createTaskWorktree(root, "sandboxed", undefined, "merge", externalParent);
	const baseEnvelope = (backend: "none" | "bwrap", unconfined?: true) =>
		resolveWorkerEnvelope({
			role: "builder",
			capabilityClass: "builder",
			recipeTools: [ToolNames.Read, ToolNames.Edit, ToolNames.Bash],
			profiledTools: [ToolNames.Read, ToolNames.Edit, ToolNames.Bash],
			denied: new Set(),
			delegates: () => false,
			ledger: false,
			write: { mode: "worktree", roots: [] },
			runtime: { toolsSupported: true, ownLoop: true, offers: () => true },
			host: { networkStripped: false, shellStripped: false, confinesWrites: backend === "bwrap", harnessTools: new Set() },
			skills: { names: [], paths: [], disabled: true, contextAttached: () => false },
			read: { roots: [root], outside: [] },
			sandbox: { backend, applies: true, egress: "off", networkOff: false, ...(unconfined ? { unconfined } : {}) },
			approval: { autonomy: "default", asks: "deny" },
			permitDigest: "test",
		});
	const emptyScope = (path: string) => ({
		source: "inferred" as const,
		workingContextPaths: [path],
		writeBoundaries: [] as string[],
		inferredOnlyPaths: [] as string[],
		parentTokens: [],
		provenance: { version: 1 as const, mode: "inferred" as const, workingContextPaths: [], writeBoundaries: [] },
	});
	const unsandboxed = workerSandboxFor({
		runtimeKind: "http",
		req: {
			agentId: "coder",
			executionRole: "builder",
			task: "edit",
			cwd: unsandboxedWorktree.path,
			taskWorktree: unsandboxedWorktree,
		},
		pathScope: emptyScope(unsandboxedWorktree.path),
		envelope: baseEnvelope("none"),
		settings: undefined,
	});
	assert.equal(existsSync(join(unsandboxedWorktree.path, "node_modules")), false);
	assert.equal(unsandboxed.spec?.backendExpected, undefined);
	assert.equal(
		unsandboxed.spec?.unconfined,
		undefined,
		"no backend without consent seals a worker that refuses commands",
	);
	const consented = baseEnvelope("none", true);
	assert.equal(consented.sandbox.unconfined, true);
	const allowed = workerSandboxFor({
		runtimeKind: "http",
		req: { agentId: "coder", executionRole: "builder", task: "edit", cwd: root },
		pathScope: emptyScope(root),
		envelope: consented,
		settings: undefined,
	});
	assert.equal(allowed.spec?.unconfined, true);

	const sandboxed = workerSandboxFor({
		runtimeKind: "http",
		req: {
			agentId: "coder",
			executionRole: "builder",
			task: "edit",
			cwd: sandboxedWorktree.path,
			taskWorktree: sandboxedWorktree,
		},
		pathScope: emptyScope(sandboxedWorktree.path),
		envelope: baseEnvelope("bwrap"),
		settings: undefined,
	});
	assert.equal(existsSync(join(sandboxedWorktree.path, "node_modules", "dep")), true);
	assert.equal(sandboxed.spec?.backendExpected, true);
	assert.equal(sandboxed.spec?.readableRoots.includes(root), true);
});

/** A fake home with a project, its sibling, a listed tool reached through a link, and a git identity. */
function fakeHome() {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pancode-home-reads-")));
	const home = join(scratch, "home");
	const project = join(home, "src", "project");
	const sibling = join(home, "src", "sibling");
	const tool = join(home, "tools", "bin");
	for (const dir of [project, sibling, tool]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, "notes.txt"), "HOME_NOTE\n");
	writeFileSync(join(sibling, "a.txt"), "SIBLING_FILE\n");
	writeFileSync(join(tool, "t.txt"), "LISTED_FILE\n");
	writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = GIT_IDENTITY\n");
	symlinkSync(tool, join(home, "linked"));
	return { scratch, home, project, sibling, tool };
}

test("under bwrap listed home reads hide the home but for the run's roots and the listed ones", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const { scratch, home, project, tool } = fakeHome();
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const sshDir = join(home, ".ssh");
	mkdirSync(sshDir, { recursive: true });
	writeFileSync(join(sshDir, "id_rsa"), "SSH_PRIVATE_KEY\n");
	const altroot = join(scratch, "altroot");
	mkdirSync(altroot, { recursive: true });
	writeFileSync(join(altroot, "secret.txt"), "ALTROOT_SECRET\n");
	const plan = planHomeReads({
		list: { roots: ["~/linked", "~/.ssh/id_rsa", "~/absent"], toolchains: [] },
		backend: "bwrap",
		admitted: [project],
		cwd: project,
		home,
		wsl: false,
	});
	assert.ok(!(plan instanceof Error), String(plan));
	assert.deepEqual(plan.restriction.links, [{ path: join(home, "linked"), target: tool }]);
	// WSL2's /mnt/wslg/distro shape (hidden strictly under a blanket mask) and a second mount of / (equal path).
	const interop = join(scratch, "wslg");
	mkdirSync(join(interop, "distro"), { recursive: true });
	const invocation = buildBwrapInvocation(
		{
			command: {
				argv: [
					"/bin/bash",
					"--noprofile",
					"--norc",
					"-c",
					[
						`cat ~/notes.txt ~/src/sibling/a.txt ~/.gitconfig ~/.ssh/id_rsa ${join(altroot, "secret.txt")} 2>/dev/null`,
						"ls ~/src",
						"cat ~/linked/t.txt",
						"echo w > written && cat written",
						"touch ~/planted 2>/dev/null || echo home-read-only",
					].join("; "),
				],
			},
			cwd: project,
			writableRoots: [project],
			// Under a hidden directory and outside every shown root, a bind or mask would show its path again.
			readOnlyPaths: [join(project, ".git"), join(home, ".config")],
			network: false,
			maskedPaths: [
				{ path: join(home, ".gitconfig"), kind: "file" },
				{ path: sshDir, kind: "directory" },
				{ path: interop, kind: "directory" },
				{ path: altroot, kind: "directory" },
			],
			readRestriction: {
				...plan.restriction,
				hidden: [...plan.restriction.hidden, join(interop, "distro"), altroot],
			},
			setEnv: { HOME: home },
		},
		availability.executable ?? "bwrap",
	);
	const args = invocation.args;
	assert.ok(args.indexOf(home) < args.indexOf("--bind-try"), "the home is hidden before any later bind");
	assert.equal(args.lastIndexOf("--remount-ro") > args.lastIndexOf("--bind-try"), true);
	assert.equal(args.includes(join(home, ".config")), false);
	assert.equal(args.includes(join(project, ".git")), true);
	assert.equal(args.includes("/dev/null"), false);
	const result = await run(invocation.file, args);
	assert.equal(result.code, 0, result.output);
	assert.doesNotMatch(result.output, /HOME_NOTE|SIBLING_FILE|GIT_IDENTITY|SSH_PRIVATE_KEY|ALTROOT_SECRET|sibling/u);
	assert.match(result.output, /^project$/mu);
	assert.match(result.output, /LISTED_FILE/u);
	assert.match(result.output, /^w$/mu);
	assert.match(result.output, /home-read-only/u);
	assert.equal(existsSync(join(home, "planted")), false);
});

test("listed home reads refuse a plan that would show a hidden tree or run outside every shown root", (t) => {
	const { scratch, home, project, sibling, tool } = fakeHome();
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	symlinkSync(scratch, join(home, "up"));
	const plan = (input: Partial<Parameters<typeof planHomeReads>[0]>) =>
		planHomeReads({
			list: { roots: [], toolchains: [] },
			backend: "bwrap",
			admitted: [project],
			cwd: project,
			home,
			wsl: false,
			...input,
		});
	assert.ok(!(plan({}) instanceof Error));
	assert.match(String(plan({ admitted: [scratch] })), /holds .*home/u);
	assert.match(String(plan({ list: { roots: ["~"], toolchains: [] } })), /home directory/u);
	assert.match(String(plan({ list: { roots: ["~/up"], toolchains: [] } })), /resolves to .* which holds/u);
	assert.match(String(plan({ cwd: sibling })), /working directory/u);
	assert.match(String(plan({ cwd: home })), /working directory .* holds/u);
	assert.match(String(plan({ cwd: scratch })), /working directory .* holds/u);
	assert.match(String(plan({ home: join(scratch, "missing-home") })), /home directory/u);
	assert.match(String(plan({ wsl: true, mountinfo: join(scratch, "no-mountinfo") })), /mount table|no-mountinfo/u);
	// Seatbelt grants traversal metadata for nested listed symlink ancestors.
	const seatbelt = buildSeatbeltInvocation({
		command: { argv: ["/bin/true"] },
		cwd: project,
		writableRoots: [project],
		network: false,
		maskedPaths: [],
		readRestriction: {
			hidden: [home],
			exposed: [project, tool],
			links: [{ path: join(home, "nested", "link"), target: tool }],
		},
	});
	assert.ok(seatbelt.args.some((arg) => arg.endsWith(`=${join(home, "nested")}`)));
});

test("safety.homeReads validates its roots, keeps roots user-only and lets a project only hide more", (t) => {
	const workspace = mkdtempSync(join(pancodeHome.dir, "workspace-"));
	mkdirSync(join(workspace, ".pancode"), { recursive: true });
	mkdirSync(join(pancodeHome.dir, "config"), { recursive: true });
	const userFile = join(pancodeHome.dir, "config", "settings.yaml");
	t.after(() => rmSync(userFile, { force: true }));
	writeFileSync(userFile, "version: 2\n");
	assert.deepEqual(readSettings().safety.homeReads, { main: "open", workers: "open", roots: [], toolchains: [] });
	writeFileSync(
		userFile,
		"version: 2\nsafety:\n  homeReads:\n    workers: listed\n    roots: [~/src/app, /opt/data]\n    toolchains: [nvm, uv]\n",
	);
	assert.deepEqual(readSettings().safety.homeReads, {
		main: "open",
		workers: "listed",
		roots: ["~/src/app", "/opt/data"],
		toolchains: ["nvm", "uv"],
	});
	for (const bad of ["roots: [src/app]", "roots: ['~']", "roots: [/]", "toolchains: [brew]"]) {
		writeFileSync(userFile, `version: 2\nsafety:\n  homeReads:\n    ${bad}\n`);
		assert.throws(() => readSettings(), /safety\.homeReads\.(roots|toolchains)/u, bad);
	}

	writeFileSync(userFile, "version: 2\n");
	writeFileSync(
		join(workspace, ".pancode", "settings.local.yaml"),
		"safety:\n  homeReads:\n    main: listed\n    workers: open\n    roots: [~/.ssh]\n    toolchains: [nvm]\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	assert.ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	assert.deepEqual(layered.settings.safety.homeReads, { main: "listed", workers: "open", roots: [], toolchains: [] });
	for (const path of ["safety.homeReads.roots", "safety.homeReads.toolchains"])
		assert.match(layered.issues.find((issue) => issue.path === path)?.message ?? "", /user settings/u, path);
	// A non-map project value (such as null) must not reset the operator's listed mode back to open.
	writeFileSync(userFile, "version: 2\nsafety:\n  homeReads:\n    main: listed\n    workers: listed\n");
	writeFileSync(join(workspace, ".pancode", "settings.local.yaml"), "safety:\n  homeReads: null\n");
	const nullSnapshot = captureProjectSurface(workspace, "settings");
	assert.ok(nullSnapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", nullSnapshot.contentHash);
	const layeredNull = readLayeredSettings(workspace);
	assert.deepEqual(layeredNull.settings.safety.homeReads, {
		main: "listed",
		workers: "listed",
		roots: [],
		toolchains: [],
	});
	assert.match(layeredNull.issues.find((issue) => issue.path === "safety.homeReads")?.message ?? "", /ignored/u);
	assert.equal(settingsChangeKind("safety.homeReads.main"), "nextTurn");
	const spec = resolveWorkerSandboxSpec({
		mode: "auto",
		readOnly: false,
		cwd: workspace,
		writeBoundaries: [],
		network: false,
		homeReads: { roots: ["~/src/app"], toolchains: ["nvm"] },
	});
	assert.deepEqual(spec?.homeReads, { roots: ["~/src/app"], toolchains: ["nvm"] });
});

/** Sends a CONNECT for `authority` through the proxy listening on `port` and returns the status line's code. */
function proxyConnect(port: number, authority: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () =>
			socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
		);
		let head = "";
		socket.on("data", (chunk: Buffer) => {
			head += chunk.toString("latin1");
			const match = /^HTTP\/1\.1 (\d{3})/u.exec(head);
			if (match === null) return;
			socket.destroy();
			resolve(Number(match[1]));
		});
		socket.on("error", reject);
	});
}

async function servedEgressProxy(options: Parameters<typeof createEgressProxy>[0]) {
	const proxy = createEgressProxy(options);
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const { port } = listener.address() as AddressInfo;
	proxy.serve(listener);
	return { proxy, port };
}

test("the egress proxy checks names before any lookup, screens every answer and asks once per origin (P3)", async (t) => {
	const target = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	t.after(() => target.close());
	const targetPort = (target.address() as AddressInfo).port;
	const looked: string[] = [];
	const dialed: string[] = [];
	const asked: string[] = [];
	const answers: Record<string, string[]> = {
		"svc.test": ["8.8.8.8"],
		"rebind.test": ["8.8.4.4", "10.0.0.1"],
		"asked.test": ["8.8.8.8"],
	};
	const { proxy, port } = await servedEgressProxy({
		grants: egressGrants(["svc.test:443", "rebind.test:443", `127.0.0.1:${targetPort}`], []),
		denyHint: "add it to safety.egress.main.allow",
		lookup: async (host) => {
			looked.push(host);
			return (answers[host] ?? []).map((address) => ({ address, family: 4 }));
		},
		dial: (address, dialPort) => {
			dialed.push(`${address}:${dialPort}`);
			return connect(targetPort, "127.0.0.1");
		},
		ask: async (origin) => {
			asked.push(`${origin.host}:${origin.port}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
			return origin.host === "asked.test";
		},
	});
	t.after(() => proxy.close());

	assert.equal(await proxyConnect(port, "svc.test:443"), 200);
	assert.deepEqual(dialed, ["8.8.8.8:443"]);
	// An origin outside the grants is asked about and, refused, never resolved.
	assert.equal(await proxyConnect(port, "nope.test:443"), 403);
	assert.equal(looked.includes("nope.test"), false);
	// One internal answer refuses the name, whichever answer a later dial would pick.
	assert.equal(await proxyConnect(port, "rebind.test:443"), 403);
	// Concurrent connections to one origin share one ask.
	assert.deepEqual(
		await Promise.all([proxyConnect(port, "asked.test:443"), proxyConnect(port, "asked.test:443")]),
		[200, 200],
	);
	assert.equal(asked.filter((origin) => origin === "asked.test:443").length, 1);
	// A private literal is refused unasked; an explicit grant of one reaches it.
	assert.equal(await proxyConnect(port, "10.1.2.3:80"), 403);
	assert.equal(asked.includes("10.1.2.3:80"), false);
	assert.equal(await proxyConnect(port, `127.0.0.1:${targetPort}`), 200);

	const refused = Object.fromEntries(
		proxy
			.receipts()
			.filter((receipt) => receipt.decision === "denied")
			.map((receipt) => [`${receipt.host}:${receipt.port}`, receipt.reason]),
	);
	assert.equal(refused["nope.test:443"], EGRESS_UNGRANTED);
	assert.match(refused["rebind.test:443"] ?? "", /resolves to 10\.0\.0\.1, a local or private address/u);
	assert.match(refused["10.1.2.3:80"] ?? "", /local or private address/u);
	const note = egressResultNote({
		receipts: proxy.receipts(),
		listeningPorts: [],
		setupFailed: false,
		denyHint: "add it to safety.egress.main.allow",
	});
	assert.match(
		note ?? "",
		/refused nope\.test:443 \(not in this shell's egress grants; add it to safety\.egress\.main\.allow\)/u,
	);
	assert.equal(
		egressResultNote({
			receipts: [{ host: "svc.test", port: 443, decision: "allowed", count: 1 }],
			listeningPorts: [],
			setupFailed: false,
			denyHint: "",
		}),
		null,
	);
});

test("allowed egress leaves through safety.egress.upstreamProxy by name with its credentials, which no surface shows (P3)", async (t) => {
	const requests: string[] = [];
	const upstream = createServer((socket) => {
		socket.once("data", (chunk: Buffer) => {
			requests.push(chunk.toString("latin1"));
			socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	t.after(() => upstream.close());
	const upstreamUrl = `http://ops:s3cr%20t@127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	assert.equal(upstreamProxyProblem(upstreamUrl), null);
	assert.notEqual(upstreamProxyProblem("socks5://127.0.0.1:1080"), null);
	assert.equal(redactedUpstreamProxy(upstreamUrl).includes("s3cr"), false);
	const { proxy, port } = await servedEgressProxy({
		grants: egressGrants(["internal.corp.test:443"], []),
		upstreamProxy: upstreamUrl,
		lookup: async () => [],
	});
	t.after(() => proxy.close());
	assert.equal(await proxyConnect(port, "internal.corp.test:443"), 200);
	assert.match(requests[0] ?? "", /^CONNECT internal\.corp\.test:443 HTTP\/1\.1\r\n/u);
	assert.match(
		requests[0] ?? "",
		new RegExp(`Proxy-Authorization: Basic ${Buffer.from("ops:s3cr t").toString("base64")}`, "u"),
	);
	// The upstream proxy carries only what the grants admit.
	assert.equal(await proxyConnect(port, "elsewhere.test:443"), 403);
	assert.equal(requests.length, 1);
});

test("under bwrap a proxied command reaches only its grants through the bridge and its own servers stay inside (P3)", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap" || sandboxNetworkIsolation(availability) !== null) {
		t.skip("bubblewrap with network isolation is not available");
		return;
	}
	if (spawnSync("curl", ["--version"]).status !== 0) {
		t.skip("curl is not installed");
		return;
	}
	const host = createHttpServer((_request, response) => response.end("granted-body"));
	await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
	t.after(() => host.close());
	const hostPort = (host.address() as AddressInfo).port;
	const workspace = mkdtempSync(join(tmpdir(), "pancode-egress-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const policy = {
		...mainSandboxPolicy({ workspace, scratchRoots: [] }),
		egress: { grants: egressGrants([`127.0.0.1:${hostPort}`], []), denyHint: "add it to safety.egress.main.allow" },
	};
	const node = JSON.stringify(process.execPath);
	const result = await runBashCommand(
		[
			// Loopback inside the sandbox is the sandbox's own: a direct dial finds nothing, and no proxy setting bypasses it.
			`curl -sS -m 5 --noproxy '*' http://127.0.0.1:${hostPort}/ >/dev/null 2>&1 && echo direct-reached || echo direct-blocked`,
			`curl -sS -m 5 --noproxy '' http://127.0.0.1:${hostPort}/; echo`,
			`curl -sS -m 5 --noproxy '' -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${hostPort + 1}/`,
			`${node} -e "require('http').createServer((q, s) => s.end('own-body')).listen(4555, '127.0.0.1')" & sleep 1.5`,
			// The sandbox's own server answers on its loopback directly; the proxy env bypasses only loopback.
			"curl -sS -m 5 http://localhost:4555/; echo",
		].join("\n"),
		{ cwd: workspace, timeoutMs: 60_000, shellSandbox: policy },
	);
	assert.match(result.stdout, /direct-blocked/u);
	assert.match(result.stdout, /granted-body/u);
	assert.match(result.stdout, /\n403\n/u);
	assert.match(result.stdout, /own-body/u);
	assert.equal(result.egress?.setupFailed, false);
	assert.deepEqual(result.egress?.listeningPorts, [4555]);
	const note = egressResultNote(result.egress) ?? "";
	assert.match(note, /refused 127\.0\.0\.1:\d+ \(a local or private address/u);
	assert.match(note, /listening on port 4555 inside the sandbox/u);
});

test("safety.egress is user-set, a project may only lower a mode, and the launch follows the backend (P3)", () => {
	const userFile = join(pancodeHome.dir, "config", "settings.yaml");
	const workspace = join(pancodeHome.dir, "egress-workspace");
	mkdirSync(join(workspace, ".pancode"), { recursive: true });
	mkdirSync(join(pancodeHome.dir, "config"), { recursive: true });
	try {
		writeFileSync(userFile, "version: 2\n");
		const defaults = readSettings().safety.egress;
		assert.equal(defaults.main.mode, "proxied");
		assert.equal(defaults.workers.mode, "off");
		assert.equal(defaults.upstreamProxy, null);
		writeFileSync(userFile, "version: 2\nsafety:\n  sandboxNetwork: true\n");
		assert.throws(() => readSettings(), /safety\.sandboxNetwork/u);
		writeFileSync(userFile, "version: 2\nsafety:\n  egress:\n    main:\n      allow: ['*.example.com']\n");
		assert.throws(() => readSettings(), /safety\.egress\.main\.allow/u);
		writeFileSync(userFile, "version: 2\nsafety:\n  egress:\n    upstreamProxy: socks5://127.0.0.1:1080\n");
		assert.throws(() => readSettings(), /safety\.egress\.upstreamProxy/u);

		writeFileSync(userFile, "version: 2\nsafety:\n  egress:\n    workers:\n      mode: proxied\n");
		writeFileSync(
			join(workspace, ".pancode", "settings.local.yaml"),
			"safety:\n  egress:\n    main:\n      mode: off\n    workers:\n      mode: open\n      allow: ['evil.test:443']\n    upstreamProxy: http://evil.test:8080\n",
		);
		const snapshot = captureProjectSurface(workspace, "settings");
		if (!snapshot.contentHash) throw new Error("missing project settings hash");
		recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
		const layered = readLayeredSettings(workspace);
		assert.equal(layered.settings.safety.egress.main.mode, "off");
		assert.equal(layered.settings.safety.egress.workers.mode, "proxied");
		assert.deepEqual(layered.settings.safety.egress.workers.allow, []);
		assert.equal(layered.settings.safety.egress.upstreamProxy, null);
		const paths = layered.issues.map((issue) => issue.path);
		for (const path of ["safety.egress.workers.mode", "safety.egress.workers.allow", "safety.egress.upstreamProxy"])
			assert.ok(paths.includes(path), path);
	} finally {
		writeFileSync(userFile, "version: 2\n");
		rmSync(workspace, { recursive: true, force: true });
	}

	// A proxied caller with no bridge to serve it runs with the network off, never open; seatbelt has no bridge yet.
	const proxied = { network: true, egress: { grants: egressGrants([], []), denyHint: "" } };
	assert.equal(mainLaunchEgress(proxied, "bwrap", true), "proxied");
	assert.equal(mainLaunchEgress(proxied, "bwrap", false), "off");
	assert.equal(mainLaunchEgress(proxied, "seatbelt", true), "open");
	assert.equal(mainLaunchEgress({ network: true }, "bwrap", true), "open");
	assert.equal(mainLaunchEgress({ network: false, egress: proxied.egress }, "bwrap", true), "off");
});

test("egress proxy refuses mismatched Host headers, screens IPv4-translated IPv6, and redacts upstreamProxy control values (P3)", async (t) => {
	assert.equal(isDeniedEgressAddress("::ffff:0:169.254.169.254"), true);
	assert.equal(isDeniedEgressAddress("::ffff:0:127.0.0.1"), true);
	const secretProxy = "http://user:s3cr3t@proxy.corp.test:3128";
	assert.equal(formatControlValue(secretProxy, "safety.egress.upstreamProxy"), "http://***@proxy.corp.test:3128");
	assert.equal(hasRedactedControlCredentials("safety.egress.upstreamProxy", secretProxy), true);
	assert.equal(hasRedactedControlCredentials("safety.egress.upstreamProxy", "http://proxy.corp.test:3128"), false);

	const target = createHttpServer((req, res) => res.end(`host=${req.headers.host}`));
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	t.after(() => target.close());
	const targetPort = (target.address() as AddressInfo).port;
	let asked = 0;
	const proxy = createEgressProxy({
		grants: egressGrants([`allowed.test:${targetPort}`], []),
		ask: async () => {
			asked += 1;
			return false;
		},
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		dial: () => connect({ host: "127.0.0.1", port: targetPort }),
	});
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	proxy.serve(listener);
	t.after(() => proxy.close());
	const proxyPort = (listener.address() as AddressInfo).port;
	const send = (raw: string): Promise<string> =>
		new Promise((resolve, reject) => {
			const sock = connect({ host: "127.0.0.1", port: proxyPort });
			const chunks: Buffer[] = [];
			sock.on("connect", () => sock.write(raw));
			sock.on("data", (c) => chunks.push(c));
			sock.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
			sock.on("error", reject);
		});

	assert.match(
		await send(
			`GET http://allowed.test:${targetPort}/ HTTP/1.1\r\nHost: evil.test:${targetPort}\r\nConnection: close\r\n\r\n`,
		),
		/^HTTP\/1\.1 400 /u,
	);
	assert.match(
		await send(`CONNECT allowed.test:${targetPort} HTTP/1.1\r\nHost: evil.test:${targetPort}\r\n\r\n`),
		/^HTTP\/1\.1 400 /u,
	);
	assert.match(
		await send("CONNECT [::ffff:0:169.254.169.254]:80 HTTP/1.1\r\nHost: [::ffff:0:169.254.169.254]:80\r\n\r\n"),
		/^HTTP\/1\.1 403 /u,
	);
	assert.equal(asked, 0);
	assert.match(
		await send(
			`GET http://allowed.test:${targetPort}/ HTTP/1.1\r\nHost: allowed.test:${targetPort}\r\nConnection: close\r\n\r\n`,
		),
		new RegExp(`host=allowed\\.test:${targetPort}`, "u"),
	);
});

test("adoptProbedSandboxBackend only accepts this host's trusted bwrap and configureWorkerProcessSandbox requires backendExpected", (t) => {
	const availability = sandboxAvailability();
	if (process.platform !== "linux") {
		t.skip("bwrap adoption check is Linux-specific");
		return;
	}
	const probe = (script: string) => {
		const res = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
			cwd: process.cwd(),
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
	};
	const nonBwrap = probe(`
		import { adoptProbedSandboxBackend, probedSandboxAvailability } from "./src/core/sandbox/availability.js";
		const spoofed = adoptProbedSandboxBackend({ backend: "bwrap", executable: "/usr/bin/true", networkIsolation: true });
		const missing = adoptProbedSandboxBackend({ backend: "bwrap", executable: "/nonexistent/bwrap" });
		console.log(JSON.stringify({ spoofed, missing, cached: probedSandboxAvailability() }));
	`);
	assert.deepEqual(nonBwrap, { spoofed: false, missing: false, cached: null });
	if (availability.available && availability.backend === "bwrap" && availability.executable !== null) {
		const exe = JSON.stringify(availability.executable);
		const gated = probe(`
			import { probedSandboxAvailability } from "./src/core/sandbox/availability.js";
			import { configureWorkerProcessSandbox } from "./src/core/sandbox/worker-process.js";
			const base = {
				version: 1,
				mode: "auto",
				writableRoots: ["/tmp"],
				readOnlyPaths: [],
				gitWritablePaths: [],
				readableRoots: [],
				network: false,
				probedBackend: { backend: "bwrap", executable: ${exe}, networkIsolation: true },
			};
			configureWorkerProcessSandbox(base);
			const withoutExpected = probedSandboxAvailability();
			configureWorkerProcessSandbox({ ...base, backendExpected: true });
			const withExpected = probedSandboxAvailability();
			console.log(JSON.stringify({ withoutExpected, withExpected }));
		`);
		assert.equal(gated.withoutExpected, null);
		assert.equal((gated.withExpected as { executable?: string } | null)?.executable, availability.executable);
	}
});
