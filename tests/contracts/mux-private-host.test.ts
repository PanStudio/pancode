// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, equal, match, notEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { panesFindings, panesModeFinding } from "../../src/cli/doctor-panes.js";
import { workspaceEligibility, workspaceExitNotice } from "../../src/cli/workspace-launch.js";
import { sha256Hex } from "../../src/core/hash.js";
import { processBirthToken } from "../../src/core/process-identity.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	renderWorkspaceConfig,
	rerenderWorkspaceConfig,
	writeWorkspaceConfig,
} from "../../src/domains/mux/workspace/config.js";
import {
	captureFailureForLauncher,
	exitMarkerPath,
	hostedInWorkspace,
	markWorkspaceExit,
	pancodeHostSessionOf,
	readWorkspaceExitResult,
	workspaceSessionFor,
} from "../../src/domains/mux/workspace/exit-marker.js";
import { holdExitSummaryForLauncher } from "../../src/domains/mux/workspace/exit-summary-handoff.js";
import { launchWorkspace } from "../../src/domains/mux/workspace/launch.js";
import {
	createPosixHostPlatform,
	noRuntimeDirMessage,
	posixRuntimeDirCandidates,
	posixRuntimeDirPlan,
	renderPosixShellShim,
} from "../../src/domains/mux/workspace/platform-posix.js";
import { installPinnedTool, mirroredSources } from "../../src/domains/toolchain/install.js";
import { findPinnedTool } from "../../src/domains/toolchain/registry.js";

const SESSION = "pancode-0123456789ab";
/** The hashed name the short fallbacks carry: the uid and PanCode's state root. */
const short = (uid: number, state = "") => createHash("sha256").update(`${uid}\0${state}`).digest("hex").slice(0, 8);
const shell = { defaultShell: "/state/mux/0123456789ab/pane-shell", shellMode: "non_login" } as const;

describe("private pane host layout (POSIX)", () => {
	it("prefers the runtime dir and falls back to /tmp when the socket path would be too long", () => {
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" }, SESSION, "linux", 1000), [
			"/run/user/1000/pancode",
			`/tmp/pancode-1000-${short(1000)}`,
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: "/var/folders/x/T/" }, SESSION, "darwin", 501), [
			"/var/folders/x/T/pancode",
			`/var/folders/x/T/c-${short(501)}`,
			`/tmp/pancode-501-${short(501)}`,
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: `/${"d".repeat(90)}` }, SESSION, "linux", 7), [
			"/run/user/7/pancode",
			`/tmp/pancode-7-${short(7)}`,
		]);
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "relative" }, SESSION, "linux", 7), [
			"/run/user/7/pancode",
			`/tmp/pancode-7-${short(7)}`,
		]);
	});

	it("tries the operator's TMPDIR before the system temp root when XDG_RUNTIME_DIR is unusable", () => {
		const systemRoot = posixRuntimeDirCandidates({}, SESSION, "linux", 7);
		const longXdg = `/${"d".repeat(90)}`;
		const tmpTail = ["/run/user/7/pancode", `/home/me/t/c-${short(7)}`, `/tmp/pancode-7-${short(7)}`];
		deepStrictEqual(posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: longXdg, TMPDIR: "/home/me/t" }, SESSION, "linux", 7), [
			"/home/me/t/pancode-7",
			...tmpTail,
		]);
		// A runtime dir that fits but cannot be made private falls through to TMPDIR, not straight to the system root.
		deepStrictEqual(
			posixRuntimeDirCandidates({ XDG_RUNTIME_DIR: "/run/user/7", TMPDIR: "/home/me/t" }, SESSION, "linux", 7),
			["/run/user/7/pancode", "/home/me/t/pancode-7", ...tmpTail.slice(1)],
		);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: `/${"t".repeat(60)}` }, SESSION, "linux", 7), systemRoot);
		deepStrictEqual(posixRuntimeDirCandidates({ TMPDIR: "relative" }, SESSION, "linux", 7), systemRoot);
	});

	it("names each runtime dir skipped as too long, its length, the limit and the variable to shorten", () => {
		const xdg = `/${"d".repeat(60)}`;
		const tmp = `/${"t".repeat(60)}/`;
		const plan = posixRuntimeDirPlan({ XDG_RUNTIME_DIR: xdg, TMPDIR: tmp }, SESSION, "linux", 7, {
			state: `/${"s".repeat(70)}`,
		});
		deepStrictEqual(plan.candidates, ["/run/user/7/pancode", `/tmp/pancode-7-${short(7, `/${"s".repeat(70)}`)}`]);
		const message = noRuntimeDirMessage(
			["EROFS: read-only file system, mkdir '/tmp/pancode-7/x'"],
			plan.tooLong,
			"linux",
		);
		ok(message.includes("(EROFS: read-only file system"), message);
		ok(message.includes(`${xdg}/pancode/${SESSION}-client.sock is 102 bytes`), message);
		ok(message.includes(`/${"t".repeat(60)}/pancode-7/${SESSION}-client.sock is 104 bytes`), message);
		ok(message.includes(`/mux/run/${SESSION}-client.sock is 112 bytes`), message);
		ok(message.includes("limit 100 bytes"), message);
		ok(message.endsWith("set a shorter XDG_RUNTIME_DIR of at most 59 bytes or TMPDIR of at most 57 bytes"), message);
		// The advised lengths are exactly the ones that fit.
		deepStrictEqual(
			posixRuntimeDirCandidates(
				{ XDG_RUNTIME_DIR: `/${"d".repeat(58)}`, TMPDIR: `/${"t".repeat(56)}` },
				SESSION,
				"linux",
				7,
			),
			[`/${"d".repeat(58)}/pancode`, `/${"t".repeat(56)}/pancode-7`, "/run/user/7/pancode", `/tmp/pancode-7-${short(7)}`],
		);
		equal(noRuntimeDirMessage(["EACCES"], [], "linux"), "no usable runtime directory for the pane host (EACCES)");
	});

	it("falls back to short hashed dirs before failing when every preferred dir is too long", () => {
		// 55 bytes: too long for `pancode-1000` beside the client socket, short enough for `c-<hash>`.
		const tmp = `/${"t".repeat(54)}`;
		const state = `/${"s".repeat(70)}`;
		const plan = posixRuntimeDirPlan({ XDG_RUNTIME_DIR: `/${"d".repeat(60)}`, TMPDIR: tmp }, SESSION, "linux", 1000, {
			state,
		});
		deepStrictEqual(plan.candidates, [
			"/run/user/1000/pancode",
			`${tmp}/c-${short(1000, state)}`,
			`/tmp/pancode-1000-${short(1000, state)}`,
		]);
		equal(Buffer.byteLength(`${tmp}/c-${short(1000, state)}/${SESSION}-client.sock`), 99);
		equal(plan.tooLong.length, 3);
		// Each PanCode home gets its own /tmp directory, and so does each user.
		notEqual(short(1000, state), short(1000, "/other"));
		notEqual(short(1000, state), short(1001, state));
	});

	it("lays the socket out in TMPDIR when the runtime dir is too long for one", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "h"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const tmp = tmpdir();
		const candidates = posixRuntimeDirCandidates({ TMPDIR: tmp }, SESSION, "linux", process.getuid?.() ?? 0);
		// The harness tmp root may itself be too long for a socket; then only the fallback case applies.
		if (candidates[0] !== join(tmp, `pancode-${process.getuid?.() ?? 0}`)) {
			t.skip("tmp root too long for a socket path");
			return;
		}
		const layout = platform.hostLayout({
			session: SESSION,
			env: { XDG_RUNTIME_DIR: `/${"d".repeat(90)}`, TMPDIR: tmp },
		});
		equal(layout.socketPath, join(candidates[0], `${SESSION}.sock`));
		equal(statSync(candidates[0]).mode & 0o777, 0o700);
	});

	it("falls back to PanCode's state root when the runtime dir exists but cannot be written", (t) => {
		const uid = process.getuid?.() ?? 0;
		if (uid === 0) {
			t.skip("root ignores directory permissions");
			return;
		}
		const scratch = mkdtempSync(join(tmpdir(), "h"));
		const session = "pancode-c";
		const fenced = join(scratch, "run");
		mkdirSync(join(fenced, "pancode"), { recursive: true, mode: 0o700 });
		chmodSync(join(fenced, "pancode"), 0o500);
		t.after(() => {
			chmodSync(join(fenced, "pancode"), 0o700);
			rmSync(scratch, { recursive: true, force: true });
		});
		const state = join(scratch, "s");
		// The harness tmp root may be long enough that a PanCode root cannot hold the socket; apply the same budget.
		const fits = (dir: string) => Buffer.byteLength(join(dir, `${session}-client.sock`)) <= 100;
		const stateRun = join(state, "mux", "run");
		deepStrictEqual(posixRuntimeDirCandidates({}, session, "linux", uid, { state, cache: join(scratch, "c") }), [
			...[stateRun, join(scratch, "c", "run")].filter(fits),
			`/run/user/${uid}/pancode`,
			`/tmp/pancode-${uid}-${short(uid, state)}`,
		]);
		if (!fits(stateRun)) {
			t.skip("tmp root too long for a socket under the state root");
			return;
		}
		const layout = createPosixHostPlatform({ platform: "linux", stateDir: () => state }).hostLayout({
			session,
			env: { XDG_RUNTIME_DIR: fenced },
		});
		equal(layout.socketPath, join(stateRun, `${session}.sock`));
		equal(statSync(join(stateRun, "c")).mode & 0o777, 0o700);
	});

	it("drops a PanCode root whose socket path would be too long", () => {
		const session = "pancode-c";
		// "/mux/run/pancode-c-client.sock" is 30 bytes, so a 70-byte state root lands exactly on the 100-byte budget.
		const fitting = `/${"s".repeat(69)}`;
		const tooLong = `${fitting}x`;
		deepStrictEqual(posixRuntimeDirCandidates({}, session, "linux", 7, { state: fitting, cache: "/c" }), [
			join(fitting, "mux", "run"),
			"/c/run",
			"/run/user/7/pancode",
			`/tmp/pancode-7-${short(7, fitting)}`,
		]);
		deepStrictEqual(posixRuntimeDirCandidates({}, session, "linux", 7, { state: tooLong, cache: "/c" }), [
			"/c/run",
			"/run/user/7/pancode",
			`/tmp/pancode-7-${short(7, tooLong)}`,
		]);
	});

	it("lays out a private root, socket and shim, and hands the operator's XDG roots to the shim", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-private-host-"));
		// A short fixture session keeps Unix sockets inside the harness root.
		const session = "pancode-a";
		const runtime = tmpdir();
		t.after(() => {
			rmSync(scratch, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const layout = platform.hostLayout({
			session,
			env: { XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: "/home/me/.cfg" },
		});
		const root = join(scratch, "state", "mux", "a");
		equal(layout.socketPath, join(runtime, "pancode", `${session}.sock`));
		equal(statSync(join(runtime, "pancode")).mode & 0o777, 0o700);
		equal(layout.configPath, join(root, "config", "herdr", "config.toml"));
		deepStrictEqual(layout.hostEnv, {
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			HERDR_SOCKET_PATH: layout.socketPath,
			PANCODE_PANE_XDG_CONFIG_HOME: "/home/me/.cfg",
		});
		deepStrictEqual(layout.shell, { defaultShell: join(root, "pane-shell"), shellMode: "non_login" });
		deepStrictEqual(layout.disposableDirs, [root, join(runtime, "pancode", "a")]);
		equal(layout.sessionFile, join(root, "config", "herdr", "session.json"));
		equal(layout.cleanupArgs, null);
		deepStrictEqual(layout.herdrArgs, []);
		equal(statSync(join(root, "pane-shell")).mode & 0o777, 0o755);
	});

	it("keeps one socket per root while it is live, whatever runtime dir a later launch sees", async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-private-host-"));
		const session = "pancode-b";
		const first = tmpdir();
		const second = join(first, "r");
		mkdirSync(second);
		const server = createServer();
		t.after(() => {
			server.close();
			for (const dir of [scratch, second]) rmSync(dir, { recursive: true, force: true });
		});
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const live = platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: first } }).socketPath;
		await new Promise<void>((resolve) => server.listen(live, resolve));
		equal(platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: second } }).socketPath, live);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		equal(
			platform.hostLayout({ session, env: { XDG_RUNTIME_DIR: second } }).socketPath,
			join(second, "pancode", `${session}.sock`),
		);
	});

	it("the shim restores set XDG roots, unsets unset ones, and execs the operator's shell", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-shim-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const shim = join(scratch, "pane-shell");
		const fake = join(scratch, "fake-shell");
		writeFileSync(shim, renderPosixShellShim("linux"), { mode: 0o755 });
		writeFileSync(
			fake,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
			'#!/bin/sh\necho "cfg=${XDG_CONFIG_HOME-unset} state=${XDG_STATE_HOME-unset} saved=${PANCODE_PANE_XDG_CONFIG_HOME-unset} args=$*"\n',
			{ mode: 0o755 },
		);
		const run = spawnSync("/bin/sh", [shim], {
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				SHELL: fake,
				XDG_CONFIG_HOME: "/private/config",
				XDG_STATE_HOME: "/private/state",
				PANCODE_PANE_XDG_CONFIG_HOME: "/home/me/.cfg",
			},
		});
		equal(run.stdout.trim(), "cfg=/home/me/.cfg state=unset saved=unset args=");
		match(renderPosixShellShim("darwin"), /bash\|zsh[^)]*\) exec "\$shell" -l ;;/u);
		ok(!/exec "\$shell" -l/u.test(renderPosixShellShim("linux")));
	});

	it("preserves the operator's runtime directory or its absence in user shells and inner PanCode", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-runtime-env-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const fake = join(scratch, "fake-shell");
		const preload = join(scratch, "runtime.mjs");
		writeFileSync(
			fake,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
			'#!/bin/sh\nprintf "pane-runtime=%s\\n" "${XDG_RUNTIME_DIR-unset}"\nexec /bin/sh\n',
			{ mode: 0o755 },
		);
		writeFileSync(preload, 'console.log("pancode-runtime=" + (process.env.XDG_RUNTIME_DIR ?? "unset"));\n');
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		for (const runtime of [tmpdir(), undefined]) {
			const env: NodeJS.ProcessEnv = { HOME: scratch, PATH: "/usr/bin:/bin", SHELL: fake, TMPDIR: tmpdir() };
			if (runtime !== undefined) env.XDG_RUNTIME_DIR = runtime;
			const layout = platform.hostLayout({ session: "r", env });
			ok(layout.shell.defaultShell);
			const command = platform.paneLaunch([
				process.execPath,
				"--import",
				"tsx",
				"--import",
				preload,
				"src/cli/index.ts",
				"--version",
			]);
			equal(command.line, null);
			// The pane is created with the command in its environment: the shim starts PanCode, then the shell.
			const run = spawnSync("/bin/sh", [layout.shell.defaultShell], {
				encoding: "utf8",
				env: { ...env, ...layout.hostEnv, ...command.env },
				input: "",
			});
			equal(run.status, 0, run.stderr);
			const lines = run.stdout.split("\n");
			equal(lines[0], `pancode-runtime=${runtime ?? "unset"}`);
			ok(lines.includes(`pane-runtime=${runtime ?? "unset"}`), run.stdout);
		}
	});

	it("hands the PanCode command to the pane as one variable per word, with nothing to type", () => {
		deepStrictEqual(
			createPosixHostPlatform({ env: {} }).paneLaunch(["/usr/bin/node", "/opt/pancode coder/index.js", "it's"]),
			{
				env: {
					PANCODE_PANE_ARGC: "3",
					PANCODE_PANE_ARG_0: "/usr/bin/node",
					PANCODE_PANE_ARG_1: "/opt/pancode coder/index.js",
					PANCODE_PANE_ARG_2: "it's",
				},
				line: null,
			},
		);
	});

	it("types the PanCode command with a leading space when the operator asks for the shell launch", () => {
		deepStrictEqual(
			createPosixHostPlatform({ env: { PANCODE_PANE_LAUNCH: "shell" } }).paneLaunch([
				"/usr/bin/node",
				"/opt/pancode coder/index.js",
				"it's",
			]),
			{ env: {}, line: " /usr/bin/node '/opt/pancode coder/index.js' 'it'\\''s'" },
		);
	});

	it("the shim runs the handed command word for word, then the operator's shell, and leaves no launch variable", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-shim-launch-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const shim = join(scratch, "pane-shell");
		const shell = join(scratch, "fake-shell");
		const pancode = join(scratch, "fake pancode");
		const leaked = '$(env | grep -c "^PANCODE_PANE_")';
		writeFileSync(shim, renderPosixShellShim("linux"), { mode: 0o755 });
		writeFileSync(shell, `#!/bin/sh\necho "shell args=$# leaked=${leaked}"\n`, { mode: 0o755 });
		writeFileSync(
			pancode,
			`#!/bin/sh\necho "pancode leaked=${leaked}"\nfor word in "$@"; do echo "word=[$word]"; done\nexit 7\n`,
			{ mode: 0o755 },
		);
		// Words a shell would split, expand or run if any of them were ever parsed as shell text.
		const words = ["it's", 'say "hi" $HOME `id`', "", "a b", "--flag=x;y"];
		const launch = createPosixHostPlatform({ env: {} }).paneLaunch([pancode, ...words]);
		const run = (env: Record<string, string>) =>
			spawnSync("/bin/sh", [shim], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SHELL: shell, ...env } });
		const started = run(launch.env);
		deepStrictEqual(started.stdout.trim().split("\n"), [
			"pancode leaked=0",
			...words.map((word) => `word=[${word}]`),
			"shell args=0 leaked=0",
		]);
		equal(started.status, 0);
		// A pane created without the command, every split and dock, is the plain shell.
		equal(run({}).stdout.trim(), "shell args=0 leaked=0");
	});

	it("the shim records the status of a PanCode that ended without its exit marker, and keeps one PanCode wrote", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-shim-marker-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const shim = join(scratch, "pane-shell");
		const pancode = join(scratch, "fake-pancode");
		const socket = join(scratch, `${SESSION}.sock`);
		const marker = exitMarkerPath(socket, "w1:p1");
		writeFileSync(shim, renderPosixShellShim("linux"), { mode: 0o755 });
		writeFileSync(
			pancode,
			'#!/bin/sh\n[ -z "$OWN" ] || printf "%s" "$OWN" >"$MARKER"\n[ "$1" = kill ] && kill -9 $$\nexit "$1"\n',
			{
				mode: 0o755,
			},
		);
		const run = (status: string, own = "") => {
			rmSync(marker, { force: true });
			const launch = createPosixHostPlatform({ env: {} }).paneLaunch([pancode, status]);
			spawnSync("/bin/sh", [shim], {
				env: {
					PATH: "/usr/bin:/bin",
					SHELL: "/bin/true",
					HERDR_PANE_ID: "w1:p1",
					HERDR_SOCKET_PATH: socket,
					MARKER: marker,
					OWN: own,
					...launch.env,
				},
			});
			return readWorkspaceExitResult(marker);
		};
		// A PanCode that failed before it registered its marker, or was killed, must not leave the launcher at the shell.
		deepStrictEqual(run("3"), { exitCode: 3, summary: null });
		deepStrictEqual(run("kill"), { exitCode: 137, summary: null });
		deepStrictEqual(run("0"), { exitCode: 0, summary: null });
		deepStrictEqual(run("5", "summary\n"), { exitCode: 0, summary: "summary\n" });
		deepStrictEqual(
			readdirSync(scratch).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("replaces a changed shell shim without truncating an existing reader's inode", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-atomic-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const platform = createPosixHostPlatform({ platform: "linux", stateDir: () => join(scratch, "state") });
		const input = { session: "pancode-atomic", env: { XDG_RUNTIME_DIR: tmpdir() } };
		const layout = platform.hostLayout(input);
		const shim = layout.shell.defaultShell;
		ok(shim);
		writeFileSync(shim, "previous complete shim\n");
		const reader = openSync(shim, "r");
		try {
			platform.hostLayout(input);
			equal(readFileSync(reader, "utf8"), "previous complete shim\n");
			equal(readFileSync(shim, "utf8"), renderPosixShellShim("linux"));
			equal(statSync(shim).mode & 0o777, 0o755);
		} finally {
			closeSync(reader);
		}
	});
});

describe("private host startup cleanup", () => {
	it("reaps a spawned server that never becomes ready before falling back", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-start-"));
		const binary = join(scratch, "host");
		const pidFile = join(scratch, "server.pid");
		const layoutRoot = join(scratch, "layout");
		const socketPath = join(tmpdir(), "start.sock");
		const program = join(scratch, "host.mjs");
		writeFileSync(
			program,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nwriteFileSync(${JSON.stringify(socketPath)}, "");\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
		);
		writeFileSync(
			binary,
			`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program.replaceAll("'", "'\\''")}' "$@"\n`,
			{ mode: 0o755 },
		);
		t.after(() => {
			if (existsSync(pidFile)) {
				try {
					const pid = Number(readFileSync(pidFile, "utf8"));
					if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
				} catch {}
			}
			rmSync(scratch, { recursive: true, force: true });
			rmSync(socketPath, { force: true });
		});
		const result = await launchWorkspace({
			herdrPath: binary,
			herdrVersion: null,
			nested: false,
			outputStyle: "standard",
			cwd: scratch,
			pancodeArgv: ["unused"],
			platform: {
				hostLayout: () => ({
					socketPath,
					herdrArgs: [],
					hostEnv: {},
					configPath: join(layoutRoot, "config.toml"),
					shell: { defaultShell: null, shellMode: "non_login" },
					sessionFile: join(layoutRoot, "session.json"),
					disposableDirs: [layoutRoot],
					cleanupArgs: null,
				}),
				paneLaunch: () => ({ env: {}, line: "" }),
				detach: () => undefined,
				afterClientExit: () => undefined,
			},
		});
		equal(result.status, "fallback");
		const pid = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		equal(alive, false, "the failed server must be reaped before fallback");
		equal(existsSync(layoutRoot), false);
		equal(existsSync(socketPath), false);
	});
});

describe("private host second terminal", () => {
	it("never joins a PanCode another live terminal still shows (#420)", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-second-"));
		const socketPath = join(tmpdir(), `${SESSION}.sock`);
		const methods: string[] = [];
		const holder = `${process.ppid}:${processBirthToken(process.ppid) ?? ""}`;
		const server = createServer((socket) => {
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.toString().trim());
				methods.push(request.method);
				let result: unknown = {};
				if (request.method === "ping") result = { version: "fixture", protocol: 21 };
				if (request.method === "workspace.list") result = { workspaces: [{ workspace_id: "w1" }] };
				if (request.method === "pane.list") {
					const tokens = { pancode_workspace: "00000000-0000-0000-0000-000000000000", pancode_launcher: holder };
					result = { panes: [{ pane_id: "w1:p1", tab_id: "t1", workspace_id: "w1", cwd: scratch, tokens }] };
				}
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
		});
		t.after(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(socketPath, { force: true });
			rmSync(scratch, { recursive: true, force: true });
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		const result = await launchWorkspace({
			herdrPath: join(scratch, "never-run"),
			herdrVersion: "fixture",
			nested: false,
			outputStyle: "standard",
			cwd: scratch,
			pancodeArgv: ["unused"],
			platform: {
				hostLayout: () => ({
					socketPath,
					herdrArgs: [],
					hostEnv: { HERDR_SOCKET_PATH: socketPath },
					configPath: join(scratch, "config.toml"),
					shell: { defaultShell: null, shellMode: "non_login" },
					sessionFile: join(scratch, "session.json"),
					disposableDirs: [],
					cleanupArgs: null,
				}),
				paneLaunch: () => ({ env: {}, line: "" }),
				detach: () => undefined,
				afterClientExit: () => undefined,
			},
		});
		equal(result.status, "fallback");
		if (result.status === "fallback") match(result.reason, new RegExp(`another terminal, pid ${process.ppid}`));
		for (const joins of ["pane.report_metadata", "workspace.focus", "workspace.create"])
			ok(!methods.includes(joins), joins);
	});
});

describe("private host attached-client shutdown", () => {
	for (const scenario of [
		"last workspace",
		"another workspace",
		"reused workspace",
		"reattached launcher",
		"terminal hangup",
	] as const) {
		it(`handles launcher termination with a delayed co-attached client (${scenario})`, {
			skip: process.platform === "win32",
		}, async (t) => {
			const scratch = mkdtempSync(join(tmpdir(), "host-clients-"));
			const socketPath = join(tmpdir(), `${SESSION}.sock`);
			const binary = join(scratch, "client");
			const program = join(scratch, "client.mjs");
			writeFileSync(
				program,
				[
					'import { createConnection } from "node:net";',
					'if (process.argv[2] === "pane") process.exit(0);',
					"const socket = createConnection(process.env.HERDR_SOCKET_PATH);",
					'socket.on("connect", () => socket.write(JSON.stringify({ method: "test.attach", params: { pid: process.pid } }) + "\\n"));',
					'socket.on("end", () => process.exit(0));',
					'socket.on("error", () => process.exit(1));',
					'process.on("SIGHUP", () => setTimeout(() => { socket.end(); process.exit(0); }, Number(process.env.DETACH_DELAY ?? 0)));',
				].join("\n"),
			);
			writeFileSync(
				binary,
				`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program.replaceAll("'", "'\\''")}' "$@"\n`,
				{ mode: 0o755 },
			);
			const connections = new Set<Socket>();
			const attached = new Set<Socket>();
			const pids = new Set<number>();
			const methods: string[] = [];
			const detaches: Array<{ delay: number; marked: boolean }> = [];
			let replacements = 0;
			let stopped = false;
			let workspace = false;
			const other = scenario === "another workspace";
			let nonce = "";
			const pane = () => ({
				pane_id: "w1:p1",
				tab_id: "t1",
				workspace_id: "w1",
				cwd: scratch,
				tokens: { pancode_workspace: nonce },
			});
			const server = createServer((socket) => {
				connections.add(socket);
				socket.on("close", () => {
					connections.delete(socket);
					attached.delete(socket);
				});
				let pending = "";
				socket.on("data", (chunk) => {
					pending += chunk.toString();
					if (!pending.includes("\n")) return;
					const request = JSON.parse(pending.trim());
					if (request.method === "test.attach") {
						attached.add(socket);
						pids.add(request.params.pid);
						return;
					}
					methods.push(request.method);
					let result: unknown = {};
					if (request.method === "ping") result = { version: "fixture", protocol: 21 };
					if (request.method === "workspace.list") {
						result = {
							workspaces: [...(workspace ? [{ workspace_id: "w1" }] : []), ...(other ? [{ workspace_id: "other" }] : [])],
						};
					}
					if (request.method === "pane.list") result = { panes: request.params.workspace_id === "w1" ? [pane()] : [] };
					if (request.method === "workspace.create") {
						workspace = true;
						result = { workspace: { workspace_id: "w1" }, root_pane: pane() };
					}
					if (request.method === "pane.report_metadata") nonce = request.params.tokens.pancode_workspace;
					if (request.method === "workspace.close") {
						workspace = false;
						if (!other && attached.size > 0) {
							replacements += 1;
							workspace = true;
							nonce = "replacement";
						}
					}
					socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
					if (request.method === "server.stop") {
						stopped = true;
						workspace = false;
						server.close();
						for (const connection of attached) connection.end();
					}
				});
			});
			const launches: Array<ReturnType<typeof launchWorkspace>> = [];
			t.after(async () => {
				for (const pid of pids) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				for (const socket of connections) socket.destroy();
				if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
				await Promise.allSettled(launches);
				rmSync(socketPath, { force: true });
				rmSync(scratch, { recursive: true, force: true });
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const base = {
				herdrPath: binary,
				herdrVersion: "fixture",
				nested: false,
				outputStyle: "standard" as const,
				cwd: scratch,
				pancodeArgv: ["unused"],
			};
			const host = (delay: number) => ({
				...base,
				platform: {
					hostLayout: () => ({
						socketPath,
						herdrArgs: [],
						hostEnv: { HERDR_SOCKET_PATH: socketPath, DETACH_DELAY: String(delay) },
						configPath: join(scratch, "config.toml"),
						shell: { defaultShell: null, shellMode: "non_login" as const },
						sessionFile: join(scratch, "session.json"),
						disposableDirs: [],
						cleanupArgs: null,
					}),
					paneLaunch: () => ({ env: {}, line: "" }),
					detach: (child: import("node:child_process").ChildProcess) => {
						detaches.push({ delay, marked: existsSync(exitMarkerPath(socketPath, "w1:p1")) });
						child.kill("SIGHUP");
					},
					afterClientExit: () => undefined,
				},
			});
			const waitForClients = async (count: number): Promise<void> => {
				for (let attempt = 0; attempt < 400 && attached.size !== count; attempt++) await sleep(25);
				equal(attached.size, count, "fixture clients did not attach");
			};
			const before = new Set(process.listeners("SIGTERM"));
			const beforeHangup = new Set(process.listeners("SIGHUP"));
			const creator = launchWorkspace(host(0));
			launches.push(creator);
			await waitForClients(1);
			const terminate = process.listeners("SIGTERM").find((handler) => !before.has(handler));
			ok(terminate);
			const hangup = process.listeners("SIGHUP").find((handler) => !beforeHangup.has(handler));
			ok(hangup, "a closed terminal must end the launch, not orphan its host");
			const beforeFollower = new Set(process.listeners("SIGTERM"));
			const follower = launchWorkspace(host(1_200));
			launches.push(follower);
			await waitForClients(2);
			if (scenario === "reused workspace") nonce = "00000000-0000-0000-0000-000000000000";
			const terminateFollower = process.listeners("SIGTERM").find((handler) => !beforeFollower.has(handler));
			ok(terminateFollower);
			const reattached = scenario === "reattached launcher";
			const hungUp = scenario === "terminal hangup";
			if (hungUp) hangup("SIGHUP");
			else (reattached ? terminateFollower : terminate)("SIGTERM");
			const first = await (reattached ? follower : creator);
			equal(first.status, "closed");
			if (first.status === "closed") equal(first.exitCode, hungUp ? 129 : 143);
			if (scenario === "reused workspace" || reattached) {
				equal(stopped, false);
				equal(methods.includes("workspace.close"), false);
				equal(
					detaches.some((request) => request.marked),
					false,
				);
			} else {
				ok(detaches.some((request) => request.delay === 0 && request.marked));
				equal(replacements, 0, "closing the last workspace under an attached client must not create a replacement");
				equal(stopped, !other);
				equal(methods.includes("workspace.close"), other);
			}
			if (!reattached) await follower;
		});
	}
});

describe("private host after the PanCode pane's shell exits", () => {
	it("stops a host left holding only herdr's replacement workspace", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-replaced-"));
		const socketPath = join(tmpdir(), `${SESSION}.sock`);
		const binary = join(scratch, "client");
		const program = join(scratch, "client.mjs");
		writeFileSync(
			program,
			[
				'import { createConnection } from "node:net";',
				"const socket = createConnection(process.env.HERDR_SOCKET_PATH);",
				'socket.on("connect", () => socket.write(JSON.stringify({ method: "test.attach", params: { pid: process.pid } }) + "\\n"));',
				'socket.on("end", () => process.exit(0));',
				'socket.on("error", () => process.exit(1));',
				'process.on("SIGHUP", () => { socket.end(); process.exit(0); });',
			].join("\n"),
		);
		writeFileSync(
			binary,
			`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program.replaceAll("'", "'\\''")}' "$@"\n`,
			{ mode: 0o755 },
		);
		const pids = new Set<number>();
		const methods: string[] = [];
		let nonce = "";
		// The PanCode pane, until the operator ends its shell and herdr puts an untagged shell workspace in its place.
		let workspaces: Array<{ id: string; tokens: () => Record<string, string> }> = [];
		let attached = false;
		const server = createServer((socket) => {
			let pending = "";
			socket.on("data", (chunk) => {
				pending += chunk.toString();
				if (!pending.includes("\n")) return;
				const request = JSON.parse(pending.trim());
				if (request.method === "test.attach") {
					pids.add(request.params.pid);
					attached = true;
					return;
				}
				methods.push(request.method);
				const pane = (id: string, tokens: Record<string, string>) => ({
					pane_id: `${id}:p1`,
					tab_id: "t1",
					workspace_id: id,
					cwd: scratch,
					tokens,
				});
				let result: unknown = {};
				if (request.method === "ping") result = { version: "fixture", protocol: 21 };
				if (request.method === "workspace.list") result = { workspaces: workspaces.map((w) => ({ workspace_id: w.id })) };
				if (request.method === "pane.list") {
					const found = workspaces.find((w) => w.id === request.params.workspace_id);
					result = { panes: found ? [pane(found.id, found.tokens())] : [] };
				}
				if (request.method === "workspace.create") {
					workspaces = [{ id: "w1", tokens: () => ({ pancode_workspace: nonce }) }];
					result = { workspace: { workspace_id: "w1" }, root_pane: pane("w1", {}) };
				}
				if (request.method === "pane.report_metadata") nonce = request.params.tokens.pancode_workspace;
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				if (request.method === "server.stop") server.close();
			});
		});
		const launches: Array<ReturnType<typeof launchWorkspace>> = [];
		t.after(async () => {
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.allSettled(launches);
			rmSync(socketPath, { force: true });
			rmSync(scratch, { recursive: true, force: true });
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		const launch = launchWorkspace({
			herdrPath: binary,
			herdrVersion: "fixture",
			nested: false,
			outputStyle: "standard",
			cwd: scratch,
			pancodeArgv: ["unused"],
			platform: {
				hostLayout: () => ({
					socketPath,
					herdrArgs: [],
					hostEnv: { HERDR_SOCKET_PATH: socketPath },
					configPath: join(scratch, "config.toml"),
					shell: { defaultShell: null, shellMode: "non_login" },
					sessionFile: join(scratch, "session.json"),
					disposableDirs: [],
					cleanupArgs: null,
				}),
				paneLaunch: () => ({ env: {}, line: null }),
				detach: (child) => {
					child.kill("SIGHUP");
				},
				afterClientExit: () => undefined,
			},
		});
		launches.push(launch);
		for (let attempt = 0; attempt < 400 && !attached; attempt++) await sleep(25);
		ok(attached, "fixture client did not attach");
		// PanCode was killed without its marker and the operator typed `exit` at the pane's shell.
		workspaces = [{ id: "w2", tokens: () => ({}) }];
		const result = await launch;
		equal(result.status, "closed");
		if (result.status === "closed") {
			equal(result.exitCode, 0);
			equal(result.workspaceLeftRunning, false);
		}
		ok(methods.includes("server.stop"), "the replacement workspace must not keep the host running");
		equal(methods.includes("workspace.close"), false);
	});
});

describe("managed herdr config", () => {
	it("uses ctrl+b, or the nested prefix inside another herdr, and unbinds herdr's own screens", () => {
		const plain = renderWorkspaceConfig({ shell, nested: false, outputStyle: "standard" });
		match(plain, /^prefix = "ctrl\+b"$/mu);
		const nested = renderWorkspaceConfig({ shell, nested: true, outputStyle: "standard" });
		match(nested, /^prefix = \["ctrl\+shift\+b", "ctrl\+\]"\]$/mu);
		for (const key of ["help", "settings", "new_workspace", "workspace_picker", "goto", "reload_config"]) {
			match(plain, new RegExp(`^${key} = ""$`, "mu"));
		}
		match(plain, /^default_shell = ".*pane-shell"$/mu);
		match(plain, /^shell_mode = "non_login"$/mu);
		match(plain, /^version_check = false$/mu);
		match(plain, /^onboarding = false$/mu);
		match(plain, /^hide_tab_bar_when_single_tab = true$/mu);
	});

	it("follows the output style with its pane chrome", () => {
		const compact = renderWorkspaceConfig({ shell, nested: false, outputStyle: "compact" });
		match(compact, /^pane_gaps = false$/mu);
		match(compact, /^pane_scrollbars = false$/mu);
		const detailed = renderWorkspaceConfig({ shell, nested: false, outputStyle: "detailed" });
		match(detailed, /^pane_borders = "always"$/mu);
		match(detailed, /^pane_outer_borders = true$/mu);
	});

	it("re-renders for a new style keeping the launch's nesting, and refuses to guess without it", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-host-config-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const configPath = join(scratch, "herdr", "config.toml");
		equal(rerenderWorkspaceConfig(configPath, shell, "detailed"), false);
		writeWorkspaceConfig(configPath, { shell, nested: true, outputStyle: "compact" });
		equal(rerenderWorkspaceConfig(configPath, shell, "detailed"), true);
		const text = readFileSync(configPath, "utf8");
		match(text, /^pane_borders = "always"$/mu);
		match(text, /^prefix = \["ctrl\+shift\+b"/mu);
	});
});

describe("host identity and exit markers", () => {
	it("does not reuse another PanCode state root's host for the same project", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "host-identity-"));
		const saved = process.env.PANCODE_STATE_DIR;
		t.after(() => {
			if (saved === undefined) delete process.env.PANCODE_STATE_DIR;
			else process.env.PANCODE_STATE_DIR = saved;
			resetXdgCache();
			rmSync(scratch, { recursive: true, force: true });
		});
		const state = join(scratch, "state-a");
		mkdirSync(state);
		process.env.PANCODE_STATE_DIR = state;
		resetXdgCache();
		const first = workspaceSessionFor(scratch);
		notEqual(first.session, `pancode-${createHash("sha256").update(first.cwd).digest("hex").slice(0, 12)}`);
		process.env.PANCODE_STATE_DIR = join(scratch, "state-b");
		mkdirSync(process.env.PANCODE_STATE_DIR);
		resetXdgCache();
		const second = workspaceSessionFor(scratch);
		notEqual(first.session, second.session);
		process.env.PANCODE_STATE_DIR = state;
		resetXdgCache();
		deepStrictEqual(workspaceSessionFor(scratch), first);
		symlinkSync(state, join(scratch, "state-link"), "junction");
		symlinkSync(scratch, join(scratch, "project-link"), "junction");
		process.env.PANCODE_STATE_DIR = join(scratch, "state-link");
		resetXdgCache();
		deepStrictEqual(workspaceSessionFor(join(scratch, "project-link")), first);
	});

	it("recognises only PanCode's host sockets, in either layout", () => {
		equal(pancodeHostSessionOf(`/run/user/1/pancode/${SESSION}.sock`), SESSION);
		equal(pancodeHostSessionOf(`C:\\Users\\me\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\herdr.sock`), SESSION);
		equal(pancodeHostSessionOf("/home/me/.config/herdr/herdr.sock"), null);
		equal(pancodeHostSessionOf("/tmp/pancode.sock"), null);
		equal(hostedInWorkspace({ HERDR_ENV: "1", HERDR_SOCKET_PATH: `/x/${SESSION}.sock` }), true);
		equal(hostedInWorkspace({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock" }), false);
	});

	it("names markers after the socket and sanitizes the pane id", () => {
		equal(exitMarkerPath(`/run/x/${SESSION}.sock`, "w1:p2"), `/run/x/${SESSION}.exit-w1_p2`);
	});

	it("carries the clean-exit summary to the launcher in the marker", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-exit-marker-"));
		t.after(() => {
			holdExitSummaryForLauncher("");
			rmSync(scratch, { recursive: true, force: true });
		});
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(scratch, `${SESSION}.sock`), HERDR_PANE_ID: "w1:p2" };
		const marker = exitMarkerPath(env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID);
		const summary = "PanCode · Session summary\n/resume 0123\n";
		holdExitSummaryForLauncher(summary);
		markWorkspaceExit(env);
		deepStrictEqual(readWorkspaceExitResult(marker), { exitCode: 0, summary });
		equal(statSync(marker).mode & 0o777, 0o600);
		deepStrictEqual(readdirSync(scratch), [basename(marker)]);
		// A quit with nothing to report still marks the exit, with no summary to print.
		holdExitSummaryForLauncher("");
		markWorkspaceExit(env);
		deepStrictEqual(readWorkspaceExitResult(marker), { exitCode: 0, summary: null });
		writeFileSync(marker, "x".repeat(256 * 1024 + 1));
		equal(readWorkspaceExitResult(marker), null);
		equal(readWorkspaceExitResult(join(scratch, "missing")), null);
		equal(readWorkspaceExitResult(scratch), null);
	});

	it("carries crash and signal exit status so the launcher can dispose the private host without masking failure", (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-exit-status-"));
		t.after(() => {
			holdExitSummaryForLauncher("");
			rmSync(scratch, { recursive: true, force: true });
		});
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(scratch, `${SESSION}.sock`), HERDR_PANE_ID: "w1:p2" };
		const marker = exitMarkerPath(env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID);
		holdExitSummaryForLauncher("session ended\n");
		for (const exitCode of [1, 143]) {
			markWorkspaceExit(env, exitCode);
			deepStrictEqual(readWorkspaceExitResult(marker), { exitCode, summary: "session ended\n" });
		}
		// A pane that failed takes its stderr with it, so the marker carries the last lines and the launcher prints them.
		const pane = { write: (_chunk: string | Uint8Array): boolean => true };
		captureFailureForLauncher(pane);
		pane.write("[pancode:domain] load failed: dispatch: dispatch admission store has an invalid active reservation\n");
		pane.write("\u001b[31merror:\u001b[39m Domain 'dispatch' failed to load; the cause is printed above\n");
		markWorkspaceExit(env, 1);
		const failed = readWorkspaceExitResult(marker);
		equal(
			failed?.failure,
			"[pancode:domain] load failed: dispatch: dispatch admission store has an invalid active reservation\nerror: Domain 'dispatch' failed to load; the cause is printed above",
		);
		equal(failed?.summary, "session ended\n");
		match(
			workspaceExitNotice(1, failed?.failure),
			/exit code 1:\n {2}\[pancode:domain\] load failed: dispatch: .*\n {2}error: /u,
		);
		match(workspaceExitNotice(1, undefined), /exit code 1\. .*pancode --with-panes/u);
		equal(workspaceExitNotice(143, undefined), "PanCode workspace ended with exit code 143.\n");
		markWorkspaceExit(env, 0);
		equal(readWorkspaceExitResult(marker)?.failure, undefined);
	});
});

describe("launcher eligibility", () => {
	const base = {
		options: {},
		env: { TERM: "xterm-256color" },
		stdinIsTTY: true,
		stdoutIsTTY: true,
		insidePancodeHost: false,
	};
	it("opens by default, nested inside the operator's herdr, and never inside its own host", () => {
		deepStrictEqual(workspaceEligibility(base), { kind: "open", nested: false });
		deepStrictEqual(workspaceEligibility({ ...base, env: { HERDR_ENV: "1" } }), { kind: "open", nested: true });
		equal(workspaceEligibility({ ...base, env: { HERDR_ENV: "1" }, insidePancodeHost: true }).kind, "plain");
	});
	it("stays plain for non-interactive runs, pipes, dumb terminals, other multiplexers and --with-panes", () => {
		equal(workspaceEligibility({ ...base, options: { headless: { task: "x" } as never } }).kind, "plain");
		equal(workspaceEligibility({ ...base, stdoutIsTTY: false }).kind, "plain");
		equal(workspaceEligibility({ ...base, env: { TERM: "dumb" } }).kind, "plain");
		equal(workspaceEligibility({ ...base, env: { TMUX: "/tmp/tmux" } }).kind, "plain");
		equal(workspaceEligibility({ ...base, options: { panes: "with" } }).kind, "plain");
	});
	it("doctor reports what a bare launch does, nested inside the operator's herdr", () => {
		const operatorHerdr = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock" };
		const guest = { mode: "guest", reason: "guest mode on /home/me/.config/herdr/herdr.sock" };
		const nested = panesModeFinding(operatorHerdr, guest);
		equal(nested.level, "ok");
		match(nested.detail, /^nested; bare `pancode` opens PanCode's private pane host inside this herdr pane/);
		match(nested.detail, /`pancode --with-panes` joins this herdr as a guest/);
		// An unreachable outside herdr does not stop the nested host, so it is not a warning.
		equal(panesModeFinding(operatorHerdr, { mode: "none", reason: "no socket answered" }).level, "ok");
		const own = panesModeFinding({ HERDR_ENV: "1", HERDR_SOCKET_PATH: `/run/u/pancode/${SESSION}.sock` }, guest);
		match(own.detail, /^guest; bare `pancode` stays in this pane \(already inside PanCode's pane host\)/);
		const outside = panesModeFinding({ TERM: "xterm-256color" }, null);
		match(outside.detail, /^PanCode's private pane host opens with bare `pancode`/);
		match(
			panesModeFinding({ TMUX: "/x/tmux" }, null).detail,
			/^plain; bare `pancode` stays in this terminal \(already inside a terminal multiplexer \(TMUX\)\)/,
		);
	});
});

describe("doctor's panes binary row", () => {
	it("names the pinned herdr the launcher runs, not a herdr on PATH", {
		skip: process.platform === "win32",
	}, async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-panes-binary-"));
		const saved = { PATH: process.env.PATH, PANCODE_DATA_DIR: process.env.PANCODE_DATA_DIR };
		t.after(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(scratch, { recursive: true, force: true });
		});
		const pin = findPinnedTool("herdr");
		ok(pin);
		// A PATH herdr that meets the floor, which the private host still never runs.
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "herdr ${pin.version}"\n`);
		chmodSync(join(bin, "herdr"), 0o755);
		process.env.PATH = bin;
		process.env.PANCODE_DATA_DIR = join(scratch, "data");
		const env = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: join(scratch, "operator.sock"),
			XDG_CONFIG_HOME: join(scratch, "cfg"),
			HOME: scratch,
		};
		const row = async (): Promise<{ level?: string; detail: string } | undefined> =>
			(await panesFindings(env)).find((finding) => finding.name === "panes binary");

		// The PATH copy hosts the operator's own panes, so the missing pin is information, not a warning (dogfood F8).
		const missing = await row();
		equal(missing?.level, "info");
		match(missing?.detail ?? "", /PanCode's pinned copy is not installed.*`pancode panes install` adds it/);
		match(missing?.detail ?? "", new RegExp(`herdr ${pin.version} on PATH at ${join(bin, "herdr")}`));

		const vendored = join(scratch, "data", "tools", "herdr", pin.version, "herdr");
		mkdirSync(join(vendored, ".."), { recursive: true });
		writeFileSync(vendored, "");
		const present = await row();
		equal(present?.level, "ok");
		equal(present?.detail, `pane host ${pin.version} (PanCode's pinned copy) at ${vendored}`);
	});
});

describe("toolchain mirror", () => {
	it("maps a pinned URL onto a mirror directory, file URL or HTTP mirror, namespaced by tool and version", () => {
		const url = "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64";
		deepStrictEqual(mirroredSources(url, "/srv/mirror", "herdr", "0.9.5"), [
			"/srv/mirror/herdr/0.9.5/herdr-linux-x86_64",
		]);
		deepStrictEqual(mirroredSources(url, "file:///srv/mirror", "herdr", "0.9.5"), [
			"/srv/mirror/herdr/0.9.5/herdr-linux-x86_64",
		]);
		deepStrictEqual(mirroredSources(url, "https://cache.example/herdr/", "herdr", "0.9.5"), [
			"https://cache.example/herdr/herdr/0.9.5/herdr-linux-x86_64",
		]);
		deepStrictEqual(
			mirroredSources("https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/LICENSE", "/srv/mirror", "herdr", "0.9.5"),
			["/srv/mirror/herdr/0.9.5/LICENSE"],
		);
	});

	it("installs tools whose same-named LICENSE files differ from one mirror and never reads a flat mirror", async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-toolchain-mirror-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const fixture = (id: string, version: string) => {
			const program = `${id} program`;
			const license = `${id} license text`;
			return {
				program,
				license,
				entry: {
					id,
					version,
					summary: id,
					homepage: "https://fixture.invalid",
					license: "MIT",
					binaries: [id],
					primaryBinary: id,
					minimumVersion: version,
					versionArgs: ["--version"],
					downloads: {
						"linux-x64": {
							url: `https://fixture.invalid/${id}/releases/${id}-linux`,
							sha256: sha256Hex(program),
							archive: "raw" as const,
							binaryMembers: { [id]: "" },
							documentMembers: [],
						},
					},
					documents: [{ name: "LICENSE", url: `https://fixture.invalid/${id}/LICENSE`, sha256: sha256Hex(license) }],
				},
			};
		};
		const alpha = fixture("alpha", "1.0.0");
		const beta = fixture("beta", "2.0.0");
		const install = (entry: typeof alpha.entry, mirror: string, root: string) =>
			installPinnedTool(entry, { root, platform: "linux-x64", mirror });

		const namespaced = join(scratch, "namespaced");
		for (const tool of [alpha, beta]) {
			const dir = join(namespaced, tool.entry.id, tool.entry.version);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${tool.entry.id}-linux`), tool.program);
			writeFileSync(join(dir, "LICENSE"), tool.license);
		}
		// A stale flat LICENSE from another tool must not shadow the namespaced copy.
		writeFileSync(join(namespaced, "LICENSE"), beta.license);
		for (const tool of [alpha, beta]) {
			const result = await install(tool.entry, namespaced, join(scratch, "tools-namespaced"));
			equal(result.ok, true, result.message);
			equal(readFileSync(join(result.dir, "LICENSE"), "utf8"), tool.license);
		}

		const flat = join(scratch, "flat");
		mkdirSync(flat, { recursive: true });
		writeFileSync(join(flat, "alpha-linux"), alpha.program);
		writeFileSync(join(flat, "LICENSE"), alpha.license);
		const refused = await install(alpha.entry, flat, join(scratch, "tools-flat"));
		equal(refused.ok, false);
		match(refused.message, /download failed/);
		equal(existsSync(refused.dir), false);
	});
});
