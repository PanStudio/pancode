// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { desktopEntry, type LaunchPaths, launcherId, launcherUnsupported } from "./desktop-entry.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const names = { entry: `${launcherId}.desktop`, manifest: `${launcherId}.desktop.owner.json` };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A file at a launcher path that is there but is not one PanCode may read: a symlink, a directory, a hard link, too large, or another user's. */
export class UnsafeLauncherFile extends Error {}

export async function contents(path: string) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.nlink !== 1 || info.size > 16_384 || (process.getuid && info.uid !== process.getuid()))
			throw new UnsafeLauncherFile("Launcher file is not a small regular file owned by this user.");
		return await readFile(path, "utf8");
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

export async function launcherFiles(prefix: string, platform: NodeJS.Platform = process.platform) {
	if (platform !== "linux") throw new Error(launcherUnsupported);
	if (!isAbsolute(prefix)) throw new Error("--prefix must be an absolute XDG data directory.");
	const directory = join(prefix, "applications");
	try {
		if (!(await lstat(directory)).isDirectory())
			throw new Error("Launcher applications path must be a directory, not a symlink.");
	} catch (error) {
		if (!missing(error)) throw error;
	}
	return { directory, entry: join(directory, names.entry), manifest: join(directory, names.manifest) };
}
export async function launcherStatus(prefix: string, platform: NodeJS.Platform = process.platform) {
	const files = await launcherFiles(prefix, platform);
	// A symlink or other odd file there is never followed or removed; the person who put it there moves it.
	const read = (path: string) =>
		contents(path).catch((error: unknown) => {
			if (error instanceof UnsafeLauncherFile)
				throw new Error(
					`${path}: ${error.message} PanCode left it in place; move it out of ${files.directory}, then run this command again.`,
				);
			throw new Error(`PanCode could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		});
	const entry = await read(files.entry),
		manifest = await read(files.manifest);
	if (entry === null && manifest === null) return { status: "absent" as const, ...files };
	let owned = false,
		available = false;
	try {
		const value = JSON.parse(manifest ?? "null");
		owned =
			entry !== null &&
			value?.version === 1 &&
			value?.owner === launcherId &&
			value?.sha256 === hash(entry) &&
			desktopEntry(value.launch) === entry;
		if (owned) {
			await access(value.launch.node, constants.X_OK);
			for (const path of [
				value.launch.node,
				value.launch.entry,
				...(value.launch.loader ? [value.launch.loader] : []),
				...(value.launch.icon ? [value.launch.icon] : []),
			]) {
				await access(path, constants.R_OK);
				if (!(await stat(path)).isFile()) throw new Error("Launcher target is not a file.");
			}
			available = true;
		}
	} catch {
		/* A malformed manifest never grants ownership. */
	}
	return {
		status: owned ? (available ? ("installed" as const) : ("unavailable" as const)) : ("conflict" as const),
		...files,
	};
}
/**
 * Why launcher files at `prefix` stay in place, and what clears them: PanCode removes an entry it owns,
 * and a person moves aside a file PanCode cannot verify as its own.
 */
export async function launcherClash(state: Awaited<ReturnType<typeof launcherStatus>>, prefix: string) {
	if (state.status === "conflict") {
		const found = [];
		for (const path of [state.entry, state.manifest])
			if (
				await lstat(path).then(
					() => true,
					() => false,
				)
			)
				found.push(basename(path));
		return `The PanCode desktop entry in ${state.directory} is not one PanCode can verify as its own, so it was left in place. Move ${found.join(" and ")} out of ${state.directory}, then run this command again.`;
	}
	const uninstall = `pancode gui launcher uninstall --prefix '${prefix.replaceAll("'", "'\\''")}'`;
	const reason =
		state.status === "unavailable"
			? "starts PanCode files that are no longer installed"
			: "opens PanCode another way, from another installation or without the background app";
	return `The PanCode desktop entry at ${state.entry} ${reason}. Remove it with ${uninstall}, then run this command again.`;
}
export async function installLauncher(prefix: string, paths: LaunchPaths) {
	const launch = {
		node: await realpath(paths.node),
		...(paths.loader ? { loader: await realpath(paths.loader) } : {}),
		...(paths.icon ? { icon: await realpath(paths.icon) } : {}),
		entry: await realpath(paths.entry),
		...(paths.background ? { background: await realpath(paths.background) } : {}),
	};
	const entry = desktopEntry(launch);
	const state = await launcherStatus(prefix);
	if (state.status === "installed" && (await contents(state.entry)) === entry) return state;
	if (state.status !== "absent") throw new Error(await launcherClash(state, prefix));
	await mkdir(state.directory, { recursive: true });
	await launcherFiles(prefix);
	try {
		await writeFile(state.entry, entry, { flag: "wx", mode: 0o644 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				"Another launcher installation created the desktop entry. Wait for it to finish, then retry or inspect launcher status.",
			);
		throw error;
	}
	try {
		await writeFile(
			state.manifest,
			`${JSON.stringify({ version: 1, owner: launcherId, sha256: hash(entry), launch })}\n`,
			{
				flag: "wx",
				mode: 0o600,
			},
		);
	} catch (error) {
		if ((await contents(state.entry)) === entry) await unlink(state.entry);
		throw error;
	}
	return launcherStatus(prefix);
}
export async function uninstallLauncher(prefix: string) {
	const state = await launcherStatus(prefix);
	if (state.status === "conflict") throw new Error("Launcher ownership could not be verified; no files were removed.");
	if (state.status === "installed" || state.status === "unavailable") {
		await unlink(state.entry);
		await unlink(state.manifest);
	}
	return launcherStatus(prefix);
}

export async function launcher(args: string[], paths: LaunchPaths) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prefix: { type: "string" } } });
	const command = positionals[0];
	if (positionals.length !== 1 || !["install", "status", "uninstall"].includes(command ?? ""))
		throw new Error("Usage: pancode gui launcher install|status|uninstall [--prefix <absolute XDG data directory>]");
	const prefix =
		values.prefix ??
		(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
			? process.env.XDG_DATA_HOME
			: join(homedir(), ".local/share"));
	const result =
		command === "install"
			? await installLauncher(prefix, paths)
			: command === "uninstall"
				? await uninstallLauncher(prefix)
				: await launcherStatus(prefix);
	console.log(JSON.stringify(result, null, 2));
	if (result.status === "conflict" || result.status === "unavailable") process.exitCode = 1;
}
