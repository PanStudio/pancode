// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { repositoryRoot } from "../../core/project-root.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { discoverSecretMasks } from "../../core/sandbox/secret-files.js";
import {
	type SandboxAvailability,
	type SandboxBackend,
	type SandboxMaskedPath,
	type SandboxMode,
	type UnixSocketMode,
	WORKER_SANDBOX_SPEC_VERSION,
} from "../../core/sandbox/types.js";
import {
	composeWorkerSandboxInvocation,
	settingsFileMasks,
	workerSandboxMasks,
} from "../../core/sandbox/worker-process.js";
import { workspaceTrustDirectory } from "../../core/workspace-trust.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { isExtensionId } from "./discovery.js";
import type { ResolvedPathGrant } from "./path-grants.js";

/**
 * The declaration a runtime starts with in a read-only session, which leaves
 * every user file unchanged. Its workspace write roots are dropped, so none is
 * created or bound; its `store` root stays, being PanCode's own home. A runtime
 * that may run programs is refused unless bubblewrap confines them, since a
 * program escapes the Node flags and Seatbelt leaves the shared temp
 * directories writable.
 */
export function readOnlyRuntimeDeclaration(
	declaration: ExtensionRuntimeDeclarationV2,
	availability: SandboxAvailability = sandboxAvailability(),
): ExtensionRuntimeDeclarationV2 {
	if ((declaration.binaries?.length ?? 0) > 0)
		throw new Error("this session is read-only and the runtime declares external programs that run outside the sandbox");
	if (declaration.permissions.exec && !(availability.available && availability.backend === "bwrap"))
		throw new Error(
			"this session is read-only and the runtime may run programs, which only a bubblewrap sandbox keeps from changing user files",
		);
	const write = declaration.permissions.fs.write.filter((entry) => entry === "store");
	return { ...declaration, permissions: { ...declaration.permissions, fs: { ...declaration.permissions.fs, write } } };
}

/**
 * What confines one runtime beyond its Node permission flags, said the way
 * `/extensions` shows it. The flags are a seat belt against mistakes; the OS
 * sandbox is what actually refuses a socket or a write outside the roots.
 */
export interface ExtensionSandboxReport {
	/** The OS backend wrapping the child, or null when only the Node flags apply. */
	backend: SandboxBackend | null;
	/** `blocked` and `allowed` follow the declaration; `unenforced` is a declared `net: false` nothing enforces. */
	network: "blocked" | "allowed" | "unenforced";
	/** Why no OS sandbox wrapped the child, when none did. */
	reason?: string;
}

export interface ExtensionLaunchRoots {
	workspace: string;
	/** The private package copy; its parent is the per-runtime temporary directory. */
	packageCopy: string;
	storeDir: string;
	bootstrap: string;
	/** The project directory of a runtime that declares `runtime.state.project`, and whether this session may write it. */
	project?: { dir: string; writable: boolean };
	/** Paths the operator named on this verb's command line: write roots bound writable, existing read paths readable. */
	grants?: ReadonlyArray<ResolvedPathGrant>;
}

export interface ExtensionLaunch {
	file: string;
	args: string[];
	report: ExtensionSandboxReport;
}

/** Paths a runtime tool or a subprocess it starts must never write: project and user installed trees, state, trust and policy. */
function managedPaths(workspace: string): string[] {
	return [path.join(workspace, ".pancode"), pancodeConfigDir(), workspaceTrustDirectory()].map((entry) =>
		canonicalizeExistingPath(entry),
	);
}

/**
 * Refuse a declared write root that reaches PanCode's own installed resources,
 * state, trust, policy or Git metadata, by name, as a broad ancestor or through an alias.
 * Roots resolve physically here, so a link inside the workspace cannot name
 * `.pancode` under another spelling, and a root that lands outside the
 * workspace is refused too.
 */
function assertDeclaredWriteRoots(declaration: ExtensionRuntimeDeclarationV2, workspace: string): void {
	const home = canonicalizeExistingPath(workspace);
	const managed = managedPaths(home);
	for (const entry of declaration.permissions.fs.write) {
		if (entry === "store") continue;
		const root = canonicalizeExistingPath(path.join(home, entry));
		if (!isSameOrDescendant(root, home)) throw new Error(`declared write root ${entry} resolves outside the workspace`);
		const hit = managed.find(
			(protectedPath) => isSameOrDescendant(root, protectedPath) || isSameOrDescendant(protectedPath, root),
		);
		if (hit) throw new Error(`declared write root ${entry} overlaps PanCode-managed path ${hit}`);
		// The sandbox keeps Git metadata read-only, and creating the root would plant a .git in a non-repository.
		if (isSameOrDescendant(root, path.join(home, ".git")))
			throw new Error(`declared write root ${entry} is inside Git metadata`);
	}
}

/**
 * Create the declared write roots that do not exist yet, so the OS sandbox binds
 * exactly each declared directory and never a parent. This runs after
 * `assertDeclaredWriteRoots`, one component at a time from the physical
 * workspace, and refuses any component that is not a plain directory: a root
 * never exists through a link, and a link cannot be swapped in underneath it.
 */
export function prepareDeclaredWriteRoots(declaration: ExtensionRuntimeDeclarationV2, workspace: string): string[] {
	assertDeclaredWriteRoots(declaration, workspace);
	const home = canonicalizeExistingPath(workspace);
	const created: string[] = [];
	for (const entry of declaration.permissions.fs.write) {
		if (entry === "store") continue;
		created.push(...plainDirectories(home, entry.split("/"), `declared write root ${entry}`));
	}
	return created;
}

/** Create `segments` below `base` one component at a time, refusing a component that is not a plain directory. */
function plainDirectories(base: string, segments: ReadonlyArray<string>, label: string): string[] {
	const created: string[] = [];
	let current = base;
	for (const segment of segments) {
		if (segment === ".") continue;
		current = path.join(current, segment);
		try {
			mkdirSync(current);
			created.push(current);
		} catch (error) {
			// An existing component is checked below; any other failure leaves the root unusable.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(current).isDirectory())
			throw new Error(`${label} passes through ${current}, which is not a plain directory`);
	}
	return created;
}

/**
 * The project directory `runtime.state.project` grants: `<repository root>/.pancode/data/<id>/`, or the workspace's
 * own `.pancode/data/<id>/` outside a repository. The default `.pancode/.gitignore` already keeps `data/` untracked.
 */
export function extensionProjectDir(workspace: string, extensionId: string): { root: string; dir: string } {
	if (!isExtensionId(extensionId)) throw new Error(`invalid extension id '${extensionId}' for project directory`);
	const home = canonicalizeExistingPath(workspace);
	const root = repositoryRoot(home) ?? home;
	const dataRoot = path.join(root, ".pancode", "data");
	const dir = path.join(dataRoot, extensionId);
	if (path.dirname(dir) !== dataRoot || path.basename(dir) !== extensionId)
		throw new Error(`project directory for '${extensionId}' escapes .pancode/data/`);
	return { root, dir };
}

/** Create the project directory before launch so the sandbox binds exactly it; the components it created. */
export function prepareProjectDir(project: { root: string; dir: string }): string[] {
	return plainDirectories(
		project.root,
		path.relative(project.root, project.dir).split(path.sep),
		"the project directory",
	);
}

/**
 * Verify that any existing components of `project.dir` below `project.root` are plain directories, without creating
 * missing ones. Used in read-only sessions so a symlink along `.pancode/data/<id>` is still refused.
 */
export function assertPlainProjectDir(project: { root: string; dir: string }): void {
	let current = project.root;
	for (const segment of path.relative(project.root, project.dir).split(path.sep)) {
		if (segment === "" || segment === ".") continue;
		current = path.join(current, segment);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!stat.isDirectory())
			throw new Error(`the project directory passes through ${current}, which is not a plain directory`);
	}
}

/**
 * Remove the directories `prepareDeclaredWriteRoots` created, deepest first, when
 * they are still empty, so a runtime leaves no empty roots behind in the
 * workspace. A non-recursive rmdir never removes content or a pre-existing root.
 */
export function releaseDeclaredWriteRoots(created: ReadonlyArray<string>): void {
	for (const directory of [...created].reverse()) {
		try {
			rmdirSync(directory);
		} catch {
			/* Not empty, already gone, or replaced: leave it. */
		}
	}
}

/**
 * Hide PanCode's settings.yaml, which can hold target auth headers, and every copy beside it. The whole config directory is
 * masked: a settings save renames a new file over settings.yaml, which would drop a mask mounted on the old file, and a
 * backup written after launch would never have had one. The child reads nothing there, so only a config directory that
 * holds one of its own roots falls back to masking the files present at launch.
 */
function settingsMasks(roots: ExtensionLaunchRoots, writable: Iterable<string>): SandboxMaskedPath[] {
	const config = canonicalizeExistingPath(pancodeConfigDir());
	const needed = [roots.workspace, roots.packageCopy, roots.bootstrap, roots.storeDir, ...writable];
	if (needed.some((entry) => isSameOrDescendant(canonicalizeExistingPath(entry), config))) return settingsFileMasks();
	return [{ path: config, kind: "directory" }];
}

/**
 * Hide other extensions' `.pancode/data/<other>/` directories behind an empty tmpfs over `.pancode/data/`, revealing
 * only this runtime's own `project` directory when it exists. Keeps an extension with workspace read or exec access
 * from reading another extension's project data.
 */
function projectDataMask(
	workspace: string,
	project: { dir: string; writable: boolean } | undefined,
): SandboxMaskedPath[] {
	const dataDir = path.join(repositoryRoot(workspace) ?? workspace, ".pancode", "data");
	try {
		if (!lstatSync(dataDir).isDirectory()) return [];
	} catch {
		return [];
	}
	const reveal: Array<{ source: string; target: string; writable?: boolean }> = [];
	if (project !== undefined) {
		try {
			if (lstatSync(project.dir).isDirectory())
				reveal.push({
					source: project.dir,
					target: project.dir,
					...(project.writable ? { writable: true } : {}),
				});
		} catch {
			// In a read-only session the directory may not exist yet: keep the data root masked with nothing revealed.
		}
	}
	return [{ path: dataDir, kind: "directory", ...(reveal.length > 0 ? { reveal } : {}) }];
}

/**
 * Secret files (`.env`, private keys, token files) in the workspace and in each other directory the manifest declares
 * readable, masked as a dispatched worker's are. `home` is left to the home credential masks; a scan of the whole home
 * would hit the scan cap long before it found anything those masks miss.
 */
function workspaceSecretMasks(
	declaration: ExtensionRuntimeDeclarationV2,
	workspace: string,
	base: ReadonlyArray<SandboxMaskedPath>,
	grants: ReadonlyArray<ResolvedPathGrant>,
): SandboxMaskedPath[] {
	const workspaceRoots = [workspace];
	for (const entry of declaration.permissions.fs.read)
		if (entry !== "workspace" && entry !== "home")
			workspaceRoots.push(path.isAbsolute(entry) ? entry : path.join(workspace, entry));
	// A granted file is the operator's explicit choice; a granted directory is scanned as the workspace is.
	for (const grant of grants)
		if (statSync(grant.canonical, { throwIfNoEntry: false })?.isDirectory() === true)
			workspaceRoots.push(grant.canonical);
	return discoverSecretMasks({ workspaceRoots }, base).masks;
}

/**
 * Compose the child's launch. With an OS sandbox the child runs read-only
 * outside its declared write roots, with secrets masked, PanCode-managed paths
 * re-bound read-only, new Unix-domain sockets refused unless the operator
 * allowed them, and an empty network namespace unless `net` is declared.
 * Without one the child runs under the Node flags alone and the report says so,
 * so a declared `net: false` is never presented as enforced. Under
 * `safety.sandbox: required` it does not run at all, as a worker would not.
 */
export function planExtensionLaunch(input: {
	declaration: ExtensionRuntimeDeclarationV2;
	roots: ExtensionLaunchRoots;
	argv: ReadonlyArray<string>;
	availability?: SandboxAvailability;
	/** The operator's `safety.sandboxUnixSockets`; absent blocks them, as in every other sandbox. */
	unixSockets?: UnixSocketMode;
	/** The operator's `safety.sandbox`; `required` refuses a launch no OS sandbox confines. */
	sandboxMode?: SandboxMode;
}): ExtensionLaunch {
	const launch = planLaunch(input);
	if (input.sandboxMode === "required" && launch.report.backend === null)
		throw new Error(
			`safety.sandbox is "required" but no OS sandbox confines this extension runtime (${launch.report.reason ?? "unavailable"}); it was not started`,
		);
	return launch;
}

function planLaunch(input: {
	declaration: ExtensionRuntimeDeclarationV2;
	roots: ExtensionLaunchRoots;
	argv: ReadonlyArray<string>;
	availability?: SandboxAvailability;
	unixSockets?: UnixSocketMode;
}): ExtensionLaunch {
	const { declaration, roots, argv } = input;
	const net = declaration.permissions.net;
	const availability = input.availability ?? sandboxAvailability();
	const [file, ...args] = argv;
	if (file === undefined) throw new Error("extension launch has no command");
	const unenforced: ExtensionLaunch = {
		file,
		args,
		report: {
			backend: null,
			network: net ? "allowed" : "unenforced",
			reason: availability.reason ?? "no OS sandbox backend",
		},
	};
	if (!availability.available) return unenforced;
	const workspace = canonicalizeExistingPath(roots.workspace);
	const writable = new Set<string>();
	if (declaration.permissions.fs.write.includes("store")) writable.add(roots.storeDir);
	for (const entry of declaration.permissions.fs.write) if (entry !== "store") writable.add(path.join(workspace, entry));
	const grants = roots.grants ?? [];
	for (const grant of grants) if (grant.access === "write") writable.add(grant.canonical);
	let invocation: ReturnType<typeof composeWorkerSandboxInvocation>;
	try {
		// An extension never reads PanCode's settings, which can hold target auth headers, so they are masked always.
		// `.pancode/data/` is masked to hide sibling extensions' project data, revealing only this extension's own dir.
		const base = [
			...workerSandboxMasks(),
			...settingsMasks(roots, writable),
			...projectDataMask(workspace, roots.project),
		];
		invocation = composeWorkerSandboxInvocation(
			{
				version: WORKER_SANDBOX_SPEC_VERSION,
				mode: "auto",
				writableRoots: [...writable],
				// Re-bound read-only after the writable roots, so a root that is a parent of the
				// project cannot rewrite Git metadata, installed resources, state or policy.
				readOnlyPaths: [path.join(workspace, ".git"), ...managedPaths(workspace)],
				// The project directory sits under a managed `.pancode/`, so it is bound writable after those.
				gitWritablePaths: roots.project?.writable ? [roots.project.dir] : [],
				readableRoots: [
					workspace,
					path.dirname(roots.packageCopy),
					path.dirname(roots.bootstrap),
					...(roots.project !== undefined ? [roots.project.dir] : []),
					...grants.filter((grant) => grant.access === "read" && grant.exists).map((grant) => grant.canonical),
				],
				network: net,
				...(input.unixSockets !== undefined && input.unixSockets !== "block" ? { unixSockets: input.unixSockets } : {}),
			},
			{ argv },
			workspace,
			availability,
			[...base, ...workspaceSecretMasks(declaration, workspace, base, grants)],
		);
	} catch (error) {
		return {
			...unenforced,
			report: { ...unenforced.report, reason: error instanceof Error ? error.message : String(error) },
		};
	}
	if (invocation === null) return unenforced;
	return {
		file: invocation.file,
		args: invocation.args,
		report: { backend: availability.backend, network: net ? "allowed" : "blocked" },
	};
}
