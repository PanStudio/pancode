// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isStrictDescendant } from "./path-containment.js";

/**
 * Resolve per-platform config/data/state/cache directories for PanCode.
 *
 * This is the single resolution order, documented once:
 *   1. Platform defaults.
 *      Linux: XDG Base Directory spec (XDG_CONFIG_HOME, XDG_DATA_HOME,
 *      XDG_STATE_HOME, XDG_CACHE_HOME).
 *      macOS: ~/Library/Application Support/pancode/{config,data,state} and
 *      ~/Library/Caches/pancode.
 *      Windows: %APPDATA%/pancode/{config,data} and %LOCALAPPDATA%/pancode/{state,cache}.
 *      Every root is distinct on every platform; no root nests inside another.
 *   2. PANCODE_HOME replaces all four roots symmetrically with
 *      PANCODE_HOME/{config,data,state,cache}.
 *   3. PANCODE_CONFIG_DIR / PANCODE_DATA_DIR / PANCODE_STATE_DIR / PANCODE_CACHE_DIR each
 *      override their one root and beat PANCODE_HOME (most specific wins).
 *
 * Role contents: config holds user-authored files (settings, credentials,
 * agents, skills, prompts, extensions, runtimes) and the records that vouch for
 * them (project and MCP approvals); data holds durable artifacts (memory,
 * vendored tools); state holds machine-produced session state (sessions,
 * telemetry, runs.json, recent-models.json, home.json, interviews, scratch);
 * cache holds disposable derived files.
 */

export interface PancodeDirs {
	config: string;
	data: string;
	state: string;
	cache: string;
}

export type PancodeDirRole = keyof PancodeDirs;

const PANCODE_DIR_ROLES: ReadonlyArray<PancodeDirRole> = ["config", "data", "state", "cache"];

const ROLE_ENV: Record<PancodeDirRole, string> = {
	config: "PANCODE_CONFIG_DIR",
	data: "PANCODE_DATA_DIR",
	state: "PANCODE_STATE_DIR",
	cache: "PANCODE_CACHE_DIR",
};

/**
 * Resolve an existing prefix physically and append any missing suffix.
 *
 * A lexical comparison misses aliases through a symlinked parent: `~/pancode`
 * and `/mnt/home/me/pancode` can be the same directory even when only the first
 * spelling exists. Lifecycle deletion needs identity rather than spelling, so
 * the layout check resolves as much of each path as the filesystem currently
 * knows without creating anything.
 */
function physicalPath(path: string): string {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/u, ""));
		cursor = parent;
	}
	try {
		cursor = realpathSync(cursor);
	} catch {
		// The directory finding reports unreadable paths. A lexical identity is
		// still useful here and never makes an unsafe layout look safer.
	}
	const joined = resolve(cursor, ...suffix);
	return process.platform === "win32" ? joined.toLowerCase() : joined;
}

/**
 * Problems that make root-scoped reset/uninstall ambiguous or destructive.
 *
 * The four roles are ownership boundaries. They must be absolute, distinct,
 * and non-nesting even when environment overrides are used. Otherwise a
 * seemingly scoped `reset --state`, or an uninstall with `--keep-config`, can
 * erase a root the preview promised to preserve.
 */
export function pancodeDirLayoutProblems(dirs: PancodeDirs = resolvePancodeDirs()): string[] {
	const problems: string[] = [];
	for (const role of PANCODE_DIR_ROLES) {
		if (!isAbsolute(dirs[role])) problems.push(`${role} root is relative: ${dirs[role]}`);
	}
	const physical = Object.fromEntries(PANCODE_DIR_ROLES.map((role) => [role, physicalPath(dirs[role])])) as Record<
		PancodeDirRole,
		string
	>;
	const home = physicalPath(homedir());
	const pancodeHome = pancodeHomeOrNull();
	const physicalPancodeHome = pancodeHome && isAbsolute(pancodeHome) ? physicalPath(pancodeHome) : null;
	for (const role of PANCODE_DIR_ROLES) {
		if (atOrAbove(physical[role], home)) problems.push(`${role} root is the home directory or above it: ${dirs[role]}`);
	}
	// PANCODE_HOME=$HOME would scatter config, data, state and cache directly in the home.
	if (
		pancodeHome !== null &&
		physicalPancodeHome !== null &&
		atOrAbove(physicalPancodeHome, home) &&
		PANCODE_DIR_ROLES.some(
			(role) => envOrNull(ROLE_ENV[role]) === null && physical[role] === physicalPath(join(pancodeHome, role)),
		)
	)
		problems.push(`PANCODE_HOME is the home directory or above it: ${pancodeHome}`);
	for (let leftIndex = 0; leftIndex < PANCODE_DIR_ROLES.length; leftIndex += 1) {
		const leftRole = PANCODE_DIR_ROLES[leftIndex];
		if (leftRole === undefined) continue;
		for (const rightRole of PANCODE_DIR_ROLES.slice(leftIndex + 1)) {
			const left = physical[leftRole];
			const right = physical[rightRole];
			if (left === right) {
				problems.push(`${leftRole} and ${rightRole} roots resolve to the same path: ${left}`);
			} else if (isStrictDescendant(right, left)) {
				problems.push(`${leftRole} root contains ${rightRole} root: ${left} -> ${right}`);
			} else if (isStrictDescendant(left, right)) {
				problems.push(`${rightRole} root contains ${leftRole} root: ${right} -> ${left}`);
			}
		}
	}
	return problems;
}

/** Refuse a layout in every writer, before it creates or removes a root. */
export function assertPancodeDirLayout(dirs: PancodeDirs = resolvePancodeDirs()): void {
	const problems = pancodeDirLayoutProblems(dirs);
	if (problems.length === 0) return;
	throw new Error(
		`Unsafe PanCode directory layout:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n` +
			"Set four absolute, distinct, non-nesting PANCODE_*_DIR paths, then run `pancode doctor`.",
	);
}

function atOrAbove(path: string, target: string): boolean {
	return path === target || isStrictDescendant(target, path);
}

/** The file whose presence marks a custom data or cache root as PanCode's own. */
const PANCODE_ROOT_MARKER = ".pancode-root";

const ROLE_OWNERSHIP_FILE: Record<PancodeDirRole, string> = {
	config: "settings.yaml",
	data: PANCODE_ROOT_MARKER,
	state: "home.json",
	cache: PANCODE_ROOT_MARKER,
};

/**
 * Top-level names PanCode creates in a cache root, taken from the code that creates
 * them. A `fleet-install-` or `update-` entry carries a generated suffix.
 */
const PANCODE_CACHE_ENTRIES: { names: ReadonlySet<string>; prefixes: ReadonlyArray<string> } = {
	names: new Set([
		"semantic",
		"grammars",
		"data-readers",
		"system-one",
		"codewiki-digests",
		"copilot-sdk",
		"component-npm",
		"run",
		"yazi",
		"mcp-catalogs",
		"skill-frontmatter.json",
		"provider-target-models",
		"provider-target-checks",
		"store",
		"sandbox-cache",
		"sandbox-cache-leases",
		"sandbox-npmrc",
		"v8-compile-cache",
		"update-logs",
	]),
	prefixes: ["fleet-install-", "update-"],
};

/** A lock or an interrupted atomic write sits beside the file it guards. */
function guardedName(entry: string): string {
	return entry.replace(/(?:\.lock)+(?:\.reclaim\.lock)?$/u, "").replace(/^\.(.+)\.tmp-.*$/u, "$1");
}

type EntryKind = "dir" | "file" | "other";

/** Entries of a real directory with their kind (a symlink is "other"), or null when it is not one. */
function directoryEntries(path: string): Array<{ name: string; kind: EntryKind }> | null {
	try {
		return readdirSync(path, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
		}));
	} catch {
		return null;
	}
}

/** The first entry under `path` (shown relative to `label`) that `accepts` refuses, or null. */
function firstRefused(
	path: string,
	label: string,
	accepts: (name: string, kind: EntryKind, full: string) => string | null | boolean,
): string | null {
	const entries = directoryEntries(path);
	if (entries === null) return label;
	for (const { name, kind } of entries) {
		const verdict = accepts(name, kind, join(path, name));
		if (verdict === false) return `${label}/${name}`;
		if (typeof verdict === "string") return verdict;
	}
	return null;
}

/** Directories of directories: `<id>/<version>` and the installers' staging directories beside a version. */
function versionedInstallTree(path: string, label: string): string | null {
	return firstRefused(path, label, (id, kind, full) =>
		kind === "dir" ? firstRefused(full, `${label}/${id}`, (_version, versionKind) => versionKind === "dir") : false,
	);
}

/**
 * What PanCode writes under each top-level name of a data root, taken from the code
 * that writes there. A name alone proves nothing: an operator's own `tools/` would
 * pass as PanCode's, and reset and uninstall would delete it. Each check returns the
 * first entry PanCode does not write, or null.
 */
const PANCODE_DATA_ENTRIES: Record<string, (path: string, label: string) => string | null> = {
	memory: (path, label) =>
		firstRefused(
			path,
			label,
			(name, kind) => kind === "file" && ["records.json", "regressions-cleared.jsonl"].includes(guardedName(name)),
		),
	tools: versionedInstallTree,
	components: versionedInstallTree,
	store: (path, label) =>
		firstRefused(path, label, (name, kind, full) =>
			name === "projects" && kind === "dir"
				? firstRefused(full, `${label}/projects`, (key, keyKind) => keyKind === "dir" && /^[0-9a-f]{16}$/u.test(key))
				: false,
		),
};

/** The first entry of an unmarked data or cache root that PanCode does not create there, or null. */
function foreignRootEntry(role: "data" | "cache", path: string): string | null {
	let entries: Array<{ name: string; kind: EntryKind }> | null = directoryEntries(path);
	if (entries === null) return "(unreadable)";
	entries = entries.filter(({ name }) => name !== PANCODE_ROOT_MARKER);
	if (role === "cache") {
		const { names, prefixes } = PANCODE_CACHE_ENTRIES;
		for (const { name } of entries) {
			const guarded = guardedName(name);
			if (!names.has(guarded) && !prefixes.some((prefix) => guarded.startsWith(prefix))) return name;
		}
		return null;
	}
	for (const { name, kind } of entries) {
		if (kind === "file" && guardedName(name) !== name && Object.hasOwn(PANCODE_DATA_ENTRIES, guardedName(name))) continue;
		const shape = Object.hasOwn(PANCODE_DATA_ENTRIES, name) ? PANCODE_DATA_ENTRIES[name] : undefined;
		if (shape === undefined || kind !== "dir") return name;
		const foreign = shape(join(path, name), name);
		if (foreign !== null) return foreign;
	}
	return null;
}

/**
 * Why a root must not be removed recursively, or null when it is PanCode's own.
 *
 * Only reset and uninstall ask. The layout check proves the four roots are
 * distinct; it does not prove a root is PanCode's. `PANCODE_CONFIG_DIR=~/.config`
 * passes it, and a recursive delete of that root takes every other tool's
 * configuration with it. A root qualifies by being the platform default, by
 * the basename `pancode`, or by holding the role's PanCode file, and never when
 * it is the home, above it, or a shared XDG base directory.
 */
export function removablePancodeRootProblem(role: PancodeDirRole, path: string): string | null {
	const physical = physicalPath(path);
	const home = physicalPath(homedir());
	if (atOrAbove(physical, home)) return "the home directory or above it";
	const shared = [
		xdgBaseDir(process.env.XDG_CONFIG_HOME, join(homedir(), ".config")),
		xdgBaseDir(process.env.XDG_DATA_HOME, join(homedir(), ".local", "share")),
		xdgBaseDir(process.env.XDG_STATE_HOME, join(homedir(), ".local", "state")),
		xdgBaseDir(process.env.XDG_CACHE_HOME, join(homedir(), ".cache")),
		join(homedir(), ".config"),
		join(homedir(), ".local", "share"),
		join(homedir(), ".local", "state"),
		join(homedir(), ".cache"),
		join(homedir(), ".local"),
	].map(physicalPath);
	if (shared.includes(physical)) return "a shared base directory other tools use";
	if (physical === physicalPath(platformDefaults()[role])) return null;
	if (basename(physical).toLowerCase() === "pancode") return null;
	if (existsSync(join(path, ROLE_OWNERSHIP_FILE[role]))) return null;
	// A PANCODE_HOME home that already held a `data` or `cache` of its own gets no marker there.
	// PanCode's config or state file beside it proves only that PanCode used the home, so the
	// directory itself must hold nothing but what PanCode creates there.
	const pancodeHome = pancodeHomeOrNull();
	if (
		pancodeHome !== null &&
		envOrNull(ROLE_ENV[role]) === null &&
		!atOrAbove(physicalPath(pancodeHome), home) &&
		physical === physicalPath(join(pancodeHome, role)) &&
		(existsSync(join(pancodeHome, "config", "settings.yaml")) ||
			existsSync(join(pancodeHome, "state", "home.json")) ||
			// The installer's launcher records a launch receipt before anything runs, so an uninstall run again after a
			// partial one finds a state root that holds only that.
			(role === "state" && onlyLaunchReceipts(path)))
	) {
		if (role === "config" || role === "state") return null;
		const foreign = foreignRootEntry(role, path);
		if (foreign === null) return null;
		return `no ${PANCODE_ROOT_MARKER} inside and it holds ${foreign}, which PanCode does not create there`;
	}
	// Callers splice this after "this one has" and inside parentheses, so it stays a noun phrase.
	return `no ${ROLE_OWNERSHIP_FILE[role]} inside and a name other than pancode`;
}

function onlyLaunchReceipts(stateDir: string): boolean {
	try {
		const entries = readdirSync(stateDir, { withFileTypes: true });
		return entries.length === 1 && entries[0]?.name === "launches" && entries[0].isDirectory();
	} catch {
		return false;
	}
}

let cachedConfigDir: string | undefined;
let cachedDataDir: string | undefined;
let cachedStateDir: string | undefined;
let cachedCacheDir: string | undefined;

function envOrNull(key: string): string | null {
	const v = process.env[key]?.trim();
	return v && v.length > 0 ? v : null;
}

/**
 * An XDG base directory variable by the spec's rule: empty or relative reads as
 * unset. Taking one literally made `XDG_STATE_HOME=` resolve the state root to
 * `pancode` under the cwd, which every writer then refused as unsafe.
 */
export function xdgBaseDir(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed && isAbsolute(trimmed) ? trimmed : fallback;
}

function platformDefaults(): PancodeDirs {
	const p = platform();
	const h = homedir();
	if (p === "win32") {
		const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
		return {
			config: join(appData, "pancode", "config"),
			data: join(appData, "pancode", "data"),
			state: join(localAppData, "pancode", "state"),
			cache: join(localAppData, "pancode", "cache"),
		};
	}
	if (p === "darwin") {
		const base = join(h, "Library", "Application Support", "pancode");
		return {
			config: join(base, "config"),
			data: join(base, "data"),
			state: join(base, "state"),
			cache: join(h, "Library", "Caches", "pancode"),
		};
	}
	const xdgConfig = xdgBaseDir(process.env.XDG_CONFIG_HOME, join(h, ".config"));
	const xdgData = xdgBaseDir(process.env.XDG_DATA_HOME, join(h, ".local", "share"));
	const xdgState = xdgBaseDir(process.env.XDG_STATE_HOME, join(h, ".local", "state"));
	const xdgCache = xdgBaseDir(process.env.XDG_CACHE_HOME, join(h, ".cache"));
	return {
		config: join(xdgConfig, "pancode"),
		data: join(xdgData, "pancode"),
		state: join(xdgState, "pancode"),
		cache: join(xdgCache, "pancode"),
	};
}

function ensureDir(dir: string, marker?: PancodeDirRole): string {
	const created = marker !== undefined && !existsSync(dir);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "EEXIST") throw err;
	}
	const s = statSync(dir);
	if (!s.isDirectory()) throw new Error(`Expected directory at ${dir}`);
	// Only a root PanCode created is marked: marking an existing directory would vouch for someone else's files.
	if (created) {
		try {
			writeFileSync(join(dir, PANCODE_ROOT_MARKER), `${marker}\n`, { flag: "wx" });
		} catch {
			// Without the marker a custom root is only kept at uninstall, never lost.
		}
	}
	return dir;
}

function pancodeHomeOrNull(): string | null {
	return envOrNull("PANCODE_HOME");
}

function resolveRole(specificVar: string, role: keyof PancodeDirs, defaults: PancodeDirs): string {
	const specific = envOrNull(specificVar);
	if (specific) return specific;
	const home = pancodeHomeOrNull();
	if (home) return join(home, role);
	return defaults[role];
}

export function resolvePancodeDirs(): PancodeDirs {
	const defaults = platformDefaults();
	return {
		config: resolveRole("PANCODE_CONFIG_DIR", "config", defaults),
		data: resolveRole("PANCODE_DATA_DIR", "data", defaults),
		state: resolveRole("PANCODE_STATE_DIR", "state", defaults),
		cache: resolveRole("PANCODE_CACHE_DIR", "cache", defaults),
	};
}

/** Credential isolation must compare resolved roots without creating directories or reading credentials. */
export function isPancodeHomeRelocated(): boolean {
	const defaults = platformDefaults();
	const dirs = resolvePancodeDirs();
	return (Object.keys(defaults) as Array<keyof PancodeDirs>).some(
		(role) => resolve(dirs[role]) !== resolve(defaults[role]),
	);
}

/**
 * True when PANCODE_INTEROP_HOME is `none`: PanCode reads no other agent's user
 * roots at all, not even one an agent home variable such as CLAUDE_CONFIG_DIR
 * names, and no other agent's quota credentials.
 */
export function interopDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PANCODE_INTEROP_HOME?.trim() === "none";
}

/**
 * The home whose foreign agent directories (`~/.claude/skills`, `~/.codex`, and
 * the rest of the interop registry) PanCode reads as user roots. Unset, that is
 * the operator's home wherever PANCODE_HOME puts PanCode's own directories, so
 * a PANCODE_HOME install still reads `~/.claude/skills` and an isolated run
 * that redirects HOME reads its own. PANCODE_INTEROP_HOME names another
 * home, or `none` for no foreign user roots (interopDisabled). Project roots
 * (`<cwd>/.claude/skills`) belong to the workspace and are unaffected.
 */
export function interopUserHome(env: NodeJS.ProcessEnv = process.env): string | null {
	if (interopDisabled(env)) return null;
	const named = env.PANCODE_INTEROP_HOME?.trim();
	return named ? resolve(named) : homedir();
}

/**
 * A per-agent home variable (CLAUDE_CONFIG_DIR, CODEX_HOME, ...) the operator
 * set is an explicit opt-in to that agent's root on every interop path: quota,
 * inventory, detection and the skill and prompt loaders. It holds even when
 * PanCode's home is relocated, and PANCODE_INTEROP_HOME=none overrides it.
 */
export function explicitAgentHome(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (interopDisabled(env)) return undefined;
	const value = name === undefined ? undefined : env[name]?.trim();
	return value ? value : undefined;
}

export function pancodeConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;
	const dirs = resolvePancodeDirs();
	assertPancodeDirLayout(dirs);
	cachedConfigDir = ensureDir(dirs.config);
	return cachedConfigDir;
}

export function pancodeDataDir(): string {
	if (cachedDataDir) return cachedDataDir;
	const dirs = resolvePancodeDirs();
	assertPancodeDirLayout(dirs);
	cachedDataDir = ensureDir(dirs.data, "data");
	return cachedDataDir;
}

export function pancodeStateDir(): string {
	if (cachedStateDir) return cachedStateDir;
	const dirs = resolvePancodeDirs();
	assertPancodeDirLayout(dirs);
	cachedStateDir = ensureDir(dirs.state);
	return cachedStateDir;
}

export function pancodeCacheDir(): string {
	if (cachedCacheDir) return cachedCacheDir;
	const dirs = resolvePancodeDirs();
	assertPancodeDirLayout(dirs);
	cachedCacheDir = ensureDir(dirs.cache, "cache");
	return cachedCacheDir;
}

/** The config root without creating it, for a reader that must leave the home as it found it. */
export function pancodeConfigPath(): string {
	return cachedConfigDir ?? resolvePancodeDirs().config;
}

export function pancodeDataPath(): string {
	return cachedDataDir ?? resolvePancodeDirs().data;
}

export function pancodeStatePath(): string {
	return cachedStateDir ?? resolvePancodeDirs().state;
}

/** The cache root without creating it, for a reader that must leave the home as it found it. */
export function pancodeCachePath(): string {
	return cachedCacheDir ?? resolvePancodeDirs().cache;
}

/**
 * True when the state root this process resolved is no longer on disk.
 *
 * `pancode uninstall` removes the whole root while processes holding session
 * writers, ledgers and telemetry journals are still running, and every writer under
 * the root mkdirs its parent back: `safeResourceWrite` does it before the temp
 * file, the state file lock does it before the critical section, a telemetry
 * journal writer does it before opening its segment. A write landing after the
 * removal therefore recreated the state home, so an uninstall that reported
 * success left one behind and the next `pancode` start read state from a home that
 * was supposed to be gone. The live case was the shutdown checkpoint, roughly
 * two minutes late, rebuilding the root around a meta.json and tree.json that
 * announced `lastCheckpointReason: shutdown`.
 *
 * "Removed" and "never created" are not the same thing, and only the first is a
 * reason to refuse a write. With no cached root this process has not resolved
 * one yet, so a writer creating it is an ordinary first run; the process
 * journal can reach its first record before anything else has called
 * `pancodeStateDir()`, and treating that as an uninstall would silently disable
 * it on a fresh install.
 * Reads the cache directly rather than `pancodeStateDir()` because the latter
 * creates the directory it is being asked about.
 *
 * Every writer under the state root calls this before it touches disk, and
 * again inside whatever lock it holds, because the removal can land while the
 * call waits for a sibling process to leave its critical section.
 */
export function stateRootRemoved(): boolean {
	if (cachedStateDir === undefined) return false;
	return !existsSync(cachedStateDir);
}

/**
 * `stateRootRemoved` for the config root: an approval recorded after an uninstall
 * must not bring the config home back.
 */
export function configRootRemoved(): boolean {
	if (cachedConfigDir === undefined) return false;
	return !existsSync(cachedConfigDir);
}

export function resetXdgCache(): void {
	cachedConfigDir = undefined;
	cachedDataDir = undefined;
	cachedStateDir = undefined;
	cachedCacheDir = undefined;
}
