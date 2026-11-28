// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Deterministic install-method detection for lifecycle verbs. `pancode upgrade`
 * must never offer the npm-global reinstall path to a source-checkout install:
 * the published package may not exist, and `npm install -g` would escape the
 * install's roots and touch the global npm prefix.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PACKAGE_NAME, resolvePackageRoot } from "../../core/package-root.js";
import { isStrictDescendant } from "../../core/path-containment.js";
import { shellQuote } from "../../core/shell-quote.js";
import { xdgBaseDir } from "../../core/xdg.js";

const DIST_CLI_SUFFIX = join("dist", "cli", "index.js");
// `pnpm run dev` and `node --import tsx src/cli/index.ts` run the checkout's source entry without dist/.
const SOURCE_CLI_SUFFIX = join("src", "cli", "index.ts");

/** The checkout root for a source install, built or run from source, or null for any other method. */
function sourceCheckoutRoot(entryPath: string | undefined = process.argv[1]): string | null {
	if (!entryPath || entryPath.trim().length === 0) return null;
	let entry: string;
	try {
		entry = realpathSync(resolve(entryPath));
	} catch {
		return null;
	}
	const suffix = [DIST_CLI_SUFFIX, SOURCE_CLI_SUFFIX].map((tail) => sep + tail).find((tail) => entry.endsWith(tail));
	if (suffix === undefined) return null;
	if (entry.split(sep).includes("node_modules")) return null;
	const root = entry.slice(0, entry.length - suffix.length);
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
		if (pkg.name !== PACKAGE_NAME) return null;
	} catch {
		return null;
	}
	const hasCheckoutMarker = existsSync(join(root, ".git")) || existsSync(join(root, "src", "cli", "index.ts"));
	return hasCheckoutMarker ? root : null;
}

/**
 * What scripts/install.sh recorded in `<install root>/install.json`: the
 * unpacked bundle the launcher runs, the Node inside it, and the bundle kept
 * for rollback.
 */
export interface InstallerRecord {
	/** The install root holding versions/ and install.json. */
	root: string;
	node: string;
	nodeVersion: string;
	nodeBuild: string;
	/** Bundle directory the launcher runs now. */
	current: string;
	/** Bundle directory kept for rollback, or null. */
	previous: string | null;
	launcher: string;
	channel: string;
	versionPin?: string;
	/** How the pin was set: an exact --version, a --bundle file, or a rollback. */
	pinSource?: "version-flag" | "bundle-file" | "rollback" | undefined;
	/** ISO time the pin was set. */
	pinnedAt?: string;
	installedAt?: string;
	autoUpdate?: boolean;
	manager?: string;
	pathAdded?: boolean;
	pathEntry?: string;
}

const INSTALLER_MANIFEST_KIND = "pancode-installer";
/** First line after the shebang of every launcher scripts/install.sh writes. */
export const INSTALLER_LAUNCHER_MARK = "# pancode-installer launcher";

export interface Installation {
	kind: "source" | "npm" | "pnpm" | "bun" | "installer" | "homebrew" | "winget" | "local" | "unknown";
	root: string;
	/** Stable entry used after replacement, independent of which launcher wins on PATH. */
	entry: string;
	/** The prefix belonging to this package, never npm's current default prefix. */
	prefix: string | null;
	/** Present for kind "installer". */
	installer?: InstallerRecord;
}

/** The resolved path; a missing tail is kept as written under its nearest resolved ancestor. */
export function realPathOf(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(realPathOf(parent), basename(absolute));
	}
}

/** True when `child` is `parent` or inside it, comparing resolved paths so a symlinked home matches. */
function pathWithin(parent: string, child: string): boolean {
	const real = realPathOf(parent);
	const target = realPathOf(child);
	const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	return fold(real) === fold(target) || isStrictDescendant(fold(target), fold(real));
}

/** The installer manifest under `installRoot`, or null when there is none or it is not ours. */
export function readInstallerRecord(installRoot: string): InstallerRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8"));
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (record.schema !== 3) return null;
	const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
	// install.sh records logical paths; a root reached through a symlinked ~/.local or HOME
	// still owns them when they resolve inside it.
	const owned = (folder: string, file: string) =>
		isAbsolute(file) &&
		(isStrictDescendant(file, join(installRoot, folder)) ||
			isStrictDescendant(realPathOf(file), realPathOf(join(installRoot, folder))));
	if (!owned("versions", text("current")) || !owned("versions", text("node"))) return null;
	if (text("previous") && !owned("versions", text("previous"))) return null;
	if (text("kind") !== INSTALLER_MANIFEST_KIND || text("current") === "" || text("node") === "") return null;
	return {
		root: installRoot,
		node: text("node"),
		nodeVersion: text("nodeVersion"),
		nodeBuild: text("nodeBuild"),
		current: text("current"),
		previous: text("previous") || null,
		launcher: text("launcher"),
		channel: text("channel") || "latest",
		versionPin: text("versionPin"),
		pinSource: (["version-flag", "bundle-file", "rollback"] as const).find((value) => value === text("pinSource")),
		pinnedAt: text("pinnedAt"),
		installedAt: text("installedAt"),
		autoUpdate: record.autoUpdate === true,
		manager: text("manager"),
		pathAdded: record.pathAdded === true,
		pathEntry: text("pathEntry"),
	};
}

/** Everything an installer creates inside its root, which may be a directory it shares with other files. */
export const INSTALLER_OWNED_ENTRIES = [
	"versions",
	"launchers",
	"launcher.cjs",
	".installer-owner",
	"install.json",
] as const;

/** Where the installers put their root when none is named: `default_install_root` in scripts/install.sh, and install.ps1. */
export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
	const named = env.PANCODE_INSTALL_DIR?.trim();
	if (named) return resolve(named);
	const pancodeHome = env.PANCODE_HOME?.trim();
	if (pancodeHome) return join(pancodeHome, "install");
	const home = homedir();
	if (process.platform === "win32")
		return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pancode", "install");
	if (process.platform === "darwin") return join(home, "Library", "Application Support", "pancode", "install");
	return join(xdgBaseDir(env.XDG_DATA_HOME, join(home, ".local", "share")), "pancode-install");
}

/** The launcher path that belongs to this installation, whether or not anything is there. */
export function launcherPathFor(
	installation: Installation,
	env: NodeJS.ProcessEnv = process.env,
	invoked: string | undefined = process.argv[1],
): string {
	if (installation.kind === "installer" && installation.installer?.launcher) return installation.installer.launcher;
	if (installation.kind === "npm" && installation.prefix) return join(installation.prefix, "bin", "pancode");
	// install-local.sh may have linked it into any PANCODE_BIN_DIR; the symlink this process was started through is
	// that launcher, whatever the variable says now.
	if (invoked && basename(invoked) === "pancode") {
		try {
			const link = resolve(invoked);
			if (lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(installation.entry)) return link;
		} catch {
			// An entry or a link that cannot be read leaves the configured location.
		}
	}
	return join(env.PANCODE_BIN_DIR?.trim() || join(homedir(), ".local", "bin"), "pancode");
}

/**
 * An installer root this binary does not run from, left behind when the launcher
 * moved to a checkout or a package manager. Nothing runs its pruning any more, so
 * `paths`, `doctor` and `uninstall` have to name it or it is invisible.
 */
export function inactiveInstallerRecord(installation: Installation): InstallerRecord | null {
	if (installation.installer) return null;
	const record = readInstallerRecord(defaultInstallRoot());
	// A root this binary runs from is never inactive, whatever path spelling reached it.
	if (
		record === null ||
		pathWithin(record.root, installation.root) ||
		pathWithin(record.root, installation.entry) ||
		pathWithin(record.root, process.execPath)
	)
		return null;
	return record;
}

/** The package root inside an unpacked bundle. */
export function installerPackageRoot(prefix: string): string {
	return join(prefix, "lib", "node_modules", "pancode");
}

/**
 * An unpacked bundle is `<install root>/versions/<version>`, and the root
 * holds the manifest. A directory of that shape with no such manifest is not
 * an installer install.
 */
function installerRecordForPrefix(prefix: string): InstallerRecord | null {
	const versions = dirname(prefix);
	if (basename(versions) !== "versions") return null;
	return readInstallerRecord(dirname(versions));
}

/**
 * pnpm 11 and later link a global package from `<pnpm home>/store/v<n>/links/...`,
 * reached through `<pnpm home>/global/v<n>/<id>/node_modules`. A project can share
 * that store too, so the root counts as global only when pnpm's global directory
 * links to it.
 */
function pnpmGlobalStoreLink(parts: string[], root: string): boolean {
	const at = parts.findIndex(
		(part, i) => part === "store" && /^v\d+$/.test(parts[i + 1] ?? "") && parts[i + 2] === "links",
	);
	if (at < 1) return false;
	const globalDir = join(parts.slice(0, at).join(sep) || sep, "global", parts[at + 1] as string);
	try {
		return readdirSync(globalDir).some((id) => {
			try {
				return realpathSync(join(globalDir, id, "node_modules", PACKAGE_NAME)) === root;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

/** Inspect layout without running a package manager or consulting the network. */
export function inspectInstallation(entryPath = process.argv[1], fallbackRoot = resolvePackageRoot()): Installation {
	let entry = join(fallbackRoot, DIST_CLI_SUFFIX);
	try {
		if (entryPath) entry = realpathSync(resolve(entryPath));
	} catch {
		// A missing launcher still leaves the package root available for recovery advice.
	}
	const suffix = [DIST_CLI_SUFFIX, SOURCE_CLI_SUFFIX].map((tail) => sep + tail).find((tail) => entry.endsWith(tail));
	const root = suffix !== undefined ? entry.slice(0, -suffix.length) : fallbackRoot;
	const base = { root, entry: join(root, DIST_CLI_SUFFIX), prefix: null };
	try {
		if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== PACKAGE_NAME)
			return { ...base, kind: "unknown" };
	} catch {
		return { ...base, kind: "unknown" };
	}
	if (sourceCheckoutRoot(base.entry) !== null || sourceCheckoutRoot(entry) !== null) return { ...base, kind: "source" };
	const parts = root.split(sep);
	if (parts.includes("Cellar") && parts.includes("pancode")) return { ...base, kind: "homebrew" };
	const bundleSuffix = sep + join("lib", "node_modules", "pancode");
	if (root.endsWith(bundleSuffix)) {
		const prefix = root.slice(0, -bundleSuffix.length);
		const installer = installerRecordForPrefix(prefix);
		if (installer !== null)
			return {
				...base,
				kind: installer.manager === "winget" && process.env.PANCODE_MANAGER_UNINSTALL !== "1" ? "winget" : "installer",
				prefix,
				installer,
			};
	}
	const npmSuffix = sep + join("lib", "node_modules", PACKAGE_NAME);
	if (root.endsWith(npmSuffix)) return { ...base, kind: "npm", prefix: root.slice(0, -npmSuffix.length) || sep };
	const windowsNpmSuffix = sep + join("node_modules", PACKAGE_NAME);
	if (process.platform === "win32" && root.endsWith(windowsNpmSuffix)) {
		const prefix = root.slice(0, -windowsNpmSuffix.length);
		if (existsSync(join(prefix, "pancode.cmd"))) return { ...base, kind: "npm", prefix };
	}
	// Store paths also occur in project-local and temporary installs. Only known
	// global layouts should receive registry nudges or global-manager instructions.
	if (parts.includes("pnpm") && parts.some((part, i) => part === "global" && /^\d+$/.test(parts[i + 1] ?? "")))
		return { ...base, kind: "pnpm" };
	if (pnpmGlobalStoreLink(parts, root)) return { ...base, kind: "pnpm" };
	if (root.includes(sep + join("install", "global", "node_modules") + sep)) return { ...base, kind: "bun" };
	if (parts.includes("node_modules")) return { ...base, kind: "local" };
	return { ...base, kind: "unknown" };
}

export function npmInstallArgs(installation: Installation, channel: string): string[] {
	if (installation.kind !== "npm" || !installation.prefix)
		throw new Error(
			"Automatic upgrade requires an identified npm global installation. Use the original package manager.",
		);
	return ["install", "-g", "--prefix", installation.prefix, `${PACKAGE_NAME}@${channel}`];
}

export interface UpgradeInvocation {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
}

/** A resolved version makes "Installing with" name the exact version that runs. */
export function npmUpgradeInvocation(
	installation: Installation,
	version: string,
	runtime: { windows: boolean; node: string; npmCli: string | null },
): UpgradeInvocation {
	const args = npmInstallArgs(installation, version);
	if (!runtime.windows) return { command: "npm", args, env: {} };
	if (runtime.npmCli === null)
		throw new Error("Cannot locate npm-cli.js beside Node; use npm install -g from your terminal");
	return { command: runtime.node, args: [runtime.npmCli, ...args], env: {} };
}

/** The installer run that moves an installer install to its channel's newest bundle. */
export function installerUpgradeInvocation(
	installation: Installation,
	opts: { channel: string; channelExplicit: boolean; leavePrerelease?: boolean },
	windows: boolean,
): UpgradeInvocation {
	const record = installation.installer;
	if (installation.kind !== "installer" || record === undefined)
		throw new Error("installer upgrade needs an install.sh installation");
	const args = windows
		? [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(installation.root, "scripts", "install.ps1"),
				"-Channel",
				opts.channel,
				"-InstallDir",
				record.root,
				"-BinDir",
				dirname(record.launcher),
				"-NoPostInstall",
			]
		: [
				join(installation.root, "scripts", "install.sh"),
				"--channel",
				opts.channel,
				"--install-dir",
				record.root,
				"--bin-dir",
				dirname(record.launcher),
				"--no-post-install",
			];
	if (record.versionPin && !opts.channelExplicit) args.push(windows ? "-Version" : "--version", record.versionPin);
	// The installers refuse a channel older than the active version unless the
	// operator asked to leave a pre-release for stable (`--channel latest`).
	if (opts.leavePrerelease) args.push(windows ? "-LeavePrerelease" : "--leave-prerelease");
	return { command: windows ? "powershell.exe" : "sh", args, env: {} };
}

export function formatUpgradeInvocation(invocation: UpgradeInvocation, windows = process.platform === "win32"): string {
	if (windows) {
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const overrides = Object.entries(invocation.env).map(([name, value]) =>
			value === undefined ? `Remove-Item Env:${name};` : `$env:${name}=${quote(value)};`,
		);
		return [...overrides, "&", ...[invocation.command, ...invocation.args].map(quote)].join(" ");
	}
	const quote = (value: string) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : shellQuote(value));
	const removed = Object.entries(invocation.env).filter(([, value]) => value === undefined);
	const prefix = removed.flatMap(([name]) => ["-u", name]);
	const overrides = Object.entries(invocation.env).flatMap(([name, value]) =>
		value === undefined ? [] : [`${name}=${quote(value)}`],
	);
	return [
		...(prefix.length ? ["env", ...prefix] : []),
		...overrides,
		...[invocation.command, ...invocation.args].map(quote),
	].join(" ");
}

export function installationCommand(
	installation: Installation,
	action: "upgrade" | "uninstall" | "check",
	channel = "latest",
): string {
	// A check asks what the channel would install and changes nothing. The beta channel follows the newer of the
	// latest and beta tags, and beta is published only while a pre-release is current, so it lists every tag.
	if (action === "check") {
		const query = channel === "beta" ? `${PACKAGE_NAME} dist-tags` : `${PACKAGE_NAME}@${channel} version`;
		if (installation.kind === "npm") return `npm view ${query}`;
		if (installation.kind === "pnpm") return `pnpm view ${query}`;
		if (installation.kind === "bun") return `bun info ${query}`;
		if (installation.kind === "homebrew") return "brew outdated pancode";
		if (installation.kind === "winget") return "winget show --id PanCode.PanCode --exact";
		return `# Ask the package manager that installed ${shellQuote(installation.root)} which version it has.`;
	}
	const spec = action === "upgrade" ? `${PACKAGE_NAME}@${channel}` : PACKAGE_NAME;
	if (installation.kind === "npm" && installation.prefix)
		return `npm ${action === "upgrade" ? "install" : "uninstall"} -g --prefix ${shellQuote(installation.prefix)} ${spec}`;
	if (installation.kind === "installer" && installation.installer) {
		const record = installation.installer;
		if (process.platform === "win32")
			return action === "upgrade"
				? `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(installation.root, "scripts", "install.ps1")}" -Channel ${channel} -InstallDir "${record.root}" -BinDir "${dirname(record.launcher)}"`
				: "pancode uninstall";
		return action === "upgrade"
			? `sh ${shellQuote(join(installation.root, "scripts", "install.sh"))} --channel ${channel} --install-dir ${shellQuote(record.root)} --bin-dir ${shellQuote(dirname(record.launcher))}`
			: "pancode uninstall";
	}
	if (installation.kind === "homebrew") return `brew ${action} pancode`;
	if (installation.kind === "winget") return `winget ${action} --id PanCode.PanCode --exact`;
	if (installation.kind === "pnpm") return `pnpm ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "bun") return `bun ${action === "upgrade" ? "add" : "remove"} -g ${spec}`;
	if (installation.kind === "source")
		return action === "upgrade"
			? `cd ${shellQuote(installation.root)}\ngit fetch --tags\n# Check out the desired release tag, then:\npnpm run install:local`
			: `# Remove this checkout after unlinking its launcher:\n# ${shellQuote(installation.root)}`;
	return `# Use the original package manager for ${shellQuote(installation.root)}.`;
}
