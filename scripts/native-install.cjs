// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const os = require("node:os");
const MARK = "# pancode-installer launcher";
const PACKAGE_NAME = "@akougkas/pancode";
const SCHEMA = 3;

/** The host id install.sh records in `.install-lock/host`, so it can reclaim a lock this process leaves behind. */
function installLockHost() {
	for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
		try {
			const id = fs.readFileSync(file, "utf8").replace(/[ \n]/gu, "");
			if (id) return withPidNamespace(id);
		} catch {}
	}
	if (process.platform === "darwin") {
		try {
			const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
				encoding: "utf8",
			});
			const id = /"IOPlatformUUID" = "([^"]+)"/u.exec(out)?.[1];
			if (id) return withPidNamespace(id);
		} catch {}
	}
	return withPidNamespace(os.hostname());
}

/** install.sh appends the pid namespace, so a container sharing the machine id never reclaims the host's lock. */
function withPidNamespace(id) {
	try {
		return `${id}/${fs.readlinkSync("/proc/self/ns/pid")}`;
	} catch {
		return id;
	}
}

function atomic(file, text, mode = 0o600) {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, text, { mode });
		// Windows FlushFileBuffers needs a writable handle; a read-only one fails with EPERM.
		const fd = fs.openSync(temp, process.platform === "win32" ? "r+" : "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

// src/core/xdg.ts resolvePancodeDirs for the two roots this helper reads. It runs before any
// package is importable, so the order is repeated here.
// On Windows the launcher is assets/windows-launcher's native exe, which starts what
// pancode.launch names with the caller's command line unchanged. A pancode.cmd
// would pass it through cmd.exe, which expands %NAME% and splits on & after an odd quote.
function quoteWindows(value) {
	return `"${value.replace(/(\\*)$/u, "$1$1")}"`;
}

// Returns the installed exe, or null where no launcher is built for this arch and the .cmd stays.
function installWindowsLauncher(cmd, launchText) {
	const assets = path.join(__dirname, "..", "assets", "windows-launcher");
	let pins;
	try {
		pins = JSON.parse(fs.readFileSync(path.join(assets, "pins.json"), "utf8"));
	} catch {
		return null;
	}
	const pin = pins[process.arch];
	if (typeof pin !== "string") return null;
	const source = path.join(assets, `win32-${process.arch}`, "launcher.exe");
	const bytes = fs.readFileSync(source);
	if (crypto.createHash("sha256").update(bytes).digest("hex") !== pin)
		throw new Error(`${source} does not match its pinned SHA-256; previous launcher remains active`);
	const bin = path.dirname(cmd);
	const exe = path.join(bin, "pancode.exe");
	atomic(path.join(bin, "pancode.launch"), launchText, 0o644);
	let installed = null;
	try {
		installed = fs.readFileSync(exe);
	} catch {
		/* No launcher yet. */
	}
	if (!installed?.equals(bytes)) {
		// A running exe cannot be replaced or deleted, but it can be renamed.
		const aside = `${exe}.${crypto.randomUUID()}.old`;
		if (installed) fs.renameSync(exe, aside);
		try {
			atomic(exe, bytes, 0o755);
		} catch (error) {
			if (installed) fs.renameSync(aside, exe);
			throw error;
		}
	}
	for (const name of fs.readdirSync(bin)) {
		if (!/^pancode\.exe\..+\.old$/u.test(name)) continue;
		try {
			fs.rmSync(path.join(bin, name));
		} catch {
			/* Still running; the next activation removes it. */
		}
	}
	return exe;
}

function pancodeRoot(role) {
	const specific = process.env[`PANCODE_${role.toUpperCase()}_DIR`]?.trim();
	if (specific) return specific;
	const pancodeHome = process.env.PANCODE_HOME?.trim();
	if (pancodeHome) return path.join(pancodeHome, role);
	const home = os.homedir();
	if (process.platform === "win32")
		return role === "config"
			? path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "pancode/config")
			: path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "pancode/state");
	if (process.platform === "darwin") return path.join(home, "Library/Application Support/pancode", role);
	const [variable, fallback] = role === "config" ? ["XDG_CONFIG_HOME", ".config"] : ["XDG_STATE_HOME", ".local/state"];
	const base = process.env[variable]?.trim();
	return path.join(base && path.isAbsolute(base) ? base : path.join(home, fallback), "pancode");
}

// One launch receipt per running launcher, in the state root so a read-only install root
// still launches. A receipt names the install root it was launched from.
function launchReceipts() {
	return path.join(pancodeRoot("state"), "launches");
}

const PROBES = new Set(["version", "--version", "-v", "help", "--help", "-h"]);

/** Doctor without --fix promises to leave the home as it found it, so it launches as a probe. */
function probe(args) {
	return PROBES.has(args[0]) || (args[0] === "doctor" && !args.includes("--fix"));
}

/** Windows paths name the same file whatever their case. */
function samePath(a, b) {
	const x = path.resolve(a);
	const y = path.resolve(b);
	if (process.platform === "win32") return x.toLowerCase() === y.toLowerCase();
	return x === y;
}

function inside(root, file) {
	if (typeof file !== "string" || !path.isAbsolute(file)) return false;
	const rel = path.relative(root, file);
	return (
		path.isAbsolute(file) && rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)
	);
}

function record(root) {
	const file = path.join(root, "install.json");
	if (!fs.existsSync(file)) return null;
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`Invalid installer manifest JSON: ${file}`);
	}
	if (
		!value ||
		typeof value !== "object" ||
		["node", "current", "launcher"].some((name) => typeof value[name] !== "string" || !path.isAbsolute(value[name]))
	)
		throw new Error(`Incomplete installer manifest: ${file}; expected absolute node, current and launcher paths`);
	if (value.schema !== SCHEMA) throw new Error(`Unsupported installer schema in ${file}`);
	if (
		value.kind !== "pancode-installer" ||
		!inside(path.join(root, "versions"), value.current) ||
		value.node !== nodeOf(value.current)
	)
		throw new Error(`Invalid installer ownership: ${file}`);
	if (value.desktopManager && !inside(path.join(root, "versions"), value.desktopManager))
		throw new Error("Desktop manager is outside owned versions");
	if (value.previous && !inside(path.join(root, "versions"), value.previous))
		throw new Error("Previous package is outside owned versions");
	return value;
}

// Every version directory is one unpacked bundle and carries the Node that runs it.
function nodeOf(prefix) {
	return process.platform === "win32" ? path.join(prefix, "node.exe") : path.join(prefix, "bin", "node");
}

// What the bundle says about itself: its target and the Node it carries.
function bundleInfo(prefix) {
	try {
		const info = JSON.parse(fs.readFileSync(path.join(prefix, "bundle.json"), "utf8"));
		return { target: String(info.target || ""), node: String(info.node || "") };
	} catch {
		return { target: "", node: "" };
	}
}

function entry(prefix) {
	return path.join(prefix, "lib", "node_modules", "pancode", "dist", "cli", "index.js");
}

function packageVersion(prefix) {
	try {
		const file = path.join(prefix, "lib", "node_modules", "pancode", "package.json");
		return String(JSON.parse(fs.readFileSync(file, "utf8")).version || "");
	} catch {
		// A prefix without readable metadata is still named by its path in messages.
		return "";
	}
}

// The commands the package declares besides pancode (pankit), each with its file inside the package.
function packageBins(prefix) {
	const pkg = path.join(prefix, "lib", "node_modules", "pancode");
	let bin;
	try {
		bin = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).bin;
	} catch {
		return new Map();
	}
	const bins = new Map();
	if (!bin || typeof bin !== "object") return bins;
	for (const [name, file] of Object.entries(bin))
		if (name !== "pancode" && /^[a-z][a-z0-9-]*$/u.test(name) && typeof file === "string")
			if (inside(pkg, path.resolve(pkg, file))) bins.set(name, path.resolve(pkg, file));
	return bins;
}

// The bootstrap every launcher of this root runs: this helper, stored once under its own hash.
function bootstrapFor(root) {
	const helper = fs.readFileSync(__filename, "utf8");
	const helpers = path.join(root, "launchers");
	fs.mkdirSync(helpers, { recursive: true });
	const bootstrap = path.join(helpers, `${crypto.createHash("sha256").update(helper).digest("hex")}.cjs`);
	if (!fs.existsSync(bootstrap)) atomic(bootstrap, helper);
	return bootstrap;
}

// The root a launcher this installer wrote runs: the whole quoted argument after its bin or launch verb.
function launcherRoot(text) {
	const posix = /^exec '(?:[^']|'\\'')*' '(?:[^']|'\\'')*' (?:bin|launch) '((?:[^']|'\\'')*)'/mu.exec(text);
	if (posix) return posix[1].replaceAll("'\\''", "'");
	const cmd = /^"[^"]*" "[^"]*" (?:bin|launch) "([^"]*)"/mu.exec(text);
	return cmd ? cmd[1] : null;
}

// A launcher this installer wrote for this root: a regular file with the mark whose root is this one.
function ownedLauncher(file, root) {
	try {
		if (!fs.lstatSync(file).isFile()) return false;
		const text = fs.readFileSync(file, "utf8");
		if (!text.includes(MARK)) return false;
		const owner = launcherRoot(text);
		return owner !== null && samePath(owner, root);
	} catch {
		return false;
	}
}

// One launcher per declared command beside pancode's, running through the manifest as pancode's does, so
// an upgrade or rollback moves them together. A launcher a version no longer declares goes, and only when
// this installer wrote it; a file someone else put there is replaced only under the installer's --force.
function syncBinLaunchers(root, prefix, binDir, launcherNode, recorded, force = false) {
	const bins = packageBins(prefix);
	const written = [];
	if (bins.size > 0) {
		const bootstrap = bootstrapFor(root);
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		for (const name of bins.keys()) {
			const file = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
			let present = false;
			try {
				fs.lstatSync(file);
				present = true;
			} catch {
				/* Nothing there yet. */
			}
			if (present && !ownedLauncher(file, root)) {
				const flag = process.platform === "win32" ? "-Force" : "--force";
				if (!force || fs.lstatSync(file).isDirectory()) {
					process.stderr.write(
						`[install] ${file} exists and this installer did not write it, so ${name} was not linked; move it aside and rerun the installer${force ? "" : `, or rerun it with ${flag}`}\n`,
					);
					continue;
				}
				process.stderr.write(`[install] replacing ${file} (${flag})\n`);
			}
			const body =
				process.platform === "win32"
					? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem ${MARK}\r\n"${launcherNode}" "${bootstrap}" bin "${root}" ${name} %*\r\nexit /b %errorlevel%\r\n`
					: `#!/bin/sh\n${MARK}\nexec ${quote(launcherNode)} ${quote(bootstrap)} bin ${quote(root)} ${name} "$@"\n`;
			fs.mkdirSync(binDir, { recursive: true });
			atomic(file, body, 0o755);
			written.push(file);
		}
	}
	for (const file of Array.isArray(recorded) ? recorded : [])
		if (typeof file === "string" && !written.some((kept) => samePath(kept, file)) && ownedLauncher(file, root))
			fs.rmSync(file, { force: true });
	return written;
}

// Writes the pancode launcher for `node` and returns its path. A POSIX launcher execs its Node, so replacing the
// file never disturbs a running shell; the Windows launcher is a native exe that reads pancode.launch on each start.
// Either follows the active version's Node, so prune can collect the version it left.
function writeLauncher(root, node, launcher) {
	const bootstrap = bootstrapFor(root);
	fs.mkdirSync(path.dirname(launcher), { recursive: true });
	if (process.platform !== "win32") {
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		atomic(launcher, `#!/bin/sh\n${MARK}\nexec ${quote(node)} ${quote(bootstrap)} launch ${quote(root)} "$@"\n`, 0o755);
		return launcher;
	}
	if (/[%\r\n"]/u.test(node + bootstrap + root + launcher))
		throw new Error("Windows installer paths cannot contain percent, newline or quote characters");
	const cmd = path.join(path.dirname(launcher), "pancode.cmd");
	const exe = installWindowsLauncher(
		cmd,
		`${node}\n${quoteWindows(bootstrap)} launch ${quoteWindows(root)}\nutf8-console\n`,
	);
	if (exe) return exe;
	atomic(
		cmd,
		`@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "PANCODE_LAUNCHER_CP=%%C"\r\nchcp 65001 >nul\r\nrem ${MARK}\r\n"${node}" "${bootstrap}" launch "${root}" %*\r\nset "PANCODE_LAUNCHER_EXIT=%errorlevel%"\r\nchcp %PANCODE_LAUNCHER_CP% >nul\r\nexit /b %PANCODE_LAUNCHER_EXIT%\r\n`,
		0o755,
	);
	return cmd;
}

function checkCandidate(node, prefix, postInstall, echo = true) {
	for (const args of [[entry(prefix), "--version"], ...(postInstall ? [[entry(prefix), "doctor", "--json"]] : [])]) {
		const result = spawnSync(node, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
		if (
			(result.status !== 0 && !(args[1] === "doctor" && result.status === 1)) ||
			(args[1] === "--version" && !result.stdout.trim())
		)
			throw new Error(
				`Candidate check failed (${result.status}): ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
			);
		if (args[1] === "doctor") {
			let report;
			try {
				report = JSON.parse(result.stdout);
			} catch {
				throw new Error(
					`Candidate doctor did not return its JSON report:\n${(result.stdout || result.stderr || "").trim().slice(0, 2000)}`,
				);
			}
			const integrity = new Set([
				"engine runtime",
				"installation files",
				"directory layout",
				"config dir",
				"data dir",
				"state dir",
				"cache dir",
				"settings.yaml",
			]);
			const failures = report.findings.filter((finding) => {
				const initializable = /^(config|data|state|cache) dir$/.test(finding.name) || finding.name === "settings.yaml";
				const missing = initializable && /(?:^missing| missing) \(run /u.test(finding.detail);
				return !finding.ok && integrity.has(finding.name) && !missing;
			});
			if (failures.length) throw new Error(failures.map((finding) => `${finding.name}: ${finding.detail}`).join("\n"));
		} else if (echo) process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
}

function check(node, prefix, postInstall, echo = true) {
	try {
		checkCandidate(node, prefix, postInstall, echo);
	} catch (error) {
		// Older candidates can embed destructive reset advice in validation errors.
		const detail = (error instanceof Error ? error.message : String(error)).replace(
			/pancode reset[^`\r\n]*/g,
			"pancode doctor --fix",
		);
		const quote = (value) =>
			process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
		const repair = `${process.platform === "win32" ? "& " : ""}${quote(node)} ${quote(entry(prefix))} doctor --fix`;
		throw new Error(
			`${detail}\nThe previous installation remains active, and it may predate this repair. Run the new version's own repair, then retry the installer: ${repair}`,
		);
	}
}

const DAY = 24 * 60 * 60 * 1000;
const FALLBACK_AGE = 7 * DAY;
const FALLBACK_NEWEST = 3;

// Command lines of this user's processes, plus the working directory of node and PanCode processes
// on Linux. `complete` is false whenever any part could not be read: an unseen process could
// still be loading files from an old prefix, so removal then falls back to age and count.
function processInventory(root) {
	if (process.platform === "linux") {
		// A local process table cannot see processes on another host sharing this filesystem.
		const local = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x794c7630, 0x2fc12fc1, 0xf2f52010]);
		try {
			if (!local.has(fs.statfsSync(root).type))
				return { complete: false, reason: `${root} is not on a local filesystem`, texts: [] };
		} catch (error) {
			return { complete: false, reason: `cannot identify the filesystem of ${root}: ${error.message}`, texts: [] };
		}
		const texts = [];
		try {
			for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
				try {
					if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
					const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
					texts.push(command);
					if (/(?:^|\/)node(?:\0|$)|pancode/.test(command.split("\0")[0])) texts.push(fs.readlinkSync(`/proc/${pid}/cwd`));
				} catch (error) {
					if (error.code !== "ENOENT" && error.code !== "ESRCH")
						return { complete: false, reason: `cannot inspect process ${pid}: ${error.code}`, texts };
				}
			}
		} catch (error) {
			return { complete: false, reason: `cannot list processes: ${error.message}`, texts };
		}
		return { complete: true, texts };
	}
	const command =
		process.platform === "darwin"
			? ["ps", ["-axww", "-o", "uid=,command="]]
			: process.platform === "win32"
				? [
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							"Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
						],
					]
				: null;
	if (!command) return { complete: false, reason: `no process inventory on ${process.platform}`, texts: [] };
	const result = spawnSync(command[0], command[1], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status !== 0)
		return {
			complete: false,
			reason: `${command[0]} failed: ${result.error?.message ?? (result.stderr || `exit ${result.status}`).trim()}`,
			texts: [],
		};
	return { complete: true, texts: parseProcessList(process.platform, result.stdout, process.getuid?.()) };
}

// macOS `ps -axww -o uid=,command=` lists every user; keep this user's lines. Windows CIM command
// lines carry no owner cheaply, so every process counts, which can only keep more.
function parseProcessList(platform, text, uid) {
	const lines = text.split(/\r?\n/u).filter((line) => line.trim());
	if (platform !== "darwin") return lines.map((line) => line.trim());
	const texts = [];
	for (const line of lines) {
		const entry = line.trimStart();
		const match = /^(\d+)\s+/u.exec(entry);
		if (match && (uid === undefined || Number(match[1]) === uid)) texts.push(entry.slice(match[0].length));
	}
	return texts;
}

function treeBytes(file) {
	let total = 0;
	const stack = [file];
	while (stack.length) {
		const next = stack.pop();
		let info;
		try {
			info = fs.lstatSync(next);
		} catch {
			continue;
		}
		total += info.size;
		if (info.isDirectory()) {
			try {
				for (const name of fs.readdirSync(next)) stack.push(path.join(next, name));
			} catch {
				/* An unreadable directory is counted by its own entry only. */
			}
		}
	}
	return total;
}

function formatBytes(bytes) {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
	return `${Math.round(bytes / 1e3)} kB`;
}

// One retention rule for versions/ and launchers/ on every platform. The keep set is
// the manifest, the launcher, the GUI service files, running-build and launch receipts, and the
// process inventory. With a complete inventory everything else goes at once; without one, keep
// anything younger than seven days and the newest three. Dead local launch receipts are removed.
// Entries prune has renamed for removal; the leading dot keeps them out of every listing.
const PRUNE_PREFIX = ".pancode-pruning-";

function prune(root, options = {}) {
	const now = options.now ?? Date.now();
	const windows = (options.platform ?? process.platform) === "win32";
	const norm = (text) => (windows ? text.toLowerCase().replaceAll("/", "\\") : text);
	const installed = record(root);
	const entries = [];
	// A version whose package.json cannot be read for a reason other than its absence (a
	// Windows file held open without sharing) is left alone, and said so, rather than skipped silently.
	const unreadable = [];
	for (const kind of ["versions", "launchers"]) {
		const dir = path.join(root, kind);
		for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			if (name.startsWith(".")) continue;
			const file = path.join(dir, name);
			const info = fs.lstatSync(file);
			if (kind === "launchers" ? !info.isFile() || !name.endsWith(".cjs") : !info.isDirectory()) continue;
			if (kind === "versions") {
				const owner = packageName(file);
				if (owner.error) unreadable.push({ kind, name, path: file, error: owner.error });
				if (owner.name !== PACKAGE_NAME) continue;
			}
			// Service files, session records and /proc carry resolved paths, the manifest the
			// logical ones; behind a symlinked home both spellings must protect the entry.
			let real = file;
			try {
				real = fs.realpathSync(file);
			} catch {}
			const spellings = real === file ? [file] : [file, real];
			entries.push({
				kind,
				name,
				path: file,
				mtimeMs: info.mtimeMs,
				needles: spellings.map((spelling) => norm(kind === "launchers" ? spelling : spelling + path.sep)),
				exact: spellings.map(norm),
			});
		}
	}
	const kept = new Map();
	let proof = true;
	let reason = "";
	const unproven = (why) => {
		if (proof) reason = why;
		proof = false;
	};
	const protect = (text, why) => {
		if (typeof text !== "string" || !text) return;
		const haystack = norm(text);
		for (const entry of entries)
			if (
				!kept.has(entry.path) &&
				(entry.needles.some((needle) => haystack.includes(needle)) || entry.exact.includes(haystack))
			)
				kept.set(entry.path, why);
	};
	for (const extra of options.keep ?? []) protect(extra, "being activated");
	protect(installed?.current, "current");
	protect(installed?.previous, "previous");
	protect(installed?.desktopManager, "desktop manager");
	const readText = (file, why) => {
		try {
			protect(fs.readFileSync(file, "utf8"), why);
		} catch (error) {
			if (error.code !== "ENOENT") unproven(`cannot read ${file}: ${error.code}`);
		}
	};
	if (installed?.launcher) readText(installed.launcher, "launcher");
	for (const file of Array.isArray(installed?.binLaunchers) ? installed.binLaunchers : [])
		if (typeof file === "string") readText(file, "launcher");
	// The native Windows launcher names its bootstrap in the sidecar, not in its own bytes.
	if (/\.exe$/iu.test(installed?.launcher ?? ""))
		readText(`${installed.launcher.slice(0, -".exe".length)}.launch`, "launcher");
	const state = pancodeRoot("state");
	const home = os.homedir();
	const listed = (dir, test) => {
		try {
			return fs
				.readdirSync(dir)
				.filter(test)
				.map((name) => path.join(dir, name));
		} catch (error) {
			if (error.code !== "ENOENT") unproven(`cannot list ${dir}: ${error.code}`);
			return [];
		}
	};
	for (const file of listed(path.join(state, "gui/background"), (name) => name.endsWith(".json")))
		readText(file, "GUI service");
	for (const file of listed(
		path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd/user"),
		(name) => /^pancode-gui-.*\.service$/.test(name),
	))
		readText(file, "GUI service");
	for (const file of listed(
		path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "applications"),
		(name) => /^dev\.pancode\..*\.desktop$/.test(name),
	))
		readText(file, "GUI service");
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code !== "ESRCH";
		}
	};
	for (const file of listed(path.join(state, "running-builds"), (name) => /^\d+\.json$/.test(name))) {
		try {
			const build = JSON.parse(fs.readFileSync(file, "utf8"));
			if (build.host === os.hostname() && Number.isInteger(build.pid) && !alive(build.pid)) continue;
			protect(build.root, "running session");
		} catch (error) {
			if (error.code !== "ENOENT") unproven(`unreadable session record ${file}`);
		}
	}
	const deadReceipts = [];
	for (const file of listed(launchReceipts(), (name) => name.endsWith(".json"))) {
		let receipt;
		try {
			receipt = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") unproven(`unreadable launch receipt ${file}`);
			continue;
		}
		if (!receipt || !Number.isInteger(receipt.pid) || receipt.pid <= 0 || typeof receipt.current !== "string") {
			unproven(`unreadable launch receipt ${file}`);
			continue;
		}
		if (receipt.host !== os.hostname()) {
			// Another host's session cannot be checked from here; honor it for a week.
			let fresh = true;
			try {
				fresh = now - fs.statSync(file).mtimeMs < FALLBACK_AGE;
			} catch {
				/* Treated as fresh. */
			}
			if (!fresh) continue;
		} else if (!alive(receipt.pid)) {
			deadReceipts.push(file);
			continue;
		}
		for (const held of [receipt.current, receipt.node, receipt.launcherNode]) protect(held, "running session");
	}
	const inventory = (options.inventory ?? processInventory)(root);
	if (!inventory.complete) unproven(inventory.reason);
	for (const text of inventory.texts) protect(text, "running process");
	if (proof === false) {
		for (const kind of ["versions", "launchers"]) {
			const own = entries.filter((entry) => entry.kind === kind).sort((a, b) => b.mtimeMs - a.mtimeMs);
			own.forEach((entry, index) => {
				if (kept.has(entry.path)) return;
				const refused = kind === "versions" && fs.existsSync(path.join(entry.path, ".pancode-refused-candidate"));
				if (!refused && (index < FALLBACK_NEWEST || now - entry.mtimeMs < FALLBACK_AGE)) kept.set(entry.path, "recent");
			});
		}
	}
	const removed = [];
	const skipped = [...unreadable];
	for (const entry of entries) {
		if (kept.has(entry.path)) continue;
		const bytes = treeBytes(entry.path);
		if (!options.dryRun) {
			// Windows deletes around a file held open and leaves a half-removed version that
			// no later prune recognizes. Renaming first fails while anything inside is open,
			// so a held entry stays whole; a rename that lands is finished now or by the next sweep.
			const doomed = path.join(path.dirname(entry.path), `${PRUNE_PREFIX}${entry.name}-${process.pid}`);
			try {
				fs.renameSync(entry.path, doomed);
			} catch (error) {
				skipped.push({ kind: entry.kind, name: entry.name, path: entry.path, error: error.code || error.message });
				continue;
			}
			try {
				fs.rmSync(doomed, { recursive: true });
			} catch {
				/* The next prune sweeps it. */
			}
		}
		removed.push({ kind: entry.kind, name: entry.name, path: entry.path, bytes });
	}
	if (!options.dryRun) {
		for (const kind of ["versions", "launchers"]) {
			const dir = path.join(root, kind);
			for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
				if (name.startsWith(PRUNE_PREFIX)) {
					try {
						fs.rmSync(path.join(dir, name), { recursive: true });
					} catch {
						/* Still held; the next prune retries. */
					}
				}
		}
		for (const file of deadReceipts) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				/* The next prune retries. */
			}
		}
	}
	return {
		proof,
		reason,
		dryRun: Boolean(options.dryRun),
		removed,
		skipped,
		kept: entries
			.filter((entry) => kept.has(entry.path))
			.map((entry) => ({ kind: entry.kind, name: entry.name, path: entry.path, why: kept.get(entry.path) })),
		deadReceipts: deadReceipts.length,
	};
}

function describePrune(result) {
	const count = (kind, one, many) => {
		const n = result.removed.filter((entry) => entry.kind === kind).length;
		return n ? `${n} ${n === 1 ? one : many}` : "";
	};
	const parts = [
		count("versions", "unused version", "unused versions"),
		count("launchers", "launcher helper", "launcher helpers"),
	].filter(Boolean);
	const lines = [];
	const verb = result.dryRun ? "would remove" : "removed";
	const versions = result.kept
		.filter((entry) => entry.kind === "versions")
		.map((entry) => `${entry.name} (${entry.why})`)
		.join(", ");
	if (parts.length)
		lines.push(
			`[install] ${verb} ${parts.join(", ")} (${formatBytes(result.removed.reduce((sum, entry) => sum + entry.bytes, 0))}); kept ${versions || "no versions"}`,
		);
	if (!result.proof && result.kept.some((entry) => entry.why === "recent"))
		lines.push(
			`[install] kept versions from the last 7 days and the newest ${FALLBACK_NEWEST}, because running processes cannot be ruled out: ${result.reason}`,
		);
	for (const entry of result.skipped)
		lines.push(`[install] could not remove ${entry.path} (${entry.error}); the next update retries`);
	return lines;
}

// A pin keeps the origin and time it was first set; reinstalling the same pin is not a new pin.
function pinRecord(old, pin, source) {
	if (!pin) return { pinSource: "", pinnedAt: "" };
	if (old?.versionPin === pin && old.pinSource) return { pinSource: old.pinSource, pinnedAt: old.pinnedAt };
	return { pinSource: source, pinnedAt: new Date().toISOString() };
}

function packageName(prefix) {
	try {
		const file = path.join(prefix, "lib", "node_modules", "pancode", "package.json");
		return { name: String(JSON.parse(fs.readFileSync(file, "utf8")).name || "") };
	} catch (error) {
		const missing = error.code === "ENOENT" || error.code === "ENOTDIR" || error instanceof SyntaxError;
		return { name: "", error: missing ? undefined : error.code || error.message };
	}
}

// Activation and rollback prune inside the installer's lock. Errors never block activation.
// Activation prunes again once the manifest moves; that pass alone names what it could not remove.
function pruneQuietly(root, keep, options = {}) {
	try {
		const result = prune(root, { keep });
		if (options.final === false) result.skipped = [];
		for (const line of describePrune(result)) process.stdout.write(`${line}\n`);
	} catch (error) {
		process.stderr.write(`[install] retained older versions: ${error.message}\n`);
	}
}

async function main() {
	const [action, root, ...args] = process.argv.slice(2);
	if (action === "probe") {
		// Whether the installers may reuse a kept version prefix: the --version check activation runs, on its own Node.
		checkCandidate(nodeOf(root), root, false, false);
		return;
	}
	if (action === "launch") {
		let current = record(root);
		if (!current) throw new Error(`No installer manifest in ${root}`);
		for (const file of [current.node, current.launcher, entry(current.current)]) {
			try {
				if (!fs.statSync(file).isFile()) throw new Error("not a file");
			} catch {
				throw new Error(
					`Incomplete managed installation: missing file ${file}; rerun the installer with the same install and bin directories`,
				);
			}
		}
		const removing = path.join(root, ".install-lock", "uninstall");
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		// A version or help answer, or a read-only doctor, is a probe (fleet preflight runs one on a remote
		// node): it writes no receipt, so it never creates the state root. Every other launch keeps one;
		// prune still sees a probe in the process table.
		let receipt = probe(args) ? null : path.join(launchReceipts(), `${process.pid}.json`);
		// Publish before importing, then recheck activation. A launcher paused across upgrades
		// must follow the new manifest rather than importing a prefix collection just removed.
		for (;;) {
			if (receipt) {
				try {
					fs.mkdirSync(path.dirname(receipt), { recursive: true });
					atomic(
						receipt,
						JSON.stringify({
							pid: process.pid,
							host: os.hostname(),
							root,
							current: current.current,
							node: current.node,
							launcherNode: process.execPath,
						}),
					);
				} catch (error) {
					// A sandbox or a shared home can leave the state root unwritable, or hide it. The
					// launch still runs; prune and uninstall see the process in the process table.
					if (!["EROFS", "EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error;
					receipt = null;
				}
			}
			const latest = record(root);
			if (latest.current === current.current && latest.node === current.node) break;
			current = latest;
		}
		if (receipt)
			process.on("exit", () => {
				try {
					fs.rmSync(receipt, { force: true });
				} catch {
					/* Uninstall may already have removed the receipt. */
				}
			});
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		let cli = entry(current.current);
		// The installed desktop host stays capable across rollback to an older CLI. It launches
		// the activated server, but keeps the owned Windows profile and error handling introduced here.
		if (current.desktopManager && args[0] === "gui" && (args[1] === "background" || args.length === 1)) {
			const manager = path.join(current.desktopManager, "lib/node_modules/pancode/dist/gui/server.js");
			const managerArgs = args[1] === "background" ? ["managed-background", ...args.slice(2)] : [];
			const result = spawnSync(current.node, [manager, ...managerArgs], {
				stdio: "inherit",
				env: {
					...process.env,
					PANCODE_PACKAGE_ROOT: path.dirname(path.dirname(path.dirname(cli))),
					PANCODE_DESKTOP_NODE: current.node,
				},
			});
			if (result.error) throw result.error;
			process.exitCode = result.status ?? 1;
			return;
		}
		// Cleanup must understand desktop state written by the newer installer even after rollback.
		if (current.desktopManager && args[0] === "uninstall") cli = entry(current.desktopManager);
		process.argv = [current.node, cli, ...args];
		if (path.resolve(current.node) === path.resolve(process.execPath)) {
			await import(pathToFileURL(cli).href);
		} else {
			const result = spawnSync(current.node, [cli, ...args], {
				stdio: "inherit",
				env: { ...process.env, PANCODE_LAUNCHER_PID: String(process.pid) },
			});
			if (result.error) throw result.error;
			process.exitCode = result.status ?? 1;
		}
		return;
	}
	if (action === "bin") {
		const [name, ...rest] = args;
		const current = record(root);
		if (!current) throw new Error(`No installer manifest in ${root}`);
		if (fs.existsSync(path.join(root, ".install-lock", "uninstall")))
			throw new Error("Uninstall is in progress; retry after it exits");
		const file = packageBins(current.current).get(name);
		if (!file || !fs.existsSync(file))
			throw new Error(
				`PanCode ${packageVersion(current.current) || current.current} has no ${name} command; pancode upgrade installs a version that has it`,
			);
		const result = spawnSync(current.node, [file, ...rest], {
			stdio: "inherit",
			env: { ...process.env, PANCODE_LAUNCHER_PID: String(process.pid) },
		});
		if (result.error) throw result.error;
		process.exitCode = result.status ?? 1;
		return;
	}
	if (action === "prune") {
		if (!record(root)) throw new Error(`No installer manifest in ${root}`);
		const dryRun = args.includes("--dry-run");
		const lock = path.join(root, ".install-lock");
		if (!dryRun) {
			try {
				fs.mkdirSync(lock);
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				process.stderr.write(
					`[install] installation locked at ${lock}; another install, upgrade or uninstall is running\n`,
				);
				process.exitCode = 75;
				return;
			}
		}
		try {
			if (!dryRun) {
				fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
				fs.writeFileSync(path.join(lock, "hostname"), `${os.hostname()}\n`);
				fs.writeFileSync(path.join(lock, "host"), `${installLockHost()}\n`);
			}
			const result = prune(root, { dryRun });
			if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
			else {
				const lines = describePrune(result);
				process.stdout.write(`${lines.length ? lines.join("\n") : "[install] nothing to remove"}\n`);
			}
		} finally {
			if (!dryRun) fs.rmSync(lock, { recursive: true, force: true });
		}
		return;
	}
	const old = record(root);
	if (action === "path-added") {
		if (!old || args[0] !== path.dirname(old.launcher)) throw new Error("PATH receipt does not match owned launcher");
		atomic(
			path.join(root, "install.json"),
			`${JSON.stringify({ ...old, pathAdded: true, pathEntry: args[0] }, null, 2)}\n`,
		);
		return;
	}
	if (action === "rollback") {
		if (!old?.previous || !inside(path.join(root, "versions"), old.previous))
			throw new Error("No owned previous install available");
		const node = nodeOf(old.previous);
		check(node, old.previous, false, false);
		// Two builds of one -dev version differ only by their prefix, so both labels name it then.
		const restoredVersion = packageVersion(old.previous);
		const replacedVersion = packageVersion(old.current);
		const same = restoredVersion !== "" && restoredVersion === replacedVersion;
		const label = (version, prefix) =>
			version ? (same ? `${version} (versions/${path.basename(prefix)})` : version) : prefix;
		const restored = label(restoredVersion, old.previous);
		const replaced = label(replacedVersion, old.current);
		// A pin follows the operator to the version they rolled back to. Left on the
		// replaced version, the next upgrade or installer run reinstalled exactly it.
		const pin = old.versionPin ? packageVersion(old.previous) || old.versionPin : "";
		const launcher = writeLauncher(root, node, old.launcher);
		const binLaunchers = syncBinLaunchers(root, old.previous, path.dirname(launcher), node, old.binLaunchers);
		const bundle = bundleInfo(old.previous);
		atomic(
			path.join(root, "install.json"),
			`${JSON.stringify(
				{
					...old,
					node,
					nodeVersion: bundle.node,
					nodeBuild: bundle.target,
					current: old.previous,
					previous: old.current,
					launcher,
					versionPin: pin,
					...pinRecord(old, pin, "rollback"),
					autoUpdate: false,
					binLaunchers,
				},
				null,
				2,
			)}\n`,
		);
		process.stdout.write(
			`[install] rolled back to ${restored}; ${replaced} stays installed and another rollback returns to it\n` +
				`[install] background updates disabled until explicitly enabled${pin ? `; pinned ${pin}` : ""}\n`,
		);
		pruneQuietly(root, []);
		return;
	}
	if (action !== "activate") throw new Error(`Unknown installer action ${action}`);
	let [current, launcher, channel, pin, autoUpdate, postInstall, pinSource, force] = args;
	const node = nodeOf(current);
	if (process.env.PANCODE_BACKGROUND_UPDATE === "1") {
		if (
			old?.current !== process.env.PANCODE_BACKGROUND_CURRENT ||
			!old?.autoUpdate ||
			old.versionPin ||
			old.channel !== channel ||
			process.env.PANCODE_AUTO_UPDATE === "0"
		)
			throw new Error("Background update policy changed; candidate not activated");
		pin = "-";
		autoUpdate = "1";
		postInstall = "0";
	}
	if (autoUpdate === "preserve") autoUpdate = old?.autoUpdate === false && !old?.versionPin ? "0" : "1";
	if (!inside(path.join(root, "versions"), current)) throw new Error("Candidate is outside owned install directories");
	// The candidate is in versions/ but not yet in the manifest.
	pruneQuietly(root, [current], { final: false });
	const fromVersion = old ? packageVersion(old.current) : "";
	const toVersion = packageVersion(current);
	if (channel === "latest" && /^\d+\.\d+\.\d+-/.test(fromVersion) && /^\d+\.\d+\.\d+$/.test(toVersion)) {
		process.stdout.write(
			`[install] Leaving the pre-release channel: installing stable ${toVersion} from ${fromVersion}.\n`,
		);
	}
	check(node, current, postInstall === "1");
	// Reinstalling the active bundle activates its own prefix again; the version before it stays the rollback target.
	const previous = old?.current && !samePath(old.current, current) ? old.current : old?.previous || "";
	// Activation has one commit point: launchers read this manifest on each invocation.
	launcher = writeLauncher(root, node, launcher);
	const binLaunchers = syncBinLaunchers(root, current, path.dirname(launcher), node, old?.binLaunchers, force === "1");
	const bundle = bundleInfo(current);
	atomic(
		path.join(root, "install.json"),
		`${JSON.stringify(
			{
				schema: SCHEMA,
				kind: "pancode-installer",
				node,
				nodeVersion: bundle.node,
				nodeBuild: bundle.target,
				current,
				desktopManager: current,
				previous,
				launcher,
				binLaunchers,
				channel,
				manager: process.env.PANCODE_INSTALL_MANAGER || old?.manager || "",
				pathAdded: old?.pathAdded === true,
				pathEntry: old?.pathEntry || "",
				versionPin: pin === "-" ? "" : pin,
				...pinRecord(old, pin === "-" ? "" : pin, pinSource || "version-flag"),
				autoUpdate: autoUpdate === "1" && (!pin || pin === "-"),
				installedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);
	pruneQuietly(root, []);
	process.stdout.write(
		`[install] background updates ${autoUpdate === "1" && (!pin || pin === "-") ? "enabled" : "disabled"}${pin && pin !== "-" ? `; pinned ${pin}` : ""}${previous ? "; previous version retained for rollback and running sessions" : ""}\n`,
	);
}

if (require.main === module)
	main().catch((error) => {
		process.stderr.write(`[install] ${error.message}\n`);
		process.exitCode = 1;
	});

module.exports = { prune, parseProcessList, describePrune };
